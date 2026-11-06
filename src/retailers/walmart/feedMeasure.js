// One-off measurement: how much do Walmart's bulk deal feeds (/paginated/items
// with specialOffer and category) hold beyond our search-built tier lists?
// Pages through Clearance and Rollback for each configured department, checks
// the possible Walmart items at one store, and compares with the tier lists.
// Runs in the background through the same throttled client as everything else.

const OFFERS = ['clearance', 'rollback'];
const BATCH = 20;

export class FeedMeasure {
  /**
   * @param {{ source, db: import('./storeScan.js').StoreScanDb, tiers: import('./tierLists.js').TierStore, loadConfig }} opts
   */
  constructor({ source, db, tiers, loadConfig, retailer = 'walmart' }) {
    Object.assign(this, { source, db, tiers, loadConfig, retailer });
    this.state = db.getMeta(`feedMeasure:${retailer}`) ?? null;
    this.running = false;
  }

  status() {
    return { running: this.running, ...(this.state ?? { phase: 'not started' }) };
  }

  /** Start unless already running. */
  start({ storeId = '573', maxPagesPerFeed = 50, maxLookups = 300 } = {}) {
    if (this.running) return false;
    this.running = true;
    this.run({ storeId, maxPagesPerFeed, maxLookups })
      .catch((err) => { this.state = { ...this.state, phase: 'failed', error: err.message.slice(0, 300) }; })
      .finally(() => { this.running = false; this.save(); });
    return true;
  }

  save() {
    this.db.setMeta(`feedMeasure:${this.retailer}`, this.state);
  }

  async run({ storeId, maxPagesPerFeed, maxLookups }) {
    const { config } = this.loadConfig();
    const departments = config?.departments ?? [];
    this.state = { phase: 'feeds', startedAt: new Date().toISOString(), storeId, maxPagesPerFeed, feeds: [], calls: 0 };
    const cats = new Map((await this.source.taxonomy()).map((c) => [c.name, c.id]));
    this.state.calls += 1;
    const candidates = new Map(); // item id -> { department, offers }
    for (const department of departments) {
      const category = cats.get(department);
      if (!category) {
        this.state.feeds.push({ department, error: 'no Walmart category with this name' });
        continue;
      }
      for (const offer of OFFERS) {
        const feed = { department, offer, pages: 0, items: 0, walmart: 0, otherSeller: 0, unnamed: 0, onlineOnly: 0, capped: false };
        this.state.feeds.push(feed);
        let query = { category, specialOffer: offer };
        while (query) {
          if (feed.pages >= maxPagesPerFeed) { feed.capped = true; break; }
          let data;
          try {
            data = await this.source.request('/paginated/items', query, { cache: false });
          } catch (err) {
            feed.error = err.message.slice(0, 200);
            break;
          }
          this.state.calls += 1;
          feed.pages += 1;
          for (const item of data?.items ?? []) {
            feed.items += 1;
            const seller = String(item.sellerInfo ?? '').trim();
            const walmart = /^walmart(\.com)?$/i.test(seller);
            if (walmart) feed.walmart += 1;
            else if (seller || item.marketplace === true) { feed.otherSeller += 1; continue; }
            else feed.unnamed += 1;
            if (item.offerType === 'ONLINE_ONLY') { feed.onlineOnly += 1; continue; }
            const id = String(item.itemId);
            const c = candidates.get(id) ?? { department, offers: new Set() };
            c.offers.add(offer);
            candidates.set(id, c);
          }
          query = data?.nextPage ? Object.fromEntries(new URL(data.nextPage, 'https://x.invalid').searchParams) : null;
          if (query) delete query.publisherId;
          if (feed.pages % 10 === 0) this.save();
        }
        this.save();
      }
    }

    // Check the possible Walmart items at one store (a spread sample if there are too many).
    this.state.phase = 'lookups';
    const all = [...candidates.keys()];
    const step = Math.max(1, all.length / (maxLookups * BATCH));
    const sample = step > 1 ? Array.from({ length: Math.floor(all.length / step) }, (_, i) => all[Math.floor(i * step)]) : all;
    const lookups = { candidates: all.length, checked: sample.length, sampled: step > 1, foundWalmartInStore: 0, notAtStore: 0, onlineOnly: 0, otherSeller: 0, clearanceFlag: 0 };
    this.state.lookups = lookups;
    const confirmed = [];
    for (let i = 0; i < sample.length; i += BATCH) {
      const batch = sample.slice(i, i + BATCH);
      const { found, missing, onlineOnly } = await this.source.storeLookup(batch, storeId);
      this.state.calls += 1;
      lookups.notAtStore += missing.length;
      lookups.onlineOnly += onlineOnly?.length ?? 0;
      for (const f of found) {
        if (!f.isWalmart) { lookups.otherSeller += 1; continue; }
        lookups.foundWalmartInStore += 1;
        if (f.clearance) lookups.clearanceFlag += 1;
        confirmed.push(f.itemId);
      }
      if ((i / BATCH) % 10 === 0) this.save();
    }

    // Compare with the search-built lists.
    const t1 = new Set(this.tiers.itemIds(1));
    const t2 = new Set(this.tiers.itemIds(2));
    const t3 = new Set(this.tiers.itemIds(3));
    const compare = { inTier1: 0, inTier2: 0, inTier3Only: 0, inNoList: 0 };
    const missedByDepartment = {};
    for (const id of confirmed) {
      if (t1.has(id)) compare.inTier1 += 1;
      else if (t2.has(id)) compare.inTier2 += 1;
      else if (t3.has(id)) compare.inTier3Only += 1;
      else {
        compare.inNoList += 1;
        const d = candidates.get(id)?.department ?? '?';
        missedByDepartment[d] = (missedByDepartment[d] ?? 0) + 1;
      }
    }
    const scale = sample.length ? all.length / sample.length : 0;
    this.state = {
      ...this.state,
      phase: 'done',
      finishedAt: new Date().toISOString(),
      compare,
      missedByDepartment,
      // Estimated for all candidates when only a sample was checked.
      estimate: {
        walmartInStore: Math.round(lookups.foundWalmartInStore * scale),
        notInAnyList: Math.round(compare.inNoList * scale),
      },
      lists: { tier1: t1.size, tier2: t2.size, tier3: t3.size },
      sampleMissed: confirmed.filter((id) => !t1.has(id) && !t2.has(id) && !t3.has(id)).slice(0, 15),
    };
  }
}
