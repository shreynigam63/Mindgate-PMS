// 054 — archiving an employee instead of destroying their record.
//
// Asked for on 25 Sep, the day after the bulk delete shipped:
//
//   "Delete employees option should only delete employees list and not
//    rest of the strings attached to it currently."
//
// Taken literally that is not what a row delete does here. core.employees
// is referenced by 36 tables' worth of employee_id columns, and only
// three of them carry a real foreign key — so deleting the row would:
//
//   * cascade-delete the competency assessments, prior ratings and
//     timesheet entries anyway, because those FKs say ON DELETE CASCADE;
//   * leave the other thirty-odd (KRA sheets, appraisals, evaluations,
//     connects, ratings, closure letters) as rows nothing can ever join
//     to again — present in the database, invisible in the product;
//   * and NOT give the records back on re-upload, because a re-uploaded
//     person is a new row with a new uuid.
//
// So the letter of it destroys the value of it. What the request is
// actually for — "clear the list so I can upload a fresh sheet" — is
// served by keeping the row and taking it off the list. Archived people
// leave the directory, leave every screen in the product (73 queries
// already filter status='active', which archiving sets), and keep every
// record attached to the same id. Re-uploading the same email
// un-archives them and their history is simply there again.
//
// The permanent version still exists, on one row at a time, behind its
// own flag — GDPR erasure and a mistyped test record both need it.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS archived_by text`);
  // Every list query filters on this, so it is worth an index — and a
  // partial one, because the rows that matter are the ones that are NOT
  // archived and that is the vast majority.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_employees_not_archived
                    ON core.employees (tenant_id, name) WHERE archived_at IS NULL`);
};
