import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeScanConfig, loadScanConfig } from '../src/lib/scanConfig.js';

const write = (obj) => {
  const path = join(mkdtempSync(join(tmpdir(), 'scan-')), 'store-scan.json');
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return path;
};

test('the shipped settings file is valid', () => {
  const loaded = loadScanConfig();
  assert.deepEqual(loaded.errors, []);
  const { config } = loaded;
  assert.equal(config.stores.length, 23);
  assert.deepEqual(config.dailyStores, ['573', '4590', '1599']);
  assert.ok(config.departments.includes('Home'));
  assert.deepEqual([config.schedule.productListHour, config.schedule.storeChecksHour, config.schedule.endHour], [4, 5, 20]);
  assert.deepEqual([config.dealFeeds, config.tier3Subcategories, config.markdownGap], [true, true, 0.1]);
});

test('defaults, and misspelled departments are flagged', () => {
  const loaded = loadScanConfig(write({ stores: [{ id: '573' }, { id: '4590' }], departments: ['Home', 'Toys', 'Toyz', 'Home'], dealFeeds: false }));
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.config.baseFilters, ['retailer_type:Walmart', 'fulfillment_method:In-store']);
  assert.deepEqual(loaded.config.tierFilters[2], ['special_offers:Rollback', 'special_offers:Reduced Price']);
  assert.equal(loaded.config.schedule.tier3RebuildDay, 'Monday');
  assert.equal(loaded.config.dealFeeds, false);
  const d = describeScanConfig(loaded, ['Home', 'Toys', 'Baby']);
  assert.deepEqual(d.config.departments, ['Home', 'Toys', 'Toyz'], 'duplicates removed');
  assert.deepEqual(d.unknownDepartments, ['Toyz']);
  assert.equal(d.ok, false);
});

test('bad settings are reported, not thrown', () => {
  assert.match(loadScanConfig(write('{ not json')).errors[0], /Could not read/);
  const { config, errors } = loadScanConfig(write({
    stores: [{ id: 'Lee\'s Summit' }], departments: [], dailyStores: ['9'], schedule: { endAt: '8pm', tier3RebuildDay: 'Mon' },
    tiers: { 1: ['Clearance'] }, markdownPercent: 0,
  }));
  assert.equal(errors.length, 7, errors.join('; '));
  assert.deepEqual([config.schedule.endHour, config.schedule.tier3RebuildDay, config.markdownGap], [20, 'Monday', 0.1], 'falls back to the defaults');
});
