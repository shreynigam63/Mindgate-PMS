// 002 — default permission bundles per tenant. Seeded for every tenant row
// present at migration time. New tenants created after migration time (the
// normal single-tenant-per-deploy boot path in index.js) get them via
// ensureTenantSeeds(), called once at boot right after tenant resolution —
// see index.js. Data, not code: clients edit role_permissions afterward.
const BUNDLES = {
  employee: ['pms_self', 'engagement_take', 'people_view'],
  manager:  ['pms_self', 'pms_team_eval', 'engagement_take', 'people_view'],
  hod:      ['pms_self', 'pms_team_eval', 'pms_hod', 'engagement_take', 'people_view'],
  // pms_compensation is HR's and admin's only — never manager or hod. A
  // manager can already see their reports' ratings; they must never see
  // their pay. Kept as its own grant rather than folded into pms_admin so
  // that revoking compensation access is one row (see migration 030).
  hr:       ['pms_self', 'pms_admin', 'pms_team_eval', 'pms_hod', 'engagement_admin', 'engagement_take', 'people_admin', 'people_view', 'letters_admin', 'pms_compensation', 'pms_hrbp', 'onboarding_ops'],
  // HRBP, and HR's pms_hrbp above, WERE granted only by migration 068 —
  // to the tenants that existed when it ran. index.js creates the tenant
  // AFTER migrations on a fresh install, so a new deployment's HRBPs
  // held nothing but what someone added by hand: no HRBP group, every
  // /hrbp/* page refused. Found on 6 Oct opening New Hire Insights as an
  // HRBP. Listed here, the boot-time seed carries them to every tenant.
  hrbp:     ['pms_self', 'pms_hrbp', 'people_view', 'engagement_take', 'onboarding_ops'],
  // HR Ops, 7 Oct: they run the First-Week Journey — tick tasks done and
  // send the joiner's emails — without HR's wider access (see 083).
  hr_ops:   ['pms_self', 'engagement_take', 'people_view', 'onboarding_ops'],
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
