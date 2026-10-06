// node --test — the timesheet→KRA mapping over the real HTTP surface.
//
// Phase 2 of the Zoho timesheet rating engine. The pure tests pin the
// maths; this pins the wiring, which is where the bugs that reach a
// client live.
//
// Three things here are worth more than the rest:
//
//   - an EMPLOYEE CANNOT MAP THEIR OWN HOURS. Saying "this item belongs
//     to that KRA" moves hours between objectives and "this is not KRA
//     work" removes them from the denominator. Either would be
//     self-marking.
//   - a BAD ROW IN A BULK CALL WRITES NOTHING. A half-applied batch
//     leaves a coverage figure matching neither what the manager saw
//     nor what they pressed.
//   - PUT /timesheet/settings DOES NOT WIPE THE REST OF THE BLOB. That
//     was a live defect, reproduced against a running instance before
//     it was fixed: changing the cycle start day silently deleted the
//     org-wide value-add keyword list.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db, server, base, tenantId, tok = {};
let ids = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tskra';
  process.env.TENANT_SLUG = 'tskra-test-' + Date.now();
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

  const mgr = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
     VALUES ($1,'TK Manager','tk-mgr@x.com','active','Delivery','Delivery Manager') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation, manager_id)
     VALUES ($1,'TK Employee','tk-emp@x.com','active','Delivery','Support Engineer',$2) RETURNING id`,
    [t.id, mgr.id])).rows[0];
  const other = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
     VALUES ($1,'TK Other','tk-other@x.com','active','Delivery','Support Engineer') RETURNING id`, [t.id])).rows[0];
  const hr = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
     VALUES ($1,'TK HR','tk-hr@x.com','active','HR','Head of HR') RETURNING id`, [t.id])).rows[0];
  ids = { mgr: mgr.id, emp: emp.id, other: other.id, hr: hr.id };

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tk-hr@x.com','admin'),($1,'tk-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['tk-mgr@x.com', 'tk-emp@x.com', 'tk-hr@x.com', 'tk-other@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase, opens_at, closes_at)
     VALUES ($1,'FY26','2026-27','manager_eval','2026-04-01','2027-03-31') RETURNING id`, [t.id])).rows[0];
  ids.cycle = cycle.id;

  // Two sheets: the employee's, and somebody else's — so "map onto a
  // KRA that is not theirs" has a real KRA to be refused with.
  const mkSheet = async (employeeId, kras) => {
    const s = (await db.query(
      `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
      [t.id, cycle.id, employeeId])).rows[0];
    const out = {};
    let i = 0;
    for (const [title, weight] of kras) {
      const k = (await db.query(
        `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [t.id, s.id, title, weight, (i += 10)])).rows[0];
      out[title] = k.id;
    }
    return out;
  };
  ids.kra = await mkSheet(emp.id, [['Ticket Resolution', 60], ['Client Reporting', 20], ['CSAT Score', 20]]);
  ids.otherKra = await mkSheet(other.id, [['Somebody Else KRA', 100]]);

  // A month of logs: two items, one of them the bulk of the time.
  const batch = (await db.query(
    `INSERT INTO pms.timesheet_batches (tenant_id, uploaded_by_email, source_file, project_name)
     VALUES ($1,'tk-hr@x.com','sprints.xlsx','UPI 5.0 Product') RETURNING id`, [t.id])).rows[0];
  const log = (d, hours, itemId, name, desc) => db.query(
    `INSERT INTO pms.timesheet_entries (tenant_id, batch_id, employee_id, owner_email, log_date, hours,
       item_id, item_name, item_type, sprint, description, project_name)
     VALUES ($1,$2,$3,'tk-emp@x.com',$4,$5,$6,$7,'Story','Q2 Sprint 3',$8,'UPI 5.0 Product')`,
    [t.id, batch.id, emp.id, d, hours, itemId, name, desc || null]);
  // 21 Aug – 20 Sep is one compliance cycle at the default start day.
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07']) {
    await log(d, 8, 'U5P-I58', 'GFF Activities', 'platform work');
  }
  await log('2026-09-08', 8, 'U5P-I72', 'Tap N Pay', 'automation of the settlement run');
  await log('2026-09-09', 4, 'U5P-I99', 'Company offsite', 'all-hands');

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
  tok.mgr = await login('tk-mgr@x.com');
  tok.emp = await login('tk-emp@x.com');
  tok.hr = await login('tk-hr@x.com');
  tok.other = await login('tk-other@x.com');
});

after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'hr') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};
const WIN = 'from=2026-08-21&to=2026-09-20';
const mapCount = async () => Number((await db.query(
  `SELECT count(*) n FROM pms.timesheet_kra_map WHERE tenant_id=$1`, [tenantId])).rows[0].n);

// ---- reading ------------------------------------------------------------

test('the read groups logs by work item and calls them all unmapped at first', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.has_kras, true);
  assert.equal(r.body.items.length, 3, 'three items, not seven logs');
  assert.deepEqual([...new Set(r.body.items.map((i) => i.how))], ['unmapped']);
  assert.equal(r.body.totals.logged, 52);
  assert.equal(r.body.totals.mapped_pct, 0);
  assert.equal(r.body.summary.score, null, 'nothing is scored from this yet');
});

test('an employee reads their own numbers, and a stranger cannot', { skip }, async () => {
  const mine = await api(`/pms/timesheet/kra/me?${WIN}`, {}, 'emp');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.employee.email, 'tk-emp@x.com');
  const theirs = await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`, {}, 'other');
  assert.equal(theirs.status, 403);
});

// ---- the authorisation that matters -------------------------------------

test('AN EMPLOYEE CANNOT MAP THEIR OWN HOURS', { skip }, async () => {
  // Mapping moves hours between objectives. Self-service here is
  // self-marking, however transparent the read side is.
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}/map`, {
    method: 'PUT',
    body: JSON.stringify({ item_key: 'u5p-i58', decision: 'kra', kra_id: ids.kra['Ticket Resolution'] }),
  }, 'emp');
  assert.equal(r.status, 403);
  assert.equal(await mapCount(), 0);
});

test('a KRA from somebody else\'s sheet is refused', { skip }, async () => {
  // Without this check a manager could park a reportee's hours on an
  // objective belonging to another person entirely, by passing its id.
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}/map`, {
    method: 'PUT',
    body: JSON.stringify({ item_key: 'u5p-i58', decision: 'kra', kra_id: ids.otherKra['Somebody Else KRA'] }),
  }, 'mgr');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /not on this person's sheet/);
  assert.equal(await mapCount(), 0);
});

test('EXCLUDING WORK NEEDS A REASON', { skip }, async () => {
  // Excluded hours leave the denominator. Without a mandatory note,
  // "not KRA work" is the quiet way to make any month look fully mapped.
  const bad = await api(`/pms/timesheet/kra/employee/${ids.emp}/map`, {
    method: 'PUT', body: JSON.stringify({ item_key: 'u5p-i99', decision: 'excluded' }),
  }, 'mgr');
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /Say why this item is not KRA work/);
  assert.equal(await mapCount(), 0);
});

test('A BAD ROW IN A BULK CALL WRITES NOTHING', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}/map/bulk`, {
    method: 'POST',
    body: JSON.stringify({ mappings: [
      { item_key: 'u5p-i58', decision: 'kra', kra_id: ids.kra['Ticket Resolution'] },
      { item_key: 'u5p-i99', decision: 'excluded' },            // no reason
    ] }),
  }, 'mgr');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /^Item 2:/);
  assert.equal(await mapCount(), 0, 'row 1 was not left behind');
});

test('a bulk call refused MID-WRITE also leaves nothing behind', { skip }, async () => {
  // The per-row validation above happens before any write. This one
  // passes validation and is refused inside the transaction, by the
  // belongs-to-this-sheet check — the path that actually needs the
  // ROLLBACK to be running on the same connection as the INSERTs.
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}/map/bulk`, {
    method: 'POST',
    body: JSON.stringify({ mappings: [
      { item_key: 'u5p-i58', decision: 'kra', kra_id: ids.kra['Ticket Resolution'] },
      { item_key: 'u5p-i72', decision: 'kra', kra_id: ids.otherKra['Somebody Else KRA'] },
    ] }),
  }, 'mgr');
  assert.equal(r.status, 422);
  assert.equal(await mapCount(), 0, 'the first insert was rolled back');
});

// ---- the happy path -----------------------------------------------------

test('the manager maps the month and every number moves', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}/map/bulk`, {
    method: 'POST',
    body: JSON.stringify({ mappings: [
      { item_key: 'u5p-i58', item_label: 'GFF Activities', decision: 'kra', kra_id: ids.kra['Ticket Resolution'] },
      { item_key: 'u5p-i72', item_label: 'Tap N Pay', decision: 'kra', kra_id: ids.kra['Client Reporting'] },
      { item_key: 'u5p-i99', item_label: 'Company offsite', decision: 'excluded', note: 'all-hands, not KRA work' },
    ] }),
  }, 'mgr');
  assert.equal(r.status, 200);
  assert.equal(r.body.saved, 3);

  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  assert.equal(v.totals.logged, 52);
  assert.equal(v.totals.excluded, 4, 'the offsite is out of the denominator');
  assert.equal(v.totals.considered, 48);
  assert.equal(v.totals.mapped_pct, 100);
  const tr = v.by_kra.find((k) => k.title === 'Ticket Resolution');
  assert.equal(tr.hours, 40);
  // Two of three KRAs saw work: 60 + 20 of 100 by weight.
  assert.equal(v.summary.weighted_coverage_pct, 80);
  assert.deepEqual(v.uncovered.map((u) => u.title), ['CSAT Score']);
});

test('EACH KRA GETS A TIMESHEET RATING — hours worked against hours required', { skip }, async () => {
  // Asked for on 6 Oct. After the mapping above: 40 h on Ticket
  // Resolution (60%), 8 h on Client Reporting (20%), none on CSAT (20%).
  //
  // The month 21 Aug – 20 Sep has 21 working days = 168 required hours.
  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  assert.equal(v.kra_ratings.required_hours, 168);
  const by = Object.fromEntries(v.kra_ratings.ratings.map((r) => [r.title, r]));
  assert.equal(by['Ticket Resolution'].expected_hours, 100.8);
  assert.equal(by['Ticket Resolution'].effort_pct, 39.7, '40 of 100.8 hours');
  assert.equal(by['Ticket Resolution'].rating, 'B', '39.7% is B');
  assert.equal(by['CSAT Score'].rating, 'B');

  // The cycle view the manager and HOD rate from covers the days the
  // uploads cover — 1 to 9 Sep, 7 working days, 56 h — so a month nobody
  // has uploaded is not counted as hours not worked.
  const c = await api(`/pms/timesheet/kra/ratings/${ids.emp}`, {}, 'mgr');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.deepEqual([c.body.window.from, c.body.window.to], ['2026-09-01', '2026-09-09']);
  assert.equal(c.body.kra_ratings.required_hours, 56);
  const cy = Object.fromEntries(c.body.kra_ratings.ratings.map((r) => [r.title, r]));
  assert.equal(cy['Ticket Resolution'].effort_pct, 119, '40 h against 33.6 expected — overtime shows');
  assert.equal(cy['Ticket Resolution'].rating, 'A+');
  assert.equal(cy['Client Reporting'].effort_pct, 71.4, '8 h against 11.2 expected');
  assert.equal(cy['Client Reporting'].rating, 'B+', '71.4% is B+');
  assert.equal((await api(`/pms/timesheet/kra/ratings/${ids.emp}`, {}, 'emp')).status, 200, 'the employee sees their own');
  assert.equal((await api(`/pms/timesheet/kra/ratings/${ids.emp}`, {}, 'other')).status, 403, 'a stranger does not');

  // Evidence only: nothing was written into an evaluation.
  const ev = (await db.query(`SELECT count(*)::int n FROM pms.manager_evaluations WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(ev, 0);
});

test('the mapping is audited with what was asserted', { skip }, async () => {
  // "Why did my hours move" must have a queryable answer, the same rule
  // as every other state change that can affect a rating. audit() is
  // deliberately fire-and-forget, so this polls rather than assuming
  // the write landed before the reply did.
  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) {
    rows = (await db.query(
      `SELECT actor_email, details FROM pms.audit_log
        WHERE tenant_id=$1 AND action='TIMESHEET_KRA_MAPPED_BULK'`, [tenantId])).rows;
    if (!rows.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_email, 'tk-mgr@x.com');
  assert.equal(rows[0].details.count, 3);
  assert.ok(rows[0].details.items.some((i) => i.item_key === 'u5p-i99' && i.decision === 'excluded'));
});

test('a KRA can be declared not measurable from timesheets, with a reason', { skip }, async () => {
  const bad = await api(`/pms/timesheet/kra/kra/${ids.kra['CSAT Score']}/tracked`, {
    method: 'PUT', body: JSON.stringify({ tracked: false }),
  }, 'mgr');
  assert.equal(bad.status, 422, 'dropping a KRA from the denominator needs saying why');

  const ok = await api(`/pms/timesheet/kra/kra/${ids.kra['CSAT Score']}/tracked`, {
    method: 'PUT', body: JSON.stringify({ tracked: false, reason: 'quarterly client survey, never logged as time' }),
  }, 'mgr');
  assert.equal(ok.status, 200);

  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  assert.equal(v.summary.weighted_coverage_pct, 100, 'now 80 of the 80 that can be measured');
  assert.deepEqual(v.unscorable.map((u) => u.title), ['CSAT Score']);
  assert.deepEqual(v.uncovered, [], 'and it is no longer reported as a gap');
});

test('removing a mapping puts the hours back where they were', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}/map/u5p-i72`, { method: 'DELETE' }, 'mgr');
  assert.equal(r.status, 200);
  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  assert.ok(v.totals.mapped_pct < 100);
  assert.equal(v.items.find((i) => i.item_key === 'u5p-i72').how, 'unmapped');
  // Put it back for the tests that follow.
  await api(`/pms/timesheet/kra/employee/${ids.emp}/map`, {
    method: 'PUT',
    body: JSON.stringify({ item_key: 'u5p-i72', decision: 'kra', kra_id: ids.kra['Client Reporting'] }),
  }, 'mgr');
});

// ---- keywords inherited from the shelf ----------------------------------

test('a KRA with no keywords of its own inherits the shelf\'s', { skip }, async () => {
  // A CORRECTION TO PHASE 1. 064's header says an employee's KRA
  // inherits the shelf's keywords when one is picked; none of the three
  // code paths that write pms.kras carries the column, so it never
  // happened. Without this the keyword half of the engine would have
  // matched nothing for everybody, forever.
  await db.query(
    `INSERT INTO pms.kra_library (tenant_id, designation, department, title, keywords, sort_order)
     VALUES ($1,'Support Engineer','Delivery','Client Reporting',$2,10)`,
    [tenantId, ['tap n pay']]);
  // Drop the explicit mapping so only the keyword can place it.
  await api(`/pms/timesheet/kra/employee/${ids.emp}/map/u5p-i72`, { method: 'DELETE' }, 'mgr');
  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  const it = v.items.find((i) => i.item_key === 'u5p-i72');
  assert.equal(it.how, 'keyword', 'placed by a keyword that only the shelf carries');
  assert.deepEqual(it.matched_keywords, ['tap n pay']);
  assert.equal(it.kra_title, 'Client Reporting');
});

// ---- the value-add scan -------------------------------------------------

test('value-add mentions are reported with the text that triggered them', { skip }, async () => {
  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  const hit = v.value_add.hits.find((h) => h.keyword === 'automation');
  assert.ok(hit, 'the seeded list found the settlement-run note');
  assert.equal(hit.hours, 8);
  assert.deepEqual(hit.examples, ['Tap N Pay']);
});

// ---- the settings blob --------------------------------------------------

test('PUT /timesheet/settings DOES NOT WIPE THE REST OF THE BLOB', { skip }, async () => {
  // A live defect, reproduced against a running instance before the
  // fix: this route replaced the whole jsonb with its own four keys, so
  // an HR user changing the cycle start day silently deleted 064's
  // org-wide value-add keyword list and 065's scoring configuration,
  // with no error and nothing on screen to say it had happened.
  // WRITTEN TWICE. The first version compared the list before and
  // after against the SEEDED default, and stayed green with the fix
  // removed — because the ensure* functions that heal a missing key
  // simply re-seeded the default, so the damage was invisible. The
  // damage is real all the same: a tenant who has CURATED the list
  // loses their curation and silently gets our defaults back. So the
  // list is curated first, and it is the curation this asserts on.
  await api('/pms/hr/kra-library/value-add-keywords', {
    method: 'PUT', body: JSON.stringify({ keywords: 'patent filed, board paper' }),
  });
  const before = (await api('/pms/timesheet/kra/scoring')).body;
  assert.deepEqual(before.value_add_keywords, ['patent filed', 'board paper'], 'curated, not the seed');
  // Likewise the scoring: tuned away from the default before the PUT.
  await api('/pms/timesheet/kra/scoring', {
    method: 'PUT',
    body: JSON.stringify({ weight_coverage: 60, weight_compliance: 30, weight_value_add: 10, min_mapped_pct: 55 }),
  });
  const beforeScoring = (await api('/pms/timesheet/kra/scoring')).body.scoring;
  assert.equal(beforeScoring.min_mapped_pct, 55, 'tuned, not the seed');

  const put = await api('/pms/timesheet/settings', {
    method: 'PUT', body: JSON.stringify({ cycle_start_day: 15, green_pct: 92, amber_pct: 70, holidays: ['2026-10-02'] }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.cycle_start_day, 15);

  const after = (await api('/pms/timesheet/kra/scoring')).body;
  assert.deepEqual(after.value_add_keywords, ['patent filed', 'board paper'],
    'the CURATED value-add list survived — not merely re-seeded to the default');
  assert.equal(after.scoring.min_mapped_pct, 55, 'and so did the tuned scoring configuration');
  assert.deepEqual(after.scoring, beforeScoring);
  // Put it all back so the window and the numbers in the other tests
  // still line up.
  await api('/pms/timesheet/settings', {
    method: 'PUT', body: JSON.stringify({ cycle_start_day: 21, green_pct: 90, amber_pct: 75, holidays: [] }),
  });
  await api('/pms/hr/kra-library/value-add-keywords', {
    method: 'PUT', body: JSON.stringify({ keywords: 'automation, optimization, critical fix, patent, innovation' }),
  });
  await api('/pms/timesheet/kra/scoring', {
    method: 'PUT',
    body: JSON.stringify({ weight_coverage: 50, weight_compliance: 30, weight_value_add: 20, min_mapped_pct: 80 }),
  });
});

test('scoring weights that do not add up to 100 are refused', { skip }, async () => {
  const r = await api('/pms/timesheet/kra/scoring', {
    method: 'PUT', body: JSON.stringify({ weight_coverage: 50, weight_compliance: 30, weight_value_add: 10 }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /add up to 100/);
});

test('only HR may see or change the scoring configuration', { skip }, async () => {
  assert.equal((await api('/pms/timesheet/kra/scoring', {}, 'mgr')).status, 403);
  assert.equal((await api('/pms/timesheet/kra/scoring', { method: 'PUT', body: '{}' }, 'emp')).status, 403);
});

test('TURNING AUTOMATIC SCORING ON IS AUDITED UNDER ITS OWN NAME', { skip }, async () => {
  // The single most consequential switch in this feature. Buried in a
  // generic settings diff, nobody would ever find when it happened.
  const r = await api('/pms/timesheet/kra/scoring', {
    method: 'PUT',
    body: JSON.stringify({ auto_score: true, weight_coverage: 50, weight_compliance: 30, weight_value_add: 20, min_mapped_pct: 80 }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.scoring.auto_score, true);

  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) {
    rows = (await db.query(
      `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='TIMESHEET_AUTO_SCORE_ENABLED'`, [tenantId])).rows;
    if (!rows.length) await new Promise((x) => setTimeout(x, 50));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].details.was.auto_score, false);
  assert.equal(rows[0].details.now.auto_score, true);

  // And with it on, and the month fully mapped, a score finally appears.
  const v = (await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`)).body;
  assert.deepEqual(v.summary.withheld, []);
  assert.equal(typeof v.summary.score, 'number');
  assert.ok(v.summary.grade, 'and a grade from the seeded bands');
});

test('a person with no KRA sheet is told that, not given a zero', { skip }, async () => {
  // 1,338 of 1,427 people on the live client instance are in exactly
  // this state. It caps this whole feature, and the wording has to make
  // that visible rather than reading as a bad month.
  const v = (await api(`/pms/timesheet/kra/employee/${ids.other}?${WIN}`)).body;
  assert.equal(v.has_kras, true, 'this fixture does have a sheet');
  // The genuinely empty case: no sheet at all.
  const nobody = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, designation)
     VALUES ($1,'TK Nosheet','tk-nosheet@x.com','active','Support Engineer') RETURNING id`, [tenantId])).rows[0];
  const w = (await api(`/pms/timesheet/kra/employee/${nobody.id}?${WIN}`)).body;
  assert.equal(w.has_kras, false);
  assert.match(w.summary.withheld.join(' '), /has no KRAs for this cycle/);
  assert.equal(w.summary.score, null);
});
