// node --test — the First-Week Journey's date arithmetic, against the
// client's own workbook.
//
// Every fixture here is a value the "7 Days Onboarding Tracker" workbook
// printed for its sample joiners, with its Report Date of 6 Oct 2026 and
// its holiday list (Gandhi Jayanti on Fri 2 Oct sits inside four of the
// six weeks). Before this was written, the whole engine was run over all
// 288 real Tracker rows of that workbook — planned date, status and days
// overdue — and matched every one; these are the cases that cover the
// edges of that run.
const { test } = require('node:test');
const assert = require('node:assert');
const cal = require('../modules/people/onboarding-calendar');

const H = new Set(['2026-10-02', '2026-12-25', '2027-01-26']);
const AS_OF = '2026-10-06';

test('WORKDAY: offset 0 is the date itself, positive and negative step over weekends and holidays', () => {
  assert.equal(cal.workday('2026-09-24', 0, H), '2026-09-24');
  assert.equal(cal.workday('2026-09-24', -2, H), '2026-09-22', 'Pre-Day 1 for a Thursday joiner is the Tuesday');
  assert.equal(cal.workday('2026-09-28', -2, H), '2026-09-24', 'and for a Monday joiner, the Thursday before');
  assert.equal(cal.workday('2026-09-24', 6, H), '2026-10-05', 'Day 7 skips the weekend AND Gandhi Jayanti');
  assert.equal(cal.workday('2026-09-24', 6), '2026-10-02', 'without the holiday it would land on it');
  assert.equal(cal.workday('2026-10-03', 0, H), '2026-10-03', 'Excel returns a weekend start unchanged at 0');
});

test('NETWORKDAYS is inclusive, skips holidays, and is negative backwards', () => {
  assert.equal(cal.networkdays('2026-09-28', AS_OF, H), 6);
  assert.equal(cal.networkdays(AS_OF, '2026-09-28', H), -6);
  assert.equal(cal.networkdays('2026-10-03', '2026-10-04', H), 0, 'a weekend has no working days');
});

test('the Joiners sheet: Day 7 date and where each sample joiner is on the Report Date', () => {
  const cases = [
    ['2026-09-24', '2026-10-05', 'After Day 7'],   // Riya Sharma
    ['2026-09-25', '2026-10-06', 'Day 7'],         // Kunal Joshi
    ['2026-09-28', '2026-10-07', 'Day 6'],         // Aarav Mehta
    ['2026-09-30', '2026-10-09', 'Day 4'],         // Sneha Kulkarni
    ['2026-10-01', '2026-10-12', 'Day 3'],         // Omkar Patil
    ['2026-09-21', '2026-09-29', 'After Day 7'],   // Tanvi Shah
  ];
  for (const [doj, day7, where] of cases) {
    assert.equal(cal.workday(doj, 6, H), day7, `Day 7 for ${doj}`);
    assert.equal(cal.currentDay(doj, AS_OF, H, cal.workday(doj, -2, H)), where, `current day for ${doj}`);
  }
});

// 8 Oct: no Pre-Day 1 any more — readiness belongs to Day 1, and before
// the date of joining a joiner is simply not joined yet.
test('before joining: Not joined, inside the readiness window and before it', () => {
  assert.equal(cal.currentDay('2026-10-08', AS_OF, H, cal.workday('2026-10-08', -2, H)), 'Not joined');
  assert.equal(cal.currentDay('2026-10-20', AS_OF, H, cal.workday('2026-10-20', -2, H)), 'Not joined');
});

test('status and lateness, as the Tracker sheet computed them', () => {
  assert.equal(cal.taskStatus('2026-10-05', null, AS_OF), 'Overdue');
  assert.equal(cal.taskStatus('2026-10-06', null, AS_OF), 'Due Today');
  assert.equal(cal.taskStatus('2026-10-07', null, AS_OF), 'Upcoming');
  assert.equal(cal.taskStatus('2026-09-22', '2026-09-30', AS_OF), 'Completed', 'a late completion is still Completed');
  assert.equal(cal.daysOverdue('2026-10-05', AS_OF, H), 1);
  assert.equal(cal.daysOverdue('2026-10-01', AS_OF, H), 2, 'the holiday in between is not a day late');
});

test('the Readiness rows are Day 1, as the workbook says, though planned before joining', () => {
  assert.equal(cal.dayLabel(-2), 'Day 1');
  assert.equal(cal.dayLabel(0), 'Day 1');
  assert.equal(cal.dayLabel(6), 'Day 7');
  assert.deepEqual(cal.DAY_ORDER, ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7']);
  assert.equal(cal.workday('2026-09-24', -2), '2026-09-22', 'the date still comes from the offset');
});

test('the shipped activity matrix is the client\'s 48 rows, ending on Day 7', () => {
  const { ACTIVITIES, QUESTIONS } = require('../migrations/081-onboarding');
  assert.equal(ACTIVITIES.length, 48);
  assert.equal(new Set(ACTIVITIES.map((a) => a[0])).size, 48, 'codes are unique');
  const byDay = {};
  for (const a of ACTIVITIES) byDay[cal.dayLabel(a[7])] = (byDay[cal.dayLabel(a[7])] || 0) + 1;
  assert.deepEqual(byDay, { 'Day 1': 16, 'Day 2': 5, 'Day 3': 7, 'Day 4': 6, 'Day 5': 4, 'Day 6': 5, 'Day 7': 5 });
  assert.ok(ACTIVITIES.every((a) => a[4].length > 0), 'every activity names at least one owner group');
  assert.ok(!ACTIVITIES.some((a) => a[3] !== a[3].trim()), 'owners are trimmed — the sheet had trailing spaces');
  assert.equal(QUESTIONS.length, 7);
});
