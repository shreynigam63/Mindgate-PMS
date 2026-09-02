// node --test — Super 50 / High-Performer Watchlist (BR-6.5) full lifecycle
// across multiple published annual cycles. Mirrors pip.test.js's pattern:
// real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-s50';
  process.env.TENANT_SLUG = 'super50-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const slug = process.env.TENANT_SLUG;
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [slug])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await require('../migrations/008-review-parameters').ensureDefaultParameters(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'S50 Mgr','s50-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'S50 Emp','s50-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'S50 HR','s50-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'s50-mgr@x.com','manager'),($1,'s50-hr@x.com','hr')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['s50-mgr@x.com', 's50-emp@x.com', 's50-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

async function login(email) {
  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) });
  return r.json();
}
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
async function scoreAllParamsTo(mgrTok, employeeId, value) {
  const plist = await api('/pms/review-parameters', mgrTok);
  const scores = Object.fromEntries(plist.body.parameters.map((p) => [p.id, value]));
  return api(`/pms/team/parameter-scores/${employeeId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ scores }) });
}

// Runs one full annual cycle end-to-end (draft -> publish) with the given
// manager rating for the fixed employee, returning the /publish response.
async function runAnnualCycle(hrTok, mgrTok, rating, name) {
  const cycleR = await api('/pms/cycles', hrTok, { method: 'POST', body: JSON.stringify({ name, fiscal_year: name, cycle_type: 'annual' }) });
  const cycleId = cycleR.body.cycle.id;
  for (const phase of ['kra_open', 'growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval']) {
    await api(`/pms/cycles/${cycleId}/phase`, hrTok, { method: 'POST', body: JSON.stringify({ to: phase }) });
  }
  await scoreAllParamsTo(mgrTok, empId, rating);
  await api(`/pms/team/evaluations/${empId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ strengths: 'x', improvement_areas: 'y' }) });
  await api(`/pms/team/evaluations/${empId}/submit`, mgrTok, { method: 'POST' });
  for (const phase of ['hod_eval', 'calibration', 'publish']) {
    await api(`/pms/cycles/${cycleId}/phase`, hrTok, { method: 'POST', body: JSON.stringify({ to: phase }) });
  }
  return api('/pms/publish', hrTok, { method: 'POST' });
}

test('Super 50: flags only after 3 consecutive A/A+ with the most recent an A+, unflags on a broken streak', { skip }, async () => {
  const hrAuth = await login('s50-hr@x.com');
  const mgrAuth = await login('s50-mgr@x.com');
  const hrTok = hrAuth.token, mgrTok = mgrAuth.token;

  const c1 = await runAnnualCycle(hrTok, mgrTok, 4, 'S50-FY1');
  assert.equal(c1.body.super50_flagged, 0, 'not eligible after only 1 cycle');

  const c2 = await runAnnualCycle(hrTok, mgrTok, 4, 'S50-FY2');
  assert.equal(c2.body.super50_flagged, 0, 'not eligible after 2 cycles, even both A');

  const c3 = await runAnnualCycle(hrTok, mgrTok, 5, 'S50-FY3');
  assert.equal(c3.body.super50_flagged, 1, '3rd consecutive top-tier, most recent is A+ (5) — now eligible');

  // BR-6.6: the HR user should have received a proactive retention_alert
  // notification the moment the flag was set, not just a passive watchlist.
  const notifs = await db.query(
    `SELECT n.title FROM core.notifications n JOIN core.employees e ON e.id=n.employee_id
      WHERE e.email='s50-hr@x.com' AND e.tenant_id=$1 AND n.kind='retention_alert'`, [tenantId]);
  assert.equal(notifs.rows.length, 1, 'exactly one retention alert sent to the HR user');
  assert.match(notifs.rows[0].title, /S50 Emp/);

  const list1 = await api('/pms/watchlist', hrTok);
  assert.equal(list1.body.watchlist.length, 1);
  assert.equal(list1.body.watchlist[0].id, empId);

  const c4 = await runAnnualCycle(hrTok, mgrTok, 2, 'S50-FY4');
  assert.equal(c4.body.super50_flagged, 0, 'a low rating does not newly flag anyone');

  const list2 = await api('/pms/watchlist', hrTok);
  assert.equal(list2.body.watchlist.length, 0, 'broken streak un-flags — watchlist is now empty');

  const mgrView = await api('/pms/watchlist', mgrTok);
  assert.equal(mgrView.status, 403, 'watchlist is HR/Management only, per the BRD Owner column');
});

test('Super 50: most recent A (4) rather than A+ (5) does not qualify, even with a longer top-tier streak', { skip }, async () => {
  const hrAuth = await login('s50-hr@x.com');
  const mgrAuth = await login('s50-mgr@x.com');
  const hrTok = hrAuth.token, mgrTok = mgrAuth.token;

  // Continues from the previous test's state (streak already broken at 2).
  await runAnnualCycle(hrTok, mgrTok, 5, 'S50-FY5');
  await runAnnualCycle(hrTok, mgrTok, 5, 'S50-FY6');
  const last = await runAnnualCycle(hrTok, mgrTok, 4, 'S50-FY7'); // most recent = A, not A+
  assert.equal(last.body.super50_flagged, 0, 'last 3 are [4,5,5] most-recent-first — most recent must be 5, not 4');

  const list = await api('/pms/watchlist', hrTok);
  assert.equal(list.body.watchlist.length, 0);
});
