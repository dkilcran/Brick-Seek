// JSON API. All routes are retailer-scoped (/api/:retailer/...) so new
// retailers show up automatically once they're in the registry.
import { isValidZip } from './lib/geo.js';
import { summarizeAvailability, isSoldByRetailer } from './retailers/RetailerAdapter.js';
import { analyzeDeal, diversify, isEligible, rankSection, SECTIONS } from './lib/deals.js';
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
      // The online offer, kept apart from the store price that leads the page.
      onlinePrice: product.price ?? null,
      onlineSeller: product.seller?.name ?? null,
      price: best.price,
      // A discount only for a labeled deal (Walmart's offer or our markdown), not a bare was-price.
      msrp: best.label && best.refPrice ? best.refPrice : null,
      seller: { name: adapter.name, isRetailer: true },
      storeOffers,
    };
  }
  throw new HttpError(404, `This item is sold by ${product.seller?.name ?? 'a marketplace seller'}, not ${adapter.name}`);
}

const discoveryCache = new Map();

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
      referencePrice: best.product.msrp > best.price ? best.product.msrp : null,
      clearance: (best.kind ?? 'clearance') === 'clearance',
      // Walmart's Clearance, Rollback or Reduced Price, or our Markdown (demo data: Clearance).
      reasons: [best.label ?? 'Clearance'],
    }))
    .sort((a, b) => b.discountPercent - a.discountPercent);
}

/** Store deal types on the Deals page, by the deal label they keep. */
const STORE_TYPES = {
  'store-clearance': ['Clearance'],
  'store-rollback': ['Rollback', 'Rollback / Reduced Price'],
  'store-reduced': ['Reduced Price', 'Rollback / Reduced Price'],
  'store-markdown': ['Markdown'],
};

/** Deals whose product name has every word of `q` (any order, any case). */
export function filterByText(deals, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return deals;
  return deals.filter((d) => {
    const name = `${d.product.name ?? ''} ${d.product.brand ?? ''} ${d.product.id}`.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

/**
 * Re-order a deal list: 'percent' (% off), 'dollars' ($ off), 'price' (low to
 * high), 'price-desc'; anything else keeps the section's own order. Ties keep
 * that order too.
 */
export function sortDeals(deals, sort) {
  const by = {
    percent: (d) => -(d.discountPercent ?? 0),
    dollars: (d) => -(d.dollarsOff ?? 0),
    price: (d) => d.lowestPrice ?? Infinity,
    'price-desc': (d) => -(d.lowestPrice ?? -Infinity),
  }[sort];
  if (!by) return deals;
  return deals.map((d, i) => [by(d), i, d]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
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
      // Paged (25 at a time) where the retailer supports it; nextStart asks for more.
      if (adapter.searchPaged) {
        const page = await adapter.searchPaged(q, { start: clampInt(query.get('start'), 1, 1, 999) });
        return { retailer: adapter.id, query: q, products: page.products.filter(isSoldByRetailer), total: page.total, nextStart: page.nextStart };
      }
      const products = (await adapter.searchProducts(q, { limit: clampInt(query.get('limit'), 25, 1, 50) }))
        .filter(isSoldByRetailer);
      return { retailer: adapter.id, query: q, products, total: products.length, nextStart: null };
    }],

    ['GET', '/api/:retailer/products/:id', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const product = requireRetailerItem(adapter, await adapter.getProduct(params.id));
      return { product: { ...product, onlineDeal: adapter.onlineDeal?.(product.id) ?? null } };
    }],

    // The All Deals list: one card per item, with Walmart.com's deal and the best
    // store deal near the ZIP. where = online,stores (where the item is sold);
    // labels = clearance,rollback,reduced,markdown,drop,lowest; paged.
    ['GET', '/api/:retailer/all-deals', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.allDealCards) throw new HttpError(501, `${adapter.name} doesn't have All Deals yet`);
      const zip = query.get('zip') || undefined;
      if (zip) requireZip(zip);
      const list = (name) => (query.get(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const num = (name) => { const n = Number.parseFloat(query.get(name)); return Number.isFinite(n) ? n : undefined; };
      // Price-history badges (dropped since our last recorded price, lowest seen) for online prices.
      const history = new Map((await analyzeCandidates(adapter)).map((d) => [d.product.id, d]));
      const cards = (await adapter.allDealCards({ zip })).map((c) => {
        const h = history.get(c.product.id);
        return h ? { ...c, dropPercent: h.dropPercent, atLowest: h.atLowest } : c;
      });
      const all = sortCards(filterCards(cards, {
        where: list('where'), labels: list('labels'), q: query.get('q') ?? '', category: query.get('category') || undefined,
        minPrice: num('minPrice'), maxPrice: num('maxPrice'), minDiscount: clampInt(query.get('minDiscount'), 0, 0, 100),
      }), query.get('sort') ?? 'best');
      const limit = clampInt(query.get('limit'), 60, 1, 100);
      const offset = clampInt(query.get('offset'), 0, 0, 100000);
      const categories = [...new Set(cards.map((c) => c.product.category).filter(Boolean))].sort();
      return { total: all.length, offset, deals: all.slice(offset, offset + limit), hasMore: offset + limit < all.length, categories };
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
          // Walmart gives no distances, only nearest-first order (store.rank).
          : (a.store.distanceMiles ?? a.store.rank ?? Infinity) - (b.store.distanceMiles ?? b.store.rank ?? Infinity),
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

    // Check one store now (the product page's "Check store"); see WalmartAdapter.checkStore.
    ['GET', '/api/:retailer/products/:id/check-store', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      const storeId = query.get('store') ?? '';
      if (!/^\d{1,6}$/.test(storeId)) throw new HttpError(400, 'store should be a store number');
      if (!/^\d{1,15}$/.test(params.id)) throw new HttpError(400, 'Item id should be a number');
      if (!adapter.checkStore) throw new HttpError(501, `${adapter.name} store checks aren't available`);
      const result = await adapter.checkStore(params.id, storeId); // 429 when over the hourly cap
      if (!result) throw new HttpError(501, 'Store checks need live mode');
      return result;
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
      // One or more deal types, comma-separated: the online sections (top, drops,
      // lowest, bigticket) and the store deal labels near a ZIP (clearance =
      // every store deal; or store-clearance, store-rollback, store-reduced,
      // store-markdown). Lists are merged in that order, each item once.
      const sections = (query.get('section') ?? 'top').split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of sections) {
        if (!SECTIONS[s] && !STORE_TYPES[s]) throw new HttpError(400, `Unknown section "${s}"`);
      }
      const opts = {
        category: query.get('category') || undefined,
        minDiscount: clampInt(query.get('minDiscount'), 0, 0, 100),
      };
      // Full lists: every match, best first, no per-category or per-brand caps; paged.
      const limit = clampInt(query.get('limit'), 50, 1, 100);
      const offset = clampInt(query.get('offset'), 0, 0, 100000);
      let storeDeals = null;
      let analyzed = null;
      const seen = new Set();
      let all = [];
      for (const s of sections) {
        let list;
        if (s === 'clearance' || STORE_TYPES[s]) {
          if (!adapter.features.localClearance) {
            throw new HttpError(501, `${adapter.name} doesn't publish store-level prices yet`);
          }
          storeDeals ??= await localClearanceDeals(adapter, requireZip(query.get('zip')), opts);
          list = s === 'clearance' ? storeDeals : storeDeals.filter((d) => STORE_TYPES[s].includes(d.reasons[0]));
        } else {
          analyzed ??= await analyzeCandidates(adapter, opts);
          list = rankSection(s, analyzed, { ...opts, all: true });
        }
        for (const d of list) {
          if (seen.has(d.product.id)) continue;
          seen.add(d.product.id);
          all.push(d);
        }
      }
      all = sortDeals(filterByText(all, query.get('q')), query.get('sort'));
      return { section: sections.join(','), total: all.length, offset, deals: all.slice(offset, offset + limit), hasMore: offset + limit < all.length };
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
    // One-off measurement of Walmart's bulk feeds vs our lists: ?start=1 runs it
    // now, ?at=<ISO time> schedules it (kept across restarts).
    ['GET', '/api/:retailer/debug/feed-measure', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.feedMeasure) throw new HttpError(501, 'Live mode only');
      const storeId = /^\d{1,6}$/.test(query.get('store') ?? '') ? query.get('store') : '573';
      let scheduled = null;
      const at = query.get('at');
      const until = query.get('until') && !Number.isNaN(Date.parse(query.get('until'))) ? new Date(query.get('until')).toISOString() : null;
      const pages = (name, d) => clampInt(query.get(name), d, 1, 200);
      const opts = {
        storeId, until, dealPages: pages('dealPages', 60), everythingPages: pages('everythingPages', 25),
        parts: (query.get('parts') ?? 'deals,everything').split(',').filter((x) => ['deals', 'everything'].includes(x)),
        lookups: query.get('lookups') !== '0',
      };
      if (at && !Number.isNaN(Date.parse(at))) scheduled = adapter.feedMeasure.schedule({ ...opts, at: new Date(at).toISOString() });
      else if (query.get('start') === '1') scheduled = adapter.feedMeasure.schedule(opts);
      return { scheduled, ...adapter.feedMeasure.status() };
    }],

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
      for (const k of ['category', 'specialOffer', 'storeId', 'count', 'query', 'categoryId', 'start', 'numItems', 'soldByWmt', 'available', 'brand',
        'facet', 'facet.filter', 'facet.range', 'responseGroup', 'sort', 'order', 'maxId', 'minId', 'lastDoc', 'minPrice', 'maxPrice']) {
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
        sample: items.slice(0, 5).map((i) => ({ itemId: i.itemId, name: i.name?.slice(0, 50), seller: i.sellerInfo ?? null, salePrice: i.salePrice, stock: i.stock, clearance: i.clearance, strikeThroughPrice: i.strikeThroughPrice ?? null })),
        // With fields=1: which fields the items carry, values of the ones that might
        // tell in-store items apart, the next page's parameters, and the item id range.
        ...(query.get('fields') === '1' ? {
          fields: items.reduce((m, i) => { for (const k of Object.keys(i)) m[k] = (m[k] ?? 0) + 1; return m; }, {}),
          values: Object.fromEntries(['offerType', 'shipToStore', 'freeShipToStore', 'availableOnline', 'marketplace', 'isTwoDayShippingEligible', 'brandName']
            .map((f) => [f, count((i) => String(i[f]))])),
          nextPageParams: data?.nextPage ? Object.fromEntries(new URL(data.nextPage, 'https://x.invalid').searchParams) : null,
          itemIds: items.length ? { first: items[0].itemId, last: items.at(-1).itemId, min: Math.min(...items.map((i) => Number(i.itemId))), max: Math.max(...items.map((i) => Number(i.itemId))) } : null,
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

    // Is discovery worth it? Finds per day and per department/page, new vs already
    // in the product list, and how many turned out marked down at a store.
    ['GET', '/api/:retailer/discovery-stats', async ({ params, query }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeData) return { enabled: false, reason: 'Live mode only' };
      const days = clampInt(query.get('days'), 7, 1, 60);
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      // Reused for 10 minutes: it reads every find in the window.
      const key = `${adapter.id}|${since}`;
      const hit = discoveryCache.get(key);
      if (hit && Date.now() - hit.at < 10 * 60000) return hit.result;
      const result = { since, ...(await adapter.storeData.discoveryYield(adapter.id, since)) };
      discoveryCache.set(key, { at: Date.now(), result });
      return result;
    }],

    // Free store checks (Walmart item lookup per store): today's progress.
    ['GET', '/api/:retailer/store-check', async ({ params }) => {
      const adapter = requireRetailer(registry, params.retailer);
      if (!adapter.storeChecker) return { enabled: false, reason: 'Live mode only' };
      return { enabled: true, ...adapter.storeChecker.status(), prices: adapter.storeData.priceCount(adapter.id), databaseMb: adapter.storeData.sizeMb(), databaseFreeMb: adapter.storeData.freeMb() };
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
