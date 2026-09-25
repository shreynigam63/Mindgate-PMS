// node --test — adding one employee by hand, and deleting a selection
// or the whole list.
//
// Asked for on 25 Sep: "there should be delete list option for deleting
// employee so we can upload new fresh sheet again and add option for
// adding single employee as currently we don't have any integration to
// HRMS software."
//
// The two rules worth testing hardest, because both are destructive or
// irreversible in the wrong direction:
//
//   * the bulk delete runs the SAME cascade as the single delete — it
//     shares purgeEmployee, and this proves it rather than trusting it
//   * the signed-in admin is never deleted, or "delete the whole list"
//     locks the only person who could upload the replacement out of the
//     system they are administering
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, hrId, mgrId, reportId, cycleId;
let hrTok;

const call = async (tok, path, method = 'GET', body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const count = async (sql, params) => (await db.query(sql, params)).rows[0].n;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-eab';
  process.env.TENANT_SLUG = 'eab-test-' + Date.now();
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

  const mk = async (name, email, managerId) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,manager_id) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
    [t.id, name, email, managerId || null])).rows[0].id;
  hrId = await mk('EAB HR', 'eab-hr@x.com');
  mgrId = await mk('EAB Manager', 'eab-mgr@x.com');
  reportId = await mk('EAB Report', 'eab-report@x.com', mgrId);

  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'eab-hr@x.com','hr')`, [t.id]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
    [t.id, 'eab-hr@x.com', await bcrypt.hash('pass', 10)]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'EAB Cycle','FYE','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;
  // Attached records, so "the cascade actually ran" is checkable.
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [t.id, cycleId, reportId, mgrId])).rows[0];
  await db.query(`INSERT INTO pms.kras (tenant_id,sheet_id,title,weight) VALUES ($1,$2,'Report KRA',100)`, [t.id, sheet.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  hrTok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'eab-hr@x.com', password: 'pass' }),
  })).json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

// ---------------------------------------------------------------- add

test('a new joiner can be added by hand, with a reporting line', { skip }, async () => {
  const r = await call(hrTok, '/employees', 'POST', {
    name: 'Hand Added', email: 'hand@x.com', emp_code: 'MGS7001',
    department: 'Development', designation: 'Software Developer',
    manager_email: 'eab-mgr@x.com', date_of_joining: '01/07/2026',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.employee.email, 'hand@x.com');
  assert.equal(r.body.employee.status, 'active');
  const row = (await db.query(
    `SELECT manager_id, department, to_char(date_of_joining,'YYYY-MM-DD') AS doj, emp_code
       FROM core.employees WHERE tenant_id=$1 AND email='hand@x.com'`, [tenantId])).rows[0];
  assert.equal(row.manager_id, mgrId, 'the manager is resolved from the email');
  assert.equal(row.department, 'Development');
  assert.equal(row.doj, '2026-07-01', 'dd/mm/yyyy is read the way the importer reads it');
  assert.equal(row.emp_code, 'MGS7001');
  // Added by hand is auditable, like everything else that changes a record.
  const n = await count(
    `SELECT count(*)::int AS n FROM core.audit_log WHERE tenant_id=$1 AND action='EMPLOYEE_ADDED'`, [tenantId]);
  assert.equal(n, 1);
});

test('an employee with no email gets a placeholder from their code, as the importer does', { skip }, async () => {
  const r = await call(hrTok, '/employees', 'POST', { name: 'No Address', emp_code: 'MGS7002' });
  assert.equal(r.status, 201);
  assert.equal(r.body.placeholder_email, true);
  assert.match(r.body.employee.email, /^mgs7002@/);
});

test('the add form refuses what the importer would refuse', { skip }, async () => {
  const bad = [
    [{ email: 'x@y.com' }, /Full name is required/],
    [{ name: 'Nameless Code' }, /employee code/],
    [{ name: 'Bad Mail', email: 'not-an-email' }, /is not an email address/],
    [{ name: 'Dup', email: 'hand@x.com' }, /already has that email/],
    [{ name: 'Dup Code', email: 'other@x.com', emp_code: 'MGS7001' }, /already has employee code/],
    [{ name: 'Ghost Mgr', email: 'gm@x.com', manager_email: 'nobody@x.com' }, /No employee on file/],
    [{ name: 'Bad Date', email: 'bd@x.com', date_of_joining: 'the 4th' }, /is not a date/],
  ];
  for (const [body, re] of bad) {
    const r = await call(hrTok, '/employees', 'POST', body);
    assert.ok(r.status === 422 || r.status === 409, `${JSON.stringify(body)} -> ${r.status}`);
    assert.match(r.body.error, re);
  }
  // ...and none of them landed.
  const n = await count(`SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId]);
  assert.equal(n, 5, 'three seeded + two added, and nothing from the refused list');
});

test('only people_admin may add', { skip }, async () => {
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
    [tenantId, 'eab-report@x.com', require('bcryptjs').hashSync('pass', 10)]);
  const tok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'eab-report@x.com', password: 'pass' }),
  })).json()).token;
  const r = await call(tok, '/employees', 'POST', { name: 'Sneaky', email: 'sneaky@x.com' });
  assert.equal(r.status, 403);
});

// -------------------------------------------------------- bulk delete

test('deleting a selection runs the same cascade the single delete runs', { skip }, async () => {
  const before = await count(`SELECT count(*)::int AS n FROM pms.kra_sheets WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, reportId]);
  assert.equal(before, 1, 'the report has a sheet to lose');

  const r = await call(hrTok, '/employees', 'DELETE', { ids: [reportId] });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM core.employees WHERE id=$1`, [reportId]), 0);
  // The cascade, not just the row: an orphan sheet behind a foreign key
  // is exactly what a second copy of this logic would leave behind.
  assert.equal(await count(`SELECT count(*)::int AS n FROM pms.kra_sheets WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, reportId]), 0);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pms.kras WHERE tenant_id=$1`, [tenantId]), 0,
    'the KRAs under that sheet went with it');
});

test('an empty selection, or no mode at all, is refused rather than guessed at', { skip }, async () => {
  const a = await call(hrTok, '/employees', 'DELETE', { ids: [] });
  assert.equal(a.status, 422);
  assert.match(a.body.error, /No employees were selected/);
  const b = await call(hrTok, '/employees', 'DELETE', {});
  assert.equal(b.status, 422);
  assert.match(b.body.error, /ids .* or confirm_count/);
  assert.ok(typeof b.body.have === 'number', 'and it says how many there are');
});

test('clearing the whole list needs the count to match what the page showed', { skip }, async () => {
  const have = await count(`SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId]);
  const wrong = await call(hrTok, '/employees', 'DELETE', { confirm_count: have + 7 });
  assert.equal(wrong.status, 409);
  assert.match(wrong.body.error, /changed since the page loaded/);
  assert.equal(await count(`SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId]), have,
    'a refused clear deletes nothing');
});

test('the signed-in admin is never deleted, so they can upload the new sheet', { skip }, async () => {
  const have = await count(`SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId]);
  const r = await call(hrTok, '/employees', 'DELETE', { confirm_count: have });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared, true);
  assert.equal(r.body.kept_self, true, 'and it says so, rather than silently deleting one fewer');
  assert.equal(r.body.removed, have - 1);
  const left = (await db.query(`SELECT email FROM core.employees WHERE tenant_id=$1`, [tenantId])).rows;
  assert.deepEqual(left.map((x) => x.email), ['eab-hr@x.com'], 'the admin survives, everybody else is gone');
  // Selecting ONLY yourself is refused outright — it would be a no-op
  // reported as a success.
  const self = await call(hrTok, '/employees', 'DELETE', { ids: [hrId] });
  assert.equal(self.status, 422);
  assert.match(self.body.error, /your own/);
});

test('clearing is audited with who did it and how many went', { skip }, async () => {
  const rows = (await db.query(
    `SELECT action, details FROM core.audit_log
      WHERE tenant_id=$1 AND action IN ('EMPLOYEE_LIST_CLEARED','EMPLOYEES_DELETED') ORDER BY id`, [tenantId])).rows;
  assert.equal(rows.length, 2, 'the selection delete and the clear');
  assert.equal(rows[0].action, 'EMPLOYEES_DELETED');
  assert.equal(rows[1].action, 'EMPLOYEE_LIST_CLEARED');
  assert.equal(rows[1].details.cleared, true);
  assert.ok(rows[1].details.count > 0);
});
