// node --test — HR org-wide KRA overview + enter-on-behalf (BR-1.1/1.4).
// Found missing 28-Aug-2026: /team/kra-sheets was manager-scoped only, and
// every KRA edit/submit route assumed "self" (req.user.id) — HR could not
// see the whole org or enter a KRA for someone else. Real Postgres, real
// HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empAId, empBId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kraov';
  process.env.TENANT_SLUG = 'kraov-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'KO HR','ko-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'KO Mgr','ko-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const empA = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status) VALUES ($1,'KO Emp A','ko-empA@x.com','Engineering',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  const empB = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status) VALUES ($1,'KO Emp B','ko-empB@x.com','Sales',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  empAId = empA.id; empBId = empB.id;
  const hash = await bcrypt.hash('pass', 10);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ko-hr@x.com','hr'),($1,'ko-mgr@x.com','manager')`, [t.id]);
  for (const email of ['ko-hr@x.com', 'ko-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'KO Cycle','FYKO','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  // empA already has a KRA sheet in progress; empB has none — proves the
  // "not_started" counter for employees who haven't touched KRAs at all.
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'draft')`, [t.id, cycle.id, empA.id, mgr.id]);

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

test('org-overview: shows status across ALL employees, not just one manager\'s reports', { skip }, async () => {
  const { token } = await login('ko-hr@x.com');
  const r = await api('/pms/kra/org-overview', token);
  assert.equal(r.status, 200);
  const empA = r.body.employees.find((e) => e.employee_id === empAId);
  const empB = r.body.employees.find((e) => e.employee_id === empBId);
  assert.equal(empA.status, 'draft');
  assert.equal(empB.status, 'not_started', 'employee with zero sheet rows shows as not_started, not missing');
  assert.equal(r.body.counters.draft, 1);
  // 4 employees seeded total (hr, mgr, empA, empB); only empA has a sheet
  // — the other 3 (including HR/manager themselves, correctly, since
  // "across all employees" means all employees) are not_started.
  assert.equal(r.body.counters.not_started, 3);
});

test('org-overview: search filters by name/department', { skip }, async () => {
  const { token } = await login('ko-hr@x.com');
  const r = await api('/pms/kra/org-overview?q=Sales', token);
  assert.equal(r.body.employees.length, 1);
  assert.equal(r.body.employees[0].employee_id, empBId);
});

test('org-overview: a plain manager (no pms_admin) is blocked', { skip }, async () => {
  const { token } = await login('ko-mgr@x.com');
  const r = await api('/pms/kra/org-overview', token);
  assert.equal(r.status, 403);
});

test('enter-on-behalf: HR can create, edit, and submit a KRA sheet for an employee with none', { skip }, async () => {
  const { token } = await login('ko-hr@x.com');
  const get1 = await api(`/pms/hr/kra-sheet/${empBId}`, token);
  assert.equal(get1.body.sheet.status, 'draft', 'auto-created, same as self-service GET /my/kra-sheet');
  assert.equal(get1.body.kras.length, 0);

  const save = await api(`/pms/hr/kra-sheet/${empBId}/kras`, token, {
    method: 'PUT', body: JSON.stringify({ kras: [{ title: 'Close 5 deals', weight: 100 }] }),
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.weights.ok, true);

  const submit = await api(`/pms/hr/kra-sheet/${empBId}/submit`, token, { method: 'POST' });
  assert.equal(submit.status, 200);

  const overview = await api('/pms/kra/org-overview', token);
  const empB = overview.body.employees.find((e) => e.employee_id === empBId);
  assert.equal(empB.status, 'submitted', 'org-overview reflects the on-behalf entry immediately');
});

test('enter-on-behalf: a plain manager cannot use the HR-only routes', { skip }, async () => {
  const { token } = await login('ko-mgr@x.com');
  const r = await api(`/pms/hr/kra-sheet/${empAId}`, token);
  assert.equal(r.status, 403);
});
