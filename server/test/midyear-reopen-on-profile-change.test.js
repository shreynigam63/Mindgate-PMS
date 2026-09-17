// node --test — the Mid-Year Review reopens when the job changes.
//
// Asked for on 17 Sep: "apply the same changes to mid-year tab as well",
// after the KRA sheet (037) and the growth plan (039).
//
// MID-YEAR IS THE ODD ONE OUT and these tests exist mostly to pin that.
// It has no 'returned' status and no comment column, so a reopen lands on
// 'in_progress' with its reason in reopened_note. The tests that carry the
// weight:
//   - NOTHING WRITTEN IS LOST: ratings, narratives and both per-KRA entry
//     maps survive a reopen untouched. Only the status moves.
//   - both halves reopen, and a half that was never submitted is left
//     exactly as it was.
//   - the flag is cleared by EITHER party submitting.
//
// Real Postgres, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, tenantId, cycleId, empId, mgrId, pc;

const row = async () => (await db.query(
  `SELECT * FROM pms.midyear_checkins WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];

const SELF_ENTRIES = { 'k-1': { rating: 4, narrative: 'shipped the migration' } };
const MGR_ENTRIES = { 'k-1': { rating: 3, narrative: 'solid, needs range' } };

const setUp = async (selfStatus, mgrStatus) => db.query(
  `UPDATE pms.midyear_checkins
      SET self_status=$1, manager_status=$2,
          self_rating=4.0, manager_rating=3.0,
          self_narrative='My own words, written by me.',
          manager_narrative='The manager''s own words.',
          self_entries=$3::jsonb, manager_entries=$4::jsonb,
          self_submitted_at=CASE WHEN $1='submitted' THEN now() ELSE NULL END,
          manager_submitted_at=CASE WHEN $2='submitted' THEN now() ELSE NULL END,
          reopened_reason=NULL, reopened_note=NULL
    WHERE cycle_id=$5 AND employee_id=$6`,
  [selfStatus, mgrStatus, JSON.stringify(SELF_ENTRIES), JSON.stringify(MGR_ENTRIES), cycleId, empId]);

const notifCount = async () => (await db.query(
  `SELECT count(*)::int AS n FROM core.notifications WHERE tenant_id=$1 AND kind='midyear_reopened'`,
  [tenantId])).rows[0].n;

const DEPT_CHANGE = [{ field: 'Department', from: 'Admin', to: 'Finance' }];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-midreopen';
  process.env.TENANT_SLUG = 'midreopen-test-' + Date.now();
  db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();
  pc = require('../modules/performance/profile-change');

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  mgrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'MY Mgr','my-mgr@x.com','active') RETURNING id`,
    [t.id])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,'MY Emp','my-emp@x.com','active','Executive','Admin',$2) RETURNING id`,
    [t.id, mgrId])).rows[0].id;
  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase) VALUES ($1,'MY Cycle','FY26','mid_year_review') RETURNING id`,
    [t.id])).rows[0].id;
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id,cycle_id,employee_id,manager_id) VALUES ($1,$2,$3,$4)`,
    [t.id, cycleId, empId, mgrId]);
});

after(async () => { if (HAS_DB) await db.pool.end(); });

test('migration 040 added both columns', { skip }, async () => {
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='pms' AND table_name='midyear_checkins'
        AND column_name IN ('reopened_reason','reopened_note') ORDER BY 1`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ['reopened_note', 'reopened_reason']);
});

test('A SUBMITTED MID-YEAR REOPENS TO in_progress, NOT returned', { skip }, async () => {
  await setUp('submitted', 'submitted');
  const out = await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, { actorEmail: 'hr@x.com' });
  assert.equal(out.length, 1);

  const r = await row();
  assert.equal(r.self_status, 'in_progress', "mid-year has no 'returned' state");
  assert.equal(r.manager_status, 'in_progress');
  assert.equal(r.reopened_reason, 'profile_change');
  assert.match(r.reopened_note, /Department: Admin → Finance/);
  assert.match(r.reopened_note, /mid-year review/i);
  assert.equal(r.self_submitted_at, null, 'the submitted timestamp is cleared');
  assert.equal(r.manager_submitted_at, null);
});

test('NOTHING WRITTEN IS LOST — ratings, narratives and per-KRA entries survive', { skip }, async () => {
  await setUp('submitted', 'submitted');
  await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {});
  const r = await row();
  assert.equal(Number(r.self_rating), 4, 'the self rating is kept');
  assert.equal(Number(r.manager_rating), 3, 'the manager rating is kept');
  assert.equal(r.self_narrative, 'My own words, written by me.');
  assert.equal(r.manager_narrative, "The manager's own words.");
  assert.deepEqual(r.self_entries, SELF_ENTRIES, 'per-KRA self entries untouched');
  assert.deepEqual(r.manager_entries, MGR_ENTRIES, 'per-KRA manager entries untouched');
});

test('a half that was never submitted is left exactly as it was', { skip }, async () => {
  await setUp('submitted', 'in_progress');
  const out = await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {});
  assert.equal(out.length, 1, 'one submitted half is enough to reopen');
  const r = await row();
  assert.equal(r.self_status, 'in_progress');
  assert.equal(r.manager_status, 'in_progress', 'unchanged, it was already in_progress');

  await setUp('not_started', 'submitted');
  await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {});
  const r2 = await row();
  assert.equal(r2.self_status, 'not_started', 'not dragged forward to in_progress');
  assert.equal(r2.manager_status, 'in_progress');
});

test('a mid-year with neither half submitted is not touched and spends no notification', { skip }, async () => {
  for (const pair of [['not_started', 'not_started'], ['in_progress', 'in_progress']]) {
    await setUp(pair[0], pair[1]);
    const n0 = await notifCount();
    const out = await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {});
    assert.equal(out.length, 0, `${pair.join('/')} is already open`);
    const r = await row();
    assert.equal(r.reopened_reason, null);
    assert.equal(await notifCount(), n0, 'no notification spent');
  }
});

test('no watched change reopens nothing', { skip }, async () => {
  await setUp('submitted', 'submitted');
  assert.deepEqual(await pc.reopenLockedMidyear(tenantId, empId, [], {}), []);
  assert.equal((await row()).self_status, 'submitted');
});

test('a closed or cancelled cycle is history', { skip }, async () => {
  for (const dead of ['closed', 'cancelled', 'draft']) {
    await setUp('submitted', 'submitted');
    await db.query(`UPDATE pms.cycles SET phase=$1 WHERE id=$2`, [dead, cycleId]);
    assert.equal((await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {})).length, 0, `phase ${dead}`);
    assert.equal((await row()).self_status, 'submitted');
  }
  await db.query(`UPDATE pms.cycles SET phase='mid_year_review' WHERE id=$1`, [cycleId]);
});

test('a name-only edit reopens nothing — the nightly-sync guard', { skip }, async () => {
  await setUp('submitted', 'submitted');
  const r = await pc.applyProfileChange(tenantId, empId,
    { department: 'Admin', designation: 'Executive' },
    { department: ' Admin ', designation: 'Executive' }, {});
  assert.deepEqual(r.changes, []);
  assert.equal(r.reopened_midyear.length, 0);
  assert.equal((await row()).self_status, 'submitted');
});

test('both sides are notified', { skip }, async () => {
  await setUp('submitted', 'submitted');
  const n0 = await notifCount();
  await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {});
  assert.equal(await notifCount(), n0 + 2);
  const who = (await db.query(
    `SELECT employee_id FROM core.notifications WHERE tenant_id=$1 AND kind='midyear_reopened'
      ORDER BY created_at DESC LIMIT 2`, [tenantId])).rows.map((x) => x.employee_id);
  assert.ok(who.includes(empId) && who.includes(mgrId));
});

test('the reopen is audited with the change that caused it', { skip }, async () => {
  await setUp('submitted', 'submitted');
  await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, { actorEmail: 'hr.audit@x.com' });
  const a = (await db.query(
    `SELECT actor_email, details FROM core.audit_log
      WHERE tenant_id=$1 AND action='MIDYEAR_REOPENED_PROFILE_CHANGE' ORDER BY id DESC LIMIT 1`,
    [tenantId])).rows[0];
  assert.ok(a);
  assert.equal(a.actor_email, 'hr.audit@x.com');
  assert.deepEqual(a.details.changes, DEPT_CHANGE);
});

test('applyProfileChange reports all THREE artifacts under separate keys', { skip }, async () => {
  await setUp('submitted', 'submitted');
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'submitted')
     ON CONFLICT (cycle_id, employee_id) DO UPDATE SET status='submitted', reopened_reason=NULL`,
    [tenantId, cycleId, empId, mgrId]);
  await db.query(
    `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'submitted')
     ON CONFLICT (cycle_id, employee_id) DO UPDATE SET status='submitted', reopened_reason=NULL`,
    [tenantId, cycleId, empId, mgrId]);

  const r = await pc.applyProfileChange(tenantId, empId,
    { designation: 'Executive' }, { designation: 'Senior Executive' }, {});
  assert.equal(r.reopened.length, 1, 'kra sheet');
  assert.equal(r.reopened_growth_plans.length, 1, 'growth plan');
  assert.equal(r.reopened_midyear.length, 1, 'mid-year');
});

test('EITHER party submitting clears the flag', { skip }, async () => {
  // Mirrors the SQL both submit routes run. The KRA side shipped without
  // this and a later, unrelated return still read "role changed".
  for (const half of ['self', 'manager']) {
    await setUp('submitted', 'submitted');
    await pc.reopenLockedMidyear(tenantId, empId, DEPT_CHANGE, {});
    assert.equal((await row()).reopened_reason, 'profile_change');

    await db.query(
      `UPDATE pms.midyear_checkins
          SET ${half}_status='submitted', ${half}_submitted_at=now(),
              reopened_reason=NULL, reopened_note=NULL
        WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId]);
    const r = await row();
    assert.equal(r.reopened_reason, null, `${half} submitting clears it`);
    assert.equal(r.reopened_note, null);
  }
});
