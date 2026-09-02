// node --test — the reminder engine against a real Postgres.
//
// The calendar arithmetic is proven next door in reminder-schedule.test.js;
// this file proves the parts that need a database: who a reminder is
// about, whether it is still pending, and — the property the whole design
// rests on — that replaying a window sends nothing twice.
//
// Every case runs on a FIXED date (runReminders takes `now`), because a
// suite whose behaviour depends on the morning it is run is a suite that
// passes until it doesn't.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, runReminders, tenantId, cycleId, empId, mgrId, emp2Id;

const on = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

async function bells(employeeId, kind) {
  const r = await db.query(
    `SELECT title, body FROM core.notifications
      WHERE tenant_id=$1 AND employee_id=$2 AND kind=$3 ORDER BY created_at`,
    [tenantId, employeeId, kind]);
  return r.rows;
}

async function reset() {
  await db.query(`DELETE FROM pms.reminder_log WHERE tenant_id=$1`, [tenantId]);
  await db.query(`DELETE FROM core.notifications WHERE tenant_id=$1`, [tenantId]);
}

async function setPhase(phase) {
  await db.query(`UPDATE pms.cycles SET phase=$2 WHERE id=$1`, [cycleId, phase]);
}

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-rem';
  process.env.TENANT_SLUG = 'rem-test-' + Date.now();
  db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();
  ({ runReminders } = require('../modules/performance'));

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Rem Mgr','rem-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'Rem Emp','rem-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const emp2 = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'Rem Emp Two','rem-emp2@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  emp2Id = emp2.id;

  // opens_at in April 2025 so the whole FY2025 reminder calendar is inside
  // the replay window.
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, opens_at)
     VALUES ($1,'Rem Cycle','FY2025','annual','mid_year_review','2025-04-01') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
});

after(async () => { if (db) await db.pool.end(); });

test('mid-year: the employee is reminded once the September dates pass, and the manager is told how many are outstanding', { skip }, async () => {
  await reset();
  await setPhase('mid_year_review');
  // 16 Sep 2025 — the 1st and the 15th have both passed.
  const r = await runReminders(tenantId, on(2025, 9, 16));

  // Three: both reportees AND the manager, who has a mid-year review of
  // their own to fill in. Being someone's manager does not exempt you.
  assert.equal(r.midyear_self, 3);
  assert.equal(r.midyear_manager, 1, 'one manager, one reminder about their reportees');

  const empBells = await bells(empId, 'midyear_self');
  assert.equal(empBells.length, 1, 'two missed dates produce ONE bell, not two');
  assert.match(empBells[0].title, /Mid-Year Review is not filled in yet/);

  const mgrBells = await bells(mgrId, 'midyear_manager');
  assert.equal(mgrBells.length, 1);
  assert.match(mgrBells[0].title, /2 of your reportees/);
  assert.match(mgrBells[0].body, /Rem Emp/);

  // Both missed occurrences are logged even though only one bell rang —
  // that is what stops the 1st firing again tomorrow.
  const logged = await db.query(
    `SELECT to_char(occurrence,'YYYY-MM-DD') AS d FROM pms.reminder_log
      WHERE tenant_id=$1 AND rule='midyear_self' AND recipient_id=$2 ORDER BY 1`, [tenantId, empId]);
  assert.deepEqual(logged.rows.map((x) => x.d), ['2025-09-01', '2025-09-15']);
});

test('running the sweep again the same day sends nothing — the ledger is the guard', { skip }, async () => {
  const again = await runReminders(tenantId, on(2025, 9, 16));
  assert.equal(again.total, 0, 'a replay is a no-op');
  assert.equal((await bells(empId, 'midyear_self')).length, 1, 'still exactly one bell');
});

test('the next scheduled date rings again — idempotency must not mean "only ever once"', { skip }, async () => {
  const r = await runReminders(tenantId, on(2025, 9, 21)); // the 20th has now passed
  assert.equal(r.midyear_self, 3);
  assert.equal((await bells(empId, 'midyear_self')).length, 2);
});

test('an employee who has submitted stops being reminded', { skip }, async () => {
  await reset();
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id, self_status, self_submitted_at)
     VALUES ($1,$2,$3,$4,'submitted','2025-09-02')`, [tenantId, cycleId, empId, mgrId]);
  const r = await runReminders(tenantId, on(2025, 9, 16));

  assert.equal(r.midyear_self, 2, 'the other reportee, and the manager for their own');
  assert.equal((await bells(empId, 'midyear_self')).length, 0);
  assert.equal((await bells(emp2Id, 'midyear_self')).length, 1);
  const mgrBells = await bells(mgrId, 'midyear_manager');
  assert.match(mgrBells[0].title, /Rem Emp Two's Mid-Year Review is still pending/,
    'one outstanding reportee is named, not counted');
});

test('a reminder is not sent while the phase makes the action impossible — and fires later instead', { skip }, async () => {
  await reset();
  await db.query(`DELETE FROM pms.midyear_checkins WHERE cycle_id=$1`, [cycleId]);
  await setPhase('growth_planning');
  const blocked = await runReminders(tenantId, on(2025, 9, 16));
  assert.equal(blocked.midyear_self, 0, 'the page is locked — a nudge would send them to a wall');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.reminder_log WHERE tenant_id=$1 AND rule='midyear_self'`, [tenantId])).rows[0].n, 0,
    'and nothing is logged, so it is not lost');

  // HR opens the phase in October, late. The catch-up fires then.
  await setPhase('mid_year_review');
  const late = await runReminders(tenantId, on(2025, 10, 3));
  assert.equal(late.midyear_self, 3, 'late, not skipped');
});

test('the post-submission chase starts on day 3, skips the weekend, and rings once a day', { skip }, async () => {
  await reset();
  await db.query(`DELETE FROM pms.midyear_checkins WHERE cycle_id=$1`, [cycleId]);
  await setPhase('mid_year_review');
  // Signed Thursday 4 Sep 2025; three days later is Sunday the 7th.
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id, self_status, self_submitted_at, manager_status)
     VALUES ($1,$2,$3,$4,'submitted','2025-09-04','not_started')`, [tenantId, cycleId, empId, mgrId]);

  assert.equal((await runReminders(tenantId, on(2025, 9, 6))).midyear_chase, 0, 'nothing before day 3');
  assert.equal((await runReminders(tenantId, on(2025, 9, 7))).midyear_chase, 0, 'day 3 is a Sunday — skipped');
  assert.equal((await runReminders(tenantId, on(2025, 9, 8))).midyear_chase, 1, 'Monday');
  assert.equal((await runReminders(tenantId, on(2025, 9, 8))).midyear_chase, 0, 'and only once that day');
  assert.equal((await runReminders(tenantId, on(2025, 9, 9))).midyear_chase, 1, 'again the next weekday');

  const chased = await bells(mgrId, 'midyear_chase');
  assert.equal(chased.length, 2);
  assert.match(chased[0].title, /Rem Emp's Mid-Year Review is waiting on you/);
});

test('the chase stops the moment the manager finalises', { skip }, async () => {
  await db.query(`UPDATE pms.midyear_checkins SET manager_status='submitted' WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId]);
  assert.equal((await runReminders(tenantId, on(2025, 9, 10))).midyear_chase, 0);
});

test('quarterly connect reminds both sides, and skips a pair who already met', { skip }, async () => {
  await reset();
  await setPhase('kra_open'); // nothing mid-year should fire from this run
  // 7 Jul 2025 is the 1st Monday of July, reminding about Apr-Jun.
  // emp2 held a connect inside that quarter; emp did not.
  await db.query(
    `INSERT INTO pms.connects (tenant_id, employee_id, manager_id, held_at) VALUES ($1,$2,$3,'2025-05-20')`,
    [tenantId, emp2Id, mgrId]);

  const r = await runReminders(tenantId, on(2025, 7, 8));
  assert.equal(r.quarterly_connect, 2, 'the employee and their manager — one pair');

  assert.equal((await bells(empId, 'quarterly_connect')).length, 1);
  assert.equal((await bells(emp2Id, 'quarterly_connect')).length, 0, 'they already met that quarter');
  const mgrBells = await bells(mgrId, 'quarterly_connect');
  assert.equal(mgrBells.length, 1);
  assert.match(mgrBells[0].title, /connect due with Rem Emp/);
});

test('annual reminders run in March against the self-appraisal, not the mid-year table', { skip }, async () => {
  await reset();
  await setPhase('self_appraisal');
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'submitted')`,
    [tenantId, cycleId, empId]);

  const r = await runReminders(tenantId, on(2026, 3, 16));
  assert.equal(r.annual_self, 2, 'the reportee who has not submitted, and the manager for their own');
  assert.equal(r.midyear_self, 0, 'the mid-year phase is closed, so nothing fires there');
  assert.equal((await bells(emp2Id, 'annual_self')).length, 1);
  assert.equal((await bells(empId, 'annual_self')).length, 0);
  assert.match((await bells(mgrId, 'annual_manager'))[0].title, /Rem Emp Two's annual self-appraisal is still pending/);
});

test('the annual chase waits on the manager evaluation, and stops when it is submitted', { skip }, async () => {
  await reset();
  await setPhase('manager_eval');
  await db.query(`UPDATE pms.self_appraisals SET submitted_at='2026-03-02' WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId]);

  // Signed Monday 2 Mar 2026; +3 days is Thursday the 5th.
  assert.equal((await runReminders(tenantId, on(2026, 3, 4))).annual_chase, 0);
  assert.equal((await runReminders(tenantId, on(2026, 3, 5))).annual_chase, 1);

  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status)
     VALUES ($1,$2,$3,$4,'submitted')`, [tenantId, cycleId, empId, mgrId]);
  assert.equal((await runReminders(tenantId, on(2026, 3, 6))).annual_chase, 0, 'finalised — stop chasing');
});

test('an inactive employee is neither reminded nor counted against their manager', { skip }, async () => {
  await reset();
  await db.query(`DELETE FROM pms.self_appraisals WHERE cycle_id=$1`, [cycleId]);
  await db.query(`UPDATE core.employees SET status='inactive' WHERE id=$1`, [emp2Id]);
  await setPhase('self_appraisal');

  const r = await runReminders(tenantId, on(2026, 3, 16));
  assert.equal((await bells(emp2Id, 'annual_self')).length, 0, 'they cannot log in at all');
  assert.match((await bells(mgrId, 'annual_manager'))[0].title, /Rem Emp's annual self-appraisal is still pending/);
  assert.equal(r.annual_self, 2, 'the active reportee, and the manager for their own');
  await db.query(`UPDATE core.employees SET status='active' WHERE id=$1`, [emp2Id]);
});
