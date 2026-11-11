import { NOT_SUBCATEGORY } from './tierLists.js';

// One-off measurements of Walmart's bulk feeds (/paginated/items) against our
// search-built tier lists:
//  - deals: the Clearance, Rollback and Reduced Price feeds for each configured
//    department; possible Walmart items are checked at one store and compared
//    with tiers 1-3.
//  - tier3: the unfiltered department feeds (everything), capped per
//    department; a sample is checked at the store and compared with tier 3.
// Runs in the background through the same throttled client as everything else,
// waits through rate limits, and can be scheduled (the plan is saved, so a
// restart re-runs an unfinished measurement).

const DEAL_OFFERS = ['clearance', 'rollback', 'reduced'];
// Walmart's own store brands, for the Tier 3 sources measurement.
export const STORE_BRANDS = [
  'Mainstays', 'Better Homes & Gardens', 'Great Value', 'Hyper Tough', 'Ozark Trail', 'onn.', 'Pen+Gear', 'Holiday Time',
  'Way To Celebrate', 'Your Zone', 'The Pioneer Woman', 'Beautiful', 'Gap Home', 'Allswell', 'Thyme & Table', 'Hart', 'Blackweb',
  'Marketside', "Sam's Choice", 'bettergoods', 'Freshness Guaranteed', 'Play Day', 'Kid Connection', 'Adventure Force', 'My Life As',
  'Athletic Works', 'EverStart', 'SuperTech', 'Auto Drive', 'Expert Grill', 'Backyard Grill', 'Spark. Create. Imagine.',
];
const BATCH = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FeedMeasure {
  /**
   * @param {{ source, db: import('./storeScan.js').StoreScanDb, tiers: import('./tierLists.js').TierStore, loadConfig }} opts
   */
  constructor({ source, db, tiers, loadConfig, retailer = 'walmart', rateLimitWaitMs = 60000, autoResume = true }) {
    Object.assign(this, { source, db, tiers, loadConfig, retailer, rateLimitWaitMs });
    this.key = `feedMeasure:${retailer}`;
    this.state = db.getMeta(this.key) ?? null;
    this.running = false;
    this.timer = null;
    // A saved plan that hasn't finished runs at its time (or now, if that's past).
    const plan = db.getMeta(`${this.key}:plan`);
    if (autoResume && plan) this.schedule(plan);
  }

  status() {
    return {
      running: this.running,
      scheduledFor: this.db.getMeta(`${this.key}:plan`)?.at ?? null,
      ...(this.state ?? { phase: 'not started' }),
    };
  }

  /**
   * Run at `at` (ISO time; default now), stopping by `until` (ISO time) with
   * whatever is done. Saved, so a restart keeps the plan.
   */
  schedule({ at = new Date().toISOString(), storeId = '573', until = null, dealPages = 60, everythingPages = 25, parts = ['deals', 'everything'], lookups = true } = {}) {
    const plan = { at, storeId, until, dealPages, everythingPages, parts, lookups };
    // A measurement already running takes the new stop time.
    if (this.running) {
      this.deadline = until ? Date.parse(until) : Infinity;
      if (this.state) this.state.until = until;
    }
    this.db.setMeta(`${this.key}:plan`, plan);
    clearTimeout(this.timer);
    const wait = Math.max(0, Date.parse(at) - Date.now());
    this.timer = setTimeout(() => this.start(plan), wait);
    this.timer.unref?.();
    return plan;
  }

  start({ storeId = '573', until = null, dealPages = 60, everythingPages = 25, parts = ['deals', 'everything'], lookups = true } = {}) {
    if (this.running) return false;
    this.running = true;
    this.deadline = until ? Date.parse(until) : Infinity;
    // The last finished measurement is kept next to the new one.
    if (this.state?.phase === 'done') this.db.setMeta(`${this.key}:previous`, this.state);
    this.run({ storeId, dealPages, everythingPages, parts, lookups })
      .then(() => this.db.setMeta(`${this.key}:plan`, null))
      .catch((err) => { this.state = { ...this.state, phase: 'failed', error: err.message.slice(0, 300) }; })
      .finally(() => { this.running = false; this.save(); });
    return true;
  }

  save() {
    this.db.setMeta(this.key, this.state);
  }

  /** A Walmart call that waits out rate limits (429) instead of giving up. */
  async call(fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fn();
        this.state.calls += 1;
        return result;
      } catch (err) {
        if (!/\b429\b/.test(err.message) || attempt >= 15) throw err;
        this.state.rateLimitWaits = (this.state.rateLimitWaits ?? 0) + 1;
        await sleep(this.rateLimitWaitMs);
      }
    }
  }

  /** Page through one feed; returns the possible Walmart items (not another seller's). */
  /** Past the stop time: finish with what's done. */
  late() {
    if (Date.now() < (this.deadline ?? Infinity)) return false;
    this.state.stoppedEarly = true;
    return true;
  }

  async readFeed(feed, query, maxPages, onItem) {
    while (query) {
      if (this.late()) break;
      if (feed.pages >= maxPages) { feed.capped = true; break; }
      let data;
      try {
        data = await this.call(() => this.source.request('/paginated/items', query, { cache: false }));
      } catch (err) {
        feed.error = err.message.slice(0, 200);
        break;
      }
      feed.pages += 1;
      for (const item of data?.items ?? []) {
        feed.items += 1;
        const seller = String(item.sellerInfo ?? '').trim();
        if (/^walmart(\.com)?$/i.test(seller)) feed.walmart += 1;
        else if (seller || item.marketplace === true) { feed.otherSeller += 1; continue; }
        else feed.unnamed += 1;
        onItem(String(item.itemId), item);
      }
      query = data?.nextPage ? Object.fromEntries(new URL(data.nextPage, 'https://x.invalid').searchParams) : null;
      if (query) delete query.publisherId;
      if (!query) feed.complete = true;
      if (feed.pages % 10 === 0) this.save();
    }
    this.save();
  }

  /** Check ids at one store (an even sample when there are more than maxLookups batches). */
  async checkAtStore(ids, storeId, maxLookups) {
    const step = Math.max(1, ids.length / (maxLookups * BATCH));
    const sample = step > 1 ? Array.from({ length: Math.floor(ids.length / step) }, (_, i) => ids[Math.floor(i * step)]) : ids;
    const out = { candidates: ids.length, checked: sample.length, sampled: step > 1, walmartInStore: 0, notAtStore: 0, onlineOnly: 0, otherSeller: 0, clearanceFlag: 0 };
    const confirmed = [];
    for (let i = 0; i < sample.length; i += BATCH) {
      if (this.late()) break;
      const batch = sample.slice(i, i + BATCH);
      const { found, missing, onlineOnly } = await this.call(() => this.source.storeLookup(batch, storeId));
      out.notAtStore += missing.length;
      out.onlineOnly += onlineOnly?.length ?? 0;
      for (const f of found) {
        if (!f.isWalmart) { out.otherSeller += 1; continue; }
        out.walmartInStore += 1;
        if (f.clearance) out.clearanceFlag += 1;
        confirmed.push(f.itemId);
      }
      if ((i / BATCH) % 10 === 0) this.save();
    }
    out.scale = sample.length ? ids.length / sample.length : 0;
    return { out, confirmed };
  }

  async run({ storeId, dealPages = 15, everythingPages = 10, parts = ['deals', 'everything'], lookups = true }) {
    const { config } = this.loadConfig();
    const departments = config?.departments ?? [];
    if (parts.includes('tier3sources')) return this.tier3Sources({ storeId, departments });
    this.state = {
      phase: parts.includes('deals') ? 'deal feeds' : 'everything feeds', startedAt: new Date().toISOString(), storeId, dealPages, everythingPages, parts, lookups,
      until: Number.isFinite(this.deadline) ? new Date(this.deadline).toISOString() : null,
      calls: 0, rateLimitWaits: 0, deals: { feeds: [] }, tier3: { feeds: [] },
    };
    const cats = new Map((await this.call(() => this.source.taxonomy())).map((c) => [c.name, c.id]));
    const t1 = new Set(this.tiers.itemIds(1));
    const t2 = new Set(this.tiers.itemIds(2));
    const t3 = new Set(this.tiers.itemIds(3));
    const lists = { tier1: t1.size, tier2: t2.size, tier3: t3.size };

    // 1. Deal feeds: Clearance, Rollback, Reduced Price per department.
    const dealCandidates = new Map(); // id -> { department, offers }
    for (const department of parts.includes('deals') ? departments : []) {
      const category = cats.get(department);
      for (const offer of DEAL_OFFERS) {
        const feed = { department, offer, pages: 0, items: 0, walmart: 0, otherSeller: 0, unnamed: 0, complete: false, capped: false };
        this.state.deals.feeds.push(feed);
        if (!category) { feed.error = 'no Walmart category with this name'; continue; }
        // soldByWmt: Walmart leaves out marketplace listings (99% of the unfiltered Clearance feeds).
        await this.readFeed(feed, { category, specialOffer: offer, soldByWmt: 'true' }, dealPages, (id) => {
          const c = dealCandidates.get(id) ?? { department, offers: [] };
          if (!c.offers.includes(offer)) c.offers.push(offer);
          dealCandidates.set(id, c);
        });
      }
    }
    if (parts.includes('deals') && lookups) {
    this.state.phase = 'deal lookups';
    const deals = await this.checkAtStore([...dealCandidates.keys()], storeId, 400);
    const compare = { inTier1: 0, inTier2: 0, inTier3Only: 0, inNoList: 0 };
    const missedByDepartment = {};
    const missedByOffer = {};
    for (const id of deals.confirmed) {
      if (t1.has(id)) compare.inTier1 += 1;
      else if (t2.has(id)) compare.inTier2 += 1;
      else if (t3.has(id)) compare.inTier3Only += 1;
      else {
        compare.inNoList += 1;
        const c = dealCandidates.get(id);
        missedByDepartment[c?.department ?? '?'] = (missedByDepartment[c?.department ?? '?'] ?? 0) + 1;
        for (const o of c?.offers ?? []) missedByOffer[o] = (missedByOffer[o] ?? 0) + 1;
      }
    }
    Object.assign(this.state.deals, {
      lookups: deals.out, compare, missedByDepartment, missedByOffer,
      estimate: { walmartInStore: Math.round(deals.out.walmartInStore * deals.out.scale), notInAnyList: Math.round(compare.inNoList * deals.out.scale) },
      sampleMissed: deals.confirmed.filter((id) => !t1.has(id) && !t2.has(id) && !t3.has(id)).slice(0, 15),
    });
    }
    this.save();

    // 2. Everything feeds (no deal filter), capped per department, vs tier 3.
    this.state.phase = 'everything feeds';
    const all = new Map(); // id -> department
    for (const department of parts.includes('everything') ? departments : []) {
      const category = cats.get(department);
      const feed = { department, pages: 0, items: 0, walmart: 0, otherSeller: 0, unnamed: 0, complete: false, capped: false };
      this.state.tier3.feeds.push(feed);
      if (!category) { feed.error = 'no Walmart category with this name'; continue; }
      await this.readFeed(feed, { category, soldByWmt: 'true' }, everythingPages, (id) => all.set(id, department));
    }
    // Overlap with tier 3 by item id alone (no lookups needed).
    this.state.tier3.items = all.size;
    this.state.tier3.alsoInTier3 = [...all.keys()].filter((id) => t3.has(id)).length;
    if (!parts.includes('everything') || !lookups) {
      this.state = { ...this.state, phase: 'done', finishedAt: new Date().toISOString(), lists };
      return;
    }
    this.state.phase = 'everything lookups';
    const everything = await this.checkAtStore([...all.keys()], storeId, 150);
    const inTier3 = everything.confirmed.filter((id) => t3.has(id)).length;
    const missedByDept = {};
    for (const id of everything.confirmed) if (!t3.has(id)) missedByDept[all.get(id)] = (missedByDept[all.get(id)] ?? 0) + 1;
    Object.assign(this.state.tier3, {
      lookups: everything.out,
      compare: { inTier3: inTier3, notInTier3: everything.confirmed.length - inTier3 },
      missedByDepartment: missedByDept,
      sampleMissed: everything.confirmed.filter((id) => !t3.has(id)).slice(0, 15),
    });
    this.state = { ...this.state, phase: 'done', finishedAt: new Date().toISOString(), lists };
  }

  /**
   * Which sources would add in-store items to Tier 3:
   *  - subcategory searches: each department's subcategories searched by their
   *    own name within that subcategory, in-store and sold by Walmart (page 1
   *    of each: total results and how many items Tier 3 lacks);
   *  - store-brand feeds: Walmart's own brands (sold by Walmart, available),
   *    kept to the configured departments, a sample checked at the store.
   */
  async tier3Sources({ storeId, departments }) {
    const t3 = new Set(this.tiers.itemIds(3));
    this.state = {
      phase: 'subcategory searches', startedAt: new Date().toISOString(), storeId, parts: ['tier3sources'],
      until: Number.isFinite(this.deadline) ? new Date(this.deadline).toISOString() : null,
      calls: 0, rateLimitWaits: 0, tier3: t3.size, subcategories: [], brands: [],
    };
    const tree = await this.call(() => this.source.taxonomy());
    const filters = ['retailer_type:Walmart', 'fulfillment_method:In-store'];
    // 1. Subcategory searches (national and store brands alike).
    for (const dept of tree.filter((c) => departments.includes(c.name))) {
      for (const subcat of (dept.children ?? []).filter((c) => !NOT_SUBCATEGORY.test(c.name))) {
        if (this.late()) break;
        const row = { department: dept.name, subcategory: subcat.name, id: subcat.id };
        this.state.subcategories.push(row);
        try {
          const data = await this.call(() => this.source.request('/search', {
            query: subcat.name, categoryId: subcat.id, numItems: 25, facet: 'on', 'facet.filter': filters,
          }, { cache: false }));
          const ids = (data?.items ?? []).filter((i) => i?.itemId && i.offerType !== 'ONLINE_ONLY').map((i) => String(i.itemId));
          row.total = Number(data?.totalResults) || 0;
          row.page1 = ids.length;
          row.page1NotInTier3 = ids.filter((id) => !t3.has(id)).length;
          // Estimated for everything reachable (searches stop at 1,000; more needs price bands).
          const reachable = Math.min(row.total, 1000);
          row.estimatedNew = ids.length ? Math.round(reachable * row.page1NotInTier3 / ids.length) : 0;
          row.callsToReadAll = Math.ceil(reachable / 25);
        } catch (err) {
          row.error = err.message.slice(0, 160);
        }
        if (this.state.subcategories.length % 10 === 0) this.save();
      }
    }
    this.save();
    // 2. Store-brand feeds.
    this.state.phase = 'store-brand feeds';
    const keep = new Set(departments);
    const brandItems = new Map(); // id -> brand
    for (const brand of STORE_BRANDS) {
      const feed = { brand, pages: 0, items: 0, walmart: 0, otherSeller: 0, unnamed: 0, inDepartments: 0, notInTier3: 0, complete: false, capped: false };
      this.state.brands.push(feed);
      await this.readFeed(feed, { brand, soldByWmt: 'true', available: 'true' }, 60, (id, item) => {
        const parts = String(item.categoryPath ?? '').split('/').map((x) => x.trim()).filter((x) => x && !/^home ?page$/i.test(x));
        if (!keep.has(parts[0])) return;
        feed.inDepartments += 1;
        if (!t3.has(id)) feed.notInTier3 += 1;
        brandItems.set(id, brand);
      });
    }
    this.state.phase = 'store-brand lookups';
    const notInTier3 = [...brandItems.keys()].filter((id) => !t3.has(id));
    const { out, confirmed } = await this.checkAtStore(notInTier3, storeId, 100);
    const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
    this.state = {
      ...this.state,
      phase: 'done',
      finishedAt: new Date().toISOString(),
      summary: {
        subcategorySearches: {
          subcategories: this.state.subcategories.length,
          totalInStoreResults: sum(this.state.subcategories, 'total'),
          estimatedNewItems: sum(this.state.subcategories, 'estimatedNew'),
          callsToReadAll: sum(this.state.subcategories, 'callsToReadAll'),
          over1000: this.state.subcategories.filter((r) => r.total > 1000).length,
        },
        storeBrands: {
          itemsInDepartments: brandItems.size,
          notInTier3: notInTier3.length,
          lookups: out,
          estimatedNewInStore: Math.round(out.walmartInStore * out.scale),
          sampleNew: confirmed.slice(0, 10),
        },
      },
    };
  }
}
