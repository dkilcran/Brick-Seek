import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createRoutes, matchRoute } from '../src/api.js';
import { RetailerRegistry } from '../src/retailers/registry.js';
import { RetailerAdapter } from '../src/retailers/RetailerAdapter.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';

// A second, minimal retailer proves the API is retailer-agnostic.
class StubAdapter extends RetailerAdapter {
  get id() { return 'stub'; }
  get name() { return 'Stub Mart'; }
}

let server;
let base;

before(async () => {
  const registry = new RetailerRegistry().register(new WalmartAdapter()).register(new StubAdapter());
  server = createApp(registry);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

test('lists registered retailers', async () => {
  const { body } = await get('/api/retailers');
  assert.deepEqual(body.retailers.map((r) => r.id), ['walmart', 'stub']);
  assert.equal(body.retailers[0].mode, 'demo');
});

test('search, inventory, history, deals, stores', async () => {
  const search = await get('/api/walmart/search?q=lego');
  assert.equal(search.status, 200);
  assert.ok(search.body.products.length >= 1);

  const inv = await get('/api/walmart/products/503001/inventory?zip=10001&radius=25&sort=price');
  assert.equal(inv.status, 200);
  assert.equal(inv.body.summary.storesChecked, inv.body.results.length);
  const prices = inv.body.results.map((r) => r.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.ok(inv.body.results.every((r) => r.store.distanceMiles <= 25));

  assert.equal((await get('/api/walmart/products/503001/history')).body.history.length, 90);
  assert.ok((await get('/api/walmart/deals?minDiscount=10')).body.deals.length > 0);
  for (const section of ['top', 'drops', 'bigticket']) {
    const { status, body } = await get(`/api/walmart/deals?section=${section}`);
    assert.equal(status, 200, section);
    assert.ok(body.deals.length > 0, section);
  }
  const clearance = await get('/api/walmart/deals?section=clearance&zip=10001');
  assert.ok(clearance.body.deals.length > 0);
  assert.ok(clearance.body.deals.every((d) => d.store && d.quantity > 0));
  assert.ok((await get('/api/walmart/stores?zip=10001')).body.stores.length > 0);
  assert.ok((await get('/api/walmart/categories')).body.categories.includes('Toys'));
});

test('deal sections for the home page', async () => {
  const { body } = await get('/api/walmart/deals/sections?zip=72712');
  assert.deepEqual(body.sections.map((s) => s.id), ['top', 'drops', 'lowest', 'bigticket', 'clearance']);
  const top = body.sections[0].deals;
  assert.equal(top.length, 8);
  const perCategory = {};
  for (const d of top) perCategory[d.product.category] = (perCategory[d.product.category] ?? 0) + 1;
  assert.ok(Object.values(perCategory).every((n) => n <= 2));
  const noZip = await get('/api/walmart/deals/sections');
  assert.match(noZip.body.sections.at(-1).note, /ZIP/);
});

test('marketplace items never appear', async () => {
  const { body } = await get('/api/walmart/deals/sections?zip=72712&limit=24');
  const ids = body.sections.flatMap((s) => s.deals.map((d) => d.product.id));
  assert.ok(!ids.some((id) => id.startsWith('511')));
  assert.equal((await get('/api/walmart/search?q=rug')).body.products.length, 0);
  const direct = await get('/api/walmart/products/511001');
  assert.equal(direct.status, 404);
  assert.match(direct.body.error, /sold by RugDirect Outlet, not Walmart/);
  assert.equal((await get('/api/walmart/products/511001/inventory?zip=10001')).status, 404);
});

test('validation and error statuses', async () => {
  assert.equal((await get('/api/walmart/deals?section=bogus')).status, 400);
  assert.equal((await get('/api/walmart/deals?section=clearance')).status, 400);
  assert.equal((await get('/api/walmart/products/503001/inventory?zip=abc')).status, 400);
  assert.equal((await get('/api/walmart/search')).status, 400);
  assert.equal((await get('/api/walmart/products/000/inventory?zip=10001')).status, 404);
  assert.equal((await get('/api/target/search?q=x')).status, 404);
  assert.equal((await get('/api/stub/search?q=x')).status, 501);
});

test('serves the SPA', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<main id="app"/);
});

test('home sections never repeat a product', async () => {
  const { body } = await get('/api/walmart/deals/sections?zip=72712');
  const ids = body.sections.flatMap((s) => s.deals.map((d) => d.product.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(body.sections.filter((s) => s.deals.length).length >= 4);
});

test('stats describe the deal pool', async () => {
  const { body } = await get('/api/walmart/stats');
  assert.equal(body.mode, 'demo');
  assert.ok(body.pool.uniqueItems > 40);
  assert.ok(body.eligible > 0 && body.eligible < body.pool.uniqueItems, 'marketplace items excluded');
  assert.equal(typeof body.analysisMs, 'number');
});

test('deal ranking is reused until the pool changes', async () => {
  const adapter = new WalmartAdapter();
  let historyCalls = 0;
  const original = adapter.getPriceHistoryFor.bind(adapter);
  adapter.getPriceHistoryFor = (...args) => { historyCalls += 1; return original(...args); };
  let stamp = 'pool-1';
  Object.defineProperty(adapter, 'dealPoolStamp', { get: () => stamp });
  const routes = createRoutes(new RetailerRegistry().register(adapter));
  const { route, params } = matchRoute(routes, 'GET', '/api/walmart/stats');
  const run = () => route.handler({ params, query: new URLSearchParams() });

  await run();
  const afterFirst = historyCalls;
  assert.ok(afterFirst > 0);
  await run();
  assert.equal(historyCalls, afterFirst, 'second request reused the ranking');
  stamp = 'pool-2';
  await run();
  assert.equal(historyCalls, afterFirst * 2, 'a new pool is ranked again');
});

test('scan-config shows the settings checked against departments', async () => {
  const { status, body } = await get('/api/walmart/scan-config');
  assert.equal(status, 200);
  assert.ok(body.config.stores.some((s) => s.id === '573'));
  assert.ok(body.availableDepartments.includes('Toys'));
  assert.equal(typeof body.daysBetweenScans, 'number');
});

test('full deal lists are uncapped and paged; the home page stays capped', async () => {
  const first = await get('/api/walmart/deals?section=top&limit=10&offset=0');
  assert.equal(first.status, 200);
  assert.equal(first.body.deals.length, 10);
  assert.ok(first.body.total > 10);
  assert.equal(first.body.hasMore, true);
  const rest = await get(`/api/walmart/deals?section=top&limit=100&offset=10`);
  const all = [...first.body.deals, ...rest.body.deals];
  assert.equal(all.length, first.body.total, 'paging returns every match');
  assert.equal(new Set(all.map((d) => d.product.id)).size, all.length, 'no repeats across pages');
  // no per-category cap in the full list (the home page allows 2)
  const perCat = {};
  for (const d of all) perCat[d.product.category] = (perCat[d.product.category] ?? 0) + 1;
  assert.ok(Math.max(...Object.values(perCat)) > 2);

  const clearance = await get('/api/walmart/deals?section=clearance&zip=72712&limit=5');
  assert.equal(clearance.body.deals.length, Math.min(5, clearance.body.total));

  const { body } = await get('/api/walmart/deals/sections?zip=72712');
  const home = body.sections.find((s) => s.id === 'clearance').deals;
  const brands = {};
  for (const d of home) { const b = (d.product.brand || d.product.name.split(' ')[0]).toLowerCase(); brands[b] = (brands[b] ?? 0) + 1; }
  assert.ok(Object.values(brands).every((n) => n <= 2), 'home clearance: at most 2 per brand');
});

test('deal lists sort by % off, $ off or price, keeping the section order for ties', async () => {
  const { sortDeals } = await import('../src/api.js');
  const deals = [
    { id: 'a', discountPercent: 20, dollarsOff: 50, lowestPrice: 200 },
    { id: 'b', discountPercent: 60, dollarsOff: 3, lowestPrice: 2 },
    { id: 'c', discountPercent: 20, dollarsOff: 10, lowestPrice: 40 },
  ];
  const ids = (sort) => sortDeals(deals, sort).map((d) => d.id);
  assert.deepEqual(ids('percent'), ['b', 'a', 'c']);
  assert.deepEqual(ids('dollars'), ['a', 'c', 'b']);
  assert.deepEqual(ids('price'), ['b', 'c', 'a']);
  assert.deepEqual(ids('price-desc'), ['a', 'c', 'b']);
  assert.deepEqual(ids('best'), ['a', 'b', 'c']);
  assert.deepEqual(ids(undefined), ['a', 'b', 'c']);
});

test('deal text search needs every word, in any order and case', async () => {
  const { filterByText } = await import('../src/api.js');
  const deals = [
    { product: { id: '1', name: 'HP OmniBook 5 16 inch Laptop' } },
    { product: { id: '2', name: 'HP 14-inch Chromebook' } },
    { product: { id: '3', name: 'LEGO Speed Champions', brand: 'LEGO' } },
  ];
  assert.deepEqual(filterByText(deals, 'laptop hp').map((d) => d.product.id), ['1']);
  assert.deepEqual(filterByText(deals, 'HP').map((d) => d.product.id), ['1', '2']);
  assert.deepEqual(filterByText(deals, '').length, 3);
});

test('several deal types at once: merged, each item once, and searchable', async () => {
  const top = await get('/api/walmart/deals?section=top&limit=100');
  const drops = await get('/api/walmart/deals?section=drops&limit=100');
  const both = await get('/api/walmart/deals?section=top,drops,store-clearance&zip=72712&limit=100');
  assert.equal(both.status, 200);
  const ids = both.body.deals.map((d) => d.product.id);
  assert.equal(new Set(ids).size, ids.length, 'no repeats');
  for (const d of [...top.body.deals, ...drops.body.deals]) assert.ok(ids.includes(d.product.id));
  const word = top.body.deals[0].product.name.split(' ')[0];
  const found = await get(`/api/walmart/deals?section=top&q=${encodeURIComponent(word)}&limit=100`);
  assert.ok(found.body.total >= 1 && found.body.deals.every((d) => d.product.name.toLowerCase().includes(word.toLowerCase())));
  assert.equal((await get('/api/walmart/deals?section=top,nope')).status, 400);
});
