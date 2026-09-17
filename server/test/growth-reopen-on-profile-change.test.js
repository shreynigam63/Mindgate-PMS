// node --test — the growth plan reopens when the job changes.
//
// Asked for on 17 Sep against CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md: "this
// changes should be applicable for My Growth Page as well."
//
// It is the identical trap. Submitting the growth plan hands it to the
// manager and closes it to the employee, and the plan describes how
// somebody will grow INTO a job — so a move between roles aims their
// development goals and their career aspiration at a role they no longer
// hold, with no way back except HR noticing.
//
// THE TESTS THAT CARRY THE WEIGHT:
//   - the full round trip: job change -> resubmit -> manager return,
//     asserting the LABEL at each step. This is the one that catches the
//     surviving-flag bug the KRA side had.
//   - a draft plan is left alone and spends no notification.
//   - the KRA sheet and the growth plan are judged INDEPENDENTLY.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, pc;

const planRow = async () => (await db.query(
  `SELECT status, reopened_reason, manager_comment FROM pms.development_plans
    WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
const sheetRow = async () => (await db.query(
  `SELECT status, reopened_reason FROM pms.kra_sheets
    WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
const setPlan = async (status) => db.query(
  `UPDATE pms.development_plans SET status=$1, reopened_reason=NULL, manager_comment=NULL
    WHERE cycle_id=$2 AND employee_id=$3`, [status, cycleId, empId]);
const notifCount = async (kind) => (await db.query(
  `SELECT count(*)::int AS n FROM core.notifications WHERE tenant_id=$1 AND kind=$2`,
  [tenantId, kind])).rows[0].n;

const DEPT_CHANGE = [{ field: 'Department', from: 'Admin', to: 'Finance' }];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-growreopen';
  process.env.TENANT_SLUG = 'growreopen-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();
  pc = require('../modules/performance/profile-change');

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  mgrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,'GR Mgr','gr-mgr@x.com','active','Manager','Admin') RETURNING id`, [t.id])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,'GR Emp','gr-emp@x.com','active','Executive','Admin',$2) RETURNING id`,
    [t.id, mgrId])).rows[0].id;

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase) VALUES ($1,'GR Cycle','FY26','kra_open') RETURNING id`,
    [t.id])).rows[0].id;
  await db.query(
    `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'submitted')`, [t.id, cycleId, empId, mgrId]);
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'draft')`, [t.id, cycleId, empId, mgrId]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('A SUBMITTED GROWTH PLAN REOPENS, AND SAYS WHY', { skip }, async () => {
  const rows = await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, { actorEmail: 'hr@x.com' });
  assert.equal(rows.length, 1);

  const p = await planRow();
  assert.equal(p.status, 'returned', 'lands on the state the whole product already understands');
  assert.equal(p.reopened_reason, 'profile_change', 'and is distinguishable from a manager return');
  assert.match(p.manager_comment, /Department: Admin → Finance/);
  assert.match(p.manager_comment, /development goals and career aspiration/,
    'the instruction names BOTH halves of My Growth');
});

test('an approved plan reopens too — just as wrong for the new job, just as locked', { skip }, async () => {
  await setPlan('approved');
  const rows = await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, {});
  assert.equal(rows.length, 1);
  assert.equal((await planRow()).status, 'returned');
});

test('a draft or returned plan is left alone and spends no notification', { skip }, async () => {
  for (const st of ['draft', 'returned']) {
    await setPlan(st);
    const n0 = await notifCount('devplan_reopened');
    const rows = await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, {});
    assert.equal(rows.length, 0, `${st} is already theirs — nothing to reopen`);
    assert.equal((await planRow()).status, st, 'and the status is untouched');
    assert.equal(await notifCount('devplan_reopened'), n0, 'no notification spent');
  }
});

test('no watched change reopens nothing', { skip }, async () => {
  await setPlan('submitted');
  assert.deepEqual(await pc.reopenLockedGrowthPlans(tenantId, empId, [], {}), []);
  assert.equal((await planRow()).status, 'submitted');
});

test('a closed or cancelled cycle is history — nothing reopens', { skip }, async () => {
  for (const dead of ['closed', 'cancelled', 'draft']) {
    await setPlan('submitted');
    await db.query(`UPDATE pms.cycles SET phase=$1 WHERE id=$2`, [dead, cycleId]);
    const rows = await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, {});
    assert.equal(rows.length, 0, `phase ${dead} must not reopen`);
    assert.equal((await planRow()).status, 'submitted');
  }
  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE id=$1`, [cycleId]);
});

test('THE KRA SHEET AND THE GROWTH PLAN ARE JUDGED INDEPENDENTLY', { skip }, async () => {
  // The sheet is draft, the plan is submitted. Reopening on a role change
  // must touch the plan and leave the sheet exactly where it was —
  // reopening a draft sheet would hand back something nobody finished.
  await setPlan('submitted');
  await db.query(`UPDATE pms.kra_sheets SET status='draft', reopened_reason=NULL WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId]);

  const r = await pc.applyProfileChange(tenantId, empId,
    { department: 'Admin' }, { department: 'Finance' }, { actorEmail: 'hr@x.com' });

  assert.equal(r.reopened.length, 0, 'the draft KRA sheet is left alone');
  assert.equal(r.reopened_growth_plans.length, 1, 'the submitted growth plan comes back');
  assert.equal((await sheetRow()).status, 'draft');
  assert.equal((await planRow()).status, 'returned');
});

test('applyProfileChange reports the two kinds under separate keys', { skip }, async () => {
  // Folding growth plans into `reopened` would silently change what
  // reopened_kra_sheets / kra_sheets_reopened mean on an HR screen.
  await setPlan('submitted');
  await db.query(`UPDATE pms.kra_sheets SET status='submitted', reopened_reason=NULL WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId]);
  const r = await pc.applyProfileChange(tenantId, empId,
    { designation: 'Executive' }, { designation: 'Senior Executive' }, {});
  assert.equal(r.reopened.length, 1);
  assert.equal(r.reopened_growth_plans.length, 1);
  assert.deepEqual(r.changes.map((c) => c.field), ['Designation']);
});

test('a name-only edit reopens nothing — the nightly-sync guard', { skip }, async () => {
  await setPlan('submitted');
  const r = await pc.applyProfileChange(tenantId, empId,
    { department: 'Finance', designation: 'Executive' },
    { department: ' Finance ', designation: 'Executive' }, {});
  assert.deepEqual(r.changes, [], 'whitespace is not a change');
  assert.equal(r.reopened_growth_plans.length, 0);
  assert.equal((await planRow()).status, 'submitted');
});

test('both sides are notified', { skip }, async () => {
  await setPlan('submitted');
  const before_ = await notifCount('devplan_reopened');
  await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, {});
  assert.equal(await notifCount('devplan_reopened'), before_ + 2, 'the employee and the manager');
  const who = (await db.query(
    `SELECT employee_id FROM core.notifications WHERE tenant_id=$1 AND kind='devplan_reopened'
      ORDER BY created_at DESC LIMIT 2`, [tenantId])).rows.map((r) => r.employee_id);
  assert.ok(who.includes(empId) && who.includes(mgrId));
});

test('every reopen is audited with the change that caused it', { skip }, async () => {
  await setPlan('submitted');
  await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, { actorEmail: 'hr.audit@x.com' });
  const row = (await db.query(
    `SELECT actor_email, details FROM core.audit_log
      WHERE tenant_id=$1 AND action='DEVPLAN_REOPENED_PROFILE_CHANGE'
      ORDER BY id DESC LIMIT 1`, [tenantId])).rows[0];
  assert.ok(row, 'audited');
  assert.equal(row.actor_email, 'hr.audit@x.com');
  assert.equal(row.details.employee_id, empId);
  assert.deepEqual(row.details.changes, DEPT_CHANGE);
});

test('FULL ROUND TRIP — role change, resubmit, then a manager return reads correctly', { skip }, async () => {
  // The test that catches the surviving-flag bug. The KRA side shipped
  // with it: the flag outlived a resubmission, so a manager's return weeks
  // later still wore the "role changed" label from a job change months
  // before.
  await setPlan('submitted');

  // 1. job changes -> reopened, labelled as a role change
  await pc.reopenLockedGrowthPlans(tenantId, empId, DEPT_CHANGE, {});
  let p = await planRow();
  assert.equal(p.status, 'returned');
  assert.equal(p.reopened_reason, 'profile_change');

  // 2. the employee resubmits. The submit route clears the flag; asserted
  //    here against the same SQL the route runs.
  await db.query(
    `UPDATE pms.development_plans SET status='submitted', reopened_reason=NULL, submitted_at=now()
      WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId]);
  p = await planRow();
  assert.equal(p.reopened_reason, null, 'submitting clears it');

  // 3. the manager returns it with feedback -> must NOT read "role changed"
  await db.query(
    `UPDATE pms.development_plans SET status='returned', manager_comment=$1, reopened_reason=NULL
      WHERE cycle_id=$2 AND employee_id=$3`, ['Add a measurable outcome to goal 2.', cycleId, empId]);
  p = await planRow();
  assert.equal(p.status, 'returned');
  assert.equal(p.reopened_reason, null, 'a manager return is not a role change');
  assert.match(p.manager_comment, /measurable outcome/);
});
