// node --test — Mid-Year Review (BR-5.1/5.2), rebuilt around
// pms.midyear_checkins (migration 020) and the mid_year_review phase
// (phase-machine.js), replacing the old read-only consolidation that
// reused pms.self_appraisals/pms.manager_evaluations. Real Postgres, real
// HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, cycleId, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-midyear';
  process.env.TENANT_SLUG = 'midyear-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'MY Mgr','my-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'MY Emp','my-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'MY Stranger','my-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'my-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['my-mgr@x.com', 'my-emp@x.com', 'my-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  // Starts in growth_planning ON PURPOSE — several tests below assert
  // Mid-Year Review is correctly BLOCKED until the cycle actually reaches
  // the mid_year_review phase (the exact "should not open before growth
  // plan is complete" request this feature implements).
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'MY Cycle','FYMY','annual','growth_planning') RETURNING id`,
    [t.id])).rows[0];
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

test('Mid-Year Review is blocked while the cycle is still in growth_planning', { skip }, async () => {
  const empAuth = await login('my-emp@x.com');
  const get = await api('/pms/my/midyear-review', empAuth.token);
  assert.equal(get.status, 200);
  assert.equal(get.body.editable, false, 'not editable before the cycle reaches mid_year_review');

  const put = await api('/pms/my/midyear-review', empAuth.token, { method: 'PUT', body: JSON.stringify({ self_narrative: 'too early' }) });
  assert.equal(put.status, 409);
  assert.match(put.body.error, /not open/);
});

test('Mid-Year Review opens once the cycle moves to mid_year_review, and locks again once it moves past it', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='mid_year_review' WHERE id=$1`, [cycleId]);
  const empAuth = await login('my-emp@x.com');

  const get = await api('/pms/my/midyear-review', empAuth.token);
  assert.equal(get.body.editable, true);
  assert.ok(Array.isArray(get.body.cycle.rating_scale), 'rating_scale is passed through for the self-rating buttons');

  const put = await api('/pms/my/midyear-review', empAuth.token, {
    method: 'PUT', body: JSON.stringify({ self_rating: get.body.cycle.rating_scale[0].value, self_narrative: 'Good progress on the launch.' }),
  });
  assert.equal(put.status, 200);

  const submit = await api('/pms/my/midyear-review/submit', empAuth.token, { method: 'POST' });
  assert.equal(submit.status, 200);

  const afterSubmit = await api('/pms/my/midyear-review', empAuth.token);
  assert.equal(afterSubmit.body.checkin.self_status, 'submitted');
  assert.equal(afterSubmit.body.editable, false, 'locks once submitted, even while still in mid_year_review');

  await db.query(`UPDATE pms.cycles SET phase='self_appraisal' WHERE id=$1`, [cycleId]);
  const afterPhaseMoves = await api('/pms/my/midyear-review', empAuth.token);
  assert.equal(afterPhaseMoves.body.editable, false, 'also locked once the cycle moves past mid_year_review');
  assert.equal(afterPhaseMoves.body.checkin.self_narrative, 'Good progress on the launch.', 'the mid-year narrative survives — untouched by the later self_appraisal phase');

  // Reset for the tests below that also need mid_year_review open.
  await db.query(`UPDATE pms.cycles SET phase='mid_year_review' WHERE id=$1`, [cycleId]);
});

test('submitting requires a non-empty narrative', { skip }, async () => {
  const t = (await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND email='my-mgr@x.com'`, [tenantId])).rows[0];
  const fresh = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'MY Fresh','my-fresh@x.com','active',$2) RETURNING id`, [tenantId, t.id])).rows[0];
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'my-fresh@x.com',$2)`, [tenantId, await bcrypt.hash('pass', 10)]);

  const { token } = await login('my-fresh@x.com');
  const get = await api('/pms/my/midyear-review', token);
  assert.equal(get.body.checkin.self_status, 'not_started', 'auto-created, not yet touched');

  const submit = await api('/pms/my/midyear-review/submit', token, { method: 'POST' });
  assert.equal(submit.status, 422);
  assert.match(submit.body.error, /reflection/);
});

test('manager can view and edit a report\'s check-in; an unrelated employee cannot', { skip }, async () => {
  const mgrAuth = await login('my-mgr@x.com');
  const strangerAuth = await login('my-stranger@x.com');

  const asManager = await api(`/pms/team/midyear-review/${empId}`, mgrAuth.token);
  assert.equal(asManager.status, 200);
  assert.equal(asManager.body.checkin.self_status, 'submitted', 'sees the employee\'s already-submitted reflection');

  const put = await api(`/pms/team/midyear-review/${empId}`, mgrAuth.token, {
    method: 'PUT', body: JSON.stringify({ manager_rating: asManager.body.cycle.rating_scale[0].value, manager_narrative: 'Agreed, strong first half.' }),
  });
  assert.equal(put.status, 200);

  const submit = await api(`/pms/team/midyear-review/${empId}/submit`, mgrAuth.token, { method: 'POST' });
  assert.equal(submit.status, 200);

  const asStranger = await api(`/pms/team/midyear-review/${empId}`, strangerAuth.token);
  assert.equal(asStranger.status, 403);
});

test('signing off the mid-year checkpoint does not lock the SAME cycle\'s later self_appraisal action', { skip }, async () => {
  // This is the exact bug a naive reuse of pms.self_appraisals would have
  // caused — confirmed here against the real gate the routes use.
  const pm = require('../modules/performance/phase-machine');
  assert.equal(pm.phaseAllows('mid_year_review', 'self_edit'), false, 'mid_year_review never grants the annual self_edit action');
  assert.equal(pm.phaseAllows('self_appraisal', 'self_edit'), true, 'self_appraisal still grants it normally, independent of what happened during mid_year_review');
});

// Found live: reported as "even after HR opens Mid-Year Review, the
// employee still can't edit." Root cause — a NEWER, earlier-phase cycle
// (easy to accumulate in testing: draft cycles started and abandoned)
// was silently outranking the correctly-advanced one under plain
// activeCycle()'s "most recently CREATED" heuristic. This proves the
// hardened resolver picks the cycle that's actually at mid_year_review,
// not whichever is newest.
test('a newer, earlier-phase cycle does not shadow the one actually at mid_year_review', { skip }, async () => {
  // A second cycle, created AFTER the mid_year_review one, still in draft.
  await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, created_at) VALUES ($1,'MY Newer Draft','FYND','annual','draft', now() + interval '1 hour')`,
    [tenantId]);

  // As MY Fresh, who has NOT submitted — so `editable` is still a live
  // signal here. Asked as my-emp, who signed off in an earlier test, it
  // would read false for a reason that has nothing to do with which cycle
  // was resolved, and would prove nothing either way.
  const { token } = await login('my-fresh@x.com');
  const get = await api('/pms/my/midyear-review', token);
  assert.equal(get.body.cycle.name, 'MY Cycle', 'resolves to the cycle actually at mid_year_review, not the newer draft one');
  assert.equal(get.body.editable, true, 'and that cycle is open — a draft cycle would have made this false');

  // The employee who already signed still sees the same resolved cycle,
  // locked. Both halves of the flag, on one resolver call.
  const signed = await api('/pms/my/midyear-review', (await login('my-emp@x.com')).token);
  assert.equal(signed.body.cycle.name, 'MY Cycle');
  assert.equal(signed.body.editable, false);
});
