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

// 15 Oct, the client's choice (it replaces 13 Oct's first-step rule):
// 5 years behind them, 72 months to the short-term role and 48 more to the
// next — Short-Term 12 months, Long-Term 60.
test('A CLIMB OF SEVERAL MOVES: experience comes off the whole climb', () => {
  const five = { months: 60, years: 5, source: 'hrms' };
  assert.equal(remainingTimeline(72, null, five).remaining_time_months, 12, 'short-term');
  assert.equal(remainingTimeline(72 + 48, null, five).remaining_time_months, 60, 'long-term');
  const ten = { months: 120, years: 10, source: 'hrms' };
  assert.equal(remainingTimeline(144, null, ten).remaining_time_months, 24, 'ten years in: 24 left of the 144-month climb');
  assert.equal(remainingTimeline(120, null, ten).timeline_text, 'Due now');
});

test('NEVER FROM ZERO: with no HRMS figure and none entered, the time since joining stands in', () => {
  const e = experienceFrom(null, null, { joined: '2021-10-15', now: '2026-10-15' });
  assert.deepEqual(e, { months: 60, years: 5, source: 'joining_date' });
  assert.equal(remainingTimeline(72, 48, e).timeline_text, '12 months');
  assert.equal(experienceFrom(null, 3, { joined: '2021-10-15', now: '2026-10-15' }).source, 'self_reported', 'their own years come first');
  assert.equal(experienceFrom(2, null, { joined: '2010-01-01', now: '2026-10-15' }).source, 'hrms', 'the HR record first of all');
  assert.equal(experienceFrom(null, null, { joined: '2030-01-01', now: '2026-10-15' }).months, null, 'a joining date in the future is no figure');
  assert.equal(experienceFrom(null, null, { joined: 'not a date' }).months, null);
});

test('THE LONG-TERM ROLE BY EXPERIENCE: the first rung experience does not cover, skipping levels if it must', () => {
  const { rungByExperience } = require('../modules/people/career-timeline');
  const ladder = [
    { to_role: 'Lead', steps: 2, typical_time_months: 120 },
    { to_role: 'Manager', steps: 3, typical_time_months: 180 },
    { to_role: 'Architect', steps: 3, typical_time_months: null },
    { to_role: 'Director', steps: 4, typical_time_months: 240 },
  ];
  assert.equal(rungByExperience(ladder, { months: 60 }).to_role, 'Lead', '5 years: the next level');
  assert.equal(rungByExperience(ladder, { months: 130 }).to_role, 'Manager', '11 years: past Lead, so Manager');
  assert.equal(rungByExperience(ladder, { months: 200 }).to_role, 'Director', 'skips two levels');
  assert.equal(rungByExperience(ladder, { months: 300 }).to_role, 'Director', 'past every rung: the furthest');
  assert.equal(rungByExperience(ladder, { months: null }).to_role, 'Lead', 'no experience: the nearest');
  assert.equal(rungByExperience([], { months: 60 }), null);
  assert.equal(rungByExperience([{ to_role: 'X', typical_time_months: null }], { months: 60 }), null);
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
