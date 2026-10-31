// JSON API. All routes are retailer-scoped (/api/:retailer/...) so new
// retailers show up automatically once they're in the registry.
import { isValidZip } from './lib/geo.js';
import { summarizeAvailability, isSoldByRetailer } from './retailers/RetailerAdapter.js';
import { analyzeDeal, diversify, isEligible, rankSection, SECTIONS } from './lib/deals.js';
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

// The site only covers items the retailer sells itself, not marketplace sellers.
// An item a marketplace seller has online still counts when the store scan
// found the retailer selling it in a store; both offers are returned.
function requireRetailerItem(adapter, product) {
  if (!product) throw new HttpError(404, 'Product not found');
  const storeOffers = adapter.storeOffers?.(product.id) ?? [];
  if (!storeOffers.length) {
    if (isSoldByRetailer(product)) return product;
  } else {
    // The store scan sees the retailer's own offer for nearby stores; the
    // catalog lookup only knows the default online offer, which may be
    // another seller's or out of date. Lead with the store offer.
    const best = storeOffers[0];
    return {
      ...product,
      price: best.price,
      msrp: best.wasPrice ?? best.price,
      seller: { name: adapter.name, isRetailer: true },
      storeOffers,
    };
  }
  throw new HttpError(404, `This item is sold by ${product.seller?.name ?? 'a marketplace seller'}, not ${adapter.name}`);
}

// Ranking ~20k items takes a few hundred ms, so reuse it until the pool changes.
const analysisCache = new Map();

async function analyzeCandidates(adapter, { category } = {}) {
  // Don't hold requests while a freshly restarted server loads its deal pool.
  const products = await adapter.getDealCandidates({ category, wait: false });
  const today = new Date().toISOString().slice(0, 10);
  const key = `${adapter.id}|${category ?? ''}|${adapter.dealPoolStamp ?? ''}|${today}`;
  if (adapter.dealPoolStamp != null && analysisCache.has(key)) return analysisCache.get(key);
  const analyzed = await Promise.all(
    products.filter(isEligible).map(async (p) => analyzeDeal(p, await adapter.getPriceHistoryFor(p))),
  );
  if (adapter.dealPoolStamp != null) {
    for (const k of analysisCache.keys()) if (k.startsWith(`${adapter.id}|`) && !k.includes(`|${adapter.dealPoolStamp}|`)) analysisCache.delete(k);
    analysisCache.set(key, analyzed);
  }
  return analyzed;
}

// One row per product: its best store markdown, plus how many stores have it.
// Returns every match, biggest discount first.
async function localClearanceDeals(adapter, zip, { category, minDiscount = 0 } = {}) {
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
      onlineSeller: best.product.onlineSeller ?? null,
      store: best.store,
      quantity: best.quantity,
      storesWithDeal: stores,
      clearance: true,
      reasons: ['Clearance'],
    }))
    .sort((a, b) => b.discountPercent - a.discountPercent);
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function createRoutes(registry, { scanConfigPath = process.env.SCAN_CONFIG_PATH || DEFAULT_SCAN_CONFIG_PATH } = {}) {
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
      const product = requireRetailerItem(adapter, result?.product);
      const sort = query.get('sort') ?? 'distance';
      const results = [...result.results].sort((a, b) =>
        sort === 'price'
          ? (a.price ?? Infinity) - (b.price ?? Infinity)
          : (a.store.distanceMiles ?? Infinity) - (b.store.distanceMiles ?? Infinity),
      );
      return {
        product,
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
      return {
        zip,
        stores: await adapter.findStores(zip, { radiusMiles: clampInt(query.get('radius'), 50, 5, 100), limit: clampInt(query.get('limit'), 15, 1, 50) }),
      };
    }],

    // One section: top | drops | lowest | bigticket | clearance (needs zip)
    ['GET', '/api/:retailer/deals', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const section = query.get('section') ?? 'top';
      if (!SECTIONS[section]) throw new HttpError(400, `Unknown section "${section}"`);
      const opts = {
        category: query.get('category') || undefined,
        minDiscount: clampInt(query.get('minDiscount'), 0, 0, 100),
      };
      // Full lists: every match, best first, no per-category or per-brand caps; paged.
      const limit = clampInt(query.get('limit'), 50, 1, 100);
      const offset = clampInt(query.get('offset'), 0, 0, 100000);
      let all;
      if (section === 'clearance') {
        if (!adapter.features.localClearance) {
          throw new HttpError(501, `${adapter.name} doesn't publish store-level prices yet`);
        }
        all = await localClearanceDeals(adapter, requireZip(query.get('zip')), opts);
      } else {
        all = rankSection(section, await analyzeCandidates(adapter, opts), { ...opts, all: true });
      }
      return { section, total: all.length, offset, deals: all.slice(offset, offset + limit), hasMore: offset + limit < all.length };
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
          if (!note) {
            // At most 2 per brand on the home page, like the other sections.
            const fresh = (await localClearanceDeals(adapter, zip, opts)).filter((d) => !shown.has(d.product.id));
            deals = diversify(fresh, { limit: opts.limit, perCategory: Infinity, perBrand: 2 });
            if (!deals.length) note = 'No clearance found yet at scanned stores near this ZIP.';
          }
        } else if (adapter.dealsLoading) {
          note = 'Deals are loading after a site update. Check back in a few minutes.';
        } else {
          // Top goes first so nothing is hidden yet; later sections rank deeper to refill after repeats.
          // Keep the caps for the visible count even though later sections rank deeper.
          const caps = { perCategory: Math.max(2, Math.ceil(opts.limit / 8)), perBrand: Math.max(2, Math.ceil(opts.limit / 12)) };
          deals = id === 'top' ? rankSection(id, analyzed, opts) : unseen(rankSection(id, analyzed, { ...opts, ...caps, limit: 100 }));
        }
        deals.forEach((d) => shown.add(d.product.id));
        sections.push({ id, ...meta, deals, note });
      }
      return { sections };
    }],

    // Diagnostics: what the deal pool holds and how long ranking takes.
    ['GET', '/api/:retailer/stats', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const started = Date.now();
      const analyzed = await analyzeCandidates(adapter);
      const analysisMs = Date.now() - started;
      const all = await adapter.getDealCandidates();
      const excluded = {
        marketplaceSeller: all.filter((p) => p.seller?.isRetailer !== true).length,
        noPrice: all.filter((p) => p.seller?.isRetailer === true && !(p.price > 0)).length,
        staleNotOnline: all.filter((p) => p.seller?.isRetailer === true && p.price > 0 && p.inStockOnline === false
          && p.listingActive === false && !p.specialOffer).length,
      };
      const sellers = {};
      for (const p of all) if (p.seller?.isRetailer !== true) sellers[p.seller?.name ?? '?'] = (sellers[p.seller?.name ?? '?'] ?? 0) + 1;
      const byCategory = {};
      for (const d of analyzed) byCategory[d.product.category ?? 'Other'] = (byCategory[d.product.category ?? 'Other'] ?? 0) + 1;
      return {
        retailer: adapter.id,
        mode: adapter.mode,
        pool: adapter.dealPoolStats?.() ?? null,
        eligible: analyzed.length,
        inStoreOnly: analyzed.filter((d) => d.product.inStockOnline === false).length,
        excluded,
        topMarketplaceSellers: Object.entries(sellers).sort((x, y) => y[1] - x[1]).slice(0, 10),
        discounted: analyzed.filter((d) => d.discountPercent > 0).length,
        withHistory: analyzed.filter((d) => d.previousPrice !== null).length,
        over100: analyzed.filter((d) => d.product.price >= 100 && d.dollarsOff > 0).length,
        analysisMs,
        byCategory: Object.fromEntries(Object.entries(byCategory).sort((x, y) => y[1] - x[1])),
      };
    }],

    // Diagnostics: raw retailer fields, to find signals of stale listings.
    ['GET', '/api/:retailer/stats/fields', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      await adapter.getDealCandidates();
      return adapter.fieldSurvey?.() ?? { error: 'not available for this retailer' };
    }],

    // Store-level price scan: budget use, schedule, recent searches, a raw sample result.
    ['GET', '/api/:retailer/store-scan', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeScanner) return { enabled: false, reason: 'Needs live mode and SERPAPI_KEY' };
      return { enabled: true, ...(await adapter.storeScanner.status()) };
    }],

    // A sample of scanned store prices next to the walmart.com price, with links
    // for checking by hand against Walmart's own store view.
    ['GET', '/api/:retailer/store-scan/sample', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeData) return { enabled: false, reason: 'Live mode only' };
      const rows = adapter.storeData.samplePrices(adapter.id, clampInt(query.get('n'), 15, 1, 40));
      const online = await adapter.onlinePrices([...new Set(rows.map((r) => r.item_id))]);
      const items = rows.map((r) => {
        const o = online.get(r.item_id) ?? null;
        const diff = o?.price != null && r.price != null ? Number((r.price - o.price).toFixed(2)) : null;
        return {
          itemId: r.item_id, title: r.title, store: r.store_id, department: r.department, scannedOn: r.date,
          storePrice: r.price, onlinePrice: o?.price ?? null, difference: diff,
          storeInStock: r.in_stock === null ? null : r.in_stock === 1, onlineSeller: o?.seller ?? null,
          link: `https://www.walmart.com/ip/${r.item_id}`,
        };
      });
      const compared = items.filter((i) => i.difference !== null);
      return {
        summary: {
          sampled: items.length,
          compared: compared.length,
          sameAsOnline: compared.filter((i) => i.difference === 0).length,
          lowerInStore: compared.filter((i) => i.difference < 0).length,
          higherInStore: compared.filter((i) => i.difference > 0).length,
        },
        items,
      };
    }],

    // Diagnostics: raw Walmart affiliate lookup for one item, and saved SerpApi inspections.
    ['GET', '/api/:retailer/debug/item/:id', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.source?.rawItem) throw new HttpError(501, 'Live mode only');
      if (!/^\d{1,15}$/.test(params.id)) throw new HttpError(400, 'Item id should be a number');
      // Only these optional lookup parameters are passed through to Walmart.
      const passthrough = {};
      for (const k of ['storeId', 'zipCode', 'zip', 'store', 'lat', 'lon']) {
        const v = query.get(k);
        if (v && /^[\d.-]{1,12}$/.test(v)) passthrough[k] = v;
      }
      return { params: passthrough, affiliate: await adapter.source.rawItem(params.id, { params: passthrough, batch: query.get('batch') === '1' }) };
    }],

    // Diagnostics: one page of a Walmart bulk feed (department or special-offer
    // list), optionally for a store, summarized.
    ['GET', '/api/:retailer/debug/feed', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.source?.request) throw new HttpError(501, 'Live mode only');
      const p = {};
      for (const k of ['category', 'specialOffer', 'storeId', 'count', 'query', 'categoryId', 'start', 'numItems',
        'facet', 'facet.filter', 'responseGroup', 'sort', 'order']) {
        const values = query.getAll(k).filter((v) => /^[\w .:&'-]{1,60}$/.test(v));
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
        sample: items.slice(0, 5).map((i) => ({ itemId: i.itemId, name: i.name?.slice(0, 50), seller: i.sellerInfo ?? null, salePrice: i.salePrice, stock: i.stock, clearance: i.clearance, strikeThroughPrice: i.strikeThroughPrice ?? null })),
        // Search facets (when facet=on): name and its top values with counts.
        facets: (data?.facets ?? []).map((f) => ({
          name: f.name, displayName: f.displayName,
          values: (f.facetValues ?? []).slice(0, 12).map((v) => `${v.name} (${v.count})`),
        })),
      };
    }],

    // Free store checks (Walmart item lookup per store): today's progress.
    ['GET', '/api/:retailer/store-check', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeChecker) return { enabled: false, reason: 'Live mode only' };
      return { enabled: true, ...adapter.storeChecker.status(), prices: adapter.storeData.priceCount(adapter.id) };
    }],

    ['GET', '/api/:retailer/store-scan/inspect', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeScanner) return { enabled: false };
      return adapter.storeScanner.db.getMeta('inspectResults') ?? { pending: true };
    }],

    // Store scan settings as loaded, checked against the retailer's departments.
    ['GET', '/api/:retailer/scan-config', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const departments = (await adapter.getDepartments?.().catch(() => [])) ?? [];
      return describeScanConfig(loadScanConfig(scanConfigPath), departments);
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
