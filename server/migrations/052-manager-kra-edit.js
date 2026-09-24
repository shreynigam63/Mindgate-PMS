// 052 — a manager may edit a submitted KRA sheet, and the sheet says so.
//
// Asked for on 24 Sep: "Direct KRA edit option to manager in team KRAs
// after submission from employee."
//
// One column. The audit log already carries WHAT changed and who did
// it — that is where "who changed my weight" is answered — but the
// sheet itself needs a flag the employee's own page can read without
// querying the audit trail, so a sheet their manager has altered says
// so on the face of it rather than only in a notification they may
// have missed.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.kra_sheets
                    ADD COLUMN IF NOT EXISTS edited_by_manager_at timestamptz`);
};
