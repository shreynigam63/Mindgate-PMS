// The seven-day self chase.
//
// Asked for: "auto-trigger email reminders if an appraisal form remains
// pending at any level (Self/Manager) beyond 7 days."
//
// The manager level already had this — four chases that ring three days
// after an employee submits. The level that had nothing was the employee
// whose own form is simply not submitted, which is also the level where
// nothing else can fire: the manager chase waits on a submission that
// never comes, so silence there produces silence everywhere.
//
// Two things decide whether this is useful or noise, and both are pinned
// below: it must not ring before seven days, and it must not ring at all
// for a form the phase will not let the person submit.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'self-chase-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const db = require('../core/db');
const { runSelfChase, SELF_CHASE_AFTER_DAYS } = require('../modules/performance/reminders');

const SLUG = `scz-test-${Date.now()}`;
let tenantId; let empId; let cycle;

const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const bells = async (rule) => (await db.query(
  `SELECT count(*)::int n FROM pms.reminder_log WHERE tenant_id=$1 AND rule=$2`, [tenantId, rule])).rows[0].n;
const notifs = async () => (await db.query(
  `SELECT kind, title FROM core.notifications WHERE tenant_id=$1 ORDER BY created_at`, [tenantId])).rows;

before(async () => {
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'Slow Filler','sc-emp@x.com','active') RETURNING id`,
    [tenantId])).rows[0].id;
  cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase,cycle_type)
     VALUES ($1,'T','FY26-27','kra_open','annual') RETURNING id, phase, created_at`, [tenantId])).rows[0];
});

after(async () => {
  if (tenantId) {
    for (const t of ['pms.reminder_log', 'core.notifications', 'pms.kra_sheets', 'pms.cycles', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

// The clock starts when the phase opened, which the engine reads from the
// audit log. Moving that row is how these tests move time.
const phaseOpened = async (date) => {
  await db.query(`DELETE FROM pms.audit_log WHERE tenant_id=$1`, [tenantId]);
  await db.query(
    `INSERT INTO pms.audit_log (tenant_id, at, actor_email, action, cycle_id)
     VALUES ($1,$2,'hr@x.com','PHASE_ADVANCE',$3)`, [tenantId, date, cycle.id]);
};

test('SIX DAYS IS NOT SEVEN — nothing rings yet', async () => {
  await phaseOpened(daysAgo(6));
  const rung = await runSelfChase(tenantId, cycle, new Date(), 'kra');
  assert.equal(rung, 0, 'it chased somebody inside the week');
  assert.equal(await bells('kra_self_chase'), 0);
});

test('PAST SEVEN DAYS, THE PERSON WHO HAS NOT FILLED IT IN IS TOLD', async () => {
  await phaseOpened(daysAgo(14));
  const rung = await runSelfChase(tenantId, cycle, new Date(), 'kra');
  assert.equal(rung, 1, 'the employee with no submitted sheet was not chased');
  const n = await notifs();
  assert.equal(n.length, 1, 'one bell per catch-up, not one per missed weekday');
  assert.match(n[0].title, /KRA sheet is still pending/);
  assert.ok(await bells('kra_self_chase') > 1,
    'every missed occurrence has to be logged, or the catch-up fires them all again tomorrow');
});

test('and it does not ring twice for the same days', async () => {
  const before = await bells('kra_self_chase');
  const rung = await runSelfChase(tenantId, cycle, new Date(), 'kra');
  assert.equal(rung, 0);
  assert.equal(await bells('kra_self_chase'), before, 'the ledger did not stop a replay');
});

test('SUBMITTING STOPS IT', async () => {
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status,submitted_at)
     VALUES ($1,$2,$3,'submitted',now())`, [tenantId, cycle.id, empId]);
  await db.query(`DELETE FROM pms.reminder_log WHERE tenant_id=$1`, [tenantId]);
  await phaseOpened(daysAgo(30));
  const rung = await runSelfChase(tenantId, cycle, new Date(), 'kra');
  assert.equal(rung, 0, 'somebody who has already submitted was chased anyway');
});

test('NOBODY IS CHASED FOR A FORM THE PHASE WILL NOT LET THEM SUBMIT', async () => {
  // The one thing worse than not chasing: telling somebody to go and fill
  // in a page that opens locked. The annual self-appraisal is not
  // submittable during KRA Setting.
  await phaseOpened(daysAgo(30));
  const rung = await runSelfChase(tenantId, { ...cycle, phase: 'kra_open' }, new Date(), 'annual');
  assert.equal(rung, 0, 'chased for a form the phase has closed');
});

test('the threshold is seven days and is stated once', () => {
  assert.equal(SELF_CHASE_AFTER_DAYS, 7);
});
