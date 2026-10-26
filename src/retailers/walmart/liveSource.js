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
    const category = item.categoryPath?.split('/')[0] ?? null;
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
      onlineStock: item.stock ?? null,
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

  async categories() {
    const data = await this.request('/taxonomy');
    return (data?.categories ?? []).map((c) => c.name).sort();
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

  async deals({ category, minDiscount = 0, limit = 50 } = {}) {
    const data = await this.request('/trends');
    return (data?.items ?? [])
      .map((i) => this.toProduct(i))
      .filter((p) => p.price && p.msrp && (!category || p.category === category))
      .map((product) => ({
        product,
        lowestPrice: product.price,
        discountPercent: Math.round((1 - product.price / product.msrp) * 100),
        storesWithDeal: null,
        clearance: false,
      }))
      .filter((d) => d.discountPercent >= minDiscount)
      .sort((a, b) => b.discountPercent - a.discountPercent)
      .slice(0, limit);
  }
}
