// The daily store-check cycle (Chicago time, settings in config/store-scan.json).
// Every step is one Walmart call: a search page, a feed page or a 20-item lookup.
//
//   lists      (schedule.productListAt, 4:00): build the tier 1 (Clearance) and
//              tier 2 (Rollback, Reduced Price) lists from Walmart's search,
//              then from Walmart's deal feeds
//   checks     (from schedule.storeChecksAt, 5:00), in this order:
//                1. tier 1 at the full-check stores (daily + rotating)
//                2. tier 2 at the full-check stores
//                3. other items with a deal at some store (e.g. found via
//                   tier 3) at the full-check stores
//                4. tier 1 + store-only deals (Clearance flag at a store, or a
//                   Markdown) at all other stores
//                5. Walmart.com's price and was-price for every deal item
//   tier3build (schedule.tier3RebuildDay, after checks): rebuild the tier 3
//              list (everything sold in stores) from department and
//              subcategory searches; continues the next day if needed
//   tier3      until schedule.endAt (20:00): the next tier 3 items at the
//              daily stores, continuing from where the previous day stopped
//
// "lists" and "checks" always finish, even past endAt.
// Progress is saved after every step, so a restart resumes where it left off.
import { localParts, scheduleDayKey } from '../../lib/scanSchedule.js';

const FEED_OFFERS = ['clearance', 'rollback', 'reduced']; // specialOffer values of Walmart's deal feeds
const MAX_FEED_PAGES = 600; // safety cap per night over all feeds (about 60 pages measured)
const BATCH = 20; // most item ids per lookup
const TIER3_REFRESH_LOOKUPS = 1000; // tier 3 lookups between deal label rebuilds (~35 minutes)
const REQUIRED = new Set(['lists', 'checks']);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class StoreChecker {
  /**
   * @param {object} opts
   * @param {{ searchPage, request, taxonomy, toProduct, storeLookup, onlinePrices }} opts.source  WalmartLiveSource
   * @param {import('./storePrices.js').StorePrices} opts.db
   * @param {import('./tierLists.js').TierStore} opts.tiers
   * @param {() => {config, errors}} opts.loadConfig  re-read every step, so edits apply without a restart
   * @param {(products: object[]) => void} [opts.onLists]  called with the tier 1/2 products when the lists are built
   */
  constructor({ source, db, tiers, loadConfig, onLists = null, retailer = 'walmart', now = () => new Date(), idleMs = 5 * 60000, errorPauseMs = 60000 }) {
    Object.assign(this, { source, db, tiers, loadConfig, onLists, retailer, now, idleMs, errorPauseMs });
    this.lastError = null;
  }

  // Small progress record, saved after every step; a check segment's item
  // list is saved under its own key when the segment starts.
  get state() {
    return this.db.getMeta('check:state');
  }

  set state(value) {
    this.db.setMeta('check:state', value);
  }

  list(name) {
    if (!this.lists?.[name]) this.lists = { ...this.lists, [name]: this.db.getMeta(`check:${name}`) ?? [] };
    return this.lists[name];
  }

  saveList(name, ids) {
    this.db.setMeta(`check:${name}`, ids);
    this.lists = { ...this.lists, [name]: ids };
  }

  /**
   * Stores that get the full checks on a day: config.dailyStores every day, plus
   * config.rotatingStoresPerDay of the others, taking turns.
   */
  static probeStoresFor(day, config) {
    const ids = config.stores.map((s) => s.id);
    const daily = (config.dailyStores ?? []).filter((id) => ids.includes(id));
    const others = ids.filter((id) => !daily.includes(id));
    const perDay = Math.min(config.rotatingStoresPerDay ?? 1, others.length);
    const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
    const start = others.length ? (dayNumber * perDay) % others.length : 0;
    const rotating = Array.from({ length: perDay }, (_, i) => others[(start + i) % others.length]);
    return [...daily, ...rotating];
  }

  static weekdayOf(day) {
    return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
  }

  hourNow() {
    return localParts(this.now()).hour;
  }

  /** Past the end time: from endAt until the next day's lists start. */
  pastEnd(config) {
    const h = this.hourNow();
    return h >= config.schedule.endHour || h < config.schedule.productListHour;
  }

  /** Search results to keep: items in the settings' departments (or with no department). */
  keepProduct(config) {
    const allowed = new Set(config.departments ?? []);
    return (p) => !allowed.size || !p.category || allowed.has(p.category);
  }

  /** Queue the department searches of a list build: one per department query and filter set. */
  queueSearches(run, config, tiers) {
    this.tiers.dropQueue(run);
    this.tiers.startRun(run, {
      tiers,
      departments: config.departments,
      queriesFor: (d) => config.departmentQueries[d] ?? [d.toLowerCase()],
      baseFilters: config.baseFilters,
    });
  }

  /** Today's cycle: the saved one, or a new one when the day (or config.restartChecks) changes. */
  ensureCycle(config) {
    const day = scheduleDayKey(this.now(), config.schedule.productListHour);
    const current = this.state;
    const restart = config.restartChecks && this.db.getMeta('check:restartDone') !== config.restartChecks;
    if (current?.day === day && !restart) return current;
    // Yesterday's lists and checks always finish before a new day starts.
    if (current && REQUIRED.has(current.phase) && !restart) return current;
    if (restart) this.db.setMeta('check:restartDone', config.restartChecks);

    const listRun = `${day}:t12`;
    this.queueSearches(listRun, config, [
      { tier: 1, filterSets: config.tierFilters[1].map((f) => [f]) },
      { tier: 2, filterSets: config.tierFilters[2].map((f) => [f]) },
    ]);
    this.state = {
      day, phase: 'lists', listRun, searches: 0, feeds: null,
      probeStores: StoreChecker.probeStoresFor(day, config), segment: 0, offset: 0, segmentTotal: null,
      lookups: 0, rows: 0, tier3Lookups: 0,
      startedAt: this.now().toISOString(), listsDoneAt: null, checksDoneAt: null, finishedAt: null,
    };
    return this.state;
  }

  /** The check segments, in order. Each list is read when its segment starts. */
  segments(state, config) {
    const full = state.probeStores;
    const others = config.stores.map((s) => s.id).filter((id) => !full.includes(id));
    const t1 = () => this.tiers.itemIds(1);
    const t2 = () => this.tiers.itemIds(2);
    return [
      { name: 'tier 1 at full-check stores', stores: full, ids: t1 },
      { name: 'tier 2 at full-check stores', stores: full, ids: () => { const s = new Set(t1()); return t2().filter((id) => !s.has(id)); } },
      { name: 'other deal items at full-check stores', stores: full, ids: () => {
        const s = new Set([...t1(), ...t2()]);
        return this.db.candidateItems(this.retailer).filter((id) => !s.has(id));
      } },
      { name: 'tier 1 and store-only deals at other stores', stores: others, ids: () => [
        ...new Set([...t1(), ...this.db.storeLevelItems(this.retailer)]),
      ] },
      // A store price above Walmart.com's isn't a deal (see refreshMarkdowns), and the
      // tier 1/2 lists are the online deals, which need Walmart.com's was-price.
      { name: 'online prices for deal items', online: true, stores: ['walmart.com'],
        ids: () => this.db.itemsNeedingOnlinePrice(this.retailer, state.day, [...t1(), ...t2()]) },
    ];
  }

  /** Do one step. Returns false when there's nothing to do right now. */
  async step() {
    const { config, errors } = this.loadConfig();
    if (!config || errors.length || !config.stores.length) return false;
    this.db.markdownGap = config.markdownGap;
    const state = this.ensureCycle(config);
    switch (state.phase) {
      case 'lists': return this.listsStep(state, config);
      case 'checks': return this.checksStep(state, config);
      case 'tier3build': return this.tier3BuildStep(state, config);
      case 'tier3': return this.tier3Step(state, config);
      default: return false; // done for today
    }
  }

  /** One search or feed page of the tier 1/2 lists; then the lists become current. */
  async listsStep(state, config) {
    const keep = this.keepProduct(config);
    const job = this.tiers.nextJob(state.listRun);
    if (job) {
      await this.tiers.runJob(state.listRun, job, this.source, { keep });
      this.state = { ...state, searches: state.searches + 1 };
      return true;
    }
    // Then Walmart's deal feeds (sold by Walmart only): they and the search each
    // find thousands of deal items the other doesn't, including Walmart.com-only deals.
    if (config.dealFeeds) {
      if (!state.feeds) {
        const categories = new Map((await this.source.taxonomy()).map((c) => [c.name, c.id]));
        const jobs = config.departments.filter((d) => categories.has(d))
          .flatMap((department) => FEED_OFFERS.map((offer) => ({ department, category: categories.get(department), offer })));
        this.state = { ...state, feeds: { jobs, index: 0, query: null, pages: 0, items: 0, otherSeller: 0, added: 0, alreadyListed: 0, skipped: 0 } };
        return true;
      }
      const f = state.feeds;
      if (f.index < f.jobs.length) {
        const feed = f.jobs[f.index];
        const query = f.query ?? { category: feed.category, specialOffer: feed.offer, soldByWmt: 'true' };
        const data = await this.source.request('/paginated/items', query, { cache: false });
        const got = this.tiers.addFeedItems(state.listRun, feed, data?.items, { toProduct: (item) => this.source.toProduct(item), keep });
        // nextPage is a path whose query string asks for the following page.
        let next = data?.nextPage ? Object.fromEntries(new URL(data.nextPage, 'https://x.invalid').searchParams) : null;
        if (next) delete next.publisherId;
        if (f.pages + 1 >= MAX_FEED_PAGES) next = null;
        this.state = {
          ...state,
          feeds: {
            ...f, index: next ? f.index : f.index + 1, query: next, pages: f.pages + 1,
            items: f.items + got.items, otherSeller: f.otherSeller + got.otherSeller, added: f.added + got.added,
            alreadyListed: f.alreadyListed + got.alreadyListed, skipped: f.skipped + got.skipped,
          },
        };
        return true;
      }
    }
    this.tiers.markBuilt(1, state.listRun);
    this.tiers.markBuilt(2, state.listRun);
    this.tiers.dropOldProducts(state.listRun);
    this.onLists?.([...this.tiers.products().values()]);
    this.state = { ...state, phase: 'checks', listsDoneAt: this.now().toISOString(), tier1: this.tiers.count(1), tier2: this.tiers.count(2) };
    return true;
  }

  /** One lookup of the current check segment (20 items at one store, or online). */
  async checksStep(state, config) {
    // Store checks start at storeChecksAt (unless this is yesterday's cycle catching up).
    const today = scheduleDayKey(this.now(), config.schedule.productListHour);
    const hour = this.hourNow();
    if (state.day === today && hour < config.schedule.storeChecksHour && hour >= config.schedule.productListHour) return false;
    const seg = this.segments(state, config)[state.segment];
    if (!seg) {
      this.db.refreshMarkdowns(this.retailer); // with today's online prices
      this.state = { ...state, phase: this.tier3Phase(state, config), checksDoneAt: this.now().toISOString() };
      return true;
    }
    if (state.segmentTotal === null) {
      // Fresh deal labels first: the later segments' lists come from them.
      this.db.refreshMarkdowns(this.retailer);
      const ids = this.db.inDepartments(this.retailer, seg.ids(), config.departments);
      this.saveList('segment', ids);
      this.state = { ...state, segmentTotal: ids.length, offset: 0 };
      return true;
    }
    const ids = this.list('segment');
    const batches = Math.ceil(ids.length / BATCH);
    if (state.offset >= batches * seg.stores.length) {
      this.state = { ...state, segment: state.segment + 1, segmentTotal: null, offset: 0 };
      return true;
    }
    const b = state.offset % batches;
    let batch = ids.slice(b * BATCH, b * BATCH + BATCH);
    if (seg.online) {
      const online = await this.source.onlinePrices(batch);
      for (const id of batch) this.db.saveOnlineLookup(this.retailer, id, online.get(String(id)), state.day);
      this.state = { ...state, offset: state.offset + 1, lookups: state.lookups + 1 };
      return true;
    }
    // Items Walmart sells online only have no store price; no call when none are left.
    batch = batch.filter((id) => !this.db.isOnlineOnly(this.retailer, id));
    if (!batch.length) {
      this.state = { ...state, offset: state.offset + 1 };
      return true;
    }
    const storeId = seg.stores[Math.floor(state.offset / batches)];
    const saved = this.db.recordStoreLookup(this.retailer, storeId, await this.source.storeLookup(batch, storeId), state.day);
    this.state = { ...state, offset: state.offset + 1, lookups: state.lookups + 1, rows: state.rows + saved };
    return true;
  }

  /** One search page of the weekly tier 3 rebuild; then the new list becomes current. */
  async tier3BuildStep(state, config) {
    const run = this.db.getMeta(`tier3:building:${this.retailer}`);
    if (!run) {
      this.state = { ...state, phase: 'tier3' };
      return true;
    }
    if (this.pastEnd(config)) return this.finish(state);
    // Once per rebuild: also search every subcategory of the departments by name
    // (queued after the department searches; the queue survives restarts).
    const subKey = `tier3:subcats:${this.retailer}:${run}`;
    if (config.tier3Subcategories && this.db.getMeta(subKey) == null) {
      const n = this.tiers.enqueueSubcategories(run, {
        tier: 3, taxonomy: await this.source.taxonomy(), departments: config.departments, baseFilters: config.baseFilters,
      });
      this.db.setMeta(subKey, n);
      return true;
    }
    const job = this.tiers.nextJob(run);
    if (job) {
      await this.tiers.runJob(run, job, this.source, { keep: this.keepProduct(config) });
      this.state = { ...state, searches: state.searches + 1 };
      return true;
    }
    this.tiers.markBuilt(3, run);
    this.db.setMeta(`tier3:building:${this.retailer}`, null);
    this.db.setMeta(`tier3:cursor:${this.retailer}`, '');
    this.state = { ...state, phase: 'tier3' };
    return true;
  }

  /** One lookup of the tier 3 checks: the current 20 items at each daily store in turn. */
  async tier3Step(state, config) {
    const daily = config.dailyStores.filter((id) => config.stores.some((s) => s.id === id));
    if (this.pastEnd(config) || !daily.length) return this.finish(state);
    let slice = state.tier3Slice;
    if (!slice || slice.storeIndex >= daily.length) {
      const ids = this.tier3Ids(this.db.getMeta(`tier3:cursor:${this.retailer}`) ?? '', config);
      if (!ids.length) return this.finish(state);
      slice = { ids, storeIndex: 0 };
    }
    const storeId = daily[slice.storeIndex];
    const saved = this.db.recordStoreLookup(this.retailer, storeId, await this.source.storeLookup(slice.ids, storeId), state.day);
    this.state = {
      ...state, tier3Slice: { ...slice, storeIndex: slice.storeIndex + 1 },
      tier3Lookups: state.tier3Lookups + 1, rows: state.rows + saved,
    };
    // Add tier 3 finds to the deal lists as it runs (about every 35 minutes).
    if ((state.tier3Lookups + 1) % TIER3_REFRESH_LOOKUPS === 0) this.db.refreshMarkdowns(this.retailer);
    return true;
  }

  /**
   * The next BATCH tier 3 items after the cursor that are worth a store
   * lookup (in the settings' departments, not online only), wrapping around
   * at the end of the list. Moves the cursor.
   */
  tier3Ids(cursor, config) {
    const ids = [];
    let at = cursor;
    let wrapped = !cursor;
    for (let tries = 0; ids.length < BATCH && tries < 50; tries += 1) {
      let candidates = this.tiers.tier3Batch(at, BATCH * 5);
      if (!candidates.length) {
        if (wrapped) break;
        wrapped = true;
        at = '';
        candidates = this.tiers.tier3Batch(at, BATCH * 5);
        if (!candidates.length) break;
      }
      for (const id of this.db.inDepartments(this.retailer, candidates, config.departments).filter((x) => !this.db.isOnlineOnly(this.retailer, x))) {
        if (ids.length >= BATCH) break;
        if (wrapped && cursor && id > cursor) break; // a full lap
        ids.push(id);
        at = id;
      }
      if (ids.length < BATCH) at = candidates.at(-1);
      if (wrapped && cursor && at >= cursor) break;
    }
    if (ids.length) this.db.setMeta(`tier3:cursor:${this.retailer}`, ids.at(-1));
    return ids;
  }

  /** After checks: rebuild tier 3 on its day (or continue a rebuild), else go straight to tier 3 slices. */
  tier3Phase(state, config) {
    const key = `tier3:building:${this.retailer}`;
    const building = this.db.getMeta(key);
    const lastStarted = this.db.getMeta(`tier3:lastStarted:${this.retailer}`);
    const due = StoreChecker.weekdayOf(state.day) === config.schedule.tier3RebuildDay && lastStarted !== state.day;
    const neverBuilt = !this.tiers.builtRun(3) && !building;
    if (!building && (due || neverBuilt)) {
      const run = `${state.day}:t3`;
      this.queueSearches(run, config, [{ tier: 3, filterSets: [[]] }]);
      this.db.setMeta(key, run);
      this.db.setMeta(`tier3:lastStarted:${this.retailer}`, state.day);
    }
    return this.db.getMeta(key) ? 'tier3build' : 'tier3';
  }

  /** End the day's cycle. Returns false (nothing more to do today). */
  finish(state) {
    this.state = { ...state, phase: 'done', finishedAt: this.now().toISOString() };
    this.db.refreshMarkdowns(this.retailer);
    console.log(`store check ${state.day}: done (${state.lookups} check lookups, ${state.tier3Lookups} tier 3 lookups)`);
    return false;
  }

  start() {
    const loop = async () => {
      for (;;) {
        let worked = false;
        try {
          worked = await this.step();
          this.lastError = null;
        } catch (err) {
          this.lastError = { at: this.now().toISOString(), message: err.message.slice(0, 200) };
          console.warn(`store check: ${err.message}`);
          await new Promise((r) => setTimeout(r, this.errorPauseMs));
          continue;
        }
        // Calls are paced by the Walmart client's throttle; idle while there's nothing to do.
        if (!worked) await new Promise((r) => setTimeout(r, this.idleMs));
      }
    };
    loop();
  }

  status() {
    const s = this.state;
    if (!s) return { state: 'not started yet' };
    const { config } = this.loadConfig();
    const segs = config ? this.segments(s, config).map((x) => x.name) : [];
    const building = this.db.getMeta(`tier3:building:${this.retailer}`);
    return {
      day: s.day,
      phase: s.phase,
      lists: {
        searches: s.searches, queued: this.tiers.queueSize(s.listRun),
        tier1: s.tier1 ?? this.tiers.count(1), tier2: s.tier2 ?? this.tiers.count(2), doneAt: s.listsDoneAt,
        // Walmart's deal feeds, read after the search: what they added, and what the search had already found.
        feeds: s.feeds ? {
          feedsDone: s.feeds.index, feedsTotal: s.feeds.jobs.length, pages: s.feeds.pages, items: s.feeds.items,
          addedBeyondSearch: s.feeds.added, alreadyFoundBySearch: s.feeds.alreadyListed, otherSeller: s.feeds.otherSeller, otherDepartments: s.feeds.skipped,
        } : null,
      },
      checks: {
        fullCheckStores: s.probeStores,
        segment: s.phase === 'checks' ? `${s.segment + 1} of ${segs.length}: ${segs[s.segment] ?? '-'}` : null,
        segmentItems: s.segmentTotal,
        segmentLookupsDone: s.phase === 'checks' ? s.offset : null,
        lookups: s.lookups, doneAt: s.checksDoneAt,
      },
      tier3: {
        listItems: this.tiers.count(3),
        rebuilding: building ? {
          run: building, queued: this.tiers.queueSize(building), found: this.tiers.count(3, building),
          subcategories: this.db.getMeta(`tier3:subcats:${this.retailer}:${building}`),
        } : null,
        cursor: this.db.getMeta(`tier3:cursor:${this.retailer}`), lookupsToday: s.tier3Lookups,
      },
      storePricesSaved: s.rows,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      lastError: this.lastError,
    };
  }
}
