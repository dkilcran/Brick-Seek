// Free store-level checks through Walmart's affiliate API (rate-limited).
// The item lookup with a storeId returns that store's price, stock, Clearance
// flag and was-price, but the bulk feeds and search ignore storeId, so each
// day's cycle (starting at config.schedule.storeChecksAt) works in phases:
//   1. discovery: Walmart's search with the configured filters (Clearance,
//      sold by Walmart) for each department, a page at a time, to find items
//      the deal pool may not have;
//   2. probe: every deal-pool and discovered item at the daily stores plus a
//      few rotating ones, to see what's marked down there;
//   3. candidates: every recently marked-down item at every configured store.
// Progress is saved, so a restart resumes where it left off.
import { scheduleDayKey } from '../../lib/scanSchedule.js';

const BATCH = 20; // most item ids per lookup
const SEARCH_PAGE = 25; // most results per search request

export class StoreChecker {
  /**
   * @param {object} opts
   * @param {{ storeLookup, searchClearance?, dealCandidates, poolLoading, poolRefreshing? }} opts.source  WalmartLiveSource
   * @param {import('./storeScan.js').StoreScanDb} opts.db
   * @param {() => {config, errors}} opts.loadConfig
   */
  constructor({ source, db, loadConfig, retailer = 'walmart', now = () => new Date(), idleMs = 10 * 60000, errorPauseMs = 60000 }) {
    this.source = source;
    this.db = db;
    this.loadConfig = loadConfig;
    this.retailer = retailer;
    this.now = now;
    this.idleMs = idleMs;
    this.errorPauseMs = errorPauseMs;
    this.lastError = null;
  }

  // Small progress record, saved after every step; the item lists are saved
  // under their own keys.
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
   * Stores that get the full probe on a day: config.dailyStores every day, plus
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

  /** Discovery runs when the source can search and there's something to search for. */
  discoveryEnabled(config) {
    return Boolean(this.source.searchClearance) && (config.departments?.length ?? 0) > 0 && (config.filters?.length ?? 0) > 0;
  }

  /** Start today's cycle if it's time. Returns the state, or null if it can't start yet. */
  async ensureCycle(config) {
    const day = scheduleDayKey(this.now(), config.schedule?.storeChecksHour ?? 0);
    const current = this.state;
    // Changing config.restartChecks starts today's cycle over with the current plan.
    const restart = config.restartChecks && this.db.getMeta('check:restartDone') !== config.restartChecks;
    if (current?.day === day && !restart) return current;
    // Wait for the deal pool: loading after a restart, or the morning refresh still running.
    if (this.source.poolLoading || this.source.poolRefreshing) return null;
    if (restart) this.db.setMeta('check:restartDone', config.restartChecks);
    this.saveList('discovered', []);
    this.saveList('probeIds', []);
    this.saveList('candidates', []);
    const probeStores = StoreChecker.probeStoresFor(day, config);
    const state = {
      day, phase: 'discovery', probeStores, probeIndex: 0, probeStore: probeStores[0],
      dept: 0, page: 0, searches: 0,
      probeTotal: 0, offset: 0, candidateTotal: 0, stores: config.stores.map((s) => s.id),
      startedAt: this.now().toISOString(), probeFound: 0, candidateRows: 0,
    };
    this.state = this.discoveryEnabled(config) ? state : await this.startProbe(state);
    return this.state;
  }

  /** Probe list = deal pool + discovered items, checked at each probe store. */
  async startProbe(state) {
    const pool = await this.source.dealCandidates({ wait: false });
    const probeIds = [...new Set([...pool.filter((p) => p.price > 0).map((p) => p.id), ...this.list('discovered')])];
    this.saveList('probeIds', probeIds);
    return { ...state, phase: 'probe', offset: 0, probeTotal: probeIds.length, discovered: this.list('discovered').length };
  }

  /** Do one step (one search page or one lookup of up to 20 items). Returns false when there's nothing to do now. */
  async step() {
    const { config, errors } = this.loadConfig();
    if (!config || errors.length || !config.stores.length) return false;
    const state = await this.ensureCycle(config);
    if (!state || state.phase === 'done') return false;
    const date = state.day;

    if (state.phase === 'discovery') {
      const dept = config.departments[state.dept];
      if (dept === undefined || !this.discoveryEnabled(config)) {
        this.state = await this.startProbe(state);
        return true;
      }
      const { ids, total } = await this.source.searchClearance({
        query: dept.toLowerCase(), filters: config.filters, start: state.page * SEARCH_PAGE + 1, numItems: SEARCH_PAGE,
      });
      const discovered = this.list('discovered');
      const fresh = ids.filter((id) => !discovered.includes(id));
      if (fresh.length) this.saveList('discovered', [...discovered, ...fresh]);
      // Measure: where each find turned up, and whether the product list already had it.
      if (this.poolDay !== date) {
        this.poolIds = new Set((await this.source.dealCandidates({ wait: false })).map((p) => p.id));
        this.poolDay = date;
      }
      this.db.recordDiscovery(this.retailer, date, dept, state.page + 1, ids.map((id) => ({ itemId: id, inPool: this.poolIds.has(id) })));
      const nextPage = state.page + 1;
      const more = ids.length > 0 && nextPage < (config.discoveryMaxPages ?? 20) && nextPage * SEARCH_PAGE < (total ?? 0);
      this.state = { ...state, searches: state.searches + 1, ...(more ? { page: nextPage } : { dept: state.dept + 1, page: 0 }) };
      return true;
    }

    if (state.phase === 'probe') {
      const ids = this.list('probeIds').slice(state.offset, state.offset + BATCH);
      if (!ids.length) {
        // This store is done; move to the next probe store, or on to candidates.
        const next = state.probeIndex + 1;
        if (next < state.probeStores.length) {
          this.state = { ...state, probeIndex: next, probeStore: state.probeStores[next], offset: 0 };
          return true;
        }
        const candidates = this.db.candidateItems(this.retailer);
        this.saveList('candidates', candidates);
        this.saveList('probeIds', []);
        this.state = { ...state, phase: 'candidates', offset: 0, candidateTotal: candidates.length };
        return true;
      }
      const { found } = await this.source.storeLookup(ids, state.probeStore);
      this.db.recordStorePrices(this.retailer, state.probeStore, found, date);
      this.state = { ...state, offset: state.offset + ids.length, probeFound: state.probeFound + found.length };
      return true;
    }

    // phase 'candidates': walk store by store through the candidate batches
    const candidates = this.list('candidates');
    const batches = Math.ceil(candidates.length / BATCH);
    const total = batches * state.stores.length;
    if (state.offset >= total) {
      this.state = { ...state, phase: 'done', finishedAt: this.now().toISOString() };
      console.log(`store check ${date}: ${candidates.length} candidates at ${state.stores.length} stores done`);
      return false;
    }
    const storeId = state.stores[Math.floor(state.offset / batches)];
    const b = state.offset % batches;
    const ids = candidates.slice(b * BATCH, b * BATCH + BATCH);
    const { found } = await this.source.storeLookup(ids, storeId);
    this.db.recordStorePrices(this.retailer, storeId, found, date);
    this.state = { ...state, offset: state.offset + 1, candidateRows: state.candidateRows + found.length };
    return true;
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
        // Calls are paced by the Walmart client's throttle; idle between cycles.
        if (!worked) await new Promise((r) => setTimeout(r, this.idleMs));
      }
    };
    loop();
  }

  status() {
    const s = this.state;
    if (!s) return { state: 'not started' };
    const probeStores = s.probeStores ?? [s.probeStore];
    const batches = Math.ceil((s.candidateTotal ?? 0) / BATCH);
    return {
      day: s.day,
      phase: s.phase,
      discovery: { searches: s.searches ?? 0, department: s.phase === 'discovery' ? s.dept + 1 : null, found: s.discovered ?? this.list('discovered').length },
      probeStore: s.probeStore,
      probeStores,
      probe: s.phase === 'probe'
        ? { store: (s.probeIndex ?? 0) + 1, ofStores: probeStores.length, checked: s.offset, of: s.probeTotal }
        : { stores: probeStores.length, itemsPerStore: s.probeTotal, found: s.probeFound },
      candidates: s.candidateTotal ?? 0,
      candidateLookups: s.phase === 'candidates' ? { done: s.offset, of: batches * s.stores.length } : null,
      candidateRows: s.candidateRows,
      stores: s.stores?.length ?? 0,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt ?? null,
      lastError: this.lastError,
    };
  }
}
