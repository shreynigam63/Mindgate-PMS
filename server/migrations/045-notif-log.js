// 045 — create core.notif_log properly.
//
// The table already existed in practice: core/mail.js ran a CREATE TABLE
// IF NOT EXISTS on every single send. That works, but it means the schema
// only appears once somebody has been mailed, so anything READING the log
// before the first send — a report, a test, an admin screen — fails on a
// missing relation rather than showing an empty list. It also puts a DDL
// statement in the path of every notification.
//
// Declared here so it exists from boot like every other table. mail.js
// keeps its guard for a tenant restored from an older dump.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS core.notif_log (
    id        bigserial PRIMARY KEY,
    tenant_id uuid,
    at        timestamptz NOT NULL DEFAULT now(),
    to_email  text,
    subject   text,
    kind      text,
    mode      text,       -- 'live' | 'simulated'
    outcome   text,       -- 'sent' | 'simulated' | 'failed'
    detail    text)`);
  // "What did we try to send this person, and did it land" — the question
  // asked when somebody says they never got the mail.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_notif_log_tenant_at
                    ON core.notif_log(tenant_id, at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_notif_log_to
                    ON core.notif_log(tenant_id, lower(to_email))`);
};
