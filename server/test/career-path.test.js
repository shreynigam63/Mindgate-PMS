// node --test — employee-facing Career Path (BR-3.1/3.2). Found missing
// alongside Development Plan, 28-Aug-2026: only the HR-admin career
// matrix config existed (modules/people/index.js), no route let an
// employee set or view their own path. Real Postgres, real HTTP surface,
// skips cleanly without DATABASE_URL, same convention as the other
// integration suites.
//
// UPDATED: the flat role_band allow-list (Career Framework,
// people.career_matrix) was removed in favour of the Career Pathing
// Matrix (people.career_transitions) — the guardrail now validates a
// specific from-role -> to-role transition, keyed off the employee's own
// current designation, rather than checking target_role against one flat
// org-wide list.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, tenantId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-career';
  process.env.TENANT_SLUG = 'career-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CP Mgr','cp-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  // designation is what the new guardrail keys "current role" off of.
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id, designation) VALUES ($1,'CP Emp','cp-emp@x.com','active',$2,'Software Engineer II') RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'cp-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['cp-mgr@x.com', 'cp-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }
  // Career Path editing is gated to the growth_planning phase (see
  // phase-machine.js) — "HR locks KRA, then Development Plan and Career
  // Path open." Without an active cycle in this phase, every PUT below
  // would 409.
  await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'CP Cycle','FYCP','annual','growth_planning')`, [t.id]);

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

test('career path: no transitions configured yet — any target_role is accepted', { skip }, async () => {
  const { token } = await login('cp-emp@x.com');
  const initial = await api('/people/career/my-path', token);
  assert.equal(initial.body.path, null);
  assert.deepEqual(initial.body.eligible_target_roles, []);

  const set = await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Staff Engineer', plan: 'Grow into a tech-lead role' }) });
  assert.equal(set.status, 200);

  const after1 = await api('/people/career/my-path', token);
  assert.equal(after1.body.path.target_role, 'Staff Engineer');
});

test('career path: once HR configures a transition FROM the employee\'s own role, an unlisted target_role is rejected', { skip }, async () => {
  const empAuth = await login('cp-emp@x.com');
  // Seeded directly, as HR would via the Career Pathing Matrix screen —
  // from_role must match the employee's own designation ('Software
  // Engineer II') for this to actually apply to them.
  await db.query(
    `INSERT INTO people.career_transitions (tenant_id, from_role, to_role, active) VALUES ($1,'Software Engineer II','Software Engineer III',true)`,
    [tenantId]);

  const bad = await api('/people/career/my-path', empAuth.token, { method: 'PUT', body: JSON.stringify({ target_role: 'Not A Real Role' }) });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /Software Engineer III/);

  const good = await api('/people/career/my-path', empAuth.token, { method: 'PUT', body: JSON.stringify({ target_role: 'Software Engineer III' }) });
  assert.equal(good.status, 200);
});

test('career path: a transition configured FROM a different role does not apply — inactive transitions are also ignored', { skip }, async () => {
  await db.query(
    `INSERT INTO people.career_transitions (tenant_id, from_role, to_role, active) VALUES
       ($1,'Some Other Role','Should Not Show Up',true),
       ($1,'Software Engineer II','Inactive Path',false)`,
    [tenantId]);

  const { token } = await login('cp-emp@x.com');
  const r = await api('/people/career/my-path', token);
  assert.deepEqual(r.body.eligible_target_roles, ['Software Engineer III'], 'only the active transition from THIS employee\'s own role shows up');
});

test('career path: manager can see their reports\' paths', { skip }, async () => {
  const { token } = await login('cp-mgr@x.com');
  const r = await api('/people/career/team', token);
  assert.equal(r.status, 200);
  const row = r.body.team.find((x) => x.employee_id === empId);
  assert.equal(row.target_role, 'Software Engineer III');
});

test('career path: an update replaces (upserts), not duplicates', { skip }, async () => {
  const { token } = await login('cp-emp@x.com');
  await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Software Engineer III', plan: 'v2 of the plan' }) });
  const rows = await db.query(`SELECT COUNT(*)::int AS n FROM people.career_paths WHERE employee_id=$1`, [empId]);
  assert.equal(rows.rows[0].n, 1, 'upsert, not a second row');
});

// The feature this whole gate exists for: "after KRAs are approved by
// managers, HR will move the cycle to lock KRA and it will open
// development plan and career path." Editing must be blocked before
// growth_planning and after it moves on, not just allowed during it.
test('career path: editing is blocked outside the growth_planning phase', { skip }, async () => {
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const { token } = await login('cp-emp@x.com');

  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE tenant_id=$1`, [t]);
  const beforeLock = await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Software Engineer III', plan: 'too early' }) });
  assert.equal(beforeLock.status, 409);
  assert.match(beforeLock.body.error, /not open/);

  await db.query(`UPDATE pms.cycles SET phase='self_appraisal' WHERE tenant_id=$1`, [t]);
  const afterWindow = await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Software Engineer III', plan: 'too late' }) });
  assert.equal(afterWindow.status, 409);

  await db.query(`UPDATE pms.cycles SET phase='growth_planning' WHERE tenant_id=$1`, [t]);
  const duringWindow = await api('/people/career/my-path', token, { method: 'PUT', body: JSON.stringify({ target_role: 'Software Engineer III', plan: 'right on time' }) });
  assert.equal(duringWindow.status, 200);

  const getResp = await api('/people/career/my-path', token);
  assert.equal(getResp.body.editable, true);
  assert.equal(getResp.body.cycle_phase, 'growth_planning');
});

// Found missing: employees could set a target role and a plan narrative,
// but nowhere to say WHEN they expect to get there.
test('career path: expected timeline is saved and returned alongside target role', { skip }, async () => {
  const { token } = await login('cp-emp@x.com');
  const set = await api('/people/career/my-path', token, {
    method: 'PUT', body: JSON.stringify({ target_role: 'Software Engineer III', target_timeline: '12-18 months', plan: 'Grow into a tech-lead role' }),
  });
  assert.equal(set.status, 200);

  const get = await api('/people/career/my-path', token);
  assert.equal(get.body.path.target_timeline, '12-18 months');

  const mgrAuth = await login('cp-mgr@x.com');
  const teamView = await api('/people/career/team', mgrAuth.token);
  const row = teamView.body.team.find((x) => x.employee_id === empId);
  assert.equal(row.target_timeline, '12-18 months', 'manager view also surfaces the timeline');
});
