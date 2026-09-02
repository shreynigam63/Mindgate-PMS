// node --test — Evidence upload (BRD Phase-4 item). pms.evidence existed
// since migration 003 with nothing writing to it. Real Postgres, real
// HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, mgrId, strangerId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-evidence';
  process.env.TENANT_SLUG = 'evidence-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Ev Mgr','ev-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'Ev Emp','ev-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Ev Stranger','ev-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id; mgrId = mgr.id; strangerId = stranger.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ev-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ev-mgr@x.com', 'ev-emp@x.com', 'ev-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }
  await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Ev Cycle','FYEV','annual','self_appraisal')`, [t.id]);

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
async function apiJson(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
async function upload(path, token, filename, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: r.status, body: await r.json() };
}

test('evidence: employee uploads, appears in their list, manager can download, unrelated employee cannot', { skip }, async () => {
  const empAuth = await login('ev-emp@x.com');
  const mgrAuth = await login('ev-mgr@x.com');
  const strangerAuth = await login('ev-stranger@x.com');

  await apiJson('/pms/my/self-appraisal', empAuth.token); // ensure appraisal row exists
  const up = await upload('/pms/my/self-appraisal/evidence', empAuth.token, 'proof.txt', 'evidence content here');
  assert.equal(up.status, 200);
  assert.equal(up.body.evidence.filename, 'proof.txt');

  const list = await apiJson('/pms/my/self-appraisal/evidence', empAuth.token);
  assert.equal(list.body.evidence.length, 1);
  const evId = list.body.evidence[0].id;

  const dl = await fetch(`${base}/pms/evidence/${evId}/download`, { headers: { Authorization: `Bearer ${mgrAuth.token}` } });
  assert.equal(dl.status, 200);
  const text = await dl.text();
  assert.equal(text, 'evidence content here');

  const blocked = await fetch(`${base}/pms/evidence/${evId}/download`, { headers: { Authorization: `Bearer ${strangerAuth.token}` } });
  assert.equal(blocked.status, 403);
});

test('evidence: employee can delete their own evidence before submission', { skip }, async () => {
  const empAuth = await login('ev-emp@x.com');
  const list = await apiJson('/pms/my/self-appraisal/evidence', empAuth.token);
  const evId = list.body.evidence[0].id;
  const del = await apiJson(`/pms/my/self-appraisal/evidence/${evId}`, empAuth.token, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after1 = await apiJson('/pms/my/self-appraisal/evidence', empAuth.token);
  assert.equal(after1.body.evidence.length, 0);
});

test('evidence: rejects a file over the 10MB limit', { skip }, async () => {
  const empAuth = await login('ev-emp@x.com');
  const big = new Uint8Array(11 * 1024 * 1024);
  const up = await upload('/pms/my/self-appraisal/evidence', empAuth.token, 'huge.bin', big);
  assert.equal(up.status, 400);
});
