// Location and HOD, kept per employee.
//
// Both of these were already in the client's HRMS export and both were
// being thrown away. `location` (and its spellings `branch`,
// `site_location`) sat in IGNORED_COLUMNS because nothing read it.
// `hod_name` was parsed per row, used to VOTE for a department head, and
// then dropped — so after an import the only record of who heads whom was
// one row per department in core.department_heads, set only where every
// employee in the department named the same person.
//
// On the live master that is 8 of 34 departments. Development alone is
// 568 people naming 23 different HODs, because Department is a coarse
// grouping and the HOD column records each person's actual head within
// it. The vote was right to refuse; what was wrong was discarding the
// per-person answer afterwards.
//
// The HRBP tab needs both: an HRBP's remit is a set of locations and a
// set of HODs, and neither can be resolved from a department-level head.
//
// NOTHING IS BACKFILLED. Both columns are null until the master is
// imported again — the values live in the HRMS, not in anything this
// migration can compute. An HRBP whose remit matches nobody sees empty
// screens, which is the honest answer while the data is absent, and the
// Employees page shows how many rows still have no location so it is
// visible rather than quiet.

module.exports.up = async (db) => {
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS location text`);
  await db.query(`ALTER TABLE core.employees ADD COLUMN IF NOT EXISTS hod_name text`);

  // Both columns are filter keys for every HRBP query, and the employee
  // master is the largest table in the product.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_employees_location
                    ON core.employees(tenant_id, location)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_employees_hod_name
                    ON core.employees(tenant_id, hod_name)`);
};
