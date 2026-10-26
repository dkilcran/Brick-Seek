// Central list of retailers. To add one: implement a RetailerAdapter subclass
// under src/retailers/<name>/ and register it in createDefaultRegistry().
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

export function createDefaultRegistry(env = process.env) {
  return new RetailerRegistry().register(WalmartAdapter.fromEnv(env));
}
