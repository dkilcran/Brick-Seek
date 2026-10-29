// Records prices the app observes so retailers without a history API still
// get a chart over time, plus "price drops" and "lowest ever" deals.
// Stored in SQLite (built into Node 22.13+): one row per product per day.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const RETENTION_DAYS = 365;

export class PriceTracker {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath] SQLite file; ':memory:' (default) keeps nothing across restarts
   * @param {string} [opts.legacyJsonPath] old JSON history file to import once, then renamed to *.imported
   */
  constructor({ dbPath = ':memory:', legacyJsonPath = null } = {}) {
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
    if (legacyJsonPath) this.importLegacyJson(legacyJsonPath);
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

  // History used to live in a JSON file: { "walmart:123": [{ date, price }] }.
  importLegacyJson(path) {
    if (!existsSync(path)) return;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      this.transaction(() => {
        for (const [key, series] of Object.entries(data)) {
          const [retailer, ...rest] = key.split(':');
          for (const { date, price } of series) this.upsert.run(retailer, rest.join(':'), date, price);
        }
      });
      renameSync(path, `${path}.imported`);
      console.log(`price tracker: imported ${Object.keys(data).length} products from ${path}`);
    } catch (err) {
      console.warn('price tracker: could not import', path, err.message);
    }
  }

  close() {
    this.db.close();
  }
}
