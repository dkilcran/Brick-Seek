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
  if (product.inStockOnline === false) reasons.push('In-store only');

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

// Not sold online and priced below this share of the current offer: the
// price is a leftover from when the item was last sold, not a real deal.
export const STALE_PRICE_RATIO = 0.5;

/**
 * Keep priced items the retailer sells itself. Items unavailable online stay
 * in ("In-store only") when there's a sign they're still sold: an active
 * listing, or the retailer's own Clearance/Rollback flag. Their price must
 * also be near the current offer price, unless the retailer marks it
 * Clearance (store clearance can sit well below the online offer).
 */
export function isEligible(product) {
  if (product?.seller?.isRetailer !== true || typeof product.price !== 'number' || product.price <= 0) return false;
  if (product.inStockOnline !== false) return true;
  if (product.listingActive === false && !product.specialOffer) return false;
  return !isStalePrice(product);
}

export function isStalePrice(product) {
  return (
    product.inStockOnline === false &&
    product.specialOffer !== 'clearance' &&
    typeof product.currentOfferPrice === 'number' &&
    product.price < product.currentOfferPrice * STALE_PRICE_RATIO
  );
}

// Brand isn't always given, so fall back to the first word of the name.
function brandOf(product) {
  return String(product.brand || product.name.split(/\s+/)[0] || '').toLowerCase();
}

/**
 * Take deals in order, at most `perCategory` from one category and
 * `perBrand` from one brand (pass Infinity to turn either cap off).
 */
export function diversify(deals, { limit, perCategory = 2, perBrand = 2 }) {
  const cats = new Map();
  const brands = new Map();
  const picked = [];
  for (const deal of deals) {
    const cat = deal.product.category ?? 'Other';
    const brand = brandOf(deal.product);
    if ((cats.get(cat) ?? 0) >= perCategory || (brands.get(brand) ?? 0) >= perBrand) continue;
    cats.set(cat, (cats.get(cat) ?? 0) + 1);
    brands.set(brand, (brands.get(brand) ?? 0) + 1);
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
export function rankSection(section, analyzed, { category, minDiscount = 0, limit = 50, perCategory, perBrand } = {}) {
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
      break;
    default:
      throw Object.assign(new Error(`Unknown deal section "${section}"`), { status: 400 });
  }
  // Caps grow with the page size; a picked category can fill the page, but one brand can't.
  return diversify(list, {
    limit,
    perCategory: category ? Infinity : perCategory ?? Math.max(2, Math.ceil(limit / 8)),
    perBrand: perBrand ?? Math.max(2, Math.ceil(limit / 12)),
  });
}
