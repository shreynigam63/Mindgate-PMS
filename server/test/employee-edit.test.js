// node --test — single-employee profile edit (core/employees.js). Found
// missing during a live conversation: re-uploading an entire spreadsheet
// just to fix one person's designation was clunky. Real Postgres, real
// HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, mgrAId, mgrBId, openCycleId, closedCycleId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-editemp';
  process.env.TENANT_SLUG = 'editemp-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Edit HR','edit-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgrA = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Edit Mgr A','edit-mgrA@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgrB = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Edit Mgr B','edit-mgrB@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, designation, manager_id, status) VALUES ($1,'Edit Emp','edit-emp@x.com','Junior Analyst',$2,'active') RETURNING id`, [t.id, mgrA.id])).rows[0];
  empId = emp.id; mgrAId = mgrA.id; mgrBId = mgrB.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'edit-hr@x.com','hr'),($1,'edit-mgrA@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['edit-hr@x.com', 'edit-mgrA@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const openCycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Edit Open Cycle','FYEO','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  const closedCycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Edit Closed Cycle','FYEC','annual','closed') RETURNING id`, [t.id])).rows[0];
  openCycleId = openCycle.id; closedCycleId = closedCycle.id;
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`, [t.id, openCycle.id, emp.id, mgrA.id]);
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`, [t.id, closedCycle.id, emp.id, mgrA.id]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
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

test('HR can edit an employee\'s designation/department; a plain manager cannot', { skip }, async () => {
  const hrAuth = await login('edit-hr@x.com');
  const r = await api(`/employees/${empId}`, hrAuth.token, {
    method: 'PUT', body: JSON.stringify({ name: 'Edit Emp', department: 'Sales', designation: 'Senior Analyst', role_band: 'L4' }),
  });
  assert.equal(r.status, 200);
  const list = await api('/employees', hrAuth.token);
  const row = list.body.employees.find((e) => e.id === empId);
  assert.equal(row.designation, 'Senior Analyst');
  assert.equal(row.department, 'Sales');
  assert.equal(row.role_band, 'L4');

  const mgrAuth = await login('edit-mgrA@x.com');
  const blocked = await api(`/employees/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ name: 'x' }) });
  assert.equal(blocked.status, 403);
});

test('name is required; an unresolvable manager email and self-management are both rejected', { skip }, async () => {
  const { token } = await login('edit-hr@x.com');
  const noName = await api(`/employees/${empId}`, token, { method: 'PUT', body: JSON.stringify({ name: '' }) });
  assert.equal(noName.status, 400);

  const unknownMgr = await api(`/employees/${empId}`, token, { method: 'PUT', body: JSON.stringify({ name: 'Edit Emp', manager_email: 'nobody@x.com' }) });
  assert.equal(unknownMgr.status, 422);

  const selfMgr = await api(`/employees/${empId}`, token, { method: 'PUT', body: JSON.stringify({ name: 'Edit Emp', manager_email: 'edit-emp@x.com' }) });
  assert.equal(selfMgr.status, 422);
});

test('changing manager_email propagates to the OPEN cycle\'s KRA sheet but not the CLOSED one', { skip }, async () => {
  const { token } = await login('edit-hr@x.com');
  const r = await api(`/employees/${empId}`, token, { method: 'PUT', body: JSON.stringify({ name: 'Edit Emp', manager_email: 'edit-mgrB@x.com' }) });
  assert.equal(r.status, 200);

  const openSheet = (await db.query(`SELECT manager_id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [openCycleId, empId])).rows[0];
  assert.equal(openSheet.manager_id, mgrBId, 'open-cycle KRA sheet follows the new manager');

  const closedSheet = (await db.query(`SELECT manager_id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [closedCycleId, empId])).rows[0];
  assert.equal(closedSheet.manager_id, mgrAId, 'closed-cycle KRA sheet keeps the ORIGINAL manager — audit history unchanged');

  const list = await api('/employees', token);
  const row = list.body.employees.find((e) => e.id === empId);
  assert.equal(row.manager_email, 'edit-mgrB@x.com');
});

test('clearing manager_email (blank) removes the manager entirely', { skip }, async () => {
  const { token } = await login('edit-hr@x.com');
  await api(`/employees/${empId}`, token, { method: 'PUT', body: JSON.stringify({ name: 'Edit Emp', manager_email: '' }) });
  const list = await api('/employees', token);
  const row = list.body.employees.find((e) => e.id === empId);
  assert.equal(row.manager_email, null);
});

test('email is not accepted by this route at all — cannot be changed here', { skip }, async () => {
  const { token } = await login('edit-hr@x.com');
  await api(`/employees/${empId}`, token, { method: 'PUT', body: JSON.stringify({ name: 'Edit Emp', email: 'changed@x.com' }) });
  const list = await api('/employees', token);
  const row = list.body.employees.find((e) => e.id === empId);
  assert.equal(row.email, 'edit-emp@x.com', 'email silently ignored, not changed — by design');
});
