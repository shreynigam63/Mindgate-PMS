// The working-day arithmetic behind the First-Week Journey, pure.
//
// The client's workbook plans every activity with Excel's WORKDAY and
// counts lateness with NETWORKDAYS, both skipping weekends and the
// Holidays sheet. These are the same two functions with the same edge
// behaviour, so a date on this screen matches the date the workbook
// would have printed for the same joiner:
//
//   workday(d, 0)   = d itself, even on a weekend (Excel does the same)
//   workday(d, 2)   = the second working day AFTER d
//   workday(d, -2)  = the second working day BEFORE d
//   networkdays(a, b) counts working days from a to b INCLUSIVE, and is
//   negative when b is before a.
//
// Dates are 'YYYY-MM-DD' strings throughout and the arithmetic is done
// in UTC, so a server in another timezone cannot move a planned date by
// a day. A date that comes out of Postgres as a Date object must be
// formatted with to_char in the query, never with toISOString here.

const DAY = 86400000;

const toUtc = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) throw new Error(`not a YYYY-MM-DD date: ${s}`);
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (t) => new Date(t).toISOString().slice(0, 10);

const isWeekend = (t) => { const w = new Date(t).getUTCDay(); return w === 0 || w === 6; };
const isWorking = (t, holidays) => !isWeekend(t) && !holidays.has(fromUtc(t));

/** WORKDAY(start, n, holidays). */
function workday(start, n, holidays = new Set()) {
  let t = toUtc(start);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    t += step * DAY;
    if (isWorking(t, holidays)) left -= 1;
  }
  return fromUtc(t);
}

/** NETWORKDAYS(a, b, holidays). */
function networkdays(a, b, holidays = new Set()) {
  let lo = toUtc(a); let hi = toUtc(b); let sign = 1;
  if (lo > hi) { [lo, hi] = [hi, lo]; sign = -1; }
  let n = 0;
  for (let t = lo; t <= hi; t += DAY) if (isWorking(t, holidays)) n += 1;
  return sign * n;
}

/**
 * Which day of the journey an activity belongs to, from its offset — the
 * offset is what plans its date, so it is the one that decides the label.
 * The workbook's own Day column disagreed with its offsets in seven rows
 * (the six Readiness rows said Day 1 while being planned two working days
 * before joining, so its Journey sheet counted Pre-Day 1 as empty).
 */
//
// 8 Oct: "pre-day and Day 1 both should come under Day 1 only" — which is
// how the client's own workbook labelled them. The readiness activities
// are part of Day 1 again; their DATES do not move (still planned from the
// offset, two working days before joining — they have to be ready before
// the joiner arrives). The screen lists them first within Day 1.
const dayLabel = (offset) => (offset < 0 ? 'Day 1' : `Day ${offset + 1}`);
const DAY_ORDER = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7'];

/**
 * One task's status on a given date. Same four words as the workbook.
 */
function taskStatus(planned, completedOn, asOf) {
  if (completedOn) return 'Completed';
  if (planned < asOf) return 'Overdue';
  if (planned === asOf) return 'Due Today';
  return 'Upcoming';
}

/** Working days late, as the workbook counts it (NETWORKDAYS - 1). */
function daysOverdue(planned, asOf, holidays) {
  return Math.max(0, networkdays(planned, asOf, holidays) - 1);
}

/**
 * Where a joiner is in their week. Not joined / Day n / After Day 7.
 * Before the date of joining it is "Not joined", readiness work or not —
 * there is no Pre-Day 1 any more (8 Oct). `preStart` is kept so callers
 * need not change.
 */
// eslint-disable-next-line no-unused-vars
function currentDay(doj, asOf, holidays, preStart) {
  const day7 = workday(doj, 6, holidays);
  if (asOf < doj) return 'Not joined';
  if (asOf > day7) return 'After Day 7';
  return `Day ${Math.max(1, networkdays(doj, asOf, holidays))}`;
}

module.exports = { workday, networkdays, dayLabel, DAY_ORDER, taskStatus, daysOverdue, currentDay };
