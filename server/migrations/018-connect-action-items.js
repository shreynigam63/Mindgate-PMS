// 018 — Quarterly Connect: Action Items.
//
// Requested with a reference screenshot: each logged 1-on-1 should be able
// to carry a small list of follow-up action items, added while logging
// the connect (a "+ Add" list, not a separate task-management feature).
// Own table rather than a jsonb column on pms.connects, because each item
// needs its own `done` state toggled independently later (after the
// connect that created it is long since signed off) — a jsonb blob would
// mean rewriting the whole array on every single toggle.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.connect_action_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    connect_id  uuid NOT NULL REFERENCES pms.connects(id) ON DELETE CASCADE,
    description text NOT NULL,
    due_date    date,
    done        boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_connect_action_items_connect ON pms.connect_action_items(connect_id)`);
};
