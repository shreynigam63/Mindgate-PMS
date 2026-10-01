// The connect form's questions, as data.
//
// Asked for: "Make the quarterly connect/discussion forms fully editable
// for HR admins to update questions." The wording lived in the page, so
// rewording a 1:1 form meant a release.
//
// The line this draws, and the reason it is worth a test: HR edits the
// QUESTION, not the storage. Each row points at a column that already
// exists on the connect record, and a question that wrote nowhere would
// collect answers and throw them away — which looks exactly like a
// working form.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'connect-q-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');

const SLUG = `cq-test-${Date.now()}`;
let server; let base; let tenantId; let hrTok; let mgrTok;

const api = async (tok, path, opts = {}) => {
  const r = await fetch(`${base}/api/v1/pms${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};

before(async () => {
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  for (const [n, e, role] of [['HR One', 'cq-hr@x.com', 'admin'], ['Mgr One', 'cq-mgr@x.com', 'manager']]) {
    await db.query(`INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,$2,$3,'active')`, [tenantId, n, e]);
    await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,$2,$3)`, [tenantId, e, role]);
  }
  await db.query(
    `INSERT INTO core.role_permissions (tenant_id,role,permission)
     VALUES ($1,'admin','*'),($1,'manager','pms_self'),($1,'manager','pms_team_eval') ON CONFLICT DO NOTHING`, [tenantId]);
  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['cq-hr@x.com', 'cq-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => (await (await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw' }),
  })).json()).token;
  hrTok = await login('cq-hr@x.com');
  mgrTok = await login('cq-mgr@x.com');
  assert.ok(hrTok && mgrTok, 'both test logins have to work');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    for (const t of ['pms.connect_questions', 'pms.audit_log', 'core.local_credentials',
      'core.user_roles', 'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('A FRESH TENANT HAS THE QUESTIONS, not an empty form', async () => {
  // The trap this exists for: index.js creates the tenant AFTER the
  // migrations run, so a migration that seeds per-tenant rows does
  // nothing on a fresh install. Seeding at request time is what makes
  // this true, and nothing on screen would have said otherwise — the
  // form would simply have had no boxes.
  const r = await api(mgrTok, '/connects/questions');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.questions.map((q) => q.key),
    ['topic', 'discussion', 'achievements', 'blockers', 'feedback']);
});

test('HR REWORDS A QUESTION AND THE FORM CHANGES', async () => {
  const qs = (await api(hrTok, '/connects/questions')).body.questions
    .map((q) => (q.key === 'blockers' ? { ...q, label: 'What is in your way?', hint: 'Be specific.' } : q));
  const w = await api(hrTok, '/connects/questions', { method: 'PUT', body: JSON.stringify({ questions: qs }) });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const after = (await api(mgrTok, '/connects/questions')).body.questions.find((q) => q.key === 'blockers');
  assert.equal(after.label, 'What is in your way?');
  assert.equal(after.hint, 'Be specific.');
});

test('switching one off takes the box off the form', async () => {
  const qs = (await api(hrTok, '/connects/questions')).body.questions
    .map((q) => (q.key === 'feedback' ? { ...q, active: false } : q));
  await api(hrTok, '/connects/questions', { method: 'PUT', body: JSON.stringify({ questions: qs }) });
  const after = (await api(mgrTok, '/connects/questions')).body.questions.find((q) => q.key === 'feedback');
  assert.equal(after.active, false);
});

test('A MANAGER CANNOT REWORD THE COMPANY’S FORM', async () => {
  const qs = (await api(mgrTok, '/connects/questions')).body.questions;
  const w = await api(mgrTok, '/connects/questions', { method: 'PUT', body: JSON.stringify({ questions: qs }) });
  assert.equal(w.status, 403);
  assert.equal(w.body.needs, 'pms_admin', 'and the refusal names what was missing');
});

test('A BLANK LABEL IS REFUSED, and nothing else is saved either', async () => {
  // Validate every row before writing any — the importer's rule. A form
  // half-saved because row three was blank is worse than a refusal,
  // because nothing on screen says which half landed.
  const qs = (await api(hrTok, '/connects/questions')).body.questions
    .map((q) => (q.key === 'topic' ? { ...q, label: 'Subject' }
      : q.key === 'achievements' ? { ...q, label: '  ' } : q));
  const w = await api(hrTok, '/connects/questions', { method: 'PUT', body: JSON.stringify({ questions: qs }) });
  assert.equal(w.status, 422);
  assert.equal(w.body.key, 'achievements', 'the refusal names which question');
  const topic = (await api(hrTok, '/connects/questions')).body.questions.find((q) => q.key === 'topic');
  assert.equal(topic.label, 'Topic', 'the rows before the bad one were written anyway');
});

test('a question can only point at a column the connect record actually has', async () => {
  // The schema, not the handler, is what makes this true — so it holds
  // for anything that writes to this table, not just the route above.
  await assert.rejects(
    () => db.query(
      `INSERT INTO pms.connect_questions (tenant_id,key,field,label) VALUES ($1,'bogus','made_up','Q')`,
      [tenantId]),
    /connect_questions_field_check/);
});
