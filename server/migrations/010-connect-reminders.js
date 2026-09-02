// 010 — Quarterly Connect reminders (BR-4.4: "automatic reminders prompt
// managers and employees when a quarterly connect is due").
//
// This deploy has no separate worker/cron service (render.yaml
// defines only the api and frontend web services) — the reminder check
// runs in-process (index.js, a daily setInterval) with a manual HR
// trigger as a backup/testing path. This log table is how repeat sends
// are avoided: "was this employee reminded within the cooldown window",
// not a stateful flag on core.employees, so the history is auditable.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.connect_reminders_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    employee_id uuid NOT NULL,
    manager_id  uuid NOT NULL,
    sent_at     timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_connect_reminders_emp ON pms.connect_reminders_log(tenant_id, employee_id, sent_at DESC)`);
};
