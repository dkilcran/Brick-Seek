// Walmart. Demo mode serves synthetic data; live mode (with Walmart I/O keys)
// reads Walmart's affiliate API, runs the daily store checks, and serves
// pages from what those saved.
import { RetailerAdapter, STOCK_STATUS } from '../RetailerAdapter.js';
import { PriceTracker } from '../../lib/priceTracker.js';
import { DEAL_LABELS, discount, signalsFrom } from '../../lib/allDeals.js';
import { DEFAULT_SCAN_CONFIG_PATH, loadScanConfig } from '../../lib/scanConfig.js';
import { scheduleDayKey } from '../../lib/scanSchedule.js';
import { parseWalmartInput, walmartProductUrl } from './identifiers.js';
import { WalmartDemoSource } from './demoSource.js';
import { WalmartLiveSource } from './liveSource.js';
import { StorePrices } from './storePrices.js';
import { StoreChecker } from './storeChecker.js';
import { TierStore } from './tierLists.js';

const SEARCH_PAGE = 25;
const STORES_SHOWN = 15; // nearest stores listed on a product page
const CHECKS_PER_HOUR = 120; // visitors' "Check store" lookups, so they can't crowd out the daily checks
const CHECK_REUSE_MS = 15 * 60000;
const CARD_SETS = 10; // deal card sets kept, one per ZIP (about 2 MB each)
const ONLINE_REBUILD_MS = 5 * 60000; // while online prices are being saved, cards are rebuilt at most this often

export class WalmartAdapter extends RetailerAdapter {
  /**
   * Live mode also takes the saved store data, the tier lists and a settings
   * loader (see fromEnv); without them the adapter serves the source as is.
   */
  constructor({ source, mode = 'demo', tracker = new PriceTracker(), storeData = null, tierStore = null, loadStoreConfig = null } = {}) {
    super();
    this.source = source ?? new WalmartDemoSource();
    this._mode = mode;
    this.tracker = tracker;
    /** @type {StorePrices|null} saved store prices and deal labels (live mode) */
    this.storeData = storeData;
    /** @type {TierStore|null} */
    this.tierStore = tierStore;
    this.loadStoreConfig = loadStoreConfig;
    this.recentChecks = new Map(); // "store|item" -> { at, result }
    this.checkTimes = [];
    this.cardCache = new Map(); // zip -> { key, online, at, cards }
  }

  /** @param {{ tracker?: PriceTracker }} shared  the app-wide price history store */
  static fromEnv(env = process.env, { tracker = new PriceTracker() } = {}) {
    // Live whenever credentials are present, unless WALMART_MODE says otherwise.
    const hasKeys = Boolean(env.WALMART_CONSUMER_ID && (env.WALMART_PRIVATE_KEY || env.WALMART_PRIVATE_KEY_PATH));
    const mode = (env.WALMART_MODE || (hasKeys ? 'live' : 'demo')).toLowerCase();
    if (mode !== 'live') {
      return new WalmartAdapter({
        source: new WalmartDemoSource({ publisherId: env.WALMART_PUBLISHER_ID }),
        // Demo prices are synthetic, so keep them out of the real history database.
        tracker: new PriceTracker(),
      });
    }
    if (!hasKeys) {
      throw new Error('WALMART_MODE=live needs WALMART_CONSUMER_ID and WALMART_PRIVATE_KEY or WALMART_PRIVATE_KEY_PATH');
    }
    const storeData = new StorePrices(tracker.db);
    const tierStore = new TierStore(storeData);
    storeData.dropLegacy();
    storeData.ensureMarkdowns('walmart');
    const source = new WalmartLiveSource({
      consumerId: env.WALMART_CONSUMER_ID,
      keyVersion: env.WALMART_KEY_VERSION ?? '1',
      // Hosting platforms often only take env vars, so accept the PEM inline too.
      privateKey: env.WALMART_PRIVATE_KEY ? env.WALMART_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
      privateKeyPath: env.WALMART_PRIVATE_KEY_PATH,
      publisherId: env.WALMART_PUBLISHER_ID,
      zipStoreCache: {
        get: (zip) => storeData.zipStores('walmart', zip),
        set: (zip, stores) => storeData.saveZipStores('walmart', zip, stores),
      },
    });
    const loadStoreConfig = () => loadScanConfig(env.SCAN_CONFIG_PATH || DEFAULT_SCAN_CONFIG_PATH);
    const adapter = new WalmartAdapter({ source, mode: 'live', tracker, storeData, tierStore, loadStoreConfig });
    adapter.storeChecker = new StoreChecker({
      source, db: storeData, tiers: tierStore, loadConfig: loadStoreConfig,
      // Each day's online prices of the deal lists: the history behind "Price drop" and "Lowest price ever".
      onLists: (products) => tracker.recordMany('walmart', products),
    });
    return adapter;
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
      deals: true,
      priceHistory: true,
      // Store-level prices: synthetic in demo mode, from the store checks when live.
      localClearance: this._mode === 'demo' || Boolean(this.storeData),
      storeQuantities: this._mode === 'demo', // Walmart's API only says in stock or not
      // Links to the retailer earn a commission (shown in the site's disclosure).
      affiliateLinks: Boolean(this.source.publisherId),
    };
  }

  get identifierHint() {
    return 'Walmart item #, UPC, walmart.com link, or keywords';
  }

  /** walmart.com link for an item, with affiliate tracking when WALMART_PUBLISHER_ID is set. */
  productUrl(itemId) {
    return walmartProductUrl(itemId, this.source.publisherId);
  }

  storeConfig() {
    return this.loadStoreConfig?.()?.config ?? null;
  }

  /**
   * Deal lists show only the departments in config/store-scan.json (items
   * with no department are kept).
   * @returns {(category: string|null) => boolean}
   */
  departmentFilter() {
    const departments = this.storeConfig()?.departments;
    if (!departments?.length) return () => true;
    const allowed = new Set(departments);
    return (category) => !category || allowed.has(category);
  }

  // ---- products --------------------------------------------------------------

  async searchProducts(query) {
    return (await this.searchPaged(query)).products;
  }

  /**
   * One page (25) of product search results: only items Walmart itself sells
   * (online or in stores; never marketplace sellers), in Walmart's relevance
   * order, up to Walmart's 1,000-result limit. On the last page, items the
   * store checks know that match the words are added (Walmart's search
   * doesn't list everything).
   * @returns {Promise<{ products: object[], total: number, nextStart: number|null }>}
   */
  async searchPaged(query, { start = 1 } = {}) {
    const parsed = parseWalmartInput(query);
    if (parsed.type === 'empty') return { products: [], total: 0, nextStart: null };
    if (parsed.type !== 'query') {
      const product = await this.lookupProduct(query);
      return { products: product ? [product] : [], total: product ? 1 : 0, nextStart: null };
    }
    if (!this.source.searchPage) {
      const products = await this.source.search(parsed.value);
      return { products, total: products.length, nextStart: null };
    }
    const { products, total } = await this.source.searchPage({
      query: parsed.value, filters: ['retailer_type:Walmart'], start, keepOnlineOnly: true,
    });
    const next = start + SEARCH_PAGE;
    const nextStart = products.length && next < 1000 && next <= total ? next : null;
    let saved = [];
    if (nextStart === null) {
      const seen = new Set(products.map((p) => p.id));
      saved = (this.storeData?.searchItems(this.id, parsed.value, { limit: SEARCH_PAGE }) ?? [])
        .filter((id) => !seen.has(id)).map((id) => this.storedProduct(id)).filter(Boolean).slice(0, SEARCH_PAGE);
    }
    return { products: [...products, ...saved].map((p) => this.withReference(p)), total, nextStart };
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

  /**
   * A product from saved data, so pages don't wait on Walmart: the tier 1/2
   * lists, then what the store checks saw. Only items Walmart itself sells;
   * anything else is looked up live.
   */
  storedProduct(id) {
    const key = String(id);
    const listed = this.tierStore?.product(key);
    if (listed) return { ...listed, url: this.productUrl(key) };
    if (!this.storeData?.soldInStores(this.id, key)) return null;
    const info = this.storeData.item(this.id, key);
    return {
      retailer: this.id, id: key, sku: key, upc: null, name: info?.title ?? `Item ${key}`, brand: null,
      category: info?.department ?? null, imageUrl: info?.image_url ?? null, url: this.productUrl(key),
      // Only store prices are known; the online offer wasn't looked up.
      price: null, msrp: null, seller: { name: 'Walmart.com', isRetailer: true },
      rating: null, reviewCount: null, specialOffer: null, inStockOnline: null, onlineOnly: false,
    };
  }

  /**
   * In live mode a product's msrp is what its discount is measured against:
   * the store checks' reference price (see refreshMarkdowns), or none.
   * Walmart's own msrp field is unreliable (a $0.98 stuffing mix at $1,149.99).
   */
  withReference(product) {
    if (!this.storeData) return product;
    if (this.references?.version !== this.storeData.markdownVersion) {
      this.references = { version: this.storeData.markdownVersion, byItem: this.storeData.itemReferences(this.id) };
    }
    const ref = this.references.byItem.get(product.id);
    return { ...product, msrp: ref > product.price ? ref : null };
  }

  async getPriceHistory(productId) {
    const product = await this.getProduct(productId);
    return product ? this.getPriceHistoryFor(product) : null;
  }

  /** The online price history: synthetic in demo mode, the recorded prices when live. */
  async getPriceHistoryFor(product) {
    return (await this.source.priceHistory?.(product)) ?? this.tracker.history(this.id, product.id);
  }

  async getDepartments() {
    return this.source.departments();
  }

  // ---- stores ----------------------------------------------------------------

  async findStores(zip, opts = {}) {
    return this.source.stores(zip, opts);
  }

  /** Stores near a ZIP with this product's price and stock at each. */
  async checkInventory(productId, zip, opts = {}) {
    const product = await this.getProduct(productId);
    if (!product) return null;
    if (!this.storeData) return { product, results: await this.source.inventory(product, zip, opts) };
    // One list: Walmart's nearest stores (nearest first), plus any farther store
    // among its 50 nearest where this item has a saved price (e.g. the tracked
    // stores near work). Walmart gives no distances, only the order (store.rank).
    const nearby = await this.source.stores(zip, { limit: 50 });
    const prices = new Map(this.storeData.latestPrices(this.id, nearby.map((s) => s.id), product.id).map((r) => [r.store_id, r]));
    const deals = this.storeData.itemMarkdowns(this.id, product.id);
    const results = nearby
      .map((store, i) => ({ ...store, rank: i + 1 }))
      .filter((store) => store.rank <= STORES_SHOWN || prices.has(store.id))
      .map((store) => {
        const row = prices.get(store.id);
        // No guessing from the online price: a store without a saved price
        // shows none, and the page offers "Check store".
        if (typeof row?.price !== 'number') {
          return { store, price: null, quantity: null, status: STOCK_STATUS.UNKNOWN, aisle: null, clearance: false, checked: false };
        }
        const kind = deals.get(store.id)?.kind;
        return {
          store, price: row.price, quantity: null, aisle: null, checked: true, seenOn: row.date,
          status: row.in_stock === 1 ? STOCK_STATUS.IN_STOCK : row.in_stock === 0 ? STOCK_STATUS.OUT_OF_STOCK : STOCK_STATUS.UNKNOWN,
          label: DEAL_LABELS[kind] ?? null,
          clearance: kind === 'clearance',
          wasPrice: row.was_price > row.price ? row.was_price : null,
        };
      });
    return { product, results };
  }

  /**
   * Look up one item at one store now, save it, and return the store's price
   * and stock. A check of the same store and item in the last 15 minutes is
   * reused, and live checks are capped per hour.
   */
  async checkStore(itemId, storeId, { now = Date.now() } = {}) {
    if (!this.source.storeLookup || !this.storeData) return null;
    const key = `${storeId}|${itemId}`;
    const recent = this.recentChecks.get(key);
    if (recent && now - recent.at < CHECK_REUSE_MS) return { ...recent.result, reused: true };
    this.checkTimes = this.checkTimes.filter((t) => now - t < 3600000);
    if (this.checkTimes.length >= CHECKS_PER_HOUR) {
      throw Object.assign(new Error('Too many store checks right now; try again in a few minutes'), { status: 429 });
    }
    this.checkTimes.push(now);
    const lookup = await this.source.storeLookup([String(itemId)], String(storeId));
    const day = scheduleDayKey(new Date(now), this.storeConfig()?.schedule?.productListHour ?? 4);
    this.storeData.recordStoreLookup(this.id, String(storeId), lookup, day);
    const item = lookup.found[0];
    const none = (note) => ({ storeId: String(storeId), price: null, status: STOCK_STATUS.UNKNOWN, note });
    let result;
    if (lookup.onlineOnly.length) result = none('Walmart sells this online only, not in stores');
    else if (!item) result = none('Walmart has no listing for this item at this store');
    else if (!item.isWalmart) result = none(`Sold by ${item.seller ?? 'another seller'} here, not Walmart`);
    else {
      result = {
        storeId: String(storeId), price: item.price, wasPrice: item.wasPrice, clearance: item.clearance,
        status: item.inStock === true ? STOCK_STATUS.IN_STOCK : item.inStock === false ? STOCK_STATUS.OUT_OF_STOCK : STOCK_STATUS.UNKNOWN,
        seenOn: day, checked: true,
      };
    }
    if (this.recentChecks.size > 2000) this.recentChecks.clear();
    this.recentChecks.set(key, { at: now, result });
    return result;
  }

  /**
   * Checked stores where Walmart itself sells this item, cheapest first. An
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
      };
    });
  }

  // ---- deals -----------------------------------------------------------------

  /** Products that may be on deal online: the tier 1/2 lists when live, the whole catalog in demo mode. */
  async getDealCandidates(opts = {}) {
    return this.tierStore ? [...this.tierStore.products().values()] : this.source.dealCandidates(opts);
  }

  async getLocalClearance(zip, opts = {}) {
    if (this.storeData) return this.storeDeals(await this.checkedStoresNear(zip));
    return this.source.localClearance(zip, opts);
  }

  /** The checked stores among Walmart's 50 nearest to a ZIP, nearest first. */
  async checkedStoresNear(zip) {
    const checked = new Set(this.storeData.scannedStores(this.id));
    return (await this.source.stores(zip, { limit: 50 })).filter((s) => checked.has(s.id));
  }

  /**
   * Deals on the shelf at the given stores (see refreshMarkdowns), in the
   * settings' departments and not known to be out of stock.
   */
  storeDeals(stores) {
    const storeById = new Map(stores.map((s) => [s.id, s]));
    const keep = this.departmentFilter();
    return this.storeData.markdownRows(this.id, stores.map((s) => s.id))
      .filter((r) => r.in_stock !== 0 && keep(r.department))
      .map((r) => {
        const ref = r.ref_price > r.price ? r.ref_price : null;
        return {
          product: {
            retailer: this.id, id: r.item_id, name: r.title ?? `Item ${r.item_id}`, category: r.department,
            imageUrl: r.image_url, url: this.productUrl(r.item_id), price: r.price, msrp: ref,
            seller: { name: 'Walmart.com', isRetailer: true },
          },
          store: { ...storeById.get(r.store_id), seenOn: r.date },
          price: r.price,
          refPrice: ref,
          quantity: null,
          kind: r.kind,
          discountPercent: discount(r.price, ref).percentOff,
        };
      });
  }

  /**
   * All Deals cards (see lib/allDeals.js), unfiltered. Online: items on today's
   * Clearance / Rollback / Reduced Price lists that Walmart.com itself sells.
   * In store: each item's cheapest deal at the checked stores near `zip`
   * (every tracked store without one). Kept per ZIP and rebuilt when the
   * store deals or lists change, or (at most every 5 minutes) online prices.
   */
  async allDealCards({ zip } = {}) {
    if (!this.storeData || !this.tierStore) return super.allDealCards({ zip });
    const db = this.storeData;
    const key = `${db.markdownVersion}|${this.tierStore.builtRun(1)}`;
    const cached = this.cardCache.get(zip ?? '');
    if (cached?.key === key && (cached.online === db.onlineVersion || Date.now() - cached.at < ONLINE_REBUILD_MS)) return cached.cards;
    const online = db.onlineVersion;
    const cards = new Map();
    const cardFor = (product) => {
      if (!cards.has(product.id)) cards.set(product.id, { product, online: null, store: null, soldOnline: true, soldInStores: true, dropPercent: 0, atLowest: false });
      return cards.get(product.id);
    };

    const stores = zip
      ? await this.checkedStoresNear(zip)
      : (this.storeConfig()?.stores ?? []).map((s) => ({ retailer: this.id, id: s.id, name: s.label ?? `Walmart #${s.id}` }));
    const storesWithDeal = new Map();
    for (const r of this.storeDeals(stores)) {
      const { retailer, id, name, imageUrl, category, url } = r.product;
      const card = cardFor({ retailer, id, name, imageUrl, category, url });
      storesWithDeal.set(id, (storesWithDeal.get(id) ?? 0) + 1);
      if (card.store && card.store.price <= r.price) continue;
      card.store = {
        price: r.price, refPrice: r.refPrice, kind: r.kind, label: DEAL_LABELS[r.kind], store: r.store, seenOn: r.store.seenOn,
        ...discount(r.price, r.refPrice),
      };
    }
    for (const [id, n] of storesWithDeal) cards.get(id).store.storesWithDeal = n;

    const keep = this.departmentFilter();
    const offers = this.tierStore.offers();
    const ids = [...new Set([...offers.keys(), ...cards.keys()])];
    const infos = db.items(this.id, ids);
    const history = this.tracker.summaries(this.id, [...offers.keys()]);
    for (const [id, kind] of offers) {
      const listed = this.tierStore.product(id);
      const info = infos.get(id);
      // Walmart.com's price from today's lookup; before it has run, from the list itself.
      const looked = Boolean(info?.online_lookup_date);
      const price = looked ? info.online_price : (info?.online_price ?? listed?.price ?? null);
      if (!(price > 0)) continue; // a marketplace seller's offer online
      const name = listed?.name ?? info?.title;
      const category = listed?.category ?? info?.department ?? null;
      if (!name || !keep(category)) continue;
      const wasPrice = looked ? info.online_was : null;
      // Rollback / Reduced Price need a was-price on Walmart.com (many items on
      // Walmart's lists have none online); Clearance shows regardless.
      if (kind !== 'clearance' && !(wasPrice > price)) continue;
      const card = cardFor({ retailer: this.id, id, name, imageUrl: listed?.imageUrl ?? info?.image_url ?? null, category, url: this.productUrl(id) });
      card.online = { price, wasPrice, kind, label: DEAL_LABELS[kind], ...discount(price, wasPrice) };
      Object.assign(card, signalsFrom(price, history.get(id)));
    }
    // Where each item is sold, as far as the online lookup has said.
    for (const [id, card] of cards) {
      const info = infos.get(id);
      const onlineOnly = info?.online_only === 1;
      card.soldOnline = onlineOnly || info?.online_available !== 0;
      card.soldInStores = !onlineOnly || Boolean(card.store);
    }
    const out = [...cards.values()];
    this.cardCache.delete(zip ?? '');
    if (this.cardCache.size >= CARD_SETS) this.cardCache.delete(this.cardCache.keys().next().value);
    this.cardCache.set(zip ?? '', { key, online, at: Date.now(), cards: out });
    return out;
  }

  /** Walmart.com's deal on one item (for the product page), or null. */
  onlineDeal(itemId) {
    const kind = this.tierStore?.offerOf(itemId);
    const info = kind && this.storeData?.item(this.id, itemId);
    if (!(info?.online_price > 0)) return null;
    if (kind !== 'clearance' && !(info.online_was > info.online_price)) return null;
    return {
      price: info.online_price, wasPrice: info.online_was, kind, label: DEAL_LABELS[kind], onlineOnly: info.online_only === 1,
      ...discount(info.online_price, info.online_was),
    };
  }
}
