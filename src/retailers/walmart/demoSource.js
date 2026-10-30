// Demo data source: deterministic synthetic stores, stock and prices.
// Values are stable for a given product/store/day so refreshing the page
// doesn't reshuffle results, but they change day to day like real inventory.
import { seeded, pick, intBetween } from '../../lib/random.js';
import { stateForZip } from '../../lib/geo.js';
import { STOCK_STATUS } from '../RetailerAdapter.js';
import { CATALOG, CATEGORIES } from './catalog.js';
import { walmartProductUrl } from './identifiers.js';

const STREETS = ['Main St', 'Commerce Pkwy', 'Market Blvd', 'Highway 7', 'Oak Ave', 'Center Dr',
  'Retail Way', 'Crossroads Blvd', 'Elm St', 'Valley Rd', 'Plaza Dr', 'Lakeview Ave'];
const CITIES = ['Springfield', 'Riverton', 'Fairview', 'Greenville', 'Franklin', 'Clinton',
  'Madison', 'Georgetown', 'Salem', 'Oakdale', 'Ashland', 'Milton', 'Bristol', 'Dover'];
const FORMATS = ['Supercenter', 'Supercenter', 'Supercenter', 'Neighborhood Market', 'Store'];
const ENDINGS = [0.0, 0.88, 0.97, 0.98];

export function walmartPrice(value, rng) {
  const dollars = Math.max(0, Math.floor(value));
  const cents = rng ? pick(rng, ENDINGS) : 0.0;
  return Math.max(0.5, Number((dollars + cents).toFixed(2)));
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export class WalmartDemoSource {
  constructor({ publisherId, now = () => new Date() } = {}) {
    this.publisherId = publisherId;
    this.now = now;
  }

  toProduct(item) {
    const rng = seeded('product', item.itemId);
    const isRetailer = item.seller === 'Walmart.com';
    const offerRoll = rng();
    return {
      retailer: 'walmart',
      id: item.itemId,
      sku: item.itemId,
      upc: item.upc,
      name: item.name,
      brand: item.brand,
      category: item.category,
      imageUrl: null,
      url: walmartProductUrl(item.itemId, this.publisherId),
      msrp: item.msrp,
      price: item.price,
      seller: { name: item.seller, isRetailer },
      rating: Number((3.4 + rng() * 1.6).toFixed(1)),
      reviewCount: intBetween(rng, 3, 9000),
      specialOffer: offerRoll < 0.12 ? 'clearance' : offerRoll < 0.35 ? 'rollback' : null,
      inStockOnline: rng() > 0.08,
    };
  }

  async search(query, { limit = 25 } = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return CATALOG.filter((item) => {
      const hay = `${item.name} ${item.category} ${item.upc} ${item.itemId}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
      .slice(0, limit)
      .map((item) => this.toProduct(item));
  }

  async getById(itemId) {
    const item = CATALOG.find((p) => p.itemId === String(itemId));
    return item ? this.toProduct(item) : null;
  }

  async getByUpc(upc) {
    const normalized = String(upc).replace(/^0+/, '');
    const item = CATALOG.find((p) => p.upc.replace(/^0+/, '') === normalized);
    return item ? this.toProduct(item) : null;
  }

  async categories() {
    return CATEGORIES;
  }

  async departments() {
    return CATEGORIES;
  }

  async stores(zip, { radiusMiles = 50, limit = 15 } = {}) {
    const rng = seeded('stores', zip);
    const state = stateForZip(zip) ?? 'US';
    const count = intBetween(rng, 9, 16);
    const stores = [];
    for (let i = 0; i < count; i++) {
      const id = String(intBetween(rng, 1000, 5999));
      const distance = i === 0 ? 0.6 + rng() * 3 : 1 + rng() * 70;
      const nearbyZip = String(Math.min(99999, Math.max(501, Number(zip) + intBetween(rng, -40, 40)))).padStart(5, '0');
      stores.push({
        retailer: 'walmart',
        id,
        name: `Walmart ${pick(rng, FORMATS)} #${id}`,
        address: `${intBetween(rng, 100, 9999)} ${pick(rng, STREETS)}`,
        city: pick(rng, CITIES),
        state,
        zip: nearbyZip,
        phone: `(${intBetween(rng, 200, 989)}) 555-${String(intBetween(rng, 0, 9999)).padStart(4, '0')}`,
        distanceMiles: Number(distance.toFixed(1)),
      });
    }
    return stores
      .filter((s) => s.distanceMiles <= radiusMiles)
      .sort((a, b) => a.distanceMiles - b.distanceMiles)
      .slice(0, limit);
  }

  storeAvailability(product, store, day = dayKey(this.now())) {
    const rng = seeded('inv', product.id, store.id, day);
    const clearance = rng() < 0.12;
    let price;
    if (clearance) {
      const discount = 0.3 + rng() * 0.45;
      price = walmartPrice(product.price * (1 - discount), rng);
    } else {
      const drift = (rng() - 0.5) * 0.1; // stores vary a few percent
      price = walmartPrice(product.price * (1 + drift), rng);
    }
    const roll = rng();
    let quantity;
    let status;
    if (roll < 0.2) {
      quantity = 0;
      status = STOCK_STATUS.OUT_OF_STOCK;
    } else if (roll < 0.4) {
      quantity = intBetween(rng, 1, 3);
      status = STOCK_STATUS.LIMITED;
    } else {
      quantity = intBetween(rng, 4, 40);
      status = STOCK_STATUS.IN_STOCK;
    }
    const aisle = `${String.fromCharCode(65 + intBetween(rng, 0, 25))}${intBetween(rng, 1, 40)}`;
    return { store, price, quantity, status, aisle, clearance };
  }

  async inventory(product, zip, opts = {}) {
    const stores = await this.stores(zip, opts);
    return stores.map((store) => this.storeAvailability(product, store));
  }

  async priceHistory(product, { days = 90 } = {}) {
    const rng = seeded('history', product.id);
    const today = this.now();
    const points = [];
    let price = walmartPrice(product.msrp * (0.85 + rng() * 0.15), rng);
    // About a quarter of items changed price today; the rest have held for a while.
    const daysAtCurrent = rng() < 0.25 ? 0 : intBetween(rng, 1, Math.min(45, days - 2));
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today.getTime() - i * 86400000);
      if (i <= daysAtCurrent) {
        points.push({ date: dayKey(date), price: product.price });
        continue;
      }
      if (rng() < 0.06) {
        // occasional rollback or price change
        price = product.price + (product.msrp - product.price) * (rng() * 1.1 - 0.1);
        price = walmartPrice(Math.max(price, product.price * 0.6), rng);
      }
      points.push({ date: dayKey(date), price });
    }
    return points;
  }

  /** Demo prices change once a day. */
  get poolStamp() {
    return dayKey(this.now());
  }

  poolStats() {
    return { uniqueItems: CATALOG.length, feeds: [{ name: 'demo catalog', pages: 1, items: CATALOG.length, error: null }] };
  }

  async dealCandidates({ category } = {}) {
    return CATALOG.filter((item) => !category || item.category === category).map((item) => this.toProduct(item));
  }

  async localClearance(zip, { radiusMiles = 50, category } = {}) {
    const stores = await this.stores(zip, { radiusMiles });
    const found = [];
    for (const product of await this.dealCandidates({ category })) {
      for (const store of stores) {
        const a = this.storeAvailability(product, store);
        if (!a.clearance || !a.quantity) continue;
        found.push({
          product,
          store,
          price: a.price,
          quantity: a.quantity,
          discountPercent: Math.round((1 - a.price / product.msrp) * 100),
        });
      }
    }
    return found;
  }
}
