// node --test — the Manager tab's scope, and the two exports.
//
// Asked for on 24 Sep:
//   "please provide export option on this page" (Employees, Completion)
//   "Team KRA sheets, Team Evaluation and Team Mid-Year in Manager tab
//    should have only names of reportees reporting to him and not all
//    employees."
//
// THE SCOPE CHANGE IS THE ONE WITH TEETH, and it pulls against an earlier
// ask. On 18 Sep the client asked for super-admin reach — "approve at all
// levels for any employees including their own" — and four list queries
// were widened to the whole company for anyone holding pms_admin. That
// reach is still here; what moved is the default. The lists open on the
// caller's own reports and widen only for ?scope=all.
//
// So there are three things to keep honest, and each has a test below:
//   1. a plain manager sees their reports and NOTHING else, whatever
//      query string they send — the widening is gated on pms_admin, not
//      on the parameter;
//   2. an admin's default is now their own reports, which is the change;
//   3. an admin can still reach everyone, which is the 18 Sep ask.
//
// Real Postgres, real HTTP. Skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, mgrId, adminId;
let adminTok, mgrTok, empTok;

const req = async (path, tok) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, buf: Buffer.from(await r.arrayBuffer()) };
};
const json = async (path, tok) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-exp';
  process.env.TENANT_SLUG = 'exp-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { authenticate, devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await db.query(
    `INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order)
     VALUES ($1,'Delivery',60,10), ($1,'Collaboration',40,20)`, [t.id]);

  const mk = async (name, email, managerId, code) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id,emp_code)
     VALUES ($1,$2,$3,'active','Executive','Delivery',$4,$5) RETURNING id`,
    [t.id, name, email, managerId || null, code || null])).rows[0].id;

  adminId = await mk('EX Admin', 'ex-admin@x.com', null, '00042');
  mgrId   = await mk('EX Manager', 'ex-mgr@x.com', null, '00007');
  // Two report to the manager; one reports to nobody, so it can only ever
  // show up in the whole-company view.
  await mk('EX Report A', 'ex-a@x.com', mgrId, '00101');
  await mk('EX Report B', 'ex-b@x.com', mgrId, '00102');
  await mk('EX Stranger', 'ex-far@x.com', null, '00999');

  for (const email of ['ex-admin@x.com', 'ex-mgr@x.com', 'ex-a@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ex-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ex-mgr@x.com','manager')`, [t.id]);

  const cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'EX Cycle','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  // Growth plans for everyone the lists should be able to reach.
  // /team/development-plans starts FROM pms.development_plans, so unlike
  // the other three it lists only people who HAVE a plan — an employee
  // with none is absent whatever the scope. That is the endpoint's own
  // shape, not a scoping bug, and it caught a wrong assumption in the
  // first draft of this test.
  for (const [email, mgr] of [['ex-a@x.com', mgrId], ['ex-b@x.com', mgrId],
                              ['ex-far@x.com', null], ['ex-admin@x.com', null]]) {
    const emp = (await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND email=$2`,
      [t.id, email])).rows[0].id;
    await db.query(
      `INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, manager_id, status)
       VALUES ($1,$2,$3,$4,'draft')`, [t.id, cycleId, emp, mgr]);
  }

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
  adminTok = await login('ex-admin@x.com');
  mgrTok = await login('ex-mgr@x.com');
  empTok = await login('ex-a@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

// ---- scope ---------------------------------------------------------------

const LISTS = [
  ['/pms/team/kra-sheets', 'sheets'],
  ['/pms/team/evaluations', 'team'],
  ['/pms/team/overview', 'rows'],
  ['/pms/team/development-plans', 'plans'],
];

test('a manager sees their own reports, and nothing widens that', { skip }, async () => {
  for (const [path, key] of LISTS) {
    const mine = await json(path, mgrTok);
    assert.equal(mine.status, 200, path);
    const names = (mine.body[key] || []).map((r) => r.employee_name || r.name).sort();
    assert.deepEqual(names, ['EX Report A', 'EX Report B'], `${path} default`);
    assert.equal(mine.body.scope, 'my_reports');
    assert.equal(mine.body.can_see_all, false, 'and the toggle is not offered');

    // THE ONE THAT MATTERS: asking for everyone does not give it to them.
    const forced = await json(`${path}?scope=all`, mgrTok);
    assert.deepEqual((forced.body[key] || []).map((r) => r.employee_name || r.name).sort(),
      ['EX Report A', 'EX Report B'], `${path} must ignore ?scope=all from a manager`);
    assert.equal(forced.body.scope, 'my_reports');
  }
});

test('an admin now DEFAULTS to their own reports — this is the 24 Sep change', { skip }, async () => {
  for (const [path, key] of LISTS) {
    const r = await json(path, adminTok);
    assert.equal(r.status, 200, path);
    // Nobody reports to this admin, so the honest answer is an empty list.
    assert.deepEqual(r.body[key], [], `${path} opens on the admin's own reports`);
    assert.equal(r.body.scope, 'my_reports');
    assert.equal(r.body.can_see_all, true, 'but they are told they may widen it');
  }
});

test('an admin can still reach the whole company — the 18 Sep ask survives', { skip }, async () => {
  for (const [path, key] of LISTS) {
    const r = await json(`${path}?scope=all`, adminTok);
    assert.equal(r.status, 200, path);
    const names = (r.body[key] || []).map((x) => x.employee_name || x.name);
    assert.ok(names.includes('EX Stranger'), `${path} reaches somebody who reports to nobody`);
    assert.ok(names.includes('EX Admin'), `${path} includes the admin themselves`);
    assert.equal(r.body.scope, 'all_employees');
  }
});

// ---- exports -------------------------------------------------------------

test('the employee export comes back as a real workbook, with the code as text', { skip }, async () => {
  const r = await req('/employees/export.xlsx', adminTok);
  assert.equal(r.status, 200);
  assert.match(r.type, /spreadsheetml/);
  // PK.. — a zip, which is what an xlsx is. A JSON error page would not be.
  assert.equal(r.buf.slice(0, 2).toString(), 'PK');

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.getWorksheet('Employees');
  assert.ok(ws, 'the sheet is named');
  assert.equal(ws.getRow(1).getCell(1).value, 'Employee ID');
  assert.equal(ws.rowCount, 6, 'header + five employees');

  // LEADING ZEROS ARE THE WHOLE POINT of exporting server-side rather
  // than building a CSV in the browser: Excel eats them off anything it
  // reads as a number, and an employee code that opens as 42 instead of
  // 00042 cannot be matched back to the HRMS.
  const codes = [];
  ws.eachRow((row, n) => { if (n > 1) codes.push(String(row.getCell(1).value)); });
  assert.ok(codes.includes('00042'), `leading zeros survive — got ${codes.join(',')}`);
  ws.eachRow((row, n) => {
    if (n > 1) assert.equal(row.getCell(1).numFmt, '@', 'the code column is formatted as text');
  });
});

test('the employee CSV carries a BOM, so Excel reads it as UTF-8', { skip }, async () => {
  const r = await req('/employees/export.csv', adminTok);
  assert.equal(r.status, 200);
  assert.match(r.type, /text\/csv/);
  const text = r.buf.toString('utf8');
  assert.ok(text.startsWith('﻿'), 'without the BOM Excel mangles every non-ASCII name');
  const lines = text.replace('﻿', '').trim().split('\n');
  assert.equal(lines.length, 6, 'header + five employees');
  assert.match(lines[0], /^Employee ID,Name,Email,/);
});

test('the completion export reuses the page\'s own rows', { skip }, async () => {
  const page = await json('/pms/reports/completion', adminTok);
  assert.equal(page.status, 200);
  const r = await req('/pms/reports/completion/export.csv', adminTok);
  assert.equal(r.status, 200);
  const lines = r.buf.toString('utf8').replace('﻿', '').trim().split('\n');
  // Header + one line per row the page shows. If these ever disagree the
  // file and the screen are answering different questions.
  assert.equal(lines.length, page.body.rows.length + 1);
  assert.match(lines[0], /^Employee,Department,KRA,/);

  const x = await req('/pms/reports/completion/export.xlsx', adminTok);
  assert.equal(x.status, 200);
  assert.equal(x.buf.slice(0, 2).toString(), 'PK');
});

test('neither export is open to someone without the permission', { skip }, async () => {
  for (const p of ['/employees/export.xlsx', '/employees/export.csv']) {
    assert.equal((await req(p, empTok)).status, 403, p);
    assert.equal((await req(p, mgrTok)).status, 403, `${p} — a manager is not HR`);
  }
  for (const p of ['/pms/reports/completion/export.xlsx', '/pms/reports/completion/export.csv']) {
    assert.equal((await req(p, empTok)).status, 403, p);
    assert.equal((await req(p, mgrTok)).status, 403, p);
  }
});

// ---- the Manager tab's dashboard ------------------------------------------
//
// Asked for on 24 Sep: "build a dashboard under 'Manager tab' same like
// one in 'self tab' for manager view regarding tracking of his
// reportees."
//
// The rule with teeth here is the one the SAME message set for the rest
// of the tab — "remove 'all employees' option from all tabs". So this
// endpoint has no ?scope=all and no admin widening at all, and the third
// test below is what stops that quietly coming back.

test('the manager dashboard needs pms_team_eval', { skip }, async () => {
  const r = await json('/pms/team/home', empTok);
  assert.equal(r.status, 403);
  assert.equal(r.body.needs || r.body.error, "Requires 'pms_team_eval'");
});

test('the manager dashboard counts the caller\'s own reports', { skip }, async () => {
  const r = await json('/pms/team/home', mgrTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reports, 2);
  assert.deepEqual(r.body.roster.map((x) => x.name).sort(), ['EX Report A', 'EX Report B']);
  // The strip and the roster are two readings of one result set, so a
  // mismatch between them is a real bug and not a rounding difference.
  assert.equal(r.body.stats.reports, r.body.roster.length);
  assert.equal(r.body.stats.evals_done + r.body.stats.evals_pending, r.body.stats.reports);
  assert.equal(r.body.stats.midyear_signed + r.body.stats.midyear_pending, r.body.stats.reports);
  assert.ok(r.body.cycle && r.body.cycle.name === 'EX Cycle');
  assert.ok(r.body.action && r.body.action.title, 'it always says what to do next');
});

test('the manager dashboard never widens to the whole company', { skip }, async () => {
  // An admin with no reports gets an empty dashboard, NOT the company.
  // EX Stranger reports to nobody, so their presence would mean the
  // whole-company query came back.
  for (const path of ['/pms/team/home', '/pms/team/home?scope=all']) {
    const r = await json(path, adminTok);
    assert.equal(r.status, 200, path);
    assert.equal(r.body.reports, 0, `${path}: an admin sees only their own reports`);
    assert.deepEqual(r.body.roster, [], `${path}: and the roster is empty`);
    assert.deepEqual(r.body.pending, [], `${path}: with nothing waiting on them`);
    // Nothing on this endpoint should even mention a scope, since there
    // is no longer a control that could change it.
    assert.equal(r.body.scope, undefined);
    assert.equal(r.body.can_see_all, undefined);
  }
});

test('the manager dashboard names who is waiting, not just how many', { skip }, async () => {
  // A count tells a manager nothing they can act on. Flip one report's
  // growth plan to submitted and the dashboard must name that person.
  const emp = (await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND email='ex-a@x.com'`,
    [tenantId])).rows[0].id;
  await db.query(
    `UPDATE pms.development_plans SET status='submitted', submitted_at=now()
      WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, emp]);
  try {
    const r = await json('/pms/team/home', mgrTok);
    assert.equal(r.status, 200);
    assert.equal(r.body.stats.growth_pending, 1);
    assert.equal(r.body.stats.pending_total, 1);
    const row = r.body.pending.find((p) => p.kind === 'growth_plan');
    assert.ok(row, 'the submission is listed, not only counted');
    assert.equal(row.name, 'EX Report A');
    assert.equal(row.to, '/team/growth');
    assert.ok(row.since, 'and it says when, so the page can say how long');
    // The one action band picks this up too, since nothing else is due
    // in kra_open with no KRA sheets submitted.
    assert.ok(/target achievement/i.test(r.body.action.title), r.body.action.title);

    // A plan belonging to somebody who is NOT this manager's report must
    // not appear — EX Admin's plan has no manager_id at all.
    const other = (await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND email='ex-far@x.com'`,
      [tenantId])).rows[0].id;
    await db.query(`UPDATE pms.development_plans SET status='submitted', submitted_at=now()
                     WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, other]);
    const again = await json('/pms/team/home', mgrTok);
    assert.equal(again.body.stats.growth_pending, 1, 'a stranger\'s submission is not the manager\'s');
    assert.deepEqual(again.body.pending.map((p) => p.name), ['EX Report A']);
    await db.query(`UPDATE pms.development_plans SET status='draft', submitted_at=NULL
                     WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, other]);
  } finally {
    await db.query(`UPDATE pms.development_plans SET status='draft', submitted_at=NULL
                     WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, emp]);
  }
});
