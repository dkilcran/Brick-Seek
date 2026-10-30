// Store-level Walmart prices from SerpApi: searches one department at one
// store (results come back priced for that store), on a schedule that spends
// a monthly search budget. Settings come from config/store-scan.json.
import { allowanceSoFar, localParts, monthPlan } from '../../lib/scanSchedule.js';

const SERPAPI_URL = 'https://serpapi.com';

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
  walmartSearch({ query, storeId, categoryId, facets = [], page = 1 }) {
    return this.get('/search.json', {
      engine: 'walmart', query: query || undefined, store_id: storeId, cat_id: categoryId,
      facet: facets.length ? facets.join('||') : undefined, page,
    });
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
    this.insertRun = db.prepare(`INSERT INTO store_scan_runs
      (retailer, store_id, department, term, month, ran_at, result_count, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.upsertPrice = db.prepare(`INSERT INTO store_prices
      (retailer, store_id, item_id, date, price, was_price, in_stock, seller, title, image_url, url, department, online_price, online_seller)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, store_id, item_id, date) DO UPDATE SET
        price = excluded.price, was_price = excluded.was_price, in_stock = excluded.in_stock, seller = excluded.seller,
        title = excluded.title, image_url = excluded.image_url, url = excluded.url, department = excluded.department,
        online_price = COALESCE(excluded.online_price, store_prices.online_price),
        online_seller = COALESCE(excluded.online_seller, store_prices.online_seller)`);
  }

  /** Successful searches this month (SerpApi only counts successful ones). */
  searchesUsed(retailer, month) {
    return this.db.prepare('SELECT COUNT(*) n FROM store_scan_runs WHERE retailer = ? AND month = ? AND error IS NULL')
      .get(retailer, month).n;
  }

  lastRunTimes(retailer) {
    const rows = this.db.prepare(`SELECT store_id, department, term, MAX(ran_at) last FROM store_scan_runs
      WHERE retailer = ? GROUP BY store_id, department, term`).all(retailer);
    return new Map(rows.map((r) => [`${r.store_id}|${r.department}|${r.term}`, r.last]));
  }

  lastError(retailer) {
    return this.db.prepare('SELECT ran_at, error FROM store_scan_runs WHERE retailer = ? ORDER BY id DESC LIMIT 1').get(retailer);
  }

  recentRuns(retailer, limit = 10) {
    return this.db.prepare(`SELECT store_id, department, term, ran_at, result_count, error FROM store_scan_runs
      WHERE retailer = ? ORDER BY id DESC LIMIT ?`).all(retailer, limit);
  }

  recordRun({ retailer, storeId, department, term, month, ranAt, results, error }) {
    this.db.exec('BEGIN');
    try {
      this.insertRun.run(retailer, storeId, department, term, month, ranAt, results?.length ?? null, error ?? null);
      const date = new Date(ranAt).toISOString().slice(0, 10);
      for (const r of results ?? []) {
        if (!r.itemId) continue;
        // SQLite can't store undefined, so missing fields become null.
        this.upsertPrice.run(retailer, storeId, r.itemId, date, r.price ?? null, r.wasPrice ?? null,
          r.inStock == null ? null : r.inStock ? 1 : 0, r.seller ?? null, r.title ?? null, r.imageUrl ?? null, r.url ?? null, department,
          r.onlinePrice ?? null, r.onlineSeller ?? null);
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

function settingsKeyOf(config) {
  return JSON.stringify([config.stores.map((s) => s.id), config.departments, config.filters, config.searchTerms]);
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

  /** Every store × department × term, oldest-scanned first. */
  jobs(config) {
    const last = this.db.lastRunTimes(this.retailer);
    const jobs = [];
    for (const store of config.stores) {
      for (const department of config.departments) {
        for (const term of config.searchTerms) {
          jobs.push({ storeId: store.id, department, term, last: last.get(`${store.id}|${department}|${term}`) ?? 0 });
        }
      }
    }
    return jobs.sort((a, b) => a.last - b.last);
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

  /** One search: save results (with walmart.com prices when available) or the error. */
  async runJob(job, config, deptIds) {
    const now = this.now();
    const ranAt = now.getTime();
    const month = localParts(now).monthKey;
    try {
      const data = await this.client.walmartSearch({
        query: job.term, storeId: job.storeId, categoryId: deptIds.get(job.department), facets: config.filters,
      });
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
      this.db.recordRun({ retailer: this.retailer, ...job, month, ranAt, results });
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
