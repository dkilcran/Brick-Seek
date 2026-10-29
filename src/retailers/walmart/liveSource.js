// Live data source backed by the Walmart I/O Affiliate API.
// https://walmart.io/docs/affiliates/v1/introduction
//
// The public affiliate API exposes catalog data, online prices and a store
// locator, but not per-store stock counts. Store-level results are returned
// with status "unknown" and the online price so the UI stays consistent.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TtlCache } from '../../lib/cache.js';
import { STOCK_STATUS } from '../RetailerAdapter.js';
import { walmartProductUrl } from './identifiers.js';

const BASE_URL = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';
const SPECIAL_OFFERS = ['clearance', 'rollback'];
const POOL_TTL_MS = 30 * 60 * 1000;
const POOL_CATEGORY_LIMIT = 20;

// Items without seller info are treated as Walmart's own (first-party).
export function isWalmartSeller(item) {
  if (item.sellerInfo) return /^walmart(\.com)?$/i.test(String(item.sellerInfo).trim());
  return item.marketplace !== true;
}

// categoryPath looks like "Home Page/Home/Rugs/Area Rugs"; the department is
// the first segment after the "Home Page" root.
export function departmentOf(categoryPath) {
  const parts = String(categoryPath ?? '')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p && !/^home ?page$/i.test(p));
  return parts[0] ?? null;
}

function specialOfferOf(item) {
  const offer = String(item.specialOffer ?? '').toLowerCase();
  if (item.clearance === true || offer === 'clearance') return 'clearance';
  if (item.rollback === true || offer === 'rollback') return 'rollback';
  return null;
}

function onlineStock(stock) {
  if (!stock) return null;
  return /^available$/i.test(stock) ? true : /not available/i.test(stock) ? false : null;
}

async function mapLimit(list, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function signWalmartRequest({ consumerId, keyVersion, privateKey, timestamp = Date.now() }) {
  const ts = String(timestamp);
  const signer = createSign('RSA-SHA256');
  signer.update(`${consumerId}\n${ts}\n${keyVersion}\n`);
  return {
    'WM_CONSUMER.ID': consumerId,
    'WM_CONSUMER.INTIMESTAMP': ts,
    'WM_SEC.KEY_VERSION': String(keyVersion),
    'WM_SEC.AUTH_SIGNATURE': signer.sign(privateKey, 'base64'),
  };
}

export class WalmartLiveSource {
  constructor({ consumerId, keyVersion = '1', privateKey, privateKeyPath, publisherId, fetchImpl = fetch } = {}) {
    if (!consumerId) throw new Error('WALMART_CONSUMER_ID is required for live mode');
    this.consumerId = consumerId;
    this.keyVersion = keyVersion;
    this.privateKey = privateKey ?? readFileSync(privateKeyPath, 'utf8');
    this.publisherId = publisherId;
    this.fetch = fetchImpl;
    this.cache = new TtlCache({ ttlMs: 10 * 60 * 1000 });
    this.poolCache = new TtlCache({ ttlMs: POOL_TTL_MS });
  }

  async request(path, params = {}) {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (this.publisherId) url.searchParams.set('publisherId', this.publisherId);
    return this.cache.wrap(url.toString(), async () => {
      const res = await this.fetch(url, {
        headers: {
          Accept: 'application/json',
          ...signWalmartRequest({
            consumerId: this.consumerId,
            keyVersion: this.keyVersion,
            privateKey: this.privateKey,
          }),
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        const err = new Error(`Walmart API ${res.status}: ${await res.text().catch(() => '')}`.trim());
        err.status = 502;
        throw err;
      }
      return res.json();
    });
  }

  toProduct(item) {
    const category = departmentOf(item.categoryPath);
    return {
      retailer: 'walmart',
      id: String(item.itemId),
      sku: String(item.itemId),
      upc: item.upc ?? null,
      name: item.name,
      brand: item.brandName ?? null,
      category,
      imageUrl: item.largeImage ?? item.mediumImage ?? item.thumbnailImage ?? null,
      url: item.productUrl ?? walmartProductUrl(item.itemId, this.publisherId),
      msrp: item.msrp ?? item.salePrice ?? null,
      price: item.salePrice ?? null,
      seller: { name: item.sellerInfo ?? 'Walmart.com', isRetailer: isWalmartSeller(item) },
      rating: Number.parseFloat(item.customerRating) || null,
      reviewCount: item.numReviews ?? null,
      specialOffer: specialOfferOf(item),
      inStockOnline: onlineStock(item.stock),
    };
  }

  async search(query, { limit = 25 } = {}) {
    const data = await this.request('/search', { query, numItems: Math.min(limit, 25) });
    return (data?.items ?? []).map((i) => this.toProduct(i));
  }

  async getById(itemId) {
    const data = await this.request(`/items/${encodeURIComponent(itemId)}`);
    const item = data?.items?.[0] ?? (data?.itemId ? data : null);
    return item ? this.toProduct(item) : null;
  }

  async getByUpc(upc) {
    const data = await this.request('/items', { upc });
    const item = data?.items?.[0];
    return item ? this.toProduct(item) : null;
  }

  async taxonomy() {
    const data = await this.request('/taxonomy');
    return data?.categories ?? [];
  }

  async categories() {
    return (await this.taxonomy()).map((c) => c.name).sort();
  }

  async stores(zip, { limit = 15 } = {}) {
    const data = await this.request('/stores', { zip });
    const list = Array.isArray(data) ? data : [];
    return list.slice(0, limit).map((s) => ({
      retailer: 'walmart',
      id: String(s.no),
      name: s.name ?? `Walmart #${s.no}`,
      address: s.streetAddress ?? null,
      city: s.city ?? null,
      state: s.stateProvCode ?? null,
      zip: s.zip ?? null,
      phone: s.phoneNumber ?? null,
      distanceMiles: null,
    }));
  }

  async inventory(product, zip, opts = {}) {
    const stores = await this.stores(zip, opts);
    return stores.map((store) => ({
      store,
      price: product.price,
      quantity: null,
      status: STOCK_STATUS.UNKNOWN,
      aisle: null,
      clearance: false,
    }));
  }

  async priceHistory() {
    return null; // fall back to locally recorded observations
  }

  // One upstream call failing shouldn't empty the deals page.
  async safeItems(path, params) {
    try {
      return (await this.request(path, params))?.items ?? [];
    } catch (err) {
      console.warn(`walmart: ${path} failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Deal pool: trending items, the first page of each top-level category,
   * and the Clearance and Rollback feeds. Cached as a whole for 30 minutes.
   */
  async dealCandidates({ category } = {}) {
    const pool = await this.poolCache.wrap('pool', async () => {
      const cats = (await this.taxonomy().catch(() => [])).slice(0, POOL_CATEGORY_LIMIT);
      const requests = [
        ['/trends', {}],
        ...SPECIAL_OFFERS.map((offer) => ['/paginated/items', { specialOffer: offer }]),
        ...cats.map((c) => ['/paginated/items', { category: c.id }]),
      ];
      const batches = await mapLimit(requests, 4, ([path, params]) => this.safeItems(path, params));
      const byId = new Map();
      for (const item of batches.flat()) {
        if (item?.itemId && !byId.has(item.itemId)) byId.set(item.itemId, this.toProduct(item));
      }
      return [...byId.values()];
    });
    return category ? pool.filter((p) => p.category === category) : pool;
  }
}
