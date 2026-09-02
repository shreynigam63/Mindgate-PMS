// node --test — Connect cadence/progress math (pure logic, no db), same
// pattern as phase-machine.test.js and rating-rules.test.js. Backs the
// "Connect Cadence / Progress this cycle / Next due" header requested
// with a reference screenshot.
const { test } = require('node:test');
const assert = require('node:assert');
const { computeCadenceProgress, DEFAULT_CADENCE_DAYS } = require('../modules/performance/connect-reminders');

test('a full annual cycle (365 days) at 90-day cadence expects 4 connects total', () => {
  const r = computeCadenceProgress({
    cycleStart: new Date('2026-04-01'), cycleEnd: new Date('2027-03-31'),
    today: new Date('2026-04-01'), loggedCount: 0, lastHeldAt: null,
  });
  assert.equal(r.expected_total, 4);
  assert.equal(r.expected_so_far, 0, 'at the very start of the cycle, none are expected yet');
  assert.equal(r.on_track, true, '0 logged >= 0 expected so far is on track');
});

test('mid-cycle: expected-so-far scales with elapsed time, and falling behind is detected', () => {
  const r = computeCadenceProgress({
    cycleStart: new Date('2026-04-01'), cycleEnd: new Date('2027-03-31'),
    today: new Date('2026-08-29'), loggedCount: 1, lastHeldAt: new Date('2026-07-01'),
  });
  assert.equal(r.expected_total, 4);
  assert.equal(r.expected_so_far, 2, '~150 elapsed days / 90 ≈ 1.67, rounds to 2');
  assert.equal(r.logged_count, 1);
  assert.equal(r.on_track, false, '1 logged < 2 expected so far');
});

test('on track when logged count meets or exceeds what is expected so far', () => {
  const r = computeCadenceProgress({
    cycleStart: new Date('2026-04-01'), cycleEnd: new Date('2027-03-31'),
    today: new Date('2026-08-29'), loggedCount: 2, lastHeldAt: new Date('2026-08-01'),
  });
  assert.equal(r.on_track, true);
});

test('next_due is last connect + cadence days when one has been held', () => {
  const r = computeCadenceProgress({
    cycleStart: new Date('2026-04-01'), cycleEnd: new Date('2027-03-31'),
    today: new Date('2026-08-29'), loggedCount: 1, lastHeldAt: new Date('2026-07-01'),
  });
  const expected = new Date('2026-07-01');
  expected.setDate(expected.getDate() + DEFAULT_CADENCE_DAYS);
  assert.equal(r.next_due.toISOString().slice(0, 10), expected.toISOString().slice(0, 10));
});

test('next_due falls back to cycle start when no connect has ever been held', () => {
  const r = computeCadenceProgress({
    cycleStart: new Date('2026-04-01'), cycleEnd: new Date('2027-03-31'),
    today: new Date('2026-04-15'), loggedCount: 0, lastHeldAt: null,
  });
  assert.equal(r.next_due.toISOString().slice(0, 10), '2026-04-01');
});

test('missing cycle dates fall back to a full year rather than throwing', () => {
  const r = computeCadenceProgress({ cycleStart: null, cycleEnd: null, today: new Date('2026-08-29'), loggedCount: 0, lastHeldAt: null });
  assert.equal(r.expected_total, 4, '365-day fallback / 90 rounds to 4');
  assert.ok(r.next_due instanceof Date);
});

test('expected_so_far never exceeds expected_total, even past the cycle end date', () => {
  const r = computeCadenceProgress({
    cycleStart: new Date('2026-04-01'), cycleEnd: new Date('2027-03-31'),
    today: new Date('2028-01-01'), loggedCount: 4, lastHeldAt: new Date('2027-01-01'),
  });
  assert.equal(r.expected_so_far, r.expected_total);
});
