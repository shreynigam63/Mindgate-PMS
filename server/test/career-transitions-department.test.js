// node --test — Department on the Career Pathing Matrix (migration 044).
//
// Asked for on 23 Sep with the filled-in template attached: Department as
// the first column of the career transitions sheet. A ladder is not
// company-wide in a business with 1,400 people — "Executive → Senior
// Executive" means something different in Sales and in Infrastructure.
//
// THE THREE THINGS THAT MATTER, all pinned below:
//
//   1. BLANK MEANS EVERYONE. Every transition written before this column
//      existed has no department, and must keep applying to the whole
//      company. A new column that quietly narrows a live matrix would be
//      the worst possible outcome of adding one.
//   2. THE DEPARTMENT IS PART OF A ROW'S IDENTITY. The same move in two
//      departments is two rungs, so re-uploading one must not overwrite
//      the other — that is the importer's update rule, and it is keyed
//      on the row, not on the move.
//   3. MOST SPECIFIC WINS. Where a department has written its own
//      version of a move AND a company-wide version exists, the employee
//      sees exactly one: theirs. Showing both would offer the same step
//      twice with contradictory competencies and time-in-role figures.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { validateCareerTransitionRows, COLUMNS, rowKey } = require('../modules/people/career-transitions-import');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, tenantId, salesEmpId, infraEmpId, hrEmpId;

const HEADERS = COLUMNS.map(([, label]) => label);

// ---- pure rules, no database ------------------------------------------

test('Department leads the template, exactly as the attached sheet has it', () => {
  assert.equal(HEADERS[0], 'Department');
  assert.deepEqual(HEADERS, [
    'Department', 'From Role', 'From Level', 'To Role', 'To Level', 'Expected Level Change',
    'Min Time In Current Role (Months)', 'Typical Time In Current Role (Months)',
    'Required Competencies', 'Notes',
  ]);
});

test('a sheet WITHOUT the column still imports — the old template keeps working', () => {
  // HR has the previous nine-column file saved locally. Rejecting it, or
  // silently shifting every value one column left, would both be worse
  // than ignoring the absent field.
  const r = validateCareerTransitionRows([
    ['From Role', 'From Level', 'To Role', 'To Level', 'Expected Level Change',
      'Min Time In Current Role (Months)', 'Typical Time In Current Role (Months)',
      'Required Competencies', 'Notes'],
    ['Executive', '', 'Senior Executive', '', '1', '12', '18', 'Ownership', 'ok'],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows[0].department, null, 'absent column reads as company-wide, not as ""');
  assert.equal(r.rows[0].to_role, 'Senior Executive');
  assert.equal(r.rows[0].min_time_months, 12, 'the other columns did not shift');
});

test('the same move in two departments is two rows, not a duplicate', () => {
  const r = validateCareerTransitionRows([
    HEADERS,
    ['Sales', 'Executive', '', 'Senior Executive', '', '1', '9', '12', 'Carries a quota', ''],
    ['Infrastructure', 'Executive', '', 'Senior Executive', '', '1', '18', '24', 'Owns an on-call rota', ''],
    ['', 'Executive', '', 'Senior Executive', '', '1', '12', '18', 'Owns a workstream', ''],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.length, 3, 'all three are distinct rungs');
  assert.equal(new Set(r.rows.map(rowKey)).size, 3);
});

test('the same move in the SAME department twice is still a duplicate', () => {
  const r = validateCareerTransitionRows([
    HEADERS,
    ['Sales', 'Executive', '', 'Senior Executive', '', '', '', '', '', ''],
    ['sales', '  executive ', '', 'Senior  Executive', '', '', '', '', '', ''],
  ]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].error, /duplicate of line 2/);
});

test('a department nobody belongs to WARNS — it never rejects', () => {
  // Same judgement as an unheld role: a matrix may describe a team being
  // stood up. But a typo silently narrows the rung to nobody, so it has
  // to be said out loud.
  const r = validateCareerTransitionRows([HEADERS,
    ['Sals', 'Executive', '', 'Senior Executive', '', '', '', '', '', '']],
  new Set(['executive', 'senior executive']), new Set(['sales']));
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.match(r.warnings.map(w => w.warning).join(' | '), /Department "Sals".*match nobody/);
});

test('"Dept" and "Function" are accepted as the column name', () => {
  const r = validateCareerTransitionRows([
    ['Dept', 'From Role', 'To Role'],
    ['Sales', 'Executive', 'Senior Executive'],
  ]);
  assert.equal(r.rows[0].department, 'Sales');
});

// ---- the real routes ---------------------------------------------------

const xlsx = async (rows) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('T');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
};
const upload = async (buf, { commit = false } = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'f.xlsx');
  const r = await fetch(`${base}/people/career/transitions/upload${commit ? '?commit=1' : ''}`,
    { method: 'POST', headers: { Authorization: `Bearer ${hrTok}` }, body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (path, tok) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok || hrTok}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ctd';
  process.env.TENANT_SLUG = 'ctd-test-' + Date.now();
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

  const mk = async (name, email, dept, desig) => {
    const id = (await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,department,designation)
       VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`, [t.id, name, email, dept, desig])).rows[0].id;
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
    return id;
  };
  hrEmpId = await mk('CTD HR', 'ctd-hr@x.com', 'HR', 'Manager');
  salesEmpId = await mk('CTD Sales', 'ctd-sales@x.com', 'Sales', 'Executive');
  infraEmpId = await mk('CTD Infra', 'ctd-infra@x.com', 'Infrastructure', 'Executive');
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ctd-hr@x.com','admin')`, [t.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  hrTok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ctd-hr@x.com', password: 'pass' }),
  })).json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the department survives the upload and comes back on the row', { skip }, async () => {
  const buf = await xlsx([
    HEADERS,
    ['', 'Executive', '', 'Senior Executive', '', 1, 12, 18, 'Owns a workstream', 'company-wide'],
    ['Sales', 'Executive', '', 'Senior Executive', '', 1, 9, 12, 'Carries a quota', 'sales only'],
    ['Infrastructure', 'Executive', '', 'Senior Executive', '', 1, 18, 24, 'Owns an on-call rota', 'infra only'],
  ]);
  const r = await upload(buf, { commit: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 3, 'three rungs, not one move deduplicated to one row');

  const list = await get('/people/career/transitions');
  const byDept = Object.fromEntries(list.body.transitions.map(t => [t.department || '(all)', t]));
  assert.deepEqual(Object.keys(byDept).sort(), ['(all)', 'Infrastructure', 'Sales']);
  assert.equal(byDept.Sales.min_time_months, 9);
  assert.equal(byDept.Infrastructure.min_time_months, 18);
  assert.equal(byDept['(all)'].min_time_months, 12);
});

test('re-uploading one department does not overwrite the other', { skip }, async () => {
  // The importer's update rule is keyed on the ROW. If the department
  // were left out of that key, publishing a corrected Sales file would
  // silently rewrite the Infrastructure rung with Sales figures.
  const buf = await xlsx([
    HEADERS,
    ['Sales', 'Executive', '', 'Senior Executive', '', 1, 6, 8, 'Carries a bigger quota', 'revised'],
  ]);
  const r = await upload(buf, { commit: true });
  assert.equal(r.body.created, 0);
  assert.equal(r.body.updated, 1, 'it updated the Sales rung, not created a fourth');

  const rows = (await db.query(
    `SELECT department, min_time_months FROM people.career_transitions WHERE tenant_id=$1`,
    [tenantId])).rows;
  assert.equal(rows.length, 3, 'still three rungs');
  const m = Object.fromEntries(rows.map(r2 => [r2.department || '(all)', r2.min_time_months]));
  assert.deepEqual(m, { '(all)': 12, Sales: 6, Infrastructure: 18 });
});

test('MOST SPECIFIC WINS: an employee sees their department version, once', { skip }, async () => {
  // Asserted against eligibleTransitionsFor directly, because that is
  // where the choice is made and it is what the agentic module reads for
  // competencies and timings. The employee-facing route only exposes
  // target role NAMES, which would hide a duplicate behind its own
  // de-duplication and let this regress unnoticed.
  const { eligibleTransitionsFor } = require('../modules/people');
  const got = await eligibleTransitionsFor(tenantId, salesEmpId);
  assert.equal(got.length, 1, 'the same move must not be offered twice');
  assert.equal(got[0].department, 'Sales');
  assert.equal(got[0].min_time_months, 6, "Sales' own figures, not the company-wide ones");
  assert.deepEqual(got[0].required_competencies, ['Carries a bigger quota']);
});

test('an employee whose department has no rung gets the company-wide one', { skip }, async () => {
  const { eligibleTransitionsFor } = require('../modules/people');
  await db.query(`UPDATE core.employees SET designation='Executive', department='Finance' WHERE id=$1`, [hrEmpId]);
  const got = await eligibleTransitionsFor(tenantId, hrEmpId);
  assert.equal(got.length, 1);
  assert.equal(got[0].department, null, 'the company-wide rung still reaches everybody');
  assert.equal(got[0].min_time_months, 12);
});

test('the company-wide rung reaches an employee in a department that HAS one for another move', { skip }, async () => {
  // Infrastructure has its own Executive -> Senior Executive. Adding a
  // company-wide rung for a DIFFERENT move must still reach them: most
  // specific wins per MOVE, not per employee.
  const { eligibleTransitionsFor } = require('../modules/people');
  await db.query(
    `INSERT INTO people.career_transitions (tenant_id, department, from_role, to_role, min_time_months)
     VALUES ($1, NULL, 'Executive', 'Team Lead', 30)`, [tenantId]);
  const got = await eligibleTransitionsFor(tenantId, infraEmpId);
  const byTo = Object.fromEntries(got.map(t => [t.to_role, t]));
  assert.deepEqual(Object.keys(byTo).sort(), ['Senior Executive', 'Team Lead']);
  assert.equal(byTo['Senior Executive'].department, 'Infrastructure');
  assert.equal(byTo['Team Lead'].department, null);
});

test('a rung belonging only to OTHER departments is excluded, and says why', { skip }, async () => {
  const { eligibleTransitionsFor, careerPathDiagnostics } = require('../modules/people');
  // Leave Infrastructure's employee with nothing but Sales' rung in reach.
  await db.query(`DELETE FROM people.career_transitions
                   WHERE tenant_id=$1 AND coalesce(btrim(department),'')=''`, [tenantId]);
  await db.query(`DELETE FROM people.career_transitions
                   WHERE tenant_id=$1 AND department='Infrastructure'`, [tenantId]);
  assert.equal((await eligibleTransitionsFor(tenantId, infraEmpId)).length, 0);

  // "No career path is configured from your role" would be FALSE — one
  // is configured, it is simply filed under another department. Before
  // the department column existed this case could not arise; now it can,
  // and it would send HR hunting for a row that already exists.
  const d = await careerPathDiagnostics(tenantId, infraEmpId);
  assert.equal(d.reason, 'department_mismatch', JSON.stringify(d));
  assert.deepEqual(d.excluded_by_department, ['Sales']);
  assert.equal(d.department, 'Infrastructure');
});

test('the downloadable template carries the column, and the sample shows the rule', { skip }, async () => {
  // The ask was literally "add this to the template", so the file HR
  // downloads is checked, not just the parser that reads it back.
  const r = await fetch(`${base}/people/career/transitions/template.xlsx`,
    { headers: { Authorization: `Bearer ${hrTok}` } });
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.worksheets[0];
  const header = ws.getRow(2).values.slice(1).map(String);
  assert.deepEqual(header, HEADERS);
  // A sample row with a department, so the one rule a heading cannot
  // explain is demonstrated rather than described.
  const depts = [3, 4, 5].map((n) => ws.getRow(n).getCell(1).value);
  assert.ok(depts.some((d) => d === 'Sales'), `no departmental sample row: ${JSON.stringify(depts)}`);

  // And the template must survive its own round trip.
  const rows = [];
  ws.eachRow((row) => rows.push(row.values.slice(1)));
  const back = validateCareerTransitionRows(rows);
  assert.equal(back.ok, true, JSON.stringify(back.errors));
  assert.equal(back.rows.length, 3);
  assert.deepEqual(back.rows.map((x) => x.department), [null, null, 'Sales']);
});
