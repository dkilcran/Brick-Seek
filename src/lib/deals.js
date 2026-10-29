// Retailer-agnostic deal ranking. Adapters supply candidate products (and
// optionally price history); this module scores them and builds the deal
// sections shown on the home and deals pages.

const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Relative weight of each signal in the overall deal score (sums to 1).
export const WEIGHTS = Object.freeze({
  percentOff: 0.35,
  dollarsOff: 0.2,
  recentDrop: 0.15,
  lowestSeen: 0.1,
  popularity: 0.1,
  specialOffer: 0.1,
});

// History needs at least this many recorded days before "lowest price ever"
// means anything.
const MIN_HISTORY_DAYS = 7;

/**
 * Work out the signals for one product.
 * @param {Product} product
 * @param {PricePoint[]} history oldest first, may be empty; today's entry is ignored
 */
export function analyzeDeal(product, history = [], { today = new Date().toISOString().slice(0, 10) } = {}) {
  const price = product.price;
  const msrp = product.msrp && product.msrp > price ? product.msrp : price;
  const percentOff = msrp ? 1 - price / msrp : 0;
  const dollarsOff = msrp - price;

  const past = history.filter((p) => p.date < today);
  const previousPrice = past.length ? past.at(-1).price : null;
  const dropPercent = previousPrice && previousPrice > price ? 1 - price / previousPrice : 0;
  const lowestBefore = past.length ? Math.min(...past.map((p) => p.price)) : null;
  const atLowest = history.length >= MIN_HISTORY_DAYS && lowestBefore !== null && price <= lowestBefore;

  const rating = typeof product.rating === 'number' ? product.rating : null;
  const reviews = product.reviewCount ?? 0;
  const popularity = rating === null ? 0.3 : clamp01((rating - 3) / 2) * clamp01(Math.log10(1 + reviews) / 3);
  const special = product.specialOffer === 'clearance' ? 1 : product.specialOffer === 'rollback' ? 0.6 : 0;

  const score =
    WEIGHTS.percentOff * clamp01(percentOff) +
    WEIGHTS.dollarsOff * clamp01(Math.log10(1 + dollarsOff) / 3) + // $1,000 off scores 1
    WEIGHTS.recentDrop * clamp01(dropPercent * 3) + // a 33% drop scores 1
    WEIGHTS.lowestSeen * (atLowest ? 1 : 0) +
    WEIGHTS.popularity * popularity +
    WEIGHTS.specialOffer * special;

  const reasons = [];
  if (product.specialOffer === 'clearance') reasons.push('Clearance');
  if (product.specialOffer === 'rollback') reasons.push('Rollback');
  if (dropPercent >= 0.01) reasons.push(`Dropped ${Math.round(dropPercent * 100)}%`);
  if (atLowest) reasons.push('Lowest price seen');

  return {
    product,
    lowestPrice: price,
    discountPercent: Math.round(percentOff * 100),
    dollarsOff: Number(dollarsOff.toFixed(2)),
    previousPrice,
    dropPercent: Math.round(dropPercent * 100),
    atLowest,
    score: Number(score.toFixed(4)),
    reasons,
    clearance: product.specialOffer === 'clearance',
  };
}

/** Keep items the retailer sells itself that can actually be bought online. */
export function isEligible(product) {
  return (
    product?.seller?.isRetailer === true &&
    typeof product.price === 'number' &&
    product.price > 0 &&
    product.inStockOnline !== false
  );
}

/** Take the best-scored deals, at most `perCategory` from any one category. */
export function diversify(deals, { limit, perCategory = 2 }) {
  const counts = new Map();
  const picked = [];
  for (const deal of deals) {
    const cat = deal.product.category ?? 'Other';
    if ((counts.get(cat) ?? 0) >= perCategory) continue;
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
    picked.push(deal);
    if (picked.length >= limit) break;
  }
  return picked;
}

export const SECTIONS = Object.freeze({
  top: { title: 'Top deals', description: 'Best overall value, spread across categories.' },
  drops: { title: 'Price drops today', description: 'Cheaper than the last price we recorded.' },
  lowest: { title: 'Lowest price ever', description: 'At the lowest price we have recorded.' },
  bigticket: { title: 'Big-ticket deals', description: 'The most dollars off items over $100.' },
  clearance: { title: 'Clearance near you', description: 'Marked down on the shelf at stores near your ZIP.' },
});

/**
 * Rank analyzed deals for one section.
 * @param {ReturnType<typeof analyzeDeal>[]} analyzed
 */
export function rankSection(section, analyzed, { category, minDiscount = 0, limit = 50, perCategory } = {}) {
  let list = analyzed.filter(
    (d) => d.discountPercent >= minDiscount && (!category || d.product.category === category),
  );
  switch (section) {
    case 'drops':
      list = list.filter((d) => d.dropPercent >= 1).sort((a, b) => b.dropPercent - a.dropPercent || b.score - a.score);
      break;
    case 'lowest':
      list = list.filter((d) => d.atLowest).sort((a, b) => b.score - a.score);
      break;
    case 'bigticket':
      list = list.filter((d) => d.product.price >= 100 && d.dollarsOff > 0).sort((a, b) => b.dollarsOff - a.dollarsOff);
      break;
    case 'top':
      list = list.filter((d) => d.discountPercent > 0 || d.dropPercent > 0).sort((a, b) => b.score - a.score);
      // A single category can still fill the page when the user picked it.
      if (!category) return diversify(list, { limit, perCategory: perCategory ?? Math.max(2, Math.ceil(limit / 8)) });
      break;
    default:
      throw Object.assign(new Error(`Unknown deal section "${section}"`), { status: 400 });
  }
  return list.slice(0, limit);
}
