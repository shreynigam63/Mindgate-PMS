// The HRBP tab: who an HR business partner may see.
//
// An HRBP is HR for a slice of the company rather than all of it. The
// slice is a set of LOCATIONS and a set of HODs, both assigned by HR —
// not inferred from the HRBP's own employee record, because an HRBP
// commonly covers two sites and because an inferred remit would change
// silently the moment somebody edited their row.
//
// ONE TABLE, TWO KINDS, read as a UNION. A person is in the remit if
// their location is one of the assigned locations OR their hod_name is
// one of the assigned HODs. Union rather than intersection: the request
// was "as per location and HOD", and on the live master 26 of 34
// departments have no department head set, so an intersection would
// usually resolve to nobody and look broken.
//
// AN EMPTY REMIT MEANS EMPTY SCREENS. Never the whole company. That is
// the one rule this table exists to make unambiguous — a scoping bug
// that fails open hands somebody the entire org's ratings, so the
// resolver treats "no rows" as "no access", and the screens say so in
// words rather than rendering a blank list.
//
// VALUES ARE MATCHED CASE-INSENSITIVELY but stored as typed, because
// the HRMS writes "Pune" and "pune" and an HRBP should not lose half
// their site to a capital letter. They are NOT normalised on the
// employee master — see 067 — so the matching does the folding.

const PAGES = [
  // The operational subset, read-only. Increment Simulation (salary),
  // Settings (tenant-wide configuration) and the KRA Library (publishes
  // shelves org-wide, which is not a scoped act) are deliberately absent:
  // an HRBP holding any of the three would be HR, not an HRBP.
  ['hrbp_approvals',    '/hrbp/approvals',           'pms_hrbp'],
  ['hrbp_employees',    '/hrbp/employees',           'pms_hrbp'],
  ['hrbp_kra_overview', '/hrbp/kra-overview',        'pms_hrbp'],
  ['hrbp_timesheet',    '/hrbp/timesheet',           'pms_hrbp'],
  ['hrbp_completion',   '/hrbp/completion-report',   'pms_hrbp'],
  ['hrbp_competency',   '/hrbp/competency-dashboard','pms_hrbp'],
  ['hrbp_nine_box',     '/hrbp/nine-box',            'pms_hrbp'],
  // Where HR assigns each HRBP their locations and HODs. HR's page, not
  // the HRBP's — a remit nobody but its holder can change is not a
  // control.
  ['hrbp_admin',        '/admin/hrbp',               'pms_admin'],
];

module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS core.hrbp_scope (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id),
    email      text NOT NULL,                      -- the HRBP, by login address
    kind       text NOT NULL,                      -- 'location' | 'hod'
    value      text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    CONSTRAINT hrbp_scope_kind CHECK (kind IN ('location','hod')),
    CONSTRAINT hrbp_scope_value_not_blank CHECK (btrim(value) <> '')
  )`);

  // One row per (hrbp, kind, value), case-insensitively: assigning Pune
  // twice is a mistake, not two sites.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS hrbp_scope_unique
    ON core.hrbp_scope (tenant_id, lower(email), kind, lower(value))`);
  await db.query(`CREATE INDEX IF NOT EXISTS hrbp_scope_by_email
    ON core.hrbp_scope (tenant_id, lower(email))`);

  // The permission, and a role bundle that holds it. pms_hrbp is its own
  // grant rather than part of pms_admin: the whole point is that an HRBP
  // is NOT an admin, and the two must be revocable separately.
  //
  // The bundle carries pms_self as well because an HRBP is an employee
  // with their own KRAs, exactly like every other bundle in 002.
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    for (const p of ['pms_self', 'pms_hrbp', 'people_view', 'engagement_take']) {
      await db.query(
        `INSERT INTO core.role_permissions (tenant_id, role, permission)
         VALUES ($1,'hrbp',$2) ON CONFLICT DO NOTHING`, [id, p]);
    }
    // HR and admin can open the HRBP pages too — HR needs to see what an
    // HRBP sees to answer a question about it, and admin holds '*'
    // already.
    await db.query(
      `INSERT INTO core.role_permissions (tenant_id, role, permission)
       VALUES ($1,'hr','pms_hrbp') ON CONFLICT DO NOTHING`, [id]);
  }

  // Page rows drive BOTH the nav and the direct-URL guard, from the same
  // row — see the security skill. A tenant seeded before these pages
  // existed cannot be reached by 042's ON CONFLICT DO NOTHING, so they
  // are inserted here for every tenant that already has page rows.
  const tenants = (await db.query(`SELECT DISTINCT tenant_id FROM core.page_permission`)).rows;
  for (const { tenant_id } of tenants) {
    for (const [page, route, perm] of PAGES) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenant_id, page, route, perm]);
    }
  }
};

module.exports.PAGES = PAGES;
