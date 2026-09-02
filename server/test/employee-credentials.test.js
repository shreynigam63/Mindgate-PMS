// node --test — HR-provisioned login credentials + role assignment
// (core/employees.js). Found genuinely missing: beyond the one-time
// bootstrap-admin (core/setup.js), there was no way for HR to give any
// other employee a real login. Real Postgres, real HTTP surface, skips
// cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, mgrId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-credentials';
  process.env.TENANT_SLUG = 'creds-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Creds HR','creds-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Creds Emp','creds-emp@x.com','active') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Creds Stranger','creds-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'creds-hr@x.com','hr'),($1,'creds-stranger@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['creds-hr@x.com', 'creds-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

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

test('employee list reflects has_login=false and role=employee before any provisioning', { skip }, async () => {
  const { token } = await login('creds-hr@x.com');
  const r = await api('/employees', token);
  const row = r.body.employees.find((e) => e.id === empId);
  assert.equal(row.has_login, false);
  assert.equal(row.role, 'employee');
});

test('GET /employees is 403 for a non-HR user even though authenticated — API-layer control, not just UI hiding', { skip }, async () => {
  // Regression guard: this endpoint used to be reachable by any logged-in
  // user, meaning a manager or plain employee could hit the API directly
  // (curl, browser devtools) and dump the whole company employee list,
  // even while the "Employees" nav item was hidden from them in the UI.
  // The test proves the API itself now refuses.
  const empAuth = await login('creds-hr@x.com');
  // Give the plain employee a real password so they can actually log in
  // and get a token to prove the endpoint refuses them AS AN AUTHENTICATED
  // USER — not just because they weren't signed in.
  await api(`/employees/${empId}/credentials`, empAuth.token, { method: 'POST', body: JSON.stringify({ password: 'employee-password-1' }) });
  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'creds-emp@x.com', password: 'employee-password-1' }) });
  const { token: empToken, user } = await r.json();
  assert.equal(user.role, 'employee', 'sanity check: the token really is for a plain employee');

  const listAttempt = await api('/employees', empToken);
  assert.equal(listAttempt.status, 403, 'plain employee gets 403, not the whole employee list');
  assert.ok(/people_admin/.test(listAttempt.body.error), 'error message names the permission missing, not a generic denial');
});

test('HR can set a password for an employee, who can then log in with it', { skip }, async () => {
  const hrAuth = await login('creds-hr@x.com');
  const set = await api(`/employees/${empId}/credentials`, hrAuth.token, { method: 'POST', body: JSON.stringify({ password: 'a-real-password1' }) });
  assert.equal(set.status, 200);

  const empLogin = await login('creds-emp@x.com');
  // login() posts with the fixed 'pass' password above for other seeded
  // users, so build the real request directly here with the actual one just set.
  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'creds-emp@x.com', password: 'a-real-password1' }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.user.role, 'employee');

  const list = await api('/employees', hrAuth.token);
  const row = list.body.employees.find((e) => e.id === empId);
  assert.equal(row.has_login, true);
});

test('HR can assign and clear a role; a non-HR employee cannot', { skip }, async () => {
  const hrAuth = await login('creds-hr@x.com');
  // creds-emp@x.com's password was changed in the previous test — login()'s
  // hardcoded 'pass' would no longer work for this user specifically.
  const empLoginR = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'creds-emp@x.com', password: 'a-real-password1' }) });
  const empAuth = await empLoginR.json();

  const setManager = await api(`/employees/${empId}/role`, hrAuth.token, { method: 'PUT', body: JSON.stringify({ role: 'manager' }) });
  assert.equal(setManager.status, 200);
  let list = await api('/employees', hrAuth.token);
  assert.equal(list.body.employees.find((e) => e.id === empId).role, 'manager');

  const clear = await api(`/employees/${empId}/role`, hrAuth.token, { method: 'PUT', body: JSON.stringify({ role: 'employee' }) });
  assert.equal(clear.status, 200);
  list = await api('/employees', hrAuth.token);
  assert.equal(list.body.employees.find((e) => e.id === empId).role, 'employee');

  const bad = await api(`/employees/${empId}/role`, hrAuth.token, { method: 'PUT', body: JSON.stringify({ role: 'superadmin' }) });
  assert.equal(bad.status, 400);

  const blocked = await api(`/employees/${empId}/role`, empAuth.token, { method: 'PUT', body: JSON.stringify({ role: 'admin' }) });
  assert.equal(blocked.status, 403);
});

test('setting credentials rejects a short password and an unknown employee', { skip }, async () => {
  const { token } = await login('creds-hr@x.com');
  const short = await api(`/employees/${empId}/credentials`, token, { method: 'POST', body: JSON.stringify({ password: 'short' }) });
  assert.equal(short.status, 400);
  const unknown = await api(`/employees/00000000-0000-0000-0000-000000000000/credentials`, token, { method: 'POST', body: JSON.stringify({ password: 'longenoughpass' }) });
  assert.equal(unknown.status, 404);
});
