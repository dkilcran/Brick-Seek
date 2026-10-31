// Settings for the local store scan, read from config/store-scan.json (or
// SCAN_CONFIG_PATH). Edited by hand, so everything is validated and problems
// are reported rather than crashing the server.
import { readFileSync } from 'node:fs';
import { parseClock } from './scanSchedule.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SCAN_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'store-scan.json');

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
  const stores = Array.isArray(raw.stores) ? raw.stores : [];
  if (!stores.length) errors.push('"stores" needs at least one store');
  for (const s of stores) {
    if (!/^\d+$/.test(String(s?.id ?? ''))) errors.push(`Store id ${JSON.stringify(s?.id)} should be a Walmart store number like "573"`);
  }
  const departments = Array.isArray(raw.departments) ? raw.departments.map((d) => String(d).trim()).filter(Boolean) : [];
  if (!departments.length) errors.push('"departments" needs at least one department');
  // Walmart search filters (facets), e.g. "special_offers:Clearance", "retailer_type:Walmart".
  const filters = Array.isArray(raw.filters) ? raw.filters.map((f) => String(f).trim()).filter(Boolean) : [];
  for (const f of filters) if (!/^[a-z_]+:.+$/.test(f)) errors.push(`Filter ${JSON.stringify(f)} should look like "special_offers:Clearance"`);
  // Optional keywords; with none, each department is searched by its filters alone.
  const terms = Array.isArray(raw.searchTerms) ? raw.searchTerms.map((t) => String(t).trim()).filter(Boolean) : [];
  const searchTerms = terms.length ? terms : [''];
  if (!terms.length && !filters.length) errors.push('Set "filters" or "searchTerms" (or both)');
  const storeIds = new Set(stores.map((s) => String(s?.id)));
  // SerpApi searches only these stores (discovery); the free item lookup checks every store.
  const discoveryStores = Array.isArray(raw.discoveryStores) && raw.discoveryStores.length
    ? raw.discoveryStores.map(String)
    : [...storeIds];
  for (const id of discoveryStores) if (!storeIds.has(id)) errors.push(`discoveryStores: ${id} isn't in "stores"`);
  // Full daily checks: these stores every day, plus this many others in rotation.
  const dailyStores = Array.isArray(raw.dailyStores) ? raw.dailyStores.map(String) : [];
  for (const id of dailyStores) if (!storeIds.has(id)) errors.push(`dailyStores: ${id} isn't in "stores"`);
  const rotatingStoresPerDay = raw.rotatingStoresPerDay == null ? 1 : Number(raw.rotatingStoresPerDay);
  if (!(Number.isInteger(rotatingStoresPerDay) && rotatingStoresPerDay >= 0)) errors.push('"rotatingStoresPerDay" should be a whole number, 0 or more');
  // Daily times (Chicago): product list refresh, then the store checks.
  const schedule = {
    productListAt: raw.schedule?.productListAt ?? '04:00',
    storeChecksAt: raw.schedule?.storeChecksAt ?? '05:00',
  };
  const productListHour = parseClock(schedule.productListAt, null);
  const storeChecksHour = parseClock(schedule.storeChecksAt, null);
  if (productListHour === null) errors.push('"schedule.productListAt" should be a time like "04:00"');
  if (storeChecksHour === null) errors.push('"schedule.storeChecksAt" should be a time like "05:00"');
  const discoveryMaxPages = raw.discoveryMaxPages == null ? 20 : Number(raw.discoveryMaxPages);
  if (!(Number.isInteger(discoveryMaxPages) && discoveryMaxPages >= 0)) errors.push('"discoveryMaxPages" should be a whole number, 0 or more');
  const maxPages = raw.maxPages == null ? 1 : Number(raw.maxPages);
  if (!(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 25)) errors.push('"maxPages" should be a whole number from 1 to 25');
  const monthlySearchBudget = Number(raw.monthlySearchBudget);
  if (!(monthlySearchBudget > 0)) errors.push('"monthlySearchBudget" should be a positive number');

  return {
    config: {
      zip: raw.zip ?? null,
      zips: Array.isArray(raw.zips) ? raw.zips.map(String) : raw.zip ? [String(raw.zip)] : [],
      stores: stores.map((s) => ({ id: String(s.id), label: s.label ?? null })),
      discoveryStores,
      schedule: { ...schedule, productListHour: productListHour ?? 4, storeChecksHour: storeChecksHour ?? 5 },
      discoveryMaxPages: Number.isInteger(discoveryMaxPages) && discoveryMaxPages >= 0 ? discoveryMaxPages : 20,
      // SerpApi store searches (paid); off now that Walmart's free search does discovery.
      useSerpApi: raw.useSerpApi === true,
      dailyStores,
      rotatingStoresPerDay: Number.isInteger(rotatingStoresPerDay) && rotatingStoresPerDay >= 0 ? rotatingStoresPerDay : 1,
      maxPages: Number.isInteger(maxPages) ? maxPages : 1,
      departments: [...new Set(departments)],
      filters,
      searchTerms,
      monthlySearchBudget: monthlySearchBudget > 0 ? Math.floor(monthlySearchBudget) : 0,
      // Change this value (e.g. to today's date) to scan everything once, right away.
      fullSweep: raw.fullSweep ? String(raw.fullSweep) : null,
      // Change this value to restart today's free store checks with the current plan.
      restartChecks: raw.restartChecks ? String(raw.restartChecks) : null,
      // Diagnostics: { run, items: [itemIds], stores: [storeIds], searchDepartment }; change run to repeat.
      inspect: raw.inspect?.run ? {
        run: String(raw.inspect.run),
        items: (raw.inspect.items ?? []).map(String).slice(0, 10),
        stores: (raw.inspect.stores ?? []).map(String).slice(0, 2),
        searchDepartment: raw.inspect.searchDepartment ?? null,
      } : null,
    },
    errors,
  };
}

/**
 * Check the config against the departments the retailer actually has, and
 * work out how often the budget lets each department be scanned.
 * @param {string[]} available department names from the retailer's taxonomy
 */
export function describeScanConfig({ config, errors }, available = []) {
  if (!config) return { ok: false, errors };
  const known = new Set(available);
  const unknownDepartments = available.length ? config.departments.filter((d) => !known.has(d)) : [];
  const searchesPerSweep = config.discoveryStores.length * config.departments.length * config.searchTerms.length * config.maxPages;
  const sweepsPerMonth = searchesPerSweep ? config.monthlySearchBudget / searchesPerSweep : 0;
  return {
    ok: errors.length === 0 && unknownDepartments.length === 0,
    errors,
    unknownDepartments,
    config,
    searchesPerSweep,
    // e.g. 100 searches / 40 per sweep -> every department at every store about every 12 days
    daysBetweenScans: sweepsPerMonth ? Math.round((30 / sweepsPerMonth) * 10) / 10 : null,
    availableDepartments: available,
  };
}
