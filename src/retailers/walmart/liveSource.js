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
// Top-level taxonomy entries that are site sections, not product departments.
const NON_PRODUCT_SECTIONS = /^(help|ideas|feature|gift registry|gifts & registry|services|photo center|shop by brand|new arrivals|savings|character shop|personalized gifts)$/i;

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
  constructor({
    consumerId, keyVersion = '1', privateKey, privateKeyPath, publisherId, fetchImpl = fetch,
    poolPages = 3, poolRefreshMs = 60 * 60 * 1000, poolMaxItems = 20000,
  } = {}) {
    if (!consumerId) throw new Error('WALMART_CONSUMER_ID is required for live mode');
    this.consumerId = consumerId;
    this.keyVersion = keyVersion;
    this.privateKey = privateKey ?? readFileSync(privateKeyPath, 'utf8');
    this.publisherId = publisherId;
    this.fetch = fetchImpl;
    this.cache = new TtlCache({ ttlMs: 10 * 60 * 1000 });
    this.poolPages = poolPages;
    this.poolRefreshMs = poolRefreshMs;
    this.poolMaxItems = poolMaxItems;
    this.pool = null; // { products, fetchedAt, stats }
    this.poolRefresh = null;
  }

  /** @param {{ cache?: boolean }} opts  big paged responses skip the cache */
  async request(path, params = {}, { cache = true } = {}) {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (this.publisherId) url.searchParams.set('publisherId', this.publisherId);
    const fetchJson = async () => {
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
    };
    return cache ? this.cache.wrap(url.toString(), fetchJson) : fetchJson();
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

  /**
   * Fetch up to `pages` pages of a paginated feed, following `nextPage`.
   * Never throws: one failing feed shouldn't empty the deals page.
   */
  async fetchFeed(name, path, params, pages) {
    const stat = { name, pages: 0, items: 0, error: null };
    const items = [];
    let query = params;
    try {
      while (query && stat.pages < pages) {
        const data = await this.request(path, query, { cache: false });
        stat.pages += 1;
        items.push(...(data?.items ?? []));
        // nextPage is a path with the query for the following page.
        query = data?.nextPage ? Object.fromEntries(new URL(data.nextPage, BASE_URL).searchParams) : null;
        if (query) delete query.publisherId;
      }
    } catch (err) {
      stat.error = err.message.slice(0, 200);
      console.warn(`walmart: ${name} failed: ${stat.error}`);
    }
    stat.items = items.length;
    return { items, stat };
  }

  async fetchPool() {
    const started = Date.now();
    const cats = (await this.taxonomy().catch(() => [])).filter((c) => !NON_PRODUCT_SECTIONS.test(c.name));
    const feeds = [
      ['trending', '/trends', {}, 1],
      ...SPECIAL_OFFERS.map((offer) => [offer, '/paginated/items', { specialOffer: offer }, this.poolPages]),
      ...cats.map((c) => [c.name, '/paginated/items', { category: c.id }, this.poolPages]),
    ];
    const results = await mapLimit(feeds, 4, ([name, path, params, pages]) => this.fetchFeed(name, path, params, pages));
    const byId = new Map();
    for (const { items } of results) {
      for (const item of items) {
        if (byId.size >= this.poolMaxItems) break;
        if (item?.itemId && !byId.has(item.itemId)) byId.set(item.itemId, this.toProduct(item));
      }
    }
    const stats = {
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      requests: results.reduce((n, r) => n + r.stat.pages + (r.stat.error ? 1 : 0), 0),
      uniqueItems: byId.size,
      feeds: results.map((r) => r.stat),
    };
    console.log(`walmart: deal pool ${stats.uniqueItems} items from ${stats.requests} requests in ${stats.durationMs}ms`);
    return { products: [...byId.values()], fetchedAt: Date.now(), stats };
  }

  /**
   * Deal pool: trending items, plus several pages each of the Clearance and
   * Rollback feeds and every product department. Refreshed hourly in the
   * background; visitors get the previous pool while a refresh runs.
   */
  async dealCandidates({ category } = {}) {
    if (!this.pool) {
      this.poolRefresh ??= this.fetchPool().finally(() => { this.poolRefresh = null; });
      this.pool = await this.poolRefresh;
    } else if (Date.now() - this.pool.fetchedAt > this.poolRefreshMs && !this.poolRefresh) {
      this.poolRefresh = this.fetchPool()
        .then((pool) => { this.pool = pool; })
        .catch((err) => console.warn('walmart: pool refresh failed', err.message))
        .finally(() => { this.poolRefresh = null; });
    }
    const { products } = this.pool;
    return category ? products.filter((p) => p.category === category) : products;
  }

  /** Changes whenever the pool is refetched. */
  get poolStamp() {
    return this.pool?.fetchedAt ?? null;
  }

  poolStats() {
    return this.pool?.stats ?? null;
  }
}
