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


// ---- bulk delete, added 25 Sep --------------------------------------
//
// "as per attached screenshot there is not delete option for deleting
// multiple files." The page had a bin on every row and no way to clear
// a draft you did not want, which after publishing a suggested matrix
// is one click per row.
const del = (token, body) => api('/people/career/transitions', token,
  { method: 'DELETE', body: JSON.stringify(body) });
const list = async (token, qs = '') => (await api(`/people/career/transitions${qs}`, token)).body.transitions;

test('a selection of transitions can be deleted in one go', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  for (const [from, to] of [['Bulk A', 'Bulk A2'], ['Bulk B', 'Bulk B2'], ['Bulk C', 'Bulk C2']]) {
    await api('/people/career/transitions', token,
      { method: 'POST', body: JSON.stringify({ department: 'Bulk', from_role: from, to_role: to }) });
  }
  const before = await list(token);
  const ids = before.filter((t) => t.department === 'Bulk').slice(0, 2).map((t) => t.id);
  assert.equal(ids.length, 2);

  const r = await del(token, { ids });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 2);
  const after = await list(token);
  assert.equal(after.length, before.length - 2);
  assert.equal(after.filter((t) => t.department === 'Bulk').length, 1, 'only the ticked ones went');
});

test('an empty selection is refused, not treated as "everything"', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  const before = (await list(token)).length;
  const r = await del(token, { ids: [] });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /No transitions were selected/);
  assert.equal((await list(token)).length, before);
});

test('only an admin may delete in bulk', { skip }, async () => {
  const stranger = await login('ct-stranger@x.com');
  const r = await del(stranger.token, { ids: ['00000000-0000-0000-0000-000000000000'] });
  assert.equal(r.status, 403);
});

test('clearing the matrix needs the count the page was showing', { skip }, async () => {
  const { token } = await login('ct-admin@x.com');
  const before = (await list(token, '?show_inactive=true')).length;
  assert.ok(before > 0, 'there is something to clear');

  const wrong = await del(token, { confirm_count: before + 5 });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /changed since the page loaded/);
  assert.equal((await list(token, '?show_inactive=true')).length, before, 'a refused clear deletes nothing');

  const ok = await del(token, { confirm_count: before });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cleared, true);
  assert.equal(ok.body.removed, before);
  assert.equal((await list(token, '?show_inactive=true')).length, 0);

  // ...and clearing an empty matrix says so rather than reporting a
  // cheerful "removed 0".
  const again = await del(token, { confirm_count: 0 });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already empty/);
});

test('a bulk delete is audited', { skip }, async () => {
  const rows = (await db.query(
    `SELECT action FROM core.audit_log
      WHERE tenant_id=$1 AND action IN ('CAREER_TRANSITIONS_DELETED','CAREER_MATRIX_EMPTIED') ORDER BY id`,
    [tenantId])).rows.map((r) => r.action);
  assert.ok(rows.includes('CAREER_TRANSITIONS_DELETED'), 'the selection delete');
  assert.ok(rows.includes('CAREER_MATRIX_EMPTIED'), 'and the clear');
});

test('the list reports what a suggested draft would be built from', { skip }, async () => {
  // Asked for on 25 Sep: "if we update employee list in PMS, then
  // suggested matrix should also be updated as per new designations."
  // It always was — the draft is generated per download, never stored —
  // and now the page can say so out loud.
  const { token } = await login('ct-admin@x.com');
  const r = await api('/people/career/transitions', token);
  assert.ok(r.body.master, 'the response carries the master summary');
  assert.equal(typeof r.body.master.employees, 'number');
  assert.equal(typeof r.body.master.departments, 'number');
  assert.equal(typeof r.body.master.designations, 'number');
  assert.ok(r.body.master.employees > 0, 'and it counts the real master, not zero');
});
