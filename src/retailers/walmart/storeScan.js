// Store-level Walmart prices. SerpApi searches find clearance items at
// discovery stores (one department, one store, one results page per search)
// on a schedule that spends a monthly search budget; the free Walmart item
// lookup (storeChecker.js) then checks prices at every store. Both save into
// StoreScanDb. Settings come from config/store-scan.json.
import { allowanceSoFar, localParts, monthPlan } from '../../lib/scanSchedule.js';

const SERPAPI_URL = 'https://serpapi.com';
export const RESULTS_PER_PAGE = 40; // SerpApi Walmart search page size
const PRICE_DAYS = 14; // store prices older than this aren't shown, and history is pruned
// "Calculated clearance": a store at least this much below the item's highest price at other stores.
/** A store price at least this far below the item's typical price (or its own earlier price) is a markdown. */
export const MARKDOWN_GAP = 0.1;
// Price columns with title/image/department from store_items when the row has none.
const PRICE_COLUMNS = `p.retailer, p.store_id, p.item_id, p.date, p.price, p.was_price, p.in_stock, p.seller,
  p.online_price, p.online_seller, p.clearance, p.source, p.url,
  COALESCE(p.title, i.title) title, COALESCE(p.image_url, i.image_url) image_url, COALESCE(p.department, i.department) department`;
const ITEM_JOIN = 'LEFT JOIN store_items i ON i.retailer = p.retailer AND i.item_id = p.item_id';

export class SerpApiClient {
  constructor({ apiKey, fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
  }

  async get(path, params) {
    const url = new URL(SERPAPI_URL + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    url.searchParams.set('api_key', this.apiKey);
    const res = await this.fetch(url, { headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw Object.assign(new Error(`SerpApi ${res.status}: ${body.error ?? 'request failed'}`), { status: 502 });
    }
    return body;
  }

  /** Walmart search limited to one store; results are priced for that store. */
  walmartSearch({ query, storeId, categoryId, facets = [], page }) {
    return this.get('/search.json', {
      engine: 'walmart', query: query || undefined, store_id: storeId, cat_id: categoryId,
      facet: facets.length ? facets.join('||') : undefined, page,
    });
  }

  /** A product page, optionally as seen from one store. */
  walmartProduct({ productId, storeId }) {
    return this.get('/search.json', { engine: 'walmart_product', product_id: productId, store_id: storeId });
  }

  /** Plan and usage; doesn't count as a search. */
  account() {
    return this.get('/account.json', {});
  }
}

/** Pull the fields we use out of one SerpApi Walmart result. Field names vary, so be lenient. */
export function parseSearchResult(r) {
  const num = (v) => (typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')) || null);
  const offer = r.primary_offer ?? {};
  return {
    itemId: String(r.us_item_id ?? r.product_id ?? r.item_id ?? r.id ?? ''),
    title: r.title ?? null,
    price: num(offer.offer_price ?? offer.min_price ?? r.price),
    wasPrice: num(r.price_was ?? offer.was_price ?? offer.list_price ?? r.was_price),
    inStock: r.out_of_stock === true ? false : r.out_of_stock === false ? true : null,
    seller: r.seller_name ?? null,
    sponsored: r.sponsored === true,
    imageUrl: r.thumbnail ?? null,
    url: r.product_page_url ?? null,
  };
}

export class StoreScanDb {
  constructor(db) {
    this.db = db;
    /** Bumps whenever store_markdowns is rebuilt, so pages can cache what they read from it. */
    this.markdownVersion = 0;
    /** Markdown threshold (settings: markdownPercent); see refreshMarkdowns. */
    this.markdownGap = MARKDOWN_GAP;
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_scan_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        retailer     TEXT NOT NULL,
        store_id     TEXT NOT NULL,
        department   TEXT NOT NULL,
        term         TEXT NOT NULL,
        month        TEXT NOT NULL, -- YYYY-MM in the schedule's time zone
        ran_at       INTEGER NOT NULL,
        result_count INTEGER,
        error        TEXT
      );
      CREATE TABLE IF NOT EXISTS store_prices (
        retailer   TEXT NOT NULL,
        store_id   TEXT NOT NULL,
        item_id    TEXT NOT NULL,
        date       TEXT NOT NULL,
        price      REAL,
        was_price  REAL,
        in_stock   INTEGER, -- 1, 0, or null when unknown
        seller     TEXT,
        title      TEXT,
        image_url  TEXT,
        url        TEXT,
        department TEXT,
        PRIMARY KEY (retailer, store_id, item_id, date)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS store_scan_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    // walmart.com price at scan time, to measure store markdowns (added after launch).
    const cols = db.prepare('PRAGMA table_info(store_prices)').all().map((c) => c.name);
    if (!cols.includes('online_price')) db.exec('ALTER TABLE store_prices ADD COLUMN online_price REAL');
    // Who sells it online: often a marketplace seller once Walmart sells it only in stores.
    if (!cols.includes('online_seller')) db.exec('ALTER TABLE store_prices ADD COLUMN online_seller TEXT');
    // Walmart's own Clearance flag for this store (1/0, null unknown), and where the row came from.
    if (!cols.includes('clearance')) db.exec('ALTER TABLE store_prices ADD COLUMN clearance INTEGER');
    if (!cols.includes('source')) db.exec('ALTER TABLE store_prices ADD COLUMN source TEXT');
    const runCols = db.prepare('PRAGMA table_info(store_scan_runs)').all().map((c) => c.name);
    if (!runCols.includes('page')) db.exec('ALTER TABLE store_scan_runs ADD COLUMN page INTEGER NOT NULL DEFAULT 1');
    if (!runCols.includes('total_results')) db.exec('ALTER TABLE store_scan_runs ADD COLUMN total_results INTEGER');
    // What daily discovery found (first place each item turned up), to measure its yield.
    db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_finds (
        retailer   TEXT NOT NULL,
        day        TEXT NOT NULL,    -- store-check day (YYYY-MM-DD)
        item_id    TEXT NOT NULL,
        department TEXT NOT NULL,
        page       INTEGER NOT NULL, -- 1-based search page
        in_pool    INTEGER NOT NULL, -- 1 = already in the product list
        PRIMARY KEY (retailer, day, item_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS store_prices_by_item_date ON store_prices (retailer, item_id, date);
      CREATE INDEX IF NOT EXISTS store_prices_by_date ON store_prices (retailer, date);
      -- Title, image and department once per item, instead of on every store-price row.
      CREATE TABLE IF NOT EXISTS store_items (
        retailer   TEXT NOT NULL,
        item_id    TEXT NOT NULL,
        title      TEXT,
        image_url  TEXT,
        department TEXT,
        PRIMARY KEY (retailer, item_id)
      ) WITHOUT ROWID;
      -- Walmart's store list per ZIP (stores rarely change), so visitor pages don't wait on Walmart.
      CREATE TABLE IF NOT EXISTS zip_stores (
        retailer   TEXT NOT NULL,
        zip        TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        data       TEXT NOT NULL,
        PRIMARY KEY (retailer, zip)
      ) WITHOUT ROWID;
    `);
    this.upsertItem = db.prepare(`INSERT INTO store_items (retailer, item_id, title, image_url, department) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET title = COALESCE(excluded.title, store_items.title),
        image_url = COALESCE(excluded.image_url, store_items.image_url), department = COALESCE(excluded.department, store_items.department)`);
    this.insertRun = db.prepare(`INSERT INTO store_scan_runs
      (retailer, store_id, department, term, month, ran_at, result_count, error, page, total_results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const columns = `(retailer, store_id, item_id, date, price, was_price, in_stock, seller, title, image_url, url, department,
      online_price, online_seller, clearance, source)`;
    const updates = `price = excluded.price, was_price = excluded.was_price, in_stock = excluded.in_stock, seller = excluded.seller,
        title = excluded.title, image_url = excluded.image_url, url = excluded.url, department = excluded.department,
        online_price = COALESCE(excluded.online_price, %T.online_price),
        online_seller = COALESCE(excluded.online_seller, %T.online_seller),
        clearance = COALESCE(excluded.clearance, %T.clearance),
        source = excluded.source`;
    // Daily history: one row per store, item and day (kept PRICE_DAYS days).
    this.upsertPrice = db.prepare(`INSERT INTO store_prices ${columns}
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, store_id, item_id, date) DO UPDATE SET ${updates.replaceAll('%T', 'store_prices')}`);
    // Latest price per store and item: what pages read. Its size doesn't grow with days.
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_latest (
        retailer TEXT NOT NULL, store_id TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
        price REAL, was_price REAL, in_stock INTEGER, seller TEXT, title TEXT, image_url TEXT, url TEXT, department TEXT,
        online_price REAL, online_seller TEXT, clearance INTEGER, source TEXT,
        PRIMARY KEY (retailer, store_id, item_id)
      ) WITHOUT ROWID;
      -- By item, then price: per-item lookups, and each item's price spread without a sort.
      CREATE INDEX IF NOT EXISTS store_latest_by_item_price ON store_latest (retailer, item_id, price);
      DROP INDEX IF EXISTS store_latest_by_item;
    `);
    // The store's price before its last change, and when that was: a drop at
    // one store shows up as a markdown even when other stores aren't checked.
    const latestCols = db.prepare('PRAGMA table_info(store_latest)').all().map((c) => c.name);
    if (!latestCols.includes('prev_price')) db.exec('ALTER TABLE store_latest ADD COLUMN prev_price REAL');
    if (!latestCols.includes('prev_date')) db.exec('ALTER TABLE store_latest ADD COLUMN prev_date TEXT');
    const changed = 'excluded.price IS NOT NULL AND store_latest.price IS NOT NULL AND excluded.price <> store_latest.price';
    this.upsertLatest = db.prepare(`INSERT INTO store_latest ${columns}
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, store_id, item_id) DO UPDATE SET date = excluded.date,
        prev_price = CASE WHEN ${changed} THEN store_latest.price ELSE store_latest.prev_price END,
        prev_date = CASE WHEN ${changed} THEN store_latest.date ELSE store_latest.prev_date END,
        ${updates.replaceAll('%T', 'store_latest')}
      WHERE excluded.date >= store_latest.date`);
    // Only the marked-down current prices, rebuilt by refreshMarkdowns(): what
    // "Clearance near you" and the daily candidate lists read, instead of
    // scanning every current price (11s at 800k rows).
    // Rebuilt on every refresh, so an older layout is simply replaced.
    const mdCols = db.prepare('PRAGMA table_info(store_markdowns)').all().map((c) => c.name);
    if (mdCols.length && !mdCols.includes('was_price')) db.exec('DROP TABLE store_markdowns');
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_markdowns (
        retailer TEXT NOT NULL, store_id TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
        price REAL NOT NULL, ref_price REAL, was_price REAL, in_stock INTEGER,
        -- 'clearance' (Walmart's flag at that store), 'rollback' / 'reduced' / 'offer' (Walmart's
        -- Rollback or Reduced Price, with a was-price at that store), 'markdown' (ours: cheaper than
        -- the item's typical price at other stores, or than this store's own earlier price)
        kind TEXT NOT NULL,
        PRIMARY KEY (retailer, store_id, item_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS store_markdowns_by_item ON store_markdowns (retailer, item_id);
    `);
    // One-time fill from history saved before store_latest existed.
    if (!db.prepare('SELECT 1 FROM store_latest LIMIT 1').get() && db.prepare('SELECT 1 FROM store_prices LIMIT 1').get()) {
      db.exec(`INSERT INTO store_latest SELECT p.retailer, p.store_id, p.item_id, p.date, p.price, p.was_price, p.in_stock,
          p.seller, p.title, p.image_url, p.url, p.department, p.online_price, p.online_seller, p.clearance, p.source
        FROM store_prices p JOIN (SELECT retailer, store_id, item_id, MAX(date) d FROM store_prices GROUP BY retailer, store_id, item_id) l
          ON p.retailer = l.retailer AND p.store_id = l.store_id AND p.item_id = l.item_id AND p.date = l.d`);
    }
  }

  /**
   * Rebuild store_markdowns at startup if it's empty but prices exist, or if
   * it still holds labels from an older version ('flag', 'was', 'calc').
   */
  ensureMarkdowns(retailer) {
    const has = this.db.prepare('SELECT 1 FROM store_markdowns WHERE retailer = ? LIMIT 1').get(retailer);
    const legacy = this.db.prepare(`SELECT 1 FROM store_markdowns WHERE retailer = ?
      AND kind NOT IN ('clearance', 'rollback', 'reduced', 'offer', 'markdown') LIMIT 1`).get(retailer);
    const prices = this.db.prepare('SELECT 1 FROM store_latest WHERE retailer = ? LIMIT 1').get(retailer);
    if ((!has || legacy) && prices) this.refreshMarkdowns(retailer);
  }

  /**
   * Save one price: the latest-price table always, the history only when
   * something changed (price, was-price, stock, Clearance flag or seller), so
   * the history is a change log instead of a daily copy of every price.
   * Values are in the column order of store_prices.
   */
  savePrice(...values) {
    const [retailer, storeId, itemId, , price, wasPrice, inStock, seller, , , , , , , clearance] = values;
    this.getLatest ??= this.db.prepare(`SELECT price, was_price, in_stock, seller, clearance FROM store_latest
      WHERE retailer = ? AND store_id = ? AND item_id = ?`);
    const prev = this.getLatest.get(retailer, storeId, itemId);
    const same = prev && prev.price === price && prev.was_price === wasPrice && prev.in_stock === inStock
      && prev.seller === seller && (clearance === null || prev.clearance === clearance);
    if (!same) this.upsertPrice.run(...values);
    this.upsertLatest.run(...values);
  }

  /** Successful searches this month (SerpApi only counts successful ones). */
  searchesUsed(retailer, month) {
    return this.db.prepare('SELECT COUNT(*) n FROM store_scan_runs WHERE retailer = ? AND month = ? AND error IS NULL')
      .get(retailer, month).n;
  }

  lastRunTimes(retailer) {
    const rows = this.db.prepare(`SELECT store_id, department, term, page, MAX(ran_at) last FROM store_scan_runs
      WHERE retailer = ? GROUP BY store_id, department, term, page`).all(retailer);
    return new Map(rows.map((r) => [`${r.store_id}|${r.department}|${r.term}|${r.page}`, r.last]));
  }

  /** Latest known total result count per store|department|term (from page-1 searches). */
  lastTotals(retailer) {
    const rows = this.db.prepare(`SELECT r.store_id, r.department, r.term, r.total_results FROM store_scan_runs r
      JOIN (SELECT store_id, department, term, MAX(id) id FROM store_scan_runs
            WHERE retailer = ? AND page = 1 AND error IS NULL AND total_results IS NOT NULL GROUP BY store_id, department, term) l
        ON r.id = l.id`).all(retailer);
    return new Map(rows.map((r) => [`${r.store_id}|${r.department}|${r.term}`, r.total_results]));
  }

  lastError(retailer) {
    return this.db.prepare('SELECT ran_at, error FROM store_scan_runs WHERE retailer = ? ORDER BY id DESC LIMIT 1').get(retailer);
  }

  recentRuns(retailer, limit = 10) {
    return this.db.prepare(`SELECT store_id, department, term, ran_at, result_count, error FROM store_scan_runs
      WHERE retailer = ? ORDER BY id DESC LIMIT ?`).all(retailer, limit);
  }

  recordRun({ retailer, storeId, department, term, month, ranAt, results, error, page = 1, totalResults = null, clearance = null }) {
    this.db.exec('BEGIN');
    try {
      this.insertRun.run(retailer, storeId, department, term, month, ranAt, results?.length ?? null, error ?? null, page, totalResults);
      const date = new Date(ranAt).toISOString().slice(0, 10);
      for (const r of results ?? []) {
        if (!r.itemId) continue;
        // SQLite can't store undefined, so missing fields become null.
        this.savePrice(retailer, storeId, r.itemId, date, r.price ?? null, r.wasPrice ?? null,
          r.inStock == null ? null : r.inStock ? 1 : 0, r.seller ?? null, r.title ?? null, r.imageUrl ?? null, r.url ?? null, department,
          r.onlinePrice ?? null, r.onlineSeller ?? null, clearance, 'serpapi');
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Latest scanned price per item at the given stores, from the last `days` days.
   * @returns rows of store_prices
   */
  latestPrices(retailer, storeIds, { days = PRICE_DAYS, itemId = null, now = Date.now() } = {}) {
    if (!storeIds.length) return [];
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const marks = storeIds.map(() => '?').join(',');
    const itemFilter = itemId ? 'AND p.item_id = ?' : '';
    return this.db.prepare(`SELECT ${PRICE_COLUMNS} FROM store_latest p ${ITEM_JOIN}
      WHERE p.retailer = ? AND p.date >= ? AND p.store_id IN (${marks}) ${itemFilter}`)
      .all(retailer, since, ...storeIds, ...(itemId ? [String(itemId)] : []));
  }

  /**
   * Save store prices from the free Walmart item lookup.
   * @param {{ itemId, title, price, wasPrice, clearance, inStock, seller, imageUrl, url, category }[]} rows
   */
  recordStorePrices(retailer, storeId, rows, date = new Date().toISOString().slice(0, 10)) {
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.upsertItem.run(retailer, String(r.itemId), r.title ?? null, r.imageUrl ?? null, r.category ?? null);
        // Lean rows: title/image/department live in store_items; the URL comes from the item id.
        this.savePrice(retailer, storeId, String(r.itemId), date, r.price ?? null, r.wasPrice ?? null,
          r.inStock == null ? null : r.inStock ? 1 : 0, r.seller ?? null, null, null,
          null, null, null, null, r.clearance == null ? null : r.clearance ? 1 : 0, 'walmart-api');
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Items marked down at any store recently: Clearance-flagged or below their was-price. */
  /** @param {{ itemId: string, inPool: boolean }[]} finds  items from one search page */
  recordDiscovery(retailer, day, department, page, finds) {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO discovery_finds
      (retailer, day, item_id, department, page, in_pool) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const f of finds) insert.run(retailer, day, String(f.itemId), department, page, f.inPool ? 1 : 0);
  }

  /**
   * How discovery paid off, from `sinceDay` on: per day, and per department
   * and page, items found, how many were new to the product list, and how
   * many were marked down at a store that day (Walmart-sold, Clearance flag or
   * a higher was-price).
   */
  async discoveryYield(retailer, sinceDay) {
    // Simple indexed queries, counted in JS. A single SQL query with a CTE was
    // re-evaluated per row by SQLite and blocked the server for minutes.
    const finds = this.db.prepare(`SELECT day, item_id, department, page, in_pool FROM discovery_finds
      WHERE retailer = ? AND day >= ?`).all(retailer, sinceDay);
    // The history only has a row when something changed, so an item was marked
    // down at a store on a day if its latest price (seen by then) is, or a
    // marked-down history row up to that day has no newer row by that day.
    const WALMART_MARKED = `(clearance = 1 OR was_price > price) AND lower(seller) IN ('walmart', 'walmart.com')`;
    const latestMarked = this.db.prepare(`SELECT 1 FROM store_latest INDEXED BY store_latest_by_item_price
      WHERE retailer = ? AND item_id = ? AND date <= ? AND ${WALMART_MARKED} LIMIT 1`);
    const markedRows = this.db.prepare(`SELECT store_id, date FROM store_prices INDEXED BY store_prices_by_item_date
      WHERE retailer = ? AND item_id = ? AND date <= ? AND ${WALMART_MARKED}`);
    const newer = this.db.prepare(`SELECT 1 FROM store_prices
      WHERE retailer = ? AND store_id = ? AND item_id = ? AND date > ? AND date <= ? LIMIT 1`);
    const isMarked = {
      get: (ret, itemId, day) => latestMarked.get(ret, itemId, day)
        || markedRows.all(ret, itemId, day).some((r) => !newer.get(ret, r.store_id, itemId, r.date, day)),
    };
    const blank = () => ({ found: 0, new: 0, markedDown: 0, markedDownNew: 0 });
    const add = (acc, f, marked) => {
      acc.found += 1;
      if (!f.in_pool) acc.new += 1;
      if (marked) acc.markedDown += 1;
      if (marked && !f.in_pool) acc.markedDownNew += 1;
    };
    const byDay = new Map();
    const byDepartment = new Map();
    // ~25 microseconds per find; pause every 2,000 so other requests aren't held up.
    for (const [i, f] of finds.entries()) {
      if (i && i % 2000 === 0) await new Promise((r) => setImmediate(r));
      const marked = Boolean(isMarked.get(retailer, f.item_id, f.day));
      if (!byDay.has(f.day)) byDay.set(f.day, { day: f.day, ...blank() });
      add(byDay.get(f.day), f, marked);
      if (!byDepartment.has(f.department)) byDepartment.set(f.department, { department: f.department, ...blank(), pages: new Map() });
      const d = byDepartment.get(f.department);
      add(d, f, marked);
      if (!d.pages.has(f.page)) d.pages.set(f.page, { page: f.page, ...blank() });
      add(d.pages.get(f.page), f, marked);
    }
    return {
      days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({
        ...d,
        // All items marked down that day from any source, counted when the day's checks finished.
        markedDownAllSources: this.getMeta(`markedDown:${retailer}:${d.day}`),
      })),
      byDepartment: [...byDepartment.values()]
        .sort((a, b) => a.department.localeCompare(b.department))
        .map((d) => ({ ...d, pages: [...d.pages.values()].sort((a, b) => a.page - b.page) })),
    };
  }

  /**
   * Distinct Walmart-sold items marked down (Clearance flag or below was-price)
   * at a store checked that day, from the markdown table (rebuilt just before).
   */
  markedDownCount(retailer, day) {
    return this.db.prepare(`SELECT COUNT(DISTINCT item_id) n FROM store_markdowns
      WHERE retailer = ? AND date = ?`).get(retailer, day).n;
  }

  /**
   * Drop history older than PRICE_DAYS (and discovery records older than 60
   * days). If the database is still over maxMb (the Render disk is 1 GB),
   * history is cut to a week; current prices are kept.
   */
  async prune(now = Date.now(), { maxMb = 700 } = {}) {
    const day = (n) => new Date(now - n * 86400000).toISOString().slice(0, 10);
    await this.deleteHistoryBefore(day(PRICE_DAYS));
    if (this.sizeMb() - this.freeMb() > maxMb) {
      console.warn(`store prices: database over ${maxMb} MB, keeping 7 days of price history`);
      await this.deleteHistoryBefore(day(7));
    }
    this.db.prepare('DELETE FROM store_latest WHERE date < ?').run(day(PRICE_DAYS));
    this.db.prepare('DELETE FROM store_markdowns WHERE date < ?').run(day(PRICE_DAYS));
    this.db.prepare('DELETE FROM discovery_finds WHERE day < ?').run(day(60));
  }

  /** Delete history rows dated before `date`, 5,000 at a time so requests aren't held up. */
  async deleteHistoryBefore(date) {
    const chunk = this.db.prepare(`DELETE FROM store_prices WHERE (retailer, store_id, item_id, date) IN
      (SELECT retailer, store_id, item_id, date FROM store_prices INDEXED BY store_prices_by_date WHERE date < ? LIMIT 5000)`);
    while (chunk.run(date).changes) await new Promise((r) => setImmediate(r));
  }

  /** Space inside the database file that's free for reuse (after deletes), in MB. */
  freeMb() {
    const { freelist_count: free } = this.db.prepare('PRAGMA freelist_count').get();
    const { page_size: size } = this.db.prepare('PRAGMA page_size').get();
    return Math.round((free * size) / 1048576);
  }

  /** Database file size in MB. */
  sizeMb() {
    const { page_count: pages } = this.db.prepare('PRAGMA page_count').get();
    const { page_size: size } = this.db.prepare('PRAGMA page_size').get();
    return Math.round((pages * size) / 1048576);
  }

  /** Items marked down at any store (any kind), from store_markdowns. */
  /**
   * Keep the ids whose department (from earlier store checks) is in
   * `departments`; items with no known department are kept.
   */
  inDepartments(retailer, ids, departments) {
    if (!departments?.length) return ids;
    const allowed = new Set(departments);
    const dept = this.db.prepare('SELECT department FROM store_items WHERE retailer = ? AND item_id = ?');
    return ids.filter((id) => {
      const d = dept.get(retailer, String(id))?.department;
      return !d || allowed.has(d);
    });
  }

  /** Forget items' store prices everywhere (e.g. Walmart sells them online only). History is kept. */
  dropItems(retailer, ids) {
    const latest = this.db.prepare('DELETE FROM store_latest WHERE retailer = ? AND item_id = ?');
    const marks = this.db.prepare('DELETE FROM store_markdowns WHERE retailer = ? AND item_id = ?');
    for (const id of ids) {
      latest.run(retailer, String(id));
      marks.run(retailer, String(id));
    }
    this.markdownVersion += 1;
  }

  /** Each store's deal label for an item: store_id -> { kind, ref_price }. */
  itemMarkdowns(retailer, itemId) {
    const rows = this.db.prepare('SELECT store_id, kind, ref_price FROM store_markdowns WHERE retailer = ? AND item_id = ?')
      .all(retailer, String(itemId));
    return new Map(rows.map((r) => [r.store_id, r]));
  }

  candidateItems(retailer) {
    return this.db.prepare('SELECT DISTINCT item_id FROM store_markdowns WHERE retailer = ?').all(retailer).map((r) => r.item_id);
  }

  /**
   * Rebuild store_markdowns from the current Walmart-sold prices. Each store
   * price gets at most one label, in this order:
   *  - clearance: Walmart's Clearance flag at that store;
   *  - rollback / reduced: on today's Walmart Rollback or Reduced Price list
   *    (tier 2) and below its was-price at that store;
   *  - markdown (ours): at least MARKDOWN_GAP below the item's typical price
   *    (the upper median of its current prices at all stores), or below this
   *    store's own price before its last change (within `days`).
   * A was-price alone isn't a deal: Walmart shows reference prices on items
   * with no offer. ~1-2s at 800k prices; runs a few times an hour during checks.
   */
  refreshMarkdowns(retailer, { days = PRICE_DAYS, now = Date.now(), gap = this.markdownGap } = {}) {
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const tier2Run = this.getMeta(`tierBuilt:${retailer}:2`);
    // The tier lists may not exist yet, or (right after an upgrade, before TierStore
    // starts) may not have their offer column yet.
    const tierCols = this.db.prepare('PRAGMA table_info(tier_items)').all().map((c) => c.name);
    const hasTiers = tierCols.length > 0;
    const offer = tierCols.includes('offer') ? "COALESCE(offer, 'offer')" : "'offer'";
    const offers = hasTiers && tier2Run
      ? `SELECT item_id, MAX(${offer}) offer FROM tier_items WHERE retailer = :retailer AND tier = 2 AND run = :run GROUP BY item_id`
      : 'SELECT NULL item_id, NULL offer WHERE 0';
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM store_markdowns WHERE retailer = ?').run(retailer);
      this.db.prepare(`INSERT INTO store_markdowns (retailer, store_id, item_id, date, price, ref_price, was_price, in_stock, kind)
        WITH
        -- Each item's price spread, read in index order (no sort). Only items whose
        -- prices differ by at least the gap need a typical price (upper median).
        spread AS (
          SELECT item_id, MIN(price) lo, MAX(price) hi, COUNT(*) n
          FROM store_latest INDEXED BY store_latest_by_item_price WHERE retailer = :retailer AND price > 0 GROUP BY item_id),
        ranked AS (
          SELECT p.item_id, p.price, s.n, ROW_NUMBER() OVER (PARTITION BY p.item_id ORDER BY p.price) rn
          FROM spread s JOIN store_latest p INDEXED BY store_latest_by_item_price
            ON p.retailer = :retailer AND p.item_id = s.item_id AND p.price > 0
          WHERE s.n >= 2 AND s.lo <= s.hi * (1 - :gap)),
        typ AS (SELECT item_id, price typical, n FROM ranked WHERE rn = n / 2 + 1),
        offers AS (${offers}),
        labeled AS (
          SELECT c.store_id, c.item_id, c.date, c.price, c.was_price, c.in_stock, t.typical, t.n,
            CASE WHEN c.prev_date >= :since AND c.prev_price > c.price THEN c.prev_price END prev,
            CASE
              WHEN c.clearance = 1 THEN 'clearance'
              WHEN o.offer IS NOT NULL AND c.was_price > c.price THEN o.offer
              WHEN c.price <= t.typical * (1 - :gap) THEN 'markdown'
              WHEN c.prev_date >= :since AND c.price <= c.prev_price * (1 - :gap) THEN 'markdown'
            END kind
          FROM store_latest c LEFT JOIN typ t ON t.item_id = c.item_id LEFT JOIN offers o ON o.item_id = c.item_id
          WHERE c.retailer = :retailer AND c.date >= :since AND c.price > 0 AND lower(c.seller) IN ('walmart', 'walmart.com'))
        SELECT :retailer, store_id, item_id, date, price,
          -- What the discount is measured against: Walmart's was-price for its own offers,
          -- else the typical price at other stores, else this store's earlier price.
          CASE
            WHEN kind <> 'markdown' AND was_price > price THEN was_price
            WHEN typical > price THEN typical
            WHEN prev > price THEN prev
          END,
          CASE WHEN was_price > price THEN was_price END, in_stock, kind
        FROM labeled WHERE kind IS NOT NULL`)
        .run({ retailer, since, gap, ...(hasTiers && tier2Run ? { run: tier2Run } : {}) });
      this.db.exec('COMMIT');
      this.markdownVersion += 1;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Marked-down rows at the given stores, with item title/image/department. */
  markdownRows(retailer, storeIds) {
    if (!storeIds.length) return [];
    const marks = storeIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT m.*, i.title, i.image_url, i.department FROM store_markdowns m
      LEFT JOIN store_items i ON i.retailer = m.retailer AND i.item_id = m.item_id
      WHERE m.retailer = ? AND m.store_id IN (${marks})`).all(retailer, ...storeIds);
  }

  /** Store-level markdowns: Walmart's Clearance flag at some store, or calculated clearance. */
  storeLevelItems(retailer) {
    return this.db.prepare(`SELECT DISTINCT item_id FROM store_markdowns WHERE retailer = ? AND kind IN ('clearance', 'markdown')`)
      .all(retailer).map((r) => r.item_id);
  }

  /** Stores where the scan found Walmart itself selling an item (latest per store, last `days` days). */
  walmartStoreOffers(retailer, itemId, { days = PRICE_DAYS, now = Date.now() } = {}) {
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT ${PRICE_COLUMNS} FROM store_latest p INDEXED BY store_latest_by_item_price ${ITEM_JOIN}
      WHERE p.retailer = ? AND p.item_id = ? AND p.date >= ? AND lower(p.seller) IN ('walmart', 'walmart.com')
      ORDER BY p.price`).all(retailer, String(itemId), since);
  }

  /**
   * What the store checks know about an item Walmart sells at a checked store:
   * title, image, department and the lowest current store price. Null if none.
   */
  itemInfo(retailer, itemId) {
    const row = this.db.prepare(`SELECT MIN(p.price) min_price, COUNT(*) stores, MAX(p.date) seen_on,
        COALESCE(MAX(p.title), i.title) title, COALESCE(MAX(p.image_url), i.image_url) image_url,
        COALESCE(MAX(p.department), i.department) department
      FROM store_latest p INDEXED BY store_latest_by_item_price ${ITEM_JOIN}
      WHERE p.retailer = ? AND p.item_id = ? AND lower(p.seller) IN ('walmart', 'walmart.com')`).get(retailer, String(itemId));
    return row?.stores ? row : null;
  }

  /** A saved store list for a ZIP, if fetched within maxAgeDays. */
  zipStores(retailer, zip, { maxAgeDays = 7, now = Date.now() } = {}) {
    const row = this.db.prepare('SELECT fetched_at, data FROM zip_stores WHERE retailer = ? AND zip = ?').get(retailer, String(zip));
    if (!row || now - row.fetched_at > maxAgeDays * 86400000) return null;
    return JSON.parse(row.data);
  }

  saveZipStores(retailer, zip, stores, now = Date.now()) {
    this.db.prepare(`INSERT INTO zip_stores (retailer, zip, fetched_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (retailer, zip) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`)
      .run(retailer, String(zip), now, JSON.stringify(stores));
  }

  /** Recent items whose online seller hasn't been recorded yet. */
  itemsMissingOnlineSeller(retailer, { days = PRICE_DAYS, now = Date.now() } = {}) {
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    // Only SerpApi rows carry an online seller; the free lookup's rows don't need one.
    return this.db.prepare(`SELECT DISTINCT item_id FROM store_latest
      WHERE retailer = ? AND date >= ? AND online_seller IS NULL AND source = 'serpapi'`).all(retailer, since).map((r) => r.item_id);
  }

  setOnlineInfo(retailer, itemId, { price, seller }) {
    for (const table of ['store_prices', 'store_latest']) {
      this.db.prepare(`UPDATE ${table} SET online_seller = ?, online_price = COALESCE(online_price, ?)
        WHERE retailer = ? AND item_id = ? AND online_seller IS NULL`).run(seller ?? null, price ?? null, retailer, String(itemId));
    }
  }

  /** Store ids that have any recent prices. */
  scannedStores(retailer) {
    // Hop from store to store along the primary key instead of reading every price row.
    const next = this.db.prepare('SELECT store_id FROM store_latest WHERE retailer = ? AND store_id > ? ORDER BY store_id LIMIT 1');
    const ids = [];
    for (let row = next.get(retailer, ''); row; row = next.get(retailer, row.store_id)) ids.push(row.store_id);
    return ids;
  }

  /** A random sample of current store prices. */
  samplePrices(retailer, limit = 15) {
    return this.db.prepare(`SELECT ${PRICE_COLUMNS} FROM store_latest p ${ITEM_JOIN}
      WHERE p.retailer = ? ORDER BY RANDOM() LIMIT ?`).all(retailer, limit);
  }

  /** n = current store prices (one per store and item), items = distinct items. */
  priceCount(retailer) {
    return this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT item_id) items FROM store_latest WHERE retailer = ?').get(retailer);
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO store_scan_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM store_scan_meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
}

// Same defaults as loadScanConfig, for configs built by hand.
const discoveryStoresOf = (config) => config.discoveryStores ?? config.stores.map((s) => s.id);

function settingsKeyOf(config) {
  return JSON.stringify([discoveryStoresOf(config), config.departments, config.filters, config.searchTerms]);
}

export class StoreScanner {
  /**
   * @param {object} opts
   * @param {SerpApiClient} opts.client
   * @param {StoreScanDb} opts.db
   * @param {() => {config, errors}} opts.loadConfig  re-read each tick so edits apply without code changes
   * @param {() => Promise<{id: string, name: string}[]>} opts.departments  the retailer's departments, for ids
   */
  constructor({
    client, db, loadConfig, departments, retailer = 'walmart', now = () => new Date(),
    errorPauseMs = 30 * 60000, accountCheckMs = 60 * 60000, sweepPauseMs = 3000, onlinePrices = null,
  }) {
    this.client = client;
    this.db = db;
    this.loadConfig = loadConfig;
    this.departments = departments;
    this.retailer = retailer;
    this.now = now;
    this.errorPauseMs = errorPauseMs;
    this.accountCheckMs = accountCheckMs;
    this.sweepPauseMs = sweepPauseMs;
    /** @type {null | ((ids: string[]) => Promise<Map<string, {price}>>)} walmart.com prices, to measure markdowns */
    this.onlinePrices = onlinePrices;
    this.busy = false;
    this.account = null; // { searchesLeft, checkedAt }
  }

  /**
   * Searches allowed so far this month. In the month the scanner first ran,
   * days before it started don't count, so it never rushes through a backlog
   * (and SerpApi's allowance may not follow calendar months anyway).
   */
  allowance(now, budget) {
    let startedAt = this.db.getMeta('startedAt');
    if (!startedAt) {
      startedAt = now.getTime();
      this.db.setMeta('startedAt', startedAt);
    }
    const start = new Date(startedAt);
    const sameMonth = localParts(start).monthKey === localParts(now).monthKey;
    return allowanceSoFar(now, budget) - (sameMonth ? allowanceSoFar(start, budget) : 0);
  }

  /** SerpApi's own count of searches left, checked at most hourly. */
  async searchesLeft(now) {
    if (!this.account || now.getTime() - this.account.checkedAt > this.accountCheckMs) {
      try {
        const a = await this.client.account();
        this.account = { searchesLeft: a.plan_searches_left ?? a.total_searches_left ?? null, checkedAt: now.getTime() };
      } catch {
        this.account = { searchesLeft: null, checkedAt: now.getTime() };
      }
    }
    return this.account.searchesLeft;
  }

  /**
   * Every discovery store × department × term × results page, oldest-scanned
   * first. Pages past the last known result count are left out; page 2+ waits
   * until page 1 has reported a count.
   */
  jobs(config) {
    const last = this.db.lastRunTimes(this.retailer);
    const totals = this.db.lastTotals(this.retailer);
    const jobs = [];
    for (const storeId of discoveryStoresOf(config)) {
      for (const department of config.departments) {
        for (const term of config.searchTerms) {
          const total = totals.get(`${storeId}|${department}|${term}`);
          const pages = total == null ? 1 : Math.min(config.maxPages ?? 1, Math.max(1, Math.ceil(total / RESULTS_PER_PAGE)));
          for (let page = 1; page <= pages; page++) {
            jobs.push({ storeId, department, term, page, last: last.get(`${storeId}|${department}|${term}|${page}`) ?? 0 });
          }
        }
      }
    }
    // Oldest first; among equals, earlier pages first.
    return jobs.sort((a, b) => a.last - b.last || a.page - b.page);
  }

  /** Run at most one search if the schedule allows one now (or a requested full sweep). */
  async tick() {
    if (this.busy) return { ran: false, reason: 'busy' };
    const { config, errors } = this.loadConfig();
    if (!config || errors.length) return { ran: false, reason: `settings: ${errors.join('; ')}` };
    const now = this.now();
    const lastErr = this.db.lastError(this.retailer);
    if (lastErr?.error && now.getTime() - lastErr.ran_at < this.errorPauseMs) return { ran: false, reason: 'pausing after an error' };
    if (config.fullSweep && this.db.getMeta('sweepDone') !== config.fullSweep) return this.sweep(config);
    if (config.inspect?.run && this.db.getMeta('inspectDone') !== config.inspect.run) return this.inspect(config);

    const { monthKey } = localParts(now);
    const used = this.db.searchesUsed(this.retailer, monthKey);
    // After the settings change (or on first start), one search runs right away to confirm they work.
    const testSearch = this.db.getMeta('testedSettings') !== settingsKeyOf(config);
    const scheduled = this.allowance(now, config.monthlySearchBudget);
    const allowed = testSearch ? Math.max(scheduled, used + 1) : scheduled;
    if (used >= allowed) return { ran: false, reason: 'waiting for schedule', used, allowed };
    if ((await this.searchesLeft(now)) === 0) return { ran: false, reason: 'SerpApi plan has no searches left' };

    const deptIds = new Map((await this.departments()).map((d) => [d.name, d.id]));
    const job = this.jobs(config).find((j) => deptIds.has(j.department));
    if (!job) return { ran: false, reason: 'no departments match Walmart\'s names' };
    this.busy = true;
    try {
      return await this.runJob(job, config, deptIds);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Run every store x department x term not searched since the sweep was
   * requested (config.fullSweep changed), a few seconds apart.
   */
  async sweep(config) {
    const key = config.fullSweep;
    let requestedAt = this.db.getMeta(`sweepRequested:${key}`);
    if (!requestedAt) {
      requestedAt = this.now().getTime();
      this.db.setMeta(`sweepRequested:${key}`, requestedAt);
    }
    const deptIds = new Map((await this.departments()).map((d) => [d.name, d.id]));
    const todo = this.jobs(config).filter((j) => deptIds.has(j.department) && j.last < requestedAt);
    this.busy = true;
    let ran = 0;
    try {
      for (const job of todo) {
        if ((await this.searchesLeft(this.now())) === 0) return { ran: ran > 0, reason: 'SerpApi plan has no searches left', sweep: key, done: ran };
        const result = await this.runJob(job, config, deptIds);
        if (!result.ran) return { ran: ran > 0, reason: `sweep paused: ${result.reason}`, sweep: key, done: ran };
        ran += 1;
        if (this.account?.searchesLeft > 0) this.account.searchesLeft -= 1;
        if (this.sweepPauseMs) await new Promise((r) => setTimeout(r, this.sweepPauseMs));
      }
      this.db.setMeta('sweepDone', key);
      console.log(`store scan: full sweep "${key}" finished, ${ran} searches`);
      return { ran: ran > 0, sweep: key, done: ran, finished: true };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Diagnostics, run once per config.inspect.run value: raw SerpApi product
   * pages for chosen items (per store, and without a store), plus one full
   * raw search response. Saved for /api/:retailer/store-scan/inspect.
   */
  async inspect(config) {
    const { items = [], stores = [], searchDepartment } = config.inspect;
    const month = localParts(this.now()).monthKey;
    const results = {};
    this.busy = true;
    try {
      const record = async (key, fn, job) => {
        const ranAt = this.now().getTime();
        try {
          results[key] = await fn();
          this.db.recordRun({ retailer: this.retailer, storeId: job.storeId ?? '-', department: `inspect:${job.what}`, term: '', month, ranAt, results: [] });
        } catch (err) {
          results[key] = { error: err.message };
        }
      };
      for (const productId of items) {
        await record(`product:${productId}:no-store`, () => this.client.walmartProduct({ productId }), { what: productId });
        for (const storeId of stores) {
          await record(`product:${productId}:store:${storeId}`, () => this.client.walmartProduct({ productId, storeId }), { what: productId, storeId });
        }
      }
      if (searchDepartment && stores[0]) {
        const deptIds = new Map((await this.departments()).map((d) => [d.name, d.id]));
        await record(`search:${searchDepartment}:store:${stores[0]}`, () => this.client.walmartSearch({
          storeId: stores[0], categoryId: deptIds.get(searchDepartment), facets: config.filters,
        }), { what: `search ${searchDepartment}`, storeId: stores[0] });
      }
      this.db.setMeta('inspectResults', { run: config.inspect.run, at: new Date().toISOString(), results });
      this.db.setMeta('inspectDone', config.inspect.run);
      return { ran: true, inspected: Object.keys(results).length };
    } finally {
      this.busy = false;
    }
  }

  /** One search: save results (with walmart.com prices when available) or the error. */
  async runJob(job, config, deptIds) {
    const now = this.now();
    const ranAt = now.getTime();
    const month = localParts(now).monthKey;
    try {
      const data = await this.client.walmartSearch({
        query: job.term, storeId: job.storeId, categoryId: deptIds.get(job.department), facets: config.filters,
        page: job.page > 1 ? job.page : undefined,
      });
      const totalResults = Number(data.search_information?.total_results) || null;
      const raw = data.organic_results ?? [];
      const results = raw.map(parseSearchResult);
      if (this.onlinePrices && results.length) {
        try {
          const online = await this.onlinePrices(results.map((r) => r.itemId).filter(Boolean));
          for (const r of results) {
            r.onlinePrice = online.get(r.itemId)?.price ?? null;
            r.onlineSeller = online.get(r.itemId)?.seller ?? null;
          }
        } catch (err) {
          console.warn(`store scan: online prices failed: ${err.message}`);
        }
      }
      if (raw.length) this.db.setMeta('sampleResult', { ...job, ranAt, result: raw[0] });
      this.db.setMeta('lastRunSummary', {
        ...job, ranAt, filters: config.filters, results: results.length,
        soldByWalmart: results.filter((r) => /^walmart(\.com)?$/i.test(r.seller ?? '')).length,
        sponsored: results.filter((r) => r.sponsored).length,
        belowOnline: results.filter((r) => r.onlinePrice > r.price).length,
        sellers: Object.entries(results.reduce((m, r) => ({ ...m, [r.seller ?? '?']: (m[r.seller ?? '?'] ?? 0) + 1 }), {}))
          .sort((a, b) => b[1] - a[1]).slice(0, 5),
      });
      this.db.recordRun({
        retailer: this.retailer, ...job, month, ranAt, results, totalResults,
        // Searches filtered to Walmart's Clearance listings: every result is clearance.
        clearance: config.filters.includes('special_offers:Clearance') ? 1 : null,
      });
      this.db.refreshMarkdowns(this.retailer);
      this.db.setMeta('testedSettings', settingsKeyOf(config));
      return { ran: true, ...job, results: results.length };
    } catch (err) {
      this.db.recordRun({ retailer: this.retailer, ...job, month, ranAt, results: null, error: err.message.slice(0, 300) });
      console.warn(`store scan: ${job.storeId} ${job.department} failed: ${err.message}`);
      return { ran: false, reason: err.message, ...job };
    }
  }

  /** Record the online seller for items scanned before that was tracked. */
  async backfillOnlineSellers() {
    if (!this.onlinePrices) return 0;
    const ids = this.db.itemsMissingOnlineSeller(this.retailer);
    if (!ids.length) return 0;
    const online = await this.onlinePrices(ids);
    for (const id of ids) {
      const o = online.get(id);
      // Not found online at all: mark it so it isn't looked up again.
      this.db.setOnlineInfo(this.retailer, id, o ? { price: o.price, seller: o.seller ?? 'Walmart.com' } : { seller: '(not sold online)' });
    }
    return ids.length;
  }

  start(intervalMs = 5 * 60000) {
    const run = () => this.tick().catch((err) => console.warn('store scan tick failed', err.message));
    this.backfillOnlineSellers()
      .then((n) => n && console.log(`store scan: recorded online sellers for ${n} items`))
      .catch((err) => console.warn('store scan: online seller backfill failed', err.message))
      .finally(run);
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  async status() {
    const { config, errors } = this.loadConfig();
    const now = this.now();
    const t = localParts(now);
    let account = null;
    try {
      const a = await this.client.account();
      account = { plan: a.plan_name ?? null, searchesPerMonth: a.searches_per_month ?? null, searchesLeft: a.plan_searches_left ?? a.total_searches_left ?? null, thisMonthUsage: a.this_month_usage ?? null };
    } catch (err) {
      account = { error: err.message };
    }
    const plan = config ? monthPlan(t.year, t.month, config.monthlySearchBudget) : [];
    return {
      settingsErrors: errors,
      month: t.monthKey,
      budget: config?.monthlySearchBudget ?? null,
      used: this.db.searchesUsed(this.retailer, t.monthKey),
      allowedSoFar: config ? this.allowance(now, config.monthlySearchBudget) : null,
      startedAt: this.db.getMeta('startedAt') ? new Date(this.db.getMeta('startedAt')).toISOString() : null,
      todayPlanned: plan[t.day - 1]?.searches ?? null,
      monthPlan: plan,
      serpapiAccount: account,
      prices: this.db.priceCount(this.retailer),
      recentRuns: this.db.recentRuns(this.retailer),
      fullSweep: config?.fullSweep
        ? { requested: config.fullSweep, done: this.db.getMeta('sweepDone') === config.fullSweep }
        : null,
      lastRunSummary: this.db.getMeta('lastRunSummary'),
      sampleResult: this.db.getMeta('sampleResult'),
    };
  }
}
