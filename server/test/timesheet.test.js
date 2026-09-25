// node --test — timesheets end to end: real Postgres, real HTTP, real
// migrations, a real .xlsx built in memory and posted as multipart.
//
// The rule this feature turns on is the one worth testing hardest: an
// employee may upload a file full of the whole team's logs, and only
// their own rows may be loaded. Route rules cannot express that, so it
// lives in the handler — and so it gets a test that would catch it
// coming back.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, empId, mgrId, farId;
let empTok, mgrTok, adminTok, farTok;

const call = async (tok, path, method = 'GET', body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const HEADER = ['Item Id', 'Item Name', 'Log Type', 'Log Hours', 'Log Hours(for calculation)',
  'Approved by', 'Created On', 'Log owner', 'Log Date', 'Billing Status', 'Approval Status',
  'Description', 'Sprint', 'Item Type', 'Owner Mail Id', 'Project Name'];

// A workbook shaped like the client's export: metadata rows, a group
// band, the header, then the logs.
async function exportBuffer(logs) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Main');
  ws.addRow(['Team Name', 'productteam']);
  ws.addRow(['Project Name', 'UPI 5.0 Product']);
  ws.addRow(['Exported By', 'Someone']);
  ws.addRow(['Date', '2026-09-25 11:04:03']);
  ws.addRow(['Filter', 'none']);
  ws.addRow(['', '', '', '', '', '', '', '', 'Timesheet']);
  ws.addRow(HEADER);
  for (const l of logs) {
    ws.addRow(['U5P-I58', 'GFF Activities', 'WorkItem', '08:00', String(l.hours ?? 8),
      'A Manager', '18/Sep/2026 16:19', l.name, l.date, 'Non-billable', 'Approved',
      l.desc || 'work', 'Q2 Sprint 3', 'Story', l.email, 'UPI 5.0 Product']);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(tok, logs, commit) {
  const fd = new FormData();
  fd.append('file', new Blob([await exportBuffer(logs)]), 'timesheet.xlsx');
  const r = await fetch(`${base}/pms/timesheet/upload${commit ? '?commit=1' : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: fd,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// 21 Sep 2026 is a Monday; 22, 23, 24, 25 are Tue-Fri.
const WEEK = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ts';
  process.env.TENANT_SLUG = 'ts-test-' + Date.now();
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
  // The page rows are seeded per tenant by 042, which ran before this
  // tenant existed — so seed this one the way 042 would. That list
  // carries the three timesheet pages, which is what the first test
  // below checks.
  await require('../migrations/042-seed-page-permissions').ensurePageSeeds(db, t.id);

  const mk = async (name, email, managerId, designation, department) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active',$4,$5,$6) RETURNING id`,
    [t.id, name, email, designation, department, managerId || null])).rows[0].id;

  await mk('TS Admin', 'ts-admin@x.com', null, 'Manager', 'HR');
  mgrId = await mk('TS Manager', 'ts-mgr@x.com', null, 'Lead', 'Development');
  empId = await mk('TS Report', 'ts-emp@x.com', mgrId, 'Software Developer', 'Development');
  // Somebody the manager does not manage — the row-scope control.
  farId = await mk('TS Stranger', 'ts-far@x.com', null, 'Software Developer', 'Cyber Security');

  for (const email of ['ts-admin@x.com', 'ts-mgr@x.com', 'ts-emp@x.com', 'ts-far@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ts-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ts-mgr@x.com','manager')`, [t.id]);

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
  adminTok = await login('ts-admin@x.com');
  mgrTok = await login('ts-mgr@x.com');
  empTok = await login('ts-emp@x.com');
  farTok = await login('ts-far@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the three pages are registered, each behind its own permission', { skip }, async () => {
  const rows = (await db.query(
    `SELECT page, route, required_permission FROM core.page_permission
      WHERE tenant_id=$1 AND route LIKE '%timesheet%' ORDER BY route`, [tenantId])).rows;
  assert.deepEqual(rows, [
    { page: 'hr_timesheet', route: '/admin/timesheet', required_permission: 'pms_admin' },
    { page: 'my_timesheet', route: '/my/timesheet', required_permission: null },
    { page: 'team_timesheet', route: '/team/timesheet', required_permission: 'pms_team_eval' },
  ]);
});

test('a dry run saves nothing and says what it would do', { skip }, async () => {
  const r = await upload(empTok, WEEK.slice(0, 3).map((d) => ({ date: d, name: 'TS Report', email: 'ts-emp@x.com' })));
  assert.equal(r.status, 200);
  assert.equal(r.body.committed, false);
  assert.equal(r.body.loadable, 3);
  assert.equal(r.body.meta.project_name, 'UPI 5.0 Product');
  const n = (await db.query(`SELECT count(*)::int AS n FROM pms.timesheet_entries WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(n, 0, 'a dry run must not write');
});

test('an employee uploading the whole team\'s export loads ONLY their own rows', { skip }, async () => {
  const logs = [
    ...WEEK.slice(0, 4).map((d) => ({ date: d, name: 'TS Report', email: 'ts-emp@x.com' })),
    ...WEEK.slice(0, 5).map((d) => ({ date: d, name: 'TS Stranger', email: 'ts-far@x.com' })),
  ];
  const r = await upload(empTok, logs, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.committed, true);
  assert.equal(r.body.loadable, 4, 'four of their own');
  assert.equal(r.body.skipped_total, 5, 'five belonging to someone else');
  assert.equal(r.body.scope, 'your own logs only');
  // And the database agrees — the point of the rule.
  const mine = (await db.query(
    `SELECT count(*)::int AS n FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empId])).rows[0].n;
  const theirs = (await db.query(
    `SELECT count(*)::int AS n FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, farId])).rows[0].n;
  assert.equal(mine, 4);
  assert.equal(theirs, 0, 'nobody may write another person\'s timesheet');
});

test('HR uploading the same file loads everybody', { skip }, async () => {
  const logs = WEEK.slice(0, 2).map((d) => ({ date: d, name: 'TS Stranger', email: 'ts-far@x.com' }));
  const r = await upload(adminTok, logs, true);
  assert.equal(r.body.committed, true);
  assert.equal(r.body.skipped_total, 0);
  assert.equal(r.body.scope, 'all employees');
  const theirs = (await db.query(
    `SELECT count(*)::int AS n FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, farId])).rows[0].n;
  assert.equal(theirs, 2);
});

test('re-uploading the same export twice is a no-op, not a doubling', { skip }, async () => {
  const before = (await db.query(
    `SELECT count(*)::int AS n FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empId])).rows[0].n;
  await upload(empTok, WEEK.slice(0, 4).map((d) => ({ date: d, name: 'TS Report', email: 'ts-emp@x.com' })), true);
  const after2 = (await db.query(
    `SELECT count(*)::int AS n FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empId])).rows[0].n;
  assert.equal(after2, before, 'the window is replaced, not appended to');
});

test('an upload outside the window leaves the earlier window alone', { skip }, async () => {
  await upload(empTok, [{ date: '2026-08-24', name: 'TS Report', email: 'ts-emp@x.com' }], true);
  const dates = (await db.query(
    `SELECT to_char(log_date,'YYYY-MM-DD') AS d FROM pms.timesheet_entries
      WHERE tenant_id=$1 AND employee_id=$2 ORDER BY log_date`, [tenantId, empId])).rows.map((r) => r.d);
  assert.deepEqual(dates, ['2026-08-24', ...WEEK.slice(0, 4)]);
});

test('an employee sees their own report and their own report only', { skip }, async () => {
  const r = await call(empTok, '/pms/timesheet/me?as_of=2026-09-25');
  assert.equal(r.status, 200);
  assert.equal(r.body.employee.email, 'ts-emp@x.com');
  const sep = r.body.cycles.find((c) => c.start === '2026-09-21');
  assert.equal(sep.work, 5, 'Mon-Fri to the 25th');
  assert.equal(sep.filled, 4, '21-24 logged, the 25th not');
  assert.equal(sep.missing, 1);
  assert.equal(sep.pct, 80);
  assert.equal(sep.rating, 'Amber');
  // There is no route that would hand them a colleague's logs.
  const nope = await call(empTok, `/pms/timesheet/employee/${farId}`);
  assert.equal(nope.status, 403);
  assert.match(nope.body.error, /reports to you/);
  assert.equal((await call(empTok, '/pms/timesheet/team')).status, 403);
  assert.equal((await call(empTok, '/pms/timesheet/all')).status, 403);
});

test('a manager sees their reports, and cannot open anybody else', { skip }, async () => {
  const r = await call(mgrTok, '/pms/timesheet/team?as_of=2026-09-25');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.team.map((x) => x.employee.email), ['ts-emp@x.com']);
  assert.equal(r.body.team[0].has_data, true);
  // The detail route is guarded on the ROW, not on the path.
  assert.equal((await call(mgrTok, `/pms/timesheet/employee/${empId}`)).status, 200);
  const nope = await call(mgrTok, `/pms/timesheet/employee/${farId}`);
  assert.equal(nope.status, 403);
  // ...and the company-wide list stays shut.
  assert.equal((await call(mgrTok, '/pms/timesheet/all')).status, 403);
});

test('HR sees everybody, and people with no upload are "no data" rather than Red', { skip }, async () => {
  const r = await call(adminTok, '/pms/timesheet/all?as_of=2026-09-25');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.employees.map((x) => [x.employee.email, x]));
  assert.equal(by['ts-emp@x.com'].has_data, true);
  assert.equal(by['ts-mgr@x.com'].has_data, false, 'the manager has uploaded nothing');
  // No data and zero are different facts, and the API has to say so:
  // a roster printing Red against everybody who has not uploaded yet
  // sends managers chasing people who have done nothing wrong.
  assert.equal(by['ts-mgr@x.com'].rating, null);
  assert.equal(by['ts-mgr@x.com'].pct, null);
  // Somebody WITH data always carries a rating. Not asserting which one:
  // this employee's overall spans two cycles and the colour is the
  // cycle maths' business, tested against literals in
  // timesheet-rules.test.js.
  assert.ok(['Green', 'Amber', 'Red'].includes(by['ts-emp@x.com'].rating));
  assert.equal(typeof by['ts-emp@x.com'].pct, 'number');
  assert.equal(r.body.totals.employees, 4);
  assert.equal(r.body.totals.with_data, 2);
  assert.equal(r.body.totals.no_data, 2);
  // The colour counts describe the people who HAVE data, and nothing else.
  assert.equal(r.body.totals.green + r.body.totals.amber + r.body.totals.red, 2);
  assert.ok(r.body.departments.includes('Development'));
});

test('a file that is not a timesheet is refused with a reason', { skip }, async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Main');
  ws.addRow(['Name', 'Hours']); ws.addRow(['Arun', 8]);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())]), 'nope.xlsx');
  const r = await fetch(`${base}/pms/timesheet/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${empTok}` }, body: fd,
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Log Date/);
});

test('a row naming somebody who is not an employee is reported, not guessed at', { skip }, async () => {
  const r = await upload(adminTok, [{ date: '2026-09-21', name: 'Nobody At All', email: 'ghost@x.com' }]);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.loadable, 0);
  assert.match(r.body.errors[0].error, /no employee on file/);
});

test('only HR may change what Green means, and the thresholds must make sense', { skip }, async () => {
  assert.equal((await call(empTok, '/pms/timesheet/settings', 'PUT', { cycle_start_day: 1, green_pct: 50, amber_pct: 20 })).status, 403);
  const bad = await call(adminTok, '/pms/timesheet/settings', 'PUT', { cycle_start_day: 40, green_pct: 90, amber_pct: 75 });
  assert.equal(bad.status, 422);
  const inverted = await call(adminTok, '/pms/timesheet/settings', 'PUT', { cycle_start_day: 21, green_pct: 60, amber_pct: 80 });
  assert.equal(inverted.status, 422, 'an Amber bar above the Green one makes everything Green');
  const badHol = await call(adminTok, '/pms/timesheet/settings', 'PUT', { cycle_start_day: 21, green_pct: 90, amber_pct: 75, holidays: '25-12-2026' });
  assert.equal(badHol.status, 422);
  assert.match(badHol.body.error, /YYYY-MM-DD/);

  const ok = await call(adminTok, '/pms/timesheet/settings', 'PUT',
    { cycle_start_day: 21, green_pct: 80, amber_pct: 60, holidays: '2026-09-25' });
  assert.equal(ok.status, 200);
  // ...and the change reaches the employee's own page, because both read
  // the same tenant setting rather than each holding a copy.
  const mine = await call(empTok, '/pms/timesheet/me?as_of=2026-09-25');
  const sep = mine.body.cycles.find((c) => c.start === '2026-09-21');
  assert.equal(sep.work, 4, 'the 25th is now a holiday');
  assert.equal(sep.pct, 100);
  assert.equal(sep.rating, 'Green');
});

test('every upload is audited against the employee it touched', { skip }, async () => {
  const rows = (await db.query(
    `SELECT action, employee_id, details FROM pms.audit_log
      WHERE tenant_id=$1 AND action='TIMESHEET_UPLOADED' ORDER BY at`, [tenantId])).rows;
  assert.ok(rows.length >= 3, 'one row per employee per upload');
  assert.ok(rows.some((r) => r.employee_id === empId));
  assert.ok(rows.some((r) => r.employee_id === farId));
  assert.ok(rows.every((r) => r.details && r.details.file));
});
