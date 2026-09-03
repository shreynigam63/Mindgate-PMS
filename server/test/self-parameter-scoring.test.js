// node --test — Employee self-scoring on the 7 Organizational Parameters
// (BR-6.2/6.3), requested with a reference screenshot: previously only
// the manager could score against these 7 parameters; the employee's own
// Self-Appraisal had no mirror of it. Also proves migration 021's actual
// point: self and manager scores must coexist per parameter without
// overwriting each other. Real Postgres, real HTTP surface, skips
// cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, cycleId, paramIds;

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
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SPS Mgr','sps-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'SPS Emp','sps-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'sps-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['sps-mgr@x.com', 'sps-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  // 2 active parameters (60/40), same tolerance principle as other tests
  // — enough to prove weighting without needing all 7 wired up.
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
  return { status: r.status, body: await r.json() };
}

test('GET /my/self-appraisal now includes cycle_type, needed to show the 7-parameter section only on annual cycles', { skip }, async () => {
  const { token } = await login('sps-emp@x.com');
  const r = await api('/pms/my/self-appraisal', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.cycle.cycle_type, 'annual');
});

test('employee can self-score the 7 parameters, computing their own weighted average', { skip }, async () => {
  const { token } = await login('sps-emp@x.com');
  const put = await api('/pms/my/parameter-scores', token, { method: 'PUT', body: JSON.stringify({ scores: { [paramIds[0]]: 5, [paramIds[1]]: 3 } }) });
  assert.equal(put.status, 200);
  // 60/40: 5*0.6 + 3*0.4 = 4.2
  assert.equal(Number(put.body.weighted_rating), 4.2);
  assert.equal(put.body.complete, true);

  // Deliberately NOT written into the appraisal's own rating. That column
  // is the per-KRA weighted average (see self-appraisal-rating.test.js);
  // this figure is a self-assessment the employee reads back from the GET
  // below. Writing it there is what made the Self-Appraisal page present
  // it as the "Overall Annual Rating" — authority it never had, since
  // BR-6.2/6.3 gives the official annual rating to the MANAGER's scoring
  // of the same 7 parameters.
  const appraisal = await api('/pms/my/self-appraisal', token);
  assert.equal(appraisal.body.appraisal.overall_self_rating, null, 'self-scoring does not write the appraisal rating');
  assert.equal(appraisal.body.appraisal.status, 'in_progress', 'but scoring alone still counts as progress');

  const back = await api('/pms/my/parameter-scores', token);
  assert.equal(Number(back.body.weighted_rating), 4.2, 'the self-assessment figure is readable, just not promoted');
});

// The exact point of migration 021: this must NOT touch the manager's own
// score for the same employee/parameter, or vice versa.
test('self-scores and manager-scores coexist independently for the same parameter, without overwriting each other', { skip }, async () => {
  const c = (await db.query(`SELECT phase FROM pms.cycles WHERE id=$1`, [cycleId])).rows[0];
  await db.query(`UPDATE pms.cycles SET phase='manager_eval' WHERE id=$1`, [cycleId]);
  const mgrAuth = await login('sps-mgr@x.com');
  await api(`/pms/team/parameter-scores/${empId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ scores: { [paramIds[0]]: 2, [paramIds[1]]: 2 } }) });

  const mgrView = await api(`/pms/team/parameter-scores/${empId}`, mgrAuth.token);
  assert.equal(mgrView.body.scores[paramIds[0]], 2, 'manager sees their own score');
  assert.equal(mgrView.body.self_scores[paramIds[0]], 5, 'and the employee\'s self-score, unaffected by the manager\'s own write');

  await db.query(`UPDATE pms.cycles SET phase=$1 WHERE id=$2`, [c.phase, cycleId]);
  const empAuth = await login('sps-emp@x.com');
  const empView = await api('/pms/my/parameter-scores', empAuth.token);
  assert.equal(empView.body.scores[paramIds[0]], 5, 'employee\'s own self-score is untouched by the manager\'s scoring');
});

// Found during a manual BRD-vs-code review (BR-6.1/6.2/6.3): the Annual
// Review consolidation screen's parameter_scores section is explicitly
// labelled "manager scoring in progress" in the UI — it must show the
// MANAGER's scores specifically, not whichever of self/manager happens
// to come back first from an unfiltered query. Both self (5, 3) and
// manager (2, 2) scores exist for these two parameters at this point in
// the suite, from the tests above — exactly the condition that exposed
// the bug.
test('Annual Review summary shows the manager\'s scores specifically, not a mix with the employee\'s self-scores', { skip }, async () => {
  const empAuth = await login('sps-emp@x.com');
  const mine = await api('/pms/my/annual-review', empAuth.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.parameter_scores.scores[paramIds[0]], 2, 'the manager\'s score (2), not the employee\'s own self-score (5)');
  assert.equal(mine.body.parameter_scores.scores[paramIds[1]], 2);

  const mgrAuth = await login('sps-mgr@x.com');
  const team = await api(`/pms/team/annual-review/${empId}`, mgrAuth.token);
  assert.equal(team.status, 200);
  assert.equal(team.body.parameter_scores.scores[paramIds[0]], 2, 'same fix applies to the manager/HOD-facing view');
});

test('submitting self-appraisal on an annual cycle requires the 7 parameters to be complete', { skip }, async () => {
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const fresh = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SPS Fresh','sps-fresh@x.com','active') RETURNING id`, [t])).rows[0];
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'sps-fresh@x.com',$2)`, [t, await bcrypt.hash('pass', 10)]);

  const { token } = await login('sps-fresh@x.com');
  await api('/pms/my/self-appraisal', token); // auto-creates the row
  const submit = await api('/pms/my/self-appraisal/submit', token, { method: 'POST' });
  assert.equal(submit.status, 422);
  assert.match(submit.body.error, /7 organisational parameters/);

  await api('/pms/my/parameter-scores', token, { method: 'PUT', body: JSON.stringify({ scores: { [paramIds[0]]: 4, [paramIds[1]]: 4 } }) });
  const submit2 = await api('/pms/my/self-appraisal/submit', token, { method: 'POST' });
  assert.equal(submit2.status, 200, 'now allowed, once all 7 (here, both configured) parameters are scored');
});
