// Minimal in-memory TTL cache used to avoid hammering upstream retailer APIs.
export class TtlCache {
  constructor({ ttlMs = 5 * 60 * 1000, maxEntries = 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  async wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, await fn(), ttlMs);
  }
}
