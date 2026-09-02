// node --test — Development Plan / Org IDP (BR-2.1/2.2/2.3). Real
// Postgres, real HTTP surface, same convention as the other integration
// suites: skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, mgrId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-devplan';
  process.env.TENANT_SLUG = 'devplan-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'DP Mgr','dp-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'DP Emp','dp-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id; mgrId = mgr.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'dp-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['dp-mgr@x.com', 'dp-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'DP Cycle','FYDP','annual','growth_planning') RETURNING id`, [t.id])).rows[0];

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

test('development plan: full lifecycle — auto-created, goals saved, submit requires at least one goal, manager approves', { skip }, async () => {
  const empAuth = await login('dp-emp@x.com');
  const mgrAuth = await login('dp-mgr@x.com');
  const empTok = empAuth.token, mgrTok = mgrAuth.token;

  const initial = await api('/pms/my/development-plan', empTok);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.plan.status, 'draft', 'auto-created on first touch, like KRA sheets');
  assert.equal(initial.body.goals.length, 0);

  const submitEmpty = await api('/pms/my/development-plan/submit', empTok, { method: 'POST' });
  assert.equal(submitEmpty.status, 422, 'cannot submit with zero goals');

  const save = await api('/pms/my/development-plan/goals', empTok, {
    method: 'PUT',
    body: JSON.stringify({ goals: [{ title: 'Learn public speaking', description: 'Toastmasters', target_date: '2027-01-01', progress_pct: 10 }] }),
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.goals.length, 1);
  assert.equal(save.body.goals[0].progress_pct, 10);

  const submit = await api('/pms/my/development-plan/submit', empTok, { method: 'POST' });
  assert.equal(submit.status, 200);

  const teamView = await api('/pms/team/development-plans', mgrTok);
  assert.equal(teamView.body.plans.length, 1);
  assert.equal(teamView.body.plans[0].status, 'submitted');
  assert.equal(teamView.body.plans[0].avg_progress, 10);
  const planId = teamView.body.plans[0].id;

  const returnNoComment = await api(`/pms/team/development-plans/${planId}/decide`, mgrTok, { method: 'POST', body: JSON.stringify({ decision: 'returned' }) });
  assert.equal(returnNoComment.status, 422, 'returning requires a comment');

  const approve = await api(`/pms/team/development-plans/${planId}/decide`, mgrTok, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(approve.status, 200);

  const afterApproval = await api('/pms/my/development-plan', empTok);
  assert.equal(afterApproval.body.plan.status, 'approved');

  // Editing goal TEXT is now blocked (plan approved)...
  const editBlocked = await api('/pms/my/development-plan/goals', empTok, { method: 'PUT', body: JSON.stringify({ goals: [{ title: 'New goal', progress_pct: 0 }] }) });
  assert.equal(editBlocked.status, 409);

  // ...but PROGRESS updates (BR-2.3: "at any point in the year") still work
  // on the approved plan's existing goal, by either the employee or the manager.
  const goalId = afterApproval.body.goals[0].id;
  const progressByEmp = await api(`/pms/my/development-plan/goals/${goalId}/progress`, empTok, { method: 'PUT', body: JSON.stringify({ progress_pct: 50 }) });
  assert.equal(progressByEmp.status, 200);
  const progressByMgr = await api(`/pms/my/development-plan/goals/${goalId}/progress`, mgrTok, { method: 'PUT', body: JSON.stringify({ progress_pct: 80 }) });
  assert.equal(progressByMgr.status, 200);

  const final = await api('/pms/my/development-plan', empTok);
  assert.equal(final.body.goals[0].progress_pct, 80);
});

test('development plan: an unrelated employee cannot update someone else\'s goal progress', { skip }, async () => {
  // A third employee, unrelated to the emp/mgr pair above — neither the
  // goal's owner nor their manager.
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'DP Stranger','dp-stranger@x.com','active') RETURNING id`, [t])).rows[0];
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'dp-stranger@x.com',$2)`, [t, await bcrypt.hash('pass', 10)]);
  const strangerAuth = await login('dp-stranger@x.com');

  const empAuth = await login('dp-emp@x.com');
  const plan = await api('/pms/my/development-plan', empAuth.token);
  const goalId = plan.body.goals[0].id;

  const blocked = await api(`/pms/my/development-plan/goals/${goalId}/progress`, strangerAuth.token, { method: 'PUT', body: JSON.stringify({ progress_pct: 99 }) });
  assert.equal(blocked.status, 403);
});

// Manager previously saw only a goal count + avg progress on the review
// card — no way to actually read what the employee wrote before
// approving or returning it.
test('development plan: manager can see full goal detail (title, description, target date) before deciding', { skip }, async () => {
  const mgrAuth = await login('dp-mgr@x.com');
  const teamView = await api('/pms/team/development-plans', mgrAuth.token);
  const planId = teamView.body.plans[0].id;

  const detail = await api(`/pms/team/development-plans/${planId}/goals`, mgrAuth.token);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.goals.length, 1);
  assert.equal(detail.body.goals[0].title, 'Learn public speaking');
  assert.equal(detail.body.goals[0].description, 'Toastmasters');

  const strangerAuth = await login('dp-stranger@x.com');
  const blocked = await api(`/pms/team/development-plans/${planId}/goals`, strangerAuth.token);
  assert.equal(blocked.status, 403, 'not this employee\'s manager');
});
