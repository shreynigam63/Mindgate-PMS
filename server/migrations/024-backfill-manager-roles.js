// 024 — one-time backfill: give existing org-chart managers the role that
// lets them actually approve.
//
// THE GAP: the employee importer has always written the ORG CHART
// (manager_email -> core.employees.manager_id) but never core.user_roles,
// and core/auth.js's principalByEmail defaults a missing row to
// 'employee'. Since pms_team_eval comes from the manager/hod/hr/admin
// bundles, every manager loaded from an HRMS could RECEIVE their reports'
// KRA submissions and was then refused at the approval step with
// "Requires 'pms_team_eval'". Reported from a real manager's login: the
// employee submitted, the sheet was waiting, and the one person who could
// act on it could not open the page.
//
// The importer now closes this going forward (core/employees.js grants the
// role on import, and previews it in the dry run). That fix only fires
// during an import, so it does nothing for people already loaded — this
// migration is the catch-up for them, so nobody has to re-run an import
// they may no longer have the file for.
//
// UPGRADE ONLY, NEVER DOWNGRADE. The NOT EXISTS guard means anyone with an
// explicit role keeps it untouched. Without it this would demote an HR or
// admin who also manages people, silently stripping permissions from the
// most privileged accounts in the system — the opposite of the intent.
//
// IDEMPOTENT, as every migration here must be: re-running grants nothing
// the second time, because the rows it would insert now exist and are
// caught by the same NOT EXISTS.
//
// Scoped per tenant by joining manager and report on the same tenant_id —
// a manager_id could otherwise be matched across tenants on a shared
// database.
//
// Only ACTIVE managers are granted. A non-active employee cannot log in at
// all (auth.js rejects them before permissions are ever consulted), so a
// grant would be permissions handed to an account that cannot use them.
// If someone is reactivated later, the next import grants it.
module.exports.up = async (db) => {
  const granted = await db.query(
    `INSERT INTO core.user_roles (tenant_id, email, role)
     SELECT DISTINCT mgr.tenant_id, LOWER(mgr.email), 'manager'
       FROM core.employees mgr
       JOIN core.employees rep
         ON rep.manager_id = mgr.id AND rep.tenant_id = mgr.tenant_id
      WHERE mgr.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM core.user_roles ur
           WHERE ur.tenant_id = mgr.tenant_id AND LOWER(ur.email) = LOWER(mgr.email))
     ON CONFLICT DO NOTHING
     RETURNING tenant_id, email`);

  // Audited per grant rather than only counted. This hands out approval
  // rights, and this repo's rule is that "why can this person approve"
  // needs a queryable answer — a boot log line scrolls away, an audit row
  // does not. actor_email names the migration because no human triggered
  // it, which is itself the useful fact when someone asks later.
  for (const row of granted.rows) {
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,'system:migration-024','ROLE_GRANTED','user_roles',$2,$3)`,
      [row.tenant_id, row.email,
       JSON.stringify({ role: 'manager', reason: 'backfill — manages at least one employee in the org chart and had no explicit role' })]);
  }
};
