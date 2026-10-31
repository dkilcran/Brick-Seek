import { RetailerAdapter } from '../RetailerAdapter.js';
import { PriceTracker } from '../../lib/priceTracker.js';
import { ItemChecks } from '../../lib/itemChecks.js';
import { PoolStore } from '../../lib/poolStore.js';
import { DEFAULT_SCAN_CONFIG_PATH, loadScanConfig } from '../../lib/scanConfig.js';
import { SerpApiClient, StoreScanDb, StoreScanner } from './storeScan.js';
import { StoreChecker } from './storeChecker.js';
import { walmartProductUrl } from './identifiers.js';
import { STOCK_STATUS } from '../RetailerAdapter.js';
import { WalmartDemoSource } from './demoSource.js';
import { WalmartLiveSource } from './liveSource.js';
import { parseWalmartInput } from './identifiers.js';

/**
 * A saved store price counts as marked down when Walmart flags it Clearance or
 * shows a higher was-price. Rows from the first SerpApi searches predate the
 * clearance column; those searches only returned Clearance listings.
 */
export function isMarkedDown(row) {
  if (row.clearance === 1 || row.was_price > row.price) return true;
  return row.clearance == null && row.source == null;
}

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
      });
      const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
      // Store-level prices for the stores in config/store-scan.json: free checks
      // through Walmart's item lookup, plus SerpApi discovery when a key is set.
      const loadConfig = () => loadScanConfig(env.SCAN_CONFIG_PATH || DEFAULT_SCAN_CONFIG_PATH);
      const storeDb = new StoreScanDb(tracker.db);
      adapter.storeDb = storeDb;
      adapter.loadStoreConfig = loadConfig;
      adapter.storeChecker = new StoreChecker({ source, db: storeDb, loadConfig });
      if (env.SERPAPI_KEY) {
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
    return this.source.search(parsed.value, opts);
  }

  async lookupProduct(input) {
    const parsed = parseWalmartInput(input);
    if (parsed.type === 'itemId') return this.getProduct(parsed.value);
    if (parsed.type === 'upc') return this.source.getByUpc(parsed.value);
    return null;
  }

  async getProduct(id) {
    const product = await this.source.getById(id);
    if (product) this.tracker.record(this.id, product.id, product.price);
    return product;
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
    for (const result of results) {
      const row = byStore.get(result.store.id);
      if (!row || typeof row.price !== 'number') continue;
      result.price = row.price;
      result.status = row.in_stock === 1 ? STOCK_STATUS.IN_STOCK : row.in_stock === 0 ? STOCK_STATUS.OUT_OF_STOCK : result.status;
      result.clearance = isMarkedDown(row);
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
    return products;
  }

  /** Changes whenever the deal pool does; used to cache ranking. */
  get dealPoolStamp() {
    return this.source.rankStamp ?? this.source.poolStamp;
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
    return db.walmartStoreOffers(this.id, itemId).map((r) => ({
      storeId: r.store_id,
      storeLabel: labels.get(r.store_id) ?? `Walmart #${r.store_id}`,
      price: r.price,
      wasPrice: r.was_price > r.price ? r.was_price : null,
      inStock: r.in_stock === null ? null : r.in_stock === 1,
      seenOn: r.date,
      clearance: isMarkedDown(r),
    }));
  }

  /** Marked-down items at checked stores near a ZIP. */
  async scannedClearance(zip, { category } = {}) {
    const db = this.storeData;
    const scanned = new Set(db.scannedStores(this.id));
    const stores = (await this.source.stores(zip, { limit: 50 })).filter((s) => scanned.has(s.id));
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const rows = db.latestPrices(this.id, stores.map((s) => s.id));
    return rows
      .filter((r) => /^walmart(\.com)?$/i.test(r.seller ?? '') && r.price > 0 && r.in_stock !== 0 && isMarkedDown(r))
      .filter((r) => !category || r.department === category)
      .map((r) => {
        // Discounts use Walmart's own "was" price for that store (strike-through
        // price). The default online offer is often another seller's or out of date.
        const was = r.was_price > r.price ? r.was_price : null;
        const product = {
          retailer: this.id, id: r.item_id, sku: r.item_id, upc: null, name: r.title ?? `Item ${r.item_id}`,
          brand: null, category: r.department, imageUrl: r.image_url, url: walmartProductUrl(r.item_id),
          msrp: was ?? r.price, price: r.price,
          seller: { name: 'Walmart.com', isRetailer: true },
          rating: null, reviewCount: null, specialOffer: 'clearance', inStockOnline: null,
        };
        return {
          product,
          store: { ...storeById.get(r.store_id), seenOn: r.date },
          price: r.price,
          quantity: null,
          discountPercent: was ? Math.round((1 - r.price / was) * 100) : 0,
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
    for (const p of await this.source.dealCandidates({ wait: false })) {
      if (!p.seller?.isRetailer || !p.category) continue;
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  }

  async getPriceHistory(productId, opts = {}) {
    const product = await this.source.getById(productId);
    if (!product) return null;
    return this.getPriceHistoryFor(product, opts);
  }

  async getPriceHistoryFor(product, opts = {}) {
    const fromSource = await this.source.priceHistory(product, opts);
    return fromSource ?? this.tracker.history(this.id, product.id);
  }
}
