// Who is in this appraisal cycle, and when the rest come in.
//
// Asked for on 24 Sep, in the client's own words:
//   "employee joined on or before 31st Dec 2026 will be eligible for
//    July 2027" and "employee joined on or after 01st Jan 2027 will be
//    eligible for July 2028"
//
// That is one rule with two halves: an appraisal in July covers people
// who joined by the 31st of December before it, and everybody else
// waits for the next July. Stated generally rather than as two fixed
// dates, because the same rule has to answer July 2028 and July 2029
// without anybody editing code — which is also the whole of point 5,
// "suggestion of next appraisal": the next appraisal IS the first July
// whose cut-off this person is on the right side of.
//
// Pure — no db, no express. The dates are the kind of thing people
// argue about, and an argument about a date is settled by a test.

// The defaults, as a client's HR would state them. Both are settings,
// so a company that appraises in April against a September cut-off
// changes two values rather than waiting for a release.
const DEFAULTS = {
  appraisal_month: 7,   // July
  cutoff_month: 12,     // the December before it...
  cutoff_day: 31,       // ...on the 31st
};

const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// The cut-off that governs the appraisal held in July of `year`:
// 31 December of the year before. Returned as a plain
// {year, month, day} so callers can format it however they print dates
// and never have to think about time zones — which is where date bugs
// in HR software actually come from.
function cutoffFor(appraisalYear, rule = {}) {
  const r = { ...DEFAULTS, ...rule };
  return { year: appraisalYear - 1, month: r.cutoff_month, day: r.cutoff_day };
}

// Is a date on or before a cut-off? Compared as numbers, not as Date
// objects, so a joining date stored at midnight UTC and a cut-off built
// in local time cannot disagree by a few hours and move somebody into
// the wrong year.
const onOrBefore = (d, c) => {
  const a = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return a <= c.year * 10000 + c.month * 100 + c.day;
};

// The first appraisal a person is eligible for.
//
// `from` is the date to reckon from — normally today, passed in rather
// than read off the clock so the answer is testable and so a report run
// for a past cycle gives that cycle's answer.
function nextAppraisalFor(dateOfJoining, { from = new Date(), rule = {} } = {}) {
  const r = { ...DEFAULTS, ...rule };
  const doj = toDate(dateOfJoining);
  if (!doj) {
    return { eligible_from: null, cutoff: null, reason: 'no_joining_date',
      detail: 'No date of joining on the employee master, so eligibility cannot be worked out.' };
  }
  const now = toDate(from) || new Date();
  // Start from the appraisal in the current year and walk forward until
  // one this person qualifies for is still ahead of us. Two iterations
  // at most in practice; the loop is bounded anyway.
  let year = now.getUTCFullYear();
  for (let i = 0; i < 10; i += 1, year += 1) {
    const cutoff = cutoffFor(year, r);
    if (!onOrBefore(doj, cutoff)) continue;      // joined too late for this one
    // The appraisal itself: the 1st of the appraisal month.
    const held = Date.UTC(year, r.appraisal_month - 1, 1);
    if (held < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) continue; // already past
    return {
      eligible_from: { year, month: r.appraisal_month },
      cutoff,
      reason: 'eligible',
      detail: `Joined on or before ${fmtCutoff(cutoff)}, so eligible for the ${monthName(r.appraisal_month)} ${year} appraisal.`,
    };
  }
  return { eligible_from: null, cutoff: null, reason: 'out_of_range',
    detail: 'No appraisal within the next ten years matches this joining date — check the date on the employee master.' };
}

// Is this person in the cycle being run now? `cycleYear` is the year the
// cycle's appraisal falls in, which for "Annual Appraisal FY26-27" run
// in July 2027 is 2027.
function eligibleForCycle(dateOfJoining, cycleYear, rule = {}) {
  const doj = toDate(dateOfJoining);
  const cutoff = cutoffFor(cycleYear, rule);
  if (!doj) return { eligible: false, reason: 'no_joining_date', cutoff };
  return { eligible: onOrBefore(doj, cutoff), reason: onOrBefore(doj, cutoff) ? 'eligible' : 'joined_after_cutoff', cutoff };
}

// The day after a cut-off, done with a real Date rather than by adding
// one to the day number. `day + 1 === 32` happens to work for the 31st
// of December and is wrong for the 30th of September, the 28th of
// February, and every other month end — and a cut-off is exactly the
// kind of setting a client moves.
function dayAfter(c) {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Which calendar year a cycle's appraisal falls in. "FY26-27" is
// appraised in July 2027, so it is the LAST year in the label — a
// two-digit tail reads as 20xx. Falls back to the year the cycle was
// created when the label carries no year at all.
function appraisalYearOf(fiscalYear, fallback = new Date()) {
  const nums = String(fiscalYear || '').match(/\d+/g) || [];
  if (nums.length) {
    const tail = nums[nums.length - 1];
    if (tail.length >= 4) return Number(tail.slice(0, 4));
    if (tail.length === 2) return 2000 + Number(tail);
  }
  const d = fallback instanceof Date ? fallback : new Date(fallback);
  return Number.isNaN(d.getTime()) ? new Date().getUTCFullYear() : d.getUTCFullYear();
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => MONTHS[m - 1] || String(m);
const fmtCutoff = (c) => `${c.day} ${monthName(c.month)} ${c.year}`;

// The sentence that goes on the cycle card, which is what the client
// pointed at in the screenshot. Both halves, in their own words, with
// the actual dates filled in rather than the 2026/2027 example.
function eligibilityStatement(cycleYear, rule = {}) {
  const r = { ...DEFAULTS, ...rule };
  const c = cutoffFor(cycleYear, r);
  const next = cutoffFor(cycleYear + 1, r);
  return {
    cutoff: c,
    line_in: `Employees who joined on or before ${fmtCutoff(c)} are eligible for the ${monthName(r.appraisal_month)} ${cycleYear} appraisal.`,
    line_out: `Employees who joined on or after ${fmtCutoff(dayAfter(c))} are eligible for the ${monthName(r.appraisal_month)} ${cycleYear + 1} appraisal.`,
    next_cutoff: next,
  };
}

module.exports = {
  nextAppraisalFor, eligibleForCycle, eligibilityStatement, cutoffFor, appraisalYearOf, dayAfter,
  monthName, fmtCutoff, DEFAULTS,
};
