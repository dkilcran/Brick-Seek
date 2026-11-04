import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriceTracker } from '../src/lib/priceTracker.js';
import { StoreScanDb } from '../src/retailers/walmart/storeScan.js';
import { StoreChecker } from '../src/retailers/walmart/storeChecker.js';
import { TierStore, CAP, PAGE } from '../src/retailers/walmart/tierLists.js';

/**
 * A fake Walmart search over a catalog: { [filter]: [{ id, price }] }. It
 * honors price bands and sorts, caps paging like Walmart, and logs requests.
 */
function fakeSearch(catalog) {
  const requests = [];
  return {
    requests,
    async searchPage({ query, filters, lo, hi, start, sort }) {
      requests.push({ query, filters, lo, hi, start, sort });
      if (start >= CAP) throw new Error('Walmart API 400: {"errors":[{"code":4010,"message":"Start should be less than 1000"}]}');
      const deal = filters.find((f) => f.startsWith('special_offers:')) ?? 'all';
      let items = (catalog[deal] ?? []).filter((i) => lo == null || (i.price >= lo && i.price <= hi));
      if (sort) items = [...items].sort((a, b) => (sort === 'ascending' ? a.price - b.price : b.price - a.price));
      const page = items.slice(start - 1, start - 1 + PAGE);
      return { total: items.length, products: page.map((i) => ({ id: i.id, price: i.price, name: `Item ${i.id}`, seller: { isRetailer: true } })) };
    },
  };
}

const newStores = () => {
  const db = new StoreScanDb(new PriceTracker().db);
  return { db, tiers: new TierStore(db) };
};

test('searches past 1,000 results split into price bands, then $1 bands, then sorted passes', async () => {
  const { tiers } = newStores();
  // 2,600 clearance items: 1,200 crowded into the $3-4 band, the rest spread out.
  const items = [
    ...Array.from({ length: 1200 }, (_, i) => ({ id: `c${i}`, price: 3 + (i % 99) / 100 })),
    ...Array.from({ length: 1400 }, (_, i) => ({ id: `s${i}`, price: 5 + (i % 300) / 10 })),
  ];
  const source = fakeSearch({ 'special_offers:Clearance': items });
  tiers.startRun('r', {
    tiers: [{ tier: 1, filterSets: [['special_offers:Clearance']] }],
    departments: ['Home'], queriesFor: () => ['home'], baseFilters: ['retailer_type:Walmart'],
  });
  let job;
  while ((job = tiers.nextJob('r'))) await tiers.runJob('r', job, source);
  tiers.markBuilt(1, 'r');

  assert.ok(source.requests.every((r) => r.start < CAP), 'never asks past result 1,000');
  assert.ok(source.requests.some((r) => r.lo === 0 && r.hi === 5), 'first price bands');
  assert.ok(source.requests.some((r) => r.lo === 3 && r.hi === 4 && r.sort === 'ascending'), 'a crowded $1 band is read sorted');
  assert.equal(tiers.count(1), 2600, 'every item reached');
});

test('a small search just pages through, and a refused page is skipped', async () => {
  const { tiers } = newStores();
  const items = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, price: 2 }));
  const source = fakeSearch({ 'special_offers:Clearance': items });
  const refusing = { searchPage: async (q) => (q.start === 26 ? Promise.reject(new Error('Walmart API 400: bad page')) : source.searchPage(q)) };
  tiers.startRun('r', {
    tiers: [{ tier: 1, filterSets: [['special_offers:Clearance']] }],
    departments: ['Toys'], queriesFor: () => ['toys'], baseFilters: [],
  });
  let job;
  while ((job = tiers.nextJob('r'))) await tiers.runJob('r', job, refusing);
  tiers.markBuilt(1, 'r');
  assert.equal(tiers.count(1), 35, 'pages 1 and 3 (25 + 10); page 2 skipped');
  assert.equal(tiers.queueSize('r'), 0);
});

/** A whole Monday: lists, the four check segments, the first tier 3 build, slices until 8pm. */
function makeDay({ start, catalog, config: extra = {} }) {
  const { db, tiers } = newStores();
  let clock = new Date(start);
  const lookups = [];
  const search = fakeSearch(catalog);
  const source = {
    requests: search.requests,
    async searchPage(q) {
      clock = new Date(clock.getTime() + 60000); // each search takes a minute
      return search.searchPage(q);
    },
    pool: null,
    setPool(products) { this.pool = products; },
    async storeLookup(ids, storeId) {
      lookups.push({ storeId, ids: [...ids], at: clock.toISOString() });
      clock = new Date(clock.getTime() + 60000); // each lookup takes a minute
      return {
        found: ids.map((id) => ({
          itemId: id, seller: 'Walmart.com', inStock: true,
          // x7 is cheaper at store C, x9 at store B: calculated clearance
          price: (id === 'x7' && storeId === 'C') || (id === 'x9' && storeId === 'B') ? 3 : 5,
          clearance: id.startsWith('t1'), wasPrice: id.startsWith('t2') ? 8 : null,
        })),
        missing: [],
      };
    },
  };
  const config = {
    stores: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id })),
    dailyStores: ['A', 'B'], rotatingStoresPerDay: 1,
    departments: ['Toys'], departmentQueries: {},
    baseFilters: ['retailer_type:Walmart'],
    tierFilters: { 1: ['special_offers:Clearance'], 2: ['special_offers:Rollback'] },
    schedule: { productListHour: 4, storeChecksHour: 5, endHour: 20, tier3RebuildDay: 'Monday' },
    ...extra,
  };
  const checker = new StoreChecker({ source, db, tiers, now: () => clock, loadConfig: () => ({ config, errors: [] }) });
  return {
    db, tiers, source, lookups, checker, config,
    advance: (ms) => { clock = new Date(clock.getTime() + ms); },
    setClock: (iso) => { clock = new Date(iso); },
    async runUntilIdle(max = 5000) { for (let i = 0; i < max && (await checker.step()); i++); },
  };
}

const CATALOG = {
  'special_offers:Clearance': [{ id: 't1a', price: 4 }, { id: 't1b', price: 6 }],
  'special_offers:Rollback': [{ id: 't2a', price: 7 }, { id: 't1a', price: 4 }],
  all: Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, price: 5 })),
};

test('a full day runs in the agreed order', async () => {
  // Monday Nov 2 2026, 4:30am Chicago (CST, UTC-6)
  const day = makeDay({ start: '2026-11-02T10:30:00Z', catalog: CATALOG });
  await day.runUntilIdle();
  // Lists are built, the deal pool set; checks wait for 5:00.
  assert.equal(day.checker.state.phase, 'checks');
  assert.deepEqual(day.tiers.itemIds(1).sort(), ['t1a', 't1b']);
  assert.deepEqual(day.tiers.itemIds(2).sort(), ['t1a', 't2a']);
  assert.equal(day.source.pool.length, 3);
  assert.equal(day.lookups.length, 0, 'no store lookups before 5:00');

  day.setClock('2026-11-02T11:00:00Z'); // 5:00am
  await day.runUntilIdle();
  const full = day.checker.state.probeStores;
  assert.equal(full.length, 3);
  assert.deepEqual(full.slice(0, 2), ['A', 'B']);
  const others = ['A', 'B', 'C', 'D', 'E'].filter((s) => !full.includes(s));
  // Segment order: tier 1, tier 2 (minus tier 1), then other stores. (No recent markdowns yet.)
  const seq = day.lookups.map((l) => `${l.storeId}:${l.ids.join(',')}`);
  const t1Calls = full.map((s) => `${s}:t1a,t1b`);
  const t2Calls = full.map((s) => `${s}:t2a`);
  assert.deepEqual(seq.slice(0, 3), t1Calls);
  assert.deepEqual(seq.slice(3, 6), t2Calls);
  assert.deepEqual(seq.slice(6, 6 + others.length).map((x) => x.split(':')[0]), others, 'clearance at the other stores');
  // Monday + no tier 3 list yet: built after checks, then slices at the daily stores only, until 8pm.
  assert.equal(day.tiers.count(3), 50);
  const tier3 = day.lookups.filter((l) => l.ids[0].startsWith('x'));
  assert.ok(tier3.length > 0 && tier3.every((l) => ['A', 'B'].includes(l.storeId)));
  assert.ok(tier3.every((l) => l.at < '2026-11-03T02:00:00Z'), 'tier 3 stops at 8pm');
  assert.equal(day.checker.state.phase, 'done');
});

test('recent markdowns from tier 3 join the next day\'s checks, and calculated clearance goes to all stores', async () => {
  const day = makeDay({ start: '2026-11-02T11:00:00Z', catalog: CATALOG });
  await day.runUntilIdle();
  // x7 was seen cheaper at C (calculated clearance) only if C was a full-check or daily store;
  // seed it directly to check tomorrow's segments.
  day.db.recordStorePrices('walmart', 'A', [{ itemId: 'x7', price: 5, seller: 'Walmart.com', clearance: false, wasPrice: 9 }], '2026-11-02');
  day.db.recordStorePrices('walmart', 'B', [{ itemId: 'x9', price: 3, seller: 'Walmart.com', clearance: false }], '2026-11-02');
  day.db.recordStorePrices('walmart', 'A', [{ itemId: 'x9', price: 5, seller: 'Walmart.com', clearance: false }], '2026-11-02');
  day.db.refreshMarkdowns('walmart', { now: Date.parse('2026-11-03T12:00:00Z') });
  assert.deepEqual(day.db.storeLevelItems('walmart').sort(), ['t1a', 't1b', 'x9'],
    'Clearance flag anywhere, or cheaper at one store than another');

  day.lookups.length = 0;
  day.setClock('2026-11-03T11:00:00Z'); // Tuesday 5:00am: new day
  await day.runUntilIdle();
  const recent = day.lookups.filter((l) => l.ids.includes('x7'));
  assert.ok(recent.length > 0, 'x7 (a markdown found through tier 3) is checked at the full-check stores');
  const otherStoreCalls = day.lookups.filter((l) => l.ids.includes('x9') && !day.checker.state.probeStores.includes(l.storeId));
  assert.ok(otherStoreCalls.length > 0, 'calculated clearance (x9) is checked at the other stores');
});

test('tiers 1 and 2 always finish, even past 8pm; tier 3 waits for tomorrow', async () => {
  const day = makeDay({ start: '2026-11-03T01:58:00Z', catalog: CATALOG }); // Monday 7:58pm
  await day.runUntilIdle();
  assert.equal(day.checker.state.phase, 'done');
  assert.ok(day.checker.state.checksDoneAt > '2026-11-03T02:00:00Z', 'checks ran past 8pm');
  assert.ok(day.lookups.every((l) => !l.ids[0].startsWith('x')), 'no tier 3 slices after 8pm');
  assert.ok(day.db.getMeta('tier3:building:walmart'), 'the tier 3 build waits');
});

test('the tier 3 rebuild starts on its weekday and continues the next day if unfinished', async () => {
  // Monday 7:52pm: lists and checks run past 8pm, so the rebuild is queued but has to wait.
  const day = makeDay({ start: '2026-11-03T01:52:00Z', catalog: CATALOG });
  await day.runUntilIdle();
  assert.equal(day.db.getMeta('tier3:building:walmart'), '2026-11-02:t3', 'Monday\'s rebuild started');
  assert.equal(day.tiers.builtRun(3), null, 'not finished by 8pm');
  // Tuesday: after its own lists and checks, Monday's rebuild finishes, then slices start.
  day.setClock('2026-11-03T11:00:00Z');
  await day.runUntilIdle();
  assert.equal(day.tiers.builtRun(3), '2026-11-02:t3');
  assert.equal(day.db.getMeta('tier3:building:walmart'), null);
  assert.ok(day.lookups.some((l) => l.ids[0].startsWith('x')), 'tier 3 slices ran on Tuesday');
  // Not rebuilt again on Tuesday: Monday is the rebuild day.
  assert.equal(day.db.getMeta('tier3:lastStarted:walmart'), '2026-11-02');
});

test('restartChecks starts today over once', async () => {
  const day = makeDay({ start: '2026-11-04T11:00:00Z', catalog: CATALOG });
  await day.runUntilIdle();
  const firstLookups = day.lookups.length;
  day.config.restartChecks = 'again';
  day.setClock('2026-11-04T15:00:00Z');
  await day.runUntilIdle();
  assert.ok(day.lookups.length > firstLookups, 'ran again');
  const after = day.lookups.length;
  day.advance(60000);
  await day.runUntilIdle();
  assert.ok(day.lookups.length - after < 50, 'not restarted again (only tier 3 slices may continue)');
});

test('only the settings\' departments: searches drop other departments, and checks skip items known to be in them', async () => {
  const catalog = {
    'special_offers:Clearance': [{ id: 't1a', price: 4 }, { id: 't1shirt', price: 3 }],
    'special_offers:Rollback': [],
    all: Array.from({ length: 30 }, (_, i) => ({ id: `x${String(i).padStart(2, '0')}`, price: 5 })),
  };
  const day = makeDay({ start: '2026-11-02T11:00:00Z', catalog });
  const search = day.source.searchPage.bind(day.source);
  day.source.searchPage = async (q) => {
    const r = await search(q);
    return { ...r, products: r.products.map((p) => ({ ...p, category: p.id === 't1shirt' ? 'Clothing' : 'Toys' })) };
  };
  // x00..x04 were seen before in Clothing.
  for (let i = 0; i < 5; i++) day.db.upsertItem.run('walmart', `x0${i}`, 'Shirt', null, 'Clothing');
  await day.runUntilIdle();
  assert.deepEqual(day.tiers.itemIds(1), ['t1a'], 'the Clothing find is left out of the list');
  const tier3 = day.lookups.filter((l) => l.ids[0].startsWith('x'));
  assert.ok(tier3.length > 0);
  for (const l of tier3) {
    assert.ok(l.ids.every((id) => !['x00', 'x01', 'x02', 'x03', 'x04'].includes(id)), 'known Clothing items are skipped');
    assert.equal(new Set(l.ids).size, l.ids.length);
  }
  assert.ok(tier3.some((l) => l.ids.length === 20), 'batches stay full');
});

test('tier 3 batches wrap around at the end of the list without repeating within a batch', () => {
  const { db, tiers } = newStores();
  for (let i = 0; i < 30; i++) tiers.insertItem.run('walmart', 3, 'r', `x${String(i).padStart(2, '0')}`, 'Toys');
  tiers.markBuilt(3, 'r');
  db.upsertItem.run('walmart', 'x01', 'Shirt', null, 'Clothing');
  const checker = new StoreChecker({ source: {}, db, tiers, loadConfig: () => ({ config: null, errors: [] }) });
  const config = { departments: ['Toys'] };
  const first = checker.tier3Ids('', config);
  assert.equal(first.length, 20);
  assert.ok(!first.includes('x01'));
  const second = checker.tier3Ids(first.at(-1), config);
  assert.deepEqual(second.slice(0, 9), Array.from({ length: 9 }, (_, i) => `x${21 + i}`));
  assert.ok(second.length <= 20 && new Set(second).size === second.length);
  assert.ok(second.slice(9).every((id) => id < first.at(-1)), 'after the end it starts over from the top');
});
