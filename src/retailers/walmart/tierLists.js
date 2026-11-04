// Lists of items Walmart sells in stores, built from Walmart's free search:
//   tier 1: Clearance            (rebuilt daily)
//   tier 2: Rollback, Reduced Price (rebuilt daily)
//   tier 3: everything            (rebuilt weekly)
// Each search returns at most 1,000 results (25 per page), so a search with
// more is split into price bands, then $1 bands, then a $1 band is read
// sorted low-to-high and high-to-low. The work is a queue of single-page
// search jobs saved in SQLite, so a restart resumes where it left off.

export const PAGE = 25;
export const CAP = 1000; // Walmart: "Start should be less than 1000"
const FIRST_BANDS = [[0, 5], [5, 10], [10, 20], [20, 50], [50, 100], [100, 200], [200, 500], [500, 100000]];

/** 'rollback' or 'reduced' from a job's special_offers filter (null for other filters). */
function offerOf(filters) {
  const f = filters.find((x) => x.startsWith('special_offers:'));
  if (!f) return null;
  const name = f.slice('special_offers:'.length).toLowerCase();
  return name === 'rollback' ? 'rollback' : name === 'reduced price' ? 'reduced' : null;
}

export class TierStore {
  /** @param {import('./storeScan.js').StoreScanDb} store  shares its database and meta table */
  constructor(store, retailer = 'walmart') {
    this.store = store;
    this.db = store.db;
    this.retailer = retailer;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS search_queue (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        retailer   TEXT NOT NULL,
        run        TEXT NOT NULL,
        tier       INTEGER NOT NULL,
        department TEXT NOT NULL,
        query      TEXT NOT NULL,
        filters    TEXT NOT NULL,   -- JSON array of facet.filter values
        lo         INTEGER,         -- price band, null = no band
        hi         INTEGER,
        sort       TEXT,            -- null, 'ascending' or 'descending' (price)
        start      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS search_queue_by_run ON search_queue (retailer, run, id);
      CREATE TABLE IF NOT EXISTS tier_items (
        retailer   TEXT NOT NULL,
        tier       INTEGER NOT NULL,
        run        TEXT NOT NULL,   -- the build that found it; old builds are dropped when a new one completes
        item_id    TEXT NOT NULL,
        department TEXT NOT NULL,
        PRIMARY KEY (retailer, tier, run, item_id)
      ) WITHOUT ROWID;
      -- Product details from tier 1/2 searches, for the home page deal sections.
      CREATE TABLE IF NOT EXISTS tier_products (
        retailer TEXT NOT NULL,
        item_id  TEXT NOT NULL,
        run      TEXT NOT NULL,
        data     TEXT NOT NULL,
        PRIMARY KEY (retailer, item_id)
      ) WITHOUT ROWID;
    `);
    // Which Walmart offer list found a tier 2 item: 'rollback' or 'reduced'.
    if (!this.db.prepare('PRAGMA table_info(tier_items)').all().some((c) => c.name === 'offer')) {
      this.db.exec('ALTER TABLE tier_items ADD COLUMN offer TEXT');
    }
    this.insertJob = this.db.prepare(`INSERT INTO search_queue
      (retailer, run, tier, department, query, filters, lo, hi, sort, start) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertItem = this.db.prepare(`INSERT OR IGNORE INTO tier_items (retailer, tier, run, item_id, department, offer) VALUES (?, ?, ?, ?, ?, ?)`);
    this.upsertProduct = this.db.prepare(`INSERT INTO tier_products (retailer, item_id, run, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET run = excluded.run, data = excluded.data`);
  }

  enqueue(run, job) {
    this.insertJob.run(this.retailer, run, job.tier, job.department, job.query, JSON.stringify(job.filters),
      job.lo ?? null, job.hi ?? null, job.sort ?? null, job.start ?? 1);
  }

  /**
   * Queue page-1 searches for every department query and filter set.
   * @param {{ tier: number, filterSets: string[][] }[]} tiers
   */
  startRun(run, { tiers, departments, queriesFor, baseFilters }) {
    this.db.exec('BEGIN');
    try {
      for (const { tier, filterSets } of tiers) {
        for (const department of departments) {
          for (const query of queriesFor(department)) {
            for (const set of filterSets) this.enqueue(run, { tier, department, query, filters: [...baseFilters, ...set] });
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  nextJob(run) {
    const row = this.db.prepare('SELECT * FROM search_queue WHERE retailer = ? AND run = ? ORDER BY id LIMIT 1').get(this.retailer, run);
    return row ? { ...row, filters: JSON.parse(row.filters) } : null;
  }

  queueSize(run) {
    return this.db.prepare('SELECT COUNT(*) n FROM search_queue WHERE retailer = ? AND run = ?').get(this.retailer, run).n;
  }

  dropQueue(run) {
    this.db.prepare('DELETE FROM search_queue WHERE retailer = ? AND run = ?').run(this.retailer, run);
  }

  /**
   * Run one search job: save what it found, then queue follow-ups (more
   * pages, or narrower searches when there are more than 1,000 results).
   * @param {{ searchPage }} source  WalmartLiveSource
   * @param {{ keep?: (product) => boolean }} opts  e.g. only the departments in the settings
   * @returns {Promise<{ found: number, total: number }>}
   */
  async runJob(run, job, source, { keep = () => true } = {}) {
    let result;
    try {
      result = await source.searchPage({ query: job.query, filters: job.filters, lo: job.lo, hi: job.hi, start: job.start, sort: job.sort });
    } catch (err) {
      // A bad page (or Walmart refusing a sort) skips just this job; rate limits are retried by the client.
      if (!/\b400\b/.test(err.message)) throw err;
      this.db.prepare('DELETE FROM search_queue WHERE id = ?').run(job.id);
      return { found: 0, total: 0, skipped: err.message.slice(0, 120) };
    }
    const { total } = result;
    // Searches for one department also return items from others (e.g. clothing for "seasonal").
    const products = result.products.filter(keep);
    this.db.exec('BEGIN');
    try {
      for (const p of products) {
        this.insertItem.run(this.retailer, job.tier, run, p.id, job.department, offerOf(job.filters));
        if (job.tier <= 2) this.upsertProduct.run(this.retailer, p.id, run, JSON.stringify(p));
      }
      if (job.start === 1) this.planFollowUps(run, job, total);
      this.db.prepare('DELETE FROM search_queue WHERE id = ?').run(job.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Stats by day (the run's date part), labeled by tier and department.
    this.store.recordDiscovery(this.retailer, run.slice(0, 10), `T${job.tier} ${job.department}`, Math.floor((job.start - 1) / PAGE) + 1,
      products.map((p) => ({ itemId: p.id, inPool: false })));
    return { found: products.length, total };
  }

  planFollowUps(run, job, total) {
    if (total > CAP && !job.sort) {
      if (job.lo == null) {
        for (const [lo, hi] of FIRST_BANDS) this.enqueue(run, { ...job, lo, hi, start: 1 });
        return;
      }
      if (job.hi - job.lo > 1) {
        const mid = Math.floor((job.lo + job.hi) / 2);
        this.enqueue(run, { ...job, lo: job.lo, hi: mid, start: 1 });
        this.enqueue(run, { ...job, lo: mid, hi: job.hi, start: 1 });
        return;
      }
      // A $1 band with more than 1,000: read it cheapest-first and dearest-first.
      for (const sort of ['ascending', 'descending']) this.enqueue(run, { ...job, sort, start: 1 });
      return;
    }
    // Page through what's reachable: starts 26, 51, ... while under 1,000.
    for (let start = 1 + PAGE; start < CAP && start <= total; start += PAGE) this.enqueue(run, { ...job, start });
  }

  /** The completed build for a tier (meta), and its items. */
  builtRun(tier) {
    return this.store.getMeta(`tierBuilt:${this.retailer}:${tier}`);
  }

  /** Make `run` the current list for `tier` and drop older builds. */
  markBuilt(tier, run) {
    this.store.setMeta(`tierBuilt:${this.retailer}:${tier}`, run);
    this.db.prepare('DELETE FROM tier_items WHERE retailer = ? AND tier = ? AND run <> ?').run(this.retailer, tier, run);
  }

  itemIds(tier) {
    const run = this.builtRun(tier);
    if (!run) return [];
    return this.db.prepare('SELECT item_id FROM tier_items WHERE retailer = ? AND tier = ? AND run = ?')
      .all(this.retailer, tier, run).map((r) => r.item_id);
  }

  count(tier, run = this.builtRun(tier)) {
    if (!run) return 0;
    return this.db.prepare('SELECT COUNT(*) n FROM tier_items WHERE retailer = ? AND tier = ? AND run = ?').get(this.retailer, tier, run).n;
  }

  /** The next `limit` tier-3 items after `afterId` (in item-id order), for slices that continue across days. */
  tier3Batch(afterId, limit) {
    const run = this.builtRun(3);
    if (!run || limit <= 0) return [];
    return this.db.prepare(`SELECT item_id FROM tier_items WHERE retailer = ? AND tier = 3 AND run = ? AND item_id > ?
      ORDER BY item_id LIMIT ?`).all(this.retailer, run, afterId, limit).map((r) => r.item_id);
  }

  /** One saved tier 1/2 product (Walmart-sold, from today's search), or null. */
  product(itemId) {
    const row = this.db.prepare('SELECT data FROM tier_products WHERE retailer = ? AND item_id = ?').get(this.retailer, String(itemId));
    return row ? JSON.parse(row.data) : null;
  }

  /** Products from the given tier 1/2 build, for the deal sections; older ones are dropped. */
  products(run) {
    this.db.prepare('DELETE FROM tier_products WHERE retailer = ? AND run <> ?').run(this.retailer, run);
    return this.db.prepare('SELECT data FROM tier_products WHERE retailer = ? AND run = ?').all(this.retailer, run).map((r) => JSON.parse(r.data));
  }
}
