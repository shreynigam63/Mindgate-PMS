// node --test — Performance Improvement Plan (BR-7.1 auto-trigger, BR-7.2
// weekly tracking through to closure). Route-level logic touches several
// tables and the phase machine together, so — like consent.test.js — this
// exercises the real HTTP surface against a real Postgres rather than
// mocking; it SKIPS (not fails) without DATABASE_URL so `npm test` still
// needs no DB for everyone else.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let app, db, server, base;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pip';
  process.env.TENANT_SLUG = 'pip-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { authenticate, devLogin } = require('../core/auth');
  await runMigrations();

  const slug = process.env.TENANT_SLUG;
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [slug])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await require('../migrations/008-review-parameters').ensureDefaultParameters(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PIP Mgr','pip-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'PIP Emp','pip-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PIP HR','pip-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'pip-mgr@x.com','manager'),($1,'pip-hr@x.com','hr')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['pip-mgr@x.com', 'pip-emp@x.com', 'pip-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;

  global.__pip_test_state = { tenantId: t.id, mgrId: mgr.id, empId: emp.id, hrId: hr.id };
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

// Scores every active review parameter to the same value, which makes the
// weighted average equal that value regardless of individual weights
// (sum(weight_i * X)/100 = X * sum(weight_i)/100 = X, since weights sum to
// 100) — the clean way for a test to land on an exact overall_rating via
// the (now mandatory, for annual cycles) 7-parameter engine.
async function scoreAllParamsTo(mgrTok, employeeId, value) {
  const plist = await api('/pms/review-parameters', mgrTok);
  const scores = Object.fromEntries(plist.body.parameters.map((p) => [p.id, value]));
  return api(`/pms/team/parameter-scores/${employeeId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ scores }) });
}

test('PIP: full lifecycle — auto-trigger on publish, manager-only writes, mandatory closure reason, idempotent re-publish', { skip }, async () => {
  const { empId } = global.__pip_test_state;
  const hrAuth = await login('pip-hr@x.com');
  const mgrAuth = await login('pip-mgr@x.com');
  const empAuth = await login('pip-emp@x.com');
  const hrTok = hrAuth.token, mgrTok = mgrAuth.token, empTok = empAuth.token;

  const cycleR = await api('/pms/cycles', hrTok, { method: 'POST', body: JSON.stringify({ name: 'Test Cycle', fiscal_year: 'FY99' }) });
  assert.equal(cycleR.body.cycle.pip_threshold, '3.0', 'default threshold is 3.0');
  const cycleId = cycleR.body.cycle.id;

  for (const phase of ['kra_open', 'growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval']) {
    await api(`/pms/cycles/${cycleId}/phase`, hrTok, { method: 'POST', body: JSON.stringify({ to: phase }) });
  }

  await scoreAllParamsTo(mgrTok, empId, 2.0);
  await api(`/pms/team/evaluations/${empId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ strengths: 'x', improvement_areas: 'y' }) });
  await api(`/pms/team/evaluations/${empId}/submit`, mgrTok, { method: 'POST' });

  for (const phase of ['hod_eval', 'calibration', 'publish']) {
    await api(`/pms/cycles/${cycleId}/phase`, hrTok, { method: 'POST', body: JSON.stringify({ to: phase }) });
  }

  const pub1 = await api('/pms/publish', hrTok, { method: 'POST' });
  assert.equal(pub1.body.pips_opened, 1, 'rating 2.0 < default threshold 3.0 auto-opens a PIP');

  const listR = await api('/pms/pip', empTok);
  assert.equal(listR.body.pips.length, 1);
  assert.equal(listR.body.pips[0].status, 'open');
  const pipId = listR.body.pips[0].id;

  const empWrite = await api(`/pms/pip/${pipId}/entries`, empTok, { method: 'POST', body: JSON.stringify({ week_ending: '2099-01-01', notes: 'should be blocked' }) });
  assert.equal(empWrite.status, 403, 'employee cannot write their own PIP entries');

  const mgrWrite = await api(`/pms/pip/${pipId}/entries`, mgrTok, { method: 'POST', body: JSON.stringify({ week_ending: '2099-01-01', notes: 'week 1 notes' }) });
  assert.equal(mgrWrite.status, 200);

  const detail = await api(`/pms/pip/${pipId}`, mgrTok);
  assert.equal(detail.body.pip.status, 'in_progress', 'first entry flips open -> in_progress');
  assert.equal(detail.body.weekly_entries.length, 1);

  const closeNoReason = await api(`/pms/pip/${pipId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ status: 'closed_successful' }) });
  assert.equal(closeNoReason.status, 400, 'closing without closed_reason is rejected');

  const closeOk = await api(`/pms/pip/${pipId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ status: 'closed_successful', closed_reason: 'met all targets' }) });
  assert.equal(closeOk.status, 200);

  const blockedEntry = await api(`/pms/pip/${pipId}/entries`, mgrTok, { method: 'POST', body: JSON.stringify({ week_ending: '2099-01-08', notes: 'too late' }) });
  assert.equal(blockedEntry.status, 409, 'no further entries once closed');

  const pub2 = await api('/pms/publish', hrTok, { method: 'POST' });
  assert.equal(pub2.body.pips_opened, 0, 're-publish does not duplicate/reopen the existing PIP');
});
