// node --test — the company's name and logo (16 Oct, Def-002): read by
// anyone (the sign-in page shows it), set by HR only, images only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-brand';
process.env.AUTH_DEV = 'true';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db, server, base, tenantId;

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin, authenticate } = require('../core/auth');
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('Brand Co',$1) RETURNING id`, [`brand-${Date.now()}`])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  const hash = await bcrypt.hash('pass', 4);
  for (const [k, role] of [['hr', 'hr'], ['emp', 'employee']]) {
    await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,$2,$3,'active')`, [tenantId, k, `${k}@brand.test`]);
    if (role !== 'employee') await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)`, [tenantId, `${k}@brand.test`, role]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [tenantId, `${k}@brand.test`, hash]);
  }
  const { getBrand, putBrand } = require('../core/brand');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.get('/api/v1/brand', getBrand);
  app.put('/api/v1/brand', authenticate, putBrand);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const tok = {};
async function call(who, method, body) {
  const h = { 'Content-Type': 'application/json' };
  if (who) {
    if (!tok[who]) tok[who] = (await (await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: h, body: JSON.stringify({ email: `${who}@brand.test`, password: 'pass' }) })).json()).token;
    h.Authorization = `Bearer ${tok[who]}`;
  }
  const r = await fetch(`${base}/brand`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const PNG = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

test('nothing shows until HR sets it; anyone can read it, before signing in', { skip }, async () => {
  assert.deepEqual((await call(null, 'GET')).body, { name: null, logo: null });
});

test('HR sets the name and logo; others cannot; only images, only small ones', { skip }, async () => {
  assert.equal((await call(null, 'PUT', { name: 'X' })).status, 401);
  assert.equal((await call('emp', 'PUT', { name: 'X' })).status, 403);
  assert.equal((await call('hr', 'PUT', { logo: 'data:text/html;base64,PGI+aGk8L2I+' })).status, 422, 'not an image');
  assert.equal((await call('hr', 'PUT', { logo: 'javascript:alert(1)' })).status, 422);
  const big = `data:image/png;base64,${Buffer.alloc(400 * 1024).toString('base64')}`;
  assert.equal((await call('hr', 'PUT', { logo: big })).status, 422, 'over 300 KB');
  let r = await call('hr', 'PUT', { name: '  Mindgate Solutions  ', logo: PNG });
  assert.equal(r.status, 200);
  assert.deepEqual((await call(null, 'GET')).body, { name: 'Mindgate Solutions', logo: PNG });
  r = await call('hr', 'PUT', { logo: null });
  assert.deepEqual((await call(null, 'GET')).body, { name: 'Mindgate Solutions', logo: null }, 'the logo removed, the name kept');
});
