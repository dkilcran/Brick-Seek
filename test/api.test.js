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
  assert.ok((await get('/api/walmart/stores?zip=10001')).body.stores.length > 0);
  assert.ok((await get('/api/walmart/categories')).body.categories.includes('Toys'));
});

test('validation and error statuses', async () => {
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
