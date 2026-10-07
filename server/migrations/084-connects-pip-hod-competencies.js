// Four of the five points asked for on 7 Oct.
//
// 1. "connects can be with anyone so allow all employees to select option
//    to connect with anyone with option as 'do you need HR as part of this
//    connect'."
//    pms.connects.manager_id has always been "the other person in the
//    conversation, who signs it off" — for a self-logged connect it was the
//    employee's manager because nobody else could be picked. It keeps that
//    meaning; the person picked is now anyone. Renaming the column would
//    rewrite every query that reads it for no change in behaviour.
//    include_hr / hr_id record the HR question and who from HR was asked.
//
// 4. The Performance Improvement Plan, written by the manager: a description
//    of the low performance, the targeted areas, and the GATES — dated
//    checkpoints at which the improvement has to be shown. pip_records gets
//    the description, areas and window; gates are rows of their own because
//    each one is reviewed (met / not met) separately, on its own date.
//
// 5. The HOD's Team Competencies page, and the manager's own entry for
//    Improvement Plans, registered so the menu and the URL guard agree.

const PAGES = [
  ['hod_competencies', '/hod/competencies', 'pms_hod'],
  ['team_pip', '/team/pip', 'pms_team_eval'],
];

// Called at boot too — a tenant created after this runs would otherwise
// have no rows for these pages (see 069).
async function ensurePages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`,
      [tenantId, page, route, perm]);
  }
}

async function up(db) {
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS include_hr boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS hr_id uuid`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_connects_hr ON pms.connects(tenant_id, hr_id) WHERE hr_id IS NOT NULL`);

  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS performance_description text`);
  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS target_areas jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS start_date date`);
  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS end_date date`);
  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS opened_by_id uuid`);
  await db.query(`ALTER TABLE pms.pip_records ADD COLUMN IF NOT EXISTS updated_at timestamptz`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.pip_gates (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    pip_id          uuid NOT NULL REFERENCES pms.pip_records(id) ON DELETE CASCADE,
    sort_order      integer NOT NULL DEFAULT 1,
    title           text NOT NULL,
    due_date        date,
    success_measure text,
    status          text NOT NULL DEFAULT 'pending',  -- pending | met | not_met
    review_note     text,
    reviewed_by     text,
    reviewed_at     timestamptz
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pip_gates_pip ON pms.pip_gates(pip_id, sort_order)`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await ensurePages(db, id);
}

module.exports = { up, ensurePages, PAGES };
