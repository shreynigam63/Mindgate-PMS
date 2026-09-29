// node --test — editing the grade bands from Calibration.
//
// Asked for on 29 Sep: "provide edit option all all tabs present in
// Calibration." Three of the four things on that page were already
// editable — the kitty, a person's rating, a person's allocation. The
// grade table was not, and two of its columns could not be changed
// from anywhere:
//
//   - the INCREMENT RANGE could be set nowhere at all, and worse, the
//     Increment Simulation route DELETEd and re-INSERTed the matrix
//     without those two columns, so saving it there silently nulled
//     every range and the out-of-band guardrail computed from them
//     stopped firing. Reproduced against a running instance.
//   - the TARGET % could only be changed on the Cycles page.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db, server, base, tenantId, tok = {}, ids = {};

const BANDS = [
  { label: 'A+', rating_min: 4.5, rating_max: 5.0, increment_pct: 17.5, increment_pct_min: 15, increment_pct_max: 20 },
  { label: 'A', rating_min: 3.5, rating_max: 4.4, increment_pct: 12, increment_pct_min: 10, increment_pct_max: 14 },
  { label: 'B+', rating_min: 2.5, rating_max: 3.4, increment_pct: 8, increment_pct_min: 7, increment_pct_max: 9 },
  { label: 'B', rating_min: 1.5, rating_max: 2.4, increment_pct: 5, increment_pct_min: 4, increment_pct_max: 6 },
  { label: 'C', rating_min: 0, rating_max: 1.4, increment_pct: 0, increment_pct_min: 0, increment_pct_max: 0 },
];
const withTargets = (t) => BANDS.map((b, i) => ({ ...b, target_pct: t[i] }));

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-bands';
  process.env.TENANT_SLUG = 'bands-test-' + Date.now();
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

  const mk = async (name, email) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, designation)
     VALUES ($1,$2,$3,'active','Head of HR') RETURNING id`, [t.id, name, email])).rows[0].id;
  ids.comp = await mk('BD Comp', 'bd-comp@x.com');
  ids.plain = await mk('BD PlainHR', 'bd-plain@x.com');

  // THE FIXTURE MODELS THE REAL SPLIT, and the first version did not.
  // The `admin` ROLE BUNDLE already carries pms_compensation (002 and
  // 030), so giving both users role=admin gave both of them the
  // permission and the guard test passed nobody. The case migration
  // 030 exists for is an HR user who has pms_admin and has NOT been
  // granted compensation — so that one gets pms_admin as a USER grant
  // on top of a role that carries neither.
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'bd-comp@x.com','admin'),($1,'bd-plain@x.com','employee')`, [t.id]);
  await db.query(`INSERT INTO core.user_permissions (tenant_id, email, permission) VALUES ($1,'bd-plain@x.com','pms_admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['bd-comp@x.com', 'bd-plain@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }

  ids.cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase, bell_curve)
     VALUES ($1,'FY26','2026-27','calibration','{"1":5,"2":15,"3":55,"4":20,"5":5}'::jsonb) RETURNING id`,
    [t.id])).rows[0].id;
  await require('../migrations/063-calibration-kitty').ensureBands(db, t.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }) })).json()).token;
  tok.comp = await login('bd-comp@x.com');
  tok.plain = await login('bd-plain@x.com');
});
after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'comp') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};
const rangesOf = async (scoped) => (await db.query(
  `SELECT label, increment_pct, increment_pct_min AS lo, increment_pct_max AS hi
     FROM pms.increment_matrix
    WHERE tenant_id=$1 AND cycle_id IS ${scoped ? 'NOT NULL' : 'NULL'} ORDER BY sort_order`,
  [tenantId])).rows;

// ---- the defect ---------------------------------------------------------

test('SAVING THE MATRIX NO LONGER WIPES THE INCREMENT RANGES', { skip }, async () => {
  // The bug, exactly as reproduced: read the matrix, save it back
  // UNCHANGED through the Increment Simulation route, and every range
  // became null — taking the calibration "Increment range" column and
  // the out-of-band guardrail with it.
  const before = await rangesOf(false);
  assert.ok(before.length, 'ensureBands seeded the standing matrix');
  assert.equal(Number(before[0].lo), 15, 'A+ starts at 15');
  assert.equal(Number(before[0].hi), 20);

  const read = await api('/pms/increment-matrix');
  assert.equal(read.status, 200);
  const put = await api('/pms/increment-matrix', {
    method: 'PUT',
    body: JSON.stringify({ bands: read.body.bands.map((b) => ({
      label: b.label, rating_min: b.rating_min, rating_max: b.rating_max,
      increment_pct: b.increment_pct,
      increment_pct_min: b.increment_pct_min, increment_pct_max: b.increment_pct_max })) }),
  });
  assert.equal(put.status, 200);

  const after = await rangesOf(false);
  assert.deepEqual(after.map((b) => [b.label, Number(b.lo), Number(b.hi)]),
    before.map((b) => [b.label, Number(b.lo), Number(b.hi)]),
    'every range survived a round trip');
});

// ---- what a band may be -------------------------------------------------

test('a backwards increment range is refused, naming the row', { skip }, async () => {
  const r = await api('/pms/calibration/bands', {
    method: 'PUT',
    body: JSON.stringify({ bands: [{ ...BANDS[0], increment_pct_min: 20, increment_pct_max: 15 }] }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.errors[0].error, /backwards \(20% to 15%\)/);
});

test('HALF A RANGE IS REFUSED', { skip }, async () => {
  // One end without the other leaves the guardrail unable to fire, so
  // it would look configured and do nothing.
  const r = await api('/pms/calibration/bands', {
    method: 'PUT', body: JSON.stringify({ bands: [{ ...BANDS[0], increment_pct_max: '' }] }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.errors[0].error, /both a minimum and a maximum, or neither/);
});

test('a standard sitting outside its own band is refused', { skip }, async () => {
  // Otherwise the table contradicts the guardrail computed from it:
  // every row would report out-of-band against the figure the table
  // itself prints as standard.
  const r = await api('/pms/calibration/bands', {
    method: 'PUT', body: JSON.stringify({ bands: [{ ...BANDS[0], increment_pct: 30 }] }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.errors[0].error, /standard 30% sits outside this band's own 15–20% range/);
});

test('TARGETS THAT DO NOT TOTAL 100 ARE REFUSED, NOT NORMALISED', { skip }, async () => {
  // Scaling them would hide the mistake behind a distribution nobody
  // chose. Same rule as the timesheet scoring weights.
  const r = await api('/pms/calibration/bands', {
    method: 'PUT', body: JSON.stringify({ bands: withTargets([50, 20, 15, 10, 1]) }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /add up to 100% - they add up to 96%/);
});

test('nothing is written by a refused save', { skip }, async () => {
  // This route replaces the cycle's matrix wholesale, so validating
  // after the DELETE would leave the cycle with fewer grades than it
  // started with.
  const n = Number((await db.query(
    `SELECT count(*) n FROM pms.increment_matrix WHERE tenant_id=$1`, [tenantId])).rows[0].n);
  await api('/pms/calibration/bands', {
    method: 'PUT', body: JSON.stringify({ bands: [{ ...BANDS[0], increment_pct_min: 99, increment_pct_max: 1 }] }),
  });
  assert.equal(Number((await db.query(
    `SELECT count(*) n FROM pms.increment_matrix WHERE tenant_id=$1`, [tenantId])).rows[0].n), n);
});

// ---- the happy path -----------------------------------------------------

test('editing the bands writes this cycle only, leaving the standing matrix alone', { skip }, async () => {
  // "A+ tops out at 22 THIS YEAR" must not rewrite the standing
  // company policy, which is what Increment Simulation edits.
  const standingBefore = await rangesOf(false);
  const r = await api('/pms/calibration/bands', {
    method: 'PUT',
    body: JSON.stringify({ bands: withTargets([10, 20, 50, 15, 5])
      .map((b) => (b.label === 'A+' ? { ...b, increment_pct: 18, increment_pct_max: 22 } : b)) }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.bands, 5);

  const scoped = await rangesOf(true);
  assert.equal(scoped.length, 5);
  assert.equal(Number(scoped[0].hi), 22, 'the cycle band tops out at 22');
  assert.equal(Number(scoped[0].increment_pct), 18);
  assert.deepEqual(await rangesOf(false), standingBefore, 'the standing matrix is untouched');
});

test('the bell curve is written with it, and read back on the page', { skip }, async () => {
  const curve = (await db.query(`SELECT bell_curve FROM pms.cycles WHERE id=$1`, [ids.cycle])).rows[0].bell_curve;
  assert.deepEqual(curve, { 1: 5, 2: 15, 3: 50, 4: 20, 5: 10 });

  const view = await api('/pms/calibration/kitty');
  assert.equal(view.status, 200);
  const aplus = view.body.grades.find((g) => g.label === 'A+');
  assert.equal(aplus.target_pct, 10);
  assert.equal(aplus.increment_max_pct, 22);
  assert.equal(aplus.standard_pct, 18);
});

test('THE GRADE ROWS CARRY THEIR RATING RANGE, so the editor can save them back', { skip }, async () => {
  // Without these the editor round-trips undefined and every save is
  // rejected as "rating range must be numeric" — found by building the
  // editor against the payload rather than by reading it.
  const view = await api('/pms/calibration/kitty');
  for (const g of view.body.grades) {
    assert.equal(typeof g.rating_min, 'number', `${g.label} has a rating_min`);
    assert.equal(typeof g.rating_max, 'number', `${g.label} has a rating_max`);
  }
});

test('the edit is audited with what the bands were', { skip }, async () => {
  // These numbers decide what every grade is worth in money.
  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) {
    rows = (await db.query(
      `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='CALIBRATION_BANDS_SET'`, [tenantId])).rows;
    if (!rows.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(rows.length);
  const d = rows[rows.length - 1].details;
  assert.ok(Array.isArray(d.before) && Array.isArray(d.after));
  assert.ok(d.after.some((b) => b.label === 'A+' && Number(b.max) === 22));
});

// ---- who may ------------------------------------------------------------

test('EDITING BANDS NEEDS pms_compensation, NOT JUST pms_admin', { skip }, async () => {
  // Migration 030 split compensation out so HR can lose salary access
  // without losing their role. An increment range IS pay policy.
  const r = await api('/pms/calibration/bands', {
    method: 'PUT', body: JSON.stringify({ bands: BANDS }),
  }, 'plain');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /pms_compensation/);
});

test('an empty band list is refused', { skip }, async () => {
  const r = await api('/pms/calibration/bands', { method: 'PUT', body: JSON.stringify({ bands: [] }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /at least one band/);
});
