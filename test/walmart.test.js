import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseWalmartInput } from '../src/retailers/walmart/identifiers.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';
import { WalmartDemoSource } from '../src/retailers/walmart/demoSource.js';
import { WalmartLiveSource, signWalmartRequest, isWalmartSeller, departmentOf } from '../src/retailers/walmart/liveSource.js';
import { CATALOG } from '../src/retailers/walmart/catalog.js';
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
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
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
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
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
    consumerId: 'abc', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl,
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
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), fetchImpl });
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
