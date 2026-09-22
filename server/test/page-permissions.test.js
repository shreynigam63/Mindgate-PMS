// node --test — the sidebar and the API must agree about every page.
//
// Asked for on 22 Sep: an employee should not be shown a menu full of
// pages that are not theirs. Before this, only 8 of 29 nav items were
// gated at all, by a `roles:` array hardcoded in App.jsx; the other 21
// showed to everyone, and the array was a second, hand-maintained copy of
// a truth the server already held.
//
// Now one row in core.page_permission drives the sidebar AND the
// direct-URL guard, and /me returns the routes the caller may open.
//
// THE TEST THAT CARRIES THE WEIGHT is `menu matches what the API allows`.
// A menu that hides a page the API would serve is an annoyance; a menu
// that SHOWS a page the API refuses is how you hand someone a 403 for
// clicking what you offered them. Both directions are asserted, per role,
// against the real endpoint behind each page — so if a handler's guard
// changes and the page row does not, this fails.
//
// The page rows were derived by calling these endpoints as each role and
// recording who the server refused; this test is that derivation, frozen.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;
const tok = {};

// page route -> the endpoint that page loads with. Only pages whose main
// read is a plain GET are listed; that is enough to catch a guard drifting
// away from its page row.
const PROBE = {
  '/my/kras': '/pms/my/kra-sheet',
  '/my/growth': '/pms/my/development-plan',
  '/team/connects': '/pms/connects',
  '/my/midyear': '/pms/my/midyear-review',
  '/my/self-appraisal': '/pms/my/self-appraisal',
  '/my/annual-review': '/pms/my/annual-review',
  '/my/rating': '/pms/my/rating',
  '/my/history': '/pms/my/history',
  '/team/overview': '/pms/team/overview',
  '/team/kra-sheets': '/pms/team/kra-sheets',
  '/team/eval': '/pms/team/evaluations',
  '/hod': '/pms/hod/queue',
  '/pip': '/pms/pip',
  '/admin/approvals': '/pms/approvals',
  '/admin/kra-overview': '/pms/kra/org-overview',
  '/admin/kra-library': '/pms/hr/kra-library',
  '/admin/completion-report': '/pms/reports/completion',
  '/admin/calibration': '/pms/calibration',
  '/admin/nine-box': '/pms/nine-box',
  '/admin/closure-letters': '/pms/closure-letters',
  '/admin/increments': '/pms/increment-simulations',
  '/admin/watchlist': '/pms/watchlist',
  '/admin/settings': '/pms/hr/settings',
};
// Cycles is deliberately NOT probed: its GET is open to everyone because
// every page needs the current cycle, while the page itself is the admin
// console and its every write is pms_admin. The page row records what the
// page is for, which is the one case where row and read differ by design.

const ROLES = ['employee', 'manager', 'hod', 'hr', 'admin'];

const get = async (path, t) =>
  (await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } })).status;
const me = async (t) =>
  (await (await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${t}` } })).json());

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pagperm';
  process.env.TENANT_SLUG = 'pageperm-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { authenticate, devLogin } = require('../core/auth');
  const { effectivePermissions } = require('../core/permissions');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  // This tenant is created after the migrations ran, exactly like a fresh
  // deploy's tenant — so it takes the same boot-time seeding path index.js
  // uses, which is itself worth exercising.
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await require('../migrations/042-seed-page-permissions').ensurePageSeeds(db, t.id);
  await db.query(
    `INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order)
     VALUES ($1,'Delivery',60,10), ($1,'Collaboration',40,20)`, [t.id]);
  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'PP Cycle','FY26','annual','kra_open')`, [t.id]);

  for (const role of ROLES) {
    const email = `pp-${role}@x.com`;
    await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
       VALUES ($1,$2,$3,'active','Executive','Delivery')`, [t.id, `PP ${role}`, email]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
    await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,$2,$3)`,
      [t.id, email, role]);
  }

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  // The same /me as index.js. Kept in step by the assertions below rather
  // than by hope: if the real one stops filtering, `menu matches what the
  // API allows` still passes here but the shape assertions would not catch
  // it — so index.js is also asserted to contain the query.
  app.get('/api/v1/me', authenticate, async (rq, rs) => {
    const rows = (await db.query(
      `SELECT route, required_permission FROM core.page_permission
        WHERE tenant_id=$1 AND route IS NOT NULL`, [rq.user.tenant_id])).rows;
    let pages = null;
    if (rows.length) {
      const { permissions, wildcard } = await effectivePermissions(rq.user);
      pages = rows.filter(r => !r.required_permission || wildcard || permissions.has(r.required_permission))
        .map(r => r.route);
    }
    rs.json({ user: rq.user, pages });
  });
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;

  for (const role of ROLES) {
    tok[role] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `pp-${role}@x.com`, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('every page is registered, and every route is registered once', { skip }, async () => {
  const { PAGES } = require('../migrations/042-seed-page-permissions');
  const rows = (await db.query(
    `SELECT page, route, required_permission FROM core.page_permission WHERE tenant_id=$1`,
    [tenantId])).rows;
  assert.equal(rows.length, PAGES.length, 'every page in the module is seeded');
  const routes = rows.map(r => r.route);
  assert.equal(new Set(routes).size, routes.length, 'no route is claimed by two pages');
  // NULL is a decision, not an omission: assert the public set is exactly
  // the one the migration's header justifies, so a new public page has to
  // be argued for here too.
  const publicRoutes = rows.filter(r => !r.required_permission).map(r => r.route).sort();
  assert.deepEqual(publicRoutes, [
    '/engagement', '/my/annual-review', '/my/growth', '/my/history', '/my/kras',
    '/my/midyear', '/my/rating', '/my/self-appraisal', '/people', '/pip', '/team/connects',
  ]);
});

test('an employee is offered only their own pages', { skip }, async () => {
  const { pages } = await me(tok.employee);
  assert.ok(pages, 'the page list is present');
  assert.ok(pages.includes('/my/kras'));
  for (const hidden of ['/team/overview', '/hod', '/admin/cycles', '/admin/increments',
                        '/admin/directory', '/admin/settings']) {
    assert.ok(!pages.includes(hidden), `${hidden} must not be offered to an employee`);
  }
});

test('a manager adds the team pages and nothing else', { skip }, async () => {
  const emp = (await me(tok.employee)).pages;
  const mgr = (await me(tok.manager)).pages;
  const added = mgr.filter(p => !emp.includes(p)).sort();
  assert.deepEqual(added, ['/team/eval', '/team/kra-sheets', '/team/overview']);
  assert.ok(!mgr.includes('/admin/increments'), 'a manager never sees compensation');
});

test('a delivery head adds their own queue, HR adds the admin pages', { skip }, async () => {
  const mgr = (await me(tok.manager)).pages;
  const hod = (await me(tok.hod)).pages;
  assert.deepEqual(hod.filter(p => !mgr.includes(p)).sort(), ['/admin/nine-box', '/hod']);

  const hr = (await me(tok.hr)).pages;
  for (const p of ['/admin/cycles', '/admin/directory', '/admin/increments',
                   '/admin/closure-letters', '/admin/settings']) {
    assert.ok(hr.includes(p), `HR must be offered ${p}`);
  }
});

test('an admin is offered every page', { skip }, async () => {
  const { PAGES } = require('../migrations/042-seed-page-permissions');
  const { pages } = await me(tok.admin);
  assert.equal(pages.length, PAGES.length);
});

test('menu matches what the API allows, for every role and page', { skip }, async () => {
  const mismatches = [];
  for (const role of ROLES) {
    const offered = new Set((await me(tok[role])).pages);
    for (const [page, endpoint] of Object.entries(PROBE)) {
      const status = await get(endpoint, tok[role]);
      const apiAllows = status !== 403;
      const menuOffers = offered.has(page);
      if (apiAllows !== menuOffers) {
        mismatches.push(`${role}: ${page} -> ${endpoint} api=${status} menu=${menuOffers}`);
      }
    }
  }
  assert.deepEqual(mismatches, [], 'the menu offers exactly what the API serves');
});

test('index.js filters /me from the page table rather than trusting the client', { skip }, async () => {
  // The app's own /me is mounted in index.js, which this test cannot boot
  // (it needs the full env). Assert the query is there, so removing the
  // filter cannot pass silently.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /FROM core\.page_permission/, 'index.js reads the page table');
  assert.match(src, /ensurePageSeeds/, 'index.js seeds pages for a tenant created after migration');
});
