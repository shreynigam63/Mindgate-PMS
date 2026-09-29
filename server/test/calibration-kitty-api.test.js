// node --test — the calibration kitty over its real HTTP surface.
//
// calibration-kitty.test.js already pins the arithmetic with no
// database. This file exists for everything that file cannot see: the
// permission split, the population query, the patch-and-recompute
// round trip, and the export. Those are where the bugs that reach a
// client actually live — the maths was right the first time and the
// wiring was not.
//
// Real Postgres, real express, skips cleanly without DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, tok = {}, emp = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kitty';
  process.env.TENANT_SLUG = 'kitty-test-' + Date.now();
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

  const mk = async (name, email, dept, desig, extra = {}) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation,
       date_of_joining, resignation_date, last_working_date)
     VALUES ($1,$2,$3,'active',$4,$5,current_date - 700,$6,$7) RETURNING id`,
    [t.id, name, email, dept, desig, extra.resignation_date || null, extra.last_working_date || null])).rows[0].id;

  emp.boss = await mk('Kitty Boss', 'kitty-boss@x.com', 'HR', 'Head of HR');
  emp.star = await mk('Kitty Star', 'kitty-star@x.com', 'Delivery', 'Architect');
  emp.mid = await mk('Kitty Mid', 'kitty-mid@x.com', 'Delivery', 'Engineer');
  emp.leaver = await mk('Kitty Leaver', 'kitty-leaver@x.com', 'Delivery', 'Engineer',
    { resignation_date: '2026-09-20', last_working_date: '2026-10-20' });
  await db.query(`UPDATE core.employees SET manager_id=$1 WHERE id = ANY($2::uuid[])`,
    [emp.boss, [emp.star, emp.mid, emp.leaver]]);

  // boss is admin (pms_admin + pms_compensation); plain is neither.
  emp.plain = await mk('Kitty Plain', 'kitty-plain@x.com', 'Delivery', 'Engineer');
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'kitty-boss@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['kitty-boss@x.com', 'kitty-plain@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, hash]);
  }

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase, bell_curve)
     VALUES ($1,'Kitty FY','2026-27','calibration',$2::jsonb) RETURNING id`,
    [t.id, JSON.stringify({ 1: 15, 2: 30, 3: 35, 4: 15, 5: 5 })])).rows[0].id;
  for (const [id, rating] of [[emp.star, 5], [emp.mid, 3], [emp.leaver, 4], [emp.boss, 4]]) {
    await db.query(
      `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, overall_rating, status)
       VALUES ($1,$2,$3,$4,$5,'submitted')`, [t.id, cycleId, id, emp.boss, rating]);
  }
  // Star is above the 50-lakh bracket; everyone else below. `plain` is
  // deliberately left with NO compensation row.
  for (const [id, ctc] of [[emp.star, 6000000], [emp.mid, 2400000], [emp.leaver, 1200000], [emp.boss, 3000000]]) {
    await db.query(
      `INSERT INTO pms.compensation (tenant_id, employee_id, annual_ctc, effective_from)
       VALUES ($1,$2,$3,current_date - 100)`, [t.id, id, ctc]);
  }

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
  tok.boss = await login('kitty-boss@x.com');
  tok.plain = await login('kitty-plain@x.com');
});

after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'boss') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null, raw: r };
};

test('SALARY IS ITS OWN PERMISSION, separate from the rest of calibration', { skip }, async () => {
  // Migration 030 split pms_compensation out of pms_admin precisely so
  // HR can lose payroll without losing their role. Hanging the kitty
  // off the pms_admin check the rest of this page uses would have
  // handed every calibration user the whole payroll.
  const denied = await api('/pms/calibration/kitty', {}, 'plain');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /pms_compensation/);
  for (const [path, opts] of [
    ['/pms/calibration/kitty', { method: 'PUT', body: '{}' }],
    [`/pms/calibration/allocation/${'00000000-0000-0000-0000-000000000000'}`, { method: 'PUT', body: '{}' }],
    ['/pms/calibration/export', {}],
  ]) {
    assert.equal((await api(path, opts, 'plain')).status, 403, `${path} must refuse too`);
  }
});

test('a fresh tenant gets its grade bands on first load, not never', { skip }, async () => {
  // The migration's own seed loop reads core.tenants, which is EMPTY
  // during migrations because index.js creates the tenant afterwards —
  // the same trap that cost migration 056 a boot loop. This tenant was
  // made after 063 ran, so if the route did not ensure the bands it
  // would show no grades at all.
  const before = +(await db.query(
    `SELECT count(*)::int AS n FROM pms.increment_matrix WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(before, 0, 'the migration seeded nothing for a tenant that did not exist yet');

  const r = await api('/pms/calibration/kitty');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.grades.map((g) => g.label), ['A+', 'A', 'B+', 'B', 'C']);

  const after = +(await db.query(
    `SELECT count(*)::int AS n FROM pms.increment_matrix WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(after, 5, 'and the bands are now real rows, editable like any other policy');
});

test('the grade table takes each band the target of the rating it stands for', { skip }, async () => {
  // The off-by-one found on 29 Sep: numeric(3,1) stored 4.49 as 4.5 and
  // Math.round(4.5) is 5, so every grade below A+ read its neighbour's
  // bell-curve target. Checked here against the real seeded rows,
  // because that is where the rounding actually happened.
  const r = await api('/pms/calibration/kitty');
  assert.deepEqual(r.body.grades.map((g) => `${g.label}=${g.target_pct}`),
    ['A+=5', 'A=15', 'B+=35', 'B=30', 'C=15']);
  const byLabel = Object.fromEntries(r.body.grades.map((g) => [g.label, g]));
  assert.equal(byLabel['A+'].count, 1, 'Star');
  assert.equal(byLabel['A'].count, 2, 'Leaver and Boss');
  assert.equal(byLabel['B+'].count, 1, 'Mid');
});

test('the kitty and the pools compute over the real population', { skip }, async () => {
  const set = await api('/pms/calibration/kitty', { method: 'PUT', body: JSON.stringify({
    kitty_pct: 8, bracket_threshold: 5000000,
    retention_pool: 500000, market_pool: 300000, promotion_pool: 400000 }) });
  assert.equal(set.status, 200);

  const r = (await api('/pms/calibration/kitty')).body;
  // 60L + 24L + 12L + 30L priced; `plain` has no CTC.
  assert.equal(r.total_ctc, 12600000);
  assert.equal(r.counts.ctc_missing, 1);
  // The leaver is frozen, so their 12L is out of the kitty base.
  assert.equal(r.kitty_base_ctc, 11400000);
  assert.equal(r.pools.kitty.approved, 912000, '8% of the base');
  assert.equal(r.pools.retention.approved, 500000);
  assert.equal(r.pools.market.approved, 300000);
  assert.equal(r.pools.promotion.approved, 400000);
});

test('the bracket filter re-splits the whole view, panel included', { skip }, async () => {
  const above = (await api('/pms/calibration/kitty?bracket=above')).body;
  assert.equal(above.counts.employees, 1);
  assert.equal(above.total_ctc, 6000000);
  assert.deepEqual(above.lines.map((l) => l.name), ['Kitty Star']);

  const below = (await api('/pms/calibration/kitty?bracket=at_or_below')).body;
  assert.equal(below.counts.employees, 3, 'Mid, Leaver and Boss — not the unpriced one');
  assert.ok(!below.lines.some((l) => l.name === 'Kitty Plain'));

  // A bracket nobody recognises falls back to everyone rather than
  // silently returning an empty page.
  const junk = (await api('/pms/calibration/kitty?bracket=nonsense')).body;
  assert.equal(junk.bracket, 'all');
  assert.equal(junk.counts.employees, 5);
});

test('saving one allocation returns the WHOLE recomputed view', { skip }, async () => {
  // Every pool total and every warning moves when one person changes.
  // A client that patched one row locally would drift from the
  // server's arithmetic, and the drift would surface at reconciliation.
  const r = await api(`/pms/calibration/allocation/${emp.mid}`, { method: 'PUT', body: JSON.stringify({
    market_pct: 5, market_reason: 'below market for the role' }) });
  assert.equal(r.status, 200);
  assert.ok(r.body.pools, 'the pools come back');
  assert.equal(r.body.pools.market.spent, 120000, '5% of 24 lakhs');
  assert.equal(r.body.pools.market.remaining, 180000);
  const mid = r.body.lines.find((l) => l.name === 'Kitty Mid');
  assert.equal(mid.market_pct, 5);
  assert.equal(mid.total_pct, 13, 'B+ standard 8 plus 5');
  assert.equal(mid.revised_ctc, 2712000);
});

test('a patch changes one field and leaves the rest alone', { skip }, async () => {
  const r = await api(`/pms/calibration/allocation/${emp.mid}`, { method: 'PUT', body: JSON.stringify({
    promoted: true, proposed_designation: 'Senior Engineer', promotion_pct: 4, promotion_reason: 'stepping up' }) });
  assert.equal(r.status, 200);
  const mid = r.body.lines.find((l) => l.name === 'Kitty Mid');
  assert.equal(mid.market_pct, 5, 'the market correction from the previous save survives');
  assert.equal(mid.reasons.market, 'below market for the role');
  assert.equal(mid.promotion_pct, 4);
  assert.equal(mid.total_pct, 17);
});

test('every special hike is refused without its reason', { skip }, async () => {
  for (const [body, pattern] of [
    [{ market_pct: 9 }, /market correction needs a reason/i],
    [{ promoted: true, proposed_band: 'E5', promotion_pct: 9 }, /promotion hike needs a reason/i],
    [{ standard_pct: 20 }, /needs a reason/i],
  ]) {
    const r = await api(`/pms/calibration/allocation/${emp.star}`, { method: 'PUT', body: JSON.stringify(body) });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.match(r.body.error, pattern);
  }
});

test('retention is refused for somebody who has not resigned', { skip }, async () => {
  const r = await api(`/pms/calibration/allocation/${emp.star}`, { method: 'PUT', body: JSON.stringify({
    retention_approved: true, retention_pct: 10, retention_reason: 'counter-offer' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /only to somebody who has resigned/i);
});

test('THE LEAVER: frozen until retention is approved, then funded from its own pool', { skip }, async () => {
  let r = (await api('/pms/calibration/kitty')).body;
  let leaver = r.lines.find((l) => l.name === 'Kitty Leaver');
  assert.equal(leaver.resigned, true);
  assert.equal(leaver.frozen, true);
  assert.equal(leaver.total_pct, 0, 'rated A, and still getting nothing');
  assert.equal(leaver.revised_ctc, 1200000, 'unchanged');

  const saved = await api(`/pms/calibration/allocation/${emp.leaver}`, { method: 'PUT', body: JSON.stringify({
    retention_approved: true, retention_pct: 10, retention_lumpsum: 25000, retention_reason: 'counter-offer accepted' }) });
  assert.equal(saved.status, 200);
  leaver = saved.body.lines.find((l) => l.name === 'Kitty Leaver');
  assert.equal(leaver.frozen, false);
  assert.equal(leaver.standard_pct, 12, 'the A band applies again');
  assert.equal(leaver.total_pct, 22);
  assert.equal(leaver.revised_ctc, 1200000 + 144000 + 120000 + 25000);
  // Retention draws on retention, never on the kitty.
  assert.equal(saved.body.pools.retention.spent, 120000 + 25000);
  assert.ok(saved.body.pools.kitty.spent > 0);
  // And unfreezing them puts their salary back into the kitty base.
  assert.equal(saved.body.kitty_base_ctc, 12600000);
});

test('going over a pool is reported, not silently allowed', { skip }, async () => {
  await api('/pms/calibration/kitty', { method: 'PUT', body: JSON.stringify({ market_pool: 1000 }) });
  const r = (await api('/pms/calibration/kitty')).body;
  assert.equal(r.pools.market.over, true);
  assert.match(r.warnings.join(' '), /market correction pool is over/i);
  // Reported, and the allocation still stands: a budget is a guardrail
  // for a human decision, not a lock that loses their work.
  assert.ok(r.lines.find((l) => l.name === 'Kitty Mid').market_pct === 5);
  await api('/pms/calibration/kitty', { method: 'PUT', body: JSON.stringify({ market_pool: 300000 }) });
});

test('the budget refuses a typo before it is stored', { skip }, async () => {
  const r = await api('/pms/calibration/kitty', { method: 'PUT', body: JSON.stringify({ kitty_pct: 800 }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /typo/i);
  assert.equal((await api('/pms/calibration/kitty')).body.kitty_pct, 8, 'and the stored kitty is untouched');
});

test('every allocation is audited', { skip }, async () => {
  let rows = [];
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    rows = (await db.query(
      // pms.audit_log, not core.audit_log: the performance module has
      // its own, keyed by cycle and employee, which is what makes "why
      // did this person's pay change in THIS cycle" answerable.
      `SELECT details, employee_id, cycle_id FROM pms.audit_log
        WHERE tenant_id=$1 AND action='CALIBRATION_ALLOCATION_SET'`,
      [tenantId])).rows;
    if (!rows.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(rows.length >= 1, '"why did this person get this" has a queryable answer');
  assert.ok(rows.some((r) => r.details.market != null));
  assert.ok(rows.every((r) => r.employee_id && r.cycle_id), 'each entry names who, and in which cycle');
  // And the budget itself, so "what pot was this signed off against".
  const b = (await db.query(
    `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='CALIBRATION_BUDGET_SET'`,
    [tenantId])).rows;
  assert.ok(b.length >= 1);
  assert.ok(b.some((r) => r.details.kitty_pct != null));
});

test('the export is a real spreadsheet, and says what is not on record', { skip }, async () => {
  const r = await api('/pms/calibration/export?bracket=all');
  assert.equal(r.status, 200);
  assert.match(r.raw.headers.get('content-type'), /spreadsheetml/);
  const buf = Buffer.from(await r.raw.arrayBuffer());
  assert.ok(buf.length > 2000, 'a real xlsx, not an error page');
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'a zip, which is what xlsx is');

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Calibration');
  assert.ok(ws, 'the sheet is named');
  const headers = ws.getRow(1).values.filter(Boolean).map(String);
  for (const h of ['Name', 'Current CTC', 'Total %', 'Revised CTC', 'Reasons']) {
    assert.ok(headers.includes(h), `the export carries ${h}`);
  }
  // The unpriced employee must not read as earning zero — a blank cell
  // sums as nothing to whoever totals the column.
  const values = [];
  ws.eachRow((row) => values.push(row.values.map((v) => String(v == null ? '' : v))));
  const plain = values.find((v) => v.includes('Kitty Plain'));
  assert.ok(plain, 'the unpriced person is still in the sheet');
  assert.ok(plain.includes('not on record'), 'and says so rather than showing 0');
  assert.ok(wb.getWorksheet('Budget'), 'the budget travels with the sheet');
});
