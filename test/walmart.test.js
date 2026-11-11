import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseWalmartInput, walmartProductUrl } from '../src/retailers/walmart/identifiers.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';
import { WalmartDemoSource } from '../src/retailers/walmart/demoSource.js';
import { WalmartLiveSource, signWalmartRequest, isWalmartSeller, departmentOf, realMsrp } from '../src/retailers/walmart/liveSource.js';
import { StorePrices } from '../src/retailers/walmart/storePrices.js';
import { TierStore } from '../src/retailers/walmart/tierLists.js';
import { StoreChecker } from '../src/retailers/walmart/storeChecker.js';
import { CATALOG } from '../src/retailers/walmart/catalog.js';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { stateForZip } from '../src/lib/geo.js';

const today = () => new Date().toISOString().slice(0, 10);
const pem = () => generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
/** A live source whose requests are answered by `respond(url)`. */
const liveSource = (respond, opts = {}) => new WalmartLiveSource({
  consumerId: 'x', privateKey: pem(), minIntervalMs: 0, maxRetries: 0,
  fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => respond(String(url)), text: async () => '' }),
  ...opts,
});
/** A live-mode adapter over saved store data. */
function liveAdapter({ source = {}, stores = [], departments = [], tiers = false } = {}) {
  const tracker = new PriceTracker();
  const db = new StorePrices(tracker.db);
  const tierStore = tiers ? new TierStore(db) : null;
  const adapter = new WalmartAdapter({
    source, mode: 'live', tracker, storeData: db, tierStore,
    loadStoreConfig: () => ({ config: { stores, departments }, errors: [] }),
  });
  return { adapter, db, tracker, tierStore };
}
const walmartRow = (itemId, price, extra = {}) => ({ itemId, price, seller: 'Walmart.com', inStock: true, ...extra });

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
  const history = await adapter.getPriceHistory('501003');
  assert.equal(history.length, 90);
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
  const calls = [];
  const source = liveSource((url) => {
    calls.push(url);
    return url.includes('/stores')
      ? [{ no: 100, name: 'Rogers Supercenter', streetAddress: '1 Main', city: 'Rogers', stateProvCode: 'AR', zip: '72756', coordinates: [-94.1, 36.3] }]
      : { totalResults: 1, items: [{ itemId: 42, name: 'Thing', salePrice: 9.98, msrp: 19.99, upc: '000000000042', categoryPath: 'Home Page/Home/Kitchen', brandName: 'Acme' }] };
  });
  const adapter = new WalmartAdapter({ source, mode: 'live' });
  const [p] = await adapter.searchProducts('thing');
  assert.deepEqual([p.id, p.category, p.msrp, p.seller.isRetailer], ['42', 'Home', 19.99, true]);
  assert.ok(calls[0].includes('/search?query=thing'));
  const [store] = await adapter.findStores('72756');
  assert.deepEqual([store.id, store.city, store.lat, store.lon], ['100', 'Rogers', 36.3, -94.1]);
  assert.equal(adapter.features.storeQuantities, false);
  assert.equal(adapter.features.localClearance, false, 'no saved store data');
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

test('fromEnv picks live mode only when credentials are present', () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(WalmartAdapter.fromEnv({}).mode, 'demo');
  const keys = { WALMART_CONSUMER_ID: 'abc', WALMART_PRIVATE_KEY: key.replace(/\n/g, '\\n') };
  const live = WalmartAdapter.fromEnv(keys);
  assert.equal(live.mode, 'live');
  assert.ok(live.storeData && live.tierStore && live.storeChecker);
  assert.equal(WalmartAdapter.fromEnv({ ...keys, WALMART_MODE: 'demo' }).mode, 'demo');
  assert.throws(() => WalmartAdapter.fromEnv({ WALMART_MODE: 'live' }), /WALMART_CONSUMER_ID/);
});

test('live requests retry after a 429 and are spaced out', async () => {
  const times = [];
  let calls = 0;
  const fetchImpl = async () => {
    times.push(Date.now());
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0.05' }, text: async () => 'slow down' };
    return { ok: true, status: 200, json: async () => ({ itemId: 1, name: 'A', salePrice: 5, sellerInfo: 'Walmart.com' }), text: async () => '' };
  };
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: pem(), fetchImpl, minIntervalMs: 30 });
  assert.equal((await source.getById('1')).id, '1');
  assert.equal(calls, 2, 'retried once');
  await source.getById('2');
  assert.ok(times[2] - times[1] >= 25, 'next request waited its turn');
});

test('a 9999 list price is a placeholder, not a list price', () => {
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: 'unused' });
  assert.equal(source.toProduct({ itemId: 1, name: 'Rug', salePrice: 139.98, msrp: 9999 }).msrp, null);
  assert.equal(source.toProduct({ itemId: 2, name: 'Tee', salePrice: 7, msrp: 8.5 }).msrp, 8.5);
  assert.equal(realMsrp(12000), null);
  assert.equal(realMsrp(0), null);
  assert.equal(realMsrp(349.99), 349.99);
});

test('unnamed marketplace listings are not labeled Walmart.com', () => {
  const source = new WalmartLiveSource({ consumerId: 'abc', privateKey: 'unused' });
  const p = source.toProduct({ itemId: 1, name: 'X', salePrice: 1, marketplace: true });
  assert.equal(p.seller.isRetailer, false);
  assert.notEqual(p.seller.name, 'Walmart.com');
});

test('daily stores every day, plus rotating stores taking turns', () => {
  const config = {
    stores: ['573', '4590', '1599', 'A', 'B', 'C', 'D', 'E'].map((id) => ({ id })),
    dailyStores: ['573', '4590', '1599'], rotatingStoresPerDay: 2,
  };
  const plans = ['2026-11-01', '2026-11-02', '2026-11-03'].map((d) => StoreChecker.probeStoresFor(d, config));
  for (const plan of plans) {
    assert.deepEqual(plan.slice(0, 3), ['573', '4590', '1599']);
    assert.equal(plan.length, 5);
  }
  assert.equal(new Set(plans.flatMap((p) => p.slice(3))).size, 5, 'over consecutive days the rotation covers every other store');
});

test('store lookups set aside items Walmart sells online only', async () => {
  const live = liveSource(() => ({ items: [
    { itemId: 1, name: 'Rug', salePrice: 31.51, strikeThroughPrice: 68, offerType: 'ONLINE_ONLY', sellerInfo: 'Walmart.com', stock: 'Available' },
    { itemId: 2, name: 'Bowl', salePrice: 1, strikeThroughPrice: 3, clearance: true, offerType: 'ONLINE_AND_STORE', sellerInfo: 'Walmart.com', stock: 'Available' },
  ] }));
  const res = await live.storeLookup(['1', '2', '3'], '573');
  assert.deepEqual(res.found.map((f) => [f.itemId, f.price, f.wasPrice, f.clearance, f.inStock, f.isWalmart]), [['2', 1, 3, true, true, true]]);
  assert.deepEqual(res.onlineOnly, ['1']);
  assert.deepEqual(res.missing, ['3']);
});

test('search pages drop marketplace and online-only items even when Walmart\'s filters let them through', async () => {
  const live = liveSource(() => ({ totalResults: 3, items: [
    { itemId: 1, name: 'Laptop A', salePrice: 500, sellerInfo: 'Walmart.com', offerType: 'ONLINE_AND_STORE' },
    { itemId: 2, name: 'Laptop B', salePrice: 842.9, sellerInfo: 'GAMES FOR LESS', marketplace: true, offerType: 'ONLINE_ONLY' },
    { itemId: 3, name: 'Laptop C', salePrice: 600, sellerInfo: 'Walmart.com', offerType: 'ONLINE_ONLY' },
  ] }));
  const inStores = await live.searchPage({ query: 'laptop', filters: ['retailer_type:Walmart'] });
  assert.deepEqual(inStores.products.map((p) => p.id), ['1']);
  assert.equal(inStores.total, 3);
  const withOnline = await live.searchPage({ query: 'laptop', filters: ['retailer_type:Walmart'], keepOnlineOnly: true });
  assert.deepEqual(withOnline.products.map((p) => [p.id, p.onlineOnly]), [['1', false], ['3', true]], 'online-only kept when asked, never marketplace');
});

test('the store list for a ZIP is saved and reused for a week', async () => {
  const { db } = liveAdapter();
  const calls = [];
  const live = liveSource((url) => { calls.push(url); return [{ no: 573, name: 'Lee', coordinates: [-94, 38] }, { no: 1094, name: 'Raytown' }]; }, {
    zipStoreCache: { get: (zip) => db.zipStores('walmart', zip), set: (zip, stores) => db.saveZipStores('walmart', zip, stores) },
  });
  assert.deepEqual((await live.stores('64081', { limit: 1 })).map((s) => s.id), ['573']);
  assert.deepEqual((await live.stores('64081')).map((s) => s.id), ['573', '1094'], 'the full list was saved');
  assert.equal(calls.length, 1);
  assert.equal(db.zipStores('walmart', '64081', { now: Date.now() + 8 * 86400000 }), null, 'older than a week is refetched');
});

test('walmart.com links carry Walmart affiliate tracking once a publisher ID is set', () => {
  assert.equal(walmartProductUrl('24796626'), 'https://www.walmart.com/ip/24796626');
  assert.equal(walmartProductUrl('24796626', '1234567'),
    'https://goto.walmart.com/c/1234567/568844/9383?veh=aff&sourceid=imp_000011112222333344&u=https%3A%2F%2Fwww.walmart.com%2Fip%2F24796626');
  const adapter = new WalmartAdapter({ source: { publisherId: '1234567' }, mode: 'live' });
  assert.equal(adapter.features.affiliateLinks, true);
  assert.match(adapter.productUrl('5'), /^https:\/\/goto\.walmart\.com\/c\/1234567\//);
});

// ---- live mode over saved store data ----------------------------------------

test('store deals near a ZIP: Walmart-sold, in stock, at a checked store, in the settings\' departments', async () => {
  const stores = [{ retailer: 'walmart', id: '573', name: "Lee's Summit" }, { retailer: 'walmart', id: '1094', name: 'Raytown' }];
  const { adapter, db } = liveAdapter({ source: { stores: async () => stores }, departments: ['Home'] });
  db.recordStorePrices('walmart', '573', [
    walmartRow('24016954', 7.97, { title: 'Cricut mat', wasPrice: 10.97, clearance: true, category: 'Home' }),
    walmartRow('555', 1, { title: 'Sold elsewhere', clearance: true, seller: 'Rug Co', category: 'Home' }),
    walmartRow('556', 2, { title: 'Out of stock', clearance: true, inStock: false, category: 'Home' }),
    walmartRow('557', 2, { title: 'Shirt', clearance: true, category: 'Clothing' }),
  ], today());
  db.refreshMarkdowns('walmart');
  assert.equal(adapter.features.localClearance, true);
  const deals = await adapter.getLocalClearance('64081');
  assert.deepEqual(deals.map((d) => [d.product.id, d.price, d.kind, d.discountPercent, d.store.name]),
    [['24016954', 7.97, 'clearance', 27, "Lee's Summit"]]);
});

test('a Markdown: cheaper at one store than another, with no Walmart deal tag', async () => {
  const stores = [{ id: '573', name: 'Lee' }, { id: '4590', name: 'Lee SW' }];
  const { adapter, db } = liveAdapter({ source: { stores: async () => stores } });
  db.recordStorePrices('walmart', '573', [walmartRow('577366430', 28.98)], today());
  db.recordStorePrices('walmart', '4590', [walmartRow('577366430', 22.98)], today());
  db.refreshMarkdowns('walmart');
  const [deal, ...rest] = await adapter.getLocalClearance('64081');
  assert.equal(rest.length, 0);
  assert.deepEqual([deal.store.id, deal.kind, deal.refPrice, deal.discountPercent], ['4590', 'markdown', 28.98, 21]);
});

test('the stock check lists the 15 nearest stores plus farther ones with a saved price, nearest first', async () => {
  const nearby = Array.from({ length: 30 }, (_, i) => ({ retailer: 'walmart', id: String(100 + i), name: `Store ${i}` }));
  const { adapter, db } = liveAdapter({ source: { stores: async () => nearby, getById: async () => null } });
  db.recordStorePrices('walmart', '100', [walmartRow('1', 7.97, { title: 'Lamp', wasPrice: 10.97, clearance: true })], today());
  db.recordStorePrices('walmart', '125', [walmartRow('1', 4, { title: 'Lamp' })], today());
  db.refreshMarkdowns('walmart');
  const inv = await adapter.checkInventory('1', '64081');
  assert.deepEqual(inv.results.map((r) => r.store.id), [...nearby.slice(0, 15).map((s) => s.id), '125']);
  const [first, second] = inv.results;
  assert.deepEqual([first.price, first.status, first.wasPrice, first.checked], [7.97, 'in_stock', 10.97, true]);
  assert.ok(first.seenOn);
  assert.deepEqual([second.price, second.status, second.checked], [null, 'unknown', false], 'no price guessed for an unchecked store');
  assert.deepEqual([inv.results.at(-1).price, inv.results.at(-1).store.rank], [4, 26]);
});

test('items Walmart sells in a checked store are allowed even when a marketplace seller has them online', async () => {
  const { createRoutes, matchRoute } = await import('../src/api.js');
  const { RetailerRegistry } = await import('../src/retailers/registry.js');
  const online = { retailer: 'walmart', id: '673610207', name: 'Play-Doh', price: 5.2, msrp: null, seller: { name: 'JNR Sales', isRetailer: false } };
  const source = {
    getById: async (id) => (id === '673610207' ? online : { ...online, id, seller: { name: 'Rug Co', isRetailer: false } }),
    stores: async () => [{ retailer: 'walmart', id: '573', name: "Lee's Summit Supercenter" }],
  };
  const { adapter, db } = liveAdapter({ source, stores: [{ id: '573', label: "Lee's Summit, Sam Walton Ln" }] });
  db.recordStorePrices('walmart', '573', [walmartRow('673610207', 0.64, { title: 'Play-Doh' })], today());
  db.refreshMarkdowns('walmart');
  const routes = createRoutes(new RetailerRegistry().register(adapter));
  const call = (path) => { const m = matchRoute(routes, 'GET', path); return m.route.handler({ params: m.params, query: new URLSearchParams() }); };

  const { product } = await call('/api/walmart/products/673610207');
  assert.equal(product.price, 0.64, 'leads with Walmart\'s store offer, not the online seller\'s $5.20');
  assert.deepEqual(product.seller, { name: 'Walmart', isRetailer: true });
  assert.deepEqual(product.storeOffers.map((o) => [o.storeLabel, o.price]), [["Lee's Summit, Sam Walton Ln", 0.64]]);
  await assert.rejects(call('/api/walmart/products/999'), /sold by Rug Co/, 'no store offer: still rejected');
});

test('product pages come from saved data instead of Walmart', async () => {
  let liveCalls = 0;
  const { adapter, db, tierStore } = liveAdapter({ source: { getById: async () => { liveCalls += 1; return null; } }, tiers: true });
  db.recordStorePrices('walmart', '573', [walmartRow('700', 5, { title: 'Lamp', wasPrice: 9 })], today());
  tierStore.saveProduct('2026-10-31:t12', { id: '701', name: 'Rug', price: 20, seller: { name: 'Walmart.com', isRetailer: true } });
  assert.equal((await adapter.getProduct('701')).name, 'Rug', 'from the tier lists');
  const lamp = await adapter.getProduct('700');
  assert.deepEqual([lamp.name, lamp.seller.isRetailer], ['Lamp', true], 'from the store checks');
  assert.equal(liveCalls, 0);
  assert.equal(await adapter.getProduct('999'), null);
  assert.equal(liveCalls, 1, 'unknown items are looked up live');
});

test('the price history route adds each nearby store\'s prices', async () => {
  const { createRoutes, matchRoute } = await import('../src/api.js');
  const { RetailerRegistry } = await import('../src/retailers/registry.js');
  const nearby = [{ id: '573', name: 'Lee' }, { id: '4590', name: 'Lee SW' }, { id: '1599', name: 'Overland Park' }];
  const { adapter, db } = liveAdapter({ source: { stores: async () => nearby }, stores: [{ id: '1599', label: 'OP Metcalf' }] });
  db.recordStorePrices('walmart', '4590', [walmartRow('700', 5, { title: 'Lamp' })], today());
  db.recordStorePrices('walmart', '1599', [walmartRow('700', 4, { title: 'Lamp' })], today());
  const routes = createRoutes(new RetailerRegistry().register(adapter));
  const call = (path, qs = '') => { const m = matchRoute(routes, 'GET', path); return m.route.handler({ params: m.params, query: new URLSearchParams(qs) }); };
  const withZip = await call('/api/walmart/products/700/history', 'zip=64081');
  assert.deepEqual(withZip.stores.map((s) => [s.store.name, s.points.at(-1).price]), [['Lee SW', 5], ['Overland Park', 4]], 'nearest first');
  assert.deepEqual((await call('/api/walmart/products/700/history')).stores.map((s) => s.store.name), ['OP Metcalf'], 'tracked stores without a ZIP');
  await assert.rejects(call('/api/walmart/products/700/history', 'zip=abc'), /ZIP/);
});

test('deal lists are built ahead of visitors for no ZIP and the settings\' ZIPs', async () => {
  const asked = [];
  const { adapter, db } = liveAdapter({ source: { stores: async (zip) => { asked.push(zip); return []; } }, tiers: true });
  adapter.loadStoreConfig = () => ({ config: { zips: ['64081', '66211'], stores: [], departments: [] }, errors: [] });
  db.onRefresh = () => adapter.warmCards({ delayMs: 0 });
  db.refreshMarkdowns('walmart');
  db.refreshMarkdowns('walmart'); // a burst builds once
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([...adapter.cardCache.keys()].sort(), ['', '64081', '66211']);
  assert.deepEqual(asked, ['64081', '66211']);
});

test('discounts come from the store data, not Walmart\'s msrp', async () => {
  const { adapter, db } = liveAdapter();
  db.recordStorePrices('walmart', 'A', [walmartRow('fish', 1)], today());
  db.recordStorePrices('walmart', 'B', [walmartRow('fish', 2.5)], today());
  db.refreshMarkdowns('walmart');
  assert.equal(adapter.withReference({ id: 'stuffing', price: 0.98, msrp: 1149.99 }).msrp, null, 'no store data: no discount');
  assert.equal(adapter.withReference({ id: 'fish', price: 1, msrp: 10 }).msrp, 2.5, 'the highest store price');
});

test('Check store looks the item up at that store now, saves it, and reuses a recent check', async () => {
  const calls = [];
  const source = {
    async storeLookup(ids, storeId) {
      calls.push(`${storeId}:${ids}`);
      if (storeId === '9') return { found: [], missing: ids, onlineOnly: [] };
      if (storeId === '8') return { found: [{ itemId: ids[0], price: 4, seller: 'Rug Co', isWalmart: false }], missing: [], onlineOnly: [] };
      if (storeId === '7') return { found: [], missing: [], onlineOnly: ids };
      return { found: [{ itemId: ids[0], price: 6.5, wasPrice: 9, clearance: true, inStock: true, seller: 'Walmart.com', isWalmart: true }], missing: [], onlineOnly: [] };
    },
  };
  const { adapter, db } = liveAdapter({ source });
  const now = Date.parse('2026-11-04T18:00:00Z');
  const res = await adapter.checkStore('123', '573', { now });
  assert.deepEqual([res.price, res.clearance, res.status], [6.5, true, 'in_stock']);
  assert.equal(db.latestPrices('walmart', ['573'], '123', { now }).length, 1, 'saved like a scheduled check');
  assert.equal((await adapter.checkStore('123', '573', { now: now + 60000 })).reused, true);
  assert.equal(calls.length, 1);
  assert.match((await adapter.checkStore('123', '9', { now })).note, /no listing/);
  assert.equal((await adapter.checkStore('123', '8', { now })).price, null, 'another seller\'s price is not shown');
  assert.match((await adapter.checkStore('124', '7', { now })).note, /online only/);
  assert.equal(db.isOnlineOnly('walmart', '124'), true);
  // At most 120 live checks an hour.
  for (let i = 0; i < 116; i++) await adapter.checkStore(String(1000 + i), '573', { now });
  await assert.rejects(adapter.checkStore('5000', '573', { now }), (err) => err.status === 429);
  await adapter.checkStore('5000', '573', { now: now + 3600001 });
});

test('product search pages through every Walmart-sold result, then adds items the store checks know', async () => {
  const all = Array.from({ length: 30 }, (_, i) => ({ id: String(500 + i), name: `HP Laptop ${i}`, price: 300, seller: { name: 'Walmart.com', isRetailer: true } }));
  const calls = [];
  const source = {
    async searchPage({ query, filters, start, keepOnlineOnly }) {
      calls.push({ query, filters, start, keepOnlineOnly });
      return { products: all.slice(start - 1, start - 1 + 25), total: all.length };
    },
  };
  const { adapter, db } = liveAdapter({ source });
  db.recordStorePrices('walmart', '573', [walmartRow('18140512295', 599, { title: 'HP OmniBook 5 16 inch Laptop' })], today());
  const first = await adapter.searchPaged('hp laptop');
  assert.deepEqual([first.products.length, first.nextStart, first.total], [25, 26, 30]);
  assert.deepEqual([calls[0].filters, calls[0].keepOnlineOnly], [['retailer_type:Walmart'], true], 'Walmart-sold, online-only items included');
  const second = await adapter.searchPaged('hp laptop', { start: 26 });
  assert.equal(second.nextStart, null);
  assert.deepEqual(second.products.map((p) => p.id), [...all.slice(25).map((p) => p.id), '18140512295'], 'saved matches after the last page');
});
