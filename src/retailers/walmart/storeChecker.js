// Free store-level checks through Walmart's affiliate item lookup with a
// storeId (20 items per call, rate-limited). The bulk feeds ignore storeId,
// so the checker works in two phases each day:
//   1. probe: every item in the deal pool at the daily stores plus a few
//      rotating ones, to discover what's marked down there;
//   2. candidates: every recently marked-down item (from any store, or found
//      by SerpApi discovery) at every configured store.
// Progress is saved, so a restart resumes where it left off.
import { localParts } from '../../lib/scanSchedule.js';

const BATCH = 20;

const dayKeyOf = (date) => {
  const t = localParts(date);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
};

export class StoreChecker {
  /**
   * @param {object} opts
   * @param {{ storeLookup, dealCandidates, poolLoading }} opts.source  WalmartLiveSource
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

  // Small progress record, saved after every lookup; the item lists are saved
  // once per phase under their own keys.
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

  /** Start today's cycle if needed. Returns the state, or null if it can't start yet. */
  async ensureCycle(config) {
    const day = dayKeyOf(this.now());
    const current = this.state;
    // Changing config.restartChecks starts today's cycle over with the current plan.
    const restart = config.restartChecks && this.db.getMeta('check:restartDone') !== config.restartChecks;
    if (current?.day === day && !restart) {
      // A cycle saved before multi-store probes: finish its store, then add today's plan.
      if (!current.probeStores) {
        const probeStores = [...new Set([current.probeStore, ...StoreChecker.probeStoresFor(day, config)])];
        this.state = { ...current, probeStores, probeIndex: 0 };
      }
      return this.state;
    }
    if (this.source.poolLoading) return null; // the deal pool loads after a restart
    const pool = await this.source.dealCandidates({ wait: false });
    const probeIds = pool.filter((p) => p.price > 0).map((p) => p.id);
    this.saveList('probeIds', probeIds);
    this.saveList('candidates', []);
    const probeStores = StoreChecker.probeStoresFor(day, config);
    if (restart) this.db.setMeta('check:restartDone', config.restartChecks);
    this.state = {
      day, phase: 'probe', probeStores, probeIndex: 0, probeStore: probeStores[0],
      probeTotal: probeIds.length, offset: 0,
      candidateTotal: 0, stores: config.stores.map((s) => s.id),
      startedAt: this.now().toISOString(), probeFound: 0, candidateRows: 0,
    };
    return this.state;
  }

  /** Do one lookup (up to 20 items at one store). Returns false when there's nothing to do now. */
  async step() {
    const { config, errors } = this.loadConfig();
    if (!config || errors.length || !config.stores.length) return false;
    const state = await this.ensureCycle(config);
    if (!state || state.phase === 'done') return false;
    const date = state.day;

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
        // Lookups are paced by the Walmart client's throttle; idle between cycles.
        if (!worked) await new Promise((r) => setTimeout(r, this.idleMs));
      }
    };
    loop();
  }

  status() {
    const s = this.state;
    if (!s) return { state: 'not started' };
    const batches = Math.ceil((s.candidateTotal ?? 0) / BATCH);
    return {
      day: s.day,
      phase: s.phase,
      probeStore: s.probeStore,
      probeStores: s.probeStores ?? [s.probeStore],
      probe: s.phase === 'probe'
        ? { store: (s.probeIndex ?? 0) + 1, ofStores: (s.probeStores ?? [s.probeStore]).length, checked: s.offset, of: s.probeTotal }
        : { stores: (s.probeStores ?? [s.probeStore]).length, itemsPerStore: s.probeTotal, found: s.probeFound },
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
