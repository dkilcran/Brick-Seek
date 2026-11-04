import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseWalmartInput } from '../src/retailers/walmart/identifiers.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';
import { WalmartDemoSource } from '../src/retailers/walmart/demoSource.js';
import { WalmartLiveSource, signWalmartRequest, isWalmartSeller, departmentOf, realMsrp } from '../src/retailers/walmart/liveSource.js';
import { CATALOG } from '../src/retailers/walmart/catalog.js';
import { ItemChecks } from '../src/lib/itemChecks.js';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { stateForZip } from '../src/lib/geo.js';

test('parseWalmartInput recognizes URLs, UPCs, item ids and keywords', () => {
  assert.deepEqual(parseWalmartInput('https://www.walmart.com/ip/Some-TV-55-inch/123456789'), { type: 'itemId', value: '123456789' });
  assert.deepEqual(parseWalmartInput('walmart.com/ip/987654'), { type: 'itemId', value: '987654' });
  assert.deepEqual(parseWalmartInput('0 12345 67890 5'), { type: 'upc', value: '012345678905' });
  assert.deepEqual(parseWalmartInput('501001'), { type: 'itemId', value: '501001' });
  assert.deepEqual(parseWalmartInput('air fryer'), { type: 'query', value: 'air fryer' });
  assert.equal(parseWalmartInput('  ').type, 'empty');
});

test('demo catalog UPCs are valid UPC-A', () => {
  for (const { upc } of CATALOG) {
    assert.match(upc, /^\d{12}$/);
    const digits = [...upc].map(Number);
    const sum = digits.slice(0, 11).reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
    assert.equal((10 - (sum % 10)) % 10, digits[11]);
  }
});

test('demo adapter searches by keyword, item id and UPC', async () => {
  const adapter = new WalmartAdapter();
  const byName = await adapter.searchProducts('air fryer');
  assert.ok(byName.some((p) => p.id === '504002'));
  const [byId] = await adapter.searchProducts('504002');
  assert.equal(byId.id, '504002');
  const [byUpc] = await adapter.searchProducts(byId.upc);
  assert.equal(byUpc.id, '504002');
  assert.deepEqual(await adapter.searchProducts('https://www.walmart.com/ip/x/999999999'), []);
});

test('demo inventory is deterministic and well formed', async () => {
  const fixed = () => new Date('2026-10-26T12:00:00Z');
  const adapter = new WalmartAdapter({ source: new WalmartDemoSource({ now: fixed }) });
  const a = await adapter.checkInventory('501001', '72712');
  const b = await adapter.checkInventory('501001', '72712');
  assert.deepEqual(a, b);
  assert.ok(a.results.length > 0);
  for (const r of a.results) {
    assert.ok(['in_stock', 'limited', 'out_of_stock'].includes(r.status));
    assert.equal(typeof r.price, 'number');
    assert.ok(r.price > 0);
    assert.equal(r.store.state, 'AR');
    assert.ok(r.store.distanceMiles <= 50);
  }
  const sorted = a.results.map((r) => r.store.distanceMiles);
  assert.deepEqual(sorted, [...sorted].sort((x, y) => x - y));
  assert.equal(await adapter.checkInventory('nope', '72712'), null);
});

test('demo deal candidates include marketplace items with seller info', async () => {
  const adapter = new WalmartAdapter();
  const products = await adapter.getDealCandidates();
  const rug = products.find((p) => p.id === '511001');
  assert.deepEqual(rug.seller, { name: 'RugDirect Outlet', isRetailer: false });
  assert.ok(products.filter((p) => p.seller.isRetailer).length > 30);
  const homeOnly = await adapter.getDealCandidates({ category: 'Home' });
  assert.ok(homeOnly.every((p) => p.category === 'Home'));
});

test('demo local clearance only lists stocked clearance items', async () => {
  const adapter = new WalmartAdapter();
  const rows = await adapter.getLocalClearance('72712');
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.ok(r.quantity > 0);
    assert.ok(r.price < r.product.price);
  }
});

test('demo price history ends at the current price', async () => {
  const adapter = new WalmartAdapter();
  const history = await adapter.getPriceHistory('501003', { days: 30 });
  assert.equal(history.length, 30);
  assert.equal(history.at(-1).price, CATALOG.find((p) => p.itemId === '501003').price);
});

test('stateForZip maps ZIP3 prefixes', () => {
  assert.equal(stateForZip('10001'), 'NY');
  assert.equal(stateForZip('90210'), 'CA');
  assert.equal(stateForZip('72712'), 'AR');
  assert.equal(stateForZip('abc'), null);
});

test('Walmart I/O request signature verifies with the public key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const headers = signWalmartRequest({ consumerId: 'abc', keyVersion: '1', privateKey: pem, timestamp: 1700000000000 });
  assert.equal(headers['WM_CONSUMER.INTIMESTAMP'], '1700000000000');
  const verifier = createVerify('RSA-SHA256');
  verifier.update('abc\n1700000000000\n1\n');
  assert.ok(verifier.verify(publicKey, headers['WM_SEC.AUTH_SIGNATURE'], 'base64'));
});

test('live source normalizes affiliate API responses', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const body = String(url).includes('/stores')
      ? [{ no: 100, name: 'Rogers Supercenter', streetAddress: '1 Main', city: 'Rogers', stateProvCode: 'AR', zip: '72756' }]
      : { items: [{ itemId: 42, name: 'Thing', salePrice: 9.98, msrp: 19.99, upc: '000000000042', categoryPath: 'Home/Kitchen', brandName: 'Acme' }] };
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  const adapter = new WalmartAdapter({ source, mode: 'live' });
  const [p] = await adapter.searchProducts('thing');
  assert.equal(p.id, '42');
  assert.equal(p.category, 'Home');
  const inv = await adapter.checkInventory('42', '72756');
  assert.equal(inv.results[0].status, 'unknown');
  assert.equal(inv.results[0].store.city, 'Rogers');
  assert.ok(calls.some((u) => u.includes('/search?query=thing')));
  assert.equal(adapter.features.storeQuantities, false);
  assert.equal(adapter.features.localClearance, false);
  await assert.rejects(adapter.getLocalClearance('72756'), /local clearance/);
});

test('departmentOf skips the "Home Page" root of real category paths', () => {
  assert.equal(departmentOf('Home Page/Home/Rugs/Area Rugs'), 'Home');
  assert.equal(departmentOf('Home Page/Food/Beverages/Soda Pop'), 'Food');
  assert.equal(departmentOf('Electronics/TVs'), 'Electronics');
  assert.equal(departmentOf('Home Page'), null);
  assert.equal(departmentOf(undefined), null);
});

test('isWalmartSeller keeps only first-party items', () => {
  assert.equal(isWalmartSeller({ sellerInfo: 'Walmart.com' }), true);
  assert.equal(isWalmartSeller({ sellerInfo: 'walmart' }), true);
  assert.equal(isWalmartSeller({ sellerInfo: 'RugDirect Outlet', marketplace: true }), false);
  assert.equal(isWalmartSeller({ marketplace: true }), false);
  assert.equal(isWalmartSeller({ marketplace: false }), true);
});

test('live deal pool merges trends, offer feeds and categories without duplicates', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const item = (itemId, extra = {}) => ({ itemId, name: `Item ${itemId}`, salePrice: 10, msrp: 20, categoryPath: 'Home Page/Home/Decor', ...extra });
  const responses = {
    '/taxonomy': { categories: [{ id: '1', name: 'Home' }, { id: '2', name: 'Toys' }] },
    '/trends': { items: [item(1), item(2, { sellerInfo: 'Rug Co', marketplace: true })] },
    'specialOffer=clearance': { items: [item(3, { clearance: true })] },
    'specialOffer=rollback': { items: [item(1)] },
    'category=1': { items: [item(4, { customerRating: '4.6', numReviews: 120, stock: 'Available' })] },
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    const key = Object.keys(responses).find((k) => u.includes(k));
    if (!key) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => responses[key], text: async () => '' };
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  const warn = console.warn;
  console.warn = () => {}; // category 2 fails on purpose
  const pool = await source.dealCandidates();
  console.warn = warn;
  assert.deepEqual(pool.map((p) => p.id).sort(), ['1', '2', '3', '4']);
  const byId = Object.fromEntries(pool.map((p) => [p.id, p]));
  assert.equal(byId['2'].seller.isRetailer, false);
  assert.equal(byId['3'].specialOffer, 'clearance');
  assert.equal(byId['4'].rating, 4.6);
  assert.equal(byId['4'].inStockOnline, true);
  assert.equal(byId['4'].category, 'Home');
});

test('fromEnv picks live mode only when credentials are present', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const base = {};
  assert.equal(WalmartAdapter.fromEnv(base).mode, 'demo');
  const keys = { ...base, WALMART_CONSUMER_ID: 'abc', WALMART_PRIVATE_KEY: pem.replace(/\n/g, '\\n') };
  assert.equal(WalmartAdapter.fromEnv(keys).mode, 'live');
  assert.equal(WalmartAdapter.fromEnv({ ...keys, WALMART_MODE: 'demo' }).mode, 'demo');
  assert.throws(() => WalmartAdapter.fromEnv({ ...base, WALMART_MODE: 'live' }), /WALMART_CONSUMER_ID/);
});

test('live pool follows nextPage up to the page limit and refreshes in the background', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  let generation = 0;
  const page = (start) => Array.from({ length: 3 }, (_, i) => ({
    itemId: start + i, name: `Item ${start + i}`, salePrice: 10 + generation, msrp: 20, categoryPath: 'Home Page/Toys',
  }));
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname.split('/').pop() + u.search);
    let body;
    if (u.pathname.endsWith('/taxonomy')) body = { categories: [{ id: '7', name: 'Toys' }, { id: '9', name: 'Help' }] };
    else if (u.pathname.endsWith('/trends')) body = { items: page(900) };
    else if (u.searchParams.get('specialOffer')) body = { items: [] };
    else {
      const n = Number(u.searchParams.get('lastDoc') ?? 0);
      // endless pages: the page limit has to stop it
      body = { items: page(100 + n * 10), nextPage: `/api-proxy/service/affil/product/v2/paginated/items?category=7&lastDoc=${n + 1}&publisherId=x` };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const source = new WalmartLiveSource({
    consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl,
    poolPages: 3, poolRefreshMs: 0,
  });
  const recorded = [];
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker: { recordMany: (_r, ps) => recorded.push(ps.length), history: () => [] } });

  const first = await adapter.getDealCandidates();
  assert.equal(first.length, 3 + 9); // trending + 3 pages of Toys
  assert.equal(calls.filter((c) => c.includes('category=7')).length, 3);
  assert.ok(!calls.some((c) => c.includes('category=9')), '"Help" is not a product department');
  assert.ok(calls.some((c) => c.includes('lastDoc=2')), 'followed nextPage');
  const stats = adapter.dealPoolStats();
  assert.equal(stats.uniqueItems, 12);
  assert.deepEqual(stats.feeds.find((f) => f.name === 'Toys'), { name: 'Toys', pages: 3, items: 9, error: null });

  // Pool is stale (refresh 0ms): callers get the old pool at once while a refresh runs.
  generation = 1;
  const again = await adapter.getDealCandidates();
  // Category pages skip the response cache, so they show the new generation's price.
  const toy = (list) => list.find((p) => p.id === '100');
  assert.equal(toy(again).price, 10, 'served the previous pool');
  await source.poolRefresh;
  const fresh = await adapter.getDealCandidates();
  assert.equal(toy(fresh).price, 11, 'refreshed pool replaces it');
  assert.equal(recorded.length, 2, 'each pool is recorded once, not on every call');
});

test('a failing feed is reported in stats without emptying the pool', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/taxonomy')) return { ok: true, status: 200, json: async () => ({ categories: [{ id: '1', name: 'Home' }] }), text: async () => '' };
    if (u.includes('/trends')) return { ok: true, status: 200, json: async () => ({ items: [{ itemId: 1, name: 'A', salePrice: 5, msrp: 9 }] }), text: async () => '' };
    return { ok: false, status: 429, json: async () => ({}), text: async () => 'Too Many Requests' };
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  const pool = await source.dealCandidates();
  console.warn = warn;
  console.log = log;
  assert.equal(pool.length, 1);
  assert.match(source.poolStats().feeds.find((f) => f.name === 'Home').error, /429/);
});

test('live requests retry after a 429 and are spaced out', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const times = [];
  let calls = 0;
  const fetchImpl = async () => {
    times.push(Date.now());
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0.05' }, text: async () => 'slow down' };
    return { ok: true, status: 200, json: async () => ({ items: [{ itemId: 1, name: 'A', salePrice: 5, sellerInfo: 'Walmart.com' }] }), text: async () => '' };
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl, minIntervalMs: 30 });
  const [p] = await source.search('a');
  assert.equal(p.id, '1');
  assert.equal(calls, 2, 'retried once');
  await source.search('b');
  assert.ok(times[2] - times[1] >= 25, 'next request waited its turn');
});

test('a feed that fails again keeps its items from the previous pool', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let homeFails = false;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/taxonomy')) return ok({ categories: [{ id: '1', name: 'Home' }, { id: '2', name: 'Toys' }] });
    if (u.includes('category=1')) {
      if (homeFails) return { ok: false, status: 429, text: async () => 'Too Many Requests' };
      return ok({ items: [{ itemId: 11, name: 'Lamp', salePrice: 5 }, { itemId: 12, name: 'Rug', salePrice: 6 }] });
    }
    if (u.includes('category=2')) return ok({ items: [{ itemId: 21, name: 'Ball', salePrice: 3 }] });
    return ok({ items: [] });
  };
  const source = new WalmartLiveSource({
    consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl,
  });
  const quiet = [console.warn, console.log];
  console.warn = () => {};
  console.log = () => {};
  source.pool = await source.fetchPool();
  homeFails = true;
  const second = await source.fetchPool();
  [console.warn, console.log] = quiet;
  assert.deepEqual(second.products.map((p) => p.id).sort(), ['11', '12', '21']);
  const home = second.stats.feeds.find((f) => f.name === 'Home');
  assert.equal(home.reusedPrevious, 2);
  assert.equal(second.stats.failedFeeds, 1);
});

test('a 9999 list price is a placeholder, not a discount', () => {
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: 'unused' });
  const rug = source.toProduct({ itemId: 1, name: 'Rug', salePrice: 139.98, msrp: 9999, stock: 'Not available' });
  assert.equal(rug.msrp, 139.98, 'falls back to the sale price: no discount');
  assert.equal(source.toProduct({ itemId: 2, name: 'Tee', salePrice: 7, msrp: 8.5 }).msrp, 8.5);
  assert.equal(realMsrp(9999), null);
  assert.equal(realMsrp(12000), null);
  assert.equal(realMsrp(0), null);
  assert.equal(realMsrp(349.99), 349.99);
});

test('listingActive reflects whether Walmart reports a current best offer', () => {
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: 'unused' });
  assert.equal(source.toProduct({ itemId: 1, name: 'A', salePrice: 1, bestMarketplacePrice: { price: 1 } }).listingActive, true);
  assert.equal(source.toProduct({ itemId: 2, name: 'B', salePrice: 1 }).listingActive, false);
  assert.equal(source.toProduct({ itemId: 3, name: 'C', salePrice: 5.97, bestMarketplacePrice: { price: 316.91 } }).currentOfferPrice, 316.91);
  assert.equal(source.toProduct({ itemId: 4, name: 'D', salePrice: 1 }).currentOfferPrice, null);
});

test('unnamed marketplace listings are not labeled Walmart.com', () => {
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: 'unused' });
  const p = source.toProduct({ itemId: 1, name: 'X', salePrice: 1, marketplace: true });
  assert.equal(p.seller.isRetailer, false);
  assert.notEqual(p.seller.name, 'Walmart.com');
});

test('field survey splits raw Walmart fields by online availability', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const items = [
    { itemId: 1, name: 'Old', salePrice: 1.4, msrp: 140, stock: 'Not available', offerType: 'ONLINE_AND_STORE', availableOnline: false },
    { itemId: 2, name: 'Live', salePrice: 9.97, msrp: 20, stock: 'Available', offerType: 'ONLINE_AND_STORE', availableOnline: true },
  ];
  const fetchImpl = async (url) => ({
    ok: true, status: 200, text: async () => '',
    json: async () => (String(url).includes('/taxonomy') ? { categories: [] } : { items: String(url).includes('/trends') ? items : [] }),
  });
  const source = new WalmartLiveSource({ consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  const log = console.log;
  console.log = () => {};
  await source.dealCandidates();
  console.log = log;
  const survey = source.fieldSurvey();
  assert.deepEqual(survey.sizes, { online: 1, notOnline: 1 });
  assert.deepEqual(survey.flags.availableOnline, { online: { true: 1 }, notOnline: { false: 1 } });
  assert.deepEqual(survey.priceCents, { online: { 97: 1 }, notOnline: { 40: 1 } });
  assert.equal(survey.samples.notOnlineHugeDiscount[0].itemId, 1);
  assert.ok(!('offerType' in (await source.dealCandidates())[0]), 'raw fields stay out of products');
});

test('feed items have an unknown seller until a lookup confirms it', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const lookups = [];
  const feed = [
    { itemId: 1, name: 'Snow bib', salePrice: 5.83, msrp: 28.98 },
    { itemId: 2, name: 'Cake pans', salePrice: 3.66, msrp: 61.19 },
    { itemId: 3, name: 'Gone', salePrice: 2, msrp: 10 },
    { itemId: 4, name: 'Full price', salePrice: 10, msrp: 10 },
  ];
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/taxonomy')) return ok({ categories: [] });
    if (u.pathname.endsWith('/trends')) return ok({ items: feed });
    if (u.pathname.endsWith('/v2/items')) {
      lookups.push(u.searchParams.get('ids'));
      return ok({ items: [
        { itemId: 1, name: 'Snow bib', salePrice: 5.83 },                          // no sellerInfo: Walmart
        { itemId: 2, name: 'Cake pans', salePrice: 3.66, sellerInfo: 'Fents 7 Ltd' }, // third party
      ] });                                                                         // 3 missing: gone
    }
    return ok({ items: [] });
  };
  const checks = new ItemChecks(new PriceTracker().db);
  const make = () => new WalmartLiveSource({
    consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, itemChecks: checks,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl,
  });
  const quiet = console.log;
  console.log = () => {};
  const source = make();
  const pool = await source.dealCandidates();
  assert.ok(pool.every((p) => p.seller.isRetailer === null), 'unknown before checks');
  const stampBefore = source.rankStamp;
  await source.checkPoolSellers();
  // pans 94% off, "Gone" 80%, snow bib 79.9%; the full-price item isn't a deal
  assert.deepEqual(lookups, ['2,3,1'], 'one batch, biggest discount first, full-price item skipped');
  const byId = Object.fromEntries(pool.map((p) => [p.id, p]));
  assert.deepEqual(byId['1'].seller, { name: 'Walmart.com', isRetailer: true });
  assert.deepEqual(byId['2'].seller, { name: 'Fents 7 Ltd', isRetailer: false });
  assert.equal(byId['3'].exists, false);
  assert.equal(byId['4'].seller.isRetailer, null);
  assert.notEqual(source.rankStamp, stampBefore, 'ranking refreshes as sellers are confirmed');
  assert.deepEqual(source.poolStats().sellerChecks, { looked: 3, walmart: 1, thirdParty: 1, notFound: 1, errors: 0, running: false, pending: 0 });

  // A new source (e.g. after a deploy) reuses saved checks instead of looking up again.
  const restarted = make();
  const again = await restarted.dealCandidates();
  console.log = quiet;
  assert.equal(again.find((p) => p.id === '2').seller.isRetailer, false);
  assert.equal(again.find((p) => p.id === '3').exists, false);
});

test('item checks expire after their max age', () => {
  const checks = new ItemChecks(new PriceTracker().db, { maxAgeDays: 7 });
  checks.putMany('walmart', [{ itemId: '9', seller: 'Walmart.com', isRetailer: true, exists: true }], 0);
  assert.equal(checks.get('walmart', '9', 6 * 86400000).isRetailer, true);
  assert.equal(checks.get('walmart', '9', 8 * 86400000), null);
});

test('store scan prices feed Clearance near you and the stock check', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  db.recordRun({
    retailer: 'walmart', storeId: '573', department: 'Home', term: '', month: '2026-10', ranAt: Date.now(), clearance: 1,
    results: [
      { itemId: '24016954', title: 'Cricut mat', price: 7.97, wasPrice: 10.97, onlinePrice: 10.97, inStock: true, seller: 'Walmart.com' },
      { itemId: '555', title: 'Sold elsewhere', price: 1, onlinePrice: 9, inStock: true, seller: 'Rug Co' },
      { itemId: '556', title: 'Out of stock', price: 2, onlinePrice: 9, inStock: false, seller: 'Walmart.com' },
    ],
  });
  const stores = [
    { retailer: 'walmart', id: '573', name: "Lee's Summit Supercenter", city: "Lee's Summit", state: 'MO', distanceMiles: null },
    { retailer: 'walmart', id: '1094', name: 'Raytown Supercenter', city: 'Raytown', state: 'MO', distanceMiles: null },
  ];
  const product = { retailer: 'walmart', id: '24016954', name: 'Cricut mat', price: 10.97, msrp: 10.97, seller: { name: 'Walmart.com', isRetailer: true } };
  const source = {
    stores: async () => stores,
    getById: async () => product,
    inventory: async (p) => stores.map((store) => ({ store, price: p.price, quantity: null, status: 'unknown', aisle: null, clearance: false })),
  };
  db.refreshMarkdowns('walmart');
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
  adapter.storeScanner = { db };
  assert.equal(adapter.features.localClearance, true);

  const clearance = await adapter.getLocalClearance('64081');
  assert.deepEqual(clearance.map((c) => c.product.id), ['24016954'], 'Walmart-sold, in stock, at a scanned store');
  assert.equal(clearance[0].price, 7.97);
  assert.equal(clearance[0].discountPercent, 27, 'measured against Walmart\'s was price');
  assert.equal(clearance[0].store.name, "Lee's Summit Supercenter");
  assert.equal(await adapter.getLocalClearance('64081'), clearance, 'reused until markdowns are rebuilt');
  db.recordRun({
    retailer: 'walmart', storeId: '573', department: 'Home', term: '', month: '2026-10', ranAt: Date.now(), clearance: 1,
    results: [{ itemId: '557', title: 'New markdown', price: 3, wasPrice: 6, inStock: true, seller: 'Walmart.com' }],
  });
  db.refreshMarkdowns('walmart');
  const after = await adapter.getLocalClearance('64081');
  assert.ok(after.some((c) => c.product.id === '557'), 'a rebuild shows new markdowns');

  const inv = await adapter.checkInventory('24016954', '64081');
  const [lees, raytown] = inv.results;
  assert.equal(lees.price, 7.97);
  assert.equal(lees.status, 'in_stock');
  assert.equal(lees.clearance, true);
  assert.ok(lees.seenOn);
  assert.equal(raytown.price, null, 'unchecked store: the online offer is not looked up for a stored item');
  assert.equal(raytown.status, 'unknown');
});

test('right after a restart, deal requests return at once while the pool loads', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let release;
  const gate = new Promise((r) => { release = r; });
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/taxonomy')) return ok({ categories: [] });
    if (u.includes('/trends')) { await gate; return ok({ items: [{ itemId: 1, name: 'A', salePrice: 5, msrp: 9, categoryPath: 'Home Page/Home' }] }); }
    return ok({ items: [] });
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  const adapter = new WalmartAdapter({ source, mode: 'live' });
  assert.deepEqual(await adapter.getDealCandidates({ wait: false }), []);
  assert.equal(adapter.dealsLoading, true);
  assert.deepEqual(await adapter.getCategories(), [], 'category chips do not wait either');
  const log = console.log;
  console.log = () => {};
  release();
  const pool = await source.dealCandidates();
  console.log = log;
  assert.equal(pool.length, 1);
  assert.equal(adapter.dealsLoading, false);
});

test('items Walmart sells in a scanned store are allowed even when a marketplace seller has them online', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const { createRoutes, matchRoute } = await import('../src/api.js');
  const { RetailerRegistry } = await import('../src/retailers/registry.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  db.recordRun({
    retailer: 'walmart', storeId: '573', department: 'Toys', term: '', month: '2026-10', ranAt: Date.now(), clearance: 1,
    results: [{ itemId: '673610207', title: 'Play-Doh', price: 0.64, onlinePrice: 5.2, onlineSeller: 'JNR Sales', inStock: true, seller: 'Walmart.com' }],
  });
  const online = { retailer: 'walmart', id: '673610207', name: 'Play-Doh', price: 5.2, msrp: 5.2, seller: { name: 'JNR Sales', isRetailer: false } };
  const other = { ...online, id: '999', seller: { name: 'Rug Co', isRetailer: false } };
  const source = {
    getById: async (id) => (id === '673610207' ? online : other),
    stores: async () => [{ retailer: 'walmart', id: '573', name: "Lee's Summit Supercenter" }],
  };
  db.refreshMarkdowns('walmart');
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
  adapter.storeScanner = { db, loadConfig: () => ({ config: { stores: [{ id: '573', label: "Lee's Summit, Sam Walton Ln" }] } }) };
  const routes = createRoutes(new RetailerRegistry().register(adapter));
  const call = (path) => { const m = matchRoute(routes, 'GET', path); return m.route.handler({ params: m.params, query: new URLSearchParams() }); };

  const { product } = await call('/api/walmart/products/673610207');
  assert.equal(product.price, 0.64, 'leads with Walmart\'s store offer, not the online seller\'s $5.20');
  assert.deepEqual(product.seller, { name: 'Walmart', isRetailer: true });
  assert.deepEqual(product.storeOffers.map((o) => [o.storeLabel, o.price]), [["Lee's Summit, Sam Walton Ln", 0.64]]);
  await assert.rejects(call('/api/walmart/products/999'), /sold by Rug Co/, 'no store offer: still rejected');

  // Stock check: unscanned stores don't show the marketplace seller's price as a store price.
  source.inventory = async (p) => [
    { store: { id: '573', name: 'Lee' }, price: p.price, status: 'unknown', clearance: false },
    { store: { id: '1094', name: 'Raytown' }, price: p.price, status: 'unknown', clearance: false },
  ];
  const inv = await adapter.checkInventory('673610207', '64081');
  assert.deepEqual(inv.results.map((r) => r.price), [0.64, null]);

  const [deal] = await adapter.getLocalClearance('64081');
  assert.equal(deal.discountPercent, 0, 'no was price: no made-up discount against another seller');
  assert.equal(deal.product.price, 0.64);
});

test('daily stores every day, plus rotating stores taking turns', async () => {
  const { StoreChecker } = await import('../src/retailers/walmart/storeChecker.js');
  const config = {
    stores: ['573', '4590', '1599', 'A', 'B', 'C', 'D', 'E'].map((id) => ({ id })),
    dailyStores: ['573', '4590', '1599'], rotatingStoresPerDay: 2,
  };
  const days = ['2026-11-01', '2026-11-02', '2026-11-03'];
  const plans = days.map((d) => StoreChecker.probeStoresFor(d, config));
  for (const plan of plans) {
    assert.deepEqual(plan.slice(0, 3), ['573', '4590', '1599']);
    assert.equal(plan.length, 5);
  }
  // over consecutive days the rotation covers every other store
  const rotated = new Set(plans.flatMap((p) => p.slice(3)));
  assert.equal(rotated.size, 5);
});

test('the deal pool is saved, so a restart reuses it instead of refetching', async () => {
  const { PoolStore } = await import('../src/lib/poolStore.js');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let fetches = 0;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/taxonomy')) return ok({ categories: [] });
    if (u.includes('/trends')) { fetches += 1; return ok({ items: [{ itemId: 1, name: 'A', salePrice: 5, msrp: 9, categoryPath: 'Home Page/Home' }] }); }
    return ok({ items: [] });
  };
  const db = new PriceTracker().db;
  const make = (poolRefreshMs) => new WalmartLiveSource({
    consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, retryPassDelayMs: 0, poolRefreshMs,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl, poolStore: new PoolStore(db),
  });
  const log = console.log;
  console.log = () => {};
  await make(86400000).dealCandidates();
  assert.equal(fetches, 1);

  // "Restart": a new source with the same database answers at once from the saved pool.
  const restarted = make(86400000);
  assert.equal(restarted.poolLoading, true);
  const pool = await restarted.dealCandidates({ wait: false });
  assert.deepEqual(pool.map((p) => p.id), ['1']);
  assert.equal(restarted.poolLoading, false);
  assert.equal(fetches, 1, 'no refetch while the saved pool is fresh');

  // A stale saved pool is still served at once, and refreshed in the background.
  const stale = make(0);
  assert.equal((await stale.dealCandidates({ wait: false })).length, 1);
  await stale.poolRefresh;
  console.log = log;
  assert.equal(fetches, 2);
});

test('the product list refreshes once a day at the scheduled time', async () => {
  const { scheduleDayKey } = await import('../src/lib/scanSchedule.js');
  const due = (fetchedAt, now) => scheduleDayKey(new Date(fetchedAt), 4) !== scheduleDayKey(now, 4);
  const fetched = Date.parse('2026-11-04T09:10:00Z'); // 3:10am Chicago Nov 4: belongs to Nov 3
  assert.equal(due(fetched, new Date('2026-11-04T09:50:00Z')), false, '3:50am: not yet');
  assert.equal(due(fetched, new Date('2026-11-04T10:05:00Z')), true, '4:05am: refresh');
  const refreshed = Date.parse('2026-11-04T10:20:00Z');
  assert.equal(due(refreshed, new Date('2026-11-04T22:00:00Z')), false, 'once a day');
});

test('searchClearance keeps only Walmart-sold results and passes repeated filters', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let seen;
  const fetchImpl = async (url) => {
    seen = new URL(String(url));
    return { ok: true, status: 200, text: async () => '', json: async () => ({ totalResults: 122, items: [
      { itemId: 1, sellerInfo: 'Walmart.com' }, { itemId: 2, sellerInfo: 'Rug Co' }, { itemId: 3 },
    ] }) };
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', minIntervalMs: 0, maxRetries: 0, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
  const r = await source.searchClearance({ query: 'toys', filters: ['special_offers:Clearance', 'retailer_type:Walmart'], start: 26 });
  assert.deepEqual(r, { ids: ['1', '3'], total: 122 });
  assert.deepEqual(seen.searchParams.getAll('facet.filter'), ['special_offers:Clearance', 'retailer_type:Walmart']);
  assert.equal(seen.searchParams.get('start'), '26');
  assert.equal(seen.searchParams.get('facet'), 'on');
});


test('Clearance near you includes calculated clearance: cheaper at one store than another', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  const today = new Date().toISOString().slice(0, 10);
  // No Clearance flag or was-price anywhere: $22.98 at 4590 vs $28.98 at 573.
  db.recordStorePrices('walmart', '573', [{ itemId: '577366430', price: 28.98, seller: 'Walmart.com', clearance: false, inStock: true }], today);
  db.recordStorePrices('walmart', '4590', [{ itemId: '577366430', price: 22.98, seller: 'Walmart.com', clearance: false, inStock: true }], today);
  db.refreshMarkdowns('walmart');
  const source = { stores: async () => [{ id: '573', name: 'Lee' }, { id: '4590', name: 'Lee SW' }] };
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
  adapter.storeDb = db;
  const deals = await adapter.getLocalClearance('64081');
  assert.equal(deals.length, 1);
  assert.equal(deals[0].store.id, '4590');
  assert.equal(deals[0].product.msrp, 28.98);
  assert.equal(deals[0].discountPercent, 21);
});

test('product pages and store lists come from saved data instead of Walmart', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const { TierStore } = await import('../src/retailers/walmart/tierLists.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  db.recordRun({
    retailer: 'walmart', storeId: '573', department: 'Home', term: '', month: '2026-10', ranAt: Date.now(), clearance: 1,
    results: [{ itemId: '700', title: 'Lamp', price: 5, wasPrice: 9, inStock: true, seller: 'Walmart.com' }],
  });
  const tiers = new TierStore(db);
  tiers.upsertProduct.run('walmart', '701', '2026-10-31:t12', JSON.stringify({ id: '701', name: 'Rug', price: 20, seller: { name: 'Walmart.com', isRetailer: true } }));
  let liveCalls = 0;
  const source = { getById: async () => { liveCalls += 1; return null; } };
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
  adapter.storeDb = db;
  adapter.tierStore = tiers;
  assert.equal((await adapter.getProduct('701')).name, 'Rug', 'from the tier search');
  const lamp = await adapter.getProduct('700');
  assert.equal(lamp.name, 'Lamp', 'from the store checks');
  assert.equal(lamp.seller.isRetailer, true);
  assert.equal(liveCalls, 0);
  assert.equal(await adapter.getProduct('999'), null);
  assert.equal(liveCalls, 1, 'unknown items are looked up live');

  // The store list for a ZIP is saved and reused for a week.
  const calls = [];
  const live = new WalmartLiveSource({
    consumerId: 'x', privateKey: generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }),
    minIntervalMs: 0,
    fetchImpl: async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => [{ no: 573, name: 'Lee', coordinates: [-94, 38] }, { no: 1094, name: 'Raytown' }] }; },
    zipStoreCache: { get: (zip) => db.zipStores('walmart', zip), set: (zip, stores) => db.saveZipStores('walmart', zip, stores) },
  });
  assert.deepEqual((await live.stores('64081', { limit: 1 })).map((s) => s.id), ['573']);
  live.cache.clear?.();
  assert.deepEqual((await live.stores('64081')).map((s) => s.id), ['573', '1094'], 'the full list was saved');
  assert.equal(calls.length, 1);
  assert.equal(db.zipStores('walmart', '64081', { now: Date.now() + 8 * 86400000 }), null, 'older than a week is refetched');
});

test('deal lists show only the departments in the settings', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  const shirt = { itemId: '801', title: 'Shirt', price: 2, wasPrice: 9, clearance: true, inStock: true, seller: 'Walmart.com', category: 'Clothing' };
  const lamp = { itemId: '802', title: 'Lamp', price: 4, wasPrice: 9, clearance: true, inStock: true, seller: 'Walmart.com', category: 'Home' };
  db.recordStorePrices('walmart', '573', [shirt, lamp], new Date().toISOString().slice(0, 10));
  db.refreshMarkdowns('walmart');
  const pool = [
    { id: '801', category: 'Clothing', price: 2, seller: { isRetailer: true } },
    { id: '802', category: 'Home', price: 4, seller: { isRetailer: true } },
    { id: '803', category: null, price: 4, seller: { isRetailer: true } },
  ];
  const source = { stores: async () => [{ id: '573' }], dealCandidates: async () => pool };
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
  adapter.storeDb = db;
  adapter.loadStoreConfig = () => ({ config: { departments: ['Home', 'Toys'], stores: [] }, errors: [] });
  assert.deepEqual((await adapter.getLocalClearance('64081')).map((c) => c.product.id), ['802']);
  assert.deepEqual((await adapter.getDealCandidates()).map((p) => p.id), ['802', '803']);
  assert.deepEqual(await adapter.getCategories(), ['Home']);
});

test('Check store looks the item up at that store now, saves it, and reuses a recent check', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  const calls = [];
  const source = {
    async storeLookup(ids, storeId) {
      calls.push(`${storeId}:${ids}`);
      if (storeId === '9') return { found: [], missing: ids };
      if (storeId === '8') return { found: [{ itemId: ids[0], price: 4, seller: 'Rug Co', isWalmart: false }], missing: [] };
      return { found: [{ itemId: ids[0], price: 6.5, wasPrice: 9, clearance: true, inStock: true, seller: 'Walmart.com', isWalmart: true }], missing: [] };
    },
  };
  const adapter = new WalmartAdapter({ source, mode: 'live', tracker });
  adapter.storeDb = db;
  const now = Date.parse('2026-11-04T18:00:00Z');
  const res = await adapter.checkStore('123', '573', { now });
  assert.deepEqual([res.price, res.clearance, res.status], [6.5, true, 'in_stock']);
  assert.equal(db.latestPrices('walmart', ['573'], { itemId: '123', now }).length, 1, 'saved like a scheduled check');
  assert.equal((await adapter.checkStore('123', '573', { now: now + 60000 })).reused, true);
  assert.equal(calls.length, 1);
  assert.match((await adapter.checkStore('123', '9', { now })).note, /no listing/);
  assert.equal((await adapter.checkStore('123', '8', { now })).price, null, 'another seller\'s price is not shown');
  // At most 120 live checks an hour.
  for (let i = 0; i < 117; i++) await adapter.checkStore(String(1000 + i), '573', { now });
  await assert.rejects(adapter.checkStore('5000', '573', { now }), (err) => err.status === 429);
  await adapter.checkStore('5000', '573', { now: now + 3600001 });
});

test('store lookups set aside items Walmart sells online only', async () => {
  const live = new WalmartLiveSource({
    consumerId: 'x', privateKey: generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }),
    minIntervalMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [
      { itemId: 1, name: 'Rug', salePrice: 31.51, strikeThroughPrice: 68, offerType: 'ONLINE_ONLY', sellerInfo: 'Walmart.com', stock: 'Available' },
      { itemId: 2, name: 'Bowl', salePrice: 1, offerType: 'ONLINE_AND_STORE', sellerInfo: 'Walmart.com', stock: 'Available' },
    ] }) }),
  });
  const res = await live.storeLookup(['1', '2', '3'], '573');
  assert.deepEqual(res.found.map((f) => f.itemId), ['2']);
  assert.deepEqual(res.onlineOnly, ['1']);
  assert.deepEqual(res.missing, ['3']);
});

test('walmart.com links carry Walmart affiliate tracking once a publisher ID is set', async () => {
  const { walmartProductUrl } = await import('../src/retailers/walmart/identifiers.js');
  assert.equal(walmartProductUrl('24796626'), 'https://www.walmart.com/ip/24796626');
  assert.equal(walmartProductUrl('24796626', '1234567'),
    'https://goto.walmart.com/c/1234567/568844/9383?veh=aff&sourceid=imp_000011112222333344&u=https%3A%2F%2Fwww.walmart.com%2Fip%2F24796626');
  const adapter = new WalmartAdapter({ source: { publisherId: '1234567' }, mode: 'live' });
  assert.equal(adapter.features.affiliateLinks, true);
  assert.match(adapter.productUrl('5'), /^https:\/\/goto\.walmart\.com\/c\/1234567\//);
});

test('home page discounts use store data, not Walmart\'s msrp', async () => {
  const { StoreScanDb } = await import('../src/retailers/walmart/storeScan.js');
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  const day = new Date().toISOString().slice(0, 10);
  db.recordStorePrices('walmart', 'A', [{ itemId: 'fish', price: 1, seller: 'Walmart.com', inStock: true }], day);
  db.recordStorePrices('walmart', 'B', [{ itemId: 'fish', price: 2.5, seller: 'Walmart.com', inStock: true }], day);
  db.refreshMarkdowns('walmart');
  const pool = [
    { id: 'stuffing', category: 'Food', price: 0.98, msrp: 1149.99, currentOfferPrice: 5, seller: { isRetailer: true } },
    { id: 'fish', category: 'Food', price: 1, msrp: 10, seller: { isRetailer: true } },
  ];
  const adapter = new WalmartAdapter({ source: { dealCandidates: async () => pool, poolStamp: 1 }, mode: 'live', tracker });
  adapter.storeDb = db;
  const [stuffing, fish] = await adapter.getDealCandidates();
  assert.equal(stuffing.msrp, null, 'no store data: no discount');
  assert.equal(stuffing.currentOfferPrice, null);
  assert.equal(fish.msrp, 2.5, 'the highest store price');
});
