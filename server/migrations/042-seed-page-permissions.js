// 042 — fill core.page_permission, the table 001 created and nothing ever
// used. One row per page drives BOTH the sidebar and the direct-URL guard,
// so the menu and the address bar can never disagree.
//
// WHERE THESE VALUES COME FROM. Not from reading the handlers — from
// calling every page's main endpoint as each of the five default roles and
// recording who the server actually refused. The menu now hides exactly
// what the API would refuse, which is the only mapping that cannot drift
// into lying to someone.
//
// NULL means public, registered consciously:
//   - the eight "my own" pages are every employee's own record
//   - Improvement Plans is row-scoped in the handler (you see your own plan
//     or your reports'), so it is genuinely everyone's page despite sitting
//     in the Team group
//   - Engagement is where employees take surveys; People Hub is the
//     company noticeboard
//
// Two pages are gated on pms_hod rather than pms_admin because their
// handlers accept EITHER, and a single column cannot say "or": in the
// default bundles everyone holding pms_admin (hr, admin) also holds pms_hod
// or the wildcard, so pms_hod is the correct single gate. A tenant that
// grants pms_admin WITHOUT pms_hod should edit these two rows — this table
// is data, and clients are meant to edit it.
//
// Cycles is pms_admin although its GET is open to everyone: the page is the
// cycle console (create, advance phase, publish) and every one of those
// writes is pms_admin. The row records what the page is FOR.
const PAGES = [
  ['home',               '/home',                     null],
  ['my_kras',            '/my/kras',                  null],
  ['my_growth',          '/my/growth',                null],
  ['quarterly_connects', '/team/connects',            null],
  ['midyear',            '/my/midyear',               null],
  ['annual_review',      '/my/self-appraisal',        null],
  ['final_rating',       '/my/annual-review',         null],
  ['my_rating',          '/my/rating',                null],
  ['past_cycles',        '/my/history',               null],

  ['team_overview',      '/team/overview',            'pms_team_eval'],
  ['team_kra_sheets',    '/team/kra-sheets',          'pms_team_eval'],
  // Split out of /my/growth on 23 Sep for the same reason /team/midyear
  // was split out of /my/midyear: the manager's list of everybody's
  // target achievements was rendering under the employee's own growth
  // card, so My Performance showed other people again.
  ['team_growth',        '/team/growth',              'pms_team_eval'],
  ['team_eval',          '/team/eval',                'pms_team_eval'],
  // Split out of /my/midyear on 23 Sep: the manager's list of everybody's
  // mid-year reviews was rendering underneath the employee's OWN mid-year
  // card, so "My Performance" showed 1,398 other people. The employee's
  // page keeps its own record; the team list is a Manager-tab page with
  // the same permission as every other team list.
  ['team_midyear',       '/team/midyear',             'pms_team_eval'],
  ['delivery_head',      '/hod',                      'pms_hod'],
  ['improvement_plans',  '/pip',                      null],

  ['all_approvals',      '/admin/approvals',          'pms_admin'],
  ['cycles',             '/admin/cycles',             'pms_admin'],
  ['employees',          '/admin/directory',          'people_admin'],
  ['department_heads',   '/admin/department-heads',   'people_admin'],
  ['career_matrix',      '/admin/career-transitions', 'people_admin'],
  ['kra_overview',       '/admin/kra-overview',       'pms_admin'],
  ['kra_library',        '/admin/kra-library',        'pms_admin'],
  ['completion_report',  '/admin/completion-report',  'pms_admin'],
  ['calibration',        '/admin/calibration',        'pms_admin'],
  ['nine_box',           '/admin/nine-box',           'pms_hod'],
  ['closure_letters',    '/admin/closure-letters',    'letters_admin'],
  ['increments',         '/admin/increments',         'pms_compensation'],
  // review_analysis ('/admin/parameter-analysis') was REMOVED on 23 Sep
  // with the rest of the 7-parameter UI. Migration 047 deletes the row
  // from tenants that already have it; this list is what a NEW tenant
  // gets, and it no longer includes a page with no way in.
  ['super_50',           '/admin/watchlist',          'pms_admin'],
  ['settings',           '/admin/settings',           'pms_admin'],

  // Engagement split in two on 23 Sep: taking a survey you were invited
  // to stays public and stays in Self; running surveys — writing them,
  // opening and closing them, reading results and themes — is HR's, and
  // carries the permission the write endpoints already required.
  ['engagement',         '/engagement',               null],
  ['engagement_admin',   '/admin/engagement',         'engagement_admin'],
  ['people_hub',         '/people',                   null],
];

// ON CONFLICT DO NOTHING: once a tenant has a row, it is theirs to edit and
// a later boot must not stamp on it.
async function ensurePageSeeds(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`,
      [tenantId, page, route, perm]);
  }
}

module.exports.up = async (db) => {
  const tenants = (await db.query(`SELECT id FROM core.tenants`)).rows;
  for (const t of tenants) await ensurePageSeeds(db, t.id);
};
module.exports.PAGES = PAGES;
module.exports.ensurePageSeeds = ensurePageSeeds;
