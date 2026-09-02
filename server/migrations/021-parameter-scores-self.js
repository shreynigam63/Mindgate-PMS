// 021 — 7 Organizational Parameters: employee self-scoring.
//
// Requested with a reference screenshot: the 7-parameter Annual Review
// rubric (BR-6.2/6.3) was manager-only — an employee's own Self-Appraisal
// had no way to self-score against the same 7 drivers, only the manager
// did (via PUT /team/parameter-scores/:employeeId).
//
// pms.parameter_scores' PRIMARY KEY was (cycle_id, employee_id,
// parameter_id) — one row per parameter, full stop. If an employee's own
// self-score were written into the SAME row, whichever of self/manager
// saved last would silently overwrite the other's score, since nothing
// distinguished them. Adding scored_by_role to the key (not just to the
// existing scored_by email column, which is for audit/display only, not
// identity) is what lets both coexist for the same parameter.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.parameter_scores ADD COLUMN IF NOT EXISTS scored_by_role text NOT NULL DEFAULT 'manager'`);
  await db.query(`ALTER TABLE pms.parameter_scores DROP CONSTRAINT IF EXISTS parameter_scores_pkey`);
  await db.query(`ALTER TABLE pms.parameter_scores ADD PRIMARY KEY (cycle_id, employee_id, parameter_id, scored_by_role)`);
};
