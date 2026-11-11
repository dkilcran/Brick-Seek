import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCards, sortCards, discount, priceSignals } from '../src/lib/allDeals.js';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StorePrices } from '../src/retailers/walmart/storePrices.js';
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

test('Online Deals / In Store Deals: items with that kind of deal, always with all their lines', () => {
  assert.deepEqual(ids(filterCards(cards)), ['both', 'web', 'shelf', 'roll']);
  const online = filterCards(cards, { where: ['online'] });
  assert.deepEqual(ids(online), ['both', 'web', 'roll']);
  assert.ok(online[0].store, 'the store deal still shows on an item picked for its online deal');
  const stores = filterCards(cards, { where: ['stores'] });
  assert.deepEqual(ids(stores), ['both', 'shelf']);
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
  const db = new StorePrices(tracker.db);
  const tiers = new TierStore(db);
  const day = new Date().toISOString().slice(0, 10);
  tiers.insertItem.run('walmart', 1, 'r1', 'clr', 'Home', null);
  tiers.insertItem.run('walmart', 2, 'r2', 'rb', 'Home', 'rollback');
  tiers.insertItem.run('walmart', 2, 'r2', 'mkt', 'Home', 'reduced');
  tiers.markBuilt(1, 'r1'); tiers.markBuilt(2, 'r2');
  for (const [id, name] of [['clr', 'Blanket'], ['rb', 'Mixer'], ['mkt', 'Chair']]) {
    tiers.saveProduct('r2', { id, name, price: 10, category: 'Home' });
  }
  db.saveOnlineLookup('walmart', 'clr', { isWalmart: true, price: 8, wasPrice: 12, onlineOnly: true, availableOnline: true }, day);
  db.saveOnlineLookup('walmart', 'rb', { isWalmart: true, price: 20, wasPrice: 25, onlineOnly: false, availableOnline: true }, day);
  db.saveOnlineLookup('walmart', 'mkt', { isWalmart: false, price: 5 }, day); // marketplace online: no online deal
  db.recordStorePrices('walmart', '573', [{ itemId: 'rb', title: 'Mixer', price: 15, wasPrice: 25, seller: 'Walmart.com', inStock: true }], day);
  db.refreshMarkdowns('walmart');
  const adapter = new WalmartAdapter({
    source: {}, mode: 'live', tracker, storeData: db, tierStore: tiers,
    loadStoreConfig: () => ({ config: { stores: [{ id: '573', label: "Lee's Summit" }], departments: ['Home'] }, errors: [] }),
  });
  const byId = Object.fromEntries((await adapter.allDealCards()).map((c) => [c.product.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), ['clr', 'rb']);
  assert.deepEqual([byId.clr.online.label, byId.clr.online.percentOff, byId.clr.soldOnline, byId.clr.soldInStores], ['Clearance', 33, true, false]);
  assert.deepEqual([byId.rb.online.label, byId.rb.store.label, byId.rb.store.price, byId.rb.soldInStores], ['Rollback', 'Rollback', 15, true]);
  assert.equal(adapter.onlineDeal('rb').wasPrice, 25);
  assert.equal(adapter.onlineDeal('mkt'), null, 'a marketplace offer online');
  // The online price dropped since the last recorded day, and was never lower.
  for (let d = 1; d <= 7; d++) tracker.record('walmart', 'rb', 24, new Date(Date.now() - d * 86400000));
  adapter.cardCache.clear();
  const rb = (await adapter.allDealCards()).find((c) => c.product.id === 'rb');
  assert.deepEqual([rb.dropPercent, rb.atLowest], [17, true]);
  // Rollback online with no Walmart.com was-price: not an online deal.
  tiers.insertItem.run('walmart', 2, 'r2', 'flat', 'Home', 'rollback');
  tiers.saveProduct('r2', { id: 'flat', name: 'Soda', price: 91.54, category: 'Home' });
  db.saveOnlineLookup('walmart', 'flat', { isWalmart: true, price: 91.54, wasPrice: null, onlineOnly: false, availableOnline: true }, day);
  adapter.cardCache.clear();
  assert.equal((await adapter.allDealCards()).some((c) => c.product.id === 'flat'), false);
  assert.equal(adapter.onlineDeal('flat'), null);
  // A store deal with no online lookup yet isn't called store-only.
  db.recordStorePrices('walmart', '573', [{ itemId: 'shelf', title: 'Lamp', price: 3, clearance: true, seller: 'Walmart.com', inStock: true }], day);
  db.refreshMarkdowns('walmart'); // new store deals: the cards are rebuilt
  let shelf = (await adapter.allDealCards()).find((c) => c.product.id === 'shelf');
  assert.equal(shelf.soldOnline, true);
  db.saveOnlineLookup('walmart', 'shelf', { isWalmart: true, price: 5, onlineOnly: false, availableOnline: false }, day);
  assert.equal((await adapter.allDealCards()).find((c) => c.product.id === 'shelf').soldOnline, true, 'online changes wait up to 5 minutes');
  adapter.cardCache.clear();
  shelf = (await adapter.allDealCards()).find((c) => c.product.id === 'shelf');
  assert.equal(shelf.soldOnline, false, 'the lookup says it is not sold online');

  // Card sets are kept per ZIP.
  const source = { stores: async () => [{ retailer: 'walmart', id: '573', name: 'Lee' }] };
  adapter.source = source;
  const near = await adapter.allDealCards({ zip: '64081' });
  const all = await adapter.allDealCards();
  assert.equal(await adapter.allDealCards({ zip: '64081' }), near, 'reused');
  assert.equal(await adapter.allDealCards(), all);
});

test('price signals: the drop since the last recorded price, and lowest-ever after a week of history', () => {
  const days = (prices) => prices.map((price, i) => ({ date: `2026-11-0${i + 1}`, price }));
  assert.deepEqual(priceSignals(8, days([10, 10, 9]), '2026-11-04'), { dropPercent: 11, atLowest: false }, 'too little history for "lowest"');
  assert.deepEqual(priceSignals(8, days([10, 10, 9, 9, 9, 9, 9]), '2026-11-08'), { dropPercent: 11, atLowest: true });
  assert.deepEqual(priceSignals(9, days([10, 7, 9, 9, 9, 9, 9]), '2026-11-08'), { dropPercent: 0, atLowest: false });
  assert.deepEqual(priceSignals(8, days([9, 8]), '2026-11-02'), { dropPercent: 11, atLowest: false }, 'today\'s own entry is ignored');
  assert.deepEqual(priceSignals(8, []), { dropPercent: 0, atLowest: false });
});

test('a retailer without its own deal cards gets them from its deal candidates and local clearance', async () => {
  const adapter = new WalmartAdapter(); // demo mode
  const cards = await adapter.allDealCards({ zip: '72712' });
  assert.ok(cards.length > 10);
  assert.ok(cards.every((c) => c.online || c.store));
  assert.ok(cards.some((c) => c.online?.label === 'Clearance') && cards.some((c) => c.online?.label === 'Rollback'));
  assert.ok(cards.some((c) => c.store?.storesWithDeal >= 1 && c.store.label === 'Clearance'));
  assert.ok(!cards.some((c) => c.product.id.startsWith('511')), 'no marketplace items');
  assert.equal((await adapter.allDealCards()).filter((c) => c.store).length, 0, 'store deals need a ZIP');
});
