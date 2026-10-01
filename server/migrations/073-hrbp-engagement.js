// An HR Business Partner reads engagement surveys in their own right.
//
// Asked for: "Any surveys use by HR should be available for all HR
// users/roles", and "we should have export option for results of all
// surveys completed by employees for HR and HRBP role."
//
// Nothing in the engagement module was ever scoped to whoever created a
// survey — created_by is written and never read as a filter — so any
// holder of engagement_admin already sees every survey and every
// template. What an HRBP lacked was the permission itself: they reached
// the page only because the HRBP gateway lends it for the request. That
// works, and it is the wrong thing to depend on. The grant is explicit
// here, and the gateway still narrows what comes back, because narrowing
// keys off pms_hrbp rather than off how the permission was obtained.
async function up(db) {
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await db.query(
      `INSERT INTO core.role_permissions (tenant_id, role, permission)
       VALUES ($1,'hrbp','engagement_admin') ON CONFLICT DO NOTHING`, [id]);
  }
}
module.exports = { up };
