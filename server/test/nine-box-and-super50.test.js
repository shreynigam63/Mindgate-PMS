// node --test — the two rules asked for on 24 Sep.
//
//   1. "after analyzing competency mapping of employees in Annual
//      review cycle, please confirm how 9 box grid will be displayed"
//   2. "configure logic of super 50 where ratings will be derived from
//      last three annual reviews and ratings should be A or A+ with
//      current year ratings as A+"
//
// Both are pure modules on purpose, so the bands and the streak rule
// can be tested without a database — which is where the arguments
// about these numbers will actually happen.
//
// No database: nothing here touches one.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  super50Check, isSuper50Eligible, gradeValue, DEFAULT_SCALE,
} = require('../modules/performance/rating-rules');
const { parsePriorRatings, sortYear } = require('../modules/performance/prior-ratings-import');

const SCALE = DEFAULT_SCALE; // A+=5, A=4, B+=3, B=2, C=1 — this client's own

// ---- 9-box --------------------------------------------------------------
// The 24 Sep 9-box rules tested here (fractions of the scale, potential as
// a gap over forward-looking categories) were replaced by the client's
// 9-box build specification on 13 Oct. Their tests went with them; the
// spec's rules are in nine-box-rules.test.js.

// ---- Super 50 -----------------------------------------------------------

test('the rule is three annual reviews at A or better with this year A+', () => {
  assert.equal(super50Check([5, 4, 5], SCALE).eligible, true);
  assert.equal(super50Check([5, 5, 5], SCALE).eligible, true);
  assert.equal(super50Check([5, 4, 4], SCALE).eligible, true);
  // This year is not A+.
  assert.equal(super50Check([4, 5, 5], SCALE).reason, 'latest_not_top');
  // A B+ in the window breaks it.
  assert.equal(super50Check([5, 3, 5], SCALE).reason, 'streak_broken');
  // Only the WINDOW counts — a fourth bad year further back does not.
  assert.equal(super50Check([5, 4, 5, 1], SCALE).eligible, true);
});

test('too little history is "not yet", not a fail — and says how short', () => {
  // The distinction that matters on a new installation: 1,398 people
  // with no published cycles are unmeasured, not underperforming.
  const r = super50Check([5, 5], SCALE);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'not_enough_history');
  assert.equal(r.have, 2);
  assert.equal(r.need, 3);
  assert.match(r.detail, /2 of 3/);
  assert.equal(super50Check([], SCALE).reason, 'not_enough_history');
});

test('the grades come off the scale, not out of the code', () => {
  // THE CHANGE ASKED FOR. It used to test `>= 4` and `=== 5`, which is
  // a fact about this client's grade scale compiled into the product.
  assert.equal(gradeValue(SCALE, 'A+'), 5);
  assert.equal(gradeValue(SCALE, 'a'), 4, 'case does not matter');
  assert.equal(gradeValue(SCALE, 'Outstanding'), null);

  // A ten-point scale where the top grade is 10, not 5.
  const ten = [{ label: 'A+', value: 10 }, { label: 'A', value: 8 }, { label: 'B', value: 5 }];
  assert.equal(super50Check([10, 8, 10], ten).eligible, true,
    'the old hardcoded ===5 could never have fired here');
  assert.equal(super50Check([8, 10, 10], ten).reason, 'latest_not_top');

  // A scale with no A/A+ at all is a misconfiguration, and is named as
  // one rather than silently failing everybody.
  const words = [{ label: 'Outstanding', value: 5 }, { label: 'Exceeds', value: 4 }];
  const bad = super50Check([5, 5, 5], words);
  assert.equal(bad.reason, 'scale_mismatch');
  assert.match(bad.detail, /not grades on this cycle's rating scale/);
});

test('the window, the minimum and this year\'s grade are all configurable', () => {
  // Two years of B+ or better, this year an A.
  const rule = { window: 2, minGrade: 'B+', latestGrade: 'A' };
  assert.equal(super50Check([4, 3], SCALE, rule).eligible, true);
  assert.equal(super50Check([5, 3], SCALE, rule).reason, 'latest_not_top', 'A+ is not A');
  assert.equal(super50Check([4, 2], SCALE, rule).reason, 'streak_broken');
});

test('the legacy boolean still behaves exactly as it did', () => {
  // Every existing caller and test passed only an array.
  assert.equal(isSuper50Eligible([5, 4, 4]), true);
  assert.equal(isSuper50Eligible([4, 5, 5]), false);
  assert.equal(isSuper50Eligible([5, 5]), false);
  assert.equal(isSuper50Eligible(null), false);
  assert.equal(isSuper50Eligible(['x', 5, 5]), false);
});

// ---- prior-year ratings -------------------------------------------------

test('a fiscal year label is read from its FIRST run of digits', () => {
  // "FY24-25" is the 2024 year. Reading it as 2025 puts every imported
  // rating one year out, and then a published FY24-25 cycle and an
  // imported FY24-25 row stop being the same year.
  assert.equal(sortYear('FY24-25'), 2024);
  assert.equal(sortYear('2024-25'), 2024);
  assert.equal(sortYear('FY24'), 2024);
  assert.equal(sortYear('2024'), 2024);
  assert.equal(sortYear('FY2024-2025'), 2024);
  assert.equal(sortYear('no digits'), null);
});

test('the prior-ratings sheet accepts grades or numbers, and refuses nonsense', () => {
  const rows = [
    ['a banner nobody reads'],
    ['Employee Code', 'Email', 'Employee Name', 'Fiscal Year', 'Rating'],
    ['00042', '', 'Aakash', 'FY24-25', 'A+'],
    ['', 'x@y.com', 'Bee', '2023', '4'],
    ['', '', '', '', ''],
    ['00099', '', 'Cee', 'FY22-23', 'Z'],
    ['00100', '', 'Dee', 'FY22-23', '9'],
    ['00101', '', 'Eee', 'no year here', 'A'],
    ['', '', 'Fff', 'FY22-23', 'A'],
  ];
  const r = parsePriorRatings(rows, SCALE);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].grade, 'A+');
  assert.equal(r.rows[0].rating, 5);
  assert.equal(r.rows[0].sort_year, 2024);
  assert.equal(r.rows[1].grade, 'A', 'a bare 4 is labelled back as A');
  const errs = r.errors.map((e) => e.error).join(' | ');
  assert.match(errs, /not a grade on this scale/);
  assert.match(errs, /outside this scale/);
  assert.match(errs, /Could not read a year/);
  assert.match(errs, /Employee Code or Email is required/);
});

test('the same person and year twice in one file is refused, not silently overwritten', () => {
  const r = parsePriorRatings([
    ['Employee Code', 'Fiscal Year', 'Rating'],
    ['00042', 'FY24-25', 'A+'],
    ['00042', 'FY24-25', 'B'],
  ], SCALE);
  assert.equal(r.rows.length, 1);
  assert.match(r.errors[0].error, /duplicate of line 2/);
});

test('a sheet with no recognisable header is rejected with a reason', () => {
  const r = parsePriorRatings([['who', 'knows'], ['a', 'b']], SCALE);
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0].error, /Could not find the header row/);
});
