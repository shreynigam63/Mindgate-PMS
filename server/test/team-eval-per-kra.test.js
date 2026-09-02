// node --test — Manager evaluation per-KRA rating (BR-5.4), mirroring
// Self-Appraisal's per-KRA feature: a rating + comment against each KRA,
// with overall_rating auto-computed as the weighted average — plus the
// Delivery Head Review detail endpoint showing both sides per KRA.
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, cycleId, empId, sheetId, kraAId, kraBId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tepk';
  process.env.TENANT_SLUG = 'tepk-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'TEPK Mgr','tepk-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'TEPK Emp','tepk-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tepk-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['tepk-mgr@x.com', 'tepk-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const scale = JSON.stringify([{ value: 5, label: 'A+' }, { value: 4, label: 'A' }, { value: 3, label: 'B+' }, { value: 2, label: 'B' }, { value: 1, label: 'C' }]);
  // Mid-year cycle_type, so overall_rating is derived from KRA weights,
  // not the 7-parameter engine (that's annual-only, unaffected by this).
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, rating_scale) VALUES ($1,'TEPK Cycle','FYTEPK','midyear','manager_eval',$2) RETURNING id`,
    [t.id, scale])).rows[0];
  cycleId = cycle.id;

  const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`, [t.id, cycle.id, empId, mgr.id])).rows[0];
  sheetId = sheet.id;
  const kraA = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Ship the launch',70,10) RETURNING id`, [t.id, sheetId])).rows[0];
  const kraB = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Support the team',30,20) RETURNING id`, [t.id, sheetId])).rows[0];
  kraAId = kraA.id; kraBId = kraB.id;

  // Employee's own self-appraisal, so the HOD detail endpoint has both
  // sides to show.
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, entries, status) VALUES ($1,$2,$3,$4,'submitted')`,
    [t.id, cycle.id, empId, JSON.stringify({ [kraAId]: { self_rating: 5, narrative: 'Shipped early' }, [kraBId]: { self_rating: 4, narrative: 'Helped onboard two people' } })]);

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
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('GET /team/evaluations/:employeeId/kras returns the KRA list for the manager', { skip }, async () => {
  const { token } = await login('tepk-mgr@x.com');
  const r = await api(`/pms/team/evaluations/${empId}/kras`, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.kras.length, 2);
});

test('manager rating per KRA auto-computes overall_rating as the weighted average', { skip }, async () => {
  const { token } = await login('tepk-mgr@x.com');
  const entries = { [kraAId]: { rating: 5, comment: 'Great execution' }, [kraBId]: { rating: 2, comment: 'Needs more consistency' } };
  const put = await api(`/pms/team/evaluations/${empId}`, token, { method: 'PUT', body: JSON.stringify({ entries }) });
  assert.equal(put.status, 200);
  // 70/30 weights: 5*0.7 + 2*0.3 = 4.1
  assert.equal(Number(put.body.overall_rating), 4.1);
});

test('the Delivery Head detail endpoint shows both the employee self-rating and the manager rating+comment, per KRA', { skip }, async () => {
  // Uses an admin login (bypasses the department-head scoping check
  // entirely in this endpoint) for a reliable permission path, rather
  // than standing up full department_heads wiring just for this test —
  // that scoping is exercised elsewhere.
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'TEPK Admin','tepk-admin@x.com','active') RETURNING id`, [t])).rows[0];
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'tepk-admin@x.com',$2)`, [t, await bcrypt.hash('pass', 10)]);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tepk-admin@x.com','admin')`, [t]);

  const { token } = await login('tepk-admin@x.com');
  const r = await api(`/pms/hod/queue/${empId}/kras`, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.kras.length, 2);
  assert.equal(r.body.self_entries[kraAId].self_rating, 5);
  assert.equal(r.body.manager_entries[kraAId].rating, 5);
  assert.equal(r.body.manager_entries[kraAId].comment, 'Great execution');
});
