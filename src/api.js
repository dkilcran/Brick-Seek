// JSON API. All routes are retailer-scoped (/api/:retailer/...) so new
// retailers show up automatically once they're in the registry.
import { isValidZip } from './lib/geo.js';
import { summarizeAvailability, isSoldByRetailer } from './retailers/RetailerAdapter.js';
import { analyzeDeal, isEligible, rankSection, SECTIONS } from './lib/deals.js';

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

// The site only covers items the retailer sells itself, not marketplace sellers.
function requireRetailerItem(adapter, product) {
  if (!product) throw new HttpError(404, 'Product not found');
  if (!isSoldByRetailer(product)) {
    throw new HttpError(404, `This item is sold by ${product.seller?.name ?? 'a marketplace seller'}, not ${adapter.name}`);
  }
  return product;
}

async function analyzeCandidates(adapter, { category } = {}) {
  const products = (await adapter.getDealCandidates({ category })).filter(isEligible);
  return Promise.all(products.map(async (p) => analyzeDeal(p, await adapter.getPriceHistoryFor(p))));
}

// One row per product: its best store markdown, plus how many stores have it.
async function localClearanceDeals(adapter, zip, { category, minDiscount = 0, limit = 50 } = {}) {
  const rows = (await adapter.getLocalClearance(zip, { category })).filter(
    (r) => isSoldByRetailer(r.product) && r.discountPercent >= minDiscount,
  );
  const byProduct = new Map();
  for (const r of rows) {
    const entry = byProduct.get(r.product.id);
    if (!entry) {
      byProduct.set(r.product.id, { best: r, stores: 1 });
    } else {
      entry.stores += 1;
      if (r.price < entry.best.price) entry.best = r;
    }
  }
  return [...byProduct.values()]
    .map(({ best, stores }) => ({
      product: best.product,
      lowestPrice: best.price,
      discountPercent: best.discountPercent,
      dollarsOff: Number((best.product.msrp - best.price).toFixed(2)),
      store: best.store,
      quantity: best.quantity,
      storesWithDeal: stores,
      clearance: true,
      reasons: ['Clearance'],
    }))
    .sort((a, b) => b.discountPercent - a.discountPercent)
    .slice(0, limit);
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
      const products = (await adapter.searchProducts(q, { limit: clampInt(query.get('limit'), 25, 1, 50) }))
        .filter(isSoldByRetailer);
      return { retailer: adapter.id, query: q, products };
    }],

    ['GET', '/api/:retailer/products/:id', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      return { product: requireRetailerItem(adapter, await adapter.getProduct(params.id)) };
    }],

    ['GET', '/api/:retailer/products/:id/inventory', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = requireZip(query.get('zip'));
      const radiusMiles = clampInt(query.get('radius'), 50, 5, 100);
      const result = await adapter.checkInventory(params.id, zip, { radiusMiles });
      requireRetailerItem(adapter, result?.product);
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

    // One section: top | drops | lowest | bigticket | clearance (needs zip)
    ['GET', '/api/:retailer/deals', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const section = query.get('section') ?? 'top';
      if (!SECTIONS[section]) throw new HttpError(400, `Unknown section "${section}"`);
      const opts = {
        category: query.get('category') || undefined,
        minDiscount: clampInt(query.get('minDiscount'), 0, 0, 100),
        limit: clampInt(query.get('limit'), 50, 1, 100),
      };
      if (section === 'clearance') {
        if (!adapter.features.localClearance) {
          throw new HttpError(501, `${adapter.name} doesn't publish store-level prices yet`);
        }
        return { section, deals: await localClearanceDeals(adapter, requireZip(query.get('zip')), opts) };
      }
      return { section, deals: rankSection(section, await analyzeCandidates(adapter, opts), opts) };
    }],

    // Every section at once, for the home page.
    ['GET', '/api/:retailer/deals/sections', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const zip = query.get('zip') || undefined;
      if (zip) requireZip(zip);
      const opts = { category: query.get('category') || undefined, limit: clampInt(query.get('limit'), 8, 1, 24) };
      const analyzed = await analyzeCandidates(adapter, opts);
      // Each product shows up once on the page, in the first section that wants it.
      const shown = new Set();
      const unseen = (deals) => deals.filter((d) => !shown.has(d.product.id)).slice(0, opts.limit);
      const sections = [];
      for (const [id, meta] of Object.entries(SECTIONS)) {
        let deals = [];
        let note = null;
        if (id === 'clearance') {
          note = !adapter.features.localClearance
            ? `${adapter.name} doesn't publish store-level prices, so this needs another data source.`
            : !zip ? 'Enter your ZIP code to see shelf markdowns at nearby stores.' : null;
          if (!note) deals = unseen(await localClearanceDeals(adapter, zip, { ...opts, limit: 100 }));
        } else {
          // Top goes first so nothing is hidden yet; later sections rank deeper to refill after repeats.
          deals = id === 'top' ? rankSection(id, analyzed, opts) : unseen(rankSection(id, analyzed, { ...opts, limit: 100 }));
        }
        deals.forEach((d) => shown.add(d.product.id));
        sections.push({ id, ...meta, deals, note });
      }
      return { sections };
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
