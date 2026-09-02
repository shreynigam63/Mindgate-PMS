// Pure timing logic for Quarterly Connect reminders (BR-4.4) — no db, so
// the actual "when is this due" decision is unit-tested directly, same
// pattern as phase-machine.js and rating-rules.js. The DB-touching
// orchestration (finding employees, sending notifications) lives in
// modules/performance/index.js and is covered by an integration test
// instead, matching this codebase's established split.

const DEFAULT_CADENCE_DAYS = 90;   // "quarterly"
const DEFAULT_COOLDOWN_DAYS = 7;   // don't re-remind more than once a week

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// lastConnectDate: Date|null (null = never held one). today: Date.
function isConnectDue(lastConnectDate, today, cadenceDays = DEFAULT_CADENCE_DAYS) {
  if (!lastConnectDate) return true; // never held one — always due
  return daysBetween(lastConnectDate, today) >= cadenceDays;
}

// lastReminderDate: Date|null. Returns whether it's safe to send another
// reminder now (either never reminded, or the cooldown has elapsed).
function shouldRemindAgain(lastReminderDate, today, cooldownDays = DEFAULT_COOLDOWN_DAYS) {
  if (!lastReminderDate) return true;
  return daysBetween(lastReminderDate, today) >= cooldownDays;
}

// Pure cadence-vs-progress math for the "Connect Cadence / Progress this
// cycle / Next due" header (requested with a reference screenshot).
// cycleStart/cycleEnd: Date|null (cycle's opens_at/closes_at — falls back
// to a full year if either is missing, since a cycle without dates set
// still needs SOME window to reason about). loggedCount: how many
// connects already exist for this employee in the window. lastHeldAt:
// Date|null (most recent connect's held_at, for computing next_due).
function computeCadenceProgress({ cycleStart, cycleEnd, today, loggedCount, lastHeldAt, cadenceDays = DEFAULT_CADENCE_DAYS }) {
  const cycleDays = cycleStart && cycleEnd ? Math.max(1, daysBetween(cycleStart, cycleEnd)) : 365;
  const expectedTotal = Math.max(1, Math.round(cycleDays / cadenceDays));
  const elapsedDays = cycleStart ? Math.max(0, Math.min(cycleDays, daysBetween(cycleStart, today))) : cycleDays;
  const expectedSoFar = Math.max(0, Math.min(expectedTotal, Math.round(elapsedDays / cadenceDays)));
  const nextDue = lastHeldAt
    ? new Date(lastHeldAt.getTime() + cadenceDays * 24 * 60 * 60 * 1000)
    : (cycleStart || today);
  return {
    cadence_days: cadenceDays,
    expected_total: expectedTotal,
    expected_so_far: expectedSoFar,
    logged_count: loggedCount,
    next_due: nextDue,
    on_track: loggedCount >= expectedSoFar,
  };
}

module.exports = { isConnectDue, shouldRemindAgain, computeCadenceProgress, DEFAULT_CADENCE_DAYS, DEFAULT_COOLDOWN_DAYS };
