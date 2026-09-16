// 035 — a development goal records the KRA it serves.
//
// The link already exists in everything but storage. The agentic
// devplan-suggest route asks for it by name ("serves_kra": the exact KRA
// title), the suggestion popup groups the suggestions under it, and the
// employee picks goals having read that grouping. Then the goal is saved
// and the association is discarded, because the table has nowhere to put
// it — so nothing downstream can answer "which KRA is this goal building
// capability for".
//
// BOTH COLUMNS, AND WHY.
//   kra_id     the real link, for joins and for the manager's view.
//              ON DELETE SET NULL, not CASCADE: dropping a KRA must not
//              silently delete the employee's development goal with it.
//   serves_kra the KRA's title AS IT STOOD when the goal was written.
//              Kept because the id is not enough on its own — a KRA can
//              be retitled mid-cycle, and past cycles are read long after
//              their sheets have been edited. It is also the only thing
//              available when the goal came from an AI suggestion that
//              named a KRA the sheet no longer has.
//
// Both nullable. "Not tied to a KRA" is a legitimate answer — a language
// course or a certification often serves the person rather than one
// objective — and every goal that exists today has no link at all.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.development_goals ADD COLUMN IF NOT EXISTS kra_id uuid`);
  await db.query(`ALTER TABLE pms.development_goals ADD COLUMN IF NOT EXISTS serves_kra text`);

  // Added separately from the column so a half-applied earlier run can
  // complete, and guarded because Postgres has no ADD CONSTRAINT IF NOT
  // EXISTS.
  const fk = await db.query(
    `SELECT 1 FROM pg_constraint WHERE conname='development_goals_kra_id_fkey'`);
  if (!fk.rowCount) {
    await db.query(`ALTER TABLE pms.development_goals
      ADD CONSTRAINT development_goals_kra_id_fkey
      FOREIGN KEY (kra_id) REFERENCES pms.kras(id) ON DELETE SET NULL`);
  }
  await db.query(`CREATE INDEX IF NOT EXISTS idx_devgoals_kra ON pms.development_goals(kra_id)`);
};
