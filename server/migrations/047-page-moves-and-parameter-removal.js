// 047 — three pages move, and one page goes away.
//
// Migration 042 seeds core.page_permission with ON CONFLICT DO NOTHING,
// which is right: once a tenant has a row it is theirs to edit and a
// later boot must not stamp on it. The consequence is that 042 can only
// ever ADD, and never move or remove. This migration is the other half,
// for tenants that already exist — a fresh tenant gets the same end state
// straight from 042's list.
//
// All three changes come from one instruction on 23 Sep:
//
//   1. "Engagement tab should be under HR tab and not my performance."
//      Engagement split in two rather than moving wholesale, because
//      moving it wholesale would take away an employee's ability to
//      answer a survey they were invited to. /engagement keeps the
//      employee's half and stays public; /admin/engagement is the new
//      HR half (write the survey, open and close it, read results and
//      themes) and carries engagement_admin — the permission its write
//      endpoints already required, so this grants nobody anything new.
//
//   2. "my growth still shows team target achievement … which should
//      ideally be under Manager tab." /team/growth, pms_team_eval, the
//      same permission every other team list carries.
//
//   3. "we don't need 7 parameters in PMS for now, please remove from
//      all tabs if available, in case it is needed in future we can
//      check." /admin/parameter-analysis was the 7 parameters' own page,
//      so its row goes; the page component, the /agentic/parameter-
//      analysis routes, pms.review_parameters, pms.parameter_scores and
//      every analysis already stored are all untouched. Restoring the
//      page is re-adding this row and the route.
//
// DELETING A PAGE ROW IS NOT THE SAME AS BLOCKING THE PAGE. An
// unregistered route is allowed through by the client guard and left to
// the API, which guards itself — so the row is removed TOGETHER WITH the
// route in App.jsx, and it is the missing route that closes the door.
// Leaving the row behind would instead have left a menu entry pointing
// at a page the router no longer has.
const ADD = [
  ['engagement_admin', '/admin/engagement', 'engagement_admin'],
  ['team_growth',      '/team/growth',      'pms_team_eval'],
];

module.exports.up = async (db) => {
  // Only for tenants that already have page rows. A tenant with none is
  // either brand new or has never been seeded, and 042's seeder will
  // give it the current list in full on boot — adding two rows here
  // would leave it with exactly two pages and no others.
  const tenants = (await db.query(
    `SELECT DISTINCT tenant_id FROM core.page_permission`)).rows;
  for (const { tenant_id } of tenants) {
    for (const [page, route, perm] of ADD) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenant_id, page, route, perm]);
    }
  }
  await db.query(
    `DELETE FROM core.page_permission WHERE route='/admin/parameter-analysis'`);
};
