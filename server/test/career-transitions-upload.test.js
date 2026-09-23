// node --test — bulk upload for the Career Pathing Matrix.
//
// Asked for on 17 Sep: "can we have template upload option so HR can
// upload template for next defined roles." Building the matrix one
// transition at a time through the modal is an afternoon of clicking for
// a company with 90 job titles, with no way to review the ladder before
// committing it.
//
// The two things an importer has to get right are what it REFUSES and
// what it does the SECOND time. Both are covered below: a file with any
// error writes nothing at all, and re-uploading a transition updates it
// instead of adding a duplicate — otherwise a corrected file doubles the
// matrix.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { validateCareerTransitionRows } = require('../modules/people/career-transitions-import');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, empTok, tenantId;

const HEADERS = ['From Role', 'From Level', 'To Role', 'To Level', 'Expected Level Change',
  'Min Time In Current Role (Months)', 'Typical Time In Current Role (Months)',
  'Required Competencies', 'Notes'];

// ---- pure rules, no database ------------------------------------------

test('the header is found below a banner, and aliases are accepted', () => {
  const r = validateCareerTransitionRows([
    ['Some instruction banner nobody deletes'],
    ['Current Role', 'From Band', 'Target Role', 'To Band', 'Level Change', 'Min Months', 'Typical Months', 'Skills', 'Comments'],
    ['Executive', '', 'Senior Executive', '', '1', '12', '18', 'Ownership', 'ok'],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].to_role, 'Senior Executive');
  assert.equal(r.rows[0].min_time_months, 12);
});

test('a file with no recognisable header is refused whole, not row by row', () => {
  const r = validateCareerTransitionRows([['Name', 'Age'], ['Bob', 5]]);
  assert.match(r.fatal, /header row/i);
  assert.equal(r.rows.length, 0);
});

test('the rules that reject a row', () => {
  const r = validateCareerTransitionRows([
    HEADERS,
    ['', '', 'Manager', '', '', '', '', '', ''],                       // no From Role
    ['Executive', '', 'Executive', '', '', '', '', '', ''],            // to itself
    ['Executive', 'L1', 'Executive', 'L2', '', '', '', '', ''],        // same role, DIFFERENT level: fine
    ['Executive', '', 'Manager', '', 'soon', '', '', '', ''],          // not a number
    ['Executive', '', 'Senior Executive', '', '', '', '', '', ''],
    ['executive', '', '  Senior   Executive ', '', '', '', '', '', ''], // same rung, different spelling
  ]);
  assert.equal(r.ok, false);
  const at = (line) => r.errors.filter((e) => e.line === line).map((e) => e.error).join(' | ');
  assert.match(at(2), /required/);
  assert.match(at(3), /moves to itself/);
  assert.equal(at(4), '', 'a level change within one role is a real transition');
  assert.match(at(5), /whole number/);
  assert.match(at(7), /duplicate of line 6/);
});

test('competencies split on newlines, semicolons or pipes', () => {
  const one = (cell) => validateCareerTransitionRows([HEADERS,
    ['A', '', 'B', '', '', '', '', cell, '']]).rows[0].required_competencies;
  assert.deepEqual(one('x\ny'), ['x', 'y']);
  assert.deepEqual(one('x; y'), ['x', 'y']);
  assert.deepEqual(one('x | y'), ['x', 'y']);
  assert.deepEqual(one('  '), []);
});

test('a role nobody holds WARNS — it never rejects', () => {
  // The point of a career matrix is roles people grow into. Rejecting a
  // target role with no incumbent would make the feature useless on day
  // one, when no one holds the senior roles yet.
  const r = validateCareerTransitionRows([HEADERS,
    ['Executive', '', 'Chief Executive', '', '', '', '', '', '']], new Set(['executive']));
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.match(r.warnings[0].warning, /Chief Executive.*not a designation/);
});

// ---- the real routes ---------------------------------------------------

const xlsx = async (rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('T');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const upload = async (buf, { commit = false, name = 'f.xlsx', tok } = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(`${base}/people/career/transitions/upload${commit ? '?commit=1' : ''}`,
    { method: 'POST', headers: { Authorization: `Bearer ${tok || hrTok}` }, body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const count = async () => (await db.query(
  `SELECT count(*)::int AS n FROM people.career_transitions WHERE tenant_id=$1`, [tenantId])).rows[0].n;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ctu';
  process.env.TENANT_SLUG = 'ctu-test-' + Date.now();
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
  for (const [name, email, desig] of [
    ['CT HR', 'ctu-hr@x.com', 'Executive'], ['CT Emp', 'ctu-emp@x.com', 'Senior Executive']]) {
    await db.query(`INSERT INTO core.employees (tenant_id,name,email,status,designation) VALUES ($1,$2,$3,'active',$4)`,
      [t.id, name, email, desig]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ctu-hr@x.com','admin')`, [t.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  hrTok = await login('ctu-hr@x.com');
  empTok = await login('ctu-emp@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the template downloads, and is people_admin-only', { skip }, async () => {
  for (const ext of ['xlsx', 'csv']) {
    const ok = await fetch(`${base}/people/career/transitions/template.${ext}`, { headers: { Authorization: `Bearer ${hrTok}` } });
    assert.equal(ok.status, 200, ext);
    const no = await fetch(`${base}/people/career/transitions/template.${ext}`, { headers: { Authorization: `Bearer ${empTok}` } });
    assert.equal(no.status, 403, `${ext} must not be open to any employee`);
  }
});

test('THE APP\'S OWN TEMPLATE IMPORTS — no drift between the two', { skip }, async () => {
  // The failure guarded against: HR downloads the official file, fills it
  // in, and every row is rejected because a header was renamed on one
  // side only.
  const r = await fetch(`${base}/people/career/transitions/template.xlsx`, { headers: { Authorization: `Bearer ${hrTok}` } });
  const out = await upload(Buffer.from(await r.arrayBuffer()));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true, JSON.stringify(out.body.errors));
  // Three sample rows since the Department column landed (migration
  // 044): two company-wide and one showing the same move scoped to a
  // department, which is the one rule a column heading cannot explain.
  assert.equal(out.body.summary.total_rows, 3, 'the three sample rows');
  // The sample's newline-separated competencies survive the round trip.
  assert.ok(out.body.rows[0].required_competencies.length >= 2);
  // And the departmental sample must come back scoped, not flattened to
  // company-wide — that would make the template teach the wrong rule.
  assert.deepEqual(out.body.rows.map((x) => x.department), [null, null, 'Sales']);
});

test('VALIDATE WRITES NOTHING', { skip }, async () => {
  const before = await count();
  const out = await upload(await xlsx([HEADERS, ['Executive', '', 'Senior Executive', '', 1, 12, 18, 'Ownership', '']]));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.committed, false);
  assert.equal(await count(), before, 'a dry run must not touch the matrix');
});

test('publish creates, and says how many', { skip }, async () => {
  const out = await upload(await xlsx([
    HEADERS,
    ['Executive', '', 'Senior Executive', '', 1, 12, 18, 'Ownership\nCoaching', 'standard step'],
    ['Senior Executive', '', 'Team Lead', '', 1, 18, 24, 'Runs a team', ''],
  ]), { commit: true });
  assert.equal(out.body.committed, true);
  assert.equal(out.body.created, 2);
  assert.equal(out.body.updated, 0);
  const rows = (await db.query(
    `SELECT * FROM people.career_transitions WHERE tenant_id=$1 ORDER BY from_role`, [tenantId])).rows;
  assert.equal(rows.length, 2);
  const exec = rows.find((x) => x.from_role === 'Executive');
  assert.deepEqual(exec.required_competencies, ['Ownership', 'Coaching']);
  assert.equal(exec.min_time_months, 12);
  assert.equal(exec.active, true);
});

test('RE-UPLOADING UPDATES, IT DOES NOT DUPLICATE', { skip }, async () => {
  // Without this a corrected file doubles the matrix, and the second copy
  // is indistinguishable from the first on screen.
  const before = await count();
  const out = await upload(await xlsx([
    HEADERS,
    ['executive', '', '  Senior Executive', '', 2, 6, 9, 'Ownership', 'revised'],
  ]), { commit: true });
  assert.equal(out.body.created, 0, 'matched despite the case and spacing');
  assert.equal(out.body.updated, 1);
  assert.equal(await count(), before, 'no new row');
  const row = (await db.query(
    `SELECT * FROM people.career_transitions WHERE tenant_id=$1 AND lower(from_role)='executive'`, [tenantId])).rows[0];
  assert.equal(row.expected_level_change, 2);
  assert.equal(row.min_time_months, 6);
  assert.equal(row.notes, 'revised');
});

test('A FILE WITH ONE BAD ROW WRITES NOTHING AT ALL', { skip }, async () => {
  const before = await count();
  const out = await upload(await xlsx([
    HEADERS,
    ['Team Lead', '', 'Manager', '', 1, 12, 18, '', ''],        // fine on its own
    ['Manager', '', 'Manager', '', 1, 12, 18, '', ''],          // to itself
  ]), { commit: true });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.committed, false, 'a commit request on a bad file must still write nothing');
  assert.equal(await count(), before, 'including the good row above it');
  assert.match(out.body.errors[0].error, /moves to itself/);
});

test('the dry run says how many are new and how many are updates', { skip }, async () => {
  const out = await upload(await xlsx([
    HEADERS,
    ['Executive', '', 'Senior Executive', '', 1, 12, 18, '', ''],   // exists
    ['Team Lead', '', 'Manager', '', 1, 12, 18, '', ''],            // new
  ]));
  assert.equal(out.body.committed, false);
  assert.equal(out.body.summary.update, 1);
  assert.equal(out.body.summary.create, 1);
});

test('a CSV works too, and an employee cannot upload at all', { skip }, async () => {
  const csv = [HEADERS.join(','), 'Manager,,Senior Manager,,1,24,30,Delegation; Hiring,'].join('\n');
  const out = await upload(Buffer.from(csv, 'utf8'), { commit: true, name: 'x.csv' });
  assert.equal(out.body.committed, true);
  assert.equal(out.body.created, 1);
  const row = (await db.query(
    `SELECT required_competencies FROM people.career_transitions WHERE tenant_id=$1 AND from_role='Manager'`, [tenantId])).rows[0];
  assert.deepEqual(row.required_competencies, ['Delegation', 'Hiring']);

  const denied = await upload(Buffer.from(csv, 'utf8'), { commit: true, name: 'x.csv', tok: empTok });
  assert.equal(denied.status, 403);
});

test('legacy .xls is refused with instructions, not a stack trace', { skip }, async () => {
  const out = await upload(Buffer.from('anything'), { name: 'old.xls' });
  assert.equal(out.status, 400);
  assert.match(out.body.error, /re-save the file as \.xlsx/i);
});

test('the bulk change is audited', { skip }, async () => {
  const rows = (await db.query(
    `SELECT actor_email, details FROM core.audit_log
      WHERE tenant_id=$1 AND action='CAREER_TRANSITIONS_UPLOADED' ORDER BY at`, [tenantId])).rows;
  assert.ok(rows.length >= 1, 'a matrix change decides which moves the product accepts');
  assert.equal(rows[0].actor_email, 'ctu-hr@x.com');
  assert.ok(Number.isInteger(rows[0].details.created));
});
