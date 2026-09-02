// node --test — the increment maths. Pure, no database.
//
// This is money. Every figure here was worked out by hand first and the
// expected values are written as arithmetic, not as whatever the code
// happened to return — a test that records the current output would pass
// just as happily on a wrong answer.
const { test } = require('node:test');
const assert = require('node:assert');
const incr = require('../modules/performance/increment-rules');

const MATRIX = [
  { label: 'Outstanding', rating_min: 4.5, rating_max: 5, increment_pct: 12 },
  { label: 'Exceeds',     rating_min: 3.5, rating_max: 4.4, increment_pct: 8 },
  { label: 'Meets',       rating_min: 2.5, rating_max: 3.4, increment_pct: 5 },
  { label: 'Below',       rating_min: 1,   rating_max: 2.4, increment_pct: 0 },
];

const emp = (id, rating, ctc, department = 'Eng') =>
  ({ employee_id: id, name: `Emp ${id}`, department, final_rating: rating, current_ctc: ctc });

test('a rating lands in its band, inclusive at both ends', () => {
  assert.equal(incr.matchBand(MATRIX, 5).increment_pct, 12);
  assert.equal(incr.matchBand(MATRIX, 4.5).increment_pct, 12, 'the lower edge belongs to the band');
  assert.equal(incr.matchBand(MATRIX, 4.4).increment_pct, 8, 'and the upper edge to the one below');
  // A weighted final rating is legitimately fractional — an exact-match
  // table would never have hit this at all.
  assert.equal(incr.matchBand(MATRIX, 4.2).increment_pct, 8);
  assert.equal(incr.matchBand(MATRIX, 0.5), null, 'outside every band is null, not a guess');
  assert.equal(incr.matchBand(MATRIX, null), null);
});

test('an overlapping matrix is rejected — one rating cannot mean two increments', () => {
  const errors = incr.validateMatrix([
    { rating_min: 4, rating_max: 5, increment_pct: 12 },
    { rating_min: 3, rating_max: 4.2, increment_pct: 8 },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /overlaps row 1/);
});

test('a backwards range, a negative percent and an absurd one are each caught', () => {
  const errors = incr.validateMatrix([
    { rating_min: 5, rating_max: 3, increment_pct: 10 },
    { rating_min: 2, rating_max: 2.4, increment_pct: -1 },
    { rating_min: 1, rating_max: 1.9, increment_pct: 400 },
  ]);
  const byRow = Object.fromEntries(errors.map((e) => [e.row, e.error]));
  assert.match(byRow[1], /backwards/);
  assert.match(byRow[2], /zero or more/);
  assert.match(byRow[3], /typa|typo|doubling/i);
});

test('a clean matrix passes', () => {
  assert.deepEqual(incr.validateMatrix(MATRIX), []);
});

test('the basic case: each employee gets their band, and the totals add up', () => {
  const r = incr.simulate({
    employees: [emp('a', 5, 1000000), emp('b', 4, 800000), emp('c', 3, 600000)],
    matrix: MATRIX,
  });
  // 1,000,000 @ 12% = 120,000 · 800,000 @ 8% = 64,000 · 600,000 @ 5% = 30,000
  assert.deepEqual(r.lines.map((l) => l.increment_amount), [120000, 64000, 30000]);
  assert.deepEqual(r.lines.map((l) => l.new_ctc), [1120000, 864000, 630000]);
  assert.equal(r.totals.increment_total, 214000);
  assert.equal(r.totals.current_total, 2400000);
  assert.equal(r.totals.new_total, 2614000);
  // 214,000 / 2,400,000 = 8.9166…% -> 8.92
  assert.equal(r.totals.average_increment_pct, 8.92);
  assert.equal(r.lines[0].band_label, 'Outstanding');
});

test('nobody is silently dropped — each exclusion says why', () => {
  const r = incr.simulate({
    employees: [
      emp('paid', 5, 1000000),
      { employee_id: 'nopay', name: 'No Pay', department: 'Eng', final_rating: 5, current_ctc: null },
      { employee_id: 'norating', name: 'No Rating', department: 'Eng', final_rating: null, current_ctc: 500000 },
      emp('offscale', 9, 500000),
    ],
    matrix: MATRIX,
  });
  assert.equal(r.lines.length, 1);
  const why = Object.fromEntries(r.excluded.map((e) => [e.employee_id, e.reason]));
  assert.match(why.nopay, /no salary on record/);
  assert.match(why.norating, /no published rating/);
  assert.match(why.offscale, /outside every band/);
  assert.equal(r.totals.excluded, 3, 'and they are counted, so the report cannot quietly under-state headcount');
});

test('a budget is compared, not enforced, unless scale-to-fit is asked for', () => {
  const employees = [emp('a', 5, 1000000), emp('b', 5, 1000000)]; // 240,000 modelled
  const over = incr.simulate({ employees, matrix: MATRIX, budgetAmount: 200000 });
  assert.equal(over.totals.increment_total, 240000);
  assert.equal(over.totals.within_budget, false);
  assert.equal(over.totals.variance, -40000, 'negative variance is the overspend');
  assert.equal(over.totals.scaled, false, 'without scale-to-fit the numbers stand and the gap is shown');

  const under = incr.simulate({ employees, matrix: MATRIX, budgetAmount: 300000 });
  assert.equal(under.totals.within_budget, true);
  assert.equal(under.totals.variance, 60000);
});

test('scale-to-fit lands exactly on the budget', () => {
  const r = incr.simulate({
    employees: [emp('a', 5, 1000000), emp('b', 5, 1000000)],
    matrix: MATRIX, budgetAmount: 200000, scaleToFit: true,
  });
  // 240,000 modelled against a 200,000 pot -> factor 0.8333… -> 12% -> 10%
  assert.equal(r.totals.increment_total, 200000);
  assert.equal(r.totals.within_budget, true);
  assert.equal(r.totals.scaled, true);
  assert.deepEqual(r.lines.map((l) => l.increment_pct), [10, 10]);
  assert.ok(r.lines.every((l) => l.scaled));
});

test('scale-to-fit does nothing when the model is already inside the budget', () => {
  const r = incr.simulate({
    employees: [emp('a', 3, 1000000)], matrix: MATRIX, budgetAmount: 900000, scaleToFit: true,
  });
  assert.equal(r.totals.increment_total, 50000, 'not scaled UP to spend the pot');
  assert.equal(r.totals.scaled, false);
});

test('an override replaces the band, keeps its reason, and survives scale-to-fit', () => {
  // The squeeze falls on matrix-driven lines only: an override is a
  // decision somebody signed their name to.
  const r = incr.simulate({
    employees: [emp('a', 5, 1000000), emp('b', 5, 1000000)],
    matrix: MATRIX,
    overrides: { a: { increment_pct: 20, reason: 'Counter-offer' } },
    budgetAmount: 300000, scaleToFit: true,
  });
  const [a, b] = r.lines;
  assert.equal(a.increment_pct, 20, 'untouched');
  assert.equal(a.increment_amount, 200000);
  assert.equal(a.overridden, true);
  assert.equal(a.override_reason, 'Counter-offer');
  assert.equal(a.base_pct, 12, 'what the matrix would have given is still reported');
  // 300,000 pot − 200,000 fixed = 100,000 for b, who was on 120,000 at 12%
  assert.equal(b.increment_pct, 10);
  assert.equal(b.increment_amount, 100000);
  assert.equal(r.totals.increment_total, 300000);
});

test('when overrides alone blow the budget, nothing is scaled to nonsense', () => {
  const r = incr.simulate({
    employees: [emp('a', 5, 1000000), emp('b', 5, 1000000)],
    matrix: MATRIX,
    overrides: { a: { increment_pct: 50, reason: 'Retention' } },   // 500,000
    budgetAmount: 300000, scaleToFit: true,
  });
  // There is no room left to squeeze out of b. Reporting the overspend is
  // more use than a negative or zero increment nobody asked for.
  assert.equal(r.lines[1].increment_pct, 12, 'left alone');
  assert.equal(r.totals.increment_total, 620000);
  assert.equal(r.totals.within_budget, false);
  assert.equal(r.totals.scaled, false);
});

test('an override lets someone outside every band still be modelled', () => {
  const r = incr.simulate({
    employees: [emp('a', 9, 500000)],
    matrix: MATRIX,
    overrides: { a: { increment_pct: 6, reason: 'Rating scale mismatch, agreed with HR' } },
  });
  assert.equal(r.excluded.length, 0);
  assert.equal(r.lines[0].increment_amount, 30000);
  assert.equal(r.lines[0].band_label, null, 'there was no band — saying so beats inventing one');
});

test('money is summed in minor units, so a thousand lines still reconcile', () => {
  // 1,000 employees on 833,333.33 at 7.5%. Summed as floats this drifts;
  // the figure has to match what adding the column gives.
  const employees = Array.from({ length: 1000 }, (_, i) => emp(`e${i}`, 3, 833333.33));
  const r = incr.simulate({ employees, matrix: [{ rating_min: 2.5, rating_max: 3.4, increment_pct: 7.5 }] });
  // 833,333.33 * 7.5% = 62,499.99975 -> 62,500.00 per line, x1000
  assert.equal(r.lines[0].increment_amount, 62500);
  assert.equal(r.totals.increment_total, 62500000);
  assert.equal(r.totals.current_total, 833333330);
});

test('a zero-percent band is a real answer, not a missing one', () => {
  const r = incr.simulate({ employees: [emp('a', 2, 500000)], matrix: MATRIX });
  assert.equal(r.excluded.length, 0, 'they are modelled...');
  assert.equal(r.lines[0].increment_pct, 0, '...at zero, which is what the policy says');
  assert.equal(r.lines[0].new_ctc, 500000);
});

test('an empty run reports zeroes rather than dividing by nothing', () => {
  const r = incr.simulate({ employees: [], matrix: MATRIX, budgetAmount: 100000 });
  assert.equal(r.totals.employees, 0);
  assert.equal(r.totals.average_increment_pct, 0);
  assert.equal(r.totals.increment_total, 0);
  assert.equal(r.totals.within_budget, true);
});

test('departments are rolled up and ordered by what they cost', () => {
  const r = incr.simulate({
    employees: [emp('a', 5, 1000000, 'Eng'), emp('b', 3, 600000, 'Support'), emp('c', 5, 400000, 'Eng')],
    matrix: MATRIX,
  });
  const d = incr.byDepartment(r.lines);
  assert.deepEqual(d.map((x) => x.department), ['Eng', 'Support']);
  assert.equal(d[0].increment_total, 168000); // 120,000 + 48,000
  assert.equal(d[0].employees, 2);
  assert.equal(d[0].average_increment_pct, 12);
  assert.equal(d[1].increment_total, 30000);
});
