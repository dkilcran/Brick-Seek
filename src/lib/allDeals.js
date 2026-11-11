// The All Deals list: one card per item with up to two deal lines, the
// retailer's online deal and its best store deal near the shopper. Adapters
// build the cards; filtering, sorting and scoring here are retailer-agnostic.
//
// card = {
//   product: { retailer, id, name, imageUrl, category, url },
//   online: { price, wasPrice, kind, label, percentOff, dollarsOff } | null,
//   store:  { price, refPrice, kind, label, store, storesWithDeal, seenOn, percentOff, dollarsOff } | null,
//   soldOnline: boolean, soldInStores: boolean,
//   dropPercent: number,  // online price drop since the last recorded price, in percent
//   atLowest: boolean,    // online price is the lowest recorded
// }

/**
 * Deal kinds and their labels. Clearance, Rollback and Reduced Price are the
 * retailer's own; Markdown is ours (a store priced well below the item's
 * highest valid store price). 'offer' is Rollback or Reduced Price when the
 * list doesn't say which.
 */
export const DEAL_LABELS = Object.freeze({
  clearance: 'Clearance',
  rollback: 'Rollback',
  reduced: 'Reduced Price',
  offer: 'Rollback / Reduced Price',
  markdown: 'Markdown',
});

// Relative weight of each signal in the "Best match" score.
const WEIGHTS = Object.freeze({ percentOff: 0.35, dollarsOff: 0.2, recentDrop: 0.15, lowestSeen: 0.1, dealKind: 0.1 });
// History needs this many recorded days before "lowest price ever" means anything.
const MIN_HISTORY_DAYS = 7;

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** % and $ off for a price against a reference (0 when there's no higher reference). */
export function discount(price, ref) {
  if (!(ref > price) || !(price >= 0)) return { percentOff: 0, dollarsOff: 0 };
  return { percentOff: Math.round((1 - price / ref) * 100), dollarsOff: Number((ref - price).toFixed(2)) };
}

/**
 * What a price history says about today's price.
 * @param {{ date: string, price: number }[]} history  oldest first; today's entry is ignored
 * @returns {{ dropPercent: number, atLowest: boolean }}
 */
export function priceSignals(price, history = [], today = new Date().toISOString().slice(0, 10)) {
  const past = history.filter((p) => p.date < today);
  return signalsFrom(price, {
    days: history.length,
    previous: past.at(-1)?.price ?? null,
    lowest: past.length ? Math.min(...past.map((p) => p.price)) : null,
  });
}

/**
 * The same from a summary of the history (see PriceTracker.summaries).
 * @param {{ days?: number, previous?: number|null, lowest?: number|null }} summary
 *   days recorded (today included), the last price before today, the lowest before today
 */
export function signalsFrom(price, { days = 0, previous = null, lowest = null } = {}) {
  return {
    dropPercent: previous > price ? Math.round((1 - price / previous) * 100) : 0,
    atLowest: days >= MIN_HISTORY_DAYS && lowest != null && price <= lowest,
  };
}

/** Labels a filter can pick: the deal kinds plus price-history badges. */
function cardLabels(card) {
  const out = new Set();
  for (const line of [card.online, card.store]) {
    if (!line) continue;
    if (line.kind === 'offer') { out.add('rollback'); out.add('reduced'); } else out.add(line.kind);
  }
  if (card.dropPercent >= 1) out.add('drop');
  if (card.atLowest) out.add('lowest');
  return out;
}

/**
 * The cards matching the filters, each with its best discount, lowest price
 * and score (see summarize). Cards always keep all their deal lines.
 * @param {object} f
 * @param {string[]} [f.where]  'online' (has an online deal) and/or 'stores' (has a store deal); default both
 * @param {string[]} [f.labels]  any of the deal kinds, 'drop' (price drop) and 'lowest' (lowest price ever)
 * @param {string} [f.q]  words that must all be in the name (or the item id)
 */
export function filterCards(cards, { where = ['online', 'stores'], labels = [], q = '', category, minPrice, maxPrice, minDiscount = 0 } = {}) {
  const w = new Set(where.length ? where : ['online', 'stores']);
  const wanted = new Set(labels);
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const card of cards) {
    if (!((w.has('online') && card.online) || (w.has('stores') && card.store))) continue;
    if (wanted.size && ![...cardLabels(card)].some((l) => wanted.has(l))) continue;
    if (category && card.product.category !== category) continue;
    if (words.length) {
      const text = `${card.product.name ?? ''} ${card.product.id}`.toLowerCase();
      if (!words.every((x) => text.includes(x))) continue;
    }
    const best = summarize(card);
    if (minPrice != null && best.lowestPrice < minPrice) continue;
    if (maxPrice != null && best.lowestPrice > maxPrice) continue;
    if (best.percentOff < minDiscount) continue;
    out.push({ ...card, ...best });
  }
  return out;
}

/** Best % / $ off and lowest price across a card's lines, and a ranking score. */
export function summarize(card) {
  const ls = [card.online, card.store].filter(Boolean);
  const percentOff = Math.max(0, ...ls.map((l) => l.percentOff ?? 0));
  const dollarsOff = Math.max(0, ...ls.map((l) => l.dollarsOff ?? 0));
  const lowestPrice = Math.min(...ls.map((l) => l.price ?? Infinity));
  const kind = ls.some((l) => l.kind === 'clearance') ? 1 : ls.some((l) => l.kind === 'markdown') ? 0.5 : 0.6;
  const score =
    WEIGHTS.percentOff * clamp01(percentOff / 100) +
    WEIGHTS.dollarsOff * clamp01(Math.log10(1 + dollarsOff) / 3) + // $1,000 off scores 1
    WEIGHTS.recentDrop * clamp01(((card.dropPercent ?? 0) / 100) * 3) + // a 33% drop scores 1
    WEIGHTS.lowestSeen * (card.atLowest ? 1 : 0) +
    WEIGHTS.dealKind * kind;
  return { percentOff, dollarsOff, lowestPrice, score: Number(score.toFixed(4)) };
}

/** Sort: best (score), percent, dollars, price, price-desc, drop. Ties keep order. */
export function sortCards(cards, sort = 'best') {
  const by = {
    best: (c) => -c.score,
    percent: (c) => -c.percentOff,
    dollars: (c) => -c.dollarsOff,
    price: (c) => c.lowestPrice,
    'price-desc': (c) => -c.lowestPrice,
    drop: (c) => -(c.dropPercent ?? 0),
  }[sort] ?? ((c) => -c.score);
  return cards.map((c, i) => [by(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}
