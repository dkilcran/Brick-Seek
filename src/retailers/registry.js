// Central list of retailers. To add one: implement a RetailerAdapter subclass
// under src/retailers/<name>/ and register it in createDefaultRegistry().
import { PriceTracker } from '../lib/priceTracker.js';
import { WalmartAdapter } from './walmart/index.js';

export class RetailerRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(adapter) {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Retailer "${adapter.id}" is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id) {
    return this.adapters.get(String(id).toLowerCase()) ?? null;
  }

  list() {
    return [...this.adapters.values()];
  }
}

/** One price history database shared by every retailer. */
export function createPriceTracker(env = process.env) {
  return new PriceTracker({
    dbPath: env.DATABASE_PATH || 'data/clearance-tracker.db',
    legacyJsonPath: env.PRICE_HISTORY_FILE || 'data/price-history.json',
  });
}

export function createDefaultRegistry(env = process.env, { tracker = createPriceTracker(env) } = {}) {
  const registry = new RetailerRegistry().register(WalmartAdapter.fromEnv(env, { tracker }));
  registry.tracker = tracker;
  return registry;
}
