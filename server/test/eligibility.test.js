// node --test — the appraisal eligibility cut-off.
//
// Asked for on 24 Sep, in the client's own words:
//   "employee joined on or before 31st Dec 2026 will be eligible for
//    July 2027" and "employee joined on or after 01st Jan 2027 will be
//    eligible for July 2028"
//
// Point 5 ("suggestion of next appraisal") is the same rule read from
// the other end, so both are tested here. Dates are the thing people
// argue about, and an argument about a date is settled by a test.
//
// No database: eligibility.js is pure.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  nextAppraisalFor, eligibleForCycle, eligibilityStatement, cutoffFor,
  appraisalYearOf, dayAfter,
} = require('../modules/performance/eligibility');

const NOW = new Date('2026-09-24T00:00:00Z');
const nextOf = (doj) => nextAppraisalFor(doj, { from: NOW }).eligible_from;

test('the two sentences the client wrote come out verbatim', () => {
  const s = eligibilityStatement(2027);
  assert.equal(s.line_in,
    'Employees who joined on or before 31 December 2026 are eligible for the July 2027 appraisal.');
  assert.equal(s.line_out,
    'Employees who joined on or after 1 January 2027 are eligible for the July 2028 appraisal.');
});

test('the cut-off is the 31st of December before the appraisal', () => {
  assert.deepEqual(cutoffFor(2027), { year: 2026, month: 12, day: 31 });
  assert.deepEqual(cutoffFor(2028), { year: 2027, month: 12, day: 31 });
});

test('both sides of the boundary land where the client said', () => {
  // The exact day named in the instruction, from both directions.
  assert.deepEqual(nextOf('2026-12-31'), { year: 2027, month: 7 }, 'on the cut-off is IN');
  assert.deepEqual(nextOf('2027-01-01'), { year: 2028, month: 7 }, 'the day after is OUT');
  // And well inside each side.
  assert.deepEqual(nextOf('2020-04-01'), { year: 2027, month: 7 });
  assert.deepEqual(nextOf('2027-11-30'), { year: 2028, month: 7 });
  assert.deepEqual(nextOf('2028-01-01'), { year: 2029, month: 7 });
});

test('a joining date in the future still resolves, rather than failing', () => {
  // People are added to the master before they start.
  assert.deepEqual(nextOf('2030-03-01'), { year: 2031, month: 7 });
});

test('no joining date is said out loud, not guessed at', () => {
  const r = nextAppraisalFor(null, { from: NOW });
  assert.equal(r.eligible_from, null);
  assert.equal(r.reason, 'no_joining_date');
  assert.match(r.detail, /No date of joining/);
  // 61 employees on this master had no reporting manager; a missing
  // joining date is the same class of gap and must not silently become
  // "eligible" or "never".
  assert.equal(nextAppraisalFor('not a date', { from: NOW }).reason, 'no_joining_date');
});

test('an appraisal already past this year rolls to the next one', () => {
  // Asked in August 2027, July 2027 has been and gone.
  const after = nextAppraisalFor('2020-01-01', { from: new Date('2027-08-15T00:00:00Z') });
  assert.deepEqual(after.eligible_from, { year: 2028, month: 7 });
  // Asked in June 2027 it is still ahead.
  const before = nextAppraisalFor('2020-01-01', { from: new Date('2027-06-15T00:00:00Z') });
  assert.deepEqual(before.eligible_from, { year: 2027, month: 7 });
});

test('eligibility for a named cycle is the same rule', () => {
  assert.equal(eligibleForCycle('2026-12-31', 2027).eligible, true);
  assert.equal(eligibleForCycle('2027-01-01', 2027).eligible, false);
  assert.equal(eligibleForCycle('2027-01-01', 2028).eligible, true);
  assert.equal(eligibleForCycle(null, 2027).reason, 'no_joining_date');
  assert.equal(eligibleForCycle('2027-06-01', 2027).reason, 'joined_after_cutoff');
});

test('the rule is configurable — a client appraising in April', () => {
  const rule = { appraisal_month: 4, cutoff_month: 9, cutoff_day: 30 };
  const s = eligibilityStatement(2027, rule);
  assert.match(s.line_in, /on or before 30 September 2026 .* April 2027/);
  assert.match(s.line_out, /on or after 1 October 2026 .* April 2028/);
  assert.deepEqual(nextAppraisalFor('2026-09-30', { from: NOW, rule }).eligible_from,
    { year: 2027, month: 4 });
  assert.deepEqual(nextAppraisalFor('2026-10-01', { from: NOW, rule }).eligible_from,
    { year: 2028, month: 4 });
});

test('the day after a cut-off is a real date, not day + 1', () => {
  // `day + 1 === 32` happens to work for 31 December and is wrong for
  // every other month end — and the cut-off is a setting clients move.
  assert.deepEqual(dayAfter({ year: 2026, month: 12, day: 31 }), { year: 2027, month: 1, day: 1 });
  assert.deepEqual(dayAfter({ year: 2026, month: 9, day: 30 }), { year: 2026, month: 10, day: 1 });
  assert.deepEqual(dayAfter({ year: 2027, month: 2, day: 28 }), { year: 2027, month: 3, day: 1 });
  assert.deepEqual(dayAfter({ year: 2028, month: 2, day: 28 }), { year: 2028, month: 2, day: 29 },
    'and 2028 is a leap year');
});

test('a fiscal-year label resolves to the year the appraisal falls in', () => {
  // "FY26-27" is appraised in July 2027 — the LAST year in the label.
  assert.equal(appraisalYearOf('FY26-27'), 2027);
  assert.equal(appraisalYearOf('FY2026-2027'), 2027);
  assert.equal(appraisalYearOf('2027'), 2027);
  assert.equal(appraisalYearOf('FY27'), 2027);
  // No year in the label at all: fall back to when the cycle was made.
  assert.equal(appraisalYearOf('', new Date('2026-05-01T00:00:00Z')), 2026);
  assert.equal(appraisalYearOf(null, new Date('2026-05-01T00:00:00Z')), 2026);
});

test('a time-of-day on the joining date cannot move somebody a year', () => {
  // A date stored at 18:30 on 31 December in one zone is 1 January in
  // another. Compared as numbers, both are the 31st.
  assert.deepEqual(nextOf('2026-12-31T00:00:00Z'), { year: 2027, month: 7 });
  assert.deepEqual(nextOf('2026-12-31T23:59:59Z'), { year: 2027, month: 7 });
  assert.deepEqual(nextOf(new Date(Date.UTC(2026, 11, 31, 18, 30))), { year: 2027, month: 7 });
});
