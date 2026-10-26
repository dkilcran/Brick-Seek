import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseWalmartInput } from '../src/retailers/walmart/identifiers.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';
import { WalmartDemoSource } from '../src/retailers/walmart/demoSource.js';
import { WalmartLiveSource, signWalmartRequest } from '../src/retailers/walmart/liveSource.js';
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

test('demo deals respect filters and sort by discount', async () => {
  const adapter = new WalmartAdapter();
  const deals = await adapter.getDeals({ minDiscount: 30, category: 'Home' });
  assert.ok(deals.length > 0);
  for (const d of deals) {
    assert.equal(d.product.category, 'Home');
    assert.ok(d.discountPercent >= 30);
  }
  const pcts = deals.map((d) => d.discountPercent);
  assert.deepEqual(pcts, [...pcts].sort((x, y) => y - x));
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
});
