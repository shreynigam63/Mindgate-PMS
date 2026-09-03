// node --test — employee self-scoring against the 7 Organizational
// Parameters is REMOVED, and this pins what that means.
//
// The employee's Self-Appraisal briefly carried its own star pickers for
// the same 7 parameters the manager scores (BR-6.2/6.3), plus GET/PUT
// /pms/my/parameter-scores behind them. The client's instruction is that
// the 7 parameters come off that page, so the routes went with the UI —
// an endpoint the product no longer offers is still callable by anyone
// with a token.
//
// The two things worth guarding are the coupling and the blast radius.
// The coupling: the annual submit gate required all 7 self-scores to be
// complete, so leaving it in place while removing the only way to write
// them would have made an annual self-appraisal unsubmittable. The blast
// radius: the MANAGER's scoring of the same 7 parameters is untouched and
// is still what the official annual rating is built from, and the
// role-filtering bug that migration 021 exposed must stay fixed even
// though nothing writes 'self' rows any more.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, cycleId, tenantId, paramIds;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sps';
  process.env.TENANT_SLUG = 'sps-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SPS Mgr','sps-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'SPS Emp','sps-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'sps-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['sps-mgr@x.com', 'sps-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  // 2 active parameters (60/40) — enough to prove weighting without
  // wiring all 7 up.
  const p1 = (await db.query(`INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order) VALUES ($1,'My Work',60,10) RETURNING id`, [t.id])).rows[0];
  const p2 = (await db.query(`INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order) VALUES ($1,'My Team',40,20) RETURNING id`, [t.id])).rows[0];
  paramIds = [p1.id, p2.id];
  await db.query(`DELETE FROM pms.review_parameters WHERE tenant_id=$1 AND id NOT IN ($2,$3)`, [t.id, p1.id, p2.id]);

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'SPS Cycle','FYSPS','annual','self_appraisal') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;

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
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
}

test('the employee self-scoring routes are gone, not merely hidden from the page', { skip }, async () => {
  const { token } = await login('sps-emp@x.com');
  // 404 from the router itself — an authenticated employee cannot reach
  // this by hand-rolling the request either.
  const get = await api('/pms/my/parameter-scores', token);
  assert.equal(get.status, 404);
  const put = await api('/pms/my/parameter-scores', token, { method: 'PUT', body: JSON.stringify({ scores: { [paramIds[0]]: 5 } }) });
  assert.equal(put.status, 404);
  const none = (await db.query(
    `SELECT count(*)::int AS n FROM pms.parameter_scores WHERE cycle_id=$1 AND scored_by_role='self'`, [cycleId])).rows[0].n;
  assert.equal(none, 0, 'and the refused PUT wrote nothing');
});

test('an annual self-appraisal submits with no parameter scoring at all', { skip }, async () => {
  // The gate this replaces returned 422 "Score all 7 organisational
  // parameters before submitting". With no way left to satisfy it, that
  // gate would be a lockout — the whole reason it had to go with the
  // feature rather than after it.
  const { token } = await login('sps-emp@x.com');
  await api('/pms/my/self-appraisal', token); // auto-creates the row
  const submit = await api('/pms/my/self-appraisal/submit', token, { method: 'POST' });
  assert.equal(submit.status, 200, 'no 422, and nothing was scored');
});

test('GET /my/self-appraisal still reports cycle_type — other annual-only wording depends on it', { skip }, async () => {
  const { token } = await login('sps-emp@x.com');
  const r = await api('/pms/my/self-appraisal', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.cycle.cycle_type, 'annual');
});

test('the MANAGER still scores the 7 parameters, and that is still the official rating', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='manager_eval' WHERE id=$1`, [cycleId]);
  const mgrAuth = await login('sps-mgr@x.com');
  const put = await api(`/pms/team/parameter-scores/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ scores: { [paramIds[0]]: 2, [paramIds[1]]: 2 } }) });
  assert.equal(put.status, 200);
  assert.equal(Number(put.body.weighted_rating), 2);

  const view = await api(`/pms/team/parameter-scores/${empId}`, mgrAuth.token);
  assert.equal(view.body.scores[paramIds[0]], 2);
  // It used to return the employee's self-scores alongside. That field is
  // gone rather than left to read as "the employee scored nothing".
  assert.equal(view.body.self_scores, undefined, 'no permanently-empty self_scores field');

  const ev = (await db.query(
    `SELECT overall_rating FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
  assert.equal(Number(ev.overall_rating), 2, 'the manager 7-parameter engine still writes the official rating');
});

// Found during a manual BRD-vs-code review (BR-6.1/6.2/6.3): the Annual
// Review consolidation screen's parameter_scores section is labelled
// "manager scoring in progress" — it must show the MANAGER's scores
// specifically, not whichever of self/manager an unfiltered query returns
// first. Nothing writes 'self' rows now, so this seeds them directly:
// historical rows from before the removal still exist in real databases,
// and the fix must not quietly rot because the writer is gone.
test('Annual Review summary shows the manager\'s scores specifically, even with legacy self-scores present', { skip }, async () => {
  await db.query(
    `INSERT INTO pms.parameter_scores (tenant_id, cycle_id, employee_id, parameter_id, score, scored_by, scored_by_role)
     VALUES ($1,$2,$3,$4,5,'legacy@x.com','self'), ($1,$2,$3,$5,3,'legacy@x.com','self')`,
    [tenantId, cycleId, empId, paramIds[0], paramIds[1]]);

  const empAuth = await login('sps-emp@x.com');
  const mine = await api('/pms/my/annual-review', empAuth.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.parameter_scores.scores[paramIds[0]], 2, 'the manager\'s score (2), not the legacy self-score (5)');
  assert.equal(mine.body.parameter_scores.scores[paramIds[1]], 2);

  const mgrAuth = await login('sps-mgr@x.com');
  const team = await api(`/pms/team/annual-review/${empId}`, mgrAuth.token);
  assert.equal(team.status, 200);
  assert.equal(team.body.parameter_scores.scores[paramIds[0]], 2, 'same filtering on the manager/HOD-facing view');
});
