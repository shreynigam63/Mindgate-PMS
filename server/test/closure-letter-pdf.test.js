// node --test — Closure letter PDF generation, closing the "Phase 4
// template engine decision" deferral mentioned in modules/performance/
// index.js's own header comment. Real Postgres, real HTTP surface,
// skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, cycleId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-letter';
  process.env.TENANT_SLUG = 'letter-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Ltr HR','ltr-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, designation, status) VALUES ($1,'Ltr Emp','ltr-emp@x.com','Engineer','active') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Ltr Stranger','ltr-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ltr-hr@x.com','hr')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ltr-hr@x.com', 'ltr-emp@x.com', 'ltr-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Ltr Cycle','FYL','annual','publish') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  await db.query(`INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating, rating_label) VALUES ($1,$2,$3,4.5,'Exceeds')`, [t.id, emp.id, cycle.id]);
  await db.query(`INSERT INTO pms.closure_letters (tenant_id, cycle_id, employee_id) VALUES ($1,$2,$3)`, [t.id, cycle.id, emp.id]);

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
async function apiJson(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('closure letter: rejects incomplete body, generates a real PDF once complete, downloadable by owner and HR', { skip }, async () => {
  const hrAuth = await login('ltr-hr@x.com');
  const empAuth = await login('ltr-emp@x.com');
  const strangerAuth = await login('ltr-stranger@x.com');

  const incomplete = await apiJson(`/pms/closure-letters/${empId}/${cycleId}/generate`, hrAuth.token, { method: 'POST', body: JSON.stringify({ salutation: 'Dear Ltr Emp,' }) });
  assert.equal(incomplete.status, 400);

  const gen = await apiJson(`/pms/closure-letters/${empId}/${cycleId}/generate`, hrAuth.token, {
    method: 'POST',
    body: JSON.stringify({ salutation: 'Dear Ltr Emp,', body_paragraphs: ['Great year overall.', 'Thank you for your contributions.'], closing_line: 'Best regards,' }),
  });
  assert.equal(gen.status, 200);
  assert.ok(gen.body.bytes > 100, 'a real PDF was generated, not an empty stub');

  const dl = await fetch(`${base}/pms/closure-letters/${empId}/${cycleId}/download`, { headers: { Authorization: `Bearer ${empAuth.token}` } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString(), '%PDF', 'the downloaded bytes are actually a PDF, not just labelled as one');

  const blocked = await fetch(`${base}/pms/closure-letters/${empId}/${cycleId}/download`, { headers: { Authorization: `Bearer ${strangerAuth.token}` } });
  assert.equal(blocked.status, 403);

  const empNotifs = await apiJson('/notifications', empAuth.token);
  assert.ok(empNotifs.body.notifications.some((n) => n.kind === 'closure_letter_ready'));
});

test('closure letter: "me" in the URL resolves to the caller\'s own employee id', { skip }, async () => {
  const empAuth = await login('ltr-emp@x.com');
  const dl = await fetch(`${base}/pms/closure-letters/me/${cycleId}/download`, { headers: { Authorization: `Bearer ${empAuth.token}` } });
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.slice(0, 4).toString(), '%PDF');
});

test('closure letter: a plain manager without letters_admin/pms_admin cannot generate one', { skip }, async () => {
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const bcrypt = require('bcryptjs');
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Ltr Mgr','ltr-mgr@x.com','active') RETURNING id`, [t])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ltr-mgr@x.com','manager')`, [t]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'ltr-mgr@x.com',$2)`, [t, await bcrypt.hash('pass', 10)]);
  const mgrAuth = await login('ltr-mgr@x.com');
  const r = await apiJson(`/pms/closure-letters/${empId}/${cycleId}/generate`, mgrAuth.token, {
    method: 'POST', body: JSON.stringify({ salutation: 'x', body_paragraphs: ['y'], closing_line: 'z' }),
  });
  assert.equal(r.status, 403);
});
