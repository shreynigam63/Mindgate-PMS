// node --test — every template the product hands out is accepted by the
// importer that produced it.
//
// This exists because the compensation .xlsx template shipped broken for
// about ten minutes: I gave it a banner row, and validateCompRows reads
// row 1 as the header, so the product rejected its own download with
// "Missing required column(s)". The CSV beside it was fine. Nothing in
// the unit tests noticed, because each half was tested on its own.
//
// The rule this file enforces: a template is not a document, it is the
// input half of a contract, and the only way to know it holds is to send
// it back. "Rejected because the sample row names a fake employee" is a
// PASS — that is the documented behaviour and every template says to
// delete its samples. "Rejected because the columns were not found" is a
// failure, and is the shape of the bug this catches.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
let app, request, tok, server;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-roundtrip';
  process.env.TENANT_SLUG = 'tpl-roundtrip-' + Date.now();
  process.env.AUTH_DEV = 'true';
  const express = require('express');
  const db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, designation)
     VALUES ($1,'TPL Admin','tpl-admin@x.com','active','Head of HR')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tpl-admin@x.com','admin')`, [t.id]);
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'tpl-admin@x.com',$2)`,
    [t.id, await bcrypt.hash('pass', 10)]);

  app = express();
  app.use(express.json());
  // core/auth exports devLogin as a handler, not a router — mounted the
  // same way the other server tests do it.
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/people', require('../modules/people').router);
  server = app.listen(0);
  const port = server.address().port;
  request = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, opts);
  tok = (await (await request('/api/v1/auth/dev-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tpl-admin@x.com', password: 'pass' }) })).json()).token;
});

// Without this the file never exits: requiring the performance module
// opens a pool, and node --test waits on the open handles. A test file
// that hangs takes the whole suite with it.
after(async () => {
  if (server) server.close();
  try { await require('../core/db').pool.end(); } catch { /* already closed */ }
});

// [name, template path, upload path, filename]
const PAIRS = [
  ['employees',     '/api/v1/employees/import-template.xlsx',             '/api/v1/employees/import?commit=0',                   'employee_import_template.xlsx'],
  ['career matrix', '/api/v1/people/career/transitions/template.xlsx',    '/api/v1/people/career/transitions/upload?commit=0',   'career_transitions_template.xlsx'],
  ['KRA sheets',    '/api/v1/pms/hr/kra-sheet/bulk-upload-template.xlsx', '/api/v1/pms/hr/kra-sheet/bulk-upload?commit=0',       'kra_bulk_upload_template.xlsx'],
  ['KRA library',   '/api/v1/pms/hr/kra-library/template.xlsx',           '/api/v1/pms/hr/kra-library/upload?commit=0',          'kra_library_template.xlsx'],
  ['prior ratings', '/api/v1/pms/watchlist/prior-ratings/template.xlsx',  '/api/v1/pms/watchlist/prior-ratings/upload?commit=0', 'prior_ratings_template.xlsx'],
  ['compensation',  '/api/v1/pms/compensation/template.xlsx',             '/api/v1/pms/compensation/upload?commit=0',            'compensation_template.xlsx'],
  ['compensation (csv)', '/api/v1/pms/compensation/template.csv',         '/api/v1/pms/compensation/upload?commit=0',            'compensation_template.csv'],
];

// A fatal is the importer saying it could not read the FILE — wrong
// columns, not a sheet, empty. Per-row errors about sample data are a
// different thing entirely and are expected.
const roundTrip = async (tplPath, upPath, filename) => {
  const t = await request(`${tplPath}?token=${tok}`);
  assert.equal(t.status, 200, `${tplPath} did not download`);
  const buf = Buffer.from(await t.arrayBuffer());
  assert.ok(buf.length > 0, `${tplPath} downloaded empty`);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  const r = await request(upPath, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, fatal: j.fatal || (r.status === 400 ? j.error : null), body: j, bytes: buf.length };
};

for (const [name, tplPath, upPath, filename] of PAIRS) {
  test(`the ${name} template is READ by its own importer`, async (t) => {
    if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
    const r = await roundTrip(tplPath, upPath, filename);
    assert.equal(r.fatal, null,
      `the ${name} template was refused outright: ${r.fatal}. `
      + 'A banner row above the header is the usual cause — some importers hunt for the header row and some read row 1.');
    assert.ok(r.status !== 400, `${name}: ${JSON.stringify(r.body).slice(0, 200)}`);
  });
}

test('the compensation template works once its sample row names a real employee', async (t) => {
  if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
  // WRITTEN TWICE. Asserting only "no fatal" above would pass on a
  // template whose columns parse but whose every row then fails — so one
  // case walks the whole journey an HR user takes, and expects zero
  // errors at the end of it.
  const csv = await (await request(`/api/v1/pms/compensation/template.csv?token=${tok}`)).text();
  const filled = csv.replace('jane.sample@example.com', 'tpl-admin@x.com');
  const fd = new FormData();
  fd.append('file', new Blob([filled], { type: 'text/csv' }), 'compensation.csv');
  const r = await request('/api/v1/pms/compensation/upload?commit=0', {
    method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: fd });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j).slice(0, 200));
  assert.equal(j.ok, true, JSON.stringify(j.errors || []).slice(0, 200));
  assert.deepEqual(j.errors, []);
  assert.equal(j.rows[0].annual_ctc, 1200000, 'and the figure survives the round trip as a number');
});

test('every template that ships sample rows says to delete them', async (t) => {
  if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
  // The prior-ratings template shipped two sample rows and no such
  // instruction, so uploading it unchanged produced two red errors naming
  // people who do not exist — which reads as "the upload is broken".
  const ExcelJS = require('exceljs');
  for (const [name, tplPath] of [
    ['prior ratings', '/api/v1/pms/watchlist/prior-ratings/template.xlsx'],
    ['compensation', '/api/v1/pms/compensation/template.xlsx'],
    ['KRA sheets', '/api/v1/pms/hr/kra-sheet/bulk-upload-template.xlsx'],
    ['employees', '/api/v1/employees/import-template.xlsx'],
  ]) {
    const buf = Buffer.from(await (await request(`${tplPath}?token=${tok}`)).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    let text = '';
    wb.eachSheet((ws) => ws.eachRow((row) => { text += ' ' + row.values.map((v) => (v == null ? '' : String(v))).join(' '); }));
    assert.match(text, /delete .{0,24}(sample|example)|(sample|example).{0,30}delete/i,
      `the ${name} template ships example data without telling anyone to remove it`);
  }
});
