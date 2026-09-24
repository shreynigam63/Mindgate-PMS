// node --test — the 24 Sep points that need a database.
//
//   1. "Direct KRA edit option to manager in team KRAs after submission
//      from employee."
//   2. "Reporting manager change will also lead to open KRA changes."
//   4. "'Team KRAs' should have department dropdown view."
//   6. "Reminder to manager for approvals of reports/actions submitted
//      by employee."
//
// Real Postgres, real HTTP. Skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, mgrA, mgrB, empId, otherId;
let mgrATok, mgrBTok, empTok, adminTok;

const call = async (tok, path, method = 'GET', body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-me';
  process.env.TENANT_SLUG = 'me-test-' + Date.now();
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
  await require('../migrations/049-competency-mapping').up(db);

  const mk = async (name, email, managerId, dept) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active','Engineer',$4,$5) RETURNING id`,
    [t.id, name, email, dept, managerId || null])).rows[0].id;

  const adminId = await mk('ME Admin', 'me-admin@x.com', null, 'HR');
  mgrA = await mk('ME Manager A', 'me-a@x.com', null, 'Development');
  mgrB = await mk('ME Manager B', 'me-b@x.com', null, 'Development');
  empId = await mk('ME Report', 'me-emp@x.com', mgrA, 'Development');
  // Somebody in a department A staffs but does not manage, for the
  // department view.
  otherId = await mk('ME Other', 'me-other@x.com', mgrB, 'Development');
  // ...and somebody in a department A has nothing to do with.
  await mk('ME Outsider', 'me-out@x.com', mgrB, 'Finance');

  for (const email of ['me-admin@x.com', 'me-a@x.com', 'me-b@x.com', 'me-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'me-admin@x.com','admin')`, [t.id]);
  for (const e of ['me-a@x.com', 'me-b@x.com']) {
    await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,$2,'manager')`, [t.id, e]);
  }

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'ME Cycle','FY26-27','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/employees', require('../core/employees').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  adminTok = await login('me-admin@x.com');
  mgrATok = await login('me-a@x.com');
  mgrBTok = await login('me-b@x.com');
  empTok = await login('me-emp@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const KRAS = [
  { title: 'Ship the payments integration', measures: 'Live by Q2', weight: 60, category: 'Delivery' },
  { title: 'Cut P1 incidents', measures: 'Under 3 a quarter', weight: 40, category: 'Quality' },
];

const sheetIdFor = async (tok, name) => {
  const list = await call(tok, '/pms/team/kra-sheets');
  return (list.body.sheets.find((s) => s.employee_name === name) || {}).id;
};

// ---- 1. the manager edits a submitted sheet ------------------------------

test('a manager cannot edit a sheet the employee has not submitted', { skip }, async () => {
  await call(empTok, '/pms/my/kra-sheet');                       // creates it
  await call(empTok, '/pms/my/kra-sheet/kras', 'PUT', { kras: KRAS });
  const id = await sheetIdFor(mgrATok, 'ME Report');
  assert.ok(id);
  const r = await call(mgrATok, `/pms/team/kra-sheets/${id}/kras`, 'PUT', { kras: KRAS });
  assert.equal(r.status, 409);
  // A DRAFT IS STILL THE EMPLOYEE'S. Editing one from here would let a
  // manager rewrite objectives the employee has not finished writing.
  assert.match(r.body.error, /still a draft/);
});

test('a manager edits a submitted sheet, and it stays submitted', { skip }, async () => {
  assert.equal((await call(empTok, '/pms/my/kra-sheet/submit', 'POST')).status, 200);
  const id = await sheetIdFor(mgrATok, 'ME Report');

  const before = await call(mgrATok, `/pms/team/kra-sheets/${id}/kras`);
  const edited = before.body.kras.map((k) => ({
    id: k.id, title: k.title, measures: k.measures, description: k.description,
    category: k.category, weight: k.weight,
  }));
  edited[0].title = 'Ship the payments integration (phase 1)';
  edited[0].weight = 70;
  edited[1].weight = 30;

  const r = await call(mgrATok, `/pms/team/kra-sheets/${id}/kras`, 'PUT', { kras: edited });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.weights.total, 100);
  // The employee sees the change, and the sheet is STILL with the
  // manager — editing is not deciding.
  const mine = await call(empTok, '/pms/my/kra-sheet');
  assert.equal(mine.body.sheet.status, 'submitted');
  assert.ok(mine.body.kras.some((k) => k.title === 'Ship the payments integration (phase 1)'));
  assert.ok(mine.body.sheet.edited_by_manager_at, 'and the sheet says a manager touched it');
});

test('what the manager changed is recorded field by field', { skip }, async () => {
  // "Who changed my weight from 60 to 70" has to have an answer, and
  // "the sheet was edited" is not one.
  const rows = (await db.query(
    `SELECT details FROM pms.audit_log
      WHERE tenant_id=$1 AND action='KRA_EDITED_BY_MANAGER' ORDER BY at DESC LIMIT 1`,
    [tenantId])).rows;
  assert.equal(rows.length, 1);
  const changes = rows[0].details.changes;
  const weight = changes.find((c) => c.field === 'weight' && c.from === '60');
  assert.ok(weight, `weight change recorded — got ${JSON.stringify(changes)}`);
  assert.equal(weight.to, '70');
  assert.ok(changes.some((c) => c.field === 'title'));
  // ...and the employee was told.
  const n = (await db.query(
    `SELECT kind FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind='kra_edited_by_manager'`,
    [tenantId, empId])).rows;
  assert.equal(n.length, 1, 'a silent rewrite is impossible');
});

test('a manager edit is held to the same weight rule as the employee', { skip }, async () => {
  const id = await sheetIdFor(mgrATok, 'ME Report');
  const cur = await call(mgrATok, `/pms/team/kra-sheets/${id}/kras`);
  const bad = cur.body.kras.map((k) => ({ id: k.id, title: k.title, measures: k.measures, weight: 10 }));
  const r = await call(mgrATok, `/pms/team/kra-sheets/${id}/kras`, 'PUT', { kras: bad });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /must total 100/);
  // Nothing was written.
  const after = await call(mgrATok, `/pms/team/kra-sheets/${id}/kras`);
  assert.equal(after.body.weights.total, 100);
});

test('only this employee\'s own manager may edit their sheet', { skip }, async () => {
  const id = await sheetIdFor(mgrATok, 'ME Report');
  const r = await call(mgrBTok, `/pms/team/kra-sheets/${id}/kras`, 'PUT', { kras: KRAS });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Not your report/);
  assert.equal((await call(empTok, `/pms/team/kra-sheets/${id}/kras`, 'PUT', { kras: KRAS })).status, 403);
});

// ---- 4. the department view ----------------------------------------------

test('the department dropdown offers only departments the manager may see', { skip }, async () => {
  const mine = await call(mgrATok, '/pms/team/kra-sheets');
  assert.equal(mine.body.scope, 'my_reports');
  assert.deepEqual(mine.body.departments, ['Development'],
    'their reports sit in Development and they head nothing else');
  assert.deepEqual(mine.body.sheets.map((s) => s.employee_name), ['ME Report']);

  const dev = await call(mgrATok, '/pms/team/kra-sheets?department=Development');
  assert.equal(dev.body.scope, 'department');
  const names = dev.body.sheets.map((s) => s.employee_name).sort();
  assert.ok(names.includes('ME Other'), 'the department view shows people who are not their reports');
  assert.ok(names.includes('ME Report'));
  assert.ok(!names.includes('ME Outsider'), 'and nobody from another department');

  // WHO MAY ACT is decided on the server, per row.
  assert.equal(dev.body.sheets.find((s) => s.employee_name === 'ME Report').is_my_report, true);
  assert.equal(dev.body.sheets.find((s) => s.employee_name === 'ME Other').is_my_report, false);
  // Somebody with no manager at all must read as false, not null — a
  // null read as "not false" in the browser handed out the Edit button.
  const admin = await call(adminTok, '/pms/team/kra-sheets?department=HR');
  for (const s of admin.body.sheets) assert.notEqual(s.is_my_report, null);
});

test('a department the manager neither staffs nor heads is refused', { skip }, async () => {
  const r = await call(mgrATok, '/pms/team/kra-sheets?department=Finance');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /neither/);
  assert.deepEqual(r.body.departments, ['Development'], 'and it says what they CAN pick');
});

test('a department head gets their department even with no reports in it', { skip }, async () => {
  await db.query(
    `INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Finance',$2)
     ON CONFLICT (tenant_id, department) DO UPDATE SET employee_id=EXCLUDED.employee_id`,
    [tenantId, mgrA]);
  const r = await call(mgrATok, '/pms/team/kra-sheets');
  assert.deepEqual(r.body.departments, ['Development', 'Finance']);
  const fin = await call(mgrATok, '/pms/team/kra-sheets?department=Finance');
  assert.equal(fin.status, 200);
  assert.deepEqual(fin.body.sheets.map((s) => s.employee_name), ['ME Outsider']);
  assert.equal(fin.body.sheets[0].is_my_report, false, 'seeing is not deciding');
  await db.query(`DELETE FROM core.department_heads WHERE tenant_id=$1 AND department='Finance'`, [tenantId]);
});

// ---- 2. the handover -----------------------------------------------------

test('changing the reporting manager moves every OPEN record', { skip }, async () => {
  // Give the employee one of each, in states that should and should
  // not move.
  await db.query(
    `INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, manager_id, status)
     VALUES ($1,$2,$3,$4,'submitted')
     ON CONFLICT DO NOTHING`, [tenantId, cycleId, empId, mgrA]);
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id, manager_status)
     VALUES ($1,$2,$3,$4,'in_progress')`, [tenantId, cycleId, empId, mgrA]);
  await db.query(
    `INSERT INTO pms.competency_assessments (tenant_id, cycle_id, employee_id, manager_id, manager_status)
     VALUES ($1,$2,$3,$4,'not_started')`, [tenantId, cycleId, empId, mgrA]);
  // A SUBMITTED evaluation. This must NOT move: it is a judgement
  // somebody put their name to, and reassigning it would attribute
  // one manager's words to another.
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status)
     VALUES ($1,$2,$3,$4,'submitted')`, [tenantId, cycleId, empId, mgrA]);

  const r = await call(adminTok, `/employees/${empId}`, 'PUT', {
    name: 'ME Report', department: 'Development', designation: 'Engineer',
    manager_email: 'me-b@x.com',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.handover_message, 'the change is reported, not done silently');

  const owner = async (table) => (await db.query(
    `SELECT manager_id FROM ${table} WHERE tenant_id=$1 AND employee_id=$2 AND cycle_id=$3`,
    [tenantId, empId, cycleId])).rows[0].manager_id;
  assert.equal(await owner('pms.kra_sheets'), mgrB, 'the KRA sheet moved');
  assert.equal(await owner('pms.development_plans'), mgrB, 'the growth plan moved');
  assert.equal(await owner('pms.midyear_checkins'), mgrB, 'the mid-year moved');
  assert.equal(await owner('pms.competency_assessments'), mgrB, 'the competency assessment moved');
  assert.equal(await owner('pms.manager_evaluations'), mgrA,
    'the SUBMITTED evaluation stayed with the manager who wrote it');
});

test('after the handover the new manager sees it and the old one does not', { skip }, async () => {
  const a = await call(mgrATok, '/pms/team/kra-sheets');
  assert.ok(!a.body.sheets.some((s) => s.employee_name === 'ME Report'),
    'the old manager no longer has them');
  const b = await call(mgrBTok, '/pms/team/kra-sheets');
  assert.ok(b.body.sheets.some((s) => s.employee_name === 'ME Report'),
    'and the new manager does');
  // And the new manager can act on the sheet the old one submitted to.
  const id = (b.body.sheets.find((s) => s.employee_name === 'ME Report') || {}).id;
  const detail = await call(mgrBTok, `/pms/team/kra-sheets/${id}/kras`);
  assert.equal(detail.status, 200);
});

// ---- 6. approval reminders ------------------------------------------------

test('a manager is chased for a KRA sheet and a growth plan left sitting', { skip }, async () => {
  const { runChase } = require('../modules/performance/reminders');
  const cycle = (await db.query(`SELECT * FROM pms.cycles WHERE id=$1`, [cycleId])).rows[0];
  // Submitted four days ago — past the three-day floor the engine uses.
  const when = new Date(Date.now() - 4 * 86400000);
  await db.query(`UPDATE pms.kra_sheets SET submitted_at=$3, status='submitted'
                   WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empId, when]);
  await db.query(`UPDATE pms.development_plans SET submitted_at=$3, status='submitted'
                   WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empId, when]);

  const today = new Date();
  assert.ok(await runChase(tenantId, cycle, today, 'kra') > 0, 'the KRA approval was chased');
  assert.ok(await runChase(tenantId, cycle, today, 'growth') > 0, 'so was the growth plan');

  const notes = (await db.query(
    `SELECT kind, title, body FROM core.notifications
      WHERE tenant_id=$1 AND employee_id=$2 AND kind IN ('kra_approval_chase','growth_approval_chase')`,
    [tenantId, mgrB])).rows;
  assert.equal(notes.length, 2, 'and they went to the NEW manager, who actually has to act');
  assert.ok(notes.every((n) => /waiting on you/.test(n.title)));
  assert.ok(notes.every((n) => /approve or a return/.test(n.body)),
    'worded as an approval, not as "signed by them"');

  // RUNG ONCE. A reminder engine that re-fires the same occurrence on
  // every nightly run is a reminder engine people mute.
  assert.equal(await runChase(tenantId, cycle, today, 'kra'), 0);
});

test('the NIGHTLY RUN fires the approval chases, not just the function', { skip }, async () => {
  // runChase() working proves the rule; it does not prove the rule is
  // wired into the sweep that actually runs. Deleting the two calls
  // from runReminders() left every other assertion in this file green.
  const { runReminders } = require('../modules/performance/reminders');
  await db.query(`DELETE FROM pms.reminder_log WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  await db.query(`DELETE FROM core.notifications WHERE tenant_id=$1
                   AND kind IN ('kra_approval_chase','growth_approval_chase')`, [tenantId]);
  await db.query(`UPDATE pms.kra_sheets SET status='submitted', submitted_at=$3
                   WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empId, new Date(Date.now() - 5 * 86400000)]);

  const counts = await runReminders(tenantId, new Date());
  assert.ok(counts.kra_approval_chase > 0,
    `the sweep chased the KRA approval — got ${JSON.stringify(counts)}`);
  assert.ok(Object.prototype.hasOwnProperty.call(counts, 'growth_approval_chase'),
    'and reports the growth chase in its counts');
});

test('nothing is chased once the manager has decided', { skip }, async () => {
  const { runChase } = require('../modules/performance/reminders');
  const cycle = (await db.query(`SELECT * FROM pms.cycles WHERE id=$1`, [cycleId])).rows[0];
  await db.query(`UPDATE pms.kra_sheets SET status='approved' WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empId]);
  await db.query(`DELETE FROM pms.reminder_log WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  assert.equal(await runChase(tenantId, cycle, new Date(), 'kra'), 0);
});
