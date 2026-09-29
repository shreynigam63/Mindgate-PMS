// node --test — the calibration kitty arithmetic.
//
// Asked for on 29 Sep as a spec for the Calibration page: a salary
// bracket filter, a live kitty and budget panel, per-grade increment
// ranges, three dedicated pools, and a grid computing a revised CTC.
//
// Pure: calibration-budget.js takes rows and returns figures, so every
// number below is checked directly with no database and no HTTP. That
// matters more here than anywhere else in this codebase — these numbers
// are people's pay, and a rounding error in a budget comparison is
// worse than no comparison at all.
//
// THE THREE RULES THE CLIENT CONFIRMED, each pinned below:
//   1. retention / market / promotion pools sit ON TOP of the kitty
//   2. total hike INCLUDES retention, so revised CTC is the real figure
//   3. resigned + retention not approved => zero, excluded from kitty
//      spend, still counted in the distribution
const { test } = require('node:test');
const assert = require('node:assert');
const k = require('../modules/performance/calibration-budget');

// The bands migration 063 seeds, which are the spec's own example ranges.
const MATRIX = [
  { label: 'A+', rating_min: 4.5, rating_max: 5.0, increment_pct: 17.5, increment_pct_min: 15, increment_pct_max: 20 },
  { label: 'A', rating_min: 3.5, rating_max: 4.49, increment_pct: 12, increment_pct_min: 10, increment_pct_max: 14 },
  { label: 'B+', rating_min: 2.5, rating_max: 3.49, increment_pct: 8, increment_pct_min: 7, increment_pct_max: 9 },
  { label: 'B', rating_min: 1.5, rating_max: 2.49, increment_pct: 5, increment_pct_min: 4, increment_pct_max: 6 },
  { label: 'C', rating_min: 0, rating_max: 1.49, increment_pct: 0, increment_pct_min: 0, increment_pct_max: 0 },
];
const BELL = { 5: 5, 4: 15, 3: 35, 2: 30, 1: 15 };
const BUDGET = { kitty_pct: 8, bracket_threshold: 5000000, retention_pool: 500000, market_pool: 300000, promotion_pool: 400000 };

const emp = (over = {}) => ({
  employee_id: over.employee_id || 'e1', name: over.name || 'Someone',
  final_rating: over.final_rating === undefined ? 4 : over.final_rating,
  current_ctc: over.current_ctc === undefined ? 1000000 : over.current_ctc,
  ...over,
});
const line = (employee, alloc) => k.lineFor({ employee, alloc, matrix: MATRIX });

// ---- the bracket splitter ----------------------------------------------

test('the 50-lakh boundary falls in the LOWER bracket, as "≤" says', () => {
  // The boundary is the case somebody always argues about, so it is
  // pinned rather than left to whichever comparison got typed.
  assert.equal(k.bracketOf(5000000, 5000000), 'at_or_below');
  assert.equal(k.bracketOf(5000001, 5000000), 'above');
  assert.equal(k.bracketOf(4999999, 5000000), 'at_or_below');
});

test('somebody with no CTC is in NEITHER bracket, not quietly in the lower one', () => {
  // Defaulting them to "≤ 50L" would inflate that bracket's headcount
  // with people nobody has priced.
  assert.equal(k.bracketOf(null, 5000000), 'unknown');
  assert.equal(k.bracketOf(undefined, 5000000), 'unknown');
  assert.equal(k.bracketOf('', 5000000), 'unknown');
  assert.equal(k.bracketOf('not a number', 5000000), 'unknown');
});

test('the threshold is a parameter, not 50 lakhs baked in', () => {
  // Thresholds live in tables so a client reconfigures instead of forking.
  assert.equal(k.bracketOf(3000000, 2500000), 'above');
  assert.equal(k.bracketOf(3000000, 5000000), 'at_or_below');
});

// ---- one person's line --------------------------------------------------

test('with nothing decided, the standard hike tracks the matrix', () => {
  const l = line(emp({ final_rating: 4 }));
  assert.equal(l.band_label, 'A');
  assert.equal(l.standard_pct, 12);
  assert.equal(l.total_pct, 12);
  assert.equal(l.revised_ctc, 1120000);
  assert.equal(l.standard_overridden, false);
});

test('an override replaces the matrix and is flagged as one', () => {
  const l = line(emp({ final_rating: 4 }), { standard_pct: 14, standard_reason: 'retention risk' });
  assert.equal(l.standard_pct, 14);
  assert.equal(l.standard_overridden, true);
  assert.equal(l.matrix_pct, 12, 'and what the band would have given is still reported');
});

test('RULE 2: the total includes retention, so revised CTC is the real figure', () => {
  const l = line(emp({ final_rating: 4, current_ctc: 1000000, resignation_date: '2026-10-01' }),
    { market_pct: 3, market_reason: 'below market', promoted: true, promotion_pct: 5,
      promotion_reason: 'to lead', proposed_designation: 'Lead',
      retention_approved: true, retention_pct: 2, retention_reason: 'counter-offer' });
  assert.equal(l.total_pct, 12 + 3 + 5 + 2);
  assert.equal(l.revised_ctc, 1220000, 'all four components are in the salary');
});

test('a retention lump sum lands in the revised CTC and the retention cost', () => {
  const l = line(emp({ current_ctc: 1000000, resignation_date: '2026-10-01' }),
    { retention_approved: true, retention_lumpsum: 50000, retention_reason: 'stay bonus' });
  assert.equal(l.retention_cost, 50000);
  assert.equal(l.revised_ctc, 1000000 + 120000 + 50000, 'standard 12% plus the lump sum');
});

test('RULE 3: resigned with retention NOT approved gets exactly zero', () => {
  const l = line(emp({ final_rating: 5, resignation_date: '2026-10-01' }),
    { market_pct: 9, market_reason: 'x' });
  assert.equal(l.frozen, true);
  assert.equal(l.standard_pct, 0, 'not the A+ band');
  assert.equal(l.market_pct, 0, 'and the market correction is frozen too');
  assert.equal(l.total_pct, 0);
  assert.equal(l.revised_ctc, 1000000, 'unchanged');
  assert.equal(l.total_cost, 0);
  assert.equal(l.final_rating, 5, 'but the rating they earned is still on the row');
});

test('…and approving retention unfreezes them', () => {
  const l = line(emp({ final_rating: 5, resignation_date: '2026-10-01' }),
    { retention_approved: true, retention_pct: 10, retention_reason: 'counter-offer' });
  assert.equal(l.frozen, false);
  assert.equal(l.standard_pct, 17.5, 'the A+ band applies again');
  assert.equal(l.total_pct, 27.5);
});

test('retention set on somebody who never resigned is ignored by the maths', () => {
  // The route refuses it outright; the maths refuses to spend it either
  // way, so a row written before that guard existed cannot leak money.
  const l = line(emp({ resignation_date: null }),
    { retention_approved: true, retention_pct: 10, retention_lumpsum: 99999 });
  assert.equal(l.retention_pct, 0);
  assert.equal(l.retention_cost, 0);
  assert.equal(l.retention_approved, false);
});

test('no CTC on record is reported, never costed as zero salary', () => {
  const l = line(emp({ current_ctc: null }));
  assert.equal(l.ctc_missing, true);
  assert.equal(l.current_ctc, null);
  assert.equal(l.revised_ctc, null, 'not 0 — a revised salary of nothing is a lie');
  assert.equal(l.total_cost, 0, 'and they cost the kitty nothing, because nobody knows');
  assert.equal(l.standard_pct, 12, 'the percentage still applies; only the rupees are unknown');
});

test('a hike outside the band range is flagged, not refused', () => {
  // A range is guidance. An exception is allowed and is exactly what a
  // calibration session exists to discuss — so it has to be visible.
  const over = line(emp({ final_rating: 4 }), { standard_pct: 18, standard_reason: 'x' });
  assert.equal(over.out_of_band, true, '18% is outside A (10-14)');
  const inside = line(emp({ final_rating: 4 }), { standard_pct: 13, standard_reason: 'x' });
  assert.equal(inside.out_of_band, false);
  const frozen = line(emp({ final_rating: 4, resignation_date: '2026-10-01' }));
  assert.equal(frozen.out_of_band, false, 'a frozen 0% is not an out-of-band exception');
});

test('percentages that do not add cleanly in binary still render', () => {
  // 7.1 + 3.2 + 10.7 is 21.000000000000004 in floating point, which
  // reaches the screen exactly like that unless it is rounded.
  const l = line(emp({ resignation_date: '2026-10-01' }),
    { standard_pct: 7.1, standard_reason: 'x', market_pct: 3.2, market_reason: 'y',
      retention_approved: true, retention_pct: 10.7, retention_reason: 'z' });
  assert.equal(l.total_pct, 21);
});

// ---- the page summary ---------------------------------------------------

const POP = [
  emp({ employee_id: 'a', name: 'Top', final_rating: 5, current_ctc: 6000000 }),          // above 50L
  emp({ employee_id: 'b', name: 'Mid', final_rating: 4, current_ctc: 2000000 }),
  emp({ employee_id: 'c', name: 'Low', final_rating: 2, current_ctc: 1000000 }),
  emp({ employee_id: 'd', name: 'Leaver', final_rating: 4, current_ctc: 1000000, resignation_date: '2026-10-01' }),
  emp({ employee_id: 'e', name: 'Unpriced', final_rating: 3, current_ctc: null }),
];
const view = (over = {}) => k.summarise({
  employees: POP, matrix: MATRIX, budget: BUDGET, bellCurve: BELL, ...over });

test('the bracket filter re-splits every figure, not just the table', () => {
  // A company-wide panel sitting above a filtered table reads as a
  // contradiction, and somebody will quote the wrong number from it.
  const all = view();
  assert.equal(all.counts.employees, 5);
  assert.equal(all.total_ctc, 6000000 + 2000000 + 1000000 + 1000000, 'the unpriced one adds nothing');

  const above = view({ bracket: 'above' });
  assert.equal(above.counts.employees, 1, 'only the 60-lakh earner');
  assert.equal(above.total_ctc, 6000000);
  assert.deepEqual(above.lines.map((l) => l.name), ['Top']);

  const below = view({ bracket: 'at_or_below' });
  assert.equal(below.counts.employees, 3, 'the three priced under 50L');
  assert.ok(!below.lines.some((l) => l.name === 'Unpriced'), 'unpriced is in neither bracket');
});

test('RULE 3: a frozen leaver is out of the kitty base as well as the spend', () => {
  const v = view();
  // total_ctc counts everyone priced; the kitty is measured over the
  // people who can actually receive one.
  assert.equal(v.total_ctc, 10000000);
  assert.equal(v.kitty_base_ctc, 9000000, 'the leaver drops out of the base');
  assert.equal(v.pools.kitty.approved, 720000, '8% of 90 lakhs, not of 100');
  assert.equal(v.counts.frozen, 1);
});

test('RULE 1: the pools are independent, each with its own remaining', () => {
  const v = k.summarise({
    employees: [emp({ employee_id: 'a', current_ctc: 1000000, resignation_date: '2026-10-01' })],
    allocs: { a: { market_pct: 5, market_reason: 'm', promoted: true, promotion_pct: 10,
      promotion_reason: 'p', proposed_band: 'E4', retention_approved: true,
      retention_pct: 3, retention_reason: 'r' } },
    matrix: MATRIX, budget: BUDGET, bellCurve: BELL,
  });
  // 12% standard, 5% market, 10% promotion, 3% retention on 10 lakhs.
  assert.equal(v.pools.kitty.spent, 120000, 'only the standard hike touches the kitty');
  assert.equal(v.pools.market.spent, 50000);
  assert.equal(v.pools.promotion.spent, 100000);
  assert.equal(v.pools.retention.spent, 30000);
  // Each remaining is against its OWN approved amount.
  assert.equal(v.pools.market.remaining, 300000 - 50000);
  assert.equal(v.pools.promotion.remaining, 400000 - 100000);
  assert.equal(v.pools.retention.remaining, 500000 - 30000);
  assert.equal(v.total_spend, 300000, 'and the grand total is the sum of all four');
});

test('going over a pool is flagged, naming the pool and the amount', () => {
  const v = k.summarise({
    employees: [emp({ employee_id: 'a', current_ctc: 10000000 })],
    allocs: { a: { market_pct: 10, market_reason: 'm' } },
    matrix: MATRIX, budget: { ...BUDGET, market_pool: 100000 }, bellCurve: BELL,
  });
  assert.equal(v.pools.market.over, true);
  assert.equal(v.pools.market.spent, 1000000);
  assert.equal(v.pools.market.remaining, -900000);
  const w = v.warnings.join(' | ');
  assert.match(w, /market correction pool is over/i);
  assert.match(w, /9,00,000/, 'the amount, in the notation the client reads');
  assert.match(w, /market correction pool is over by/, 'and it says which pool');
});

test('an unset pool does not read as 100% spent', () => {
  // 0/0 is the classic divide that renders as NaN% or 100% and panics
  // somebody into thinking a budget is blown.
  const v = k.summarise({ employees: [], matrix: MATRIX,
    budget: { kitty_pct: 0, bracket_threshold: 5000000 }, bellCurve: BELL });
  assert.equal(v.pools.market.used_pct, null);
  assert.equal(v.pools.market.over, false);
  assert.deepEqual(v.warnings, []);
});

test('the grade table maps ratings to A+/A/B+/B/C with target vs actual', () => {
  const v = view();
  const byLabel = Object.fromEntries(v.grades.map((g) => [g.label, g]));
  assert.deepEqual(v.grades.map((g) => g.label), ['A+', 'A', 'B+', 'B', 'C']);
  assert.equal(byLabel['A+'].target_pct, 5, 'the bell curve already on the cycle');
  assert.equal(byLabel['A+'].count, 1);
  assert.equal(byLabel['A'].count, 2, 'Mid and Leaver are both rated 4');
  assert.equal(byLabel['A'].actual_pct, 40, '2 of 5');
  assert.equal(byLabel['A+'].increment_min_pct, 15);
  assert.equal(byLabel['A+'].increment_max_pct, 20);
  assert.equal(byLabel['C'].count, 0, 'an empty grade is a row of zeros, not a missing row');
});

test('the frozen leaver still counts in the distribution they earned', () => {
  // RULE 3 zeroes their money, not their rating. Dropping them would
  // make the bell curve describe a different population from the one
  // that was rated.
  const v = view();
  const a = v.grades.find((g) => g.label === 'A');
  assert.equal(a.count, 2);
  assert.equal(a.spend, 240000, 'but only Mid contributes rupees (12% of 20 lakhs)');
});

test('missing CTC is counted and said out loud', () => {
  const v = view();
  assert.equal(v.counts.ctc_missing, 1);
  assert.match(v.warnings.join(' '), /1 person has no CTC on record/);
});

test('an empty population produces zeros, not NaN', () => {
  const v = k.summarise({ employees: [], matrix: MATRIX, budget: BUDGET, bellCurve: BELL });
  assert.equal(v.total_ctc, 0);
  assert.equal(v.pools.kitty.approved, 0);
  assert.equal(v.total_spend, 0);
  for (const g of v.grades) { assert.equal(g.count, 0); assert.equal(g.actual_pct, 0); }
});

test('a thousand awkward salaries total to the exact paise', () => {
  // WHAT THIS DOES AND DOES NOT PROVE, measured rather than assumed.
  //
  // The module works in integer paise throughout, matching
  // increment-rules.js. I tried to pin that with a poison — sum the
  // pool totals in rupees as floats instead — and it DID NOT BITE, at
  // 1,000 employees or at the client's 1,427. The reason is that each
  // line's cost is already rounded to the paise before it is added, so
  // a thousand float additions drift by about 0.00008 rupees, far under
  // the half-paise that would change the rounded total.
  //
  // So the paise discipline here is defensive, not load-bearing, and
  // this test does not guard it — it guards the TOTALS, which is worth
  // having on its own: an off-by-one in the rate, the base or the
  // rounding direction all fail it. Said plainly so that nobody later
  // reads a passing suite as proof the integer arithmetic is required,
  // and nobody removes the integer arithmetic believing this covers it.
  const many = Array.from({ length: 1000 }, (_, i) =>
    emp({ employee_id: `x${i}`, final_rating: 3, current_ctc: 1000000.33 }));
  const v = k.summarise({ employees: many, matrix: MATRIX, budget: BUDGET, bellCurve: BELL });
  // 8% of 1000 x 1000000.33
  assert.equal(v.pools.kitty.approved, 80000026.4);
  // B+ is 8%: 8% of 1000000.33 = 80000.0264, to the paise 80000.03.
  assert.equal(v.pools.kitty.spent, 80000030);
  assert.equal(v.total_ctc, 1000000330);
});

// ---- what the routes will accept ---------------------------------------

test('every special hike needs its reason', () => {
  const base = { standard_pct: null, market_pct: 0, promotion_pct: 0, retention_pct: 0, retention_lumpsum: 0 };
  assert.match(k.validateAllocation({ ...base, market_pct: 5 }), /market correction needs a reason/i);
  assert.match(k.validateAllocation({ ...base, promotion_pct: 5, promoted: true, proposed_band: 'E4' }),
    /promotion hike needs a reason/i);
  assert.match(k.validateAllocation({ ...base, standard_pct: 20 }), /needs a reason/i);
  assert.equal(k.validateAllocation({ ...base, market_pct: 5, market_reason: 'below market' }), null);
});

test('a promotion has to say what it is TO', () => {
  const r = k.validateAllocation({ standard_pct: null, market_pct: 0, promotion_pct: 0,
    retention_pct: 0, retention_lumpsum: 0, promoted: true });
  assert.match(r, /new designation or band/i);
});

test('a promotion hike without the promotion flag is refused', () => {
  const r = k.validateAllocation({ standard_pct: null, market_pct: 0, promotion_pct: 8,
    promotion_reason: 'x', retention_pct: 0, retention_lumpsum: 0, promoted: false });
  assert.match(r, /marked as promoted/i);
});

test('retention on somebody who never resigned is refused outright', () => {
  const a = { standard_pct: null, market_pct: 0, promotion_pct: 0, retention_pct: 5,
    retention_lumpsum: 0, retention_approved: true, retention_reason: 'x' };
  assert.match(k.validateAllocation(a, { resigned: false }), /only to somebody who has resigned/i);
  assert.equal(k.validateAllocation(a, { resigned: true }), null);
});

test('a retention amount without approval is refused', () => {
  const r = k.validateAllocation({ standard_pct: null, market_pct: 0, promotion_pct: 0,
    retention_pct: 5, retention_lumpsum: 0, retention_approved: false }, { resigned: true });
  assert.match(r, /approved first/i);
});

test('a typo that doubles a salary is caught before it is saved', () => {
  const r = k.validateAllocation({ standard_pct: 900, standard_reason: 'oops',
    market_pct: 0, promotion_pct: 0, retention_pct: 0, retention_lumpsum: 0 });
  assert.match(r, /looks like a typo/i);
});

test('the budget refuses nonsense, in sentences', () => {
  assert.match(k.validateBudget({ kitty_pct: -1 }), /zero or more/i);
  assert.match(k.validateBudget({ kitty_pct: 400 }), /typo/i);
  assert.match(k.validateBudget({ bracket_threshold: 0 }), /more than zero/i);
  assert.match(k.validateBudget({ retention_pool: -5 }), /retention pool must be zero or more/i);
  assert.equal(k.validateBudget({ kitty_pct: 8, retention_pool: 500000 }), null);
  assert.equal(k.validateBudget({}), null, 'an empty patch changes nothing and is fine');
});

test('a patch changes one field without wiping the rest', () => {
  // The grid saves field by field. A body carrying only market_pct must
  // not erase the promotion reason typed a minute ago.
  const cur = { standard_pct: 14, standard_reason: 'kept', market_pct: 3, market_reason: 'also kept',
    promoted: true, proposed_band: 'E4', promotion_pct: 5, promotion_reason: 'still here',
    retention_approved: false, retention_pct: 0, retention_lumpsum: 0, retention_reason: null };
  const merged = k.mergeAllocation(cur, { market_pct: 6 });
  assert.equal(merged.market_pct, 6);
  assert.equal(merged.market_reason, 'also kept');
  assert.equal(merged.standard_pct, 14);
  assert.equal(merged.promotion_reason, 'still here');
  assert.equal(merged.proposed_band, 'E4');
  assert.equal(merged.promoted, true);
});

test('clearing the standard hike returns it to the matrix, rather than setting zero', () => {
  // NULL means "track the band". Coercing a cleared input to 0 would
  // silently give somebody no increment at all.
  const merged = k.mergeAllocation({ standard_pct: 14, standard_reason: 'x' }, { standard_pct: '' });
  assert.equal(merged.standard_pct, null);
  const l = line(emp({ final_rating: 4 }), merged);
  assert.equal(l.standard_pct, 12, 'back to the A band');
});

// ---- the seeded matrix, read back out of a real database ---------------
//
// BOTH BUGS BELOW WERE FOUND THIS WAY, not by reading the literals.
// rating_min/rating_max are numeric(3,1), so a seed written as 4.49 is
// STORED as 4.5 — and the code was then reasoning about a number the
// database never held.
const { GRADES } = require('../migrations/063-calibration-kitty');
const { validateMatrix } = require('../modules/performance/increment-rules');

test('the seeded bands survive one decimal place without overlapping', () => {
  // numeric(3,1) rounds the literals. If a band's max rounds up onto
  // the next band's min, two bands claim the same rating — and since
  // ranges are inclusive at both ends, validateMatrix refuses the whole
  // matrix the first time HR presses save on the Increment Simulation
  // page. The seed would have shipped a matrix the app rejects.
  const stored = GRADES.map((g) => ({
    label: g.label,
    rating_min: Math.round(g.min * 10) / 10,   // what numeric(3,1) keeps
    rating_max: Math.round(g.max * 10) / 10,
    increment_pct: (g.lo + g.hi) / 2,
  }));
  assert.deepEqual(validateMatrix(stored), [], 'the seeded matrix must be one the app accepts');
});

test('each seeded band maps to the rating whose bell-curve target it takes', () => {
  // The off-by-one: Math.round(4.5) is 5, so "A" read A+'s target and
  // every grade below shifted by one. Every number on screen still
  // looked plausible, which is what made it worth a test.
  const matrix = GRADES.map((g) => ({
    label: g.label,
    rating_min: Math.round(g.min * 10) / 10,
    rating_max: Math.round(g.max * 10) / 10,
    increment_pct: (g.lo + g.hi) / 2, increment_pct_min: g.lo, increment_pct_max: g.hi,
  }));
  const v = k.summarise({ employees: [], matrix, budget: BUDGET, bellCurve: BELL });
  assert.deepEqual(
    v.grades.map((g) => `${g.label}=${g.target_pct}`),
    ['A+=5', 'A=15', 'B+=35', 'B=30', 'C=15'],
    'A+ takes rating 5s target, A takes 4s, and so on down');
});

test('a rating lands in exactly one seeded band, including on the boundaries', () => {
  const matrix = GRADES.map((g) => ({
    label: g.label, rating_min: Math.round(g.min * 10) / 10, rating_max: Math.round(g.max * 10) / 10,
    increment_pct: (g.lo + g.hi) / 2,
  }));
  for (const [rating, expected] of [[5, 'A+'], [4.5, 'A+'], [4.4, 'A'], [4, 'A'], [3.5, 'A'],
    [3.4, 'B+'], [3, 'B+'], [2.4, 'B'], [2, 'B'], [1.4, 'C'], [1, 'C'], [0, 'C']]) {
    const hits = matrix.filter((b) => rating >= b.rating_min && rating <= b.rating_max);
    assert.equal(hits.length, 1, `rating ${rating} matched ${hits.length} bands: ${hits.map((h) => h.label)}`);
    assert.equal(hits[0].label, expected, `rating ${rating} should be ${expected}`);
  }
});

test('a band ending on a half takes the whole rating INSIDE it, not the one above', () => {
  // Pinned separately because with the corrected seed (4.4, 3.4, …)
  // Math.round and Math.floor agree, so the seeded-matrix tests above
  // cannot tell them apart — putting Math.round back leaves them all
  // green. They only diverge on a band whose top end is a half, which
  // a tenant is free to configure: 3.6-4.5 contains the rating 4 and
  // no other, so it takes 4's bell-curve target. Math.round would hand
  // it 5's, and every grade below would shift by one.
  const matrix = [
    { label: 'Top', rating_min: 4.6, rating_max: 5.0, increment_pct: 15 },
    { label: 'Next', rating_min: 3.6, rating_max: 4.5, increment_pct: 10 },
    { label: 'Mid', rating_min: 2.6, rating_max: 3.5, increment_pct: 7 },
  ];
  const v = k.summarise({ employees: [], matrix, budget: BUDGET, bellCurve: BELL });
  assert.deepEqual(v.grades.map((g) => `${g.label}=${g.target_pct}`),
    ['Top=5', 'Next=15', 'Mid=35']);
});

test('the FIRST allocation on a person merges onto nothing and still saves', () => {
  // The bug this pins: merging {market_pct: 5} onto a row that does not
  // exist left every other percentage as Number(undefined) — NaN — and
  // validateAllocation rightly refused it, so the first save for any
  // employee returned 422. The patch test above missed it entirely by
  // starting from a fully populated row, which is the one case where
  // no key is ever absent. Found by the HTTP test, pinned here.
  const merged = k.mergeAllocation({}, { market_pct: 5, market_reason: 'below market' });
  assert.equal(merged.promotion_pct, 0);
  assert.equal(merged.retention_pct, 0);
  assert.equal(merged.retention_lumpsum, 0);
  assert.equal(merged.standard_pct, null, 'and the standard still tracks the band');
  assert.equal(k.validateAllocation(merged, { resigned: false }), null);
});
