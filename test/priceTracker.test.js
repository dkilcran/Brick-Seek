import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PriceTracker } from '../src/lib/priceTracker.js';

const day = (d) => new Date(`2026-10-${d}T12:00:00Z`);

test('records one price per product per day, latest wins', () => {
  const t = new PriceTracker();
  t.recordMany('walmart', [{ id: '1', price: 10 }, { id: '2', price: 5 }, { id: '3', price: null }], day(27));
  t.record('walmart', '1', 9, day(28));
  t.record('walmart', '1', 8, day(28));
  assert.deepEqual(t.history('walmart', '1'), [
    { date: '2026-10-27', price: 10 },
    { date: '2026-10-28', price: 8 },
  ]);
  assert.deepEqual(t.history('walmart', '3'), []);
  assert.deepEqual(t.history('target', '1'), []);
});

test('persists to disk, imports legacy JSON once, and prunes old rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-'));
  const dbPath = join(dir, 'db', 'prices.db');
  const legacy = join(dir, 'price-history.json');
  writeFileSync(legacy, JSON.stringify({ 'walmart:42': [{ date: '2025-01-01', price: 30 }, { date: '2026-10-01', price: 25 }] }));

  const a = new PriceTracker({ dbPath, legacyJsonPath: legacy });
  assert.equal(a.history('walmart', '42').length, 2);
  assert.ok(!existsSync(legacy) && existsSync(`${legacy}.imported`));
  a.record('walmart', '42', 20, day(29));
  a.prune(day(29));
  a.close();

  const b = new PriceTracker({ dbPath, legacyJsonPath: legacy });
  assert.deepEqual(b.history('walmart', '42').map((p) => p.price), [25, 20]);
  b.close();
});
