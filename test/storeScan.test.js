import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowanceSoFar, dayWeight, monthPlan } from '../src/lib/scanSchedule.js';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { parseSearchResult, StoreScanDb, StoreScanner } from '../src/retailers/walmart/storeScan.js';

// November 2026: Sun the 1st, Wed the 4th, Thu the 5th
test('days are weighted toward Wed/Thu and the first week', () => {
  assert.equal(dayWeight(2026, 11, 2), 2); // Mon, first week
  assert.equal(dayWeight(2026, 11, 4), 6); // Wed, first week
  assert.equal(dayWeight(2026, 11, 11), 3); // Wed
  assert.equal(dayWeight(2026, 11, 13), 1); // Fri
  const plan = monthPlan(2026, 11, 250);
  assert.equal(Math.round(plan.reduce((a, d) => a + d.searches, 0)), 250);
  assert.ok(plan[3].searches > plan[10].searches && plan[10].searches > plan[12].searches);
});

test('allowance accrues through the morning and carries forward', () => {
  const at = (iso) => new Date(iso);
  // Nov 1 2026, Chicago is on CST (UTC-6) from 2am: 11:00Z is 5am local -> nothing yet
  assert.equal(allowanceSoFar(at('2026-11-01T11:00:00Z'), 250), 0);
  const day1 = monthPlan(2026, 11, 250)[0].searches;
  // 8am local: halfway through the 6-10am window
  assert.equal(allowanceSoFar(at('2026-11-01T14:00:00Z'), 250), Math.floor(day1 / 2));
  // afternoon: the whole day
  assert.equal(allowanceSoFar(at('2026-11-01T20:00:00Z'), 250), Math.floor(day1));
  // end of month: the whole budget
  assert.equal(allowanceSoFar(at('2026-12-01T05:00:00Z'), 250), 250);
});

test('parses SerpApi Walmart results leniently', () => {
  const r = parseSearchResult({
    us_item_id: '17216380', title: 'Bath Mat', primary_offer: { offer_price: 14.39 }, price_was: '$100.00',
    out_of_stock: false, seller_name: 'Walmart.com', thumbnail: 'https://i5.walmartimages.com/x.jpg',
  });
  assert.deepEqual(r, {
    itemId: '17216380', title: 'Bath Mat', price: 14.39, wasPrice: 100, inStock: true,
    seller: 'Walmart.com', sponsored: false, imageUrl: 'https://i5.walmartimages.com/x.jpg', url: null,
  });
});

function makeScanner({ now, fetchResults, budget = 250, departments = ['Home', 'Toys'], started, searchesLeft = 240 }) {
  const db = new StoreScanDb(new PriceTracker().db);
  if (started) db.setMeta('startedAt', new Date(started).getTime());
  const calls = [];
  const client = {
    walmartSearch: async (q) => { calls.push(q); return fetchResults(q); },
    account: async () => ({ plan_name: 'Free Plan', searches_per_month: 250, plan_searches_left: searchesLeft }),
  };
  const config = { stores: [{ id: '573' }, { id: '4590' }], departments, filters: ['special_offers:Clearance'], searchTerms: [''], monthlySearchBudget: budget };
  // An existing setup has already run its test search for these settings.
  if (started) db.setMeta('testedSettings', JSON.stringify([['573', '4590'], departments, config.filters, config.searchTerms]));
  const scanner = new StoreScanner({
    client, db, now,
    loadConfig: () => ({ config, errors: [] }),
    departments: async () => [{ id: '4044', name: 'Home' }, { id: '4171', name: 'Toys' }],
  });
  return { scanner, calls, db };
}

test('scanner runs one search per tick within the allowance, oldest job first', async () => {
  let clock = new Date('2026-11-04T16:00:00Z'); // Wed Nov 4, 10am Chicago: full day allowed
  const { scanner, calls, db } = makeScanner({
    started: '2026-10-15T12:00:00Z',
    now: () => clock,
    fetchResults: () => ({ organic_results: [{ us_item_id: '1', title: 'Lamp', primary_offer: { offer_price: 5 } }] }),
  });
  const first = await scanner.tick();
  assert.equal(first.ran, true);
  assert.deepEqual(calls[0], { query: '', storeId: '573', categoryId: '4044', facets: ['special_offers:Clearance'], page: undefined });
  clock = new Date(clock.getTime() + 60000);
  await scanner.tick();
  clock = new Date(clock.getTime() + 60000);
  await scanner.tick();
  // second and third searches cover jobs not yet run, never repeating one while others wait
  const jobs = calls.map((c) => `${c.storeId}|${c.categoryId}`);
  assert.equal(new Set(jobs).size, 3);
  assert.equal(db.priceCount('walmart').items, 1);
  const status = await scanner.status();
  assert.equal(status.used, 3);
  assert.equal(status.serpapiAccount.searchesLeft, 240);
  assert.equal(status.sampleResult.result.us_item_id, '1');
});

test('scanner waits when the allowance is used up and pauses after errors', async () => {
  const early = makeScanner({ started: '2026-10-15T12:00:00Z', now: () => new Date('2026-11-01T11:00:00Z'), fetchResults: () => ({ organic_results: [] }) });
  // it has searched before, so no "first search right away"
  early.db.recordRun({ retailer: 'walmart', storeId: '573', department: 'Home', term: 'clearance', month: '2026-10', ranAt: Date.parse('2026-10-20T15:00:00Z'), results: [] });
  assert.equal((await early.scanner.tick()).reason, 'waiting for schedule');
  assert.equal(early.calls.length, 0);

  let clock = new Date('2026-11-04T16:00:00Z');
  const failing = makeScanner({ started: '2026-10-15T12:00:00Z', now: () => clock, fetchResults: () => { throw new Error('SerpApi 401: Invalid API key'); } });
  const quiet = console.warn;
  console.warn = () => {};
  const r = await failing.scanner.tick();
  console.warn = quiet;
  assert.equal(r.ran, false);
  assert.equal(failing.db.searchesUsed('walmart', '2026-11'), 0, 'failed searches do not use the budget');
  clock = new Date(clock.getTime() + 60000);
  assert.equal((await failing.scanner.tick()).reason, 'pausing after an error');
});

test('first start: one search right away, then no backlog from earlier in the month', async () => {
  // Started Fri Oct 30 2026, 10:45am Chicago: October's earlier days must not be "owed"
  let clock = new Date('2026-10-30T15:45:00Z');
  const { scanner, calls } = makeScanner({ now: () => clock, fetchResults: () => ({ organic_results: [] }) });
  assert.equal((await scanner.tick()).ran, true, 'first search runs right away');
  clock = new Date(clock.getTime() + 5 * 60000);
  assert.equal((await scanner.tick()).reason, 'waiting for schedule');
  // Next morning (Sat Oct 31, 10am): only that day's share
  clock = new Date('2026-10-31T15:00:00Z');
  let ran = 0;
  for (let i = 0; i < 20; i++) {
    clock = new Date(clock.getTime() + 60000);
    if ((await scanner.tick()).ran) ran += 1;
  }
  const oct31 = monthPlan(2026, 10, 250)[30].searches;
  assert.ok(ran <= Math.ceil(oct31) && ran >= Math.floor(oct31) - 1, `ran ${ran}, share ${oct31}`);
  assert.equal(calls.length, 1 + ran);
});

test('stops when SerpApi reports no searches left', async () => {
  const { scanner, calls } = makeScanner({
    started: '2026-10-15T12:00:00Z', searchesLeft: 0,
    now: () => new Date('2026-11-04T16:00:00Z'), fetchResults: () => ({ organic_results: [] }),
  });
  assert.equal((await scanner.tick()).reason, 'SerpApi plan has no searches left');
  assert.equal(calls.length, 0);
});

test('a settings change triggers one test search, then the schedule resumes', async () => {
  let departments = ['Home', 'Toys'];
  const db = new StoreScanDb(new PriceTracker().db);
  db.setMeta('startedAt', Date.parse('2026-10-15T12:00:00Z'));
  const calls = [];
  const scanner = new StoreScanner({
    client: { walmartSearch: async (q) => { calls.push(q); return { organic_results: [{ us_item_id: '1', seller_name: 'Walmart.com' }, { us_item_id: '2', seller_name: 'Rug Co', sponsored: true }] }; }, account: async () => ({ plan_searches_left: 200 }) },
    db,
    now: () => new Date('2026-11-01T11:00:00Z'), // 5am: nothing scheduled yet
    loadConfig: () => ({ config: { stores: [{ id: '573' }], departments, filters: ['special_offers:Clearance'], searchTerms: [''], monthlySearchBudget: 250 }, errors: [] }),
    departments: async () => [{ id: '4044', name: 'Home' }, { id: '4171', name: 'Toys' }],
  });
  assert.equal((await scanner.tick()).ran, true, 'first start');
  assert.equal((await scanner.tick()).reason, 'waiting for schedule');
  departments = ['Home'];
  assert.equal((await scanner.tick()).ran, true, 'settings changed');
  assert.equal((await scanner.tick()).reason, 'waiting for schedule');
  assert.equal(calls.length, 2);
  const summary = db.getMeta('lastRunSummary');
  assert.equal(summary.soldByWalmart, 1);
  assert.equal(summary.sponsored, 1);
});

test('samplePrices returns the latest price per store and item', () => {
  const db = new StoreScanDb(new PriceTracker().db);
  const run = (ranAt, price) => db.recordRun({
    retailer: 'walmart', storeId: '573', department: 'Home', term: '', month: '2026-11', ranAt,
    results: [{ itemId: '1', title: 'Lamp', price, wasPrice: null, inStock: true, seller: 'Walmart.com' }],
  });
  run(Date.parse('2026-11-04T15:00:00Z'), 10);
  run(Date.parse('2026-11-05T15:00:00Z'), 8);
  const rows = db.samplePrices('walmart', 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 8);
  assert.equal(rows[0].date, '2026-11-05');
});

test('a full sweep runs every job once, then the schedule resumes', async () => {
  const db = new StoreScanDb(new PriceTracker().db);
  db.setMeta('startedAt', Date.parse('2026-10-15T12:00:00Z'));
  const calls = [];
  let sweepValue = '2026-10-30';
  let clock = new Date('2026-11-01T11:00:00Z'); // 5am: the schedule alone would wait
  const config = () => ({
    stores: [{ id: '573' }, { id: '4590' }], departments: ['Home', 'Toys'], filters: ['special_offers:Clearance'],
    searchTerms: [''], monthlySearchBudget: 250, fullSweep: sweepValue,
  });
  const scanner = new StoreScanner({
    client: {
      walmartSearch: async (q) => { calls.push(`${q.storeId}|${q.categoryId}`); return { organic_results: [{ us_item_id: `${q.storeId}-${q.categoryId}`, seller_name: 'Walmart.com', primary_offer: { offer_price: 5 } }] }; },
      account: async () => ({ plan_searches_left: 100 }),
    },
    db, sweepPauseMs: 0,
    now: () => clock,
    loadConfig: () => ({ config: config(), errors: [] }),
    departments: async () => [{ id: '4044', name: 'Home' }, { id: '4171', name: 'Toys' }],
    onlinePrices: async (ids) => new Map(ids.map((id) => [id, { price: 8 }])),
  });
  const result = await scanner.tick();
  assert.equal(result.finished, true);
  assert.equal(result.done, 4);
  assert.deepEqual(calls.sort(), ['4590|4044', '4590|4171', '573|4044', '573|4171']);
  assert.equal(db.latestPrices('walmart', ['573'], { itemId: '573-4044', now: Date.parse('2026-11-01T12:00:00Z') })[0].online_price, 8);
  assert.equal((await scanner.tick()).reason, 'waiting for schedule', 'sweep done; back to the schedule');
  sweepValue = '2026-11-01';
  clock = new Date('2026-11-01T11:30:00Z');
  assert.equal((await scanner.tick()).done, 4, 'a new value sweeps again');
});

test('online sellers are backfilled for items scanned before they were tracked', async () => {
  const db = new StoreScanDb(new PriceTracker().db);
  db.recordRun({ retailer: 'walmart', storeId: '573', department: 'Toys', term: '', month: '2026-10', ranAt: Date.now(),
    results: [{ itemId: '1', price: 1, seller: 'Walmart.com' }, { itemId: '2', price: 2, seller: 'Walmart.com' }] });
  const scanner = new StoreScanner({
    client: {}, db, loadConfig: () => ({ config: null, errors: [] }), departments: async () => [],
    onlinePrices: async () => new Map([['1', { price: 5, seller: 'JNR Sales' }]]),
  });
  assert.equal(await scanner.backfillOnlineSellers(), 2);
  assert.deepEqual(db.itemsMissingOnlineSeller('walmart'), []);
  const rows = db.latestPrices('walmart', ['573']).sort((a, b) => a.item_id.localeCompare(b.item_id));
  assert.equal(rows[0].online_seller, 'JNR Sales');
  assert.equal(rows[0].online_price, 5);
  assert.equal(rows[1].online_seller, '(not sold online)');
});
