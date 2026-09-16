// 034 — the KRA library gains a department, so a job title can mean
// different things in different parts of the company.
//
// WHY. Keyed on designation alone, one shelf named "Manager" has to serve
// every Manager in the company. In the client's own employee master that
// is 59 people across 15 departments, and it is not the exception: 37 of
// the 90 job titles appear in more than one department, covering 1,281 of
// 1,398 active employees. A single shelf for all of them is either too
// generic to use or wrong for most of the people it reaches.
//
// NULLABLE ON PURPOSE. A row with no department is the FALLBACK for its
// designation — "these KRAs suit this title anywhere". Every shelf
// published before this migration has a null department and therefore
// keeps working exactly as it did; matching prefers the employee's own
// department and falls back to the blank row, so nothing has to be
// re-uploaded and nothing breaks if it never is.
//
// NOT AN ENUM, NOT A FOREIGN KEY. Departments come from the HRMS export
// and change without warning; a constraint here would turn an HR data
// correction into a failed import. The column is text and is matched
// case- and whitespace-insensitively, the same way designation already is.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.kra_library ADD COLUMN IF NOT EXISTS department text`);

  // The employee-facing lookup is (department, designation) on every page
  // load of the picker, so it gets an index. lower(btrim(...)) mirrors the
  // comparison the query actually makes — an index on the raw columns
  // would never be used.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_kra_library_dept_desig
    ON pms.kra_library (tenant_id, lower(btrim(coalesce(department,''))), lower(btrim(designation)))`);
};
