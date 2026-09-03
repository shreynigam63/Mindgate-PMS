// 028 — Aspiring Career becomes a PLAN you can track.
//
// people.career_paths held four things: a target role, a timeline, one
// free-text plan, and updated_at. That is an aspiration, not a plan —
// there was nothing to tick off and no way to say how far along someone
// was. The gap showed up concretely: the mid-year/annual AI assist was
// asked to read "any progress marked in Aspiring Career" and there was no
// progress field for it to read, so it could only quote the plan text
// back.
//
// SHAPED LIKE pms.development_goals ON PURPOSE. That table already solved
// the same problem for the Development Plan — title, description, target
// date, progress_pct, sort_order — and it is what the app's own progress
// UI already understands. A second, differently-shaped goal table would
// mean two of everything for no gain.
//
// STANDING, NOT PER-CYCLE. career_paths has no cycle_id: an aspiration to
// become a Technical Manager does not restart every April, and neither do
// the steps towards it. Milestones therefore hang off the career path,
// and carry across cycles the way the aspiration itself does.
//
// NO APPROVAL WORKFLOW, deliberately, unlike the Development Plan. The
// existing route comment records the reason and it still holds: BR-3.1
// has employees define their own aspiration, and the BRD has no "manager
// approves career path" step. A manager sees these milestones (they
// already see the path) — they do not sign them off. Adding a gate the
// business never asked for would turn someone's own career thinking into
// something they need permission to write down.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS people.career_milestones (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    career_path_id uuid NOT NULL REFERENCES people.career_paths(id) ON DELETE CASCADE,
    title         text NOT NULL,
    description   text,
    target_date   date,
    progress_pct  integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
    sort_order    integer NOT NULL DEFAULT 10,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_career_milestones_path
    ON people.career_milestones (career_path_id)`);

  // career_paths had no id exposed to callers before now (it was always
  // read and upserted by (tenant_id, employee_id)), but a child table
  // needs something to reference. The column has existed since migration
  // 004 — this index is what makes the lookup by owner cheap now that it
  // is on a hot path.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_career_paths_owner
    ON people.career_paths (tenant_id, employee_id)`);
};
