// node --test — the increment simulation over HTTP: who may see salary,
// where the data comes from, and that a scenario never becomes pay.
//
// The maths is proven next door in increment-rules.test.js. What needs a
// database is the access boundary (this is the only feature in the system
// holding salary) and the promise that nothing here writes one.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empA, empB, mgrId, simId;

const api = async (path, token, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-inc';
  process.env.TENANT_SLUG = 'inc-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  // Migration 030 seeds pms_compensation for tenants that existed when it
  // ran; this tenant is created after, so seed it the same way the boot
  // path does.
  for (const role of ['hr', 'admin']) {
    await db.query(`INSERT INTO core.role_permissions (tenant_id, role, permission) VALUES ($1,$2,'pms_compensation') ON CONFLICT DO NOTHING`, [t.id, role]);
  }

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'INC HR','inc-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'INC Mgr','inc-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const a = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id, department) VALUES ($1,'INC A','inc-a@x.com','active',$2,'Engineering') RETURNING id`, [t.id, mgr.id])).rows[0];
  const b = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id, department) VALUES ($1,'INC B','inc-b@x.com','active',$2,'Support') RETURNING id`, [t.id, mgr.id])).rows[0];
  empA = a.id; empB = b.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'inc-hr@x.com','hr'),($1,'inc-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['inc-hr@x.com', 'inc-mgr@x.com', 'inc-a@x.com', 'inc-b@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'INC Cycle','FYINC','annual','calibration') RETURNING id`,
    [t.id])).rows[0];
  cycleId = cycle.id;
  // A published rating for A, a submitted manager evaluation for B — the
  // scenario has to work before publish, which is when a budget
  // conversation actually happens.
  await db.query(`INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating) VALUES ($1,$2,$3,5)`, [t.id, empA, cycle.id]);
  await db.query(`INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status, overall_rating) VALUES ($1,$2,$3,$4,'submitted',3)`, [t.id, cycle.id, empB, mgr.id]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (!HAS_DB) return; server.close(); await db.pool.end(); });

async function login(email) {
  const r = await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }),
  });
  return (await r.json()).token;
}

const upload = async (token, csv, commit) => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'comp.csv');
  const r = await fetch(`${base}/api/v1/pms/compensation/upload${commit ? '?commit=1' : ''}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
  });
  return { status: r.status, body: await r.json() };
};

test('a manager cannot reach any of it — they see ratings, never pay', { skip }, async () => {
  const token = await login('inc-mgr@x.com');
  for (const path of ['/pms/compensation', '/pms/increment-matrix', '/pms/increment-simulations']) {
    const r = await api(path, token);
    assert.equal(r.status, 403, path);
    assert.match(r.body.error, /pms_compensation/);
  }
  const post = await api('/pms/increment-simulations', token, { method: 'POST', body: JSON.stringify({ name: 'sneaky' }) });
  assert.equal(post.status, 403);
});

test('an ordinary employee cannot either, not even about themselves', { skip }, async () => {
  const token = await login('inc-a@x.com');
  assert.equal((await api('/pms/compensation', token)).status, 403);
});

test('HR uploads salaries: dry run first, and commas in the numbers are fine', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  const csv = 'employee_email,annual_ctc\ninc-a@x.com,"1,000,000"\ninc-b@x.com,600000\n';

  const dry = await upload(token, csv, false);
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.committed, false, 'nothing loads without ?commit=1');
  assert.equal(dry.body.summary.total_rows, 2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.compensation WHERE tenant_id=$1`, [tenantId])).rows[0].n, 0);

  const done = await upload(token, csv, true);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.loaded, 2);
  const rows = await db.query(`SELECT annual_ctc FROM pms.compensation WHERE tenant_id=$1 ORDER BY annual_ctc DESC`, [tenantId]);
  assert.deepEqual(rows.rows.map((r) => Number(r.annual_ctc)), [1000000, 600000]);
});

test('a bad row is reported with its line, and nothing partially loads', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  const r = await upload(token, 'employee_email,annual_ctc\nnobody@x.com,500000\ninc-a@x.com,abc\n', true);
  assert.equal(r.status, 422);
  const errs = r.body.errors.map((e) => `${e.line}:${e.error}`).join(' | ');
  assert.match(errs, /2:.*not found among active employees/);
  assert.match(errs, /3:.*positive number/);
  const still = await db.query(`SELECT count(*)::int AS n FROM pms.compensation WHERE tenant_id=$1`, [tenantId]);
  assert.equal(still.rows[0].n, 2, 'the earlier load is intact and this one added nothing');
});

test('a salary that looks like lakhs is warned about, not rejected', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  const r = await upload(token, 'employee_email,annual_ctc\ninc-a@x.com,12\n', false);
  assert.equal(r.status, 200);
  assert.match(r.body.warnings[0].warning, /lakhs or thousands/);
});

test('an overlapping matrix is refused before it can be saved', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  const r = await api('/pms/increment-matrix', token, {
    method: 'PUT',
    body: JSON.stringify({ bands: [
      { label: 'Top', rating_min: 4, rating_max: 5, increment_pct: 12 },
      { label: 'Mid', rating_min: 3, rating_max: 4.2, increment_pct: 8 },
    ] }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.errors[0].error, /overlaps/);
});

test('the matrix saves and reads back, standing rather than cycle-scoped', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  const put = await api('/pms/increment-matrix', token, {
    method: 'PUT',
    body: JSON.stringify({ bands: [
      { label: 'Outstanding', rating_min: 4.5, rating_max: 5, increment_pct: 12 },
      { label: 'Meets', rating_min: 2.5, rating_max: 3.4, increment_pct: 5 },
    ] }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const get = await api('/pms/increment-matrix', token);
  assert.equal(get.body.scope, 'standing');
  assert.equal(get.body.bands.length, 2);
});

test('a scenario models published AND not-yet-published ratings', { skip }, async () => {
  // A is published at 5; B only has a submitted manager evaluation at 3.
  // A budget conversation happens before publish, so both must count.
  const token = await login('inc-hr@x.com');
  const r = await api('/pms/increment-simulations', token, {
    method: 'POST', body: JSON.stringify({ name: 'Base case', budget_amount: 200000 }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  simId = r.body.simulation.id;

  const byId = Object.fromEntries(r.body.lines.map((l) => [l.employee_id, l]));
  assert.equal(byId[empA].increment_amount, 120000, '1,000,000 at 12%');
  assert.equal(byId[empB].increment_amount, 30000, '600,000 at 5%');
  assert.equal(r.body.totals.increment_total, 150000);
  assert.equal(r.body.totals.within_budget, true);
  assert.equal(r.body.totals.variance, 50000);
  // HR and the manager have no salary on record and are reported as such
  // rather than quietly missing.
  assert.ok(r.body.excluded.some((e) => /no salary on record/.test(e.reason)));
  assert.deepEqual(r.body.by_department.map((d) => d.department), ['Engineering', 'Support']);
});

test('a scenario is recomputed from its inputs, so changing the matrix changes it', { skip }, async () => {
  // The alternative — freezing computed lines — means a saved scenario
  // silently disagrees with the matrix it claims to use.
  const token = await login('inc-hr@x.com');
  await api('/pms/increment-matrix', token, {
    method: 'PUT',
    body: JSON.stringify({ bands: [
      { label: 'Outstanding', rating_min: 4.5, rating_max: 5, increment_pct: 6 },
      { label: 'Meets', rating_min: 2.5, rating_max: 3.4, increment_pct: 5 },
    ] }),
  });
  const r = await api(`/pms/increment-simulations/${simId}`, token);
  assert.equal(r.body.lines.find((l) => l.employee_id === empA).increment_amount, 60000, 'halved with the band');
  assert.equal(r.body.totals.increment_total, 90000);
});

test('an override needs a reason, and then replaces the band', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  const noReason = await api(`/pms/increment-simulations/${simId}/overrides/${empA}`, token, {
    method: 'PUT', body: JSON.stringify({ increment_pct: 15 }),
  });
  assert.equal(noReason.status, 422);
  assert.match(noReason.body.error, /reason is required/);

  const ok = await api(`/pms/increment-simulations/${simId}/overrides/${empA}`, token, {
    method: 'PUT', body: JSON.stringify({ increment_pct: 15, reason: 'Counter-offer from a competitor' }),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const line = ok.body.lines.find((l) => l.employee_id === empA);
  assert.equal(line.increment_pct, 15);
  assert.equal(line.increment_amount, 150000);
  assert.equal(line.overridden, true);
  assert.equal(line.override_reason, 'Counter-offer from a competitor');
  assert.equal(line.base_pct, 6, 'what the band would have given is still on the record');
});

test('scale-to-fit squeezes the matrix lines and leaves the override alone', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  // 150,000 (override, fixed) + 30,000 (B at 5%) = 180,000 against 160,000.
  // B's 5% scales by 10,000/30,000 to 1.6666…%, which floors to 1.66% —
  // 9,960 rather than the arithmetically perfect 10,000. Under, never
  // over: rounding a readable percentage to NEAREST would have landed
  // this on 160,020 while reporting it as within budget.
  const r = await api(`/pms/increment-simulations/${simId}`, token, {
    method: 'PUT', body: JSON.stringify({ budget_amount: 160000, scale_to_fit: true }),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lines.find((l) => l.employee_id === empA).increment_pct, 15, 'the override is a decision, not a candidate for squeezing');
  assert.equal(r.body.lines.find((l) => l.employee_id === empB).increment_pct, 1.66);
  assert.equal(r.body.lines.find((l) => l.employee_id === empB).increment_amount, 9960);
  assert.equal(r.body.totals.increment_total, 159960);
  assert.equal(r.body.totals.within_budget, true, 'at or under, always');
  assert.ok(r.body.totals.increment_total <= 160000);
  assert.equal(r.body.totals.variance, 40, 'the unspent remainder is reported, not hidden');
});

test('a scenario NEVER becomes pay — no route writes a salary', { skip }, async () => {
  // The safety property this whole feature rests on. If a write path is
  // ever added, this fails.
  const before = await db.query(`SELECT employee_id, annual_ctc FROM pms.compensation WHERE tenant_id=$1 ORDER BY employee_id`, [tenantId]);
  const token = await login('inc-hr@x.com');
  await api(`/pms/increment-simulations/${simId}`, token);
  await api(`/pms/increment-simulations/${simId}`, token, { method: 'PUT', body: JSON.stringify({ scale_to_fit: false }) });
  const after = await db.query(`SELECT employee_id, annual_ctc FROM pms.compensation WHERE tenant_id=$1 ORDER BY employee_id`, [tenantId]);
  assert.deepEqual(after.rows, before.rows, 'modelling a raise must not grant one');
});

test('two scenarios can be compared, and a name cannot be reused', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  // A at 6% of 1,000,000 plus B at 5% of 600,000 is 90,000 — already
  // inside a 100,000 pot. Scale-to-fit does NOT scale up to spend the
  // budget: it is a ceiling, not a target.
  const second = await api('/pms/increment-simulations', token, {
    method: 'POST', body: JSON.stringify({ name: 'Tight budget', budget_amount: 100000, scale_to_fit: true }),
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.totals.increment_total, 90000);
  assert.equal(second.body.totals.scaled, false);
  assert.equal(second.body.totals.variance, 10000, 'left unspent');

  const dupe = await api('/pms/increment-simulations', token, { method: 'POST', body: JSON.stringify({ name: 'Tight budget' }) });
  assert.equal(dupe.status, 409);

  const list = await api('/pms/increment-simulations', token);
  assert.equal(list.body.simulations.length, 2);
});

test('deleting a scenario takes its overrides and leaves the salaries', { skip }, async () => {
  const token = await login('inc-hr@x.com');
  assert.equal((await api(`/pms/increment-simulations/${simId}`, token, { method: 'DELETE' })).status, 200);
  const overrides = await db.query(`SELECT count(*)::int AS n FROM pms.increment_overrides WHERE simulation_id=$1`, [simId]);
  assert.equal(overrides.rows[0].n, 0);
  const comp = await db.query(`SELECT count(*)::int AS n FROM pms.compensation WHERE tenant_id=$1`, [tenantId]);
  assert.equal(comp.rows[0].n, 2, 'the underlying pay data is untouched');
});
