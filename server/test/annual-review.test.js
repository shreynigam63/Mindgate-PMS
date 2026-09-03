// node --test — Annual Review consolidation (BR-6.1: "consolidates KRA
// outcomes, development plan progress, and career path status"). Real
// Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, mgrId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-arsum';
  process.env.TENANT_SLUG = 'arsum-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'AR Mgr','ar-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'AR Emp','ar-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'AR Stranger','ar-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id; mgrId = mgr.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ar-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ar-mgr@x.com', 'ar-emp@x.com', 'ar-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'AR Cycle','FYAR','annual','manager_eval') RETURNING id`, [t.id])).rows[0];

  // Seed a KRA sheet + KRA with self and manager entries.
  const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`, [t.id, cycle.id, emp.id, mgr.id])).rows[0];
  const kra = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight) VALUES ($1,$2,'Ship the feature',100) RETURNING id`, [t.id, sheet.id])).rows[0];
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status, entries) VALUES ($1,$2,$3,'submitted',$4)`,
    [t.id, cycle.id, emp.id, JSON.stringify({ [kra.id]: { self_rating: 4, narrative: 'Shipped on time' } })]);
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status, entries) VALUES ($1,$2,$3,$4,'pending',$5)`,
    [t.id, cycle.id, emp.id, mgr.id, JSON.stringify({ [kra.id]: { rating: 4, comment: 'Agreed, great work' } })]);

  // Development plan with one goal at 60% progress.
  const plan = (await db.query(`INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING id`, [t.id, cycle.id, emp.id, mgr.id])).rows[0];
  await db.query(`INSERT INTO pms.development_goals (tenant_id, plan_id, title, progress_pct) VALUES ($1,$2,'Learn Kubernetes',60)`, [t.id, plan.id]);

  // Career path.
  await db.query(`INSERT INTO people.career_paths (tenant_id, employee_id, target_role, plan) VALUES ($1,$2,'Staff Engineer','Grow scope')`, [t.id, emp.id]);

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
async function api(path, token) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
}

test('annual review summary: consolidates KRA outcomes, dev plan progress, and career path in one call', { skip }, async () => {
  const { token } = await login('ar-emp@x.com');
  const r = await api('/pms/my/annual-review', token);
  assert.equal(r.status, 200);

  assert.equal(r.body.kra.outcomes.length, 1);
  assert.equal(r.body.kra.outcomes[0].title, 'Ship the feature');
  assert.equal(r.body.kra.outcomes[0].self.self_rating, 4);
  assert.equal(r.body.kra.outcomes[0].manager.rating, 4);

  assert.equal(r.body.development_plan.goals.length, 1);
  assert.equal(r.body.development_plan.avg_progress, 60);

  assert.equal(r.body.career_path.target_role, 'Staff Engineer');

  // The employee's own view carries no parameter scores: they are the
  // MANAGER's, and this route has no publish gate, so returning them let
  // the person being scored watch their own scoring appear before
  // calibration. The three things this test's own title names — KRA
  // outcomes, dev plan progress, career path — are all still here.
  assert.equal(r.body.parameter_scores, undefined, 'withheld from the person being scored');

  assert.deepEqual(r.body.rating_history, [], 'no published history yet for this brand-new employee');
  assert.equal(r.body.super50.flag, false);
});

test('annual review summary: manager can view a report\'s summary; an unrelated employee cannot', { skip }, async () => {
  const mgrAuth = await login('ar-mgr@x.com');
  const strangerAuth = await login('ar-stranger@x.com');

  const asManager = await api(`/pms/team/annual-review/${empId}`, mgrAuth.token);
  assert.equal(asManager.status, 200);
  assert.equal(asManager.body.employee.name, 'AR Emp');
  assert.equal(asManager.body.kra.outcomes[0].title, 'Ship the feature');

  const asStranger = await api(`/pms/team/annual-review/${empId}`, strangerAuth.token);
  assert.equal(asStranger.status, 403);
});

test('annual review summary: an employee with no cycle activity yet gets empty-but-valid sections, not an error', { skip }, async () => {
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const bcrypt = require('bcryptjs');
  const fresh = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'AR Fresh','ar-fresh@x.com','active') RETURNING id`, [t])).rows[0];
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'ar-fresh@x.com',$2)`, [t, await bcrypt.hash('pass', 10)]);
  const { token } = await login('ar-fresh@x.com');
  const r = await api('/pms/my/annual-review', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.kra.sheet, null);
  assert.deepEqual(r.body.kra.outcomes, []);
  assert.equal(r.body.development_plan.plan, null);
  assert.equal(r.body.career_path, null);
});
