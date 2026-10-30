// Free store-level checks through Walmart's affiliate item lookup with a
// storeId (20 items per call, rate-limited). The bulk feeds ignore storeId,
// so the checker works in two phases each day:
//   1. probe: every item in the deal pool at one store (rotating daily)
//      to discover what's marked down there;
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

  /** Start today's cycle if needed. Returns the state, or null if it can't start yet. */
  async ensureCycle(config) {
    const day = dayKeyOf(this.now());
    if (this.state?.day === day) return this.state;
    if (this.source.poolLoading) return null; // the deal pool loads after a restart
    const pool = await this.source.dealCandidates({ wait: false });
    // Rotate the full probe through the stores, one store per day.
    const dayNumber = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
    const probeStore = config.stores[dayNumber % config.stores.length].id;
    const probeIds = pool.filter((p) => p.price > 0).map((p) => p.id);
    this.saveList('probeIds', probeIds);
    this.saveList('candidates', []);
    this.state = {
      day, phase: 'probe', probeStore, probeTotal: probeIds.length, offset: 0,
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
      probe: s.phase === 'probe' ? { checked: s.offset, of: s.probeTotal } : { checked: s.probeTotal, found: s.probeFound },
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
