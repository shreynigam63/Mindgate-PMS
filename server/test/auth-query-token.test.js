// node --test — authenticate() accepting ?token= as a fallback for plain
// <a href> download links (evidence/closure-letter PDFs), which can't
// attach an Authorization header. The header path must still work
// identically, and no token at all must still 401.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, token;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-qtoken';
  process.env.TENANT_SLUG = 'qtoken-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { authenticate, devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'QT Emp','qt-emp@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'qt-emp@x.com',$2)`, [t.id, await bcrypt.hash('pass', 10)]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.get('/api/v1/whoami', authenticate, (req, res) => res.json({ user: req.user }));
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;

  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'qt-emp@x.com', password: 'pass' }) });
  token = (await r.json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('authenticate: Authorization header still works exactly as before', { skip }, async () => {
  const r = await fetch(`${base}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
});

test('authenticate: ?token= query param works as a fallback for plain download links', { skip }, async () => {
  const r = await fetch(`${base}/whoami?token=${token}`);
  assert.equal(r.status, 200);
});

test('authenticate: no token at all still 401s', { skip }, async () => {
  const r = await fetch(`${base}/whoami`);
  assert.equal(r.status, 401);
});

test('authenticate: a bogus query token is rejected, not silently ignored', { skip }, async () => {
  const r = await fetch(`${base}/whoami?token=not-a-real-token`);
  assert.equal(r.status, 401);
});
