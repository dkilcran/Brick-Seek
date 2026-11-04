import { RetailerAdapter } from '../RetailerAdapter.js';
import { PriceTracker } from '../../lib/priceTracker.js';
import { ItemChecks } from '../../lib/itemChecks.js';
import { PoolStore } from '../../lib/poolStore.js';
import { DEFAULT_SCAN_CONFIG_PATH, loadScanConfig } from '../../lib/scanConfig.js';
import { SerpApiClient, StoreScanDb, StoreScanner } from './storeScan.js';
import { StoreChecker } from './storeChecker.js';
import { TierStore } from './tierLists.js';
import { scheduleDayKey } from '../../lib/scanSchedule.js';
import { walmartProductUrl } from './identifiers.js';
import { STOCK_STATUS } from '../RetailerAdapter.js';
import { WalmartDemoSource } from './demoSource.js';
import { WalmartLiveSource } from './liveSource.js';
import { parseWalmartInput } from './identifiers.js';

/**
 * Deal labels for store prices (store_markdowns.kind). Clearance, Rollback and
 * Reduced Price are Walmart's own; Markdown is ours (cheaper than the item's
 * highest valid store price, including this store's earlier price). A
 * was-price alone gets no label.
 */
export const DEAL_LABELS = {
  clearance: 'Clearance',
  rollback: 'Rollback',
  reduced: 'Reduced Price',
  offer: 'Rollback / Reduced Price',
  markdown: 'Markdown',
};

export class WalmartAdapter extends RetailerAdapter {
  constructor({ source, mode = 'demo', tracker = new PriceTracker() } = {}) {
    super();
    this.source = source ?? new WalmartDemoSource();
    this._mode = mode;
    this.tracker = tracker;
  }

  /** @param {{ tracker?: PriceTracker }} shared  the app-wide price history store */
  static fromEnv(env = process.env, { tracker = new PriceTracker() } = {}) {
    // Live whenever credentials are present, unless WALMART_MODE says otherwise.
    const hasKeys = Boolean(env.WALMART_CONSUMER_ID && (env.WALMART_PRIVATE_KEY || env.WALMART_PRIVATE_KEY_PATH));
    const mode = (env.WALMART_MODE || (hasKeys ? 'live' : 'demo')).toLowerCase();
    if (mode === 'live') {
      if (!hasKeys) {
        throw new Error('WALMART_MODE=live needs WALMART_CONSUMER_ID and WALMART_PRIVATE_KEY or WALMART_PRIVATE_KEY_PATH');
      }
      const loadConfig = () => loadScanConfig(env.SCAN_CONFIG_PATH || DEFAULT_SCAN_CONFIG_PATH);
      // Refresh the product list once a day at schedule.productListAt (Chicago time).
      // The daily tier lists replace the old bulk download once they've built a pool.
      const poolRefreshDue = (fetchedAt, now) => {
        if (source.poolFromTiers) return false;
        const hour = loadConfig().config?.schedule?.productListHour ?? 4;
        return scheduleDayKey(new Date(fetchedAt), hour) !== scheduleDayKey(now, hour);
      };
      // Store-level prices for the stores in config/store-scan.json: free checks
      // through Walmart's item lookup, plus SerpApi discovery when a key is set.
      const storeDb = new StoreScanDb(tracker.db);
      const source = new WalmartLiveSource({
        consumerId: env.WALMART_CONSUMER_ID,
        keyVersion: env.WALMART_KEY_VERSION ?? '1',
        // Hosting platforms often only take env vars, so accept the PEM inline too.
        privateKey: env.WALMART_PRIVATE_KEY ? env.WALMART_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
        privateKeyPath: env.WALMART_PRIVATE_KEY_PATH,
        publisherId: env.WALMART_PUBLISHER_ID,
        poolPages: Number(env.WALMART_POOL_PAGES) || undefined,
        poolRefreshMs: Number(env.WALMART_POOL_REFRESH_MINUTES) * 60000 || undefined,
        itemChecks: new ItemChecks(tracker.db),
        poolStore: new PoolStore(tracker.db),
        // An explicit WALMART_POOL_REFRESH_MINUTES keeps the old interval behavior.
        poolRefreshDue: env.WALMART_POOL_REFRESH_MINUTES ? undefined : poolRefreshDue,
        zipStoreCache: {
          get: (zip) => storeDb.zipStores('walmart', zip),
          set: (zip, stores) => storeDb.saveZipStores('walmart', zip, stores),
        },
      });
      const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
      storeDb.ensureMarkdowns('walmart');
      adapter.storeDb = storeDb;
      adapter.loadStoreConfig = loadConfig;
      adapter.tierStore = new TierStore(storeDb);
      adapter.storeChecker = new StoreChecker({ source, db: storeDb, tiers: adapter.tierStore, loadConfig });
      // SerpApi store searches only when turned on in the settings (useSerpApi).
      if (env.SERPAPI_KEY && loadConfig().config?.useSerpApi) {
        adapter.storeScanner = new StoreScanner({
          client: new SerpApiClient({ apiKey: env.SERPAPI_KEY }),
          db: storeDb,
          loadConfig,
          departments: () => source.taxonomy(),
          onlinePrices: (ids) => source.onlinePrices(ids),
        });
      }
      return adapter;
    }
    return new WalmartAdapter({
      source: new WalmartDemoSource({ publisherId: env.WALMART_PUBLISHER_ID }),
      mode: 'demo',
      // Demo prices are synthetic, so keep them out of the real history database.
      tracker: new PriceTracker(),
    });
  }

  get id() {
    return 'walmart';
  }

  /** walmart.com link for an item, with affiliate tracking when WALMART_PUBLISHER_ID is set. */
  productUrl(itemId) {
    return walmartProductUrl(itemId, this.source.publisherId);
  }

  get name() {
    return 'Walmart';
  }

  get color() {
    return '#0071dc';
  }

  get mode() {
    return this._mode;
  }

  get features() {
    return {
      // Links to the retailer earn a commission (shown in the site's disclosure).
      affiliateLinks: Boolean(this.source.publisherId),
      search: true,
      inventory: true,
      storeQuantities: this._mode === 'demo',
      deals: true,
      priceHistory: true,
      // Walmart's public API has no per-store prices, so only demo data has this.
      // Store-level prices come from demo data, or from the store scan (SerpApi) when set up.
      localClearance: this._mode === 'demo' || Boolean(this.storeData),
    };
  }

  get identifierHint() {
    return 'Walmart item #, UPC, walmart.com link, or keywords';
  }

  async searchProducts(query, opts = {}) {
    const parsed = parseWalmartInput(query);
    if (parsed.type === 'empty') return [];
    if (parsed.type !== 'query') {
      const product = await this.lookupProduct(query);
      return product ? [product] : [];
    }
    // Same discount references as the deal lists (Walmart's msrp is unreliable).
    const refs = this.referenceMap();
    const results = await this.source.search(parsed.value, opts);
    if (!refs) return results;
    return results.map((p) => this.withReference(p));
  }

  /** item_id -> deal reference price from the store checks, reused until the markdowns change. Null without store data. */
  referenceMap() {
    const db = this.storeData;
    if (!db) return null;
    if (this.refMap?.version !== db.markdownVersion) this.refMap = { version: db.markdownVersion, map: db.itemReferences(this.id) };
    return this.refMap.map;
  }

  async lookupProduct(input) {
    const parsed = parseWalmartInput(input);
    if (parsed.type === 'itemId') return this.getProduct(parsed.value);
    if (parsed.type === 'upc') return this.source.getByUpc(parsed.value);
    return null;
  }

  async getProduct(id) {
    const stored = this.storedProduct(id);
    if (stored) return this.withReference(stored);
    const product = await this.source.getById(id);
    if (product) this.tracker.record(this.id, product.id, product.price);
    return product && this.withReference(product);
  }

  /** The product with its discount measured against store data instead of Walmart's msrp (when live). */
  withReference(product) {
    const refs = this.referenceMap();
    if (!refs) return product;
    const ref = refs.get(product.id);
    return { ...product, msrp: ref > product.price ? ref : null, currentOfferPrice: null };
  }

  /**
   * A product from saved data, so visitor pages don't wait on Walmart: today's
   * deal pool, then the tier 1/2 search results, then what the store checks saw.
   * Only items Walmart itself sells; anything else is looked up live.
   */
  storedProduct(id) {
    const key = String(id);
    const pooled = this.source.pool?.byId?.get?.(key);
    if (pooled?.seller?.isRetailer) return pooled;
    const tiered = this.tierStore?.product(key);
    if (tiered) return { ...tiered, url: this.productUrl(key) };
    const info = this.storeData?.itemInfo?.(this.id, key);
    if (!info) return null;
    return {
      retailer: this.id, id: key, sku: key, upc: null, name: info.title ?? `Item ${key}`, brand: null,
      category: info.department ?? null, imageUrl: info.image_url ?? null, url: this.productUrl(key),
      // Only store prices are known; the online offer wasn't looked up.
      price: null, msrp: null, seller: { name: 'Walmart.com', isRetailer: true },
      rating: null, reviewCount: null, specialOffer: null, inStockOnline: null, storeOnly: true,
    };
  }

  async findStores(zip, opts = {}) {
    return this.source.stores(zip, opts);
  }

  async checkInventory(productId, zip, opts = {}) {
    const product = await this.getProduct(productId);
    if (!product) return null;
    const results = await this.source.inventory(product, zip, opts);
    this.applyScannedPrices(product, results);
    return { product, results };
  }

  /**
   * Look up one item at one store now (Walmart's item lookup with storeId),
   * save it, and return the store's price and stock. A check of the same
   * store and item in the last 15 minutes is reused, and live checks are
   * capped per hour so visitors can't crowd out the daily store checks.
   */
  async checkStore(itemId, storeId, { now = Date.now() } = {}) {
    if (!this.source.storeLookup || !this.storeData) return null;
    const key = `${storeId}|${itemId}`;
    this.recentChecks ??= new Map();
    const recent = this.recentChecks.get(key);
    if (recent && now - recent.at < 15 * 60000) return { ...recent.result, reused: true };
    this.checkTimes = (this.checkTimes ?? []).filter((t) => now - t < 3600000);
    if (this.checkTimes.length >= 120) {
      const err = new Error('Too many store checks right now; try again in a few minutes');
      err.status = 429;
      throw err;
    }
    this.checkTimes.push(now);
    const { found, onlineOnly } = await this.source.storeLookup([String(itemId)], String(storeId));
    if (onlineOnly?.length) this.storeData.dropItems(this.id, onlineOnly);
    const item = found[0];
    const hour = this.storeConfig()?.schedule?.productListHour ?? 4;
    const day = scheduleDayKey(new Date(now), hour);
    let result;
    if (onlineOnly?.length) {
      result = { storeId: String(storeId), price: null, status: STOCK_STATUS.UNKNOWN, note: 'Walmart sells this online only, not in stores' };
    } else if (!item) {
      result = { storeId: String(storeId), price: null, status: STOCK_STATUS.UNKNOWN, note: 'Walmart has no listing for this item at this store' };
    } else {
      this.storeData.recordStorePrices(this.id, String(storeId), [item], day);
      result = item.isWalmart
        ? {
          storeId: String(storeId), price: item.price, wasPrice: item.wasPrice, clearance: item.clearance,
          status: item.inStock === true ? STOCK_STATUS.IN_STOCK : item.inStock === false ? STOCK_STATUS.OUT_OF_STOCK : STOCK_STATUS.UNKNOWN,
          seenOn: day, checked: true,
        }
        : { storeId: String(storeId), price: null, status: STOCK_STATUS.UNKNOWN, note: `Sold by ${item.seller ?? 'another seller'} here, not Walmart` };
    }
    if (this.recentChecks.size > 2000) this.recentChecks.clear();
    this.recentChecks.set(key, { at: now, result });
    return result;
  }

  /** Saved store prices (free checks and SerpApi), when live. */
  get storeData() {
    return this.storeDb ?? this.storeScanner?.db ?? null;
  }

  storeConfig() {
    return (this.loadStoreConfig ?? this.storeScanner?.loadConfig)?.()?.config ?? null;
  }

  /** Overlay saved store prices onto stock-check rows for stores that were checked. */
  applyScannedPrices(product, results) {
    // A marketplace seller's online price says nothing about Walmart's store price.
    if (product.seller?.isRetailer === false) for (const result of results) result.price = null;
    const db = this.storeData;
    if (!db || !results.length) return;
    const rows = db.latestPrices(this.id, results.map((r) => r.store.id), { itemId: product.id });
    const byStore = new Map(rows.map((r) => [r.store_id, r]));
    const deals = db.itemMarkdowns(this.id, product.id);
    for (const result of results) {
      const row = byStore.get(result.store.id);
      // The online price is only a guess at a store's price, so stores without a
      // saved store price show none (the page offers "Check store").
      if (!row || typeof row.price !== 'number') {
        result.price = null;
        result.checked = false;
        continue;
      }
      result.checked = true;
      result.price = row.price;
      result.status = row.in_stock === 1 ? STOCK_STATUS.IN_STOCK : row.in_stock === 0 ? STOCK_STATUS.OUT_OF_STOCK : result.status;
      const deal = deals.get(result.store.id);
      result.label = DEAL_LABELS[deal?.kind] ?? null;
      result.clearance = deal?.kind === 'clearance';
      result.wasPrice = row.was_price > row.price ? row.was_price : null;
      result.seenOn = row.date;
    }
  }

  async getDealCandidates(opts = {}) {
    const products = await this.source.dealCandidates(opts);
    // Record each new pool once; this builds the history behind "price drops" and "lowest ever".
    if (!opts.category && this.source.poolStamp !== this.recordedStamp) {
      this.tracker.recordMany(this.id, products);
      this.recordedStamp = this.source.poolStamp;
    }
    const keep = this.departmentFilter();
    const kept = keep ? products.filter((p) => keep(p.category)) : products;
    return this.withStoreReferences(kept, opts.category);
  }

  /**
   * Walmart's msrp and "best offer" prices are unreliable (a $0.98 stuffing
   * mix listed at $1,149.99), so with store data, deals are measured only
   * against what the store checks found: Walmart's was-price for its own
   * Clearance / Rollback / Reduced Price offer at a store, or the item's
   * highest valid store price (see refreshMarkdowns). Items with neither get
   * no discount. Reused until the pool or the markdowns change.
   */
  withStoreReferences(products, category = '') {
    const db = this.storeData;
    if (!db) return products;
    const key = `${this.source.poolStamp}|${db.markdownVersion}|${category ?? ''}|${products.length}`;
    if (this.refCache?.key === key) return this.refCache.output;
    const refs = this.referenceMap();
    const output = products.map((p) => {
      const ref = refs.get(p.id);
      return { ...p, msrp: ref > p.price ? ref : null, currentOfferPrice: null };
    });
    this.refCache = { key, output };
    return output;
  }

  /**
   * Deal lists show only the departments in config/store-scan.json (items
   * with no department are kept). Null when there's no such setting.
   */
  departmentFilter() {
    const departments = this.storeConfig()?.departments;
    if (!departments?.length) return null;
    const allowed = new Set(departments);
    return (category) => !category || allowed.has(category);
  }

  /** Changes whenever the deal pool does; used to cache ranking. */
  get dealPoolStamp() {
    // Discounts come from the markdown table too, so a rebuild re-ranks.
    const base = this.source.rankStamp ?? this.source.poolStamp;
    if (base == null) return null;
    return this.storeData ? `${base}.${this.storeData.markdownVersion}` : base;
  }

  /** True while the deal pool is still loading after a restart. */
  get dealsLoading() {
    return Boolean(this.source.poolLoading);
  }

  dealPoolStats() {
    return this.source.poolStats();
  }

  fieldSurvey() {
    return this.source.fieldSurvey?.() ?? null;
  }

  async getLocalClearance(zip, opts = {}) {
    if (!this.features.localClearance) return super.getLocalClearance(zip, opts);
    if (this.storeData) return this.scannedClearance(zip, opts);
    return this.source.localClearance(zip, opts);
  }

  /**
   * Scanned stores where Walmart itself sells this item, cheapest first. An
   * item can be Walmart's in store while a marketplace seller has it online.
   */
  storeOffers(itemId) {
    const db = this.storeData;
    if (!db) return [];
    const labels = new Map((this.storeConfig()?.stores ?? []).map((s) => [s.id, s.label]));
    const deals = db.itemMarkdowns(this.id, itemId);
    return db.walmartStoreOffers(this.id, itemId).map((r) => {
      const deal = deals.get(r.store_id);
      return {
        storeId: r.store_id,
        storeLabel: labels.get(r.store_id) ?? `Walmart #${r.store_id}`,
        price: r.price,
        wasPrice: r.was_price > r.price ? r.was_price : null,
        // What a deal's discount is measured against (see refreshMarkdowns).
        refPrice: deal?.ref_price > r.price ? deal.ref_price : null,
        label: DEAL_LABELS[deal?.kind] ?? null,
        inStock: r.in_stock === null ? null : r.in_stock === 1,
        seenOn: r.date,
        clearance: deal?.kind === 'clearance',
      };
    });
  }

  /** Marked-down items at checked stores near a ZIP. */
  async scannedClearance(zip, { category } = {}) {
    const db = this.storeData;
    const scanned = new Set(db.scannedStores(this.id));
    const stores = (await this.source.stores(zip, { limit: 50 })).filter((s) => scanned.has(s.id));
    // The markdown table only changes when it's rebuilt, so reuse the result until then.
    const departments = this.storeConfig()?.departments ?? [];
    const key = `${db.markdownVersion}|${stores.map((s) => s.id).join(',')}|${category ?? ''}|${departments.join(',')}`;
    this.clearanceCache ??= new Map();
    const cached = this.clearanceCache.get(key);
    if (cached) return cached;
    const rows = this.readClearance(db, stores, { category });
    if (this.clearanceCache.size >= 20) this.clearanceCache.clear();
    this.clearanceCache.set(key, rows);
    return rows;
  }

  readClearance(db, stores, { category }) {
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const keep = this.departmentFilter() ?? (() => true);
    // Precomputed deals: Walmart's Clearance flag, Rollback or Reduced Price, or our
    // Markdown (cheaper than the item's highest valid store price).
    return db.markdownRows(this.id, stores.map((s) => s.id))
      .filter((r) => r.in_stock !== 0)
      .filter((r) => (!category || r.department === category) && keep(r.department))
      .map((r) => {
        // Walmart's offers are measured against its was-price at that store; our
        // markdowns against the item's highest valid store price (including this
        // store's earlier price). The default online offer is often another
        // seller's or out of date, so it isn't used.
        const ref = r.ref_price > r.price ? r.ref_price : null;
        const product = {
          retailer: this.id, id: r.item_id, sku: r.item_id, upc: null, name: r.title ?? `Item ${r.item_id}`,
          brand: null, category: r.department, imageUrl: r.image_url, url: this.productUrl(r.item_id),
          msrp: ref ?? r.price, price: r.price,
          seller: { name: 'Walmart.com', isRetailer: true },
          rating: null, reviewCount: null, specialOffer: r.kind, inStockOnline: null,
        };
        return {
          product,
          store: { ...storeById.get(r.store_id), seenOn: r.date },
          price: r.price,
          quantity: null,
          kind: r.kind,
          label: DEAL_LABELS[r.kind] ?? null,
          discountPercent: ref ? Math.round((1 - r.price / ref) * 100) : 0,
        };
      });
  }

  /** walmart.com prices for item ids (live mode only). */
  async onlinePrices(ids) {
    return this.source.onlinePrices ? this.source.onlinePrices(ids) : new Map();
  }

  /** Every product department the retailer has, for settings like the store scan. */
  async getDepartments() {
    return this.source.departments();
  }

  /** Departments that have Walmart-sold items in the deal pool, most items first. */
  async getCategories() {
    const counts = new Map();
    for (const p of await this.getDealCandidates({ wait: false })) {
      if (!p.seller?.isRetailer || !p.category) continue;
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  }

  async getPriceHistory(productId, opts = {}) {
    const product = await this.getProduct(productId);
    if (!product) return null;
    return this.getPriceHistoryFor(product, opts);
  }

  async getPriceHistoryFor(product, opts = {}) {
    const fromSource = await this.source.priceHistory(product, opts);
    return fromSource ?? this.tracker.history(this.id, product.id);
  }
}
