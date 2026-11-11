// JSON API. All routes are retailer-scoped (/api/:retailer/...) so new
// retailers show up automatically once they're in the registry.
import { isValidZip } from './lib/geo.js';
import { summarizeAvailability, isSoldByRetailer } from './retailers/RetailerAdapter.js';
import { filterCards, sortCards } from './lib/allDeals.js';
import { DEFAULT_SCAN_CONFIG_PATH, describeScanConfig, loadScanConfig } from './lib/scanConfig.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireRetailer(registry, id) {
  const adapter = registry.get(id);
  if (!adapter) throw new HttpError(404, `Unknown retailer "${id}"`);
  return adapter;
}

function requireZip(zip) {
  if (!isValidZip(zip)) throw new HttpError(400, 'A valid 5-digit ZIP code is required');
  return zip;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// The site only covers items the retailer sells itself, not marketplace
// sellers. An item a marketplace seller has online still counts when the
// retailer sells it in a checked store; the page then leads with the store
// offer and shows the online offer apart.
function requireRetailerItem(adapter, product) {
  if (!product) throw new HttpError(404, 'Product not found');
  const storeOffers = adapter.storeOffers?.(product.id) ?? [];
  if (storeOffers.length) {
    const best = storeOffers[0];
    return {
      ...product,
      onlinePrice: product.price ?? null,
      onlineSeller: product.price != null ? product.seller?.name ?? null : null,
      price: best.price,
      // A discount only for a labeled deal, not a bare was-price.
      msrp: best.label && best.refPrice ? best.refPrice : null,
      seller: { name: adapter.name, isRetailer: true },
      storeOffers,
    };
  }
  if (isSoldByRetailer(product)) return product;
  throw new HttpError(404, `This item is sold by ${product.seller?.name ?? 'a marketplace seller'}, not ${adapter.name}`);
}

export function createRoutes(registry, { scanConfigPath = process.env.SCAN_CONFIG_PATH || DEFAULT_SCAN_CONFIG_PATH } = {}) {
  return [
    ['GET', '/api/health', () => ({ ok: true })],

    ['GET', '/api/retailers', () => ({ retailers: registry.list().map((r) => r.describe()) })],

    // Product search, paged where the retailer supports it (nextStart asks for the next page).
    ['GET', '/api/:retailer/search', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const q = (query.get('q') ?? '').trim();
      if (!q) throw new HttpError(400, 'Query parameter "q" is required');
      const page = adapter.searchPaged
        ? await adapter.searchPaged(q, { start: clampInt(query.get('start'), 1, 1, 999) })
        : { products: await adapter.searchProducts(q), nextStart: null };
      const products = page.products.filter(isSoldByRetailer);
      return { retailer: adapter.id, query: q, products, total: page.total ?? products.length, nextStart: page.nextStart };
    }],

    ['GET', '/api/:retailer/products/:id', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const product = requireRetailerItem(adapter, await adapter.getProduct(params.id));
      return { product: { ...product, onlineDeal: adapter.onlineDeal?.(product.id) ?? null } };
    }],

    // Stores near a ZIP with the product's price and stock at each.
    ['GET', '/api/:retailer/products/:id/inventory', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = requireZip(query.get('zip'));
      const radiusMiles = clampInt(query.get('radius'), 50, 5, 100);
      const result = await adapter.checkInventory(params.id, zip, { radiusMiles });
      const product = requireRetailerItem(adapter, result?.product);
      const byPrice = query.get('sort') === 'price';
      // Nearest first by default: by distance, or by the retailer's own order (store.rank) when it gives none.
      const nearness = (r) => r.store.distanceMiles ?? r.store.rank ?? Infinity;
      const results = [...result.results].sort((a, b) => (byPrice ? (a.price ?? Infinity) - (b.price ?? Infinity) : nearness(a) - nearness(b)));
      return {
        product: { ...product, onlineDeal: adapter.onlineDeal?.(product.id) ?? null },
        zip,
        radiusMiles,
        summary: summarizeAvailability(results),
        results,
        checkedAt: new Date().toISOString(),
      };
    }],

    // Look one item up at one store now (the product page's "Check store").
    ['GET', '/api/:retailer/products/:id/check-store', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const storeId = query.get('store') ?? '';
      if (!/^\d{1,6}$/.test(storeId)) throw new HttpError(400, 'store should be a store number');
      if (!/^\d{1,15}$/.test(params.id)) throw new HttpError(400, 'Item id should be a number');
      const result = await adapter.checkStore?.(params.id, storeId); // 429 when over the hourly cap
      if (!result) throw new HttpError(501, `${adapter.name} store checks need live mode`);
      return result;
    }],

    // The online price history, and with storePriceHistory the price at each store.
    ['GET', '/api/:retailer/products/:id/history', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = query.get('zip') ? requireZip(query.get('zip')) : null;
      const history = await adapter.getPriceHistory(params.id);
      if (!history) throw new HttpError(404, 'Product not found');
      return { history, stores: (await adapter.storePriceHistory?.(params.id, zip)) ?? [] };
    }],

    ['GET', '/api/:retailer/stores', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = requireZip(query.get('zip'));
      return {
        zip,
        stores: await adapter.findStores(zip, { radiusMiles: clampInt(query.get('radius'), 50, 5, 100), limit: clampInt(query.get('limit'), 15, 1, 50) }),
      };
    }],

    // The deal list: one card per item, with the retailer's online deal and its
    // best store deal near the ZIP. where = online,stores (the kind of deal an
    // item must have); labels = clearance,rollback,reduced,markdown,drop,lowest.
    ['GET', '/api/:retailer/all-deals', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = query.get('zip') || undefined;
      if (zip) requireZip(zip);
      const list = (name) => (query.get(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const num = (name) => { const n = Number.parseFloat(query.get(name)); return Number.isFinite(n) ? n : undefined; };
      const cards = await adapter.allDealCards({ zip });
      const all = sortCards(filterCards(cards, {
        where: list('where'), labels: list('labels'), q: query.get('q') ?? '', category: query.get('category') || undefined,
        minPrice: num('minPrice'), maxPrice: num('maxPrice'), minDiscount: clampInt(query.get('minDiscount'), 0, 0, 100),
      }), query.get('sort') ?? 'best');
      const limit = clampInt(query.get('limit'), 60, 1, 100);
      const offset = clampInt(query.get('offset'), 0, 0, 100000);
      const categories = [...new Set(cards.map((c) => c.product.category).filter(Boolean))].sort();
      return { total: all.length, offset, deals: all.slice(offset, offset + limit), hasMore: offset + limit < all.length, categories };
    }],

    // ---- status and diagnostics (not used by the pages) ----------------------

    // Today's store-check cycle, and the size of the saved data.
    ['GET', '/api/:retailer/store-check', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeChecker) return { enabled: false, reason: 'Live mode only' };
      const data = adapter.storeData;
      return { enabled: true, ...adapter.storeChecker.status(), prices: data.priceCount(adapter.id), databaseMb: data.sizeMb(), databaseFreeMb: data.freeMb() };
    }],

    // The store-check settings as loaded, checked against the retailer's departments.
    ['GET', '/api/:retailer/scan-config', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const departments = (await adapter.getDepartments?.().catch(() => [])) ?? [];
      return describeScanConfig(loadScanConfig(scanConfigPath), departments);
    }],

    // Walmart's raw answer for one item; storeId=<store> asks for that store's offer.
    ['GET', '/api/:retailer/debug/item/:id', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.source?.rawItem) throw new HttpError(501, 'Live mode only');
      if (!/^\d{1,15}$/.test(params.id)) throw new HttpError(400, 'Item id should be a number');
      const storeId = query.get('storeId');
      const lookup = storeId && /^\d{1,6}$/.test(storeId) ? { storeId } : {};
      return { params: lookup, affiliate: await adapter.source.rawItem(params.id, { params: lookup, batch: query.get('batch') === '1' }) };
    }],

    // One page of Walmart's bulk feed (or, with search=1, its search), summarized.
    // fields=1 adds which fields the items carry and the next page's parameters.
    ['GET', '/api/:retailer/debug/feed', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.source?.request) throw new HttpError(501, 'Live mode only');
      const p = {};
      for (const k of ['category', 'specialOffer', 'soldByWmt', 'available', 'brand', 'count', 'lastDoc',
        'query', 'categoryId', 'start', 'numItems', 'facet', 'facet.filter', 'facet.range', 'sort', 'order']) {
        // Allows facet.range values like "price:[0 TO 5]".
        const values = query.getAll(k).filter((v) => /^[\w .:&'\[\]-]{1,60}$/.test(v));
        if (values.length) p[k] = values.length === 1 ? values[0] : values;
      }
      const path = query.get('search') === '1' ? '/search' : '/paginated/items';
      const data = await adapter.source.request(path, p, { cache: false });
      const items = data?.items ?? [];
      const count = (f) => items.reduce((m, i) => ({ ...m, [f(i)]: (m[f(i)] ?? 0) + 1 }), {});
      return {
        path, params: p, items: items.length, nextPage: Boolean(data?.nextPage), totalResults: data?.totalResults ?? null,
        sellers: count((i) => (/^walmart/i.test(i.sellerInfo ?? '') ? 'Walmart' : i.sellerInfo ? 'other' : i.marketplace ? 'marketplace' : 'unnamed')),
        stock: count((i) => i.stock ?? '?'),
        clearanceFlag: count((i) => String(i.clearance)),
        sample: items.slice(0, 5).map((i) => ({
          itemId: i.itemId, name: i.name?.slice(0, 50), seller: i.sellerInfo ?? null, salePrice: i.salePrice, stock: i.stock,
          clearance: i.clearance, strikeThroughPrice: i.strikeThroughPrice ?? null,
        })),
        ...(query.get('fields') === '1' ? {
          fields: items.reduce((m, i) => { for (const k of Object.keys(i)) m[k] = (m[k] ?? 0) + 1; return m; }, {}),
          values: Object.fromEntries(['offerType', 'availableOnline', 'marketplace', 'brandName'].map((f) => [f, count((i) => String(i[f]))])),
          nextPageParams: data?.nextPage ? Object.fromEntries(new URL(data.nextPage, 'https://x.invalid').searchParams) : null,
        } : {}),
        // Search facets (when facet=on): name and its top values with counts.
        facets: (data?.facets ?? []).map((f) => ({
          name: f.name, displayName: f.displayName,
          values: (f.facetValues ?? []).slice(0, 12).map((v) => `${v.name} (${v.count})`),
        })),
      };
    }],

    // Walmart's category tree below a category (or the top level): names and ids.
    ['GET', '/api/:retailer/debug/taxonomy', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.source?.taxonomy) throw new HttpError(501, 'Live mode only');
      const id = query.get('category');
      const find = (list) => {
        for (const c of list ?? []) {
          if (c.id === id) return c;
          const hit = find(c.children);
          if (hit) return hit;
        }
        return null;
      };
      const all = await adapter.source.taxonomy();
      const node = id ? find(all) : { name: 'All', children: all };
      if (!node) throw new HttpError(404, 'No such category');
      const count = (c) => 1 + (c.children ?? []).reduce((n, x) => n + count(x), 0);
      return { id: node.id ?? null, name: node.name, children: (node.children ?? []).map((c) => ({ id: c.id, name: c.name, subcategories: count(c) - 1 })) };
    }],
  ].map(([method, pattern, handler]) => ({ method, pattern, handler, ...compile(pattern) }));
}

function compile(pattern) {
  const keys = [];
  const source = pattern.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return { route, params };
  }
  return null;
}
