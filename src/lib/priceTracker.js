// Records the online prices the app observes, so retailers without a history
// API still get a chart over time, plus "Price drop" and "Lowest price ever".
// Stored in SQLite (built into Node 22.13+): one row per product per day.
// The same database file holds each retailer's own tables.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const RETENTION_DAYS = 365;

export class PriceTracker {
  /** @param {{ dbPath?: string }} opts  SQLite file; ':memory:' (default) keeps nothing across restarts */
  constructor({ dbPath = ':memory:' } = {}) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS price_history (
        retailer   TEXT NOT NULL,
        product_id TEXT NOT NULL,
        date       TEXT NOT NULL, -- YYYY-MM-DD
        price      REAL NOT NULL,
        PRIMARY KEY (retailer, product_id, date)
      ) WITHOUT ROWID;
    `);
    this.upsert = this.db.prepare(`
      INSERT INTO price_history (retailer, product_id, date, price) VALUES (?, ?, ?, ?)
      ON CONFLICT (retailer, product_id, date) DO UPDATE SET price = excluded.price
    `);
    this.select = this.db.prepare(
      'SELECT date, price FROM price_history WHERE retailer = ? AND product_id = ? ORDER BY date',
    );
  }

  record(retailer, productId, price, date = new Date()) {
    this.recordMany(retailer, [{ id: productId, price }], date);
  }

  /** Record many products' prices in one transaction. */
  recordMany(retailer, products, date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    this.transaction(() => {
      for (const p of products) {
        if (typeof p.price === 'number') this.upsert.run(retailer, String(p.id), day, p.price);
      }
    });
  }

  history(retailer, productId) {
    return this.select.all(retailer, String(productId)).map((r) => ({ date: r.date, price: r.price }));
  }

  /**
   * For many products at once: days recorded, the last price before `today`
   * and the lowest price before `today` (what lib/allDeals.js signalsFrom needs).
   * @returns {Map<string, { days: number, previous: number|null, lowest: number|null }>}
   */
  summaries(retailer, productIds, today = new Date().toISOString().slice(0, 10)) {
    this.summarize ??= this.db.prepare(`
      SELECT h.product_id AS id, COUNT(*) AS days, MIN(CASE WHEN h.date < :today THEN h.price END) AS lowest,
        (SELECT p.price FROM price_history p WHERE p.retailer = :retailer AND p.product_id = h.product_id AND p.date < :today
         ORDER BY p.date DESC LIMIT 1) AS previous
      FROM json_each(:ids) j CROSS JOIN price_history h ON h.retailer = :retailer AND h.product_id = j.value
      GROUP BY h.product_id`);
    const rows = this.summarize.all({ retailer, today, ids: JSON.stringify(productIds.map(String)) });
    return new Map(rows.map((r) => [r.id, { days: r.days, previous: r.previous, lowest: r.lowest }]));
  }

  /** Drop rows older than the retention window. */
  prune(now = new Date()) {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    this.db.prepare('DELETE FROM price_history WHERE date < ?').run(cutoff);
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}
