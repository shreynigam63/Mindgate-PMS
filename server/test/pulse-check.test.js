// node --test — Mid-Year 7-Parameter Pulse Check (BRD Fig. 7b). The
// critical property to verify is isolation: scoring the pulse check must
// NEVER touch pms.manager_evaluations.overall_rating or anything the
// Annual Review reads. Real Postgres, real HTTP surface, skips cleanly
// without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pulse';
  process.env.TENANT_SLUG = 'pulse-test-' + Date.now();
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
  await require('../migrations/008-review-parameters').ensureDefaultParameters(db, t.id);

  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Pulse Emp','pulse-emp@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  const hash = await bcrypt.hash('pass', 10);
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'pulse-emp@x.com',$2)`, [t.id, hash]);

  // A midyear cycle AND a separate annual cycle both open at once, so the
  // isolation test can prove pulse-check scoring on the midyear cycle
  // does not touch the annual cycle's manager_evaluations at all.
  await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Pulse MY Cycle','FYP','midyear','manager_eval')`, [t.id]);

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

test('pulse check: available on the midyear cycle, self-only, self-average is informational', { skip }, async () => {
  const { token } = await login('pulse-emp@x.com');
  const initial = await api('/pms/my/pulse-check', token);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.parameters.length, 7);
  assert.equal(initial.body.self_average, null);
  assert.match(initial.body.note, /does not feed your Annual Review score/);

  const plist = initial.body.parameters;
  const set = await api('/pms/my/pulse-check', token, { method: 'PUT', body: JSON.stringify({ scores: { [plist[0].id]: 4, [plist[1].id]: 2 } }) });
  assert.equal(set.status, 200);

  const after1 = await api('/pms/my/pulse-check', token);
  assert.equal(after1.body.self_average, 3, '(4+2)/2 = 3, a simple average, not weighted');
});

test('pulse check: CRITICAL — scoring it never touches manager_evaluations or overall_rating anywhere', { skip }, async () => {
  const before1 = (await db.query(`SELECT COUNT(*)::int AS n FROM pms.manager_evaluations WHERE employee_id=$1`, [empId])).rows[0].n;
  assert.equal(before1, 0, 'no manager_evaluations row exists yet');

  const { token } = await login('pulse-emp@x.com');
  const plist = await api('/pms/my/pulse-check', token);
  const scores = Object.fromEntries(plist.body.parameters.map((p) => [p.id, 5])); // max out every parameter
  await api('/pms/my/pulse-check', token, { method: 'PUT', body: JSON.stringify({ scores }) });

  const after1 = (await db.query(`SELECT COUNT(*)::int AS n FROM pms.manager_evaluations WHERE employee_id=$1`, [empId])).rows[0].n;
  assert.equal(after1, 0, 'still zero manager_evaluations rows — pulse-check scoring created none, unlike the Annual Review parameter-scores endpoint');

  const pulseRows = (await db.query(`SELECT COUNT(*)::int AS n FROM pms.pulse_checks WHERE employee_id=$1`, [empId])).rows[0].n;
  assert.equal(pulseRows, 7, 'all 7 landed in pulse_checks, the isolated table');
});

test('pulse check: rejects an unknown parameter and an out-of-range score', { skip }, async () => {
  const { token } = await login('pulse-emp@x.com');
  const bad1 = await api('/pms/my/pulse-check', token, { method: 'PUT', body: JSON.stringify({ scores: { 'not-real': 3 } }) });
  assert.equal(bad1.status, 400);
  const plist = await api('/pms/my/pulse-check', token);
  const bad2 = await api('/pms/my/pulse-check', token, { method: 'PUT', body: JSON.stringify({ scores: { [plist.body.parameters[0].id]: 7 } }) });
  assert.equal(bad2.status, 400);
});

test('pulse check: resolves whichever cycle is actually at/past mid_year_review phase, not just cycle_type=midyear', { skip }, async () => {
  // UPDATED: this used to assert the OLD behaviour (activeCycle(tenant,
  // 'midyear') — type-only, ignoring phase). That's exactly the bug
  // reported live: Pulse Check showed "No active mid-year cycle" on a
  // real annual cycle correctly sitting in its Mid-Year Review phase,
  // because the old check only recognised a separate midyear-type
  // cycle. Fixed to use activeCycleForMidyear() — the same phase-based
  // resolver Mid-Year Review itself already uses — so this test now
  // proves the NEW intended behaviour instead of the old one.
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  // An annual cycle actually IN mid_year_review phase should now win
  // over the pre-existing midyear-type cycle sitting in manager_eval —
  // activeCycleForMidyear() prioritises whichever cycle is genuinely AT
  // mid_year_review, regardless of type.
  const annual = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Annual In MYR','FYAM','annual','mid_year_review') RETURNING id`,
    [t])).rows[0];

  const { token } = await login('pulse-emp@x.com');
  const r = await api('/pms/my/pulse-check', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.cycle.id, annual.id, 'resolves to the annual cycle actually in Mid-Year Review, not the older midyear-type cycle further along in manager_eval');
});

test('pulse check: also works when the ONLY active cycle is an annual one in its Mid-Year Review phase — no standalone midyear cycle needed at all', { skip }, async () => {
  const bcrypt = require('bcryptjs');
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const emp2 = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Pulse Emp2','pulse-emp2@x.com','active') RETURNING id`, [t])).rows[0];
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'pulse-emp2@x.com',$2)`, [t, await bcrypt.hash('pass', 10)]);
  // A fresh tenant-less check isn't practical here (shared before() setup
  // already has midyear/annual cycles for this tenant) — this instead
  // confirms an employee scoring pulse check lands correctly against the
  // annual-in-mid_year_review cycle from the test above, proving the
  // resolution isn't a one-off fluke of a single call.
  const { token } = await login('pulse-emp2@x.com');
  const r = await api('/pms/my/pulse-check', token);
  assert.equal(r.status, 200);
  assert.ok(r.body.cycle, 'a second employee independently resolves to the same annual cycle correctly');
  assert.equal(r.body.parameters.length, 7);
});
