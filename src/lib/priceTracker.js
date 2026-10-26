// Records prices the app observes so retailers without a history API still
// get a chart over time. Persisted to a JSON file when a path is given.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class PriceTracker {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.data = {};
    if (filePath) {
      try {
        this.data = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        this.data = {};
      }
    }
  }

  record(retailer, productId, price, date = new Date()) {
    if (typeof price !== 'number') return;
    const key = `${retailer}:${productId}`;
    const day = date.toISOString().slice(0, 10);
    const series = (this.data[key] ??= []);
    const last = series[series.length - 1];
    if (last?.date === day) last.price = price;
    else series.push({ date: day, price });
    if (series.length > 365) series.shift();
    this.save();
  }

  history(retailer, productId) {
    return this.data[`${retailer}:${productId}`] ?? [];
  }

  save() {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data));
    } catch (err) {
      console.warn('price tracker: could not persist', err.message);
    }
  }
}
