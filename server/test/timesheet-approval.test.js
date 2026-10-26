// node --test — timesheet approvals (26 Oct).
//
// "Once uploaded by HR, manager should have approval option for editing
// ratings generated per system and approve timesheet uploaded on system.
// In case manager is not approving the timesheet after cutoff time, these
// data should be received on upper level manager as per reporting matrix
// ... For manager there will be one system generated KRA title as
// 'Timesheet Approval'." With the client's answers: a cutoff of 5 working
// days after upload (then 5 more for the upper manager); a missed cutoff
// marks only the manager's KRA; that KRA is a fixed 10%; all approved on
// time A, none B, some B+.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
// Before the module loads: core/auth reads the secret when it is required.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tsap';
process.env.TENANT_SLUG = 'tsap-test-' + Date.now();
process.env.AUTH_DEV = 'true';
const ap = require('../modules/performance/timesheet-approval');

// ---- the rules, pure -------------------------------------------------------

test('the cutoff is N working days after the upload day, weekends and holidays skipped', () => {
  assert.equal(ap.addWorkingDays('2026-10-26', 5), '2026-11-02', 'Mon + 5 working days is the next Mon');
  assert.equal(ap.addWorkingDays('2026-10-23', 1), '2026-10-26', 'Fri + 1 is Mon');
  assert.equal(ap.addWorkingDays('2026-10-26', 5, ['2026-10-28']), '2026-11-03', 'a holiday is not a working day');
});

test('a month is pending, then escalated, then not approved, as the dates pass', () => {
  const row = { status: 'pending', due_on: '2026-11-02', escalation_due_on: '2026-11-09', upper_manager_id: 'u' };
  assert.equal(ap.statusOf(row, '2026-11-02'), 'pending', 'the cutoff day itself is still in time');
  assert.equal(ap.statusOf(row, '2026-11-03'), 'escalated');
  assert.equal(ap.statusOf(row, '2026-11-10'), 'lapsed');
  assert.equal(ap.statusOf({ ...row, upper_manager_id: null }, '2026-11-03'), 'lapsed', 'nobody above: not approved');
  assert.equal(ap.statusOf({ ...row, status: 'approved' }, '2026-12-01'), 'approved');
});

test('the manager\'s Timesheet Approval KRA: all on time A, none B, some B+, undecided while time is left', () => {
  const r = (onTime, status = 'approved', due = '2026-11-02') => ({ on_time_by_manager: onTime, status, due_on: due });
  assert.equal(ap.approvalRating([r(true), r(true)], '2026-11-10').rating, 'A');
  assert.equal(ap.approvalRating([r(false, 'pending'), r(false)], '2026-11-10').rating, 'B');
  assert.equal(ap.approvalRating([r(true), r(false)], '2026-11-10').rating, 'B+');
  const open = ap.approvalRating([r(true), r(false, 'pending')], '2026-11-01');
  assert.equal(open.rating, null); assert.equal(open.awaiting, 1);
  assert.equal(ap.approvalRating([], '2026-11-01'), null);
});

// ---- over HTTP ---------------------------------------------------------------

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db, server, base, tenantId, tok = {}, ids = {};

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  const add = async (name, email, manager = null) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation, manager_id)
     VALUES ($1,$2,$3,'active','Delivery','Engineer',$4) RETURNING id`, [t.id, name, email, manager])).rows[0].id;
  ids.upper = await add('AP Upper', 'ap-upper@x.com');
  ids.mgr = await add('AP Manager', 'ap-mgr@x.com', ids.upper);
  ids.e1 = await add('AP One', 'ap-one@x.com', ids.mgr);
  ids.e2 = await add('AP Two', 'ap-two@x.com', ids.mgr);
  ids.hr = await add('AP HR', 'ap-hr@x.com');
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ap-hr@x.com','hr'),($1,'ap-mgr@x.com','manager'),($1,'ap-upper@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['ap-upper@x.com', 'ap-mgr@x.com', 'ap-one@x.com', 'ap-two@x.com', 'ap-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase, opens_at, closes_at)
     VALUES ($1,'FY26','2026-27','manager_eval','2026-04-01','2027-03-31') RETURNING id`, [t.id])).rows[0];
  const sheet = async (emp, kras) => {
    const s = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
      [t.id, cycle.id, emp])).rows[0];
    const out = {}; let i = 0;
    for (const [title, w] of kras) {
      out[title] = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [t.id, s.id, title, w, (i += 10)])).rows[0].id;
    }
    return out;
  };
  ids.k1 = await sheet(ids.e1, [['Delivery', 60], ['Quality', 40]]);
  ids.k2 = await sheet(ids.e2, [['Delivery', 100]]);
  ids.km = await sheet(ids.mgr, [['Team delivery', 70], ['People', 30]]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) })).json()).token;
  for (const [k, e] of [['upper', 'ap-upper@x.com'], ['mgr', 'ap-mgr@x.com'], ['e1', 'ap-one@x.com'], ['e2', 'ap-two@x.com'], ['hr', 'ap-hr@x.com']]) tok[k] = await login(e);
});
after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'hr') => {
  const r = await fetch(`${base}${path}`, { ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
};
const HEAD = 'Item Id,Item Name,Log Title,Log Hours(for calculation),Log owner,Log Date,Owner Mail Id';
const upload = async (lines) => {
  const fd = new FormData();
  fd.append('file', new Blob([[HEAD, ...lines].join('\n')]), 'ts.csv');
  const r = await fetch(`${base}/pms/timesheet/upload?commit=1`, { method: 'POST', headers: { Authorization: `Bearer ${tok.hr}` }, body: fd });
  return { status: r.status, body: await r.json() };
};
const SEP = ['01/Sep/2026', '02/Sep/2026', '03/Sep/2026'];
const rowsFor = (name, email, title, hours) => SEP.map((d, i) => `I-${i},Work,${title},${hours},${name},${d},${email}`);
const mine = async (who = 'mgr', q = '') => (await api(`/pms/timesheet/approvals${q}`, {}, who)).body;

test('HR\'s upload opens a month to approve for each person, due 5 working days on', { skip }, async () => {
  const up = await upload([...rowsFor('AP One', 'ap-one@x.com', 'Delivery', 8), ...rowsFor('AP Two', 'ap-two@x.com', 'Delivery', 8)]);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.approvals.opened, 2);
  assert.equal(up.body.approvals.due_on, ap.addWorkingDays(ap.todayIso(), 5));
  const list = await mine();
  assert.deepEqual(list.approvals.map((a) => a.employee.name).sort(), ['AP One', 'AP Two']);
  assert.ok(list.approvals.every((a) => a.status === 'pending' && a.can_act_as === 'manager' && a.period_start === '2026-08-21'));
  const note = (await db.query(`SELECT title FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind='timesheet_approval'`,
    [tenantId, ids.mgr])).rows;
  assert.equal(note.length, 1, 'one notice to the manager for the whole upload');
});

test('nobody approves their own; the upper manager waits for the cutoff; a stranger is refused', { skip }, async () => {
  const id = (await mine()).approvals.find((a) => a.employee.name === 'AP One').id;
  assert.equal((await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST', body: '{}' }, 'e1')).status, 403);
  const early = await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST', body: '{}' }, 'upper');
  assert.equal(early.status, 403);
  assert.match(early.body.error, /comes to you after that/);
  assert.equal((await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST', body: '{}' }, 'e2')).status, 403);
  assert.equal((await mine('upper')).approvals.length, 0, 'not in the upper manager\'s list before the cutoff');
});

test('THE MANAGER EDITS A RATING, WITH A REASON, AND APPROVES ON TIME', { skip }, async () => {
  const id = (await mine()).approvals.find((a) => a.employee.name === 'AP One').id;
  const view = await api(`/pms/timesheet/approvals/${id}`, {}, 'mgr');
  assert.equal(view.status, 200);
  const sys = Object.fromEntries(view.body.kra_ratings.ratings.map((r) => [r.title, r]));
  assert.equal(sys.Quality.reason, 'Not used this month', 'the system\'s figures are what the manager reviews');
  const noReason = await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST',
    body: JSON.stringify({ kra_overrides: { [ids.k1.Delivery]: { rating: 'A+' } } }) }, 'mgr');
  assert.equal(noReason.status, 422);
  assert.match(noReason.body.error, /Say why/);
  const bad = await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST',
    body: JSON.stringify({ kra_overrides: { [ids.k1.Delivery]: { rating: 'Z', reason: 'x' } } }) }, 'mgr');
  assert.equal(bad.status, 422);
  const ok = await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST',
    body: JSON.stringify({ kra_overrides: { [ids.k1.Delivery]: { rating: 'A+', reason: 'Covered a release weekend' } },
      month_override: { rating: 'A', reason: 'Strong month' }, note: 'Checked with the lead' }) }, 'mgr');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.on_time_by_manager, true);
  assert.equal(ok.body.edits, 2);
  // The edit shows in KRA coverage, the system's rating beside it.
  const cov = (await api(`/pms/timesheet/kra/employee/${ids.e1}?from=2026-08-21&to=2026-09-20&months=1`, {}, 'mgr')).body;
  const d = cov.kra_ratings.ratings.find((r) => r.title === 'Delivery');
  assert.equal(d.rating, 'A+'); assert.equal(d.edited, true); assert.equal(d.edit_reason, 'Covered a release weekend');
  assert.ok(d.rating_system && d.rating_system !== 'A+');
  assert.equal(cov.kra_ratings.month.rating, 'A'); assert.equal(cov.kra_ratings.month.edited, true);
  assert.equal(cov.approval.status, 'approved');
  assert.equal(cov.monthly.months[0].approval.status, 'approved');
  assert.equal((await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST', body: '{}' }, 'hr')).status, 409);
});

test('PAST THE CUTOFF IT GOES TO THE UPPER MANAGER, and a late approval is not on time', { skip }, async () => {
  const id = (await mine()).approvals.find((a) => a.employee.name === 'AP Two').id;
  await db.query(`UPDATE pms.timesheet_approvals SET due_on = current_date - 3 WHERE id=$1`, [id]);
  const up = await mine('upper');
  assert.deepEqual(up.approvals.map((a) => [a.employee.name, a.status, a.can_act_as]), [['AP Two', 'escalated', 'upper_manager']]);
  assert.equal(await ap.sweepEscalations(tenantId), 1, 'the upper manager is told once');
  assert.equal(await ap.sweepEscalations(tenantId), 0);
  const ok = await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST', body: '{}' }, 'upper');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.approved_as, 'upper_manager');
  assert.equal(ok.body.on_time_by_manager, false);
});

test('THE MANAGER\'S "TIMESHEET APPROVAL" KRA: added by HR at 10%, rated from the approvals', { skip }, async () => {
  const dry = await api('/pms/timesheet/approvals/kra', { method: 'POST', body: '{}' });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dry_run, true);
  const m = dry.body.managers.find((x) => x.employee.name === 'AP Manager');
  assert.equal(m.total_before, 100); assert.equal(m.total_after, 100);
  assert.equal((await api('/pms/timesheet/approvals/kra', { method: 'POST', body: '{}' }, 'mgr')).status, 403, 'HR only');
  const done = await api('/pms/timesheet/approvals/kra?commit=1', { method: 'POST', body: '{}' });
  assert.equal(done.status, 200);
  const kras = (await db.query(
    `SELECT k.title, k.weight::float AS w, k.system_kind FROM pms.kras k JOIN pms.kra_sheets s ON s.id=k.sheet_id
      WHERE s.employee_id=$1 ORDER BY k.sort_order`, [ids.mgr])).rows;
  assert.deepEqual(kras.map((k) => [k.title, k.w]), [['Team delivery', 63], ['People', 27], ['Timesheet Approval', 10]]);
  const again = await api('/pms/timesheet/approvals/kra?commit=1', { method: 'POST', body: '{}' });
  assert.equal(again.body.managers.find((x) => x.employee.name === 'AP Manager').action, 'already has it');
  // One reportee approved on time, one not: B+.
  const cov = (await api(`/pms/timesheet/kra/employee/${ids.mgr}?from=2026-08-21&to=2026-09-20&months=1`, {}, 'hr')).body;
  const row = cov.monthly.kras.find((k) => k.title === 'Timesheet Approval');
  assert.equal(row.cells[0].rating, 'B+');
  assert.equal(row.cells[0].on_time, 1); assert.equal(row.cells[0].total, 2);
  const onScreen = cov.kra_ratings.ratings.find((r) => r.title === 'Timesheet Approval');
  assert.equal(onScreen.approval_rating.rating, 'B+');
});

test('uploading an approved month again sends it back for approval with a new clock', { skip }, async () => {
  const up = await upload(rowsFor('AP One', 'ap-one@x.com', 'Delivery', 7));
  assert.equal(up.body.approvals.opened, 1);
  const a = (await mine()).approvals.find((x) => x.employee.name === 'AP One');
  assert.equal(a.status, 'pending');
  assert.deepEqual(a.kra_overrides, {}, 'the edits were for the data that was replaced');
});

test('HR sees everybody\'s and approves any; the cutoff is HR\'s setting', { skip }, async () => {
  const all = await api('/pms/timesheet/approvals?scope=all&status=all');
  assert.equal(all.body.as, 'hr');
  assert.equal(all.body.approvals.length, 2);
  const set = await api('/pms/timesheet/settings', { method: 'PUT',
    body: JSON.stringify({ cycle_start_day: 21, green_pct: 90, amber_pct: 75, hours_per_day: 8, holidays: [], approval_cutoff_days: 3 }) });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((await api('/pms/timesheet/approvals?scope=all')).body.cutoff_days, 3);
  const bad = await api('/pms/timesheet/settings', { method: 'PUT',
    body: JSON.stringify({ cycle_start_day: 21, green_pct: 90, amber_pct: 75, approval_cutoff_days: 0 }) });
  assert.equal(bad.status, 422);
});
