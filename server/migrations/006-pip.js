// 006 — Performance Improvement Plan (PIP): BR-7.1 (auto-trigger below a
// configurable threshold) and BR-7.2 (weekly tracking through to closure).
// pms.pip_records already existed (migration 003) but nothing wrote to it —
// this adds what was missing: a configurable threshold, weekly entries, and
// a closure reason, plus the idempotency guard the auto-trigger needs.
//
// RATING-SCALE NOTE (documented once here, referenced from
// modules/performance/index.js): the BRD/project-plan describe the PIP
// threshold and the Super-50 rule in letter grades ("below B+", "3
// consecutive A/A+"), but the cycle's actual rating_scale (migration 003)
// is numeric 1-5 with English labels (Needs Improvement..Outstanding) —
// there is no letter-grade column anywhere in the schema. Rather than
// inventing a letter-grade system that doesn't otherwise exist, PIP uses a
// numeric threshold directly on that existing 1-5 scale. Default 3.0 (i.e.
// strictly below "Meets Expectations" triggers a PIP) is the closest
// reasonable reading of "below B+" onto the scale that's actually there.
// The project plan itself flags this exact value as something to confirm
// with the client HR team during UAT ("Build to the BRD default... confirm
// during UAT") — hence it's a per-cycle configurable column, not a
// hardcoded constant.

module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.cycles ADD COLUMN IF NOT EXISTS pip_threshold numeric(3,1) NOT NULL DEFAULT 3.0`);
  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS closed_reason text`);
  // One PIP record per employee per cycle — makes the publish-time
  // auto-trigger idempotent (ON CONFLICT DO NOTHING) if publish is re-run.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pip_employee_cycle ON pms.pip_records(tenant_id, employee_id, cycle_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pip_employee ON pms.pip_records(tenant_id, employee_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.pip_weekly_entries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    pip_id       uuid NOT NULL REFERENCES pms.pip_records(id) ON DELETE CASCADE,
    week_ending  date NOT NULL,
    notes        text NOT NULL,
    submitted_by text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pip_weekly_pip ON pms.pip_weekly_entries(pip_id, week_ending DESC)`);
};
