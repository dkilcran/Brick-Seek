import { RetailerAdapter } from '../RetailerAdapter.js';
import { PriceTracker } from '../../lib/priceTracker.js';
import { WalmartDemoSource } from './demoSource.js';
import { WalmartLiveSource } from './liveSource.js';
import { parseWalmartInput } from './identifiers.js';

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
      });
      return new WalmartAdapter({ source, mode: 'live', tracker });
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
      localClearance: this._mode === 'demo',
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
    return { product, results };
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

  dealPoolStats() {
    return this.source.poolStats();
  }

  fieldSurvey() {
    return this.source.fieldSurvey?.() ?? null;
  }

  async getLocalClearance(zip, opts = {}) {
    if (!this.features.localClearance) return super.getLocalClearance(zip, opts);
    return this.source.localClearance(zip, opts);
  }

  /** Departments that have Walmart-sold items in the deal pool, most items first. */
  async getCategories() {
    const counts = new Map();
    for (const p of await this.source.dealCandidates()) {
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
