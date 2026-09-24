// 048 — the Manager tab gets its own dashboard page.
//
// Asked for on 24 Sep: "build a dashboard under 'Manager tab' same like
// one in 'self tab' for manager view regarding tracking of his
// reportees."
//
// Same reason 047 exists: 042 seeds core.page_permission with ON CONFLICT
// DO NOTHING, so it can only ever add rows to a tenant that has none of
// that page yet — it cannot reach a tenant that was seeded before the
// page existed. A fresh tenant gets this row straight from 042's list;
// this migration is for the ones already running.
//
// pms_team_eval, the same permission every other Manager-tab page
// carries. The page shows one manager's reports and nothing wider, so it
// needs nothing wider than the permission those pages already need.
const ADD = [
  ['team_dashboard', '/team/dashboard', 'pms_team_eval'],
];

module.exports.up = async (db) => {
  // Only tenants that already have page rows — see 047 for why seeding a
  // never-seeded tenant from here would leave it with one page and no
  // others.
  const tenants = (await db.query(`SELECT DISTINCT tenant_id FROM core.page_permission`)).rows;
  for (const { tenant_id } of tenants) {
    for (const [page, route, perm] of ADD) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenant_id, page, route, perm]);
    }
  }
};
