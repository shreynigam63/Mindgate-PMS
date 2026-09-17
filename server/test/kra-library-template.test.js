// node --test — the file HR downloads from the KRA Library screen.
//
// Updated 17 Sep with a filled-in example from the client: the template
// was missing the Department column. The parser has accepted one since
// migration 034 (Department / Dept / Departments / Business Unit), but
// the downloadable file never had it, so the only way to discover the
// feature was to read the source. That is why not one published row on
// live data carries a department while the department dimension is
// switched on.
//
// The point of this file is that the template and the parser cannot drift
// apart again: the last test downloads the real .xlsx and feeds it to the
// real importer.
//
// Real Postgres and a real HTTP surface, because the routes are
// pms_admin-gated and the .xlsx is built by the route itself.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, empTok;

const EXPECTED = ['Department', 'Designation', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)',
  'KPIs \n(Measuring Metrics & Data Source)', 'Suggested Weightage', 'Comments'];

const get = (path, tok) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tpl';
  process.env.TENANT_SLUG = 'tpl-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  for (const [name, email] of [['Tpl HR', 'tpl-hr@x.com'], ['Tpl Emp', 'tpl-emp@x.com']]) {
    await db.query(`INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,$2,$3,'active')`, [t.id, name, email]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'tpl-hr@x.com','admin')`, [t.id]);

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
  hrTok = await login('tpl-hr@x.com');
  empTok = await login('tpl-emp@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('THE .XLSX TEMPLATE LEADS WITH DEPARTMENT', { skip }, async () => {
  const r = await get('/pms/hr/kra-library/template.xlsx', hrTok);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const ws = wb.getWorksheet('KRA Library');
  // Row 1 is the merged banner, row 2 the headers.
  const headers = ws.getRow(2).values.slice(1).map((v) => (v && v.richText ? v.richText.map((x) => x.text).join('') : v));
  assert.deepEqual(headers, EXPECTED);
});

test('the banner states the forward-fill rule, not just that the column exists', { skip }, async () => {
  // The one thing about this column that can silently publish the wrong
  // shelf. A blank cell means "company-wide" at the start of a block and
  // "same as above" inside one; HR cannot tell those apart by looking.
  const r = await get('/pms/hr/kra-library/template.xlsx', hrTok);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  const banner = String(wb.getWorksheet('KRA Library').getRow(1).getCell(1).value || '');
  assert.match(banner, /company-wide/i);
  assert.match(banner, /carries down/i, 'the fill must be stated');
  assert.match(banner, /new Designation clears it/i, 'and so must the reset');
});

test('DEPARTMENT FILLS DOWN A BLOCK AND RESETS ON A NEW DESIGNATION', { skip }, async () => {
  // The behaviour the banner promises, checked against the parser rather
  // than assumed. Written because the opposite was documented for a day:
  // a test that only tried a blank Department across a designation CHANGE
  // saw the reset and was read as "Department never fills down".
  const { validateKraBulkRows } = require('../modules/performance');
  const { parseExcelSheets } = require('../core/employees');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('L');
  ws.addRow(['Department', 'Designation', 'Parameters', 'KRA', 'KPIs', 'Suggested Weightage']);
  for (const row of [
    ['Admin', 'Manager', 'Financial', 'A', 'm', 10],
    ['', '', 'Customer', 'B', 'm', 10],                 // inside the block → Admin
    ['', 'Senior Manager', 'People', 'C', 'm', 10],     // new title → cleared
    ['Sales', '', 'Financial', 'D', 'm', 10],           // named mid-block
    ['', '', 'Customer', 'E', 'm', 10],                 // inside it → Sales
  ]) ws.addRow(row);
  const rep = validateKraBulkRows(await parseExcelSheets(Buffer.from(await wb.xlsx.writeBuffer())),
    new Set(['manager', 'senior manager']), null, { keyField: 'designation' });
  assert.equal(rep.summary.errors, 0);
  assert.deepEqual(rep.rows.map((x) => x.department), ['Admin', 'Admin', null, 'Sales', 'Sales']);
});

test('the .csv carries the same columns as the .xlsx', { skip }, async () => {
  const r = await get('/pms/hr/kra-library/template.csv', hrTok);
  assert.equal(r.status, 200);
  const first = (await r.text()).split('\n')[0];
  // Newlines inside a header are flattened to spaces for CSV.
  assert.deepEqual(first.split(',').map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"')),
    EXPECTED.map((h) => h.replace(/\s*\n\s*/g, ' ')));
});

test('both templates stay pms_admin-only', { skip }, async () => {
  for (const p of ['/pms/hr/kra-library/template.xlsx', '/pms/hr/kra-library/template.csv']) {
    assert.equal((await get(p, empTok)).status, 403, `${p} must not be public`);
  }
});

test('THE TEMPLATE THE ROUTE EMITS ACTUALLY IMPORTS — no drift', { skip }, async () => {
  // The failure this guards against is a header renamed in the template
  // and not in the parser's alias list: HR downloads the official file,
  // fills it in, and every row is rejected.
  const { validateKraBulkRows } = require('../modules/performance');
  const { parseExcelSheets } = require('../core/employees');

  const r = await get('/pms/hr/kra-library/template.xlsx', hrTok);
  const buf = Buffer.from(await r.arrayBuffer());
  // parseExcelSheets is async — forgetting the await yields a promise,
  // which the validator reads as an empty file and calls a clean parse.
  const report = validateKraBulkRows(await parseExcelSheets(buf), new Set(['manager']), null, { keyField: 'designation' });
  assert.ok(!report.fatal, `the template must not read as an empty file: ${report.fatal}`);

  assert.equal(report.summary.errors, 0, `the app's own template must parse: ${JSON.stringify(report.rows.filter((x) => x.error).slice(0, 3))}`);
  assert.equal(report.rows.length, 3, 'three sample rows, banner and header skipped');
  // And the Department column is actually read, not merely present.
  // All three samples sit in one Admin / Manager block, so all three carry
  // Admin — the second and third by the fill, which is the client's file
  // as they sent it.
  assert.deepEqual(report.rows.map((x) => x.department), ['Admin', 'Admin', 'Admin']);
  assert.deepEqual([...new Set(report.rows.map((x) => x.designation))], ['Manager']);
});
