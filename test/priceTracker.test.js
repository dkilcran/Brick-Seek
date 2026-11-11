import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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

test('persists to disk and prunes rows older than a year', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'tracker-')), 'db', 'prices.db');
  const a = new PriceTracker({ dbPath });
  a.record('walmart', '42', 30, new Date('2025-01-01T12:00:00Z'));
  a.record('walmart', '42', 25, new Date('2026-10-01T12:00:00Z'));
  a.record('walmart', '42', 20, day(29));
  a.prune(day(29));
  a.close();

  const b = new PriceTracker({ dbPath });
  assert.deepEqual(b.history('walmart', '42').map((p) => p.price), [25, 20]);
  b.close();
});
