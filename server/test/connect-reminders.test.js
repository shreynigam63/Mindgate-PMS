// node --test — Quarterly Connect reminder timing (pure logic, no DB).
const { test } = require('node:test');
const assert = require('node:assert');
const { isConnectDue, shouldRemindAgain } = require('../modules/performance/connect-reminders');

const day = (n) => new Date(Date.UTC(2026, 0, n)); // Jan n, 2026 UTC

test('isConnectDue: never held a connect is always due', () => {
  assert.equal(isConnectDue(null, day(1)), true);
});

test('isConnectDue: within the cadence window is not due', () => {
  assert.equal(isConnectDue(day(1), day(30), 90), false, '29 days since last, cadence 90');
});

test('isConnectDue: exactly at the cadence boundary is due', () => {
  assert.equal(isConnectDue(day(1), day(91), 90), true, 'exactly 90 days later');
});

test('isConnectDue: well past the cadence is due', () => {
  assert.equal(isConnectDue(day(1), day(200), 90), true);
});

test('isConnectDue: custom cadence is respected', () => {
  assert.equal(isConnectDue(day(1), day(20), 30), false);
  assert.equal(isConnectDue(day(1), day(31), 30), true);
});

test('shouldRemindAgain: never reminded before is always OK to send', () => {
  assert.equal(shouldRemindAgain(null, day(1)), true);
});

test('shouldRemindAgain: within the cooldown window blocks a repeat', () => {
  assert.equal(shouldRemindAgain(day(1), day(3), 7), false);
});

test('shouldRemindAgain: past the cooldown allows a repeat', () => {
  assert.equal(shouldRemindAgain(day(1), day(8), 7), true);
});
