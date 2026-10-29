// Results of looking items up one by one at the retailer: who sells them and
// whether they still exist. Bulk feeds often leave the seller out, so these
// checks decide what can be shown. Stored in SQLite next to price history.

const DAY_MS = 86400000;

export class ItemChecks {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ maxAgeDays?: number }} opts  how long a check stays valid
   */
  constructor(db, { maxAgeDays = 7 } = {}) {
    this.db = db;
    this.maxAgeMs = maxAgeDays * DAY_MS;
    db.exec(`
      CREATE TABLE IF NOT EXISTS item_checks (
        retailer    TEXT NOT NULL,
        item_id     TEXT NOT NULL,
        seller      TEXT,             -- null when the item no longer exists
        is_retailer INTEGER NOT NULL, -- 1 = sold by the retailer itself
        item_exists INTEGER NOT NULL,
        checked_at  INTEGER NOT NULL, -- epoch ms
        PRIMARY KEY (retailer, item_id)
      ) WITHOUT ROWID;
    `);
    this.upsert = db.prepare(`
      INSERT INTO item_checks (retailer, item_id, seller, is_retailer, item_exists, checked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET
        seller = excluded.seller, is_retailer = excluded.is_retailer,
        item_exists = excluded.item_exists, checked_at = excluded.checked_at
    `);
    this.selectOne = db.prepare(
      'SELECT seller, is_retailer, item_exists, checked_at FROM item_checks WHERE retailer = ? AND item_id = ?',
    );
  }

  /** @returns {{ seller, isRetailer, exists, checkedAt } | null} a check that hasn't expired */
  get(retailer, itemId, now = Date.now()) {
    const row = this.selectOne.get(retailer, String(itemId));
    if (!row || now - row.checked_at > this.maxAgeMs) return null;
    return { seller: row.seller, isRetailer: row.is_retailer === 1, exists: row.item_exists === 1, checkedAt: row.checked_at };
  }

  /** @param {{ itemId, seller, isRetailer, exists }[]} checks */
  putMany(retailer, checks, now = Date.now()) {
    this.db.exec('BEGIN');
    try {
      for (const c of checks) {
        this.upsert.run(retailer, String(c.itemId), c.seller ?? null, c.isRetailer ? 1 : 0, c.exists ? 1 : 0, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
