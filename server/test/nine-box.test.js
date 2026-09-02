// node --test — 9-Box grid aggregation (BR-6.4). Real Postgres, real HTTP
// surface, same convention as pip.test.js/super50.test.js: skips cleanly
// without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, cycleId;
const empIds = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-9box';
  process.env.TENANT_SLUG = 'ninebox-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, department, status) VALUES ($1,'9B Mgr','9b-mgr@x.com','Engineering','active') RETURNING id`, [t.id])).rows[0];
  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'9B HR','9b-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const hod = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'9B HOD','9b-hod@x.com','active') RETURNING id`, [t.id])).rows[0];
  const empA = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status) VALUES ($1,'9B Emp A','9b-empA@x.com','Engineering',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  const empB = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status) VALUES ($1,'9B Emp B','9b-empB@x.com','Sales',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  empIds.mgr = mgr.id; empIds.empA = empA.id; empIds.empB = empB.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'9b-hr@x.com','hr'),($1,'9b-hod@x.com','hod'),($1,'9b-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['9b-hr@x.com', '9b-hod@x.com', '9b-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'9Box Cycle','FY9B','annual','calibration') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  await db.query(
    `INSERT INTO pms.top_talent (tenant_id, cycle_id, employee_id, potential_rating, nine_box_cell, noted_by) VALUES
       ($1,$2,$3,'high','high-high','9b-hr@x.com'),
       ($1,$2,$4,'low','low-mid','9b-hr@x.com')`,
    [t.id, cycleId, empA.id, empB.id]);

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
async function api(path, token) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
}

test('9-Box: org level aggregates everyone into one group', { skip }, async () => {
  const { token } = await login('9b-hr@x.com');
  const r = await api('/pms/nine-box?level=org', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.groups.length, 1);
  assert.equal(r.body.groups[0].key, 'Organisation');
  assert.equal(r.body.groups[0].total, 2);
  assert.equal(r.body.groups[0].cells['high-high'][0].name, '9B Emp A');
  assert.equal(r.body.groups[0].cells['low-mid'][0].name, '9B Emp B');
});

test('9-Box: department level splits Engineering vs Sales', { skip }, async () => {
  const { token } = await login('9b-hr@x.com');
  const r = await api('/pms/nine-box?level=department', token);
  const byKey = Object.fromEntries(r.body.groups.map(g => [g.key, g]));
  assert.equal(byKey.Engineering.total, 1);
  assert.equal(byKey.Sales.total, 1);
});

test('9-Box: reporting-line (manager) level groups both under the shared manager', { skip }, async () => {
  const { token } = await login('9b-hr@x.com');
  const r = await api('/pms/nine-box?level=manager', token);
  assert.equal(r.body.groups.length, 1);
  assert.equal(r.body.groups[0].key, '9B Mgr');
  assert.equal(r.body.groups[0].total, 2);
});

test('9-Box: HOD can view, per BR-6.4; a plain manager cannot', { skip }, async () => {
  const hod = await login('9b-hod@x.com');
  const mgr = await login('9b-mgr@x.com');
  const rHod = await api('/pms/nine-box', hod.token);
  assert.equal(rHod.status, 200);
  const rMgr = await api('/pms/nine-box', mgr.token);
  assert.equal(rMgr.status, 403);
});

test('9-Box: an invalid level falls back to org rather than erroring', { skip }, async () => {
  const { token } = await login('9b-hr@x.com');
  const r = await api('/pms/nine-box?level=bogus', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.level, 'org');
});
