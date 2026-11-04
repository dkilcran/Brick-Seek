// The daily store-check cycle (Chicago time, settings in config/store-scan.json).
// Every step is one Walmart call: a search page or a 20-item store lookup.
//
//   lists      (schedule.productListAt, 4:00): build the tier 1 (Clearance) and
//              tier 2 (Rollback, Reduced Price) lists from Walmart's search;
//              they also become the home page deal pool
//   checks     (from schedule.storeChecksAt, 5:00), in this order:
//                1. tier 1 at the full-check stores (daily + rotating)
//                2. tier 2 at the full-check stores
//                3. recent markdowns not in tiers 1-2 (e.g. found via tier 3)
//                   at the full-check stores
//                4. tier 1 + store-level markdowns (Clearance flag at a store,
//                   or calculated clearance) at all other stores
//   tier3build (schedule.tier3RebuildDay, after checks): rebuild the tier 3
//              list (everything sold in stores); continues the next day if needed
//   tier3      until schedule.endAt (20:00): the next tier 3 items at the
//              daily stores, continuing from where the previous day stopped
//
// "lists" and "checks" always finish, even past endAt.
// Progress is saved after every step, so a restart resumes where it left off.
import { localParts, scheduleDayKey } from '../../lib/scanSchedule.js';

const BATCH = 20; // most item ids per store lookup
const REQUIRED = new Set(['lists', 'checks']);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class StoreChecker {
  /**
   * @param {object} opts
   * @param {{ storeLookup, searchPage, setPool? }} opts.source  WalmartLiveSource
   * @param {import('./storeScan.js').StoreScanDb} opts.db
   * @param {import('./tierLists.js').TierStore} opts.tiers
   * @param {() => {config, errors}} opts.loadConfig
   */
  constructor({ source, db, tiers, loadConfig, retailer = 'walmart', now = () => new Date(), idleMs = 5 * 60000, errorPauseMs = 60000 }) {
    this.source = source;
    this.db = db;
    this.tiers = tiers;
    this.loadConfig = loadConfig;
    this.retailer = retailer;
    this.now = now;
    this.idleMs = idleMs;
    this.errorPauseMs = errorPauseMs;
    this.lastError = null;
  }

  // Small progress record, saved after every step; item lists are saved
  // under their own keys when a check segment starts.
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

  /** Start today's cycle if it's time. Returns the state, or null if there's nothing to start. */
  ensureCycle(config) {
    const day = scheduleDayKey(this.now(), config.schedule.productListHour);
    const current = this.state;
    // Changing config.restartChecks starts today's cycle over.
    const restart = config.restartChecks && this.db.getMeta('check:restartDone') !== config.restartChecks;
    if (current?.day === day && !restart && current.version === 2) return current;
    // Yesterday's lists and checks always finish before a new day starts.
    if (current?.version === 2 && current.day !== day && REQUIRED.has(current.phase) && !restart) return current;
    if (restart) this.db.setMeta('check:restartDone', config.restartChecks);

    const listRun = `${day}:t12`;
    this.tiers.dropQueue(listRun);
    this.tiers.startRun(listRun, {
      tiers: [
        { tier: 1, filterSets: config.tierFilters[1].map((f) => [f]) },
        { tier: 2, filterSets: config.tierFilters[2].map((f) => [f]) },
      ],
      departments: config.departments,
      queriesFor: (d) => config.departmentQueries[d] ?? [d.toLowerCase()],
      baseFilters: config.baseFilters,
    });
    this.state = {
      version: 2, day, phase: 'lists', listRun, searches: 0,
      probeStores: StoreChecker.probeStoresFor(day, config), segment: 0, offset: 0, segmentTotal: null,
      lookups: 0, rows: 0, tier3Lookups: 0,
      startedAt: this.now().toISOString(), listsDoneAt: null, checksDoneAt: null, finishedAt: null,
    };
    return this.state;
  }

  /** The four check segments, in order. Lists are computed when a segment starts. */
  segments(state, config) {
    const all = config.stores.map((s) => s.id);
    const full = state.probeStores;
    const others = all.filter((id) => !full.includes(id));
    // Lists are only read when a segment starts (ids()), not on every step.
    const t1 = () => this.tiers.itemIds(1);
    const t2 = () => this.tiers.itemIds(2);
    return [
      { name: 'tier 1 at full-check stores', stores: full, ids: t1 },
      { name: 'tier 2 at full-check stores', stores: full, ids: () => { const s = new Set(t1()); return t2().filter((id) => !s.has(id)); } },
      { name: 'recent markdowns at full-check stores', stores: full, ids: () => {
        const s = new Set([...t1(), ...t2()]);
        return this.db.candidateItems(this.retailer).filter((id) => !s.has(id));
      } },
      { name: 'clearance and calculated clearance at other stores', stores: others, ids: () => [
        ...new Set([...t1(), ...this.db.storeLevelItems(this.retailer)]),
      ] },
    ];
  }

  /** Do one step. Returns false when there's nothing to do right now. */
  async step() {
    const { config, errors } = this.loadConfig();
    if (!config || errors.length || !config.stores.length) return false;
    if (config.markdownGap != null) this.db.markdownGap = config.markdownGap;
    const state = this.ensureCycle(config);
    if (!state || state.phase === 'done') return false;

    if (state.phase === 'lists') {
      const job = this.tiers.nextJob(state.listRun);
      if (job) {
        await this.tiers.runJob(state.listRun, job, this.source, { keep: this.keepProduct(config) });
        this.state = { ...state, searches: state.searches + 1 };
        return true;
      }
      this.tiers.markBuilt(1, state.listRun);
      this.tiers.markBuilt(2, state.listRun);
      // The tier 1/2 products become the home page deal pool.
      const products = this.tiers.products(state.listRun);
      if (products.length) this.source.setPool?.(products);
      this.state = { ...state, phase: 'checks', listsDoneAt: this.now().toISOString(), tier1: this.tiers.count(1), tier2: this.tiers.count(2) };
      return true;
    }

    if (state.phase === 'checks') {
      // Store checks start at storeChecksAt (unless this is yesterday's cycle catching up).
      const today = scheduleDayKey(this.now(), config.schedule.productListHour);
      if (state.day === today && this.hourNow() < config.schedule.storeChecksHour && this.hourNow() >= config.schedule.productListHour) return false;
      const segs = this.segments(state, config);
      const seg = segs[state.segment];
      if (!seg) {
        this.state = { ...state, phase: this.tier3Phase(state, config), checksDoneAt: this.now().toISOString() };
        return true;
      }
      if (state.segmentTotal === null) {
        // Fresh markdowns first: the later segments' lists come from them.
        this.db.refreshMarkdowns(this.retailer);
        // Only the departments in the settings (items found earlier in others are skipped).
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
      const storeId = seg.stores[Math.floor(state.offset / batches)];
      const b = state.offset % batches;
      const { found, onlineOnly } = await this.source.storeLookup(ids.slice(b * BATCH, b * BATCH + BATCH), storeId);
      this.db.recordStorePrices(this.retailer, storeId, found, state.day);
      if (onlineOnly?.length) this.db.dropItems(this.retailer, onlineOnly);
      this.state = { ...state, offset: state.offset + 1, lookups: state.lookups + 1, rows: state.rows + found.length };
      return true;
    }

    if (state.phase === 'tier3build') {
      const run = this.db.getMeta(`tier3:building:${this.retailer}`);
      if (!run) {
        this.state = { ...state, phase: 'tier3' };
        return true;
      }
      if (this.pastEnd(config)) {
        this.finish(state);
        return false;
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
      this.state = { ...state, phase: 'tier3', tier3: this.tiers.count(3) };
      return true;
    }

    if (state.phase === 'tier3') {
      if (this.pastEnd(config)) {
        this.finish(state);
        return false;
      }
      const daily = (config.dailyStores ?? []).filter((id) => config.stores.some((s) => s.id === id));
      if (!daily.length) {
        this.finish(state);
        return false;
      }
      // One lookup per step: the current 20 items at each daily store in turn.
      let slice = state.tier3Slice;
      if (!slice || slice.storeIndex >= daily.length) {
        const cursor = this.db.getMeta(`tier3:cursor:${this.retailer}`) ?? '';
        const ids = this.tier3Ids(cursor, config);
        if (!ids.length) {
          this.finish(state);
          return false;
        }
        slice = { ids, storeIndex: 0 };
      }
      const storeId = daily[slice.storeIndex];
      const { found, onlineOnly } = await this.source.storeLookup(slice.ids, storeId);
      this.db.recordStorePrices(this.retailer, storeId, found, state.day);
      if (onlineOnly?.length) this.db.dropItems(this.retailer, onlineOnly);
      this.state = {
        ...state, tier3Slice: { ...slice, storeIndex: slice.storeIndex + 1 },
        tier3Lookups: state.tier3Lookups + 1, rows: state.rows + found.length,
      };
      // Keep "Clearance near you" current while tier 3 runs (~every 7 minutes).
      if ((state.tier3Lookups + 1) % 200 === 0) this.db.refreshMarkdowns(this.retailer);
      return true;
    }
    return false;
  }

  /** Search results to keep: items in the settings' departments (or with no department). */
  keepProduct(config) {
    const allowed = new Set(config.departments ?? []);
    return (p) => !allowed.size || !p.category || allowed.has(p.category);
  }

  /**
   * The next BATCH tier 3 items after the cursor that are in the settings'
   * departments, wrapping around at the end of the list. Moves the cursor.
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
      for (const id of this.db.inDepartments(this.retailer, candidates, config.departments)) {
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
      this.tiers.dropQueue(run);
      this.tiers.startRun(run, {
        tiers: [{ tier: 3, filterSets: [[]] }],
        departments: config.departments,
        queriesFor: (d) => config.departmentQueries[d] ?? [d.toLowerCase()],
        baseFilters: config.baseFilters,
      });
      this.db.setMeta(key, run);
      this.db.setMeta(`tier3:lastStarted:${this.retailer}`, state.day);
    }
    return this.db.getMeta(key) ? 'tier3build' : 'tier3';
  }

  finish(state) {
    this.state = { ...state, phase: 'done', finishedAt: this.now().toISOString() };
    this.db.refreshMarkdowns(this.retailer);
    // Count the day's markdowns once, for /api/walmart/discovery-stats.
    this.db.setMeta(`markedDown:${this.retailer}:${state.day}`, this.db.markedDownCount(this.retailer, state.day));
    console.log(`store check ${state.day}: done (${state.lookups} check lookups, ${state.tier3Lookups} tier 3 lookups)`);
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
        // Calls are paced by the Walmart client's throttle; idle when waiting.
        if (!worked) await new Promise((r) => setTimeout(r, this.idleMs));
      }
    };
    loop();
  }

  status() {
    const s = this.state;
    if (!s || s.version !== 2) return { state: 'not started on the tier schedule yet' };
    const { config } = this.loadConfig();
    const segs = config ? this.segments(s, config).map((x) => x.name) : [];
    const building = this.db.getMeta(`tier3:building:${this.retailer}`);
    return {
      day: s.day,
      phase: s.phase,
      lists: {
        searches: s.searches, queued: this.tiers.queueSize(s.listRun),
        tier1: s.tier1 ?? this.tiers.count(1), tier2: s.tier2 ?? this.tiers.count(2), doneAt: s.listsDoneAt,
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
        rebuilding: building ? { run: building, queued: this.tiers.queueSize(building), found: this.tiers.count(3, building) } : null,
        cursor: this.db.getMeta(`tier3:cursor:${this.retailer}`), lookupsToday: s.tier3Lookups,
      },
      storePricesSaved: s.rows,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      lastError: this.lastError,
    };
  }
}
