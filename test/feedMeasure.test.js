import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StoreScanDb } from '../src/retailers/walmart/storeScan.js';
import { TierStore } from '../src/retailers/walmart/tierLists.js';
import { FeedMeasure } from '../src/retailers/walmart/feedMeasure.js';

function setup() {
  const db = new StoreScanDb(new PriceTracker().db);
  const tiers = new TierStore(db);
  tiers.insertItem.run('walmart', 1, 'r1', '1', 'Toys', null);
  tiers.markBuilt(1, 'r1');
  tiers.insertItem.run('walmart', 3, 'r3', '7', 'Toys', null);
  tiers.markBuilt(3, 'r3');
  let limited = 1; // the first feed call is rate-limited once
  const pages = {
    'clearance:': { items: [
      { itemId: 1, sellerInfo: 'Walmart.com' }, { itemId: 2 }, { itemId: 3, sellerInfo: 'Toy Co' },
    ], nextPage: '/v1/paginated/items?category=4171&specialOffer=clearance&lastDoc=abc' },
    'clearance:abc': { items: [{ itemId: 5 }] },
    'rollback:': { items: [{ itemId: 2 }] },
    'reduced:': { items: [{ itemId: 6 }] },
    'undefined:': { items: [{ itemId: 7 }, { itemId: 8 }, { itemId: 9, sellerInfo: 'Other' }] },
  };
  const source = {
    taxonomy: async () => [{ name: 'Toys', id: '4171' }],
    async request(path, q) {
      if (limited-- > 0) throw new Error('Walmart API 429: too many');
      return pages[`${q.specialOffer}:${q.lastDoc ?? ''}`] ?? { items: [] };
    },
    async storeLookup(ids) {
      return {
        found: ids.filter((id) => id !== '5' && id !== '6').map((id) => ({ itemId: id, isWalmart: true, clearance: id === '2' })),
        missing: ids.filter((id) => id === '5'),
        onlineOnly: ids.filter((id) => id === '6'),
      };
    },
  };
  return { db, tiers, source };
}

test('feed measurement: deal feeds (with Reduced Price) and everything feeds vs the lists, waiting out rate limits', async () => {
  const { db, tiers, source } = setup();
  const m = new FeedMeasure({ source, db, tiers, loadConfig: () => ({ config: { departments: ['Toys'] } }), rateLimitWaitMs: 1 });
  m.schedule();
  await new Promise((r) => setTimeout(r, 5));
  while (m.running) await new Promise((r) => setTimeout(r, 5));
  const s = m.status();
  assert.equal(s.phase, 'done', s.error);
  assert.equal(s.rateLimitWaits, 1);
  assert.equal(s.scheduledFor, null, 'the plan is cleared when done');
  assert.deepEqual(s.deals.feeds.map((f) => [f.offer, f.pages, f.items, f.complete]), [['clearance', 2, 4, true], ['rollback', 1, 1, true], ['reduced', 1, 1, true]]);
  assert.deepEqual(s.deals.lookups.onlineOnly, 1);
  assert.deepEqual(s.deals.compare, { inTier1: 1, inTier2: 0, inTier3Only: 0, inNoList: 1 });
  assert.deepEqual(s.deals.missedByOffer, { clearance: 1, rollback: 1 });
  assert.deepEqual(s.tier3.compare, { inTier3: 1, notInTier3: 1 });
});

test('a scheduled measurement is saved and picked up again after a restart', () => {
  const { db, tiers, source } = setup();
  const at = new Date(Date.now() + 3600000).toISOString();
  const m = new FeedMeasure({ source, db, tiers, loadConfig: () => ({ config: { departments: [] } }) });
  m.schedule({ at });
  clearTimeout(m.timer);
  const after = new FeedMeasure({ source, db, tiers, loadConfig: () => ({ config: { departments: [] } }) });
  assert.equal(after.status().scheduledFor, at);
  clearTimeout(after.timer);
});
