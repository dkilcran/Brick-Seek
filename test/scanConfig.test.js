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
  assert.deepEqual(loaded.config.stores.map((s) => s.id), ['573', '4590']);
  assert.ok(loaded.config.departments.includes('Home'));
});

test('describes scan frequency and flags misspelled departments', () => {
  const path = write({
    stores: [{ id: '573' }, { id: '4590' }],
    departments: ['Home', 'Toys', 'Toyz', 'Home'],
    searchTerms: ['clearance'],
    monthlySearchBudget: 100,
  });
  const d = describeScanConfig(loadScanConfig(path), ['Home', 'Toys', 'Baby']);
  assert.deepEqual(d.config.departments, ['Home', 'Toys', 'Toyz'], 'duplicates removed');
  assert.deepEqual(d.unknownDepartments, ['Toyz']);
  assert.equal(d.ok, false);
  assert.equal(d.searchesPerSweep, 6);
  assert.equal(d.daysBetweenScans, 1.8); // 100 / 6 sweeps a month
});

test('bad settings are reported, not thrown', () => {
  assert.match(loadScanConfig(write('{ not json')).errors[0], /Could not read/);
  const { errors } = loadScanConfig(write({ stores: [{ id: 'Lee\'s Summit' }], departments: [], monthlySearchBudget: 0 }));
  assert.equal(errors.length, 4); // bad store id, no departments, no budget, no filters or terms
});
