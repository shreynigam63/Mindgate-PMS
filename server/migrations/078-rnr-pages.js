// The RnR screens, registered so the menu and the direct-URL guard agree.
//
// Each lands in the tab of the role that owns that step: the manager
// nominates from Manager, the HOD approves from their own tab,
// the HRBP from theirs, HR administers from HR. One row drives both the
// menu entry and who may open the URL.
const PAGES = [
  ['rnr_dashboard', '/rnr/dashboard', 'pms_self'],
  ['rnr_nominate', '/rnr/nominate', 'pms_team_eval'],
  ['rnr_mine', '/rnr/my-nominations', 'pms_team_eval'],
  ['rnr_dh', '/rnr/approvals/delivery-head', 'pms_hod'],
  ['rnr_hrbp_q', '/hrbp/rnr-approvals', 'pms_hrbp'],
  ['rnr_hr', '/rnr/approvals/hr', 'pms_admin'],
  ['rnr_admin', '/admin/rnr', 'pms_admin'],
];

// Also called at boot — see the note in 069. A migration cannot seed a
// tenant that is created after it runs, so without this a fresh deploy
// gets no RnR menu entries at all and every /rnr/* URL is refused by the
// page guard, which reads the same rows.
async function ensureRnrPages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`,
      [tenantId, page, route, perm]);
  }
}

async function up(db) {
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    for (const [page, route, perm] of PAGES) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, page) DO UPDATE SET route=EXCLUDED.route,
           required_permission=EXCLUDED.required_permission`, [id, page, route, perm]);
    }
  }
}
module.exports = { up, ensureRnrPages, PAGES };
