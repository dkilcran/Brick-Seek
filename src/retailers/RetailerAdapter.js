// Every retailer plugs into the app by subclassing RetailerAdapter and
// returning the normalized shapes documented below. The HTTP API and the UI
// only ever talk to these shapes, so adding a retailer never touches them.
//
// Product {
//   retailer, id, name, brand, category, upc, sku, imageUrl, url,
//   msrp, price,           // price: the online price; msrp: what a discount is measured against, or null
//   seller: { name, isRetailer },  // isRetailer false = marketplace seller
//   rating, reviewCount,   // null when unknown
//   specialOffer,          // 'clearance' | 'rollback' | null
//   inStockOnline,         // boolean, null when unknown
//   onlineOnly             // true when the retailer doesn't carry it in stores
// }
// Store {
//   retailer, id, name, address, city, state, zip, phone, distanceMiles
// }
// StoreAvailability {
//   store: Store,
//   price: number|null,    // in-store price, null if unknown
//   quantity: number|null, // on-hand estimate, null if unknown
//   status: 'in_stock' | 'limited' | 'out_of_stock' | 'unknown',
//   aisle: string|null,
//   clearance: boolean
// }
// LocalClearance {
//   product: Product, store: Store, price, discountPercent, quantity
// }
// Deal card: see src/lib/allDeals.js
// PricePoint { date: 'YYYY-MM-DD', price }
import { DEAL_LABELS, discount, priceSignals } from '../lib/allDeals.js';

export const STOCK_STATUS = Object.freeze({
  IN_STOCK: 'in_stock',
  LIMITED: 'limited',
  OUT_OF_STOCK: 'out_of_stock',
  UNKNOWN: 'unknown',
});

export class NotSupportedError extends Error {
  constructor(retailer, feature) {
    super(`${retailer} does not support ${feature}`);
    this.name = 'NotSupportedError';
    this.status = 501;
  }
}

export class RetailerAdapter {
  /** Short, URL-safe id, e.g. "walmart". */
  get id() {
    throw new Error('RetailerAdapter.id not implemented');
  }

  /** Display name, e.g. "Walmart". */
  get name() {
    throw new Error('RetailerAdapter.name not implemented');
  }

  /** Brand color used by the UI. */
  get color() {
    return '#444';
  }

  /** Where the data comes from: 'demo' or 'live'. */
  get mode() {
    return 'demo';
  }

  /** Feature flags so the UI can hide what a retailer can't do. */
  get features() {
    return { search: true, inventory: true, deals: true, priceHistory: true, localClearance: false };
  }

  /** Hint text describing what identifiers the search box accepts. */
  get identifierHint() {
    return 'Product name, UPC, or product URL';
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      color: this.color,
      mode: this.mode,
      features: this.features,
      identifierHint: this.identifierHint,
    };
  }

  /** @returns {Promise<Product[]>} */
  async searchProducts(_query, _opts = {}) {
    throw new NotSupportedError(this.name, 'search');
  }

  /**
   * Resolve a raw user input (retailer item id, UPC, or product URL) to a Product.
   * @returns {Promise<Product|null>}
   */
  async lookupProduct(_input) {
    throw new NotSupportedError(this.name, 'product lookup');
  }

  /** @returns {Promise<Product|null>} */
  async getProduct(_id) {
    throw new NotSupportedError(this.name, 'product details');
  }

  /** @returns {Promise<Store[]>} sorted by distance */
  async findStores(_zip, _opts = {}) {
    throw new NotSupportedError(this.name, 'store locator');
  }

  /** @returns {Promise<StoreAvailability[]>} */
  async checkInventory(_productId, _zip, _opts = {}) {
    throw new NotSupportedError(this.name, 'inventory');
  }

  /**
   * Products that may be on deal online. Marketplace items may be included;
   * only items the retailer sells itself are shown.
   * @returns {Promise<Product[]>}
   */
  async getDealCandidates(_opts = {}) {
    throw new NotSupportedError(this.name, 'deals');
  }

  /**
   * Store-level markdowns near a ZIP. Needs per-store pricing, which many
   * retailers don't publish; set features.localClearance when implemented.
   * @returns {Promise<LocalClearance[]>}
   */
  async getLocalClearance(_zip, _opts = {}) {
    throw new NotSupportedError(this.name, 'local clearance');
  }

  /**
   * Deal cards for the All Deals list (see lib/allDeals.js), unfiltered. The
   * default builds them from getDealCandidates (an online deal when the
   * retailer flags one or the price is below msrp) and, with a ZIP,
   * getLocalClearance (the cheapest store per item).
   * @returns {Promise<object[]>}
   */
  async allDealCards({ zip } = {}) {
    const cards = new Map();
    const cardFor = (p) => {
      if (!cards.has(p.id)) {
        cards.set(p.id, {
          product: { retailer: p.retailer, id: p.id, name: p.name, imageUrl: p.imageUrl, category: p.category, url: p.url },
          online: null, store: null, soldOnline: p.inStockOnline !== false, soldInStores: !p.onlineOnly, dropPercent: 0, atLowest: false,
        });
      }
      return cards.get(p.id);
    };
    for (const p of await this.getDealCandidates()) {
      if (!isSoldByRetailer(p) || !(p.price > 0) || !(p.specialOffer || p.msrp > p.price)) continue;
      const kind = p.specialOffer ?? 'reduced';
      const wasPrice = p.msrp > p.price ? p.msrp : null;
      Object.assign(cardFor(p), {
        online: { price: p.price, wasPrice, kind, label: DEAL_LABELS[kind], ...discount(p.price, wasPrice) },
        ...priceSignals(p.price, await this.getPriceHistoryFor(p)),
      });
    }
    if (zip && this.features.localClearance) {
      const counts = new Map();
      for (const r of await this.getLocalClearance(zip)) {
        if (!isSoldByRetailer(r.product)) continue;
        const card = cardFor(r.product);
        counts.set(r.product.id, (counts.get(r.product.id) ?? 0) + 1);
        if (card.store && card.store.price <= r.price) continue;
        const refPrice = r.product.msrp > r.price ? r.product.msrp : null;
        card.store = { price: r.price, refPrice, kind: 'clearance', label: DEAL_LABELS.clearance, store: r.store, seenOn: null, ...discount(r.price, refPrice) };
      }
      for (const [id, n] of counts) cards.get(id).store.storesWithDeal = n;
    }
    return [...cards.values()];
  }

  /** @returns {Promise<PricePoint[]>} */
  async getPriceHistory(_productId) {
    throw new NotSupportedError(this.name, 'price history');
  }

  /**
   * History for a product already in hand. Override when the default
   * (look the product up again by id) would cost an API call per product.
   * @returns {Promise<PricePoint[]>}
   */
  async getPriceHistoryFor(product) {
    return (await this.getPriceHistory(product.id)) ?? [];
  }
}

/** True when the retailer itself sells the product (not a marketplace seller). */
export function isSoldByRetailer(product) {
  return product?.seller?.isRetailer === true;
}

/** Collapse store-level availability into a summary for the UI. */
export function summarizeAvailability(results) {
  const priced = results.filter((r) => typeof r.price === 'number');
  const prices = priced.map((r) => r.price);
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    storesChecked: results.length,
    storesPriced: priced.length,
    inStock: count(STOCK_STATUS.IN_STOCK),
    limited: count(STOCK_STATUS.LIMITED),
    outOfStock: count(STOCK_STATUS.OUT_OF_STOCK),
    unknown: count(STOCK_STATUS.UNKNOWN),
    lowestPrice: prices.length ? Math.min(...prices) : null,
    highestPrice: prices.length ? Math.max(...prices) : null,
    clearanceStores: results.filter((r) => r.clearance).length,
  };
}
