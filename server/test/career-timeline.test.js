// What is left of a move's time (13 Oct: "expected timeline should be
// remaining months from current experience/total experience and not total
// expected timeline"). The client chose the plain reading: the matrix's
// figure less total experience, never below nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const { experienceFrom, remainingTimeline } = require('../modules/people/career-timeline');

test('experience: the HRMS figure first, then what the employee entered, else unknown', () => {
  assert.deepEqual(experienceFrom(4.5, 9), { months: 54, years: 4.5, source: 'hrms' });
  assert.deepEqual(experienceFrom(null, 3), { months: 36, years: 3, source: 'self_reported' });
  assert.deepEqual(experienceFrom('', ''), { months: null, years: null, source: null });
  assert.deepEqual(experienceFrom(-1, 'lots'), { months: null, years: null, source: null }, 'nonsense is no figure');
  assert.equal(experienceFrom(0, 5).source, 'hrms', 'zero years is a figure (a fresher), not a blank');
});

test('THE SCREENSHOT: typically 72, at least 48 — with 5 years behind them, 12 left and none at least', () => {
  const r = remainingTimeline(72, 48, experienceFrom(5));
  assert.deepEqual(r, { remaining_time_months: 12, remaining_min_months: 0, timeline_text: '12 months', timeline_basis: 'hrms' });
});

test('past the figure is due now, never negative', () => {
  const r = remainingTimeline(24, 12, experienceFrom(10));
  assert.equal(r.remaining_time_months, 0);
  assert.equal(r.timeline_text, 'Due now');
});

test('no experience on record: the matrix\'s full figure, and it says so', () => {
  assert.deepEqual(remainingTimeline(72, 48, experienceFrom(null, null)),
    { remaining_time_months: 72, remaining_min_months: 48, timeline_text: '72 months', timeline_basis: 'no_experience' });
});

test('no figure from HR: nothing to work out', () => {
  assert.equal(remainingTimeline(null, null, experienceFrom(5)).timeline_text, null);
  assert.equal(remainingTimeline(24, null, experienceFrom(1)).remaining_min_months, null, 'no minimum, none left over');
});

// Found by review, 13 Oct.
test('A CLIMB OF SEVERAL MOVES: experience comes off the first move only', () => {
  const tenYears = { months: 120, years: 10, source: 'hrms' };
  // 72 to the next role, then 72 more: ten years in, the first move is
  // done and the second has not begun — 72 left, not 24.
  assert.equal(remainingTimeline(144, null, tenYears, 72).remaining_time_months, 72);
  assert.equal(remainingTimeline(144, null, { months: 36, years: 3, source: 'hrms' }, 72).remaining_time_months, 36 + 72);
  assert.equal(remainingTimeline(144, 48, tenYears, 72).remaining_min_months, null, 'a minimum is for one move');
});

test('CURRENT EXPERIENCE: a dated figure counts up to today', () => {
  const { monthsSince } = require('../modules/people/career-timeline');
  assert.equal(monthsSince('2025-10-13', '2026-10-13'), 12);
  assert.equal(monthsSince('2026-10-13', '2026-11-12'), 0, 'not a whole month yet');
  assert.equal(monthsSince(null, '2026-10-13'), 0);
  const e = experienceFrom(5, null, { hrmsAsOf: '2025-10-13', now: '2026-10-13' });
  assert.deepEqual(e, { months: 72, years: 6, source: 'hrms' });
  assert.equal(remainingTimeline(72, 48, e).timeline_text, 'Due now', 'a year after the import, the 12 months left have run out');
  assert.equal(experienceFrom(null, 2, { selfAsOf: '2026-04-13', now: '2026-10-13' }).months, 30);
});
