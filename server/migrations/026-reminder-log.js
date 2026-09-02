// 026 — the reminder ledger.
//
// WHY A LEDGER AND NOT A TIMER. This deploy has no worker or cron service
// (render.yaml defines an api and a frontend, both on the free plan), and
// a free instance sleeps after fifteen minutes idle. A reminder scheduled
// for "the 1st Monday of September" would simply not happen if nothing was
// awake that morning. Confirmed with the client: reminders may arrive
// late, but must never be skipped.
//
// So the engine does not ask "is today a reminder day". Every run asks
// "which reminder days have passed that I have not sent yet", replays
// them, and writes a row here for each one. The UNIQUE constraint is what
// makes replaying safe — a second run over the same window inserts
// nothing, so a reminder is sent exactly once no matter how often the
// engine wakes.
//
// The key is (rule, occurrence, recipient, subject) rather than a bare
// timestamp because the same person can legitimately receive several
// reminders on one day about different people (a manager with four
// reportees), and the same pair can get different rules on the same date
// (a quarterly connect and a mid-year nudge both land in September).
//
// occurrence is a DATE, not a timestamp: it is the scheduled day the
// reminder belongs to, which is the thing that must be unique. sent_at
// records when it actually went out, which on a catch-up run is later —
// keeping both is what lets someone answer "was this late?" afterwards.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.reminder_log (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    rule              text NOT NULL,
    occurrence        date NOT NULL,
    recipient_id      uuid NOT NULL,
    about_employee_id uuid NOT NULL,
    cycle_id          uuid,
    sent_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, rule, occurrence, recipient_id, about_employee_id)
  )`);
  // The engine's hot path is "have I already sent this rule for this
  // window", which scans by tenant and rule over a date range.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_reminder_log_rule
    ON pms.reminder_log (tenant_id, rule, occurrence)`);
};
