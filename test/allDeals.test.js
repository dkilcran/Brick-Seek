import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCards, sortCards, discount } from '../src/lib/allDeals.js';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StoreScanDb } from '../src/retailers/walmart/storeScan.js';
import { TierStore } from '../src/retailers/walmart/tierLists.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';

const line = (kind, price, ref) => ({ kind, price, ...discount(price, ref) });
const cards = [
  // Rollback online and Clearance at a store
  { product: { id: 'both', name: 'Laptop', category: 'Electronics' }, online: line('rollback', 599, 799), store: line('clearance', 449, 799), soldOnline: true, soldInStores: true },
  // Walmart.com only (not in stores)
  { product: { id: 'web', name: 'Rug', category: 'Home' }, online: line('reduced', 50, 80), store: null, soldOnline: true, soldInStores: false },
  // Store only (not sold online), a Markdown
  { product: { id: 'shelf', name: 'Lamp', category: 'Home' }, online: null, store: line('markdown', 6, 10), soldOnline: false, soldInStores: true },
  // In stores with only an online deal
  { product: { id: 'roll', name: 'Mixer', category: 'Home' }, online: line('rollback', 98, 110), store: null, soldOnline: true, soldInStores: true, dropPercent: 12, atLowest: true },
];
const ids = (list) => list.map((c) => c.product.id);

test('where it is sold: both by default; online hides store lines; in stores keeps online lines', () => {
  assert.deepEqual(ids(filterCards(cards)), ['both', 'web', 'shelf', 'roll']);
  const online = filterCards(cards, { where: ['online'] });
  assert.deepEqual(ids(online), ['both', 'web', 'roll']);
  assert.equal(online[0].store, null, 'store line hidden when only Sold Online is picked');
  const stores = filterCards(cards, { where: ['stores'] });
  assert.deepEqual(ids(stores), ['both', 'shelf', 'roll'], 'in-store items, even with only an online deal');
  assert.ok(stores[0].online && stores[0].store, 'both lines shown');
});

test('badge filter, text, category, price range and minimum discount', () => {
  assert.deepEqual(ids(filterCards(cards, { labels: ['clearance'] })), ['both']);
  assert.deepEqual(ids(filterCards(cards, { labels: ['markdown', 'reduced'] })), ['web', 'shelf']);
  assert.deepEqual(ids(filterCards(cards, { labels: ['lowest'] })), ['roll']);
  assert.deepEqual(ids(filterCards(cards, { labels: ['drop'] })), ['roll']);
  assert.deepEqual(ids(filterCards(cards, { q: 'lap' })), ['both']);
  assert.deepEqual(ids(filterCards(cards, { category: 'Home' })), ['web', 'shelf', 'roll']);
  assert.deepEqual(ids(filterCards(cards, { minPrice: 40, maxPrice: 100 })), ['web', 'roll']);
  // best % off: both 44 (store), web 38, shelf 40, roll 11
  assert.deepEqual(ids(filterCards(cards, { minDiscount: 40 })), ['both', 'shelf']);
});

test('sorting uses each card\'s best deal', () => {
  const all = filterCards(cards);
  assert.deepEqual(ids(sortCards(all, 'percent')), ['both', 'shelf', 'web', 'roll']);
  assert.deepEqual(ids(sortCards(all, 'dollars')), ['both', 'web', 'roll', 'shelf']);
  assert.deepEqual(ids(sortCards(all, 'price')), ['shelf', 'web', 'roll', 'both']);
  assert.deepEqual(ids(sortCards(all, 'drop')), ['roll', 'both', 'web', 'shelf']);
});

test('Walmart builds cards from the online lookups and store deals', async () => {
  const tracker = new PriceTracker();
  const db = new StoreScanDb(tracker.db);
  const tiers = new TierStore(db);
  const day = new Date().toISOString().slice(0, 10);
  tiers.insertItem.run('walmart', 1, 'r1', 'clr', 'Home', null);
  tiers.insertItem.run('walmart', 2, 'r2', 'rb', 'Home', 'rollback');
  tiers.insertItem.run('walmart', 2, 'r2', 'mkt', 'Home', 'reduced');
  tiers.markBuilt(1, 'r1'); tiers.markBuilt(2, 'r2');
  for (const [id, name] of [['clr', 'Blanket'], ['rb', 'Mixer'], ['mkt', 'Chair']]) {
    tiers.upsertProduct.run('walmart', id, 'r2', JSON.stringify({ id, name, price: 10, category: 'Home' }));
  }
  db.saveOnlineLookup('walmart', 'clr', { isWalmart: true, price: 8, wasPrice: 12, onlineOnly: true, availableOnline: true }, day);
  db.saveOnlineLookup('walmart', 'rb', { isWalmart: true, price: 20, wasPrice: 25, onlineOnly: false, availableOnline: true }, day);
  db.saveOnlineLookup('walmart', 'mkt', { isWalmart: false, price: 5 }, day); // marketplace online: no online deal
  db.recordStorePrices('walmart', '573', [{ itemId: 'rb', title: 'Mixer', price: 15, wasPrice: 25, seller: 'Walmart.com', inStock: true }], day);
  db.refreshMarkdowns('walmart');
  const adapter = new WalmartAdapter({ source: { pool: null, poolStamp: 1 }, mode: 'live', tracker });
  adapter.storeDb = db;
  adapter.tierStore = tiers;
  adapter.loadStoreConfig = () => ({ config: { stores: [{ id: '573', label: "Lee's Summit" }], departments: ['Home'] }, errors: [] });
  const byId = Object.fromEntries((await adapter.allDealCards()).map((c) => [c.product.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['clr', 'rb']);
  assert.deepEqual([byId.clr.online.label, byId.clr.online.percentOff, byId.clr.soldOnline, byId.clr.soldInStores], ['Clearance', 33, true, false]);
  assert.deepEqual([byId.rb.online.label, byId.rb.store.label, byId.rb.store.price, byId.rb.soldInStores], ['Rollback', 'Rollback', 15, true]);
  assert.equal(adapter.onlineDeal('rb').wasPrice, 25);
  // A store deal with no online lookup yet isn't called store-only.
  db.recordStorePrices('walmart', '573', [{ itemId: 'shelf', title: 'Lamp', price: 3, clearance: true, seller: 'Walmart.com', inStock: true }], day);
  db.refreshMarkdowns('walmart');
  adapter.cardCache = null;
  let shelf = (await adapter.allDealCards()).find((c) => c.product.id === 'shelf');
  assert.equal(shelf.soldOnline, true);
  db.saveOnlineLookup('walmart', 'shelf', { isWalmart: true, price: 5, onlineOnly: false, availableOnline: false }, day);
  adapter.cardCache = null;
  shelf = (await adapter.allDealCards()).find((c) => c.product.id === 'shelf');
  assert.equal(shelf.soldOnline, false, 'the lookup says it is not sold online');
});
