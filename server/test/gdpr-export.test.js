// node --test — GDPR data export, Article 15 "right of access" (BRD
// §6 NFR). Real Postgres, real HTTP surface, skips cleanly without
// DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-gdpr';
  process.env.TENANT_SLUG = 'gdpr-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'GD HR','gd-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'GD Emp','gd-emp@x.com','active') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'GD Stranger','gd-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'gd-hr@x.com','hr')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['gd-hr@x.com', 'gd-emp@x.com', 'gd-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }
  await db.query(`INSERT INTO core.employee_consents (tenant_id, employee_id, consent_type, granted, granted_at, updated_by) VALUES ($1,$2,'meeting_ai_insights',true,now(),'gd-emp@x.com')`, [t.id, emp.id]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/gdpr', require('../core/gdpr').router);
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
async function api(path, token) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
}

test('gdpr export: self-service export includes profile and consent records', { skip }, async () => {
  const { token } = await login('gd-emp@x.com');
  const r = await api('/gdpr/export', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.name, 'GD Emp');
  assert.equal(r.body.consents.length, 1);
  assert.equal(r.body.consents[0].granted, true);
  assert.ok(Array.isArray(r.body.rating_history));
  assert.ok(r.body.exported_at);
});

test('gdpr export: HR can export on behalf of an employee; a plain employee cannot export someone else\'s data', { skip }, async () => {
  const hrAuth = await login('gd-hr@x.com');
  const strangerAuth = await login('gd-stranger@x.com');

  const asHr = await api(`/gdpr/export/${empId}`, hrAuth.token);
  assert.equal(asHr.status, 200);
  assert.equal(asHr.body.profile.name, 'GD Emp');

  const asStranger = await api(`/gdpr/export/${empId}`, strangerAuth.token);
  assert.equal(asStranger.status, 403);
});
