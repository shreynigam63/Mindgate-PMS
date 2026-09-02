// node --test — KRA bulk-upload warns when a title redundantly includes
// the employee's own name/designation, and the one-time "Clean up KRA
// titles" repair action strips that exact pattern from existing KRAs.
// Found live with a screenshot: a bulk upload's source file had
// "(Employee Name - Designation)" typed onto the end of every title.
// Confirmed this isn't something the bulk-upload code itself adds (it
// passes kra_title through verbatim) — a data-entry issue in the source
// file, not a recurring code bug. Real Postgres, real HTTP surface,
// skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, cycleId, sheetId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ktc';
  process.env.TENANT_SLUG = 'ktc-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'KTC Admin','ktc-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, designation) VALUES ($1,'Aaraf Ali','ktc-emp@x.com','active','Software Developer') RETURNING id`,
    [t.id])).rows[0];
  empId = emp.id;
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'KTC Stranger','ktc-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ktc-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ktc-admin@x.com', 'ktc-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'KTC Cycle','FYKTC','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'draft') RETURNING id`, [t.id, cycleId, empId])).rows[0];
  sheetId = sheet.id;
  // Exactly the pattern from the report: title with the employee's own
  // "(Name - Designation)" appended, plus one clean title and one that
  // legitimately contains parentheses for an unrelated reason (must be
  // left alone).
  await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES
    ($1,$2,'Feature Delivery & Code Quality (Aaraf Ali - Software Developer)',30,10),
    ($1,$2,'Sprint & Release Reliability (Aaraf Ali - Software Developer)',25,20),
    ($1,$2,'Already Clean Title',25,30),
    ($1,$2,'Reduce cost by 10% (target FY26)',20,40)`,
    [t.id, sheetId]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

async function login(email) {
  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) });
  return r.json();
}
async function apiJson(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
async function upload(path, token, filename, content) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/csv' }), filename);
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: r.status, body: await r.json() };
}

test('bulk upload warns (not rejects) when a kra_title redundantly includes the employee\'s own name', { skip }, async () => {
  const { token } = await login('ktc-admin@x.com');
  const csv = 'employee_email,kra_title,weight\nktc-emp@x.com,"Own Domain Delivery (Aaraf Ali - Software Developer)",100\n';
  const r = await upload('/pms/hr/kra-sheet/bulk-upload', token, 'kras.csv', csv);
  assert.equal(r.status, 200, 'a warning is not a fatal error — dry run still succeeds');
  assert.equal(r.body.ok, true);
  assert.ok(r.body.warnings.some((w) => /own name/.test(w.warning)), 'warns specifically about the redundant name');
});

test('POST /hr/kra-sheet/clean-titles strips the exact Name/Designation suffix, leaves other titles alone, is admin-only', { skip }, async () => {
  const strangerAuth = await login('ktc-stranger@x.com');
  const blocked = await apiJson('/pms/hr/kra-sheet/clean-titles', strangerAuth.token, { method: 'POST' });
  assert.equal(blocked.status, 403);

  const adminAuth = await login('ktc-admin@x.com');
  const r = await apiJson('/pms/hr/kra-sheet/clean-titles', adminAuth.token, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleaned, 2, 'exactly the two polluted titles, not the clean one or the one with unrelated parentheses');

  const rows = (await db.query(`SELECT title FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheetId])).rows;
  assert.equal(rows[0].title, 'Feature Delivery & Code Quality');
  assert.equal(rows[1].title, 'Sprint & Release Reliability');
  assert.equal(rows[2].title, 'Already Clean Title', 'untouched');
  assert.equal(rows[3].title, 'Reduce cost by 10% (target FY26)', 'a legitimate parenthetical is left alone, not stripped');
});

test('re-running clean-titles finds nothing left to clean (idempotent)', { skip }, async () => {
  const { token } = await login('ktc-admin@x.com');
  const r = await apiJson('/pms/hr/kra-sheet/clean-titles', token, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleaned, 0);
});
