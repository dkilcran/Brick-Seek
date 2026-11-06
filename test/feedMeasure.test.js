import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StoreScanDb } from '../src/retailers/walmart/storeScan.js';
import { TierStore } from '../src/retailers/walmart/tierLists.js';
import { FeedMeasure } from '../src/retailers/walmart/feedMeasure.js';

test('feed measurement pages each department feed, checks candidates at a store, and compares with the lists', async () => {
  const db = new StoreScanDb(new PriceTracker().db);
  const tiers = new TierStore(db);
  tiers.insertItem.run('walmart', 1, 'r1', '1', 'Toys', null);
  tiers.markBuilt(1, 'r1');
  const pages = {
    'clearance:': { items: [
      { itemId: 1, sellerInfo: 'Walmart.com' }, { itemId: 2 }, { itemId: 3, sellerInfo: 'Toy Co' }, { itemId: 4, offerType: 'ONLINE_ONLY' },
    ], nextPage: '/v1/paginated/items?category=4171&specialOffer=clearance&lastDoc=abc' },
    'clearance:abc': { items: [{ itemId: 5 }] },
    'rollback:': { items: [{ itemId: 2 }] },
  };
  const source = {
    taxonomy: async () => [{ name: 'Toys', id: '4171' }],
    async request(path, q) { return pages[`${q.specialOffer}:${q.lastDoc ?? ''}`] ?? { items: [] }; },
    async storeLookup(ids) {
      return {
        found: ids.filter((id) => id !== '5').map((id) => ({ itemId: id, isWalmart: true, clearance: id === '2' })),
        missing: ids.filter((id) => id === '5'),
        onlineOnly: [],
      };
    },
  };
  const m = new FeedMeasure({ source, db, tiers, loadConfig: () => ({ config: { departments: ['Toys'] } }) });
  assert.equal(m.start(), true);
  while (m.running) await new Promise((r) => setTimeout(r, 5));
  const s = m.status();
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.feeds.map((f) => [f.offer, f.pages, f.items, f.otherSeller, f.onlineOnly]), [['clearance', 2, 5, 1, 1], ['rollback', 1, 1, 0, 0]]);
  assert.deepEqual(s.lookups, { candidates: 3, checked: 3, sampled: false, foundWalmartInStore: 2, notAtStore: 1, onlineOnly: 0, otherSeller: 0, clearanceFlag: 1 });
  assert.deepEqual(s.compare, { inTier1: 1, inTier2: 0, inTier3Only: 0, inNoList: 1 });
  assert.deepEqual(s.sampleMissed, ['2']);
});
