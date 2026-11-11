// Settings for the store checks, read from config/store-scan.json (or
// SCAN_CONFIG_PATH). Edited by hand, so everything is validated and problems
// are reported rather than crashing the server. See config/README.md.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClock } from './scanSchedule.js';

export const DEFAULT_SCAN_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'store-scan.json');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FILTER = /^[a-z_]+:.+$/; // e.g. "special_offers:Clearance"

/**
 * @returns {{ config: object|null, errors: string[] }}
 */
export function loadScanConfig(path = DEFAULT_SCAN_CONFIG_PATH) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { config: null, errors: [`Could not read ${path}: ${err.message}`] };
  }
  const errors = [];
  const strings = (value) => (Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : []);

  const stores = Array.isArray(raw.stores) ? raw.stores : [];
  if (!stores.length) errors.push('"stores" needs at least one store');
  for (const s of stores) {
    if (!/^\d+$/.test(String(s?.id ?? ''))) errors.push(`Store id ${JSON.stringify(s?.id)} should be a Walmart store number like "573"`);
  }
  const storeIds = new Set(stores.map((s) => String(s?.id)));
  const dailyStores = strings(raw.dailyStores);
  for (const id of dailyStores) if (!storeIds.has(id)) errors.push(`dailyStores: ${id} isn't in "stores"`);
  const rotatingStoresPerDay = raw.rotatingStoresPerDay == null ? 1 : Number(raw.rotatingStoresPerDay);
  if (!(Number.isInteger(rotatingStoresPerDay) && rotatingStoresPerDay >= 0)) errors.push('"rotatingStoresPerDay" should be a whole number, 0 or more');

  const departments = [...new Set(strings(raw.departments))];
  if (!departments.length) errors.push('"departments" needs at least one department');

  const schedule = {
    productListAt: raw.schedule?.productListAt ?? '04:00',
    storeChecksAt: raw.schedule?.storeChecksAt ?? '05:00',
    endAt: raw.schedule?.endAt ?? '20:00',
    tier3RebuildDay: raw.schedule?.tier3RebuildDay ?? 'Monday',
  };
  const hours = {};
  for (const [key, name, fallback] of [['productListAt', 'productListHour', 4], ['storeChecksAt', 'storeChecksHour', 5], ['endAt', 'endHour', 20]]) {
    const hour = parseClock(schedule[key], null);
    if (hour === null) errors.push(`"schedule.${key}" should be a time like "${String(fallback).padStart(2, '0')}:00"`);
    hours[name] = hour ?? fallback;
  }
  if (!WEEKDAYS.includes(schedule.tier3RebuildDay)) {
    errors.push('"schedule.tier3RebuildDay" should be a weekday like "Monday"');
    schedule.tier3RebuildDay = 'Monday';
  }

  const baseFilters = Array.isArray(raw.baseFilters) ? strings(raw.baseFilters) : ['retailer_type:Walmart', 'fulfillment_method:In-store'];
  const tierFilters = {
    1: strings(raw.tiers?.['1'] ?? ['special_offers:Clearance']),
    2: strings(raw.tiers?.['2'] ?? ['special_offers:Rollback', 'special_offers:Reduced Price']),
  };
  for (const f of [...baseFilters, ...tierFilters[1], ...tierFilters[2]]) {
    if (!FILTER.test(f)) errors.push(`Filter ${JSON.stringify(f)} should look like "special_offers:Clearance"`);
  }
  const markdownPercent = raw.markdownPercent == null ? 10 : Number(raw.markdownPercent);
  if (!(markdownPercent > 0 && markdownPercent < 100)) errors.push('"markdownPercent" should be a number between 0 and 100, like 10');

  return {
    config: {
      zips: strings(raw.zips),
      stores: stores.map((s) => ({ id: String(s.id), label: s.label ?? null })),
      dailyStores,
      rotatingStoresPerDay: Number.isInteger(rotatingStoresPerDay) && rotatingStoresPerDay >= 0 ? rotatingStoresPerDay : 1,
      departments,
      // Search words per department (Walmart's search needs text); default: the department name.
      departmentQueries: raw.departmentQueries && typeof raw.departmentQueries === 'object' ? raw.departmentQueries : {},
      schedule: { ...schedule, ...hours },
      baseFilters,
      tierFilters,
      dealFeeds: raw.dealFeeds !== false,
      tier3Subcategories: raw.tier3Subcategories !== false,
      markdownGap: markdownPercent > 0 && markdownPercent < 100 ? markdownPercent / 100 : 0.1,
      // Change this value to restart today's store checks with the current settings.
      restartChecks: raw.restartChecks ? String(raw.restartChecks) : null,
    },
    errors,
  };
}

/**
 * The settings checked against the departments the retailer actually has.
 * @param {string[]} available department names from the retailer's taxonomy
 */
export function describeScanConfig({ config, errors }, available = []) {
  if (!config) return { ok: false, errors };
  const known = new Set(available);
  const unknownDepartments = available.length ? config.departments.filter((d) => !known.has(d)) : [];
  return { ok: errors.length === 0 && unknownDepartments.length === 0, errors, unknownDepartments, config, availableDepartments: available };
}
