// Lists of items Walmart itself sells, which the store checks then look up:
//   tier 1: Clearance               (rebuilt daily)
//   tier 2: Rollback, Reduced Price (rebuilt daily)
//   tier 3: everything in stores    (rebuilt weekly)
// Built from Walmart's search (in stores, sold by Walmart) and Walmart's feeds
// (sold by Walmart): the deal feeds for tiers 1-2; for tier 3 the store-brand
// feeds weekly and each department's newest listings nightly. A search returns at most 1,000 results (25 per page),
// so one with more is split into price bands, then $1 bands, then a $1 band
// is read sorted low-to-high and high-to-low. The work is a queue of
// single-page search jobs saved in SQLite, so a restart resumes where it left off.

export const PAGE = 25;
export const CAP = 1000; // Walmart: "Start should be less than 1000"
const FIRST_BANDS = [[0, 5], [5, 10], [10, 20], [20, 50], [50, 100], [100, 200], [200, 500], [500, 100000]];
/** Taxonomy children that are shop pages rather than product subcategories. */
const NOT_SUBCATEGORY = /^shop |shop by|featured|endeca|sweepstakes|ideas|lookbook|inspiration|manual|values|personalized|gift|deals|new arrivals|trending|savings|clearance|rollback/i;

/** 'rollback' or 'reduced' from a job's special_offers filter (null for other filters). */
function offerOf(filters) {
  const f = filters.find((x) => x.startsWith('special_offers:'));
  if (!f) return null;
  const name = f.slice('special_offers:'.length).toLowerCase();
  return name === 'rollback' ? 'rollback' : name === 'reduced price' ? 'reduced' : null;
}

export class TierStore {
  /** @param {import('./storePrices.js').StorePrices} store  shares its database and saved values */
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
        start      INTEGER NOT NULL,
        category   TEXT             -- limit the search to this Walmart (sub)category id
      );
      CREATE INDEX IF NOT EXISTS search_queue_by_run ON search_queue (retailer, run, id);
      CREATE TABLE IF NOT EXISTS tier_items (
        retailer   TEXT NOT NULL,
        tier       INTEGER NOT NULL,
        run        TEXT NOT NULL,   -- the build that found it; old builds are dropped when a new one completes
        item_id    TEXT NOT NULL,
        department TEXT NOT NULL,
        offer      TEXT,            -- tier 2: 'rollback' or 'reduced'
        PRIMARY KEY (retailer, tier, run, item_id)
      ) WITHOUT ROWID;
      -- Product details (JSON) of tier 1/2 items, for deal cards and product pages.
      CREATE TABLE IF NOT EXISTS tier_products (
        retailer TEXT NOT NULL,
        item_id  TEXT NOT NULL,
        run      TEXT NOT NULL,
        data     TEXT NOT NULL,
        PRIMARY KEY (retailer, item_id)
      ) WITHOUT ROWID;
    `);
    this.insertJob = this.db.prepare(`INSERT INTO search_queue
      (retailer, run, tier, department, query, filters, lo, hi, sort, start, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.insertItem = this.db.prepare(`INSERT OR IGNORE INTO tier_items (retailer, tier, run, item_id, department, offer) VALUES (?, ?, ?, ?, ?, ?)`);
    this.upsertProduct = this.db.prepare(`INSERT INTO tier_products (retailer, item_id, run, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET run = excluded.run, data = excluded.data`);
    /** @type {Map<string, object>|null} tier_products in memory, loaded on first use */
    this.productCache = null;
  }

  enqueue(run, job) {
    this.insertJob.run(this.retailer, run, job.tier, job.department, job.query, JSON.stringify(job.filters),
      job.lo ?? null, job.hi ?? null, job.sort ?? null, job.start ?? 1, job.category ?? null);
  }

  /**
   * Queue one search per Walmart subcategory of the departments: its own name,
   * limited to that subcategory (search's categoryId). Reaches far more of the
   * shelf than the department words alone (measured: ~24,000 in-store items
   * tier 3 lacked).
   * @param {{ name: string, id: string, children?: object[] }[]} taxonomy
   * @returns {number} subcategories queued
   */
  enqueueSubcategories(run, { tier, taxonomy, departments, baseFilters }) {
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const dept of taxonomy.filter((c) => departments.includes(c.name))) {
        for (const subcat of (dept.children ?? []).filter((c) => c.id && !NOT_SUBCATEGORY.test(c.name))) {
          this.enqueue(run, { tier, department: dept.name, query: subcat.name, filters: [...baseFilters], category: subcat.id });
          n += 1;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return n;
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
      result = await source.searchPage({ query: job.query, filters: job.filters, lo: job.lo, hi: job.hi, start: job.start, sort: job.sort, categoryId: job.category ?? null });
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
        // The search only returns Walmart-sold items, so its price is Walmart's online price.
        if (p.seller?.isRetailer !== false && p.price > 0) this.store.saveOnlinePrice(this.retailer, p.id, p.price, run.slice(0, 10));
        if (job.tier <= 2) this.saveProduct(run, p);
      }
      if (job.start === 1) this.planFollowUps(run, job, total);
      this.db.prepare('DELETE FROM search_queue WHERE id = ?').run(job.id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  /** The completed build (run name) a tier's current list comes from, or null. */
  builtRun(tier) {
    return this.store.getMeta(`tierBuilt:${this.retailer}:${tier}`);
  }

  /** Make `run` the current list for `tier` and drop older builds. */
  markBuilt(tier, run) {
    this.store.setMeta(`tierBuilt:${this.retailer}:${tier}`, run);
    this.db.prepare('DELETE FROM tier_items WHERE retailer = ? AND tier = ? AND run <> ?').run(this.retailer, tier, run);
  }

  /** Item ids on a tier's current list. */
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

  /** The highest item id (as a number) on any tier 3 list in a department, or null. */
  maxTier3Id(department) {
    const row = this.db.prepare(`SELECT MAX(CAST(item_id AS INTEGER)) AS id FROM tier_items
      WHERE retailer = ? AND tier = 3 AND department = ?`).get(this.retailer, department);
    return row?.id == null ? null : String(row.id);
  }

  /**
   * Copy into a new tier 3 build the items of the old one that the store checks
   * have seen on a shelf (a current Walmart-sold store price), so items found
   * outside the weekly searches (e.g. the nightly new listings) stay listed.
   * @returns {number} items copied
   */
  carryOverShelfItems(fromRun, toRun) {
    if (!fromRun || fromRun === toRun) return 0;
    return this.db.prepare(`INSERT OR IGNORE INTO tier_items (retailer, tier, run, item_id, department, offer)
      SELECT t.retailer, 3, :to, t.item_id, t.department, NULL FROM tier_items t
      WHERE t.retailer = :retailer AND t.tier = 3 AND t.run = :from AND EXISTS (
        SELECT 1 FROM store_latest l WHERE l.retailer = t.retailer AND l.item_id = t.item_id
          AND l.price > 0 AND lower(l.seller) IN ('walmart', 'walmart.com'))`)
      .run({ retailer: this.retailer, from: fromRun, to: toRun }).changes;
  }

  /** The next `limit` tier-3 items after `afterId` (in item-id order), for slices that continue across days. */
  tier3Batch(afterId, limit) {
    const run = this.builtRun(3);
    if (!run || limit <= 0) return [];
    return this.db.prepare(`SELECT item_id FROM tier_items WHERE retailer = ? AND tier = 3 AND run = ? AND item_id > ?
      ORDER BY item_id LIMIT ?`).all(this.retailer, run, afterId, limit).map((r) => r.item_id);
  }

  /**
   * Add one page of a Walmart feed (/paginated/items with soldByWmt) to a run's
   * lists. Deal feeds (job.offer): Clearance to tier 1, Rollback / Reduced
   * Price to tier 2. Tier 3 feeds (job.tier 3): items with a price, added to
   * every run given (unpriced listings such as video episodes are left out).
   * Items another seller sells, or outside the kept departments, are skipped.
   * Counts how many were already listed, and the highest priced item id.
   * @param {string|string[]} runs
   * @param {{ offer?: 'clearance'|'rollback'|'reduced', tier?: 3, department: string }} job
   * @param {(item) => object} toProduct  the source's item -> product
   */
  addFeedItems(runs, job, items, { toProduct, keep = () => true }) {
    const tier = job.tier ?? (job.offer === 'clearance' ? 1 : 2);
    const targets = [].concat(runs);
    const run = targets[0];
    const has = this.db.prepare('SELECT 1 FROM tier_items WHERE retailer = ? AND tier = ? AND run = ? AND item_id = ?');
    const out = { items: 0, otherSeller: 0, added: 0, alreadyListed: 0, skipped: 0, unpriced: 0, lastPricedId: null };
    this.db.exec('BEGIN');
    try {
      for (const item of items ?? []) {
        if (!item?.itemId) continue;
        out.items += 1;
        const seller = String(item.sellerInfo ?? '').trim();
        if ((seller && !/^walmart(\.com)?$/i.test(seller)) || item.marketplace === true) { out.otherSeller += 1; continue; }
        const p = toProduct(item);
        if (tier === 3 && !(p.price > 0)) { out.unpriced += 1; continue; }
        if (p.price > 0 && (out.lastPricedId === null || Number(p.id) > Number(out.lastPricedId))) out.lastPricedId = p.id;
        if (!keep(p)) { out.skipped += 1; continue; }
        if (has.get(this.retailer, tier, run, p.id)) out.alreadyListed += 1;
        else out.added += 1;
        for (const r of targets) this.insertItem.run(this.retailer, tier, r, p.id, job.department, tier === 2 ? job.offer : null);
        if (tier <= 2) this.saveProduct(run, p);
        if (p.price > 0) this.store.saveOnlinePrice(this.retailer, p.id, p.price, run.slice(0, 10));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return out;
  }

  /**
   * Walmart's online deal label for each item on today's lists: 'clearance'
   * (tier 1), else 'rollback' / 'reduced' (tier 2; 'offer' when unknown).
   * @returns {Map<string, string>}
   */
  offers() {
    const out = new Map();
    const t2 = this.builtRun(2);
    if (t2) {
      for (const r of this.db.prepare('SELECT item_id, offer FROM tier_items WHERE retailer = ? AND tier = 2 AND run = ?').iterate(this.retailer, t2)) {
        if (!out.has(r.item_id) || r.offer) out.set(r.item_id, r.offer ?? 'offer');
      }
    }
    const t1 = this.builtRun(1);
    if (t1) for (const id of this.itemIds(1)) out.set(id, 'clearance');
    return out;
  }

  /** One item's online deal label on today's lists (see offers), or null. */
  offerOf(itemId) {
    const row = (tier) => {
      const run = this.builtRun(tier);
      return run && this.db.prepare('SELECT offer FROM tier_items WHERE retailer = ? AND tier = ? AND run = ? AND item_id = ?')
        .get(this.retailer, tier, run, String(itemId));
    };
    if (row(1)) return 'clearance';
    const listed = row(2);
    return listed ? listed.offer ?? 'offer' : null;
  }

  /** Save a tier 1/2 item's details (and keep the in-memory copy current). */
  saveProduct(run, product) {
    this.upsertProduct.run(this.retailer, product.id, run, JSON.stringify(product));
    this.productCache?.set(product.id, product);
  }

  /** Details of every tier 1/2 item: id -> product. Kept in memory; pages read it often. */
  products() {
    this.productCache ??= new Map(
      this.db.prepare('SELECT item_id, data FROM tier_products WHERE retailer = ?').all(this.retailer).map((r) => [r.item_id, JSON.parse(r.data)]),
    );
    return this.productCache;
  }

  /** One tier 1/2 item's details, or null. */
  product(itemId) {
    return this.products().get(String(itemId)) ?? null;
  }

  /** When a tier 1/2 build completes: forget products only older builds had. */
  dropOldProducts(run) {
    this.db.prepare('DELETE FROM tier_products WHERE retailer = ? AND run <> ?').run(this.retailer, run);
    this.productCache = null;
  }
}
