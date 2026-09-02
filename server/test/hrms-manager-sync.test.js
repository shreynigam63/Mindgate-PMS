// node --test — KRA/Development Plan manager-sync on HRMS re-import
// (BR-1.5: "KRA information should automatically update whenever there
// is a change in the HRMS, such as an employee changing their
// manager..."). Found genuinely missing during a full BRD re-audit:
// pms.kra_sheets/pms.development_plans snapshot manager_id once at
// creation and previously never got updated when core.employees.manager_id
// changed via re-import. Real Postgres, skips cleanly without
// DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, tenantId, empId, mgrAId, mgrBId, openCycleId, closedCycleId;

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, ['hrms-sync-test-' + Date.now()])).rows[0];
  tenantId = t.id;

  const mgrA = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Sync Mgr A','sync-mgrA@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgrB = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Sync Mgr B','sync-mgrB@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'Sync Emp','sync-emp@x.com','active',$2) RETURNING id`, [t.id, mgrA.id])).rows[0];
  mgrAId = mgrA.id; mgrBId = mgrB.id; empId = emp.id;

  const openCycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Open Cycle','FYO','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  const closedCycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Closed Cycle','FYC','annual','closed') RETURNING id`, [t.id])).rows[0];
  openCycleId = openCycle.id; closedCycleId = closedCycle.id;

  // KRA sheets and dev plans in BOTH an open and a closed cycle, both
  // originally pointing at Manager A.
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`, [t.id, openCycle.id, emp.id, mgrA.id]);
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`, [t.id, closedCycle.id, emp.id, mgrA.id]);
  await db.query(`INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`, [t.id, openCycle.id, emp.id, mgrA.id]);
  await db.query(`INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`, [t.id, closedCycle.id, emp.id, mgrA.id]);
});

after(async () => {
  if (!HAS_DB) return;
  await db.pool.end();
});

test('HRMS re-import: a manager change propagates to open-cycle KRA sheets and dev plans, but NOT to closed ones', { skip }, async () => {
  const { loadEmployees } = require('../core/employees');
  // Re-import with the employee now reporting to Manager B.
  await loadEmployees(tenantId, [{
    emp_code: null, name: 'Sync Emp', email: 'sync-emp@x.com', department: null, designation: null,
    role_band: null, manager_email: 'sync-mgrB@x.com', date_of_joining: null, status: 'active',
  }, {
    emp_code: null, name: 'Sync Mgr A', email: 'sync-mgrA@x.com', department: null, designation: null,
    role_band: null, manager_email: null, date_of_joining: null, status: 'active',
  }, {
    emp_code: null, name: 'Sync Mgr B', email: 'sync-mgrB@x.com', department: null, designation: null,
    role_band: null, manager_email: null, date_of_joining: null, status: 'active',
  }]);

  const emp = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [empId])).rows[0];
  assert.equal(emp.manager_id, mgrBId, 'core.employees.manager_id itself updates (pre-existing behaviour)');

  const openSheet = (await db.query(`SELECT manager_id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [openCycleId, empId])).rows[0];
  assert.equal(openSheet.manager_id, mgrBId, 'open-cycle KRA sheet follows the reassignment');

  const closedSheet = (await db.query(`SELECT manager_id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [closedCycleId, empId])).rows[0];
  assert.equal(closedSheet.manager_id, mgrAId, 'closed-cycle KRA sheet keeps the ORIGINAL manager — audit history is not rewritten');

  const openPlan = (await db.query(`SELECT manager_id FROM pms.development_plans WHERE cycle_id=$1 AND employee_id=$2`, [openCycleId, empId])).rows[0];
  assert.equal(openPlan.manager_id, mgrBId, 'open-cycle development plan follows the reassignment too');

  const closedPlan = (await db.query(`SELECT manager_id FROM pms.development_plans WHERE cycle_id=$1 AND employee_id=$2`, [closedCycleId, empId])).rows[0];
  assert.equal(closedPlan.manager_id, mgrAId, 'closed-cycle development plan also keeps its original manager');
});
