// 050 — the competency pages, for tenants that already exist.
//
// Same reason 047 and 048 exist: 042 seeds core.page_permission with ON
// CONFLICT DO NOTHING, so it can only reach a tenant that has no row for
// that page yet — it cannot reach one seeded before the page existed. A
// fresh tenant gets these straight from 042's list.
//
// Four pages, three permissions:
//   /my/competencies            public — it is the employee's own form
//   /team/competencies          pms_team_eval, like every Manager page
//   /admin/competencies         pms_admin — the Competency Master
//   /admin/competency-dashboard pms_admin — company-wide figures
const ADD = [
  ['my_competencies',      '/my/competencies',            null],
  ['team_competencies',    '/team/competencies',          'pms_team_eval'],
  ['competency_framework', '/admin/competencies',         'pms_admin'],
  ['competency_dashboard', '/admin/competency-dashboard', 'pms_admin'],
];

module.exports.up = async (db) => {
  const tenants = (await db.query(`SELECT DISTINCT tenant_id FROM core.page_permission`)).rows;
  for (const { tenant_id } of tenants) {
    for (const [page, route, perm] of ADD) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenant_id, page, route, perm]);
    }
  }
};
