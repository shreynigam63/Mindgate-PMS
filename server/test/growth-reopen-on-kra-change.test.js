// node --test — the growth plan reopens when the KRAs under it change.
//
// Reported on 18 Sep against a screenshot: "Edit option is not available on
// My Growth even after KRAs are reopened on changing department, designation
// or role. Please check the exact issue as to why it is not fetched directly
// from My KRAs."
//
// The existing reopen (growth-reopen-on-profile-change.test.js) fires when
// HR changes somebody's job. But the KRAs do not change at that moment —
// the employee refills My KRAs and resubmits LATER, and that is when their
// objectives actually become different ones. Nothing reopened the plan at
// that second moment, so an employee who had resubmitted their plan in
// between was locked out holding goals aimed at KRAs that no longer
// existed. growthEditable() checks the plan status FIRST, so the state of
// the sheet could not rescue them.
//
// THE TESTS THAT CARRY THE WEIGHT:
//   - the round trip: submit KRAs -> plan reopens -> employee re-points the
//     goal -> resubmits -> the flag is CLEARED. Without that last step a
//     manager's return weeks later would still read "KRAs changed".
//   - a goal that still matches does NOT reopen the plan. Getting this
//     wrong reopens every plan on the instance on every KRA submission.
//   - relinking runs BEFORE the orphan check, so a goal whose kra_id was
//     nulled by the old delete-and-reinsert save is repaired rather than
//     treated as stale.
//   - two KRAs sharing a title are left unlinked rather than guessed at.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, hrId, sheetId, planId, empTok, hrTok, sync;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const plan = async () => (await db.query(
  `SELECT status, reopened_reason, manager_comment FROM pms.development_plans WHERE id=$1`,
  [planId])).rows[0];
const setPlan = async (status) => db.query(
  `UPDATE pms.development_plans SET status=$1, reopened_reason=NULL, manager_comment=NULL WHERE id=$2`,
  [status, planId]);
const setSheet = async (status) => db.query(
  `UPDATE pms.kra_sheets SET status=$1, reopened_reason=NULL WHERE id=$2`, [status, sheetId]);

// Replace the sheet's KRAs wholesale, the way a refill after a role change
// does. Returns the new rows so a test can assert on their ids.
const putKras = async (titles) => {
  await db.query(`DELETE FROM pms.kras WHERE sheet_id=$1`, [sheetId]);
  const out = [];
  let i = 10;
  for (const t of titles) {
    out.push((await db.query(
      `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, title`,
      [tenantId, sheetId, t, 100 / titles.length, i])).rows[0]);
    i += 10;
  }
  return out;
};
const putGoal = async (title, servesKra, kraId = null) => (await db.query(
  `INSERT INTO pms.development_goals (tenant_id, plan_id, title, target_date, serves_kra, kra_id, sort_order)
   VALUES ($1,$2,$3,'2027-03-31',$4,$5,10) RETURNING id`,
  [tenantId, planId, title, servesKra, kraId])).rows[0].id;
const clearGoals = async () => db.query(`DELETE FROM pms.development_goals WHERE plan_id=$1`, [planId]);
const goalRow = async (id) => (await db.query(
  `SELECT kra_id, serves_kra FROM pms.development_goals WHERE id=$1`, [id])).rows[0];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-krachange';
  process.env.TENANT_SLUG = 'krachange-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  sync = require('../modules/performance/kra-goal-sync');

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  mgrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation)
     VALUES ($1,'KC Mgr','kc-mgr@x.com','active','Manager') RETURNING id`, [t.id])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,manager_id)
     VALUES ($1,'KC Emp','kc-emp@x.com','active','Executive',$2) RETURNING id`,
    [t.id, mgrId])).rows[0].id;
  hrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation)
     VALUES ($1,'KC HR','kc-hr@x.com','active','HR') RETURNING id`, [t.id])).rows[0].id;
  for (const email of ['kc-emp@x.com', 'kc-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'kc-hr@x.com','admin')`, [t.id]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase)
     VALUES ($1,'KC Cycle','FY26','kra_open') RETURNING id`, [t.id])).rows[0].id;
  sheetId = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'draft') RETURNING id`, [t.id, cycleId, empId, mgrId])).rows[0].id;
  planId = (await db.query(
    `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'submitted') RETURNING id`, [t.id, cycleId, empId, mgrId])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  empTok = await login('kc-emp@x.com');
  hrTok = await login('kc-hr@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('SUBMITTING A DIFFERENT SET OF KRAs REOPENS THE PLAN, AND SAYS WHY', { skip }, async () => {
  // The employee's plan was submitted while they held the OLD KRAs. Their
  // job changed, they refilled the sheet, and now they submit it: the goal
  // still names an objective that is not there any more.
  await clearGoals();
  await putKras(['Infra SLA governance']);
  await putGoal('Learn server sizing', 'Data centre capacity planning');   // gone from the sheet
  await setPlan('submitted');
  await setSheet('returned');

  const r = await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.growth_plan_reopened, true, 'the response says the plan came back');

  const p = await plan();
  assert.equal(p.status, 'returned');
  assert.equal(p.reopened_reason, 'kra_changed', 'NOT profile_change and NOT null');
  assert.match(p.manager_comment, /no longer on your sheet/);
  assert.match(p.manager_comment, /submit again/);
});

test('a goal that still names a live KRA leaves the plan alone', { skip }, async () => {
  // The case that matters for blast radius: if this reopened anyway, every
  // plan on the instance would come back on every KRA submission.
  await clearGoals();
  const kras = await putKras(['Infra SLA governance', 'Cost optimisation']);
  await putGoal('Deepen SLA reporting', 'Infra SLA governance', kras[0].id);
  await setPlan('submitted');
  await setSheet('returned');

  const r = await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.growth_plan_reopened, false);
  assert.equal((await plan()).status, 'submitted', 'still with the manager, as it should be');
});

test('a goal tied to no KRA at all is never treated as stale', { skip }, async () => {
  // "Not tied to a KRA" is a legitimate answer — a language course serves
  // the person, not one objective — and must not drag the plan open.
  await clearGoals();
  await putKras(['Infra SLA governance']);
  await putGoal('Business English course', null);
  await setPlan('submitted');
  await setSheet('returned');

  await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal((await plan()).status, 'submitted');
});

test('A NULLED kra_id IS REPAIRED BEFORE ANYTHING IS JUDGED STALE', { skip }, async () => {
  // This is defect 2. Until the id-preserving save landed, writing a sheet
  // deleted and re-inserted every KRA, and the FK (ON DELETE SET NULL)
  // wiped kra_id on every goal pointing at them. Such a goal is NOT stale —
  // its title still identifies a KRA on the sheet — so it must be relinked,
  // not used as grounds to reopen the plan.
  await clearGoals();
  const kras = await putKras(['Infra SLA governance']);
  const gid = await putGoal('Deepen SLA reporting', 'Infra SLA governance', null);  // id lost
  await setPlan('submitted');
  await setSheet('returned');

  const r = await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(r.body.goals_relinked, 1, 'the pointer was restored');
  assert.equal(r.body.growth_plan_reopened, false, 'and so it was NOT called stale');
  assert.equal((await goalRow(gid)).kra_id, kras[0].id);
  assert.equal((await plan()).status, 'submitted');
});

test('relinking is case- and whitespace-insensitive, as the upload path is', { skip }, async () => {
  await clearGoals();
  const kras = await putKras(['Infra SLA Governance']);
  const gid = await putGoal('Deepen SLA reporting', '  infra sla governance  ', null);
  await setPlan('submitted');
  await setSheet('returned');

  await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal((await goalRow(gid)).kra_id, kras[0].id);
});

test('two KRAs sharing a title are left unlinked rather than guessed at', { skip }, async () => {
  // A wrong kra_id would quietly mis-attribute the goal in the manager's
  // view. The frozen title renders identically either way, so leaving the
  // pointer null is the honest outcome — and the goal is not stale either,
  // because the title IS on the sheet.
  await clearGoals();
  await putKras(['Duplicated KRA', 'Duplicated KRA']);
  const gid = await putGoal('Something', 'Duplicated KRA', null);
  await setPlan('submitted');
  await setSheet('returned');

  const r = await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(r.body.goals_relinked, 0, 'no guess was made');
  assert.equal((await goalRow(gid)).kra_id, null);
  assert.equal(r.body.growth_plan_reopened, false, 'and the title still matches, so not stale');
});

test('a draft plan is already the employee\'s, so it is relinked but not "reopened"', { skip }, async () => {
  await clearGoals();
  const kras = await putKras(['Infra SLA governance']);
  const gid = await putGoal('Deepen SLA reporting', 'Infra SLA governance', null);
  await putGoal('Old thing', 'A KRA that is gone');
  await setPlan('draft');
  await setSheet('returned');

  const r = await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(r.body.goals_relinked, 1, 'the repair still happens');
  assert.equal(r.body.growth_plan_reopened, false, 'nothing to reopen');
  const p = await plan();
  assert.equal(p.status, 'draft', 'and it is NOT dragged to returned');
  assert.equal(p.reopened_reason, null, 'nor labelled');
  assert.equal((await goalRow(gid)).kra_id, kras[0].id);
});

test('an APPROVED plan reopens too — it is just as wrong for the new KRAs', { skip }, async () => {
  await clearGoals();
  await putKras(['Infra SLA governance']);
  await putGoal('Learn server sizing', 'Data centre capacity planning');
  await setPlan('approved');
  await setSheet('returned');

  await req('POST', '/pms/my/kra-sheet/submit', empTok);
  const p = await plan();
  assert.equal(p.status, 'returned');
  assert.equal(p.reopened_reason, 'kra_changed');
});

test('the reopen is audited, naming the goals and the KRAs they lost', { skip }, async () => {
  await db.query(`DELETE FROM core.audit_log WHERE tenant_id=$1 AND action='DEVPLAN_REOPENED_KRA_CHANGED'`, [tenantId]);
  await clearGoals();
  await putKras(['Infra SLA governance']);
  await putGoal('Learn server sizing', 'Data centre capacity planning');
  await setPlan('submitted');
  await setSheet('returned');

  await req('POST', '/pms/my/kra-sheet/submit', empTok);

  const rows = (await db.query(
    `SELECT actor_email, entity, details FROM core.audit_log
      WHERE tenant_id=$1 AND action='DEVPLAN_REOPENED_KRA_CHANGED'`, [tenantId])).rows;
  assert.equal(rows.length, 1, '"why is my plan open again" has one queryable answer');
  assert.equal(rows[0].actor_email, 'kc-emp@x.com');
  assert.equal(rows[0].entity, 'development_plans');
  assert.equal(rows[0].details.employee_id, empId);
  assert.equal(rows[0].details.orphaned_goals[0].goal, 'Learn server sizing');
  assert.equal(rows[0].details.orphaned_goals[0].served_kra, 'Data centre capacity planning');
});

test('both sides are notified', { skip }, async () => {
  const count = async (who) => (await db.query(
    `SELECT count(*)::int AS n FROM core.notifications
      WHERE tenant_id=$1 AND employee_id=$2 AND kind='devplan_reopened'`, [tenantId, who])).rows[0].n;
  await db.query(`DELETE FROM core.notifications WHERE tenant_id=$1 AND kind='devplan_reopened'`, [tenantId]);
  await clearGoals();
  await putKras(['Infra SLA governance']);
  await putGoal('Learn server sizing', 'Data centre capacity planning');
  await setPlan('submitted');
  await setSheet('returned');

  await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(await count(empId), 1, 'the employee, whose plan came back with nobody pressing a button');
  assert.equal(await count(mgrId), 1, 'the manager, whose queue it left');
});

test('HR submitting on somebody\'s behalf follows the same rule', { skip }, async () => {
  // HR entering an employee's KRAs for them changes those KRAs just as
  // much. This path is the backstop for people who do not self-serve, so
  // it must not be the one that leaves a stale plan locked.
  await clearGoals();
  await putKras(['Infra SLA governance']);
  await putGoal('Learn server sizing', 'Data centre capacity planning');
  await setPlan('submitted');
  await setSheet('returned');

  const r = await req('POST', `/pms/hr/kra-sheet/${empId}/submit`, hrTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.growth_plan_reopened, true);
  const p = await plan();
  assert.equal(p.reopened_reason, 'kra_changed');
});

test('THE ROUND TRIP — reopened, re-pointed, resubmitted, AND THE FLAG IS CLEARED', { skip }, async () => {
  // The bug the KRA sheet had and this must not repeat: if the flag
  // survives a resubmission, a manager's return WEEKS later still reads
  // "your KRAs changed", blaming a machine for a person's judgement.
  await clearGoals();
  const kras = await putKras(['Infra SLA governance']);
  const gid = await putGoal('Learn server sizing', 'Data centre capacity planning');
  await setPlan('submitted');
  await setSheet('returned');

  // 1. submit the KRAs — the plan comes back, labelled.
  await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal((await plan()).reopened_reason, 'kra_changed');

  // 2. the employee re-points the goal at a KRA they now hold. The editable
  //    view offers exactly this as a dropdown.
  const put = await req('PUT', '/pms/my/development-plan/goals', empTok, {
    goals: [{ id: gid, title: 'Learn server sizing', target_date: '2027-03-31',
              progress_pct: 0, kra_id: kras[0].id, serves_kra: kras[0].title }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // 3. resubmit the plan.
  const sub = await req('POST', '/pms/my/development-plan/submit', empTok);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));

  const p = await plan();
  assert.equal(p.status, 'submitted');
  assert.equal(p.reopened_reason, null, 'the label does not survive the resubmission');
});

test('orphanedGoals(): an empty sheet means "nothing to compare", not "all stale"', { skip }, async () => {
  // Unit-level, because the HTTP submit route refuses a sheet with no KRAs
  // and so can never reach this state — but HR paths and future callers
  // can, and an employee mid-refill holding zero KRAs must not be told
  // every goal is stale.
  const goals = [{ id: 'g1', title: 'x', serves_kra: 'Anything at all' }];
  assert.deepEqual(sync.orphanedGoals(goals, []), []);
  assert.equal(sync.orphanedGoals(goals, [{ id: 'k1', title: 'Something else' }]).length, 1);
});

test('MIGRATION 041 REPAIRS ROWS THE OLD SAVE PATH DAMAGED', { skip }, async () => {
  // The migration runs before this harness creates anything, so a fresh-DB
  // run proves nothing about it. Seed the damage the old delete-and-reinsert
  // save left behind, then invoke up() directly — which is honest because
  // the migration only touches kra_id IS NULL and is therefore idempotent.
  await clearGoals();
  const kras = await putKras(['Infra SLA governance', 'Cost optimisation']);
  const repairable = await putGoal('Deepen SLA reporting', 'Infra SLA governance', null);
  const ambiguousKras = await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order)
     VALUES ($1,$2,'Cost optimisation',0,99) RETURNING id`, [tenantId, sheetId]);
  const ambiguous = await putGoal('Cut spend', 'Cost optimisation', null);   // now two matches
  const orphan = await putGoal('Learn server sizing', 'A KRA nobody has', null);

  await require('../migrations/041-relink-devgoal-kra-ids').up(db);

  assert.equal((await goalRow(repairable)).kra_id, kras[0].id, 'the unambiguous match is restored');
  assert.equal((await goalRow(ambiguous)).kra_id, null, 'the ambiguous one is left alone, not guessed');
  assert.equal((await goalRow(orphan)).kra_id, null, 'and a genuine orphan stays null');
  assert.equal((await goalRow(orphan)).serves_kra, 'A KRA nobody has', 'its title snapshot survives');

  // Running it twice changes nothing more.
  await require('../migrations/041-relink-devgoal-kra-ids').up(db);
  assert.equal((await goalRow(repairable)).kra_id, kras[0].id);

  await db.query(`DELETE FROM pms.kras WHERE id=$1`, [ambiguousKras.rows[0].id]);
});

test('syncGoalsToKras() is a no-op when the employee has no plan row', { skip }, async () => {
  // Somebody who has never opened My Growth has no plan. Creating one here
  // would put a plan in front of them that they never asked for.
  const other = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation)
     VALUES ($1,'KC NoPlan','kc-noplan@x.com','active','Executive') RETURNING id`, [tenantId])).rows[0].id;
  const r = await sync.syncGoalsToKras(tenantId, cycleId, other, { actorEmail: 'kc-hr@x.com' });
  assert.equal(r.plan_id, null);
  assert.equal(r.reopened, false);
  assert.equal((await db.query(
    `SELECT count(*)::int AS n FROM pms.development_plans WHERE employee_id=$1`, [other])).rows[0].n, 0);
});
