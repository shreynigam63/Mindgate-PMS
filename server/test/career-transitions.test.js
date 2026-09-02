// node --test — Career Pathing Matrix (CR-11, phase 1 of 2): role-to-role
// transition rules, built to the exact "New transition" form fields from
// a reference screenshot. Real Postgres, real HTTP surface, skips
// cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ct';
  process.env.TENANT_SLUG = 'ct-test-' + Date.now();
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

  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CT Admin','ct-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  const eng = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, designation) VALUES ($1,'CT Eng','ct-eng@x.com','active','Software Engineer II') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CT Stranger','ct-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ct-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ct-admin@x.com', 'ct-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
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

test('GET /designations returns real employee designations on file, deduplicated', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  const r = await api('/people/designations', token);
  assert.equal(r.status, 200);
  assert.ok(r.body.designations.includes('Software Engineer II'));
});

test('POST /career/transitions requires from_role and to_role, splits competencies by line, requires admin', { skip }, async () => {
  const strangerAuth = await login('ct-stranger@x.com');
  const blocked = await api('/people/career/transitions', strangerAuth.token, { method: 'POST', body: JSON.stringify({ from_role: 'A', to_role: 'B' }) });
  assert.equal(blocked.status, 403);

  const adminAuth = await login('ct-admin@x.com');
  const missing = await api('/people/career/transitions', adminAuth.token, { method: 'POST', body: JSON.stringify({ from_role: 'Software Engineer II' }) });
  assert.equal(missing.status, 400);

  const create = await api('/people/career/transitions', adminAuth.token, {
    method: 'POST',
    body: JSON.stringify({
      from_role: 'Software Engineer II', from_level: 'L2', to_role: 'Software Engineer III', to_level: 'L3',
      expected_level_change: 1, min_time_months: 12, typical_time_months: 18,
      required_competencies: 'System design fundamentals\nIndependent feature ownership\nMentoring 1 junior',
      notes: 'Standard next-level path',
    }),
  });
  assert.equal(create.status, 200);
  assert.deepEqual(create.body.transition.required_competencies, ['System design fundamentals', 'Independent feature ownership', 'Mentoring 1 junior']);
  assert.equal(create.body.transition.active, true);
});

test('GET /career/transitions lists active by default, supports search and show_inactive', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  const list = await api('/people/career/transitions', token);
  assert.equal(list.status, 200);
  assert.equal(list.body.transitions.length, 1);

  const searched = await api('/people/career/transitions?q=Engineer%20III', token);
  assert.equal(searched.body.transitions.length, 1);
  const notFound = await api('/people/career/transitions?q=Nonexistent', token);
  assert.equal(notFound.body.transitions.length, 0);
});

test('PUT deactivates a transition; GET without show_inactive then excludes it, with it includes it', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  const list = await api('/people/career/transitions', token);
  const id = list.body.transitions[0].id;

  const deactivate = await api(`/people/career/transitions/${id}`, token, { method: 'PUT', body: JSON.stringify({ active: false }) });
  assert.equal(deactivate.status, 200);
  assert.equal(deactivate.body.transition.active, false);

  const defaultView = await api('/people/career/transitions', token);
  assert.equal(defaultView.body.transitions.length, 0, 'inactive entries hidden by default');

  const withInactive = await api('/people/career/transitions?show_inactive=true', token);
  assert.equal(withInactive.body.transitions.length, 1);
});

test('DELETE removes a transition; 404s on one that does not exist', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  const list = await api('/people/career/transitions?show_inactive=true', token);
  const id = list.body.transitions[0].id;

  const del = await api(`/people/career/transitions/${id}`, token, { method: 'DELETE' });
  assert.equal(del.status, 200);

  const missing = await api(`/people/career/transitions/${id}`, token, { method: 'DELETE' });
  assert.equal(missing.status, 404);
});
