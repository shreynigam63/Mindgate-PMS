// 002 — default permission bundles per tenant. Seeded for every tenant row
// present at migration time. New tenants created after migration time (the
// normal single-tenant-per-deploy boot path in index.js) get them via
// ensureTenantSeeds(), called once at boot right after tenant resolution —
// see index.js. Data, not code: clients edit role_permissions afterward.
const BUNDLES = {
  employee: ['pms_self', 'engagement_take', 'people_view'],
  manager:  ['pms_self', 'pms_team_eval', 'engagement_take', 'people_view'],
  hod:      ['pms_self', 'pms_team_eval', 'pms_hod', 'engagement_take', 'people_view'],
  hr:       ['pms_self', 'pms_admin', 'pms_team_eval', 'pms_hod', 'engagement_admin', 'engagement_take', 'people_admin', 'people_view', 'letters_admin'],
  admin:    ['*'],
};

async function ensureTenantSeeds(db, tenantId) {
  for (const [role, perms] of Object.entries(BUNDLES)) {
    for (const p of perms) {
      await db.query(
        `INSERT INTO core.role_permissions (tenant_id, role, permission)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, role, p]);
    }
  }
}

module.exports.up = async (db) => {
  const tenants = (await db.query(`SELECT id FROM core.tenants`)).rows;
  for (const t of tenants) await ensureTenantSeeds(db, t.id);
};
module.exports.BUNDLES = BUNDLES;
module.exports.ensureTenantSeeds = ensureTenantSeeds;
