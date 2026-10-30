// Store-level Walmart prices. SerpApi searches find clearance items at
// discovery stores (one department, one store, one results page per search)
// on a schedule that spends a monthly search budget; the free Walmart item
// lookup (storeChecker.js) then checks prices at every store. Both save into
// StoreScanDb. Settings come from config/store-scan.json.
import { allowanceSoFar, localParts, monthPlan } from '../../lib/scanSchedule.js';

const SERPAPI_URL = 'https://serpapi.com';
export const RESULTS_PER_PAGE = 40; // SerpApi Walmart search page size

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
    this.insertRun = db.prepare(`INSERT INTO store_scan_runs
      (retailer, store_id, department, term, month, ran_at, result_count, error, page, total_results)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.upsertPrice = db.prepare(`INSERT INTO store_prices
      (retailer, store_id, item_id, date, price, was_price, in_stock, seller, title, image_url, url, department, online_price, online_seller, clearance, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, store_id, item_id, date) DO UPDATE SET
        price = excluded.price, was_price = excluded.was_price, in_stock = excluded.in_stock, seller = excluded.seller,
        title = excluded.title, image_url = excluded.image_url, url = excluded.url, department = excluded.department,
        online_price = COALESCE(excluded.online_price, store_prices.online_price),
        online_seller = COALESCE(excluded.online_seller, store_prices.online_seller),
        clearance = COALESCE(excluded.clearance, store_prices.clearance),
        source = excluded.source`);
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
        this.upsertPrice.run(retailer, storeId, r.itemId, date, r.price ?? null, r.wasPrice ?? null,
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
  latestPrices(retailer, storeIds, { days = 14, itemId = null, now = Date.now() } = {}) {
    if (!storeIds.length) return [];
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    const marks = storeIds.map(() => '?').join(',');
    const itemFilter = itemId ? 'AND item_id = ?' : '';
    const args = [retailer, since, ...storeIds, ...(itemId ? [String(itemId)] : []), retailer];
    return this.db.prepare(`SELECT p.* FROM store_prices p
      JOIN (SELECT store_id, item_id, MAX(date) d FROM store_prices
            WHERE retailer = ? AND date >= ? AND store_id IN (${marks}) ${itemFilter} GROUP BY store_id, item_id) l
        ON p.store_id = l.store_id AND p.item_id = l.item_id AND p.date = l.d
      WHERE p.retailer = ?`).all(...args);
  }

  /**
   * Save store prices from the free Walmart item lookup.
   * @param {{ itemId, title, price, wasPrice, clearance, inStock, seller, imageUrl, url, category }[]} rows
   */
  recordStorePrices(retailer, storeId, rows, date = new Date().toISOString().slice(0, 10)) {
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.upsertPrice.run(retailer, storeId, String(r.itemId), date, r.price ?? null, r.wasPrice ?? null,
          r.inStock == null ? null : r.inStock ? 1 : 0, r.seller ?? null, r.title ?? null, r.imageUrl ?? null,
          r.url ?? null, r.category ?? null, null, null, r.clearance == null ? null : r.clearance ? 1 : 0, 'walmart-api');
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Items marked down at any store recently: Clearance-flagged or below their was-price. */
  candidateItems(retailer, { days = 14, now = Date.now() } = {}) {
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT DISTINCT item_id FROM store_prices
      WHERE retailer = ? AND date >= ? AND (clearance = 1 OR was_price > price)`).all(retailer, since).map((r) => r.item_id);
  }

  /** Stores where the scan found Walmart itself selling an item (latest per store, last `days` days). */
  walmartStoreOffers(retailer, itemId, { days = 14, now = Date.now() } = {}) {
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT p.* FROM store_prices p
      JOIN (SELECT store_id, MAX(date) d FROM store_prices WHERE retailer = ? AND item_id = ? AND date >= ? GROUP BY store_id) l
        ON p.store_id = l.store_id AND p.date = l.d
      WHERE p.retailer = ? AND p.item_id = ? AND lower(p.seller) IN ('walmart', 'walmart.com')
      ORDER BY p.price`).all(retailer, String(itemId), since, retailer, String(itemId));
  }

  /** Recent items whose online seller hasn't been recorded yet. */
  itemsMissingOnlineSeller(retailer, { days = 14, now = Date.now() } = {}) {
    const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(`SELECT DISTINCT item_id FROM store_prices
      WHERE retailer = ? AND date >= ? AND online_seller IS NULL`).all(retailer, since).map((r) => r.item_id);
  }

  setOnlineInfo(retailer, itemId, { price, seller }) {
    this.db.prepare(`UPDATE store_prices SET online_seller = ?, online_price = COALESCE(online_price, ?)
      WHERE retailer = ? AND item_id = ? AND online_seller IS NULL`).run(seller ?? null, price ?? null, retailer, String(itemId));
  }

  /** Store ids that have any scanned prices. */
  scannedStores(retailer) {
    return this.db.prepare('SELECT DISTINCT store_id FROM store_prices WHERE retailer = ?').all(retailer).map((r) => r.store_id);
  }

  /** A random sample of saved store prices (most recent date per store and item). */
  samplePrices(retailer, limit = 15) {
    return this.db.prepare(`SELECT p.* FROM store_prices p
      JOIN (SELECT store_id, item_id, MAX(date) d FROM store_prices WHERE retailer = ? GROUP BY store_id, item_id) l
        ON p.store_id = l.store_id AND p.item_id = l.item_id AND p.date = l.d
      WHERE p.retailer = ? ORDER BY RANDOM() LIMIT ?`).all(retailer, retailer, limit);
  }

  priceCount(retailer) {
    return this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT item_id) items FROM store_prices WHERE retailer = ?').get(retailer);
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
