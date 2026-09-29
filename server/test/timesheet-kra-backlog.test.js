// node --test — the HR mapping backlog, and the window everything lands on.
//
// Phase 3 of the Zoho timesheet rating engine.
//
// Two things here are worth more than the rest, and both are defects
// found by looking at the running screens rather than at the code:
//
//   - THE DEFAULT PERIOD IS THE LATEST ONE WITH LOGS. A timesheet is
//     uploaded after the month it covers, so the calendar's current
//     cycle is empty for most of its length. The first version opened
//     on it and told a manager reviewing September "no timesheet logged
//     in 21 Sep – 20 Oct", with no way from that screen to reach the
//     month they had come for.
//   - "NO KRAs" MEANS NO KRAs, NOT NO SHEET ROW. Two demo employees
//     carry an approved or returned sheet with zero KRAs on it, so
//     testing for the sheet made the HR screen report "0 people without
//     a sheet" while the screen beside it said "this person has no KRAs
//     for this cycle".
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db, server, base, tenantId, tok = {}, ids = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tsbk';
  process.env.TENANT_SLUG = 'tsbk-test-' + Date.now();
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

  const mk = async (name, email, extra = {}) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation, manager_id)
     VALUES ($1,$2,$3,'active',$4,$5,$6) RETURNING id`,
    [t.id, name, email, extra.department || 'Delivery', extra.designation || 'Engineer',
     extra.manager_id || null])).rows[0].id;
  ids.hr = await mk('BK HR', 'bk-hr@x.com', { department: 'HR', designation: 'Head of HR' });
  ids.mgr = await mk('BK Manager', 'bk-mgr@x.com', { designation: 'Delivery Manager' });
  ids.full = await mk('BK Full', 'bk-full@x.com', { manager_id: ids.mgr });
  // An APPROVED SHEET WITH NO KRAs ON IT — the state that made the two
  // screens contradict each other.
  ids.empty = await mk('BK EmptySheet', 'bk-empty@x.com', { manager_id: ids.mgr });

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'bk-hr@x.com','admin'),($1,'bk-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['bk-hr@x.com', 'bk-mgr@x.com', 'bk-full@x.com', 'bk-empty@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase) VALUES ($1,'FY26','2026-27','manager_eval') RETURNING id`,
    [t.id])).rows[0];
  ids.cycle = cycle.id;

  const sheet = async (employeeId, status) => (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,$4) RETURNING id`,
    [t.id, cycle.id, employeeId, status])).rows[0].id;
  const s1 = await sheet(ids.full, 'approved');
  ids.kra = {};
  let i = 0;
  for (const [title, weight] of [['Delivery', 70], ['Reporting', 30]]) {
    ids.kra[title] = (await db.query(
      `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [t.id, s1, title, weight, (i += 10)])).rows[0].id;
  }
  await sheet(ids.empty, 'approved');   // a sheet row, and nothing on it

  const batch = (await db.query(
    `INSERT INTO pms.timesheet_batches (tenant_id, uploaded_by_email, source_file) VALUES ($1,'bk-hr@x.com','s.xlsx') RETURNING id`,
    [t.id])).rows[0];
  const log = (emp, d, hours, itemId, name) => db.query(
    `INSERT INTO pms.timesheet_entries (tenant_id, batch_id, employee_id, log_date, hours, item_id, item_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t.id, batch.id, emp, d, hours, itemId, name]);
  // TWO cycles of logs at the default start day of 21, and nothing at
  // all in the current one — the shape real data always has.
  for (const d of ['2026-07-22', '2026-07-23', '2026-07-24']) await log(ids.full, d, 8, 'I-1', 'Sprint work');
  for (const d of ['2026-08-24', '2026-08-25']) await log(ids.full, d, 8, 'I-1', 'Sprint work');
  await log(ids.full, '2026-08-26', 4, 'I-2', 'Status report');
  await log(ids.empty, '2026-08-27', 8, 'I-3', 'Something');

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
  tok.hr = await login('bk-hr@x.com');
  tok.mgr = await login('bk-mgr@x.com');
  tok.full = await login('bk-full@x.com');
});
after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'hr') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};

// ---- the window ---------------------------------------------------------

test('THE DEFAULT PERIOD IS THE LATEST ONE WITH LOGS, not the calendar month', { skip }, async () => {
  // Nothing was logged in the current cycle, and the last logs are in
  // 21 Aug – 20 Sep. Opening on the current cycle would greet every
  // reader with an empty screen for most of every month.
  const r = await api(`/pms/timesheet/kra/employee/${ids.full}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.window.from, '2026-08-21');
  assert.equal(r.body.window.to, '2026-09-20');
  assert.equal(r.body.window.source, 'latest-with-data');
  assert.equal(r.body.has_entries, true);
});

test('every period with logs is offered, newest first', { skip }, async () => {
  // Without this an empty month is a dead end: the reader can see there
  // is no data and has no way to reach the month that has it.
  const r = await api(`/pms/timesheet/kra/employee/${ids.full}`);
  const w = r.body.windows;
  assert.equal(w.length, 2);
  assert.deepEqual(w.map((x) => x.from), ['2026-08-21', '2026-07-21']);
  assert.equal(w[0].hours, 20);
  assert.equal(w[1].hours, 24);
});

test('an explicitly named period is never overridden', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/employee/${ids.full}?from=2026-07-21&to=2026-08-20`);
  assert.equal(r.body.window.from, '2026-07-21');
  assert.equal(r.body.window.source, 'explicit');
  assert.equal(r.body.totals.logged, 24);
});

// ---- the backlog --------------------------------------------------------

test('the backlog lands on the same period as the per-person view', { skip }, async () => {
  // These two screens sit one click apart. Written separately they
  // drifted: the per-person view got the latest-with-data fallback and
  // the backlog kept opening on an empty current cycle, announcing
  // "nothing to map yet" over hundreds of logged hours.
  const person = await api(`/pms/timesheet/kra/employee/${ids.full}`);
  const backlog = await api('/pms/timesheet/kra/backlog');
  assert.equal(backlog.status, 200);
  assert.equal(backlog.body.window.from, person.body.window.from);
  assert.equal(backlog.body.window.source, 'latest-with-data');
  assert.ok(backlog.body.totals.people > 0, 'and it found the people who logged time');
});

test('NO KRAs MEANS NO KRAs, NOT NO SHEET ROW', { skip }, async () => {
  // bk-empty has an APPROVED sheet carrying zero KRAs. Counting the
  // sheet row made HR's screen say "0 people without a sheet" while the
  // per-person screen beside it said "this person has no KRAs for this
  // cycle". Both true, and they read as a contradiction.
  const b = (await api('/pms/timesheet/kra/backlog')).body;
  const empty = b.people.find((p) => p.employee.name === 'BK EmptySheet');
  const full = b.people.find((p) => p.employee.name === 'BK Full');
  assert.equal(empty.has_kras, false, 'a sheet with nothing on it is not KRAs');
  assert.equal(full.has_kras, true);
  assert.equal(b.totals.without_kras, 1);

  // And the per-person view agrees, in words.
  const p = await api(`/pms/timesheet/kra/employee/${ids.empty}`);
  assert.match(p.body.summary.withheld.join(' '), /has no KRAs for this cycle/);
});

test('the backlog counts items and hours, and mapping moves them', { skip }, async () => {
  const before = (await api('/pms/timesheet/kra/backlog')).body;
  const me = before.people.find((p) => p.employee.name === 'BK Full');
  assert.equal(me.items, 2);
  assert.equal(me.unmapped_items, 2);
  assert.equal(me.hours, 20);
  assert.equal(me.mapped_hours, 0);

  const put = await api(`/pms/timesheet/kra/employee/${ids.full}/map/bulk`, {
    method: 'POST',
    body: JSON.stringify({ mappings: [
      { item_key: 'i-1', item_label: 'Sprint work', decision: 'kra', kra_id: ids.kra.Delivery },
      { item_key: 'i-2', item_label: 'Status report', decision: 'excluded', note: 'admin reporting, not a KRA' },
    ] }),
  }, 'mgr');
  assert.equal(put.status, 200);

  const after = (await api('/pms/timesheet/kra/backlog')).body;
  const me2 = after.people.find((p) => p.employee.name === 'BK Full');
  assert.equal(me2.unmapped_items, 0, 'an excluded item is placed, not outstanding');
  assert.equal(me2.mapped_items, 1);
  assert.equal(me2.excluded_items, 1);
  // The excluded hours are NOT counted as mapped: HR's headline is
  // "how much of what was logged is against a KRA", and excluded work
  // is neither against one nor waiting to be.
  assert.equal(me2.mapped_hours, 16);
  assert.ok(after.totals.needing_mapping < before.totals.needing_mapping);
});

test('the backlog is HR only', { skip }, async () => {
  assert.equal((await api('/pms/timesheet/kra/backlog', {}, 'mgr')).status, 403);
  assert.equal((await api('/pms/timesheet/kra/backlog', {}, 'full')).status, 403);
});

test('a mapping in one cycle does not leak into a report for another', { skip }, async () => {
  // The map is keyed by cycle, and the July window reads the same
  // mappings because they belong to the cycle, not to the month. What
  // must NOT happen is July's hours being counted into August's totals.
  const july = (await api(`/pms/timesheet/kra/employee/${ids.full}?from=2026-07-21&to=2026-08-20`)).body;
  const aug = (await api(`/pms/timesheet/kra/employee/${ids.full}?from=2026-08-21&to=2026-09-20`)).body;
  assert.equal(july.totals.logged, 24);
  assert.equal(aug.totals.logged, 20);
  assert.notEqual(july.totals.attributed, aug.totals.attributed);
});
