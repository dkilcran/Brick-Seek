// JSON API. All routes are retailer-scoped (/api/:retailer/...) so new
// retailers show up automatically once they're in the registry.
import { isValidZip } from './lib/geo.js';
import { summarizeAvailability } from './retailers/RetailerAdapter.js';

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

export function createRoutes(registry) {
  return [
    ['GET', '/api/health', () => ({ ok: true })],

    ['GET', '/api/retailers', () => ({ retailers: registry.list().map((r) => r.describe()) })],

    ['GET', '/api/:retailer/search', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const q = (query.get('q') ?? '').trim();
      if (!q) throw new HttpError(400, 'Query parameter "q" is required');
      const products = await adapter.searchProducts(q, { limit: clampInt(query.get('limit'), 25, 1, 50) });
      return { retailer: adapter.id, query: q, products };
    }],

    ['GET', '/api/:retailer/products/:id', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const product = await adapter.getProduct(params.id);
      if (!product) throw new HttpError(404, 'Product not found');
      return { product };
    }],

    ['GET', '/api/:retailer/products/:id/inventory', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = requireZip(query.get('zip'));
      const radiusMiles = clampInt(query.get('radius'), 50, 5, 100);
      const result = await adapter.checkInventory(params.id, zip, { radiusMiles });
      if (!result) throw new HttpError(404, 'Product not found');
      const sort = query.get('sort') ?? 'distance';
      const results = [...result.results].sort((a, b) =>
        sort === 'price'
          ? (a.price ?? Infinity) - (b.price ?? Infinity)
          : (a.store.distanceMiles ?? Infinity) - (b.store.distanceMiles ?? Infinity),
      );
      return {
        product: result.product,
        zip,
        radiusMiles,
        summary: summarizeAvailability(results),
        results,
        checkedAt: new Date().toISOString(),
      };
    }],

    ['GET', '/api/:retailer/products/:id/history', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const history = await adapter.getPriceHistory(params.id, { days: clampInt(query.get('days'), 90, 7, 365) });
      if (!history) throw new HttpError(404, 'Product not found');
      return { history };
    }],

    ['GET', '/api/:retailer/stores', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = requireZip(query.get('zip'));
      return { zip, stores: await adapter.findStores(zip, { radiusMiles: clampInt(query.get('radius'), 50, 5, 100) }) };
    }],

    ['GET', '/api/:retailer/deals', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = query.get('zip') || undefined;
      if (zip) requireZip(zip);
      const deals = await adapter.getDeals({
        zip,
        category: query.get('category') || undefined,
        minDiscount: clampInt(query.get('minDiscount'), 0, 0, 100),
        limit: clampInt(query.get('limit'), 50, 1, 100),
      });
      return { deals };
    }],

    ['GET', '/api/:retailer/categories', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      return { categories: await adapter.getCategories() };
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
