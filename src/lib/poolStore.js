// Saves a retailer's deal pool (its product list) in SQLite, so a restart can
// use the last download right away instead of fetching everything again.

export class PoolStore {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS saved_pools (
        retailer   TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL, -- epoch ms of the download
        data       TEXT NOT NULL     -- JSON: { products, feedIds, stats }
      );
    `);
  }

  save(retailer, { products, feedIds, stats, fetchedAt }) {
    this.db.prepare(`INSERT INTO saved_pools (retailer, fetched_at, data) VALUES (?, ?, ?)
      ON CONFLICT (retailer) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`)
      .run(retailer, fetchedAt, JSON.stringify({ products, feedIds, stats }));
  }

  /** @returns {{ products, byId, feedIds, stats, fetchedAt } | null} */
  load(retailer) {
    const row = this.db.prepare('SELECT fetched_at, data FROM saved_pools WHERE retailer = ?').get(retailer);
    if (!row) return null;
    const { products, feedIds, stats } = JSON.parse(row.data);
    return { products, byId: new Map(products.map((p) => [p.id, p])), feedIds, stats, fetchedAt: row.fetched_at };
  }
}
