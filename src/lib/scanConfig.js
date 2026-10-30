// Settings for the local store scan, read from config/store-scan.json (or
// SCAN_CONFIG_PATH). Edited by hand, so everything is validated and problems
// are reported rather than crashing the server.
import { readFileSync } from 'node:fs';
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
  const monthlySearchBudget = Number(raw.monthlySearchBudget);
  if (!(monthlySearchBudget > 0)) errors.push('"monthlySearchBudget" should be a positive number');

  return {
    config: {
      zip: raw.zip ?? null,
      stores: stores.map((s) => ({ id: String(s.id), label: s.label ?? null })),
      departments: [...new Set(departments)],
      filters,
      searchTerms,
      monthlySearchBudget: monthlySearchBudget > 0 ? Math.floor(monthlySearchBudget) : 0,
      // Change this value (e.g. to today's date) to scan everything once, right away.
      fullSweep: raw.fullSweep ? String(raw.fullSweep) : null,
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
  const searchesPerSweep = config.stores.length * config.departments.length * config.searchTerms.length;
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
