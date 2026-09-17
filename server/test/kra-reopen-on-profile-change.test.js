// node --test — a KRA sheet is written FOR a job. Change the job, reopen
// the sheet.
//
// Asked for on 17 Sep, immediately after the submission lock: "if employee
// has submitted his KRA to manager and his department, designation or role
// is changed, his KRAs should be opened again for refilling as it gets
// locked after submission to manager."
//
// Without this the lock traps them: their sheet describes a job they no
// longer hold, and only HR noticing and reopening it by hand gets them
// out. The three places a profile actually changes are all covered —
// the HR quick-edit form, the role assignment, and the HRMS re-import,
// which is the path most of these arrive on.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, tenantId, cycleId, empId, mgrId, sheetId, loadEmployees;

const as = (tok) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: as(tok), body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sheet = async () => (await db.query(
  `SELECT status, manager_comment, reopened_reason FROM pms.kra_sheets WHERE id=$1`, [sheetId])).rows[0];
const setSheet = async (status) => db.query(
  `UPDATE pms.kra_sheets SET status=$1, manager_comment=NULL WHERE id=$2`, [status, sheetId]);
const setProfile = async (dept, desig) => db.query(
  `UPDATE core.employees SET department=$1, designation=$2 WHERE id=$3`, [dept, desig, empId]);
const edit = (body) => req('PUT', `/employees/${empId}`, hrTok, body);
// The HR form posts every field, so the tests do too. Omitting
// manager_email is not "leave it alone" on this route — it CLEARS the
// manager, and then propagates that null onto the KRA sheet. Leaving it
// out here quietly stripped the manager the reopen notification is
// supposed to reach.
const BASE_EDIT = { name: 'Move Emp', department: 'Admin', designation: 'Executive',
  manager_email: 'move-mgr@x.com' };

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-move';
  process.env.TENANT_SLUG = 'move-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  loadEmployees = require('../core/employees').loadEmployees;

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  mgrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'Move Mgr','move-mgr@x.com','active') RETURNING id`,
    [t.id])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,manager_id,department,designation)
     VALUES ($1,'Move Emp','move-emp@x.com','active',$2,'Admin','Executive') RETURNING id`,
    [t.id, mgrId])).rows[0].id;
  await db.query(`INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'Move HR','move-hr@x.com','active')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'move-hr@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'move-hr@x.com',$2)`,
    [t.id, await bcrypt.hash('pass', 10)]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'Move Cycle','FYM','annual','manager_eval') RETURNING id`, [t.id])).rows[0].id;
  sheetId = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'submitted') RETURNING id`, [t.id, cycleId, empId, mgrId])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  hrTok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'move-hr@x.com', password: 'pass' }),
  })).json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('A DESIGNATION CHANGE REOPENS A SUBMITTED SHEET', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  const r = await edit({ ...BASE_EDIT, designation: 'Senior Executive' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reopened_kra_sheets, 1, 'the route says what it did rather than doing it quietly');
  const s = await sheet();
  assert.equal(s.status, 'returned');
  assert.match(s.manager_comment, /Designation: Executive → Senior Executive/);
  assert.match(s.manager_comment, /submit again/);
  // The banner must not attribute this to the manager, who did nothing.
  assert.equal(s.reopened_reason, 'profile_change');
});

test('a MANAGER\'s own return is not labelled as an automatic one', { skip }, async () => {
  // The two land on the same status, so the stored reason is the only
  // thing keeping them apart — and it has to be cleared, not just set.
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  await edit({ ...BASE_EDIT, designation: 'Team Lead' });
  assert.equal((await sheet()).reopened_reason, 'profile_change');

  await setSheet('submitted');
  const r = await req('POST', `/pms/team/kra-sheets/${sheetId}/decide`, hrTok,
    { decision: 'returned', comment: 'Weights look off.' });
  assert.equal(r.status, 200);
  const s2 = await sheet();
  assert.equal(s2.status, 'returned');
  assert.equal(s2.reopened_reason, null, 'a manager deciding clears the automatic label');
});

test('a department change does too', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  const r = await edit({ ...BASE_EDIT, department: 'Finance' });
  assert.equal(r.body.reopened_kra_sheets, 1);
  assert.match((await sheet()).manager_comment, /Department: Admin → Finance/);
});

test('an APPROVED sheet is reopened too — it is just as wrong for the new job', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('approved');
  const r = await edit({ ...BASE_EDIT, designation: 'Team Lead' });
  assert.equal(r.body.reopened_kra_sheets, 1);
  assert.equal((await sheet()).status, 'returned');
});

test('changing the ROLE reopens it as well', { skip }, async () => {
  await setSheet('submitted');
  const r = await req('PUT', `/employees/${empId}/role`, hrTok, { role: 'manager' });
  assert.equal(r.status, 200);
  assert.equal(r.body.reopened_kra_sheets, 1);
  assert.match((await sheet()).manager_comment, /Role: employee → manager/);
  // Setting the SAME role again is not a change and must not reopen.
  await setSheet('submitted');
  const again = await req('PUT', `/employees/${empId}/role`, hrTok, { role: 'manager' });
  assert.equal(again.body.reopened_kra_sheets, 0);
  assert.equal((await sheet()).status, 'submitted');
  await req('PUT', `/employees/${empId}/role`, hrTok, { role: 'employee' });
});

test('A DRAFT SHEET IS LEFT ALONE — there is nothing to unlock', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('draft');
  const r = await edit({ ...BASE_EDIT, designation: 'Process Manager' });
  assert.equal(r.body.reopened_kra_sheets, 0);
  assert.equal((await sheet()).status, 'draft', 'and its status is untouched');
});

test('an edit that changes NOTHING relevant reopens nothing', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  // A corrected name and a manager reassignment are not job changes. The
  // manager change still propagates onto the sheet — it just does not
  // throw the objectives away, which is the distinction that matters.
  const r = await edit({ ...BASE_EDIT, name: 'Move  Emp', manager_email: 'move-mgr@x.com' });
  assert.equal(r.body.reopened_kra_sheets, 0);
  assert.equal((await sheet()).status, 'submitted');
});

test('a closed cycle is history and is never rewritten', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  const r = await edit({ ...BASE_EDIT, designation: 'Manager' });
  assert.equal(r.body.reopened_kra_sheets, 0);
  assert.equal((await sheet()).status, 'submitted', 'last year\'s approved sheet keeps its answer');
  await db.query(`UPDATE pms.cycles SET phase='manager_eval' WHERE id=$1`, [cycleId]);
});

test('the reopen is audited, with the before and after that caused it', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  await db.query(`DELETE FROM core.audit_log WHERE tenant_id=$1 AND action='KRA_REOPENED_PROFILE_CHANGE'`, [tenantId]);
  await edit({ ...BASE_EDIT, designation: 'System Administrator' });
  const rows = (await db.query(
    `SELECT actor_email, entity, entity_id, details FROM core.audit_log
      WHERE tenant_id=$1 AND action='KRA_REOPENED_PROFILE_CHANGE'`, [tenantId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, 'kra_sheets');
  assert.equal(rows[0].entity_id, sheetId);
  assert.equal(rows[0].actor_email, 'move-hr@x.com', 'who did it, not just that it happened');
  assert.deepEqual(rows[0].details.changes,
    [{ field: 'Designation', from: 'Executive', to: 'System Administrator' }]);
});

test('both sides are told', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  await db.query(`DELETE FROM core.notifications WHERE tenant_id=$1`, [tenantId]);
  await edit({ ...BASE_EDIT, designation: 'Office Assistant' });
  const n = (await db.query(
    `SELECT employee_id, title FROM core.notifications WHERE tenant_id=$1 AND kind='kra_reopened'`, [tenantId])).rows;
  assert.equal(n.length, 2, 'the employee, whose sheet came back, and the manager, whose queue it left');
  assert.ok(n.some((x) => x.employee_id === empId));
  assert.ok(n.some((x) => x.employee_id === mgrId));
});

test('THE HRMS RE-IMPORT REOPENS TOO — the path these changes really arrive on', { skip }, async () => {
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  const out = await loadEmployees(tenantId, [
    { emp_code: 'M1', name: 'Move Emp', email: 'move-emp@x.com', department: 'Admin',
      designation: 'Assistant Vice President', role_band: null, date_of_joining: null,
      status: 'active', manager_email: 'move-mgr@x.com' },
  ], { actorEmail: 'importer@x.com' });
  assert.equal((out.kra_sheets_reopened || []).length, 1, 'the import report names it, rather than leaving HR to find out');
  assert.equal(out.kra_sheets_reopened[0].sheets, 1);
  assert.equal((await sheet()).status, 'returned');
  assert.match((await sheet()).manager_comment, /Executive → Assistant Vice President/);
});

test('re-importing the SAME file changes nothing and reopens nothing', { skip }, async () => {
  // The common case by far: a nightly sync of a company whose designations
  // did not move. Reopening every submitted sheet each night would make
  // the feature unusable.
  await setProfile('Admin', 'Executive');
  await setSheet('submitted');
  const row = { emp_code: 'M1', name: 'Move Emp', email: 'move-emp@x.com', department: 'Admin',
    designation: 'Executive', role_band: null, date_of_joining: null, status: 'active',
    manager_email: 'move-mgr@x.com' };
  for (const pass of [1, 2]) {
    const out = await loadEmployees(tenantId, [row], { actorEmail: 'importer@x.com' });
    assert.equal((out.kra_sheets_reopened || []).length, 0, `pass ${pass} should reopen nothing`);
  }
  assert.equal((await sheet()).status, 'submitted');
});

test('a brand-new joiner in the import is not treated as a change', { skip }, async () => {
  const out = await loadEmployees(tenantId, [
    { emp_code: 'N1', name: 'Brand New', email: 'move-new@x.com', department: 'Admin',
      designation: 'Executive', role_band: null, date_of_joining: null, status: 'active', manager_email: null },
  ], { actorEmail: 'importer@x.com' });
  assert.equal((out.kra_sheets_reopened || []).length, 0);
});

test('null → empty string is not a change anybody should hear about', { skip }, async () => {
  const { watchedChanges } = require('../modules/performance/profile-change');
  assert.deepEqual(watchedChanges({ department: null }, { department: '' }), []);
  assert.deepEqual(watchedChanges({ designation: 'Executive' }, { designation: '  Executive  ' }), []);
  // A field the caller did not send is not a change to blank.
  assert.deepEqual(watchedChanges({ department: 'Admin', designation: 'Executive' }, { designation: 'Executive' }), []);
  // …but a real move is.
  assert.deepEqual(watchedChanges({ department: 'Admin' }, { department: 'Finance' }),
    [{ field: 'Department', from: 'Admin', to: 'Finance' }]);
});
