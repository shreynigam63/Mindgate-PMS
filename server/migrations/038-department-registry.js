// A registry of departments, so HR can add one BEFORE anybody is in it and
// remove one that is finished with.
//
// Until now a department was not a thing. It existed only as free text in
// core.employees.department, and the Department Heads page derived its list
// from `SELECT DISTINCT department FROM core.employees`. Two consequences,
// both of which HR hit:
//
//   - A new department could not be set up in advance. You could not name a
//     Delivery Head for "Cloud Ops" until somebody was already filed under
//     it, and the page said so out loud: "No departments found — add
//     employees with a department set first."
//   - A department could never be removed. A typo in one HRMS import
//     ("Devlopment") became a permanent row on that page, with a dropdown
//     inviting someone to assign it a head.
//
// WHAT THIS IS NOT: a constraint on core.employees.department. The column
// stays free text and the HRMS importer keeps accepting whatever it is sent.
// Making the registry authoritative would start REJECTING imports the moment
// HR adds a department the registry has not heard of — on a file of 1,398
// people that is a bad trade for a tidier list, and it is a separate
// decision that belongs to the client, not to this migration.
//
// So the page shows the UNION of "departments people are actually in" and
// "departments HR has registered", with a count beside each. A department
// with employees cannot be removed — that is the one hard rule, and it is
// enforced in the route rather than here, because the answer HR needs is
// "14 people are still in Finance", not a foreign-key violation.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS core.departments (
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id),
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    PRIMARY KEY (tenant_id, name)
  )`);

  // Case-insensitive uniqueness. "Finance" and "finance" are one department
  // to every human who reads the page, and two rows here would show up as
  // two lines each offering its own Delivery Head.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_ci
                    ON core.departments (tenant_id, lower(btrim(name)))`);

  // Seed from what employees are already in, so the page looks identical the
  // moment this lands and nothing appears to have been lost. Idempotent:
  // ON CONFLICT DO NOTHING means a second run adds nothing, and a department
  // HR has since deliberately REMOVED does not come back on the next boot
  // unless an employee is still in it — in which case it was never
  // removable in the first place.
  await db.query(`
    INSERT INTO core.departments (tenant_id, name, created_by)
    SELECT DISTINCT e.tenant_id, btrim(e.department), 'migration-038'
      FROM core.employees e
     WHERE e.status='active' AND coalesce(btrim(e.department),'') <> ''
    ON CONFLICT DO NOTHING`);
};
