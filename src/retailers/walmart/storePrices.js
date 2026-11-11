// Store-level Walmart prices and the deal labels worked out from them. The
// store checks (storeChecker.js) save what Walmart's item lookup returns for
// each store; pages read the small precomputed tables. Synchronous SQLite
// blocks the server, so everything a page calls here is an indexed lookup.

const PRICE_DAYS = 14; // store prices older than this aren't shown, and history is pruned
/** A store price at least this far below the item's highest valid store price is a Markdown. */
const MARKDOWN_GAP = 0.1;
/** Bump when the labeling rules change, so startup rebuilds store_markdowns with them. */
const MARKDOWN_RULES = '4';
const SOLD_BY_WALMART = "IN ('walmart', 'walmart.com')";

const dayBefore = (now, days) => new Date(now - days * 86400000).toISOString().slice(0, 10);
const flag = (v) => (v == null ? null : v ? 1 : 0);

export class StorePrices {
  /** @param {import('node:sqlite').DatabaseSync} db  the app's database (shared with the price tracker) */
  constructor(db) {
    this.db = db;
    /** Bumps whenever store_markdowns changes, so pages can cache what they read from it. */
    this.markdownVersion = 0;
    /** Bumps whenever an item's online price or online-only flag is saved. */
    this.onlineVersion = 0;
    /** Markdown threshold (settings: markdownPercent); see refreshMarkdowns. */
    this.markdownGap = MARKDOWN_GAP;
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_scan_meta (key TEXT PRIMARY KEY, value TEXT);
      -- Change log: a row only when a store's price, was-price, stock, Clearance
      -- flag or seller changes (kept PRICE_DAYS days).
      CREATE TABLE IF NOT EXISTS store_prices (
        retailer TEXT NOT NULL, store_id TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
        price REAL, was_price REAL,
        in_stock INTEGER,  -- 1, 0, or null when unknown
        seller TEXT,
        clearance INTEGER, -- Walmart's Clearance flag at that store
        PRIMARY KEY (retailer, store_id, item_id, date)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS store_prices_by_item_date ON store_prices (retailer, item_id, date);
      CREATE INDEX IF NOT EXISTS store_prices_by_date ON store_prices (retailer, date);
      -- The current price per store and item (date = last check): what pages read.
      CREATE TABLE IF NOT EXISTS store_latest (
        retailer TEXT NOT NULL, store_id TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
        price REAL, was_price REAL, in_stock INTEGER, seller TEXT, clearance INTEGER,
        prev_price REAL, prev_date TEXT, -- the price before its last change, and when that was seen
        PRIMARY KEY (retailer, store_id, item_id)
      ) WITHOUT ROWID;
      -- By item, then price: per-item lookups, and each item's price spread without a sort.
      CREATE INDEX IF NOT EXISTS store_latest_by_item_price ON store_latest (retailer, item_id, price);
      -- Once per item: details, Walmart's list price, and Walmart.com's own offer.
      CREATE TABLE IF NOT EXISTS store_items (
        retailer TEXT NOT NULL, item_id TEXT NOT NULL,
        title TEXT, image_url TEXT, department TEXT,
        msrp REAL,                  -- Walmart's list price, when it gives one
        online_price REAL,          -- Walmart.com's price with Walmart as the seller (null: a marketplace offer)
        online_date TEXT,           -- when online_price was seen (search, feed or lookup)
        online_was REAL,            -- Walmart.com's was-price (online lookup)
        online_only INTEGER,        -- 1: Walmart sells it online only
        online_available INTEGER,   -- 1/0: available on Walmart.com (online lookup)
        online_lookup_date TEXT,    -- day of the last online lookup
        PRIMARY KEY (retailer, item_id)
      ) WITHOUT ROWID;
      -- Walmart's store list per ZIP (stores rarely change), so pages don't wait on Walmart.
      CREATE TABLE IF NOT EXISTS zip_stores (
        retailer TEXT NOT NULL, zip TEXT NOT NULL, fetched_at INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (retailer, zip)
      ) WITHOUT ROWID;
      -- The current store prices that are deals, rebuilt by refreshMarkdowns(), so
      -- pages don't scan every current price (11s at 800k rows).
      CREATE TABLE IF NOT EXISTS store_markdowns (
        retailer TEXT NOT NULL, store_id TEXT NOT NULL, item_id TEXT NOT NULL, date TEXT NOT NULL,
        price REAL NOT NULL,
        ref_price REAL, -- what the discount is measured against
        was_price REAL, in_stock INTEGER,
        kind TEXT NOT NULL, -- clearance | rollback | reduced | offer (rollback or reduced) | markdown
        PRIMARY KEY (retailer, store_id, item_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS store_markdowns_by_item ON store_markdowns (retailer, item_id);
    `);
    const priceCols = '(retailer, store_id, item_id, date, price, was_price, in_stock, seller, clearance)';
    const priceUpdates = (table) => `price = excluded.price, was_price = excluded.was_price, in_stock = excluded.in_stock,
      seller = excluded.seller, clearance = COALESCE(excluded.clearance, ${table}.clearance)`;
    this.getLatest = db.prepare(`SELECT price, was_price, in_stock, seller, clearance FROM store_latest
      WHERE retailer = ? AND store_id = ? AND item_id = ?`);
    this.upsertPrice = db.prepare(`INSERT INTO store_prices ${priceCols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, store_id, item_id, date) DO UPDATE SET ${priceUpdates('store_prices')}`);
    const changed = 'excluded.price IS NOT NULL AND store_latest.price IS NOT NULL AND excluded.price <> store_latest.price';
    this.upsertLatest = db.prepare(`INSERT INTO store_latest ${priceCols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, store_id, item_id) DO UPDATE SET date = excluded.date,
        prev_price = CASE WHEN ${changed} THEN store_latest.price ELSE store_latest.prev_price END,
        prev_date = CASE WHEN ${changed} THEN store_latest.date ELSE store_latest.prev_date END,
        ${priceUpdates('store_latest')}
      WHERE excluded.date >= store_latest.date`);
    this.upsertItem = db.prepare(`INSERT INTO store_items (retailer, item_id, title, image_url, department) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET title = COALESCE(excluded.title, store_items.title),
        image_url = COALESCE(excluded.image_url, store_items.image_url), department = COALESCE(excluded.department, store_items.department)`);
    this.setListPrice = db.prepare(`INSERT INTO store_items (retailer, item_id, msrp) VALUES (?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET msrp = excluded.msrp`);
    this.setOnline = db.prepare(`INSERT INTO store_items (retailer, item_id, online_price, online_date) VALUES (?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET online_price = excluded.online_price, online_date = excluded.online_date`);
    this.setOnlineLookup = db.prepare(`INSERT INTO store_items
      (retailer, item_id, online_price, online_date, online_was, online_only, online_available, online_lookup_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (retailer, item_id) DO UPDATE SET online_price = excluded.online_price, online_date = excluded.online_date,
        online_was = excluded.online_was, online_only = COALESCE(excluded.online_only, store_items.online_only),
        online_available = excluded.online_available, online_lookup_date = excluded.online_lookup_date`);
    this.getItem = db.prepare('SELECT * FROM store_items WHERE retailer = ? AND item_id = ?');
  }

  // ---- saving ---------------------------------------------------------------

  /**
   * Save what a store lookup returned: item details, and each price (the
   * current-price table always; the change log only when something changed).
   * @param {{ itemId, title?, imageUrl?, category?, listPrice?, price, wasPrice?, clearance?, inStock?, seller }[]} rows
   */
  recordStorePrices(retailer, storeId, rows, date = new Date().toISOString().slice(0, 10)) {
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        const id = String(r.itemId);
        this.upsertItem.run(retailer, id, r.title ?? null, r.imageUrl ?? null, r.category ?? null);
        if (r.listPrice > 0) this.setListPrice.run(retailer, id, r.listPrice);
        const values = [retailer, storeId, id, date, r.price ?? null, r.wasPrice ?? null, flag(r.inStock), r.seller ?? null, flag(r.clearance)];
        const [, , , , price, wasPrice, inStock, seller, clearance] = values;
        const prev = this.getLatest.get(retailer, storeId, id);
        const same = prev && prev.price === price && prev.was_price === wasPrice && prev.in_stock === inStock
          && prev.seller === seller && (clearance === null || prev.clearance === clearance);
        if (!same) this.upsertPrice.run(...values);
        this.upsertLatest.run(...values);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Save a store lookup's result: prices of the items found there, and items
   * that turned out to be sold online only (marked, and their store prices
   * forgotten). Returns how many prices were saved.
   * @param {{ found: object[], onlineOnly?: string[] }} lookup  WalmartLiveSource.storeLookup's result
   */
  recordStoreLookup(retailer, storeId, { found, onlineOnly = [] }, date) {
    this.recordStorePrices(retailer, storeId, found, date);
    if (onlineOnly.length) {
      this.markOnlineOnly(retailer, onlineOnly);
      this.dropItems(retailer, onlineOnly);
    }
    return found.length;
  }

  /** Walmart's own online price for an item as seen on `date` (from a Walmart-sold search or feed result). */
  saveOnlinePrice(retailer, itemId, price, date) {
    this.setOnline.run(retailer, String(itemId), price > 0 ? price : null, date);
    this.onlineVersion += 1;
  }

  /**
   * Save the online lookup of an item: Walmart.com's price and was-price when
   * Walmart is the online seller (else no price: a marketplace offer), and
   * whether Walmart sells it online only / has it available online.
   * @param {{ isWalmart: boolean, price?: number, wasPrice?: number, onlineOnly?: boolean, availableOnline?: boolean }|undefined} o
   */
  saveOnlineLookup(retailer, itemId, o, date) {
    const walmart = o?.isWalmart === true;
    this.setOnlineLookup.run(retailer, String(itemId), walmart && o.price > 0 ? o.price : null, date,
      walmart && o.wasPrice > o.price ? o.wasPrice : null,
      o ? (o.onlineOnly ? 1 : 0) : null, walmart ? (o.availableOnline ? 1 : 0) : null, date);
    this.onlineVersion += 1;
  }

  /** Mark items as sold online only (a store lookup said so). */
  markOnlineOnly(retailer, ids) {
    const mark = this.db.prepare(`INSERT INTO store_items (retailer, item_id, online_only) VALUES (?, ?, 1)
      ON CONFLICT (retailer, item_id) DO UPDATE SET online_only = 1`);
    for (const id of ids) mark.run(retailer, String(id));
    this.onlineVersion += 1;
  }

  /** Forget items' current store prices everywhere (e.g. Walmart sells them online only). */
  dropItems(retailer, ids) {
    const latest = this.db.prepare('DELETE FROM store_latest WHERE retailer = ? AND item_id = ?');
    const marks = this.db.prepare('DELETE FROM store_markdowns WHERE retailer = ? AND item_id = ?');
    for (const id of ids) {
      latest.run(retailer, String(id));
      marks.run(retailer, String(id));
    }
    this.markdownVersion += 1;
  }

  saveZipStores(retailer, zip, stores, now = Date.now()) {
    this.db.prepare(`INSERT INTO zip_stores (retailer, zip, fetched_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (retailer, zip) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`)
      .run(retailer, String(zip), now, JSON.stringify(stores));
  }

  // ---- deal labels -----------------------------------------------------------

  /** Rebuild store_markdowns at startup if it's empty but prices exist, or the labeling rules changed. */
  ensureMarkdowns(retailer) {
    const has = this.db.prepare('SELECT 1 FROM store_markdowns WHERE retailer = ? LIMIT 1').get(retailer);
    const prices = this.db.prepare('SELECT 1 FROM store_latest WHERE retailer = ? LIMIT 1').get(retailer);
    const rulesChanged = this.getMeta(`markdownRules:${retailer}`) !== MARKDOWN_RULES;
    if ((!has || rulesChanged) && prices) this.refreshMarkdowns(retailer);
    this.setMeta(`markdownRules:${retailer}`, MARKDOWN_RULES);
  }

  /**
   * Rebuild store_markdowns from the current Walmart-sold prices. Each store
   * price gets at most one label, in this order:
   *  - clearance: Walmart's Clearance flag at that store;
   *  - rollback / reduced: on today's Walmart Rollback or Reduced Price list
   *    (tier 2) and below its was-price at that store;
   *  - markdown (ours): at least MARKDOWN_GAP below the item's highest valid
   *    store price (current, Walmart-sold, at any store, or this store's own
   *    price before its last change within `days`), where a price above the
   *    item's list price (msrp or highest was-price) isn't valid, and the
   *    reference is capped at Walmart's own online price. The discount is
   *    measured against that reference.
   * A store price above Walmart's own online price gets no label at all
   * (buying online is cheaper), and a was-price alone isn't a deal (Walmart
   * shows reference prices on items with no offer). About 1s at 800k prices;
   * runs a few times an hour during checks.
   */
  refreshMarkdowns(retailer, { days = PRICE_DAYS, now = Date.now(), gap = this.markdownGap } = {}) {
    const since = dayBefore(now, days);
    // Today's Rollback / Reduced Price list (tier 2), once the tier lists exist.
    const tier2Run = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tier_items'").get()
      ? this.getMeta(`tierBuilt:${retailer}:2`) : null;
    const offers = tier2Run
      ? "SELECT item_id, MAX(COALESCE(offer, 'offer')) offer FROM tier_items WHERE retailer = :retailer AND tier = 2 AND run = :run GROUP BY item_id"
      : 'SELECT NULL item_id, NULL offer WHERE 0';
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM store_markdowns WHERE retailer = ?').run(retailer);
      this.db.prepare(`INSERT INTO store_markdowns (retailer, store_id, item_id, date, price, ref_price, was_price, in_stock, kind)
        WITH
        -- Each item's price spread over all saved prices, read in index order (no
        -- sort): a cheap superset of the items whose current Walmart prices differ
        -- by at least the gap. Only those need their highest valid store price,
        -- taken from current Walmart-sold prices only.
        varying AS MATERIALIZED (
          SELECT item_id FROM store_latest INDEXED BY store_latest_by_item_price
          WHERE retailer = :retailer AND price > 0 GROUP BY item_id HAVING COUNT(*) >= 2 AND MIN(price) <= MAX(price) * (1 - :gap)),
        -- A store price above the item's list price (Walmart's msrp, or the highest
        -- was-price at any store) isn't a valid reference.
        items AS MATERIALIZED (
          SELECT v.item_id, NULLIF(MAX(COALESCE(i.msrp, 0), COALESCE((
            SELECT MAX(w.was_price) FROM store_latest w INDEXED BY store_latest_by_item_price
            WHERE w.retailer = :retailer AND w.item_id = v.item_id AND w.date >= :since AND lower(w.seller) ${SOLD_BY_WALMART}), 0)), 0) ceiling
          FROM varying v LEFT JOIN store_items i ON i.retailer = :retailer AND i.item_id = v.item_id),
        top AS (
          SELECT p.item_id, MAX(p.price) high, COUNT(*) n
          FROM items v CROSS JOIN store_latest p INDEXED BY store_latest_by_item_price
            ON p.retailer = :retailer AND p.item_id = v.item_id AND p.price > 0
          WHERE p.date >= :since AND lower(p.seller) ${SOLD_BY_WALMART} AND (v.ceiling IS NULL OR p.price <= v.ceiling)
          GROUP BY p.item_id HAVING COUNT(*) >= 2),
        offers AS (${offers}),
        -- Rows that could get a label (before the online-price checks).
        cand AS (
          SELECT c.store_id, c.item_id, c.date, c.price, c.was_price, c.in_stock, c.clearance, o.offer, t.high top_high,
            CASE WHEN c.prev_date >= :since AND c.prev_price > c.price THEN c.prev_price END prev
          FROM store_latest c LEFT JOIN top t ON t.item_id = c.item_id LEFT JOIN offers o ON o.item_id = c.item_id
          WHERE c.retailer = :retailer AND c.date >= :since AND c.price > 0 AND lower(c.seller) ${SOLD_BY_WALMART}
            AND (c.clearance = 1 OR (o.offer IS NOT NULL AND c.was_price > c.price) OR c.price <= t.high * (1 - :gap)
              OR (c.prev_date >= :since AND c.price <= c.prev_price * (1 - :gap)))),
        -- Walmart's own online price (recent) and the item's list price.
        priced AS (
          SELECT c.*, CASE WHEN i.online_date >= :since AND i.online_price > 0 THEN i.online_price END online,
            NULLIF(MAX(COALESCE(i.msrp, 0), COALESCE(c.was_price, 0)), 0) ceiling
          FROM cand c LEFT JOIN store_items i ON i.retailer = :retailer AND i.item_id = c.item_id),
        -- The highest valid store price (any store's, or this store's own earlier
        -- price, within the list price), capped at Walmart's online price.
        reffed AS (
          SELECT *, MIN(
            MAX(COALESCE(top_high, 0), CASE WHEN prev <= COALESCE(ceiling, prev) THEN prev ELSE 0 END),
            COALESCE(online, 1e18)) high
          FROM priced),
        labeled AS (
          SELECT *,
            CASE
              WHEN online IS NOT NULL AND price > online THEN NULL -- cheaper online: not a deal
              WHEN clearance = 1 THEN 'clearance'
              WHEN offer IS NOT NULL AND was_price > price THEN offer
              WHEN price <= high * (1 - :gap) THEN 'markdown'
            END kind
          FROM reffed)
        SELECT :retailer, store_id, item_id, date, price,
          -- What the discount is measured against: Walmart's was-price for its own
          -- offers, else (and for Markdowns) the highest valid store price.
          CASE
            WHEN kind <> 'markdown' AND was_price > price THEN was_price
            WHEN high > price THEN high
          END,
          CASE WHEN was_price > price THEN was_price END, in_stock, kind
        FROM labeled WHERE kind IS NOT NULL`)
        .run({ retailer, since, gap, ...(tier2Run ? { run: tier2Run } : {}) });
      this.db.exec('COMMIT');
      this.markdownVersion += 1;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- reading -----------------------------------------------------------------

  /** Deals at the given stores, with item title, image and department. */
  markdownRows(retailer, storeIds) {
    if (!storeIds.length) return [];
    const marks = storeIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT m.*, i.title, i.image_url, i.department FROM store_markdowns m
      LEFT JOIN store_items i ON i.retailer = m.retailer AND i.item_id = m.item_id
      WHERE m.retailer = ? AND m.store_id IN (${marks})`).all(retailer, ...storeIds);
  }

  /** Each store's deal label for an item: store_id -> { kind, ref_price }. */
  itemMarkdowns(retailer, itemId) {
    const rows = this.db.prepare('SELECT store_id, kind, ref_price FROM store_markdowns WHERE retailer = ? AND item_id = ?')
      .all(retailer, String(itemId));
    return new Map(rows.map((r) => [r.store_id, r]));
  }

  /** Each item's highest deal reference price at any store (was-price or highest store price): item_id -> price. */
  itemReferences(retailer) {
    const rows = this.db.prepare('SELECT item_id, MAX(ref_price) ref FROM store_markdowns WHERE retailer = ? AND ref_price > 0 GROUP BY item_id')
      .all(retailer);
    return new Map(rows.map((r) => [r.item_id, r.ref]));
  }

  /** Items with a deal at any store. */
  candidateItems(retailer) {
    return this.db.prepare('SELECT DISTINCT item_id FROM store_markdowns WHERE retailer = ?').all(retailer).map((r) => r.item_id);
  }

  /** Items with a store-only deal at any store: Walmart's Clearance flag there, or a Markdown. */
  storeLevelItems(retailer) {
    return this.db.prepare(`SELECT DISTINCT item_id FROM store_markdowns WHERE retailer = ? AND kind IN ('clearance', 'markdown')`)
      .all(retailer).map((r) => r.item_id);
  }

  /** Current prices of one item at the given stores, from the last `days` days. */
  latestPrices(retailer, storeIds, itemId, { days = PRICE_DAYS, now = Date.now() } = {}) {
    if (!storeIds.length) return [];
    const marks = storeIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT store_id, date, price, was_price, in_stock, seller, clearance FROM store_latest
      WHERE retailer = ? AND date >= ? AND store_id IN (${marks}) AND item_id = ?`)
      .all(retailer, dayBefore(now, days), ...storeIds, String(itemId));
  }

  /** Stores where Walmart itself sells an item, cheapest first (current prices from the last `days` days). */
  walmartStoreOffers(retailer, itemId, { days = PRICE_DAYS, now = Date.now() } = {}) {
    return this.db.prepare(`SELECT store_id, date, price, was_price, in_stock FROM store_latest INDEXED BY store_latest_by_item_price
      WHERE retailer = ? AND item_id = ? AND date >= ? AND lower(seller) ${SOLD_BY_WALMART}
      ORDER BY price`).all(retailer, String(itemId), dayBefore(now, days));
  }

  /** An item's saved details and Walmart.com offer (a store_items row), or undefined. */
  item(retailer, itemId) {
    return this.getItem.get(retailer, String(itemId));
  }

  /** store_items rows for many items: id -> row (items never seen are left out). */
  items(retailer, itemIds) {
    this.getItems ??= this.db.prepare('SELECT s.* FROM json_each(?) j CROSS JOIN store_items s ON s.retailer = ? AND s.item_id = j.value');
    return new Map(this.getItems.all(JSON.stringify(itemIds.map(String)), retailer).map((r) => [r.item_id, r]));
  }

  /** True when Walmart itself sells the item at some checked store. */
  soldInStores(retailer, itemId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM store_latest INDEXED BY store_latest_by_item_price
      WHERE retailer = ? AND item_id = ? AND lower(seller) ${SOLD_BY_WALMART} LIMIT 1`).get(retailer, String(itemId)));
  }

  /** Items Walmart sells online only (from the online lookup or a store lookup). */
  isOnlineOnly(retailer, itemId) {
    return this.item(retailer, itemId)?.online_only === 1;
  }

  /**
   * Keep the ids whose department (from earlier store checks) is in
   * `departments`; items with no known department are kept.
   */
  inDepartments(retailer, ids, departments) {
    if (!departments?.length) return ids;
    const allowed = new Set(departments);
    return ids.filter((id) => {
      const d = this.item(retailer, id)?.department;
      return !d || allowed.has(d);
    });
  }

  /**
   * Items needing today's online lookup: those with a deal at some store, plus
   * `extraIds` (Walmart's Clearance, Rollback and Reduced Price lists).
   */
  itemsNeedingOnlinePrice(retailer, day, extraIds = []) {
    return [...new Set([...this.candidateItems(retailer), ...extraIds.map(String)])]
      .filter((id) => !(this.item(retailer, id)?.online_lookup_date >= day));
  }

  /**
   * Items the store checks have seen whose title has every word of `query`
   * (any order, any case). For the product search.
   */
  searchItems(retailer, query, { limit = 25 } = {}) {
    const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
    if (!words.length) return [];
    const like = words.map(() => 'lower(i.title) LIKE ?').join(' AND ');
    return this.db.prepare(`SELECT i.item_id FROM store_items i
      WHERE i.retailer = ? AND i.title IS NOT NULL AND ${like} LIMIT ?`)
      .all(retailer, ...words.map((w) => `%${w.replace(/[%_]/g, '')}%`), limit * 4).map((r) => r.item_id);
  }

  /** A saved store list for a ZIP, if fetched within maxAgeDays. */
  zipStores(retailer, zip, { maxAgeDays = 7, now = Date.now() } = {}) {
    const row = this.db.prepare('SELECT fetched_at, data FROM zip_stores WHERE retailer = ? AND zip = ?').get(retailer, String(zip));
    if (!row || now - row.fetched_at > maxAgeDays * 86400000) return null;
    return JSON.parse(row.data);
  }

  /** Store ids that have current prices. */
  scannedStores(retailer) {
    // Hop from store to store along the primary key instead of reading every price row.
    const next = this.db.prepare('SELECT store_id FROM store_latest WHERE retailer = ? AND store_id > ? ORDER BY store_id LIMIT 1');
    const ids = [];
    for (let row = next.get(retailer, ''); row; row = next.get(retailer, row.store_id)) ids.push(row.store_id);
    return ids;
  }

  /** n = current store prices (one per store and item), items = distinct items. */
  priceCount(retailer) {
    return this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT item_id) items FROM store_latest WHERE retailer = ?').get(retailer);
  }

  // ---- upkeep -------------------------------------------------------------------

  /**
   * Drop prices older than PRICE_DAYS. If the database is still over maxMb (the
   * Render disk is 1 GB), the change log is cut to a week; current prices are kept.
   */
  async prune(now = Date.now(), { maxMb = 700 } = {}) {
    await this.deleteHistoryBefore(dayBefore(now, PRICE_DAYS));
    if (this.sizeMb() - this.freeMb() > maxMb) {
      console.warn(`store prices: database over ${maxMb} MB, keeping 7 days of price history`);
      await this.deleteHistoryBefore(dayBefore(now, 7));
    }
    this.db.prepare('DELETE FROM store_latest WHERE date < ?').run(dayBefore(now, PRICE_DAYS));
    this.db.prepare('DELETE FROM store_markdowns WHERE date < ?').run(dayBefore(now, PRICE_DAYS));
  }

  /** Delete change-log rows dated before `date`, 5,000 at a time so requests aren't held up. */
  async deleteHistoryBefore(date) {
    const chunk = this.db.prepare(`DELETE FROM store_prices WHERE (retailer, store_id, item_id, date) IN
      (SELECT retailer, store_id, item_id, date FROM store_prices INDEXED BY store_prices_by_date WHERE date < ? LIMIT 5000)`);
    while (chunk.run(date).changes) await new Promise((r) => setImmediate(r));
  }

  /** Database file size in MB. */
  sizeMb() {
    const { page_count: pages } = this.db.prepare('PRAGMA page_count').get();
    const { page_size: size } = this.db.prepare('PRAGMA page_size').get();
    return Math.round((pages * size) / 1048576);
  }

  /** Space inside the database file that's free for reuse (after deletes), in MB. */
  freeMb() {
    const { freelist_count: free } = this.db.prepare('PRAGMA freelist_count').get();
    const { page_size: size } = this.db.prepare('PRAGMA page_size').get();
    return Math.round((free * size) / 1048576);
  }

  /**
   * One-time cleanup of tables and settings left by removed features (SerpApi
   * searches, the bulk deal pool, discovery statistics, feed measurements).
   */
  dropLegacy() {
    this.db.exec(`
      DROP TABLE IF EXISTS store_scan_runs;
      DROP TABLE IF EXISTS discovery_finds;
      DROP TABLE IF EXISTS saved_pools;
      DROP TABLE IF EXISTS item_checks;
      DELETE FROM store_scan_meta WHERE key LIKE 'markedDown:%' OR key LIKE 'feedMeasure:%'
        OR key IN ('startedAt', 'testedSettings', 'lastRunSummary', 'sampleResult', 'inspectResults', 'inspectDone', 'sweepDone');
    `);
  }

  /** Small saved values (JSON) by key: checker state, list builds, cursors. */
  setMeta(key, value) {
    this.db.prepare('INSERT INTO store_scan_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM store_scan_meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
}
