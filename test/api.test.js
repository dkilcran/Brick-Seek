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
