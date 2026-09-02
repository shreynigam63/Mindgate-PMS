// node --test — Quarterly Connect reminder orchestration (BR-4.4), the
// DB-touching half of connect-reminders.js's pure timing logic. Real
// Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, empOverdueId, empRecentId, empNeverId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-remind';
  process.env.TENANT_SLUG = 'remind-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'RM HR','rm-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'RM Mgr','rm-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const overdue = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, manager_id, status) VALUES ($1,'RM Overdue','rm-overdue@x.com',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  const recent = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, manager_id, status) VALUES ($1,'RM Recent','rm-recent@x.com',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  const never = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, manager_id, status) VALUES ($1,'RM Never','rm-never@x.com',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  empOverdueId = overdue.id; empRecentId = recent.id; empNeverId = never.id;
  const hash = await bcrypt.hash('pass', 10);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'rm-hr@x.com','hr')`, [t.id]);
  for (const email of ['rm-hr@x.com', 'rm-mgr@x.com', 'rm-overdue@x.com', 'rm-recent@x.com', 'rm-never@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  // Overdue: last connect 200 days ago (cadence is 90). Recent: 10 days
  // ago (not due). Never: no connect rows at all (always due).
  await db.query(`INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at) VALUES ($1,$2,$3, now() - interval '200 days')`, [t.id, mgr.id, overdue.id]);
  await db.query(`INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at) VALUES ($1,$2,$3, now() - interval '10 days')`, [t.id, mgr.id, recent.id]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/notifications', require('../core/notifications').router);
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

test('connect reminders: only overdue/never-held employees are reminded, not the recent one', { skip }, async () => {
  const { token } = await login('rm-hr@x.com');
  const r = await api('/pms/connects/check-reminders', token, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reminded, 2, 'overdue + never = 2; recent is excluded');

  const overdueEmpAuth = await login('rm-overdue@x.com');
  const overdueNotifs = await api('/notifications', overdueEmpAuth.token);
  assert.ok(overdueNotifs.body.notifications.some((n) => n.kind === 'connect_due'));

  const recentEmpAuth = await login('rm-recent@x.com');
  const recentNotifs = await api('/notifications', recentEmpAuth.token);
  assert.ok(!recentNotifs.body.notifications.some((n) => n.kind === 'connect_due'), 'recent connect should not trigger a reminder');
});

test('connect reminders: running it again immediately does not double-remind (cooldown)', { skip }, async () => {
  const { token } = await login('rm-hr@x.com');
  const r = await api('/pms/connects/check-reminders', token, { method: 'POST' });
  assert.equal(r.body.reminded, 0, 'cooldown blocks an immediate repeat for everyone just reminded');
});

test('connect reminders: manager also gets notified, not just the employee', { skip }, async () => {
  const mgrAuth = await login('rm-mgr@x.com');
  const mgrNotifs = await api('/notifications', mgrAuth.token);
  const connectDue = mgrNotifs.body.notifications.filter((n) => n.kind === 'connect_due');
  assert.equal(connectDue.length, 2, 'one per overdue/never-held report');
});
