// node --test — Super 50 eligibility rule (pure logic, no DB).
const { test } = require('node:test');
const assert = require('node:assert');
const { isSuper50Eligible } = require('../modules/performance/rating-rules');

test('3 consecutive A/A+ with the most recent an A+ (5) qualifies', () => {
  assert.equal(isSuper50Eligible([5, 4, 4]), true);
  assert.equal(isSuper50Eligible([5, 5, 5]), true);
  assert.equal(isSuper50Eligible([5, 4, 5]), true);
});

test('most recent must be A+ (5) specifically — an A (4) most recently does not qualify', () => {
  assert.equal(isSuper50Eligible([4, 5, 5]), false, 'most recent is 4 (A), not 5 (A+)');
});

test('any of the last 3 below A (4) breaks the streak', () => {
  assert.equal(isSuper50Eligible([5, 3, 5]), false);
  assert.equal(isSuper50Eligible([5, 5, 3]), false);
});

test('fewer than 3 published cycles is not eligible, not an error', () => {
  assert.equal(isSuper50Eligible([]), false);
  assert.equal(isSuper50Eligible([5]), false);
  assert.equal(isSuper50Eligible([5, 5]), false);
});

test('only the first 3 entries are considered even if more are passed', () => {
  assert.equal(isSuper50Eligible([5, 5, 5, 1, 1]), true, 'older history beyond the last 3 is irrelevant');
  assert.equal(isSuper50Eligible([1, 1, 1, 5, 5, 5]), false, 'the most-recent-first 3 are [1,1,1], not the trailing 5s');
});

test('rounds fractional ratings before comparing (matches the label() rounding elsewhere)', () => {
  assert.equal(isSuper50Eligible([4.6, 4.5, 4.5]), true, 'rounds to 5,5,5 (banker/half-up per Math.round)');
  assert.equal(isSuper50Eligible([4.4, 4.0, 4.0]), false, 'rounds to 4,4,4 — most recent is not a 5');
});

test('non-numeric or malformed entries are treated as not eligible, not thrown', () => {
  assert.equal(isSuper50Eligible(null), false);
  assert.equal(isSuper50Eligible(undefined), false);
  assert.equal(isSuper50Eligible(['x', 5, 5]), false);
});

// ---------- computeWeightedRating (BR-6.2/6.3) ------------------------------
const { computeWeightedRating } = require('../modules/performance/rating-rules');

test('weighted rating: equal weights, all scored, matches simple average', () => {
  const params = [{ id: 'a', weight_pct: 50 }, { id: 'b', weight_pct: 50 }];
  const r = computeWeightedRating(params, { a: 4, b: 2 });
  assert.equal(r.complete, true);
  assert.equal(r.rating, 3); // (4*0.5)+(2*0.5)=3
});

test('weighted rating: uneven weights computed correctly', () => {
  const params = [{ id: 'a', weight_pct: 70 }, { id: 'b', weight_pct: 30 }];
  const r = computeWeightedRating(params, { a: 5, b: 1 });
  assert.equal(r.complete, true);
  assert.equal(r.rating, 3.8); // 5*0.7 + 1*0.3 = 3.8
});

test('weighted rating: missing a score is incomplete, reports which parameter', () => {
  const params = [{ id: 'a', weight_pct: 50 }, { id: 'b', weight_pct: 50 }];
  const r = computeWeightedRating(params, { a: 4 });
  assert.equal(r.complete, false);
  assert.deepEqual(r.missing, ['b']);
});

test('weighted rating: accepts a Map as well as a plain object for scores', () => {
  const params = [{ id: 'a', weight_pct: 100 }];
  const r = computeWeightedRating(params, new Map([['a', 4]]));
  assert.equal(r.complete, true);
  assert.equal(r.rating, 4);
});

test('weighted rating: zero parameters is not complete and has no rating', () => {
  const r = computeWeightedRating([], {});
  assert.equal(r.complete, false);
  assert.equal(r.rating, null);
});

test('weighted rating: rounds to one decimal place', () => {
  const params = [{ id: 'a', weight_pct: 33.33 }, { id: 'b', weight_pct: 33.33 }, { id: 'c', weight_pct: 33.34 }];
  const r = computeWeightedRating(params, { a: 3, b: 4, c: 5 });
  assert.equal(r.complete, true);
  assert.equal(r.rating, 4); // (3+4+5)/3 = 4 exactly, but via weights ~3.9999+ -> rounds to 4.0
});
