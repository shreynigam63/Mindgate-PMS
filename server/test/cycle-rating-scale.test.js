// node --test — PUT /cycles/:id/rating-scale. Added alongside narrowing
// the default rating scale from 6 grades (A+..D) to 5 (A+..C) — without
// this, a cycle already created under the old default would be stuck on
// it forever, since narrowing only a DEFAULT has no effect on cycles
// that already exist. Real Postgres, real HTTP surface, skips cleanly
// without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, cycleId, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-crs';
  process.env.TENANT_SLUG = 'crs-test-' + Date.now();
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

  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CRS Admin','crs-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CRS Stranger','crs-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'crs-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['crs-admin@x.com', 'crs-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const oldScale = JSON.stringify([{ value: 6, label: 'A+' }, { value: 5, label: 'A' }, { value: 4, label: 'B+' }, { value: 3, label: 'B' }, { value: 2, label: 'C' }, { value: 1, label: 'D' }]);
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, rating_scale) VALUES ($1,'CRS Cycle','FYCRS','annual','kra_open',$2) RETURNING id`,
    [t.id, oldScale])).rows[0];
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

test('an existing cycle can be updated from the old 6-grade scale to the new 5-grade one', { skip }, async () => {
  const { token } = await login('crs-admin@x.com');
  const before5 = await api('/pms/cycles', token);
  const c = before5.body.cycles.find((x) => x.id === cycleId);
  assert.equal(c.rating_scale.length, 6, 'starts on the old 6-grade scale');

  const put = await api(`/pms/cycles/${cycleId}/rating-scale`, token, {
    method: 'PUT',
    body: JSON.stringify({
      rating_scale: [{ value: 5, label: 'A+' }, { value: 4, label: 'A' }, { value: 3, label: 'B+' }, { value: 2, label: 'B' }, { value: 1, label: 'C' }],
      bell_curve: { '5': 5, '4': 15, '3': 35, '2': 30, '1': 15 },
    }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.cycle.rating_scale.length, 5);
  assert.deepEqual(put.body.cycle.rating_scale.map((s) => s.label), ['A+', 'A', 'B+', 'B', 'C']);
});

test('requires pms_admin, and rejects a malformed rating_scale', { skip }, async () => {
  const strangerAuth = await login('crs-stranger@x.com');
  const blocked = await api(`/pms/cycles/${cycleId}/rating-scale`, strangerAuth.token, {
    method: 'PUT', body: JSON.stringify({ rating_scale: [{ value: 5, label: 'A+' }] }),
  });
  assert.equal(blocked.status, 403);

  const adminAuth = await login('crs-admin@x.com');
  const malformed = await api(`/pms/cycles/${cycleId}/rating-scale`, adminAuth.token, {
    method: 'PUT', body: JSON.stringify({ rating_scale: [{ value: 'five', label: 'A+' }] }),
  });
  assert.equal(malformed.status, 422);
});
