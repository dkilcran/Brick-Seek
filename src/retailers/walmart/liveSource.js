// Walmart I/O Affiliate API client (https://walmart.io/docs/affiliates/v1/introduction).
// What each call really returns is recorded in CLAUDE.md; in short:
//   /search           finds items (25 per page, 1,000 per search), online price only
//   /paginated/items  bulk feeds by department and deal tag (200 per page)
//   /items            details for up to 20 item ids: Walmart.com's offer, or with
//                     a storeId that store's price, stock and Clearance flag
//   /stores, /taxonomy  the store locator and the category tree
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TtlCache } from '../../lib/cache.js';
import { walmartProductUrl } from './identifiers.js';

const BASE_URL = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';
const LOOKUP_BATCH = 20; // most item ids Walmart accepts per lookup
// Top-level taxonomy entries that are site sections, not product departments.
const NON_PRODUCT_SECTIONS = /^(help|ideas|feature|gift registry|gifts & registry|services|photo center|shop by brand|new arrivals|savings|character shop|personalized gifts)$/i;

/** Walmart itself sells the item: it names itself, or names no seller on an item not flagged marketplace. */
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

/** Walmart's stock text ("Available", "Not available", ...) as true / false / null (unknown). */
function inStock(stock) {
  if (!stock) return null;
  return /^available$/i.test(stock) ? true : /not available/i.test(stock) ? false : null;
}

const wasPriceOf = (item) => {
  const strike = Number(item.strikeThroughPrice);
  return strike > (item.salePrice ?? 0) ? strike : null;
};

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
  /**
   * @param {object} opts
   * @param {{ get(zip): object[]|null, set(zip, stores): void }} [opts.zipStoreCache]  saved store lists per ZIP
   * @param {number} [opts.minIntervalMs]  spacing between calls; Walmart rate-limits the API
   */
  constructor({
    consumerId, keyVersion = '1', privateKey, privateKeyPath, publisherId, fetchImpl = fetch,
    zipStoreCache = null, minIntervalMs = 2000, maxRetries = 3,
  } = {}) {
    if (!consumerId) throw new Error('WALMART_CONSUMER_ID is required for live mode');
    this.consumerId = consumerId;
    this.keyVersion = keyVersion;
    this.privateKey = privateKey ?? readFileSync(privateKeyPath, 'utf8');
    this.publisherId = publisherId;
    this.fetch = fetchImpl;
    this.cache = new TtlCache({ ttlMs: 10 * 60 * 1000 });
    this.zipStoreCache = zipStoreCache;
    this.minIntervalMs = minIntervalMs;
    this.maxRetries = maxRetries;
    this.nextSlot = 0;
  }

  /** Wait for this request's turn: at most one request per minIntervalMs. */
  async throttle() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  /**
   * A signed GET. Array values are sent as repeated parameters. 404 gives null;
   * other errors throw. Cached for 10 minutes unless `cache` is false.
   */
  async request(path, params = {}, { cache = true } = {}) {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const each of v) url.searchParams.append(k, each); // repeated parameter
      else if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
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
    return {
      retailer: 'walmart',
      id: String(item.itemId),
      sku: String(item.itemId),
      upc: item.upc ?? null,
      name: item.name,
      brand: item.brandName ?? null,
      category: departmentOf(item.categoryPath),
      imageUrl: item.largeImage ?? item.mediumImage ?? item.thumbnailImage ?? null,
      // Built here rather than taken from Walmart, so every link has the affiliate tracking (or none).
      url: walmartProductUrl(item.itemId, this.publisherId),
      msrp: realMsrp(item.msrp),
      price: item.salePrice ?? null,
      seller: {
        name: item.sellerInfo ?? (item.marketplace === true ? 'Marketplace seller (unnamed)' : 'Walmart.com'),
        isRetailer: isWalmartSeller(item),
      },
      rating: Number.parseFloat(item.customerRating) || null,
      reviewCount: item.numReviews ?? null,
      specialOffer: specialOfferOf(item),
      inStockOnline: inStock(item.stock),
      // Walmart sells it online only (not carried in stores).
      onlineOnly: item.offerType === 'ONLINE_ONLY',
    };
  }

  /**
   * Walmart's raw item lookup, for diagnostics. `params` passes optional
   * lookup parameters through (e.g. a store), to see what they change.
   * `batch` uses the /items?ids= form instead of /items/{id}.
   */
  async rawItem(itemId, { params = {}, batch = false } = {}) {
    return batch
      ? this.request('/items', { ids: itemId, ...params }, { cache: false })
      : this.request(`/items/${encodeURIComponent(itemId)}`, params, { cache: false });
  }

  /** Walmart.com's default offer for an item (may be a marketplace seller's). */
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

  /** Walmart's category tree: [{ id, name, children }]. */
  async taxonomy() {
    const data = await this.request('/taxonomy');
    return data?.categories ?? [];
  }

  /** Top-level product departments (site sections like Help left out). */
  async departments() {
    return (await this.taxonomy()).map((c) => c.name).filter((n) => !NON_PRODUCT_SECTIONS.test(n)).sort();
  }

  /** Walmart stores near a ZIP, nearest first (saved per ZIP when a cache is given). */
  async stores(zip, { limit = 15 } = {}) {
    const saved = this.zipStoreCache?.get(zip);
    if (saved?.length) return saved.slice(0, limit);
    const data = await this.request('/stores', { zip });
    const list = Array.isArray(data) ? data : [];
    const stores = list.map((s) => ({
      retailer: 'walmart',
      id: String(s.no),
      name: s.name ?? `Walmart #${s.no}`,
      address: s.streetAddress ?? null,
      city: s.city ?? null,
      state: s.stateProvCode ?? null,
      zip: s.zip ?? null,
      phone: s.phoneNumber ?? null,
      // Walmart gives coordinates as [lon, lat].
      lat: Array.isArray(s.coordinates) ? s.coordinates[1] : null,
      lon: Array.isArray(s.coordinates) ? s.coordinates[0] : null,
      distanceMiles: null,
    }));
    if (stores.length) {
      try {
        this.zipStoreCache?.set(zip, stores);
      } catch (err) {
        console.warn('walmart: could not save the store list', err.message);
      }
    }
    return stores.slice(0, limit);
  }

  /**
   * One page of Walmart's search: facet filters, an optional (sub)category id,
   * an optional whole-dollar price band (lo..hi) and an optional price sort.
   * Returns Walmart-sold products and the total result count. Walmart's own
   * filters let some marketplace and online-only items through; those are
   * dropped (online-only ones are kept when `keepOnlineOnly` is set).
   */
  async searchPage({ query, filters, lo = null, hi = null, start = 1, sort = null, keepOnlineOnly = false, categoryId = null }) {
    const params = { query, facet: 'on', 'facet.filter': filters, start, numItems: 25 };
    if (categoryId) params.categoryId = categoryId;
    if (lo != null && hi != null) params['facet.range'] = `price:[${lo} TO ${hi}]`;
    if (sort) Object.assign(params, { sort: 'price', order: sort });
    const data = await this.request('/search', params, { cache: false });
    const products = (data?.items ?? [])
      .filter((item) => item?.itemId && isWalmartSeller(item) && (keepOnlineOnly || item.offerType !== 'ONLINE_ONLY'))
      .map((item) => this.toProduct(item));
    return { products, total: Number(data?.totalResults) || 0 };
  }

  /**
   * Walmart's offer for up to 20 item ids at one store: with a storeId the
   * lookup returns that store's price, stock, Clearance flag and was-price
   * instead of the default online offer. Items Walmart sells online only
   * come back with the online price, so they're returned apart.
   * @returns {Promise<{ found: object[], missing: string[], onlineOnly: string[] }>}
   */
  async storeLookup(ids, storeId) {
    let data;
    try {
      data = await this.request('/items', { ids: ids.join(','), storeId }, { cache: false });
    } catch (err) {
      if (/\b400\b/.test(err.message) && /not found/i.test(err.message)) return { found: [], missing: ids.map(String), onlineOnly: [] };
      throw err;
    }
    const all = (data?.items ?? []).map((item) => {
      const p = this.toProduct(item);
      return {
        itemId: p.id,
        title: p.name,
        imageUrl: p.imageUrl,
        category: p.category,
        price: p.price,
        wasPrice: wasPriceOf(item),
        listPrice: p.msrp,
        clearance: item.clearance === true,
        inStock: p.inStockOnline, // with a storeId, "stock" describes that store
        seller: p.seller.name,
        isWalmart: p.seller.isRetailer,
        onlineOnly: p.onlineOnly,
      };
    });
    const seen = new Set(all.map((f) => f.itemId));
    return {
      found: all.filter((f) => !f.onlineOnly),
      missing: ids.map(String).filter((id) => !seen.has(id)),
      onlineOnly: all.filter((f) => f.onlineOnly).map((f) => f.itemId),
    };
  }

  /**
   * Walmart.com's offer for item ids (20 per lookup): price, was-price, seller,
   * and whether Walmart sells the item online only. id -> offer; ids Walmart
   * doesn't know are left out.
   */
  async onlinePrices(ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
      const batch = ids.slice(i, i + LOOKUP_BATCH);
      try {
        const data = await this.request('/items', { ids: batch.join(',') }, { cache: false });
        for (const item of data?.items ?? []) {
          const p = this.toProduct(item);
          out.set(p.id, {
            price: p.price, wasPrice: wasPriceOf(item), seller: p.seller.name, isWalmart: p.seller.isRetailer,
            onlineOnly: p.onlineOnly, availableOnline: item.availableOnline === true,
          });
        }
      } catch (err) {
        if (!/not found/i.test(err.message)) throw err;
      }
    }
    return out;
  }
}
