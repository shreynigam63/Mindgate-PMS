// node --test — Team KRA Sheets (BR-1.3), regression coverage for a bug
// reported live with a screenshot: "Team KRA Sheets should be visible if
// employee fills KRA and manager approves — shows 'No direct reports
// found' instead." Real Postgres, real HTTP surface, skips cleanly
// without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, mgrId, notStartedEmpId, staleEmpId, cycleId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tks';
  process.env.TENANT_SLUG = 'tks-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'TKS Mgr','tks-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  // A report who has NEVER touched their own KRA page — no kra_sheets row
  // exists for them at all yet.
  const notStarted = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'TKS NotStarted','tks-notstarted@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  notStartedEmpId = notStarted.id;
  // A report whose KRA sheet's OWN stored manager_id will be deliberately
  // set to something else after creation — simulating the exact drift
  // this bug traces to (an HRMS import correcting manager_id after the
  // sheet already existed with an earlier, wrong snapshot).
  const stale = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'TKS Stale','tks-stale@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  staleEmpId = stale.id;

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tks-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['tks-mgr@x.com', 'tks-notstarted@x.com', 'tks-stale@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'TKS Cycle','FYTKS','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;

  // The "stale" employee's KRA sheet gets created with a WRONG manager_id
  // snapshot (a random uuid, standing in for "some other manager, or one
  // that hasn't resolved correctly yet") — their CURRENT, real manager
  // (core.employees.manager_id) is correctly tks-mgr, but the sheet's own
  // stored column disagrees.
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,gen_random_uuid(),'submitted') RETURNING id`,
    [t.id, cycleId, staleEmpId])).rows[0];
  await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Ship the thing',100,10)`, [t.id, sheet.id]);

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

test('a report with no KRA sheet yet still appears, as not_started — not silently dropped', { skip }, async () => {
  const { token } = await login('tks-mgr@x.com');
  const r = await api('/pms/team/kra-sheets', token);
  assert.equal(r.status, 200);
  const row = r.body.sheets.find((s) => s.employee_id === notStartedEmpId);
  assert.ok(row, 'the report shows up even though they have not touched their KRA page yet');
  assert.equal(row.status, 'not_started');
  assert.equal(row.id, null, 'no sheet row exists for them, correctly reflected as null');
});

test('a submitted KRA sheet appears for the CURRENT manager even if its own stored manager_id snapshot disagrees', { skip }, async () => {
  const { token } = await login('tks-mgr@x.com');
  const r = await api('/pms/team/kra-sheets', token);
  const row = r.body.sheets.find((s) => s.employee_id === staleEmpId);
  assert.ok(row, 'found despite the stale kra_sheets.manager_id snapshot — this is the exact reported bug');
  assert.equal(row.status, 'submitted');
  assert.equal(row.kra_count, 1);
});

test('the manager can still approve that sheet, via the live employee->manager check, not the stale snapshot', { skip }, async () => {
  const { token } = await login('tks-mgr@x.com');
  const list = await api('/pms/team/kra-sheets', token);
  const row = list.body.sheets.find((s) => s.employee_id === staleEmpId);

  const kras = await api(`/pms/team/kra-sheets/${row.id}/kras`, token);
  assert.equal(kras.status, 200, 'view endpoint also uses the live check, not the stale snapshot');

  const decide = await api(`/pms/team/kra-sheets/${row.id}/decide`, token, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(decide.status, 200, 'decide endpoint also uses the live check, not the stale snapshot');
});
