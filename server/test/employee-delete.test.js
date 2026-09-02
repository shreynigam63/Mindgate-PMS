// node --test — employee deletion (core/employees.js), the most
// consequential route in this file. Real Postgres, real HTTP surface,
// skips cleanly without DATABASE_URL. Focused specifically on the two
// hardest-to-get-right properties: (1) deleting a MANAGER does not
// destroy their REPORTS' own KRA/appraisal data, and (2) everything
// really is gone afterward across the tables that are the deleted
// person's own.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, mgrId, reportId, cycleId, sheetId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deleteemp';
  process.env.TENANT_SLUG = 'deleteemp-test-' + Date.now();
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

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Del HR','del-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Del Mgr','del-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const report = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, manager_id, status) VALUES ($1,'Del Report','del-report@x.com',$2,'active') RETURNING id`, [t.id, mgr.id])).rows[0];
  mgrId = mgr.id; reportId = report.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'del-hr@x.com','hr'),($1,'del-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['del-hr@x.com', 'del-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Del Cycle','FYD','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  // Report's own KRA sheet, with the manager set — this is exactly the
  // record that must survive the manager's deletion, just with
  // manager_id nulled.
  const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING id`, [t.id, cycle.id, report.id, mgr.id])).rows[0];
  sheetId = sheet.id;
  await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight) VALUES ($1,$2,'Report KRA',100)`, [t.id, sheet.id]);
  // A manager_evaluations row where del-mgr is the MANAGER (NOT NULL
  // column) — this specific row cannot survive del-mgr's deletion.
  await db.query(`INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'pending')`, [t.id, cycle.id, report.id, mgr.id]);
  // A connect logged by del-mgr about the report — manager_id is NOT NULL there too.
  await db.query(`INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, notes) VALUES ($1,$2,$3,'2026-01-01','test note')`, [t.id, mgr.id, report.id]);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
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
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('a plain manager cannot delete anyone; HR cannot delete their own logged-in account', { skip }, async () => {
  const mgrAuth = await login('del-mgr@x.com');
  const blocked = await api(`/employees/${reportId}`, mgrAuth.token, { method: 'DELETE' });
  assert.equal(blocked.status, 403);

  const hrAuth = await login('del-hr@x.com');
  const hrId = hrAuth.user.id;
  const selfDelete = await api(`/employees/${hrId}`, hrAuth.token, { method: 'DELETE' });
  assert.equal(selfDelete.status, 422);
});

test('deleting a MANAGER preserves the report\'s own KRA sheet, but removes review rows that required a manager', { skip }, async () => {
  const before1 = (await db.query(`SELECT manager_id FROM pms.kra_sheets WHERE id=$1`, [sheetId])).rows[0];
  assert.equal(before1.manager_id, mgrId);

  const { token } = await login('del-hr@x.com');
  const r = await api(`/employees/${mgrId}`, token, { method: 'DELETE' });
  assert.equal(r.status, 200);

  // The report's own KRA sheet (and its KRA rows, via cascade) still exist.
  const sheet = (await db.query(`SELECT manager_id FROM pms.kra_sheets WHERE id=$1`, [sheetId])).rows[0];
  assert.ok(sheet, 'the report\'s own KRA sheet was NOT deleted');
  assert.equal(sheet.manager_id, null, 'manager_id nulled out, not left dangling');
  const kras = await db.query(`SELECT COUNT(*)::int AS n FROM pms.kras WHERE sheet_id=$1`, [sheetId]);
  assert.equal(kras.rows[0].n, 1, 'the KRA row itself is untouched');

  // manager_evaluations and connects where del-mgr was the (NOT NULL)
  // manager are gone -- documented, unavoidable given the schema.
  const evals = await db.query(`SELECT COUNT(*)::int AS n FROM pms.manager_evaluations WHERE employee_id=$1`, [reportId]);
  assert.equal(evals.rows[0].n, 0, 'the manager-side evaluation row could not survive — no valid manager_id to fall back to');
  const connects = await db.query(`SELECT COUNT(*)::int AS n FROM pms.connects WHERE employee_id=$1`, [reportId]);
  assert.equal(connects.rows[0].n, 0);

  // The report themselves still exists as an employee, untouched.
  const reportRow = await db.query(`SELECT id FROM core.employees WHERE id=$1`, [reportId]);
  assert.equal(reportRow.rows.length, 1, 'the report is NOT deleted just because their manager was');
});

test('deleting an employee removes their login, role, and audit-logs the deletion', { skip }, async () => {
  const { token } = await login('del-hr@x.com');
  const cred = await db.query(`SELECT 1 FROM core.local_credentials WHERE LOWER(email)='del-mgr@x.com'`);
  assert.equal(cred.rows.length, 0, 'del-mgr\'s login credentials are gone (deleted in the previous test)');
  const role = await db.query(`SELECT 1 FROM core.user_roles WHERE LOWER(email)='del-mgr@x.com'`);
  assert.equal(role.rows.length, 0);

  const audit = await db.query(`SELECT details FROM core.audit_log WHERE action='EMPLOYEE_DELETED' AND entity_id=$1`, [mgrId]);
  assert.equal(audit.rows.length, 1, 'the deletion itself is recorded in the audit log, even though the employee row is gone');
  assert.equal(audit.rows[0].details.email, 'del-mgr@x.com');
});

test('deleting a not-found employee id returns 404', { skip }, async () => {
  const { token } = await login('del-hr@x.com');
  const r = await api('/employees/00000000-0000-0000-0000-000000000000', token, { method: 'DELETE' });
  assert.equal(r.status, 404);
});
