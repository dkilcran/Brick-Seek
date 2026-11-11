import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StorePrices } from '../src/retailers/walmart/storePrices.js';

test('price history only grows when something changes; current prices still show the latest check', () => {
  const db = new StorePrices(new PriceTracker().db);
  const save = (date, price, clearance = false) => db.recordStorePrices('walmart', '573', [{ itemId: '1', price, seller: 'Walmart.com', inStock: true, clearance }], date);
  save('2026-11-01', 5);
  save('2026-11-02', 5);
  save('2026-11-03', 5);
  save('2026-11-04', 3, true);
  const rows = db.db.prepare('SELECT date, price FROM store_prices ORDER BY date').all().map((r) => `${r.date}:${r.price}`);
  assert.deepEqual(rows, ['2026-11-01:5', '2026-11-04:3']);
  assert.equal(db.db.prepare('SELECT date FROM store_latest').get().date, '2026-11-04');

  // The current price remembers the price before its last change.
  const latest = db.db.prepare('SELECT price, prev_price, prev_date FROM store_latest').get();
  assert.deepEqual({ ...latest }, { price: 3, prev_price: 5, prev_date: '2026-11-03' });
});

test('prune drops price history older than 14 days in chunks and keeps current prices', async () => {
  const db = new StorePrices(new PriceTracker().db);
  const items = Array.from({ length: 6000 }, (_, i) => ({ itemId: String(i), price: 5, seller: 'Walmart.com' }));
  db.recordStorePrices('walmart', '573', items, '2026-10-01');
  db.recordStorePrices('walmart', '573', [{ itemId: '1', price: 4, seller: 'Walmart.com' }], '2026-11-01');
  await db.prune(Date.parse('2026-11-04T12:00:00Z'));
  assert.deepEqual(db.db.prepare('SELECT item_id, date FROM store_prices').all().map((r) => `${r.item_id}:${r.date}`), ['1:2026-11-01']);
});

test('deal labels: Walmart Clearance, Rollback / Reduced Price, our Markdown; a was-price alone is not a deal', async () => {
  const { TierStore } = await import('../src/retailers/walmart/tierLists.js');
  const db = new StorePrices(new PriceTracker().db);
  const tiers = new TierStore(db);
  tiers.insertItem.run('walmart', 2, 'r2', 'roll', 'Toys', 'rollback');
  tiers.insertItem.run('walmart', 2, 'r2', 'reduced', 'Toys', 'reduced');
  tiers.markBuilt(2, 'r2');
  const day = '2026-11-04';
  const at = (store, rows) => db.recordStorePrices('walmart', store, rows.map((r) => ({ seller: 'Walmart.com', inStock: true, ...r })), day);
  at('A', [
    { itemId: 'clr', price: 3, wasPrice: 9, clearance: true },
    { itemId: 'roll', price: 5, wasPrice: 8 },
    { itemId: 'reduced', price: 6, wasPrice: 7 },
    { itemId: 'wasOnly', price: 10, wasPrice: 30 }, // same price everywhere: Walmart's reference price
    { itemId: 'cheap', price: 7 },
    { itemId: 'slight', price: 9.5 },
  ]);
  for (const s of ['B', 'C']) {
    at(s, [
      { itemId: 'clr', price: 3, wasPrice: 9, clearance: true },
      { itemId: 'wasOnly', price: 10, wasPrice: 30 },
      { itemId: 'cheap', price: 10 },
      { itemId: 'slight', price: 10 },
    ]);
  }
  db.refreshMarkdowns('walmart', { now: Date.parse('2026-11-04T12:00:00Z') });
  const rows = db.markdownRows('walmart', ['A']);
  const kinds = Object.fromEntries(rows.map((r) => [r.item_id, [r.kind, r.ref_price]]));
  assert.deepEqual(kinds, {
    clr: ['clearance', 9],
    roll: ['rollback', 8],
    reduced: ['reduced', 7],
    cheap: ['markdown', 10], // 30% below the highest price at other stores
  });
  assert.equal(db.markdownRows('walmart', ['B']).length, 1, 'only the Clearance item at B');

  // A drop at one store, measured against its own earlier price.
  db.recordStorePrices('walmart', 'D', [{ itemId: 'solo', price: 20, seller: 'Walmart.com', inStock: true }], '2026-11-01');
  db.recordStorePrices('walmart', 'D', [{ itemId: 'solo', price: 15, seller: 'Walmart.com', inStock: true }], day);
  db.refreshMarkdowns('walmart', { now: Date.parse('2026-11-04T12:00:00Z') });
  assert.deepEqual(db.markdownRows('walmart', ['D']).map((r) => [r.item_id, r.kind, r.ref_price]), [['solo', 'markdown', 20]]);
  assert.equal(db.itemMarkdowns('walmart', 'solo').get('D').kind, 'markdown');

  // Online-only items are dropped from every store.
  db.dropItems('walmart', ['clr']);
  assert.equal(db.latestPrices('walmart', ['A', 'B', 'C'], 'clr', { now: Date.parse('2026-11-04T12:00:00Z') }).length, 0);
});

test('the highest store price only counts current Walmart-sold prices', () => {
  const db = new StorePrices(new PriceTracker().db);
  db.recordStorePrices('walmart', 'A', [{ itemId: '1', price: 1, seller: 'Walmart.com', inStock: true }], '2026-11-04');
  db.recordStorePrices('walmart', 'B', [{ itemId: '1', price: 6, seller: 'Chip Co', inStock: true }], '2026-11-04');
  db.recordStorePrices('walmart', 'C', [{ itemId: '1', price: 6, seller: 'Walmart.com', inStock: true }], '2026-10-01');
  db.refreshMarkdowns('walmart', { now: Date.parse('2026-11-04T12:00:00Z') });
  assert.equal(db.markdownRows('walmart', ['A']).length, 0, 'one current Walmart price: nothing to compare with');
});

test('markdowns are measured against the highest valid store price, not the median', () => {
  const db = new StorePrices(new PriceTracker().db);
  const day = '2026-11-04';
  const at = (store, price) => db.recordStorePrices('walmart', store, [{ itemId: '1', price, seller: 'Walmart.com', inStock: true }], day);
  at('A', 5); at('B', 5); at('C', 5); at('D', 10);
  db.refreshMarkdowns('walmart', { now: Date.parse('2026-11-04T12:00:00Z') });
  const rows = db.markdownRows('walmart', ['A', 'B', 'C', 'D']).map((r) => [r.store_id, r.kind, r.ref_price]).sort();
  assert.deepEqual(rows, [['A', 'markdown', 10], ['B', 'markdown', 10], ['C', 'markdown', 10]], 'half off the highest store price');
});

test('valid store prices: none above the list price, and Walmart\'s online price caps the reference', () => {
  const db = new StorePrices(new PriceTracker().db);
  const day = '2026-11-04';
  const now = Date.parse('2026-11-04T12:00:00Z');
  const at = (store, itemId, price, extra = {}) =>
    db.recordStorePrices('walmart', store, [{ itemId, price, seller: 'Walmart.com', inStock: true, ...extra }], day);
  // Mortal Kombat: $69 list price; $105.68 at some stores isn't a valid reference.
  for (const s of ['A', 'B']) at(s, 'mk', 29.83, { listPrice: 69 });
  for (const s of ['C', 'D']) at(s, 'mk', 105.68, { listPrice: 69 });
  // Olipop: no list price, $15.76 online at Walmart; one store at $91.54.
  for (const s of ['A', 'B', 'C']) at(s, 'soda', 15.76);
  at('D', 'soda', 91.54);
  db.saveOnlinePrice('walmart', 'soda', 15.76, day);
  // A real markdown: $10 at two stores and online, $6 at one.
  at('A', 'lamp', 6); at('B', 'lamp', 10); at('C', 'lamp', 10);
  db.saveOnlinePrice('walmart', 'lamp', 10, day);
  // Clearance at a store but cheaper online: not a deal.
  at('A', 'mug', 5, { clearance: true, wasPrice: 9 });
  db.saveOnlinePrice('walmart', 'mug', 4, day);
  // Online price from a marketplace seller isn't saved as Walmart's (null): no cap.
  at('A', 'rug', 20); at('B', 'rug', 40);
  db.saveOnlinePrice('walmart', 'rug', null, day);
  db.refreshMarkdowns('walmart', { now });
  const rows = db.markdownRows('walmart', ['A', 'B', 'C', 'D']).map((r) => `${r.store_id}:${r.item_id}:${r.kind}:${r.ref_price}`).sort();
  assert.deepEqual(rows, ['A:lamp:markdown:10', 'A:rug:markdown:40']);
});

test('a store lookup saves prices, marks online-only items and forgets their store prices', () => {
  const db = new StorePrices(new PriceTracker().db);
  const day = '2026-11-04';
  db.recordStorePrices('walmart', '573', [{ itemId: 'web', title: 'Rug', price: 30, seller: 'Walmart.com' }], day);
  const saved = db.recordStoreLookup('walmart', '573', {
    found: [{ itemId: 'lamp', title: 'Lamp', category: 'Home', listPrice: 12, price: 9, seller: 'Walmart.com', inStock: true }],
    onlineOnly: ['web'],
  }, day);
  assert.equal(saved, 1);
  assert.equal(db.isOnlineOnly('walmart', 'web'), true);
  assert.equal(db.soldInStores('walmart', 'web'), false);
  assert.equal(db.soldInStores('walmart', 'lamp'), true);
  const lamp = db.item('walmart', 'lamp');
  assert.deepEqual([lamp.title, lamp.department, lamp.msrp], ['Lamp', 'Home', 12]);
  assert.deepEqual(db.scannedStores('walmart'), ['573']);
  assert.deepEqual({ ...db.priceCount('walmart') }, { n: 1, items: 1 });
  assert.deepEqual(db.inDepartments('walmart', ['lamp', 'web', 'new'], ['Toys']), ['web', 'new'], 'unknown departments are kept');
  assert.deepEqual(db.searchItems('walmart', 'LAM'), ['lamp']);
});

test('the online lookup: Walmart.com\'s price and was-price, or none for a marketplace offer', () => {
  const db = new StorePrices(new PriceTracker().db);
  db.recordStorePrices('walmart', '573', [{ itemId: 'a', price: 3, clearance: true, seller: 'Walmart.com' }], '2026-11-04');
  db.refreshMarkdowns('walmart', { now: Date.parse('2026-11-04T12:00:00Z') });
  assert.deepEqual(db.itemsNeedingOnlinePrice('walmart', '2026-11-04', ['b', 'a']), ['a', 'b']);
  db.saveOnlineLookup('walmart', 'a', { isWalmart: true, price: 4, wasPrice: 9, onlineOnly: false, availableOnline: true }, '2026-11-04');
  db.saveOnlineLookup('walmart', 'b', { isWalmart: false, price: 2 }, '2026-11-04');
  assert.deepEqual(db.itemsNeedingOnlinePrice('walmart', '2026-11-04', ['b', 'a']), []);
  assert.deepEqual(db.itemsNeedingOnlinePrice('walmart', '2026-11-05', ['b']), ['a', 'b'], 'again the next day');
  const a = db.item('walmart', 'a');
  assert.deepEqual([a.online_price, a.online_was, a.online_only, a.online_available], [4, 9, 0, 1]);
  assert.equal(db.item('walmart', 'b').online_price, null);
});

test('store lists per ZIP are saved for a week', () => {
  const db = new StorePrices(new PriceTracker().db);
  db.saveZipStores('walmart', '64081', [{ id: '573' }]);
  assert.deepEqual(db.zipStores('walmart', '64081'), [{ id: '573' }]);
  assert.equal(db.zipStores('walmart', '64081', { now: Date.now() + 8 * 86400000 }), null);
  assert.equal(db.zipStores('walmart', '66211'), null);
});

test('leftovers of removed features are dropped once', () => {
  const db = new StorePrices(new PriceTracker().db);
  db.db.exec('CREATE TABLE discovery_finds (x); CREATE TABLE saved_pools (x)');
  db.setMeta('feedMeasure:walmart', { big: true });
  db.setMeta('check:state', { day: '2026-11-04' });
  db.dropLegacy();
  db.dropLegacy();
  assert.equal(db.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('discovery_finds', 'saved_pools')").get().n, 0);
  assert.equal(db.getMeta('feedMeasure:walmart'), null);
  assert.deepEqual(db.getMeta('check:state'), { day: '2026-11-04' });
});

test('store price history: one point per day per store, carried forward between checks', () => {
  const db = new StorePrices(new PriceTracker().db);
  const save = (store, date, price, extra = {}) => db.recordStorePrices('walmart', store, [{ itemId: '1', price, seller: 'Walmart.com', inStock: true, ...extra }], date);
  save('573', '2026-11-01', 5);
  save('573', '2026-11-02', 5);
  save('573', '2026-11-04', 3, { clearance: true, wasPrice: 5 });
  save('573', '2026-11-05', 3, { clearance: true, wasPrice: 5 });
  save('4590', '2026-11-05', 4);
  db.recordStorePrices('walmart', '1599', [{ itemId: '1', price: 1, seller: 'Rug Co', inStock: true }], '2026-11-05');
  const history = db.storeHistory('walmart', '1', { now: Date.parse('2026-11-06T12:00:00Z') });
  assert.deepEqual(history.get('573').map((p) => [p.date, p.price, p.clearance]), [
    ['2026-11-01', 5, false], ['2026-11-02', 5, false], ['2026-11-03', 5, false], ['2026-11-04', 3, true], ['2026-11-05', 3, true],
  ]);
  assert.equal(history.get('573').at(-1).wasPrice, 5);
  assert.deepEqual(history.get('4590').map((p) => [p.date, p.price]), [['2026-11-05', 4]]);
  assert.equal(history.has('1599'), false, 'another seller\'s price');
  assert.deepEqual([...db.storeHistory('walmart', '1', { now: Date.parse('2026-11-30T12:00:00Z') }).keys()], [], 'older than 14 days');
});

test('each deal label rebuild calls onRefresh', () => {
  const db = new StorePrices(new PriceTracker().db);
  let calls = 0;
  db.onRefresh = () => { calls += 1; };
  db.refreshMarkdowns('walmart');
  db.refreshMarkdowns('walmart');
  assert.equal(calls, 2);
});
