// node --test — PMS Completion Report, See Past Years (history), Team
// Overview, and the idempotent Re-seed HOD evaluations utility.
// Requested after a BRD/reference-menu review confirmed these four were
// missing. Real Postgres, real HTTP surface, skips cleanly without
// DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, pastCycleId, empId, mgrId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-rar';
  process.env.TENANT_SLUG = 'rar-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department) VALUES ($1,'RAR Mgr','rar-mgr@x.com','active','Engineering') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id, department) VALUES ($1,'RAR Emp','rar-emp@x.com','active',$2,'Engineering') RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'RAR Admin','rar-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'RAR Stranger','rar-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'rar-mgr@x.com','manager')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'rar-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['rar-mgr@x.com', 'rar-emp@x.com', 'rar-admin@x.com', 'rar-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, opens_at) VALUES ($1,'RAR Cycle','FYRAR','annual','hod_eval','2026-04-01') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;

  const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`, [t.id, cycleId, empId])).rows[0];
  await db.query(`INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved')`, [t.id, cycleId, empId]);
  await db.query(`INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'submitted')`, [t.id, cycleId, empId]);
  await db.query(`INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'submitted')`, [t.id, cycleId, empId, mgrId]);
  await db.query(`INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, discussion_notes) VALUES ($1,$2,$3,'2026-05-01','check-in')`, [t.id, mgrId, empId]);
  await db.query(`INSERT INTO people.career_paths (tenant_id, employee_id, target_role) VALUES ($1,$2,'Staff Engineer')`, [t.id, empId]);

  // A past, published cycle for the history test.
  const pastCycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'RAR Past','FYPAST','annual','closed') RETURNING id`, [t.id])).rows[0];
  pastCycleId = pastCycle.id;
  await db.query(`INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating, rating_label) VALUES ($1,$2,$3,4.2,'Exceeds')`, [t.id, empId, pastCycle.id]);
  // One approved KRA on the CLOSED cycle and nothing else, so the
  // cycle_id test below proves real per-cycle scoping rather than just
  // getting an empty result set back.
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved')`, [t.id, pastCycleId, empId]);

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

test('PMS Completion Report: admin-only, correctly marks a fully-submitted employee as complete', { skip }, async () => {
  const strangerAuth = await login('rar-stranger@x.com');
  const blocked = await api('/pms/reports/completion', strangerAuth.token);
  assert.equal(blocked.status, 403);

  const adminAuth = await login('rar-admin@x.com');
  const r = await api('/pms/reports/completion', adminAuth.token);
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.employee_id === empId);
  assert.ok(row);
  assert.equal(row.kra_status, 'approved');
  assert.equal(row.self_appraisal_status, 'submitted');
  assert.equal(row.complete, true);

  const strangerRow = r.body.rows.find((x) => x.name === 'RAR Stranger');
  assert.equal(strangerRow.kra_status, 'not_started');
  assert.equal(strangerRow.complete, false);
});

test('See Past Years: employee sees their own history; manager can see a report\'s; a stranger cannot', { skip }, async () => {
  const empAuth = await login('rar-emp@x.com');
  const mine = await api('/pms/my/history', empAuth.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.history.length, 1);
  assert.equal(mine.body.history[0].rating_label, 'Exceeds');
  assert.equal(Number(mine.body.history[0].final_rating), 4.2);

  const mgrAuth = await login('rar-mgr@x.com');
  const team = await api(`/pms/team/history/${empId}`, mgrAuth.token);
  assert.equal(team.status, 200);
  assert.equal(team.body.history.length, 1);

  const strangerAuth = await login('rar-stranger@x.com');
  const blocked = await api(`/pms/team/history/${empId}`, strangerAuth.token);
  assert.equal(blocked.status, 403);
});

test('Team Overview: shows the manager\'s report with KRA/Dev Plan/Career Path/Connects all correctly aggregated', { skip }, async () => {
  const mgrAuth = await login('rar-mgr@x.com');
  const r = await api('/pms/team/overview', mgrAuth.token);
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.employee_id === empId);
  assert.ok(row);
  assert.equal(row.kra_status, 'approved');
  assert.equal(row.has_career_path, true);
  assert.equal(row.connects_this_cycle, 1);

  const strangerAuth = await login('rar-stranger@x.com');
  const blocked = await api('/pms/team/overview', strangerAuth.token);
  assert.equal(blocked.status, 403, 'requires pms_team_eval');
});

test('Re-seed HOD evaluations: creates a pending entry for the submitted manager evaluation, is idempotent, and skips departments with no head', { skip }, async () => {
  const adminAuth = await login('rar-admin@x.com');

  // No department head assigned yet for Engineering — should skip, not error.
  const first = await api('/pms/hod/re-seed', adminAuth.token, { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.body.checked, 1);
  assert.equal(first.body.created, 0);
  assert.equal(first.body.skipped_no_head, 1);

  // Assign a head, then re-seed again — should now create the entry.
  const head = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'RAR Head','rar-head@x.com','active') RETURNING id`, [tenantId])).rows[0];
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Engineering',$2)`, [tenantId, head.id]);

  const second = await api('/pms/hod/re-seed', adminAuth.token, { method: 'POST' });
  assert.equal(second.body.created, 1);

  const check = (await db.query(`SELECT status FROM pms.hod_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
  assert.equal(check.status, 'pending');

  // Running it a third time must not create a duplicate or error (idempotent).
  const third = await api('/pms/hod/re-seed', adminAuth.token, { method: 'POST' });
  assert.equal(third.status, 200);
  assert.equal(third.body.created, 0, 'already exists — nothing new to create');

  const count = (await db.query(`SELECT COUNT(*)::int AS n FROM pms.hod_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
  assert.equal(count.n, 1, 'still exactly one row, not duplicated');
});

// Regression: this report resolved its cycle ONLY through activeCycle(),
// which filters out closed/cancelled — so it went blank at precisely the
// moment HR wants it, just as a cycle closes. An explicit cycle_id must
// reach a closed cycle, and omitting it must preserve the old default.
test('Completion Report: cycle_id reaches a CLOSED cycle, still defaults to active without it', { skip }, async () => {
  const adminAuth = await login('rar-admin@x.com');

  // No cycle_id — unchanged behaviour, resolves the open cycle.
  const dflt = await api('/pms/reports/completion', adminAuth.token);
  assert.equal(dflt.status, 200);
  assert.equal(dflt.body.cycle.id, cycleId);

  // Explicit closed cycle — previously unreachable.
  const past = await api(`/pms/reports/completion?cycle_id=${pastCycleId}`, adminAuth.token);
  assert.equal(past.status, 200);
  assert.equal(past.body.cycle.id, pastCycleId);
  assert.equal(past.body.cycle.phase, 'closed');
  assert.equal(past.body.cycle.name, 'RAR Past');

  // Rows must be scoped to THAT cycle. This employee has an approved KRA
  // in the closed cycle and nothing else, whereas in the active cycle
  // their self-appraisal is submitted — so the joins prove the scoping.
  const row = past.body.rows.find((x) => x.employee_id === empId);
  assert.ok(row, 'employee present in the closed-cycle report');
  assert.equal(row.kra_status, 'approved');
  assert.equal(row.self_appraisal_status, 'not_started', 'scoped to the closed cycle, not the active one');
  assert.equal(row.complete, false);

  // Unknown id is a clean 404, not a silent fall back to the active cycle.
  const missing = await api('/pms/reports/completion?cycle_id=00000000-0000-0000-0000-000000000000', adminAuth.token);
  assert.equal(missing.status, 404);

  // Malformed id must 404 too, not 500 on the uuid cast.
  const junk = await api('/pms/reports/completion?cycle_id=not-a-uuid', adminAuth.token);
  assert.equal(junk.status, 404);

  // Still admin-gated when a cycle_id is supplied.
  const strangerAuth = await login('rar-stranger@x.com');
  const blocked = await api(`/pms/reports/completion?cycle_id=${pastCycleId}`, strangerAuth.token);
  assert.equal(blocked.status, 403);
});
