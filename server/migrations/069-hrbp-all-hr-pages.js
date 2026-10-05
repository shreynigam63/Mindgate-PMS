// HRBP gets every HR tab, not a hand-picked seven.
//
// Asked for after the first cut shipped: "HRBP should have all tabs
// available in HR but with conditions we have mentioned" — HR's own
// screens, acting on their own people only.
//
// So the bespoke HRBP views are gone and the HRBP tab now opens HR's
// actual pages, on parallel /hrbp/* routes. The routes are separate from
// /admin/* on purpose: one page_permission row drives both the menu and
// the direct-URL guard, so giving an HRBP the /admin/* rows would put the
// HR tab itself in their menu beside their own. Two routes to one
// component keeps the two tabs distinct and the guard honest.
//
// The data is narrowed per request by hrbp-gateway.js. These rows decide
// only what may be OPENED.

const PAGES = [
  // page key,              route,                        replaces (HR page)
  ['hrbp_approvals', '/hrbp/approvals'],                // All Approvals
  ['hrbp_cycles', '/hrbp/cycles'],                   // Cycles — read-only
  ['hrbp_directory', '/hrbp/directory'],                // Employees
  ['hrbp_dept_heads', '/hrbp/department-heads'],         // Department Heads — read-only
  ['hrbp_career', '/hrbp/career-transitions'],      // Career Pathing Matrix
  ['hrbp_kra_overview', '/hrbp/kra-overview'],             // KRA Overview
  ['hrbp_kra_library', '/hrbp/kra-library'],              // KRA Library — read-only
  ['hrbp_competencies', '/hrbp/competencies'],             // Competency Framework — read-only
  ['hrbp_competency', '/hrbp/competency-dashboard'],      // Competency Dashboard
  ['hrbp_timesheet', '/hrbp/timesheet'],                // Timesheet
  ['hrbp_completion', '/hrbp/completion-report'],        // PMS Completion Report
  ['hrbp_calibration', '/hrbp/calibration'],              // Calibration
  ['hrbp_nine_box', '/hrbp/nine-box'],                 // 9-Box Grid
  ['hrbp_closure', '/hrbp/closure-letters'],          // Closure Letters
  ['hrbp_increments', '/hrbp/increments'],                // Increment Simulation
  ['hrbp_watchlist', '/hrbp/watchlist'],                // Super 50
  ['hrbp_engagement', '/hrbp/engagement'],               // Engagement Surveys
  ['hrbp_new_hire', '/hrbp/engagement-insights'],      // New Hire Insights
  ['hrbp_settings', '/hrbp/settings'],                 // Settings — read-only
];

// The seven bespoke views from 068 that no longer exist as pages. Their
// rows are removed rather than left pointing at nothing: a page_permission
// row for a route the router does not serve is a menu entry that opens a
// blank screen.
const RETIRED = ['/hrbp/employees'];

// Increment Simulation is salary, and salary sits behind its own
// permission rather than riding along with the rest of HR — deliberately,
// since "HR access" and "may see what people are paid" are different
// decisions at most clients. Granting it here is therefore a decision, not
// a tidy-up: it was asked for explicitly ("all tabs available in HR"), and
// what an HRBP sees through it is their own remit, never the company.
// Revoking it is one DELETE from core.role_permissions and costs the HRBP
// exactly those two tabs.
const ROLE_GRANTS = ['pms_compensation'];

// CALLED AT BOOT TOO, not only from up(). No migration can seed a tenant
// that does not exist yet: index.js creates the tenant row AFTER
// runMigrations(), so on a fresh deploy this migration's loop over
// core.tenants finds nothing and the HRBP tab simply never appears — the
// menu and the URL guard both read page_permission, so the whole tab is
// silently absent rather than broken in a way anyone would notice. 042
// already carries this shape for exactly the same reason; these rows were
// added later and did not.
//
// DO NOTHING on conflict, not DO UPDATE: this runs on every boot, and the
// table is data a client is meant to edit. up() keeps the UPDATE, because
// there it is a one-time correction for tenants that still carry the 068
// route set.
async function ensureHrbpPages(db, tenantId) {
  for (const perm of ROLE_GRANTS) {
    await db.query(
      `INSERT INTO core.role_permissions (tenant_id, role, permission) VALUES ($1,'hrbp',$2)
       ON CONFLICT DO NOTHING`, [tenantId, perm]);
  }
  for (const [page, route] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,'pms_hrbp') ON CONFLICT (tenant_id, page) DO NOTHING`,
      [tenantId, page, route]);
  }
}

async function up(db) {
  const tenants = (await db.query(`SELECT id FROM core.tenants`)).rows;
  for (const t of tenants) {
    await ensureHrbpPages(db, t.id);
    // The corrective pass, for a tenant that already holds the 068 rows.
    for (const [page, route] of PAGES) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,'pms_hrbp')
         ON CONFLICT (tenant_id, page) DO UPDATE
           SET route = EXCLUDED.route, required_permission = EXCLUDED.required_permission`,
        [t.id, page, route]);
    }
    await db.query(
      `DELETE FROM core.page_permission WHERE tenant_id=$1 AND route = ANY($2::text[])`,
      [t.id, RETIRED]);
  }
}

module.exports = { up, ensureHrbpPages, PAGES, RETIRED, ROLE_GRANTS };
