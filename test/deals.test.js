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
  assert.equal(isEligible(product(3, { inStockOnline: false })), false);
  assert.equal(isEligible(product(4, { inStockOnline: null })), true);
  assert.equal(isEligible(product(5, { price: null })), false);
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

test('diversify caps items per category', () => {
  const deals = [1, 2, 3, 4].map((i) => ({ product: product(i, { category: 'Rugs' }) }))
    .concat([5, 6].map((i) => ({ product: product(i, { category: 'Toys' }) })));
  const picked = diversify(deals, { limit: 10, perCategory: 2 });
  assert.deepEqual(picked.map((d) => d.product.id), [1, 2, 5, 6]);
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
