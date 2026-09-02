// node --test — one-time admin bootstrap (core/setup.js). This route is
// deliberately unauthenticated (nothing to authenticate against on a
// fresh tenant), so its entire safety model rests on the "zero employees"
// gate — these tests exist specifically to prove that gate actually
// holds, including under concurrent requests. Real Postgres, real HTTP
// surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-setup';
  db = require('../core/db');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, ['setup-test-' + Date.now()])).rows[0];
  tenantId = t.id;

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/setup', require('../core/setup').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

async function api(path, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('bootstrap: status reports available on a fresh tenant with zero employees', { skip }, async () => {
  const r = await api('/setup/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.bootstrap_available, true);
});

test('bootstrap: rejects a missing name, invalid email, and a short password', { skip }, async () => {
  const noName = await api('/setup/bootstrap-admin', { method: 'POST', body: JSON.stringify({ email: 'a@x.com', password: 'longenough1' }) });
  assert.equal(noName.status, 400);

  const badEmail = await api('/setup/bootstrap-admin', { method: 'POST', body: JSON.stringify({ name: 'A', email: 'not-an-email', password: 'longenough1' }) });
  assert.equal(badEmail.status, 400);

  const shortPass = await api('/setup/bootstrap-admin', { method: 'POST', body: JSON.stringify({ name: 'A', email: 'a@x.com', password: 'short' }) });
  assert.equal(shortPass.status, 400);
});

test('bootstrap: creates an admin who can immediately log in with the password they chose', { skip }, async () => {
  const create = await api('/setup/bootstrap-admin', {
    method: 'POST', body: JSON.stringify({ name: 'First Admin', email: 'first-admin@x.com', password: 'correct-horse-battery' }),
  });
  assert.equal(create.status, 200);
  assert.equal(create.body.ok, true);
  assert.ok(!JSON.stringify(create.body).includes('correct-horse-battery'), 'the chosen password is never echoed back');

  process.env.AUTH_DEV = 'true';
  const login = await api('/auth/dev-login', { method: 'POST', body: JSON.stringify({ email: 'first-admin@x.com', password: 'correct-horse-battery' }) });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'admin');
});

test('bootstrap: permanently locks itself out the moment one employee exists — even a different email', { skip }, async () => {
  const status = await api('/setup/status');
  assert.equal(status.body.bootstrap_available, false, 'locked out after the previous test created an employee');

  const second = await api('/setup/bootstrap-admin', {
    method: 'POST', body: JSON.stringify({ name: 'Second Admin', email: 'second-admin@x.com', password: 'another-long-password' }),
  });
  assert.equal(second.status, 403);

  const stillJustOne = await db.query(`SELECT COUNT(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId]);
  assert.equal(stillJustOne.rows[0].n, 1, 'the locked-out attempt created no rows at all');
});

test('bootstrap: concurrent bootstrap attempts on a fresh tenant only ever produce ONE admin, never two', { skip }, async () => {
  const t2 = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, ['setup-race-test-' + Date.now()])).rows[0];
  const express = require('express');
  const app2 = express();
  app2.use(express.json());
  app2.use((req, _res, next) => { req.tenantId = t2.id; next(); });
  app2.use('/api/v1/setup', require('../core/setup').router);
  const server2 = app2.listen(0);
  const base2 = `http://localhost:${server2.address().port}/api/v1`;

  const attempt = (email) => fetch(`${base2}/setup/bootstrap-admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Racer', email, password: 'racing-password-1' }),
  }).then((r) => r.status);

  const results = await Promise.all([
    attempt('racer-a@x.com'), attempt('racer-b@x.com'), attempt('racer-c@x.com'),
  ]);
  const succeeded = results.filter((s) => s === 200).length;
  assert.equal(succeeded, 1, 'exactly one of the simultaneous attempts won, the rest correctly rejected — the advisory lock held');

  const finalCount = await db.query(`SELECT COUNT(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [t2.id]);
  assert.equal(finalCount.rows[0].n, 1);

  server2.close();
});
