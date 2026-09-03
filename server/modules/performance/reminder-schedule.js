// Pure calendar logic for PMS reminders — no db, so every "when does this
// fire" decision is unit-tested directly, the same split this module
// already uses for phase-machine.js, rating-rules.js and
// connect-reminders.js. The DB-touching orchestration lives in
// reminders.js next door.
//
// THE PERFORMANCE YEAR IS FIXED AT APRIL–MARCH, confirmed with the client.
// Everything below is expressed against that year rather than against a
// cycle's own dates, because the reminders were specified by calendar
// position ("month 6", "the month after quarter end") and a cycle whose
// dates are unset or wrong should not silently move a company-wide
// reminder schedule.
//
// ALL DATES ARE UTC. A reminder that fires "on the 1st" must fire on the
// 1st for everyone reading it, and mixing a server's local timezone into
// month arithmetic is how a schedule quietly drifts by a day.

const FY_START_MONTH = 3;  // April, 0-based
const MID_YEAR_MONTH = 8;  // September — month 6 of an April year
const ANNUAL_MONTH = 2;    // March — the closing month of the year

const d = (y, m, day) => new Date(Date.UTC(y, m, day));
const iso = (date) => date.toISOString().slice(0, 10);

// The April–March year a date falls in, named by its STARTING calendar
// year: 2026-02-14 belongs to FY 2025 (Apr 2025 – Mar 2026).
function fiscalYearOf(date) {
  return date.getUTCMonth() >= FY_START_MONTH ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
}

// nth occurrence of a weekday in a month (weekday: 0=Sun … 6=Sat).
function nthWeekdayOf(year, month, weekday, n = 1) {
  const first = d(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return d(year, month, 1 + offset + (n - 1) * 7);
}

function lastWeekdayOf(year, month, weekday) {
  const last = d(year, month + 1, 0); // day 0 of next month = last day of this one
  const back = (last.getUTCDay() - weekday + 7) % 7;
  return d(year, month, last.getUTCDate() - back);
}

const firstMondayOf = (year, month) => nthWeekdayOf(year, month, 1, 1);
const lastFridayOf = (year, month) => lastWeekdayOf(year, month, 5);

const isWeekend = (date) => date.getUTCDay() === 0 || date.getUTCDay() === 6;

// ---------------------------------------------------------------------------
// The four rules, each returning the dates it fires on within one fiscal year.
// ---------------------------------------------------------------------------

// QUARTERLY CONNECT — "the 1st Monday of the month following quarter end",
// to the employee AND their manager. On an April year the quarters end in
// June, September, December and March, so the reminders land in July,
// October, January and April. The January and April ones fall in the NEXT
// calendar year, which is why the month list is walked as an offset from
// April rather than as bare month numbers.
function quarterlyConnectDates(fiscalYear) {
  return [3, 6, 9, 12].map((offset) => {
    const m = FY_START_MONTH + offset;
    return firstMondayOf(fiscalYear + Math.floor(m / 12), m % 12);
  });
}

// The follow-up ladder both mid-year and annual reminders use once the
// month opens: the 15th, 20th, 25th, and the last Friday. Kept in one
// place because the client specified it once and applied it to both.
function followUpDates(year, month) {
  const dates = [d(year, month, 15), d(year, month, 20), d(year, month, 25), lastFridayOf(year, month)];
  // The last Friday can be the 25th (or earlier in a short month) — de-dup
  // so the same calendar day is never scheduled twice, which would show
  // the same person two identical reminders on one morning.
  const seen = new Set();
  return dates.filter((x) => (seen.has(iso(x)) ? false : seen.add(iso(x)))).sort((a, b) => a - b);
}

// The calendar year the given fiscal month falls in. September is in the
// starting year, March is in the following one.
const yearOfMonth = (fiscalYear, month) => (month >= FY_START_MONTH ? fiscalYear : fiscalYear + 1);

// EMPLOYEE, mid-year: "the 1st of month 6, then the 15th, 20th, 25th and
// the last Friday." Month 6 of an April year is September.
function midYearEmployeeDates(fiscalYear) {
  const y = yearOfMonth(fiscalYear, MID_YEAR_MONTH);
  return [d(y, MID_YEAR_MONTH, 1), ...followUpDates(y, MID_YEAR_MONTH)];
}

// MANAGER, mid-year: the 1st MONDAY (not the 1st), then the same ladder.
// The difference is deliberate in the request — the employee is nudged the
// moment the month opens, the manager on the first working Monday.
function midYearManagerDates(fiscalYear) {
  const y = yearOfMonth(fiscalYear, MID_YEAR_MONTH);
  return dedupe([firstMondayOf(y, MID_YEAR_MONTH), ...followUpDates(y, MID_YEAR_MONTH)]);
}

// ANNUAL self-appraisal: the same two shapes in March, the closing month.
function annualEmployeeDates(fiscalYear) {
  const y = yearOfMonth(fiscalYear, ANNUAL_MONTH);
  return [d(y, ANNUAL_MONTH, 1), ...followUpDates(y, ANNUAL_MONTH)];
}
function annualManagerDates(fiscalYear) {
  const y = yearOfMonth(fiscalYear, ANNUAL_MONTH);
  return dedupe([firstMondayOf(y, ANNUAL_MONTH), ...followUpDates(y, ANNUAL_MONTH)]);
}

function dedupe(dates) {
  const seen = new Set();
  return dates.filter((x) => (seen.has(iso(x)) ? false : seen.add(iso(x)))).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// CATCH-UP. The app runs on a free plan that sleeps, so a scheduled date
// can pass with nothing running. Rather than asking "is today a reminder
// day", every run asks "which reminder days have passed that I have not
// sent yet" — late is acceptable, skipped is not. The de-duplication is
// the caller's (a unique row per rule/date/person), so replaying the same
// window is harmless.
//
// `from` bounds the replay: without it, a first run in March would fire
// every reminder since April at once. Callers pass the later of the cycle
// start and a sensible floor.
function occurrencesDue(dates, today, from) {
  return dates.filter((x) => x <= today && (!from || x >= from));
}

// The chase after a submission: "notify the manager immediately, and if it
// is not finalised within 3 days, remind daily except Saturday and Sunday."
//
// The 3 days are calendar days from the submission — the client said "3
// days", not "3 working days" — but the reminders themselves skip the
// weekend, so a Thursday submission first chases on the following Monday.
// Returns the weekday dates from submittedAt + 3 days up to and including
// today, which is what makes a missed run catch up rather than lose a day.
const CHASE_AFTER_DAYS = 3;
function chaseDatesSince(submittedAt, today, afterDays = CHASE_AFTER_DAYS) {
  if (!submittedAt) return [];
  const start = d(submittedAt.getUTCFullYear(), submittedAt.getUTCMonth(), submittedAt.getUTCDate() + afterDays);
  const end = d(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const out = [];
  for (let x = start; x <= end; x = d(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + 1)) {
    if (!isWeekend(x)) out.push(x);
  }
  return out;
}

module.exports = {
  FY_START_MONTH, MID_YEAR_MONTH, ANNUAL_MONTH, CHASE_AFTER_DAYS,
  fiscalYearOf, nthWeekdayOf, lastWeekdayOf, firstMondayOf, lastFridayOf, isWeekend,
  quarterlyConnectDates, followUpDates,
  midYearEmployeeDates, midYearManagerDates, annualEmployeeDates, annualManagerDates,
  occurrencesDue, chaseDatesSince, iso,
};
