// node --test — closing a month, overriding one, and what reaches
// calibration.
//
// Phase 4 of the Zoho timesheet rating engine.
//
// The two things worth more than the rest:
//
//   - A CLOSED MONTH DOES NOT MOVE WHEN ITS INPUTS DO. That is the
//     whole reason this table exists. Recomputing September in March
//     gives a different answer whenever a KRA has been reweighted or an
//     item remapped, and "why did my rating change" must have an
//     answer.
//   - THE ROLLUP REACHES CALIBRATION AS CONTEXT AND CHANGES NOTHING.
//     Not the proposed rating, not the distribution, not the kitty.
//     Rolling timesheet hygiene into an annual performance rating
//     silently merges two different measurements.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db, server, base, tenantId, tok = {}, ids = {};
// Fixed so the "period is not over" rule is deterministic rather than
// depending on the day the suite happens to run.
const TODAY = '2026-09-29';

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tsm';
  process.env.TENANT_SLUG = 'tsm-test-' + Date.now();
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
     VALUES ($1,$2,$3,'active','Delivery',$4,$5) RETURNING id`,
    [t.id, name, email, extra.designation || 'Engineer', extra.manager_id || null])).rows[0].id;
  ids.hr = await mk('TM HR', 'tm-hr@x.com', { designation: 'Head of HR' });
  ids.mgr = await mk('TM Manager', 'tm-mgr@x.com', { designation: 'Delivery Manager' });
  ids.emp = await mk('TM Employee', 'tm-emp@x.com', { manager_id: ids.mgr });

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tm-hr@x.com','admin'),($1,'tm-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['tm-hr@x.com', 'tm-mgr@x.com', 'tm-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase, opens_at, closes_at)
     VALUES ($1,'FY26','2026-27','calibration','2026-04-01','2027-03-31') RETURNING id`, [t.id])).rows[0];
  ids.cycle = cycle.id;

  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
    [t.id, cycle.id, ids.emp])).rows[0].id;
  ids.kra = {};
  let i = 0;
  for (const [title, weight] of [['Delivery', 50], ['Reporting', 50]]) {
    ids.kra[title] = (await db.query(
      `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [t.id, sheet, title, weight, (i += 10)])).rows[0].id;
  }
  // A submitted manager evaluation, so this person appears on
  // calibration at all.
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status, overall_rating)
     VALUES ($1,$2,$3,$4,'submitted',3)`, [t.id, cycle.id, ids.emp, ids.mgr]);

  const batch = (await db.query(
    `INSERT INTO pms.timesheet_batches (tenant_id, uploaded_by_email, source_file) VALUES ($1,'tm-hr@x.com','s.xlsx') RETURNING id`,
    [t.id])).rows[0];
  const log = (d, hours, itemId, name) => db.query(
    `INSERT INTO pms.timesheet_entries (tenant_id, batch_id, employee_id, log_date, hours, item_id, item_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t.id, batch.id, ids.emp, d, hours, itemId, name]);
  // A finished period (21 Jul – 20 Aug) and a second one (21 Aug – 20 Sep).
  for (const d of ['2026-07-22', '2026-07-23', '2026-07-24']) await log(d, 8, 'I-1', 'Sprint work');
  for (const d of ['2026-08-24', '2026-08-25']) await log(d, 8, 'I-1', 'Sprint work');

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
  tok.hr = await login('tm-hr@x.com');
  tok.mgr = await login('tm-mgr@x.com');
  tok.emp = await login('tm-emp@x.com');

  // Map the item so there is something to snapshot.
  await fetch(`${base}/pms/timesheet/kra/employee/${ids.emp}/map`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok.mgr}` },
    body: JSON.stringify({ item_key: 'i-1', item_label: 'Sprint work', decision: 'kra', kra_id: ids.kra.Delivery }),
  });
});
after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'hr') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};
const JUL = { from: '2026-07-21', to: '2026-08-20' };
const AUG = { from: '2026-08-21', to: '2026-09-20' };
const monthCount = async () => Number((await db.query(
  `SELECT count(*) n FROM pms.timesheet_month WHERE tenant_id=$1`, [tenantId])).rows[0].n);

// ---- closing --------------------------------------------------------

test('A PERIOD THAT IS NOT OVER CANNOT BE CLOSED', { skip }, async () => {
  // Closing mid-month freezes a partial month as if it were whole, and
  // the compliance figure in particular would be permanently wrong.
  const r = await api('/pms/timesheet/kra/close', {
    method: 'POST',
    body: JSON.stringify({ from: '2026-09-21', to: '2026-10-20', dry_run: false, as_of: TODAY }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /is not over yet/);
  assert.equal(await monthCount(), 0);
});

test('closing is previewed by default and the preview writes nothing', { skip }, async () => {
  // dry_run defaults TRUE: this writes the numbers that reach
  // calibration, so the safe thing has to be the default thing.
  const r = await api('/pms/timesheet/kra/close', {
    method: 'POST', body: JSON.stringify({ ...JUL, as_of: TODAY }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.dry_run, true);
  assert.equal(r.body.would_close, 1);
  assert.equal(r.body.rows[0].hours, 24);
  assert.equal(await monthCount(), 0, 'the preview wrote nothing');
});

test('only HR may close a period', { skip }, async () => {
  assert.equal((await api('/pms/timesheet/kra/close', { method: 'POST', body: '{}' }, 'mgr')).status, 403);
  assert.equal((await api('/pms/timesheet/kra/close', { method: 'POST', body: '{}' }, 'emp')).status, 403);
});

test('closing settles the month, and closing again skips it', { skip }, async () => {
  const one = await api('/pms/timesheet/kra/close', {
    method: 'POST', body: JSON.stringify({ ...JUL, dry_run: false, as_of: TODAY }),
  });
  assert.equal(one.body.closed, 1);
  assert.equal(await monthCount(), 1);

  const again = await api('/pms/timesheet/kra/close', {
    method: 'POST', body: JSON.stringify({ ...JUL, as_of: TODAY }),
  });
  assert.equal(again.body.would_close, 0);
  assert.match(again.body.skipped[0].reason, /already closed/);
});

test('A CLOSED MONTH DOES NOT MOVE WHEN ITS INPUTS DO', { skip }, async () => {
  // The entire reason this table exists. Reweighting a KRA changes what
  // a live recompute says about July; the closed July must not follow.
  const closed = (await db.query(
    `SELECT weighted_coverage_pct FROM pms.timesheet_month
      WHERE tenant_id=$1 AND employee_id=$2 AND period_start='2026-07-21'`, [tenantId, ids.emp])).rows[0];
  assert.equal(Number(closed.weighted_coverage_pct), 50, 'one of two equally weighted KRAs');

  await db.query(`UPDATE pms.kras SET weight=90 WHERE id=$1`, [ids.kra.Delivery]);
  try {
    const live = await api(`/pms/timesheet/kra/employee/${ids.emp}?from=${JUL.from}&to=${JUL.to}`);
    assert.equal(live.body.summary.weighted_coverage_pct, 64.3, 'the live view follows the new weight');

    const still = (await db.query(
      `SELECT weighted_coverage_pct FROM pms.timesheet_month
        WHERE tenant_id=$1 AND employee_id=$2 AND period_start='2026-07-21'`, [tenantId, ids.emp])).rows[0];
    assert.equal(Number(still.weighted_coverage_pct), 50, 'the closed month does not');
  } finally {
    await db.query(`UPDATE pms.kras SET weight=50 WHERE id=$1`, [ids.kra.Delivery]);
  }
});

test('the closed month keeps the configuration that produced it', { skip }, async () => {
  // A snapshot nobody can argue with is worse than no snapshot.
  const row = (await db.query(
    `SELECT scoring, by_kra, withheld FROM pms.timesheet_month
      WHERE tenant_id=$1 AND employee_id=$2 AND period_start='2026-07-21'`, [tenantId, ids.emp])).rows[0];
  assert.equal(row.scoring.auto_score, false);
  assert.equal(row.scoring.min_mapped_pct, 80);
  assert.equal(row.by_kra.length, 2, 'the per-KRA breakdown as it stood');
  assert.ok(row.withheld.length, 'and why no score was produced');
});

test('closing is audited', { skip }, async () => {
  let rows = [];
  for (let i = 0; i < 40 && !rows.length; i++) {
    rows = (await db.query(
      `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='TIMESHEET_MONTH_CLOSED'`, [tenantId])).rows;
    if (!rows.length) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].details.period_start, '2026-07-21');
  assert.equal(rows[0].details.closed, 1);
});

// ---- the override ---------------------------------------------------

test('AN EMPLOYEE CANNOT OVERRIDE THEIR OWN MONTH', { skip }, async () => {
  const id = (await db.query(
    `SELECT id FROM pms.timesheet_month WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, ids.emp])).rows[0].id;
  ids.month = id;
  const r = await api(`/pms/timesheet/kra/month/${id}/override`, {
    method: 'PUT', body: JSON.stringify({ score: 99, reason: 'I was great' }),
  }, 'emp');
  assert.equal(r.status, 403);
});

test('an override needs a reason, enforced by the database too', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/month/${ids.month}/override`, {
    method: 'PUT', body: JSON.stringify({ score: 80 }),
  }, 'mgr');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /why this month is being overridden/);

  // And the constraint holds even if the handler were bypassed.
  await assert.rejects(
    db.query(`UPDATE pms.timesheet_month SET override_score=80 WHERE id=$1`, [ids.month]),
    /timesheet_month_override_reason/);
});

test('a manager overrides a month and the rollup reads it', { skip }, async () => {
  const put = await api(`/pms/timesheet/kra/month/${ids.month}/override`, {
    method: 'PUT',
    body: JSON.stringify({ score: 78, grade: 'A', reason: 'Two sprints ran in the client\'s own Jira that month' }),
  }, 'mgr');
  assert.equal(put.status, 200);

  const roll = await api(`/pms/timesheet/kra/months/${ids.emp}`, {}, 'mgr');
  assert.equal(roll.status, 200, JSON.stringify(roll.body));
  assert.equal(roll.body.rollup.overrides, 1);
  assert.equal(roll.body.rollup.score, 78);
  assert.equal(roll.body.rollup.override_reasons[0].from, null, 'no score had been computed');
  assert.equal(roll.body.rollup.override_reasons[0].to, 78);
  assert.match(roll.body.rollup.override_reasons[0].reason, /own Jira/);
});

test('the employee can read their own closed months', { skip }, async () => {
  const r = await api('/pms/timesheet/kra/months/me', {}, 'emp');
  assert.equal(r.status, 200);
  assert.equal(r.body.months.length, 1);
  assert.equal(r.body.rollup.overrides, 1, 'including the override and its reason');
});

// ---- what reaches calibration ---------------------------------------

test('THE ROLLUP REACHES CALIBRATION AS CONTEXT AND CHANGES NOTHING', { skip }, async () => {
  // Rolling timesheet hygiene into an annual performance rating merges
  // two different measurements. The suggestion is attached; the rating,
  // the distribution and the kitty are untouched.
  const before = await api('/pms/calibration');
  assert.equal(before.status, 200);
  const rowBefore = before.body.rows.find((r) => r.employee_id === ids.emp);
  assert.equal(Number(rowBefore.proposed), 3, 'the manager rating');
  const distBefore = JSON.stringify(before.body.distribution);

  assert.ok(before.body.timesheet[ids.emp], 'the rollup is attached');
  assert.equal(before.body.timesheet[ids.emp].months, 1);
  assert.match(before.body.timesheet_note, /does not feed the proposed rating/);

  // Now close a SECOND month and override it hard. If any of this fed
  // the rating, this is where it would show.
  await api('/pms/timesheet/kra/close', {
    method: 'POST', body: JSON.stringify({ ...AUG, dry_run: false, as_of: TODAY }),
  });
  const id2 = (await db.query(
    `SELECT id FROM pms.timesheet_month WHERE tenant_id=$1 AND employee_id=$2 AND period_start='2026-08-21'`,
    [tenantId, ids.emp])).rows[0].id;
  await api(`/pms/timesheet/kra/month/${id2}/override`, {
    method: 'PUT', body: JSON.stringify({ score: 5, grade: 'C', reason: 'testing that this cannot move a rating' }),
  }, 'mgr');

  const after = await api('/pms/calibration');
  const rowAfter = after.body.rows.find((r) => r.employee_id === ids.emp);
  assert.equal(Number(rowAfter.proposed), 3, 'the proposed rating is unchanged');
  assert.equal(JSON.stringify(after.body.distribution), distBefore, 'and so is the bell-curve distribution');
  assert.equal(after.body.timesheet[ids.emp].months, 2, 'only the context moved');
  assert.equal(after.body.timesheet[ids.emp].overrides, 2);
});

test('calibration still opens when there is no timesheet data at all', { skip }, async () => {
  // Calibration is the page a company runs its increments from. It must
  // not depend on this feature having been used.
  const other = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, designation)
     VALUES ($1,'TM Nolog','tm-nolog@x.com','active','Engineer') RETURNING id`, [tenantId])).rows[0];
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status, overall_rating)
     VALUES ($1,$2,$3,$4,'submitted',4)`, [tenantId, ids.cycle, other.id, ids.mgr]);
  const r = await api('/pms/calibration');
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.employee_id === other.id);
  assert.equal(Number(row.proposed), 4);
  assert.equal(r.body.timesheet[other.id], undefined, 'absent, not zero');
});

test('CALIBRATION OPENS EVEN IF THE TIMESHEET SIDE IS BROKEN', { skip }, async () => {
  // WRITTEN AFTER A POISON DID NOT BITE. The handler wraps the rollup
  // in a try/catch precisely so that Calibration — the page a company
  // runs its increments from — cannot be taken down by this feature,
  // but nothing exercised the catch: the only other test covers a
  // tenant with NO timesheet rows, which returns before the risky part.
  // So this genuinely breaks the timesheet side and checks the page
  // still answers.
  await db.query(`ALTER TABLE pms.timesheet_month RENAME TO timesheet_month_hidden`);
  try {
    const r = await api('/pms/calibration');
    assert.equal(r.status, 200, 'calibration still opens');
    const row = r.body.rows.find((x) => x.employee_id === ids.emp);
    assert.equal(Number(row.proposed), 3, 'and the rating is still there');
    assert.deepEqual(r.body.timesheet, {}, 'the context is absent, not wrong');
  } finally {
    await db.query(`ALTER TABLE pms.timesheet_month_hidden RENAME TO timesheet_month`);
  }
  // And it comes back once the table does.
  const back = await api('/pms/calibration');
  assert.ok(back.body.timesheet[ids.emp], 'the rollup returns');
});

test('the HR rollup lists everyone and says how readable it is', { skip }, async () => {
  const r = await api('/pms/timesheet/kra/rollup');
  assert.equal(r.status, 200);
  // THIRTEEN, not twelve, and that is correct: a 1 Apr - 31 Mar year
  // against a cycle start day of 21 genuinely overlaps thirteen
  // periods. Counting twelve would put a closed month outside its own
  // denominator.
  assert.equal(r.body.periods_in_cycle, 13);
  assert.deepEqual(r.body.closed_periods, ['2026-07-21', '2026-08-21']);
  assert.equal(r.body.totals.people, 1);
  assert.equal(r.body.totals.overrides, 2);
  assert.equal(r.body.people[0].rollup.cycle_coverage_pct, 15.4, '2 of 13');
  assert.equal((await api('/pms/timesheet/kra/rollup', {}, 'mgr')).status, 403);
});
