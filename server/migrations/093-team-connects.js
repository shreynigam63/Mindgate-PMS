// Connects, 15 Oct.
//
// The AI sorts what was discussed into Achievements, Blockers and Feedback
// after a connect is saved (connect-ai.js); these columns say how that went.
//   ai_status  pending | working | done | failed — NULL when nothing to sort
//
// TEAM CONNECTS: the connects of the people a manager, Delivery Head, HRBP
// or HR looks after move out of Self → Connects into a Team Connects page
// in each of those tabs. The pages are registered here and at boot (a
// tenant created later needs them too).
const PAGES = [
  ['team_connects', '/team/team-connects', 'pms_team_eval'],
  ['hod_team_connects', '/hod/team-connects', 'pms_hod'],
  ['hrbp_team_connects', '/hrbp/team-connects', 'pms_hrbp'],
  ['hr_team_connects', '/admin/team-connects', 'pms_admin'],
];

async function ensureTeamConnectPages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenantId, page, route, perm]);
  }
}

async function up(db) {
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS ai_status text`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS ai_error text`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS ai_categorised_at timestamptz`);
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await ensureTeamConnectPages(db, id);
}

module.exports = { up, ensureTeamConnectPages, PAGES };
