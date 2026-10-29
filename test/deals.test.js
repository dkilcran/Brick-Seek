import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDeal, diversify, isEligible, rankSection } from '../src/lib/deals.js';

const TODAY = '2026-10-29';
const walmart = { name: 'Walmart.com', isRetailer: true };
const product = (id, over = {}) => ({
  id, name: `P${id}`, category: 'Home', price: 50, msrp: 100, seller: walmart,
  rating: 4.5, reviewCount: 500, specialOffer: null, inStockOnline: true, ...over,
});
const days = (...prices) => prices.map((price, i) => ({
  date: `2026-10-${String(29 - prices.length + 1 + i).padStart(2, '0')}`, price,
}));

test('isEligible keeps only retailer-sold, buyable items', () => {
  assert.equal(isEligible(product(1)), true);
  assert.equal(isEligible(product(2, { seller: { name: 'Rug Co', isRetailer: false } })), false);
  assert.equal(isEligible(product(3, { inStockOnline: false })), true, 'in-store only items stay');
  assert.equal(isEligible(product(4, { inStockOnline: null })), true);
  assert.equal(isEligible(product(5, { price: null })), false);
  // not online and no sign anyone still sells it: stale listing
  assert.equal(isEligible(product(6, { inStockOnline: false, listingActive: false })), false);
  assert.equal(isEligible(product(7, { inStockOnline: false, listingActive: true })), true);
  assert.equal(isEligible(product(8, { inStockOnline: false, listingActive: false, specialOffer: 'clearance' })), true);
  assert.equal(isEligible(product(9, { inStockOnline: true, listingActive: false })), true, 'online stock is enough');
  // seller not confirmed yet, or the listing no longer exists
  assert.equal(isEligible(product(10, { seller: { name: null, isRetailer: null } })), false);
  assert.equal(isEligible(product(11, { exists: false })), false);
  // stores rarely stock books and collectibles, so their not-online listings are out
  assert.equal(isEligible(product(12, { inStockOnline: false, category: 'Books' })), false);
  assert.equal(isEligible(product(13, { inStockOnline: true, category: 'Books' })), true);
});

test('analyzeDeal computes discount, savings and today\'s drop', () => {
  // history: ..., yesterday 60, today 50 (today's entry is ignored)
  const d = analyzeDeal(product(1), days(70, 70, 65, 65, 65, 60, 60, 50), { today: TODAY });
  assert.equal(d.discountPercent, 50);
  assert.equal(d.dollarsOff, 50);
  assert.equal(d.previousPrice, 60);
  assert.equal(d.dropPercent, 17);
  assert.equal(d.atLowest, true);
  assert.deepEqual(d.reasons, ['Dropped 17%', 'Lowest price seen']);
});

test('not-online discounts are measured against today\'s offer price', () => {
  // EZ Foil pans: $3.66, list $61.19, best offer today $5.10
  const pans = analyzeDeal(product(1, { price: 3.66, msrp: 61.19, currentOfferPrice: 5.1, inStockOnline: false }), [], { today: TODAY });
  assert.equal(pans.referencePrice, 5.1);
  assert.equal(pans.discountPercent, 28);
  // Dreamcast game priced above today's offer: no discount, whatever the list price says
  const game = analyzeDeal(product(2, { price: 44.96, msrp: 417.05, currentOfferPrice: 29.99, inStockOnline: false }), [], { today: TODAY });
  assert.equal(game.discountPercent, 0);
  // no current offer: fall back to the list price
  assert.equal(analyzeDeal(product(3, { price: 5.83, msrp: 28.98, inStockOnline: false }), [], { today: TODAY }).discountPercent, 80);
  // online items keep using the list price
  assert.equal(analyzeDeal(product(4, { price: 50, msrp: 100, currentOfferPrice: 55 }), [], { today: TODAY }).referencePrice, 100);
});

test('items unavailable online are tagged In-store only', () => {
  assert.deepEqual(analyzeDeal(product(1, { inStockOnline: false }), [], { today: TODAY }).reasons, ['In-store only']);
  assert.deepEqual(analyzeDeal(product(1, { inStockOnline: null }), [], { today: TODAY }).reasons, []);
});

test('analyzeDeal needs enough history for lowest-ever', () => {
  assert.equal(analyzeDeal(product(1), days(60, 50), { today: TODAY }).atLowest, false);
  assert.equal(analyzeDeal(product(1), [], { today: TODAY }).dropPercent, 0);
});

test('clearance, rollback and bigger savings raise the score', () => {
  const base = analyzeDeal(product(1), [], { today: TODAY }).score;
  assert.ok(analyzeDeal(product(1, { specialOffer: 'clearance' }), [], { today: TODAY }).score > base);
  assert.ok(analyzeDeal(product(1, { specialOffer: 'rollback' }), [], { today: TODAY }).score > base);
  const bigger = analyzeDeal(product(1, { price: 500, msrp: 1000 }), [], { today: TODAY }).score;
  assert.ok(bigger > base, 'same percent off, more dollars off');
});

test('diversify caps items per category and per brand', () => {
  const deals = [1, 2, 3, 4].map((i) => ({ product: product(i, { category: 'Rugs', brand: `B${i}` }) }))
    .concat([5, 6].map((i) => ({ product: product(i, { category: 'Toys', brand: `B${i}` }) })));
  assert.deepEqual(diversify(deals, { limit: 10, perCategory: 2 }).map((d) => d.product.id), [1, 2, 5, 6]);

  // Same brand across categories, brand missing (falls back to first word of the name)
  const safavieh = [1, 2, 3].map((i) => ({ product: product(i, { category: `C${i}`, brand: null, name: `SAFAVIEH Rug ${i}` }) }))
    .concat([{ product: product(4, { category: 'C4', brand: 'Safavieh' }) }, { product: product(5, { category: 'C5', brand: 'Other' }) }]);
  assert.deepEqual(diversify(safavieh, { limit: 10, perCategory: Infinity }).map((d) => d.product.id), [1, 2, 5]);
});

test('big-ticket on the home page is not one brand', () => {
  const rugs = [1, 2, 3, 4, 5].map((i) => analyzeDeal(product(i, { price: 200, msrp: 330 + i, brand: 'Safavieh' }), [], { today: TODAY }));
  const tv = analyzeDeal(product(9, { price: 300, msrp: 400, category: 'TV', brand: 'Onn' }), [], { today: TODAY });
  const picked = rankSection('bigticket', [...rugs, tv], { limit: 8 });
  assert.equal(picked.filter((d) => d.product.brand === 'Safavieh').length, 2);
  assert.ok(picked.some((d) => d.product.id === 9));
});

test('rankSection builds each section', () => {
  const analyzed = [
    analyzeDeal(product(1, { price: 300, msrp: 400, category: 'TV' }), [], { today: TODAY }),
    analyzeDeal(product(2, { price: 20, msrp: 80 }), days(30, 30, 30, 30, 30, 30, 30, 20), { today: TODAY }),
    analyzeDeal(product(3, { price: 90, msrp: 90 }), [], { today: TODAY }),
  ];
  assert.deepEqual(rankSection('bigticket', analyzed).map((d) => d.product.id), [1]);
  assert.deepEqual(rankSection('drops', analyzed).map((d) => d.product.id), [2]);
  assert.deepEqual(rankSection('lowest', analyzed).map((d) => d.product.id), [2]);
  // item 3 has no discount and no drop, so it's not a deal
  assert.deepEqual(rankSection('top', analyzed).map((d) => d.product.id).sort(), [1, 2]);
  assert.deepEqual(rankSection('top', analyzed, { category: 'TV' }).map((d) => d.product.id), [1]);
  assert.deepEqual(rankSection('top', analyzed, { minDiscount: 50 }).map((d) => d.product.id), [2]);
  assert.throws(() => rankSection('nope', analyzed), /Unknown deal section/);
});
