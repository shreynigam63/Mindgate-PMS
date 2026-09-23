// node --test — the landing screen's data, and who is allowed to see it.
//
// Asked for on 23 Sep: a landing page with quick links instead of
// dropping people onto My KRAs. GET /pms/home answers "what do I owe"
// and "where is everything else" in one request.
//
// THE TEST THAT CARRIES THE WEIGHT is that the team and admin blocks are
// ABSENT for people who may not see them. Those blocks are counts across
// other people — "9 active employees", "3 of 9 sheets approved" — and a
// count is not harmless: it tells you the size of the company and how
// far along everyone else is. A page that renders whatever the API sends
// leaks exactly as much as the API is careless with.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId;
const tok = {};

const get = async (path, t) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-home';
  process.env.TENANT_SLUG = 'home-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await db.query(`INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order)
                  VALUES ($1,'Delivery',60,10), ($1,'Collaboration',40,20)`, [t.id]);

  const mk = async (name, email, managerId) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active','Executive','Delivery',$4) RETURNING id`,
    [t.id, name, email, managerId || null])).rows[0].id;
  await mk('H Admin', 'h-admin@x.com', null);
  mgrId = await mk('H Manager', 'h-mgr@x.com', null);
  empId = await mk('H Report', 'h-emp@x.com', mgrId);

  for (const e of ['h-admin@x.com', 'h-mgr@x.com', 'h-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'h-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'h-mgr@x.com','manager')`, [t.id]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'H Cycle','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['admin', 'h-admin@x.com'], ['manager', 'h-mgr@x.com'], ['employee', 'h-emp@x.com']]) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('an employee gets their own work and nothing about anyone else', { skip }, async () => {
  const { status, body } = await get('/pms/home', tok.employee);
  assert.equal(status, 200);
  assert.equal(body.cycle.name, 'H Cycle');
  assert.equal(body.team, null, 'an employee has no team block');
  assert.equal(body.admin, null, 'an employee has no company counts');
  assert.ok(body.me, 'their own state is present');
});

test('a manager gets a team block but no company counts', { skip }, async () => {
  const { body } = await get('/pms/home', tok.manager);
  assert.ok(body.team, 'a manager has reports, so a team block');
  assert.equal(body.team.reports, 1);
  assert.equal(body.team.scope, 'my_reports');
  assert.equal(body.admin, null, 'a manager must not be handed company-wide counts');
});

test('an admin gets both, and the team block widens to everyone', { skip }, async () => {
  const { body } = await get('/pms/home', tok.admin);
  assert.ok(body.admin, 'admin gets the company counts');
  assert.equal(body.admin.employees, 3);
  assert.equal(body.team.scope, 'all_employees');
});

test('the action is the one thing that is actually due', { skip }, async () => {
  // kra_open, nothing drafted: the employee owes their KRAs.
  let r = await get('/pms/home', tok.employee);
  assert.equal(r.body.action.kind, 'kra_due');

  // Submitted: it is now the manager's move, not theirs.
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now())`, [tenantId, cycleId, empId, mgrId]);
  r = await get('/pms/home', tok.employee);
  assert.equal(r.body.action.kind, 'clear', 'nothing is waiting on the employee now');

  // The manager has a report waiting — but has not drafted their OWN KRAs
  // either, and their own work outranks work they owe others. Nobody else
  // can write their sheet; someone else could chase the approval.
  r = await get('/pms/home', tok.manager);
  assert.equal(r.body.action.kind, 'kra_due', "the manager's own sheet comes first");
  assert.equal(r.body.team.kra_pending, 1, 'the team queue is still counted, just not the banner');

  // Once their own sheet is in, the banner moves to the queue they owe.
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status,submitted_at)
     VALUES ($1,$2,$3,'submitted',now())`, [tenantId, cycleId, mgrId]);
  r = await get('/pms/home', tok.manager);
  assert.equal(r.body.action.kind, 'team_pending');
  assert.match(r.body.action.title, /1 person is waiting on you/);

  // Returned outranks everything: it is the employee's move again.
  await db.query(`UPDATE pms.kra_sheets SET status='returned', manager_comment='Weights'
                   WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId]);
  r = await get('/pms/home', tok.employee);
  assert.equal(r.body.action.kind, 'kra_returned');
  assert.equal(r.body.action.detail, 'Weights', "the manager's reason is carried to the banner");
});

test('someone with no KRA sheet row at all is told to start, not told they are clear', { skip }, async () => {
  // Regression. The first cut guarded this branch with `kra && ...`, so an
  // employee who had never opened the product — no pms.kra_sheets row —
  // fell through every branch to "Nothing is waiting on you". The one
  // person who most needs telling was the one person not told.
  const { nextAction } = require('../modules/performance/home');
  assert.equal(nextAction({ phase: 'kra_open', kra: null, teamPending: 0 }).kind, 'kra_due');
  assert.equal(nextAction({ phase: 'mid_year_review', kra: { status: 'approved' }, midyear: null, teamPending: 0 }).kind, 'midyear_due');
  assert.equal(nextAction({ phase: 'self_appraisal', kra: { status: 'approved' }, appraisal: null, teamPending: 0 }).kind, 'appraisal_due');
});

test('the dashboard numbers are real counts, and stay scoped to the caller', { skip }, async () => {
  // The stat strip and the coloured desk tiles are all driven from this
  // one response. A dashboard number nobody can trace is worse than no
  // number, so each one is asserted against rows put in here.
  const plan = (await db.query(
    `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'approved') RETURNING id`, [tenantId, cycleId, empId, mgrId])).rows[0].id;
  await db.query(
    `INSERT INTO pms.development_goals (tenant_id,plan_id,title,progress_pct)
     VALUES ($1,$2,'Ship the importer',100), ($1,$2,'Mentor a junior',40)`, [tenantId, plan]);
  const con = (await db.query(
    `INSERT INTO pms.connects (tenant_id,manager_id,employee_id,held_at,notes)
     VALUES ($1,$2,$3,now(),'first 1-on-1') RETURNING id`, [tenantId, mgrId, empId])).rows[0].id;
  await db.query(
    `INSERT INTO pms.connect_action_items (tenant_id,connect_id,description,done)
     VALUES ($1,$2,'Write the design note',false), ($1,$2,'Book the training',true)`, [tenantId, con]);

  const { body } = await get('/pms/home', tok.employee);
  assert.equal(body.me.goals.total, 2);
  assert.equal(body.me.goals.done, 1, 'only the 100% one counts as done');
  assert.equal(body.me.goals.status, 'approved');
  assert.equal(body.me.connects.logged, 1);
  assert.equal(body.me.connects.open_actions, 1, 'the completed action is not outstanding');

  // The manager has one report and has now held a connect with them, so
  // nobody is un-met. The admin sees the two people nobody has met.
  const mgr = await get('/pms/home', tok.manager);
  assert.equal(mgr.body.team.no_connect, 0);
  const adm = await get('/pms/home', tok.admin);
  assert.equal(adm.body.team.scope, 'all_employees');
  assert.equal(adm.body.team.no_connect, 2, 'the admin and the manager have had none');
  assert.equal(adm.body.admin.kra_awaiting, 1, 'one sheet is submitted and undecided');

  // And none of it leaks: the employee gets no team or company numbers at
  // all, however interesting the counts are.
  assert.equal(body.team, null);
  assert.equal(body.admin, null);
});

test('in evaluation season a manager is told about evaluations, not silence', { skip }, async () => {
  // The KRA queue is empty by manager_eval (sheets are approved), so the
  // team_pending branch cannot speak for this phase. Without its own
  // branch a manager owing every assessment is told they are up to date.
  const { nextAction } = require('../modules/performance/home');
  const team = { reports: 4, evals_done: 1, kra_pending: 0 };
  const a = nextAction({ phase: 'manager_eval', kra: { status: 'approved' }, team, teamPending: 0 });
  assert.equal(a.kind, 'evals_due');
  assert.match(a.title, /3 evaluations to write/);
  assert.equal(nextAction({ phase: 'manager_eval', kra: { status: 'approved' },
    team: { reports: 4, evals_done: 4, kra_pending: 0 }, teamPending: 0 }).kind, 'clear');
});

test('no open cycle is said plainly, not rendered as an error', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  const { status, body } = await get('/pms/home', tok.employee);
  assert.equal(status, 200);
  assert.equal(body.cycle, null);
  assert.equal(body.action.kind, 'no_cycle');
});
