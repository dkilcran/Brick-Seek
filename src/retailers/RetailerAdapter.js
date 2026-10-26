// Every retailer plugs into the app by subclassing RetailerAdapter and
// returning the normalized shapes documented below. The HTTP API and the UI
// only ever talk to these shapes, so adding a retailer never touches them.
//
// Product {
//   retailer, id, name, brand, category, upc, sku, imageUrl, url,
//   msrp, price            // national/online price
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
// Deal {
//   product: Product, lowestPrice, discountPercent, storesWithDeal, clearance
// }
// PricePoint { date: 'YYYY-MM-DD', price }

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
    return { search: true, inventory: true, deals: true, priceHistory: true };
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

  /** @returns {Promise<Deal[]>} */
  async getDeals(_opts = {}) {
    throw new NotSupportedError(this.name, 'deals');
  }

  /** @returns {Promise<string[]>} */
  async getCategories() {
    return [];
  }

  /** @returns {Promise<PricePoint[]>} */
  async getPriceHistory(_productId, _opts = {}) {
    throw new NotSupportedError(this.name, 'price history');
  }
}

/** Collapse store-level availability into a summary for the UI. */
export function summarizeAvailability(results) {
  const priced = results.filter((r) => typeof r.price === 'number');
  const prices = priced.map((r) => r.price);
  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    storesChecked: results.length,
    inStock: count(STOCK_STATUS.IN_STOCK),
    limited: count(STOCK_STATUS.LIMITED),
    outOfStock: count(STOCK_STATUS.OUT_OF_STOCK),
    unknown: count(STOCK_STATUS.UNKNOWN),
    lowestPrice: prices.length ? Math.min(...prices) : null,
    highestPrice: prices.length ? Math.max(...prices) : null,
    clearanceStores: results.filter((r) => r.clearance).length,
  };
}
