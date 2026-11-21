// Times the pages' read paths on a production-size database (805,000 current
// store prices, 6,000 listed deal items). Run before pushing a new query:
//   node scripts/perf.mjs [db path]     (builds the database the first time, ~20 s)
// Production on Render is about 5-10x slower than this machine.
import { existsSync } from 'node:fs';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StorePrices } from '../src/retailers/walmart/storePrices.js';
import { TierStore } from '../src/retailers/walmart/tierLists.js';
import { WalmartAdapter } from '../src/retailers/walmart/index.js';
import { filterCards, sortCards } from '../src/lib/allDeals.js';
const path = process.argv[2] ?? 'data/perf.db';
const fresh = !existsSync(path);
const tracker = new PriceTracker({ dbPath: path });
const db = new StorePrices(tracker.db);
const tiers = new TierStore(db);
const day = new Date().toISOString().slice(0, 10);
const storeIds = Array.from({ length: 23 }, (_, i) => String(1000 + i));
const time = async (label, fn) => { const t0 = performance.now(); const r = await fn(); console.log(label.padEnd(34), Math.round(performance.now() - t0), 'ms'); return r; };
if (fresh) {
  await time('build', () => {
    for (const store of storeIds) {
      const batch = [];
      for (let i = 0; i < 35000; i++) {
        const id = String(100000 + ((i * 7 + Number(store)) % 40000));
        batch.push({ itemId: id, title: `Item ${id} with a typical long Walmart title`, category: i % 3 ? 'Home' : 'Toys', imageUrl: 'https://i5.walmartimages.com/x.jpeg',
          price: i % 50 === 0 && store === '1003' ? 3 : 5, wasPrice: i % 40 === 0 ? 9 : null, clearance: i % 60 === 0, seller: 'Walmart.com', inStock: true });
      }
      db.recordStorePrices('walmart', store, batch, day);
    }
    const run = `${day}:t12`;
    db.db.exec('BEGIN');
    for (let i = 0; i < 6000; i++) {
      const id = String(100000 + i * 6);
      const kind = ['clearance', 'rollback', 'reduced'][i % 3];
      tiers.insertItem.run('walmart', kind === 'clearance' ? 1 : 2, run, id, 'Home', kind === 'clearance' ? null : kind);
      tiers.saveProduct(run, { retailer: 'walmart', id, name: `Item ${id}`, price: 8, category: 'Home', seller: { name: 'Walmart.com', isRetailer: true } });
      db.saveOnlineLookup('walmart', id, { isWalmart: true, price: 8, wasPrice: 12, onlineOnly: i % 5 === 0, availableOnline: true }, day);
    }
    db.db.exec('COMMIT');
    for (let d = 1; d <= 10; d++) tracker.recordMany('walmart', Array.from({ length: 6000 }, (_, i) => ({ id: String(100000 + i * 6), price: 8 + (d % 3) })), new Date(Date.now() - d * 86400000));
    tiers.markBuilt(1, run); tiers.markBuilt(2, run);
  });
}
console.log('store_latest rows', db.db.prepare('SELECT COUNT(*) n FROM store_latest').get().n);
await time('refreshMarkdowns', () => db.refreshMarkdowns('walmart'));
const stores = storeIds.map((id) => ({ retailer: 'walmart', id, name: `Store ${id}` }));
const adapter = new WalmartAdapter({
  source: { stores: async () => stores, getById: async () => null }, mode: 'live', tracker, storeData: db, tierStore: tiers,
  loadStoreConfig: () => ({ config: { stores: storeIds.map((id) => ({ id, label: `Store ${id}` })), departments: ['Home', 'Toys'] }, errors: [] }),
});
const cards = await time('allDealCards cold (zip)', () => adapter.allDealCards({ zip: '64081' }));
console.log('cards', cards.length);
await time('allDealCards warm', () => adapter.allDealCards({ zip: '64081' }));
adapter.cardCache.clear();
await time('allDealCards cold (no zip)', () => adapter.allDealCards({}));
await time('filter+sort best', () => sortCards(filterCards(cards, { where: ['online', 'stores'] }), 'best').slice(0, 60));
await time('filter+sort percent, q', () => sortCards(filterCards(cards, { q: 'item 1', labels: ['clearance'] }), 'percent').slice(0, 60));
await time('getProduct x200', async () => { for (let i = 0; i < 200; i++) await adapter.getProduct(String(100000 + i * 13)); });
await time('checkInventory x50', async () => { for (let i = 0; i < 50; i++) await adapter.checkInventory(String(100000 + i * 17), '64081'); });
await time('storeOffers x200', () => { for (let i = 0; i < 200; i++) adapter.storeOffers(String(100000 + i * 13)); });
await time('onlineDeal x200', () => { for (let i = 0; i < 200; i++) adapter.onlineDeal(String(100000 + i * 6)); });
await time('searchItems', () => db.searchItems('walmart', 'item 12345'));
await time('prune', () => db.prune());
// Store price history for a product page, with a real change log.
for (let d = 1; d <= 13; d++) {
  const date = new Date(Date.now() - (14 - d) * 86400000).toISOString().slice(0, 10);
  db.recordStorePrices('walmart', storeIds[d % 23], Array.from({ length: 3000 }, (_, i) => ({ itemId: String(100000 + i), price: 4 + (d % 3), seller: 'Walmart.com', inStock: true })), date);
}
await time('storeHistory x50', () => { for (let i = 0; i < 50; i++) db.storeHistory('walmart', String(100000 + i * 7)); });
await time('storePriceHistory (adapter)', () => adapter.storePriceHistory('100007', '64081'));
console.log('stores with history', (await adapter.storePriceHistory('100007', '64081')).length);
