// node --test — 7 Organizational Parameters weighted rating engine
// (BR-6.2/BR-6.3). Real Postgres, real HTTP surface, same convention as
// the other integration suites: skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-params';
  process.env.TENANT_SLUG = 'params-test-' + Date.now();
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
  await require('../migrations/008-review-parameters').ensureDefaultParameters(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Param Mgr','param-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'Param Emp','param-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Param HR','param-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'param-mgr@x.com','manager'),($1,'param-hr@x.com','hr')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['param-mgr@x.com', 'param-emp@x.com', 'param-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

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
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('review-parameters: default set is 7 parameters summing to 100', { skip }, async () => {
  const { token } = await login('param-hr@x.com');
  const r = await api('/pms/review-parameters', token);
  assert.equal(r.body.parameters.length, 7);
  const total = r.body.parameters.reduce((s, p) => s + Number(p.weight_pct), 0);
  assert.equal(Math.round(total), 100);
});

test('review-parameters: HR can reconfigure; weights must sum to 100', { skip }, async () => {
  const { token } = await login('param-hr@x.com');
  const bad = await api('/pms/review-parameters', token, { method: 'PUT', body: JSON.stringify({ parameters: [{ name: 'Only One', weight_pct: 50 }] }) });
  assert.equal(bad.status, 422);

  const good = await api('/pms/review-parameters', token, {
    method: 'PUT',
    body: JSON.stringify({ parameters: [{ name: 'Half A', weight_pct: 50 }, { name: 'Half B', weight_pct: 50 }] }),
  });
  assert.equal(good.status, 200);
  const list = await api('/pms/review-parameters', token);
  assert.equal(list.body.parameters.length, 2);
  assert.deepEqual(list.body.parameters.map((p) => p.name), ['Half A', 'Half B']);
});

test('parameter-scores: partial scoring is incomplete; full scoring computes and commits into overall_rating', { skip }, async () => {
  const hrAuth = await login('param-hr@x.com');
  const mgrAuth = await login('param-mgr@x.com');
  const hrTok = hrAuth.token, mgrTok = mgrAuth.token;

  // Fresh 2-parameter config from the previous test (Half A=50, Half B=50).
  const plist = await api('/pms/review-parameters', hrTok);
  const [pA, pB] = plist.body.parameters;

  const cycleR = await api('/pms/cycles', hrTok, { method: 'POST', body: JSON.stringify({ name: 'Param Cycle', fiscal_year: 'FYP', cycle_type: 'annual' }) });
  const cycleId = cycleR.body.cycle.id;
  for (const phase of ['kra_open', 'growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval']) {
    await api(`/pms/cycles/${cycleId}/phase`, hrTok, { method: 'POST', body: JSON.stringify({ to: phase }) });
  }

  const partial = await api(`/pms/team/parameter-scores/${empId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ scores: { [pA.id]: 4 } }) });
  assert.equal(partial.body.complete, false);
  assert.deepEqual(partial.body.missing, [pB.id]);

  // Manager evaluation submit should still be blocked — no manager_evaluations
  // row exists yet at all (parameter-scores only creates/updates it once
  // complete), so the pre-existing, unmodified submit route correctly 404s.
  const submitTooEarly = await api(`/pms/team/evaluations/${empId}/submit`, mgrTok, { method: 'POST' });
  assert.equal(submitTooEarly.status, 404);

  const full = await api(`/pms/team/parameter-scores/${empId}`, mgrTok, { method: 'PUT', body: JSON.stringify({ scores: { [pB.id]: 2 } }) });
  assert.equal(full.body.complete, true);
  assert.equal(full.body.weighted_rating, 3); // (4*0.5)+(2*0.5)=3, matches computeWeightedRating unit test

  // GET reflects the same computed values.
  const get = await api(`/pms/team/parameter-scores/${empId}`, mgrTok);
  assert.equal(get.body.weighted_rating, 3);
  assert.equal(get.body.complete, true);

  // Now the existing, UNCHANGED manager-evaluation submit path works,
  // proving the weighted score fed straight into overall_rating without
  // any change needed to that route or anything downstream of it.
  const submitNow = await api(`/pms/team/evaluations/${empId}/submit`, mgrTok, { method: 'POST' });
  assert.equal(submitNow.status, 200);

  const teamList = await api('/pms/team/evaluations', mgrTok);
  const row = teamList.body.team.find((e) => e.employee_id === empId);
  assert.equal(Number(row.overall_rating), 3, 'overall_rating in the pre-existing table now reflects the weighted score');
});

test('parameter-scores: rejects an unknown parameter_id and an out-of-range score', { skip }, async () => {
  const hrAuth = await login('param-hr@x.com');
  const mgrAuth = await login('param-mgr@x.com');
  const bad1 = await api(`/pms/team/parameter-scores/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ scores: { 'not-a-real-id': 3 } }) });
  assert.equal(bad1.status, 400);
  const plist = await api('/pms/review-parameters', hrAuth.token);
  const pid = plist.body.parameters[0].id;
  const bad2 = await api(`/pms/team/parameter-scores/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ scores: { [pid]: 9 } }) });
  assert.equal(bad2.status, 400);
});

test('team/evaluations: directly setting overall_rating on an annual cycle is rejected — must go through parameter-scores', { skip }, async () => {
  const hrAuth = await login('param-hr@x.com');
  const mgrAuth = await login('param-mgr@x.com');
  const cycleR = await api('/pms/cycles', hrAuth.token, { method: 'POST', body: JSON.stringify({ name: 'Guard Cycle', fiscal_year: 'FYG', cycle_type: 'annual' }) });
  const cycleId = cycleR.body.cycle.id;
  for (const phase of ['kra_open', 'growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval']) {
    await api(`/pms/cycles/${cycleId}/phase`, hrAuth.token, { method: 'POST', body: JSON.stringify({ to: phase }) });
  }
  const direct = await api(`/pms/team/evaluations/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ overall_rating: 5 }) });
  assert.equal(direct.status, 409);
  assert.match(direct.body.error, /7 organisational parameters/);
  // Strengths/improvement_areas (no overall_rating) still work normally.
  const textOnly = await api(`/pms/team/evaluations/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ strengths: 'fine' }) });
  assert.equal(textOnly.status, 200);
});
