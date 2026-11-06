// The All Deals list: one card per item with up to two deal lines, an online
// deal (Walmart.com's Clearance / Rollback / Reduced Price) and the best store
// deal near the shopper (Clearance / Rollback / Reduced Price / Markdown at a
// store). Filtering and sorting are retailer-agnostic; adapters build cards.
//
// card = {
//   product: { retailer, id, name, imageUrl, category, url },
//   online: { price, wasPrice, kind, label, percentOff, dollarsOff } | null,
//   store:  { price, refPrice, kind, label, store, storesWithDeal, seenOn, percentOff, dollarsOff } | null,
//   soldOnline: boolean, soldInStores: boolean,
//   dropPercent?: number, atLowest?: boolean,
// }

import { WEIGHTS } from './deals.js';

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** % and $ off for a price against a reference (0 when there's no higher reference). */
export function discount(price, ref) {
  if (!(ref > price) || !(price >= 0)) return { percentOff: 0, dollarsOff: 0 };
  return { percentOff: Math.round((1 - price / ref) * 100), dollarsOff: Number((ref - price).toFixed(2)) };
}

/** The deal lines a card shows for a "where" choice: online only hides store lines. */
function lines(card, where) {
  const showStore = where.has('stores');
  return [card.online, showStore ? card.store : null].filter(Boolean);
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
 * Keep the cards matching the filters, with the lines that apply.
 * @param {{ where?: string[], labels?: string[], q?: string, category?: string,
 *   minPrice?: number, maxPrice?: number, minDiscount?: number }} f
 *   where: 'online' (sold online) and/or 'stores' (sold in stores); default both.
 */
export function filterCards(cards, { where = ['online', 'stores'], labels = [], q = '', category, minPrice, maxPrice, minDiscount = 0 } = {}) {
  const w = new Set(where.length ? where : ['online', 'stores']);
  const wanted = new Set(labels);
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const card of cards) {
    // Where it's sold: items sold in both places show under either.
    if (!((w.has('online') && card.soldOnline) || (w.has('stores') && card.soldInStores))) continue;
    const shown = { ...card, store: w.has('stores') ? card.store : null };
    const ls = lines(card, w);
    if (!ls.length) continue;
    if (wanted.size && ![...cardLabels(shown)].some((l) => wanted.has(l))) continue;
    if (category && card.product.category !== category) continue;
    if (words.length) {
      const text = `${card.product.name ?? ''} ${card.product.id}`.toLowerCase();
      if (!words.every((x) => text.includes(x))) continue;
    }
    const best = summarize(shown);
    if (minPrice != null && best.lowestPrice < minPrice) continue;
    if (maxPrice != null && best.lowestPrice > maxPrice) continue;
    if (best.percentOff < minDiscount) continue;
    out.push({ ...shown, ...best });
  }
  return out;
}

/** Best % / $ off and lowest price across a card's lines, and a ranking score. */
export function summarize(card) {
  const ls = [card.online, card.store].filter(Boolean);
  const percentOff = Math.max(0, ...ls.map((l) => l.percentOff ?? 0));
  const dollarsOff = Math.max(0, ...ls.map((l) => l.dollarsOff ?? 0));
  const lowestPrice = Math.min(...ls.map((l) => l.price ?? Infinity));
  const special = ls.some((l) => l.kind === 'clearance') ? 1 : ls.some((l) => ['rollback', 'reduced', 'offer'].includes(l.kind)) ? 0.6
    : ls.some((l) => l.kind === 'markdown') ? 0.5 : 0;
  const score =
    WEIGHTS.percentOff * clamp01(percentOff / 100) +
    WEIGHTS.dollarsOff * clamp01(Math.log10(1 + dollarsOff) / 3) +
    WEIGHTS.recentDrop * clamp01(((card.dropPercent ?? 0) / 100) * 3) +
    WEIGHTS.lowestSeen * (card.atLowest ? 1 : 0) +
    WEIGHTS.specialOffer * special;
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
