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

// Walmart fills msrp with 9999 when it has no real list price.
const PLACEHOLDER_MSRP = 9999;
export function realMsrp(msrp) {
  return typeof msrp === 'number' && msrp > 0 && msrp < PLACEHOLDER_MSRP ? msrp : null;
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

// Raw Walmart fields per product, kept out of API responses; used by fieldSurvey().
const RAW_FIELDS = new WeakMap();

function scalarFields(item) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === 'bestMarketplacePrice' && v && typeof v === 'object') {
      // Flatten this one: it describes the item's current best offer.
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || ['string', 'number', 'boolean'].includes(typeof sv)) out[`${k}.${sk}`] = sv;
      }
      out[k] = '[object]';
    } else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v;
    } else {
      out[k] = Array.isArray(v) ? `[array ${v.length}]` : '[object]';
    }
  }
  return out;
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
    minIntervalMs = 2000, maxRetries = 3, retryPassDelayMs = 30000,
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
    // Walmart rate-limits the affiliate API, so requests are spaced out.
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.retryPassDelayMs = retryPassDelayMs;
    this.nextSlot = 0;
  }

  /** Wait for this request's turn: at most one request per minIntervalMs. */
  async throttle() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  /** @param {{ cache?: boolean }} opts  big paged responses skip the cache */
  async request(path, params = {}, { cache = true } = {}) {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (this.publisherId) url.searchParams.set('publisherId', this.publisherId);
    const fetchJson = async (attempt = 0) => {
      await this.throttle();
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
      if (res.status === 429 && attempt < this.maxRetries) {
        // Honor Retry-After when given, otherwise back off 2s, 4s, 8s.
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 30000)));
        return fetchJson(attempt + 1);
      }
      if (!res.ok) {
        const err = new Error(`Walmart API ${res.status}: ${await res.text().catch(() => '')}`.trim());
        err.status = 502;
        throw err;
      }
      return res.json();
    };
    return cache ? this.cache.wrap(url.toString(), () => fetchJson()) : fetchJson();
  }

  toProduct(item) {
    const category = departmentOf(item.categoryPath);
    const product = {
      retailer: 'walmart',
      id: String(item.itemId),
      sku: String(item.itemId),
      upc: item.upc ?? null,
      name: item.name,
      brand: item.brandName ?? null,
      category,
      imageUrl: item.largeImage ?? item.mediumImage ?? item.thumbnailImage ?? null,
      url: item.productUrl ?? walmartProductUrl(item.itemId, this.publisherId),
      msrp: realMsrp(item.msrp) ?? item.salePrice ?? null,
      price: item.salePrice ?? null,
      seller: {
        name: item.sellerInfo ?? (item.marketplace === true ? 'Marketplace seller (unnamed)' : 'Walmart.com'),
        isRetailer: isWalmartSeller(item),
      },
      rating: Number.parseFloat(item.customerRating) || null,
      reviewCount: item.numReviews ?? null,
      specialOffer: specialOfferOf(item),
      inStockOnline: onlineStock(item.stock),
      // Walmart only reports a best current offer for listings someone is selling now.
      listingActive: Boolean(item.bestMarketplacePrice),
    };
    RAW_FIELDS.set(product, scalarFields(item));
    return product;
  }

  /**
   * Diagnostics for spotting stale listings: which fields Walmart sends and
   * their values, split by available-online vs not, plus price-cent endings
   * and samples of the biggest "discounts" among items not sold online.
   */
  fieldSurvey() {
    const products = this.pool?.products ?? [];
    const group = (p) => (p.inStockOnline === false ? 'notOnline' : 'online');
    const keys = { online: {}, notOnline: {} };
    const values = {};
    const cents = { online: {}, notOnline: {} };
    const sizes = { online: 0, notOnline: 0 };
    for (const p of products) {
      if (!p.seller?.isRetailer) continue;
      const g = group(p);
      sizes[g] += 1;
      const raw = RAW_FIELDS.get(p) ?? {};
      for (const [k, v] of Object.entries(raw)) {
        keys[g][k] = (keys[g][k] ?? 0) + 1;
        if (typeof v === 'string' && v.length > 40) continue;
        values[k] ??= { online: {}, notOnline: {} };
        const key = String(v);
        values[k][g][key] = (values[k][g][key] ?? 0) + 1;
      }
      if (typeof p.price === 'number') {
        const c = Math.round((p.price % 1) * 100).toString().padStart(2, '0');
        cents[g][c] = (cents[g][c] ?? 0) + 1;
      }
    }
    const top = (obj, n = 12) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
    // Only fields with a handful of distinct values are useful as flags.
    const flags = {};
    for (const [k, v] of Object.entries(values)) {
      const distinct = new Set([...Object.keys(v.online), ...Object.keys(v.notOnline)]).size;
      if (distinct <= 15) flags[k] = { online: top(v.online, 15), notOnline: top(v.notOnline, 15) };
    }
    const offPct = (p) => (p.msrp > 0 ? 1 - p.price / p.msrp : 0);
    const sample = (list) => list.slice(0, 8).map((p) => ({ ...RAW_FIELDS.get(p), _discountPct: Math.round(offPct(p) * 100) }));
    const sold = products.filter((p) => p.seller?.isRetailer && p.price > 0);
    return {
      sizes,
      keys: { online: top(keys.online, 80), notOnline: top(keys.notOnline, 80) },
      flags,
      priceCents: { online: top(cents.online, 15), notOnline: top(cents.notOnline, 15) },
      samples: {
        notOnlineHugeDiscount: sample(sold.filter((p) => p.inStockOnline === false && offPct(p) >= 0.9)),
        notOnlineModestDiscount: sample(sold.filter((p) => p.inStockOnline === false && offPct(p) > 0.1 && offPct(p) < 0.4)),
        onlineDiscounted: sample(sold.filter((p) => p.inStockOnline !== false && offPct(p) > 0.2)),
      },
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
    // One feed at a time; requests are throttled anyway and parallel bursts get rate-limited.
    const fetchAll = (list) => mapLimit(list, 1, ([name, path, params, pages]) => this.fetchFeed(name, path, params, pages));
    const results = await fetchAll(feeds);
    // Give rate-limited feeds one more try after a pause.
    const failed = feeds.filter((_, i) => results[i].stat.error);
    if (failed.length) {
      await new Promise((r) => setTimeout(r, this.retryPassDelayMs));
      const retried = await fetchAll(failed);
      failed.forEach((feed, j) => {
        const i = feeds.indexOf(feed);
        if (retried[j].items.length >= results[i].items.length) {
          results[i] = { items: retried[j].items, stat: { ...retried[j].stat, retried: true } };
        }
      });
    }

    const previous = this.pool;
    const byId = new Map();
    const feedIds = {};
    results.forEach(({ items, stat }) => {
      let products = items.filter((item) => item?.itemId).map((item) => this.toProduct(item));
      // A feed that still failed keeps what it had last time rather than dropping out.
      const before = previous?.feedIds?.[stat.name];
      if (stat.error && before && before.length > products.length) {
        products = before.map((id) => previous.byId.get(id)).filter(Boolean);
        stat.reusedPrevious = products.length;
      }
      feedIds[stat.name] = products.map((p) => p.id);
      for (const p of products) {
        if (byId.size >= this.poolMaxItems) break;
        if (!byId.has(p.id)) byId.set(p.id, p);
      }
    });
    const stats = {
      fetchedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      requests: results.reduce((n, r) => n + r.stat.pages + (r.stat.error ? 1 : 0), 0),
      uniqueItems: byId.size,
      failedFeeds: results.filter((r) => r.stat.error).length,
      feeds: results.map((r) => r.stat),
    };
    console.log(`walmart: deal pool ${stats.uniqueItems} items, ${stats.failedFeeds} failed feeds, ${stats.requests} requests in ${stats.durationMs}ms`);
    return { products: [...byId.values()], byId, feedIds, fetchedAt: Date.now(), stats };
  }

  /**
   * Deal pool: trending items, plus several pages each of the Clearance and
   * Rollback feeds and every product department. Refreshed hourly in the
   * background; visitors get the previous pool while a refresh runs. The
   * very first load waits for the whole fetch (a couple of minutes).
   */
  async dealCandidates({ category } = {}) {
    if (!this.pool) {
      this.poolRefresh ??= this.fetchPool().finally(() => { this.poolRefresh = null; });
      this.pool = await this.poolRefresh;
    } else if (Date.now() - this.pool.fetchedAt >= this.poolRefreshMs && !this.poolRefresh) {
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
