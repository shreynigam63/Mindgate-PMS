// node --test — Connect insights guards (BR-4.2), found missing during a
// full BRD re-audit. Only the validation/authorization guards that run
// BEFORE any actual AI call are tested here — no existing agentic route
// in this codebase has an integration test that reaches the real AI call
// (ANTHROPIC_API_KEY isn't set in this sandbox), so this matches that
// established convention while still adding real coverage for the parts
// that don't need a key.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ci';
  process.env.TENANT_SLUG = 'ci-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CI Mgr','ci-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'CI Emp','ci-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CI Stranger','ci-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ci-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ci-mgr@x.com', 'ci-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
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

test('connect-insights: requires employee_id, blocks an unrelated manager, 422s with no logged notes yet', { skip }, async () => {
  const mgrAuth = await login('ci-mgr@x.com');
  const strangerAuth = await login('ci-stranger@x.com');

  const noId = await api('/agentic/connect-insights', mgrAuth.token, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(noId.status, 400);

  const notYourReport = await api('/agentic/connect-insights', strangerAuth.token, { method: 'POST', body: JSON.stringify({ employee_id: empId }) });
  assert.equal(notYourReport.status, 403);

  const noNotes = await api('/agentic/connect-insights', mgrAuth.token, { method: 'POST', body: JSON.stringify({ employee_id: empId }) });
  assert.equal(noNotes.status, 422, 'no logged connects with notes yet — nothing to summarise');
});

// Regression test: migration 017 replaced the old single `notes` column
// with `discussion_notes` (achievements/blockers/feedback are now their
// own columns) — this endpoint was still reading `cn.notes`, which new
// connects never populate, so it would silently 422 forever even with
// real logged connects. Caught and fixed while building /connect-extract.
test('connect-insights: finds connects logged with the new discussion_notes field, not just the legacy notes column', { skip }, async () => {
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const mgr = (await db.query(`SELECT id FROM core.employees WHERE email='ci-mgr@x.com' AND tenant_id=$1`, [t])).rows[0];
  await db.query(
    `INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, discussion_notes) VALUES ($1,$2,$3,'2026-06-01','Discussed Q2 progress, on track')`,
    [t, mgr.id, empId]);

  const mgrAuth = await login('ci-mgr@x.com');
  // Still hits the real AI call past this point (no ANTHROPIC_API_KEY in
  // this sandbox) — asserting it gets PAST the 422 "nothing to summarise"
  // guard is exactly what confirms the column-name fix, without needing
  // the AI call itself to succeed.
  const r = await api('/agentic/connect-insights', mgrAuth.token, { method: 'POST', body: JSON.stringify({ employee_id: empId }) });
  assert.notEqual(r.status, 422, 'a connect with discussion_notes should be found, not treated as "no notes"');
});

// New: /connect-extract — the piece that derives Achievements/Blockers/
// Feedback from "What was discussed?" rather than the manager typing all
// three from scratch.
test('connect-extract: requires discussion_notes, requires pms_team_eval', { skip }, async () => {
  const mgrAuth = await login('ci-mgr@x.com');
  const strangerAuth = await login('ci-stranger@x.com');

  const empty = await api('/agentic/connect-extract', mgrAuth.token, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(empty.status, 400);

  const whitespaceOnly = await api('/agentic/connect-extract', mgrAuth.token, { method: 'POST', body: JSON.stringify({ discussion_notes: '   ' }) });
  assert.equal(whitespaceOnly.status, 400);

  // A stranger with no pms_team_eval permission should be blocked before
  // any AI call is attempted, same as every other manager-only endpoint.
  const blocked = await api('/agentic/connect-extract', strangerAuth.token, { method: 'POST', body: JSON.stringify({ discussion_notes: 'Talked about the Q2 launch' }) });
  assert.equal(blocked.status, 403);
});
