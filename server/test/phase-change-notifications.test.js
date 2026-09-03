// node --test — role-wise notifications when HR advances, rolls back, or
// cancels a cycle's phase. Found missing entirely: the phase-change
// endpoint updated the phase and wrote an audit log entry, but never
// notified anyone — no one heard that KRA Setting, Self-Appraisal, etc.
// had opened for them. Scoped per a confirmed role mapping (only people
// with something to do in a phase get notified about it). Real Postgres,
// real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, hodId, adminId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pcn';
  process.env.TENANT_SLUG = 'pcn-test-' + Date.now();
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

  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PCN Admin','pcn-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  adminId = admin.id;
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department) VALUES ($1,'PCN Mgr','pcn-mgr@x.com','active','Engineering') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'PCN Emp','pcn-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const hod = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PCN Head','pcn-head@x.com','active') RETURNING id`, [t.id])).rows[0];
  hodId = hod.id;
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Engineering',$2)`, [t.id, hodId]);

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'pcn-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'pcn-admin@x.com',$2)`, [t.id, hash]);

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'PCN Cycle','FYPCN','annual','draft') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;

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
async function notificationsFor(employeeId) {
  return (await db.query(`SELECT title, body FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind='phase_change' ORDER BY created_at`, [tenantId, employeeId])).rows;
}

test('advancing to kra_open notifies every active employee, not managers/HOD only', { skip }, async () => {
  const { token } = await login('pcn-admin@x.com');
  const r = await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ to: 'kra_open' }) });
  assert.equal(r.status, 200);

  for (const id of [empId, mgrId, hodId]) {
    const notes = await notificationsFor(id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, 'KRA Setting is now open');
  }
});

test('advancing to manager_eval only notifies managers, not individual contributors or Delivery Heads', { skip }, async () => {
  const { token } = await login('pcn-admin@x.com');
  for (const to of ['growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval']) {
    await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ to }) });
  }
  const mgrNotes = await notificationsFor(mgrId);
  assert.ok(mgrNotes.some((n) => n.title === 'Team Evaluation is now open'), 'manager notified');

  const empNotes = await notificationsFor(empId);
  assert.ok(!empNotes.some((n) => n.title === 'Team Evaluation is now open'), 'individual contributor not notified about manager-only phase');
});

test('advancing to hod_eval notifies only Delivery Heads (via department_heads), not everyone', { skip }, async () => {
  const { token } = await login('pcn-admin@x.com');
  await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ to: 'hod_eval' }) });

  const hodNotes = await notificationsFor(hodId);
  assert.ok(hodNotes.some((n) => n.title === 'Delivery Head Review is now open'));

  const empNotes = await notificationsFor(empId);
  assert.ok(!empNotes.some((n) => n.title === 'Delivery Head Review is now open'), 'non-Delivery-Head not notified');
});

test('rolling back closes the phase being left, with a "no longer open" body, not a stale open-direction message', { skip }, async () => {
  const { token } = await login('pcn-admin@x.com');
  const before = await notificationsFor(hodId);
  const beforeCount = before.length;

  // The cycle is at hod_eval, so rolling BACK goes to manager_eval — the
  // step before it. This asked for 'calibration', which is the step
  // AFTER, so the phase machine correctly refused it (409) and no notice
  // was ever sent; the test then failed on the missing notification
  // rather than on the behaviour it was written to check.
  const rolled = await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ rollback: true, to: 'manager_eval' }) });
  assert.equal(rolled.status, 200, JSON.stringify(rolled.body));
  // Rolling back FROM hod_eval closes hod_eval's own audience (Delivery Heads).
  const after = await notificationsFor(hodId);
  assert.equal(after.length, beforeCount + 1);
  const closed = after[after.length - 1];
  assert.equal(closed.title, 'Delivery Head Review has closed');
  assert.equal(closed.body, 'This is no longer open.', 'not a stale "is now open" message from the open-direction text');
});

test('cancelling notifies everyone, regardless of which phase the cycle was in', { skip }, async () => {
  const { token } = await login('pcn-admin@x.com');
  await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ cancel: true }) });
  for (const id of [empId, mgrId, hodId]) {
    const notes = await notificationsFor(id);
    assert.ok(notes.some((n) => n.title === 'PCN Cycle has been cancelled'));
  }
});
