import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
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

test('search, inventory, history, stores', async () => {
  const search = await get('/api/walmart/search?q=lego');
  assert.equal(search.status, 200);
  assert.ok(search.body.products.length >= 1);
  assert.equal(search.body.nextStart, null);

  const inv = await get('/api/walmart/products/503001/inventory?zip=10001&radius=25&sort=price');
  assert.equal(inv.status, 200);
  assert.equal(inv.body.summary.storesChecked, inv.body.results.length);
  const prices = inv.body.results.map((r) => r.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.ok(inv.body.results.every((r) => r.store.distanceMiles <= 25));

  assert.equal((await get('/api/walmart/products/503001/history')).body.history.length, 90);
  assert.ok((await get('/api/walmart/stores?zip=10001')).body.stores.length > 0);
});

test('the deal list: online and store lines per item, filters, sorting and paging', async () => {
  const all = await get('/api/walmart/all-deals?zip=72712&limit=100');
  assert.equal(all.status, 200);
  const { deals, total, categories } = all.body;
  assert.ok(total > 10 && deals.length === Math.min(100, total));
  assert.ok(categories.includes('Toys'));
  assert.equal(new Set(deals.map((d) => d.product.id)).size, deals.length, 'one card per item');
  assert.ok(deals.some((d) => d.online && d.store), 'an item can have both an online and a store deal');
  assert.ok(deals.every((d) => !d.store || d.store.store), 'store lines name the store');
  const scores = deals.map((d) => d.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'best match first');

  const count = async (qs) => (await get(`/api/walmart/all-deals?zip=72712&limit=1&${qs}`)).body.total;
  assert.equal(await count('where=online'), deals.filter((d) => d.online).length);
  const withStoreDeal = deals.filter((d) => d.store).length;
  assert.ok(withStoreDeal > 0 && withStoreDeal < total);
  assert.equal(await count('where=stores'), withStoreDeal);
  assert.ok(await count('labels=clearance') < total);
  assert.equal(await count('minPrice=100000'), 0);
  // Without a ZIP there are no store deals.
  assert.equal((await get('/api/walmart/all-deals?where=stores')).body.total, 0);

  const byPercent = (await get('/api/walmart/all-deals?zip=72712&sort=percent&limit=20')).body.deals.map((d) => d.percentOff);
  assert.deepEqual(byPercent, [...byPercent].sort((a, b) => b - a));
  const first = await get('/api/walmart/all-deals?zip=72712&limit=10');
  const next = await get('/api/walmart/all-deals?zip=72712&limit=10&offset=10');
  assert.equal(first.body.hasMore, true);
  assert.equal(new Set([...first.body.deals, ...next.body.deals].map((d) => d.product.id)).size, 20, 'no repeats across pages');
  const word = first.body.deals[0].product.name.split(' ')[0];
  const found = (await get(`/api/walmart/all-deals?zip=72712&q=${encodeURIComponent(word)}`)).body.deals;
  assert.ok(found.length >= 1 && found.every((d) => d.product.name.toLowerCase().includes(word.toLowerCase())));
});

test('marketplace items never appear', async () => {
  const { body } = await get('/api/walmart/all-deals?zip=72712&limit=100');
  assert.ok(!body.deals.some((d) => d.product.id.startsWith('511')));
  assert.equal((await get('/api/walmart/search?q=rug')).body.products.length, 0);
  const direct = await get('/api/walmart/products/511001');
  assert.equal(direct.status, 404);
  assert.match(direct.body.error, /sold by RugDirect Outlet, not Walmart/);
  assert.equal((await get('/api/walmart/products/511001/inventory?zip=10001')).status, 404);
});

test('validation and error statuses', async () => {
  assert.equal((await get('/api/walmart/all-deals?zip=abc')).status, 400);
  assert.equal((await get('/api/walmart/products/503001/inventory?zip=abc')).status, 400);
  assert.equal((await get('/api/walmart/search')).status, 400);
  assert.equal((await get('/api/walmart/products/000/inventory?zip=10001')).status, 404);
  assert.equal((await get('/api/walmart/products/503001/check-store?store=573')).status, 501, 'store checks need live mode');
  assert.equal((await get('/api/target/search?q=x')).status, 404);
  assert.equal((await get('/api/stub/search?q=x')).status, 501);
});

test('serves the SPA', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<main id="app"/);
});

test('scan-config shows the settings checked against departments', async () => {
  const { status, body } = await get('/api/walmart/scan-config');
  assert.equal(status, 200);
  assert.equal(body.ok, false, 'the demo catalog lacks some of the configured departments');
  assert.ok(body.config.stores.some((s) => s.id === '573'));
  assert.ok(body.availableDepartments.includes('Toys'));
});
