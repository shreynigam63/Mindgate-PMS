// node --test — the reminder calendar. Pure, no database.
//
// Every date here was checked against a real 2025/2026 calendar, because
// the whole point of this file is that the arithmetic is right: a reminder
// that lands a day late is a reminder nobody trusts.
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../modules/performance/reminder-schedule');

const iso = s.iso;
const on = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

test('the fiscal year runs April to March and is named by its starting year', () => {
  assert.equal(s.fiscalYearOf(on(2025, 4, 1)), 2025);
  assert.equal(s.fiscalYearOf(on(2025, 12, 31)), 2025);
  assert.equal(s.fiscalYearOf(on(2026, 3, 31)), 2025, 'March belongs to the year that began the previous April');
  assert.equal(s.fiscalYearOf(on(2026, 4, 1)), 2026);
});

test('quarterly connect fires the 1st Monday of the month after each quarter ends', () => {
  // Quarters end Jun/Sep/Dec/Mar, so the reminders land in Jul/Oct/Jan/Apr.
  // 1 Jul 2025 is a Tuesday, so the first Monday is the 7th.
  assert.deepEqual(s.quarterlyConnectDates(2025).map(iso),
    ['2025-07-07', '2025-10-06', '2026-01-05', '2026-04-06']);
  // The last one falls in the NEXT fiscal year — that is the quarter
  // ending in March being reminded about in April, exactly as specified.
  assert.equal(s.fiscalYearOf(s.quarterlyConnectDates(2025)[3]), 2026);
});

test('mid-year runs in September — the 6th month of an April year', () => {
  // Employee: the 1st, then 15/20/25 and the last Friday (26 Sep 2025).
  assert.deepEqual(s.midYearEmployeeDates(2025).map(iso),
    ['2025-09-01', '2025-09-15', '2025-09-20', '2025-09-25', '2025-09-26']);
});

test('the manager gets the 1st Monday where the employee gets the 1st', () => {
  // 1 Sep 2025 happens to BE a Monday, so that year they coincide...
  assert.equal(iso(s.midYearManagerDates(2025)[0]), '2025-09-01');
  // ...and 1 Sep 2026 is a Tuesday, so the manager's lands on the 7th
  // while the employee's stays on the 1st. Proving the two rules are
  // genuinely different and not the same rule written twice.
  assert.equal(iso(s.midYearEmployeeDates(2026)[0]), '2026-09-01');
  assert.equal(iso(s.midYearManagerDates(2026)[0]), '2026-09-07');
});

test('annual runs in March, the closing month, in the following calendar year', () => {
  assert.deepEqual(s.annualEmployeeDates(2025).map(iso),
    ['2026-03-01', '2026-03-15', '2026-03-20', '2026-03-25', '2026-03-27']);
  // 2 Mar 2026 is the first Monday.
  assert.equal(iso(s.annualManagerDates(2025)[0]), '2026-03-02');
});

test('the last Friday is never scheduled twice when it lands on the 25th', () => {
  // The ladder is 15th, 20th, 25th, last Friday — so a month whose last
  // Friday IS the 25th would schedule that day twice. February 2028 is
  // such a month.
  const feb = s.followUpDates(2028, 1).map(iso);
  assert.equal(iso(s.lastFridayOf(2028, 1)), '2028-02-25');
  assert.deepEqual(feb, ['2028-02-15', '2028-02-20', '2028-02-25'],
    'the duplicate is collapsed, so nobody gets two identical bells that morning');
});

test('follow-up dates come back in calendar order even when the last Friday precedes the 25th', () => {
  // Feb 2026: last Friday is the 27th — after the 25th. Feb 2027: the
  // 26th. A month where the last Friday falls before the 25th would put
  // the list out of order if it were not sorted.
  const march = s.followUpDates(2026, 2).map(iso);
  assert.deepEqual(march, [...march].sort(), 'dates must be ascending');
  assert.deepEqual(march, ['2026-03-15', '2026-03-20', '2026-03-25', '2026-03-27']);
});

test('occurrencesDue returns what has passed and not yet been handled, never the future', () => {
  const dates = [on(2025, 9, 1), on(2025, 9, 15), on(2025, 9, 20), on(2025, 9, 25)];
  assert.deepEqual(s.occurrencesDue(dates, on(2025, 9, 17)).map(iso), ['2025-09-01', '2025-09-15']);
  assert.deepEqual(s.occurrencesDue(dates, on(2025, 8, 31)).map(iso), [], 'nothing before the first');
  // The floor keeps a first-ever run from replaying the whole year at once.
  assert.deepEqual(s.occurrencesDue(dates, on(2025, 9, 30), on(2025, 9, 16)).map(iso),
    ['2025-09-20', '2025-09-25']);
});

test('the post-submission chase starts 3 days later and skips the weekend', () => {
  // Signed Thursday 5 Mar 2026. Three days later is Sunday the 8th, so
  // the first chase is Monday the 9th.
  assert.deepEqual(s.chaseDatesSince(on(2026, 3, 5), on(2026, 3, 12)).map(iso),
    ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12']);
  // Nothing at all until the 3 days have elapsed.
  assert.deepEqual(s.chaseDatesSince(on(2026, 3, 5), on(2026, 3, 7)).map(iso), []);
  // Signed Monday 2 Mar: 3 days later is Thursday the 5th, a working day,
  // so the chase starts there and Sat/Sun are absent from the run.
  assert.deepEqual(s.chaseDatesSince(on(2026, 3, 2), on(2026, 3, 10)).map(iso),
    ['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10']);
  assert.deepEqual(s.chaseDatesSince(null, on(2026, 3, 10)), []);
});

test('a chase that spans a month boundary keeps counting', () => {
  // Signed 27 Mar 2026 (Friday); +3 is Monday the 30th.
  assert.deepEqual(s.chaseDatesSince(on(2026, 3, 27), on(2026, 4, 2)).map(iso),
    ['2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02']);
});

test('weekends are Saturday and Sunday, in UTC', () => {
  assert.equal(s.isWeekend(on(2026, 3, 7)), true);  // Saturday
  assert.equal(s.isWeekend(on(2026, 3, 8)), true);  // Sunday
  assert.equal(s.isWeekend(on(2026, 3, 9)), false); // Monday
});
