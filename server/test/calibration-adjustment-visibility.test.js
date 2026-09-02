// node --test — GET /pms/calibration now surfaces the adjustment reason
// itself (who, when, why), not just the resulting number. Found live
// during a UX review: the reason typed into the mandatory "why did my
// rating change" prompt was saved to pms.rating_adjustments but never
// displayed anywhere again — the page's own caption calls it "the
// permanent answer," but nothing surfaced that answer. Real Postgres,
// real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, cycleId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cav';
  process.env.TENANT_SLUG = 'cav-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CAV Mgr','cav-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id, department) VALUES ($1,'CAV Emp','cav-emp@x.com','active',$2,'Sales') RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CAV Admin','cav-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'cav-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['cav-admin@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, bell_curve) VALUES ($1,'CAV Cycle','FYCAV','annual','calibration','{}') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  await db.query(`INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, overall_rating, status) VALUES ($1,$2,$3,$4,2.1,'submitted')`, [t.id, cycleId, empId, mgr.id]);

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

test('before any adjustment, GET /calibration returns no adjustment_reason for the row', { skip }, async () => {
  const { token } = await login('cav-admin@x.com');
  const r = await api('/pms/calibration', token);
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.employee_id === empId);
  assert.equal(row.proposed, '2.1');
  assert.equal(row.adjustment_reason, null);
});

test('after an adjustment, GET /calibration surfaces the reason, who made it, and when — not just the new number', { skip }, async () => {
  const { token } = await login('cav-admin@x.com');
  const adjust = await api('/pms/calibration/adjust', token, {
    method: 'POST', body: JSON.stringify({ employee_id: empId, from_rating: 2.1, to_rating: 3, reason: 'Aligned to peer group after calibration discussion' }),
  });
  assert.equal(adjust.status, 200);

  const r = await api('/pms/calibration', token);
  const row = r.body.rows.find((x) => x.employee_id === empId);
  assert.equal(Number(row.proposed), 3, 'proposed now reflects the adjustment');
  assert.equal(row.adjustment_reason, 'Aligned to peer group after calibration discussion', 'the reason itself is now visible, not just the resulting number');
  assert.equal(row.adjusted_by, 'cav-admin@x.com');
  assert.ok(row.adjusted_at, 'a timestamp is present');
});
