// node --test — Department Heads assignment (core.department_heads).
// Reported live: setting an employee's role to "hod" grants access to
// the Delivery Head Review screen, but their queue stayed permanently
// empty — GET /hod/queue scopes visibility by core.department_heads,
// a completely separate table nothing in this app had a way to write
// to. This covers the new admin endpoints that fix that, and proves
// the fix end to end against the real /hod/queue query. Real Postgres,
// real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hodId, empId, cycleId, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-dh';
  process.env.TENANT_SLUG = 'dh-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department) VALUES ($1,'DH Mgr','dh-mgr@x.com','active','Engineering') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id, department) VALUES ($1,'DH Emp','dh-emp@x.com','active',$2,'Engineering') RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const hod = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department) VALUES ($1,'Shrey Nigam','dh-hod@x.com','active','Engineering') RETURNING id`, [t.id])).rows[0];
  hodId = hod.id;
  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'DH Admin','dh-admin@x.com','active') RETURNING id`, [t.id])).rows[0];

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'dh-mgr@x.com','manager')`, [t.id]);
  // The reported scenario exactly: role set to "hod", nothing more.
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'dh-hod@x.com','hod')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'dh-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['dh-mgr@x.com', 'dh-hod@x.com', 'dh-admin@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'DH Cycle','FYDH','midyear','hod_eval') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  await db.query(`INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, overall_rating, status) VALUES ($1,$2,$3,$4,4,'submitted')`, [t.id, cycleId, empId, mgr.id]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
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

// The exact bug: role alone is not enough.
test('reproduces the reported bug: "hod" role alone leaves the queue empty', { skip }, async () => {
  const { token } = await login('dh-hod@x.com');
  const r = await api('/pms/hod/queue', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.queue.length, 0, 'role alone does not scope them to any department yet');
});

test('GET /employees/department-heads lists departments with no head assigned yet', { skip }, async () => {
  const { token } = await login('dh-admin@x.com');
  const r = await api('/employees/department-heads', token);
  assert.equal(r.status, 200);
  const eng = r.body.departments.find((d) => d.department === 'Engineering');
  assert.ok(eng);
  assert.equal(eng.head, null);
});

test('assigning a department head is the fix: the queue now shows correctly', { skip }, async () => {
  const adminAuth = await login('dh-admin@x.com');
  const put = await api(`/employees/department-heads/${encodeURIComponent('Engineering')}`, adminAuth.token, {
    method: 'PUT', body: JSON.stringify({ employee_id: hodId }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.head.name, 'Shrey Nigam');

  const hodAuth = await login('dh-hod@x.com');
  const queue = await api('/pms/hod/queue', hodAuth.token);
  assert.equal(queue.body.queue.length, 1, 'now correctly scoped to Engineering, where the submitted evaluation is');
  assert.equal(queue.body.queue[0].name, 'DH Emp');
});

test('requires people_admin, and clearing (employee_id: null) removes the assignment', { skip }, async () => {
  const mgrAuth = await login('dh-mgr@x.com');
  const blocked = await api(`/employees/department-heads/${encodeURIComponent('Engineering')}`, mgrAuth.token, {
    method: 'PUT', body: JSON.stringify({ employee_id: hodId }),
  });
  assert.equal(blocked.status, 403);

  const adminAuth = await login('dh-admin@x.com');
  const clear = await api(`/employees/department-heads/${encodeURIComponent('Engineering')}`, adminAuth.token, {
    method: 'PUT', body: JSON.stringify({ employee_id: null }),
  });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.head, null);

  const hodAuth = await login('dh-hod@x.com');
  const queue = await api('/pms/hod/queue', hodAuth.token);
  assert.equal(queue.body.queue.length, 0, 'back to empty once the assignment is cleared');
});
