// 020 — Mid-Year Review checkpoint (its own table).
//
// Requested with a reference screenshot: a distinct "Mid-Year Review"
// phase/screen between Growth Planning and Self-Appraisal, with its own
// employee narrative + self-rating and manager narrative + rating, each
// independently signed off.
//
// Deliberately NOT reusing pms.self_appraisals/pms.manager_evaluations:
// those tables permanently lock (`status='submitted'` blocks ALL further
// edits, checked with no phase awareness) the moment either party signs.
// If the mid-year checkpoint wrote to the same row a cycle's REAL
// end-of-year self-appraisal/manager-evaluation uses, signing off the
// mid-year checkpoint would permanently lock the annual one too, in the
// same cycle, months before it's even supposed to open. Caught this
// while wiring the new mid_year_review phase into phase-machine.js and
// switched to a separate table before it became a live bug — a plain
// ALLOWS-map change alone would NOT have caught this, since phaseAllows
// has no idea the two tables' "submitted" semantics collide.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.midyear_checkins (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    cycle_id           uuid NOT NULL,
    employee_id        uuid NOT NULL,
    manager_id         uuid,
    self_rating        numeric(3,1),
    self_narrative     text,
    self_status        text NOT NULL DEFAULT 'not_started', -- not_started|in_progress|submitted
    self_submitted_at  timestamptz,
    manager_rating     numeric(3,1),
    manager_narrative  text,
    manager_status     text NOT NULL DEFAULT 'not_started',
    manager_submitted_at timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, employee_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_midyear_checkins_cycle ON pms.midyear_checkins(tenant_id, cycle_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_midyear_checkins_manager ON pms.midyear_checkins(tenant_id, manager_id)`);
};
