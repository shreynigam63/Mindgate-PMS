// node --test — super admin sees everyone, and can approve their own.
//
// Asked for on 18 Sep: "there should be a super admin access where they
// should be able to access all tabs and can be able to approve at all
// levels for any employees including their own as well."
//
// WHAT WAS ACTUALLY MISSING. Every act-on-a-record guard in the performance
// module already let pms_admin through — "Not your report" has always been
// `manager_id !== me && !pms_admin`. What was missing was the ability to
// SEE the record: four list queries were hard-scoped to
// `manager_id = req.user.id` with no widening, so an admin opening Team KRA
// Sheets, Team Evaluation, Team Development Plans or Team Overview saw only
// their own direct reports. Everyone else was reachable by the API and
// invisible in the UI.
//
// Their OWN row was the case that could never appear at all: nobody is
// their own manager, so no team list could contain them, and the one thing
// the client asked for by name — approving your own — had no route through
// the product.
//
// THE TESTS THAT CARRY THE WEIGHT:
//   - A PLAIN MANAGER STILL SEES ONLY THEIR OWN REPORTS. This is the one
//     that matters most: widening a list query for one role is exactly how
//     everybody else's data leaks. Asserted on all four lists.
//   - the admin's own row appears in every list, and they can drive their
//     own sheet from submitted to approved over real HTTP.
//   - self_action is stamped on the audit row when the actor is the
//     subject, and NOT stamped otherwise.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId;
let adminId, mgrId, reportId, strangerId;
let adminTok, mgrTok;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const idsIn = (rows, key = 'employee_id') => (rows || []).map((r) => r[key]);

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-superadmin';
  process.env.TENANT_SLUG = 'superadmin-test-' + Date.now();
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

  const mk = async (name, email, managerId) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active','Executive','Delivery',$4) RETURNING id`,
    [t.id, name, email, managerId || null])).rows[0].id;

  adminId    = await mk('SA Admin',    'sa-admin@x.com',    null);
  mgrId      = await mk('SA Manager',  'sa-mgr@x.com',      null);
  reportId   = await mk('SA Report',   'sa-report@x.com',   mgrId);   // the manager's own report
  strangerId = await mk('SA Stranger', 'sa-stranger@x.com', adminId); // reports to nobody relevant

  for (const email of ['sa-admin@x.com', 'sa-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'sa-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'sa-mgr@x.com','manager')`, [t.id]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'SA Cycle','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;
  // The 7-parameter set is seeded per tenant by migration 008 for tenants
  // that exist when it runs; this tenant is created afterwards, so publish
  // two parameters explicitly — the same thing other tests in this suite do.
  await db.query(
    `INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order)
     VALUES ($1,'Delivery',60,10), ($1,'Collaboration',40,20)`, [t.id]);

  // A development plan for each, so the plans list has rows to scope.
  for (const [emp, mgr] of [[adminId, null], [reportId, mgrId], [strangerId, adminId]]) {
    await db.query(
      `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,manager_id,status)
       VALUES ($1,$2,$3,$4,'draft')`, [t.id, cycleId, emp, mgr]);
  }

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  adminTok = await login('sa-admin@x.com');
  mgrTok = await login('sa-mgr@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('SUPER ADMIN SEES EVERY EMPLOYEE IN EVERY TEAM LIST — THEMSELVES INCLUDED', { skip }, async () => {
  const sheets = await req('GET', '/pms/team/kra-sheets', adminTok);
  assert.equal(sheets.status, 200, JSON.stringify(sheets.body));
  assert.equal(sheets.body.scope, 'all_employees');
  for (const id of [adminId, mgrId, reportId, strangerId]) {
    assert.ok(idsIn(sheets.body.sheets).includes(id), `kra-sheets is missing ${id}`);
  }

  const evals = await req('GET', '/pms/team/evaluations', adminTok);
  assert.equal(evals.body.scope, 'all_employees');
  assert.ok(idsIn(evals.body.team).includes(adminId), 'the admin can see their OWN evaluation row');
  assert.ok(idsIn(evals.body.team).includes(reportId), "…and somebody else's report");

  const overview = await req('GET', '/pms/team/overview', adminTok);
  assert.equal(overview.body.scope, 'all_employees');
  assert.ok(idsIn(overview.body.rows).includes(adminId));
  assert.ok(idsIn(overview.body.rows).includes(reportId));

  const plans = await req('GET', '/pms/team/development-plans', adminTok);
  assert.equal(plans.body.scope, 'all_employees');
  assert.ok(plans.body.plans.some((p) => p.employee_id === adminId), 'their own growth plan');
  assert.ok(plans.body.plans.some((p) => p.employee_id === reportId), "and somebody else's");
});

test('A PLAIN MANAGER STILL SEES ONLY THEIR OWN REPORTS — all four lists', { skip }, async () => {
  // The test that matters most. Widening a list for one role is exactly
  // how everybody else's data starts leaking to everybody.
  const sheets = await req('GET', '/pms/team/kra-sheets', mgrTok);
  assert.equal(sheets.status, 200, JSON.stringify(sheets.body));
  assert.equal(sheets.body.scope, 'my_reports');
  assert.deepEqual(idsIn(sheets.body.sheets), [reportId], 'exactly their one report, nobody else');

  const evals = await req('GET', '/pms/team/evaluations', mgrTok);
  assert.equal(evals.body.scope, 'my_reports');
  assert.deepEqual(idsIn(evals.body.team), [reportId]);

  const overview = await req('GET', '/pms/team/overview', mgrTok);
  assert.equal(overview.body.scope, 'my_reports');
  assert.deepEqual(idsIn(overview.body.rows), [reportId]);

  const plans = await req('GET', '/pms/team/development-plans', mgrTok);
  assert.equal(plans.body.scope, 'my_reports');
  assert.deepEqual(plans.body.plans.map((p) => p.employee_id), [reportId]);

  // And the manager cannot reach a stranger's sheet by guessing its id.
  const s = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'submitted') RETURNING id`,
    [tenantId, cycleId, strangerId])).rows[0].id;
  const poke = await req('GET', `/pms/team/kra-sheets/${s}/kras`, mgrTok);
  assert.equal(poke.status, 403, 'still Not your report');
  await db.query(`DELETE FROM pms.kra_sheets WHERE id=$1`, [s]);
});

test('THE ADMIN CAN APPROVE THEIR OWN KRA SHEET, END TO END', { skip }, async () => {
  // Their own sheet, submitted by them, approved by them. Explicitly asked
  // for: "approve at all levels for any employees including their own".
  const own = await req('GET', '/pms/my/kra-sheet', adminTok);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const put = await req('PUT', '/pms/my/kra-sheet/kras', adminTok, {
    kras: [{ title: 'Run the platform', weight: 100 }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await req('POST', '/pms/my/kra-sheet/submit', adminTok)).status, 200);

  // It now appears in their own team list, which is the UI path that did
  // not exist before.
  const list = await req('GET', '/pms/team/kra-sheets', adminTok);
  const mine = list.body.sheets.find((r) => r.employee_id === adminId);
  assert.ok(mine, 'their own row is in the list they approve from');
  assert.equal(mine.status, 'submitted');

  // The list returns the sheet id as `id` (s.id in the SELECT), which is
  // what the approve button posts to.
  assert.ok(mine.id, 'the row carries the sheet id the decide route needs');
  const decide = await req('POST', `/pms/team/kra-sheets/${mine.id}/decide`, adminTok,
    { decision: 'approved' });
  assert.equal(decide.status, 200, JSON.stringify(decide.body));
  assert.equal((await db.query(
    `SELECT status FROM pms.kra_sheets WHERE id=$1`, [mine.id])).rows[0].status, 'approved');
});

test('SELF-APPROVAL IS MARKED IN THE AUDIT LOG — and only when it is one', { skip }, async () => {
  // A legitimate power, and exactly what an auditor comes looking for.
  // "Show me every rating somebody awarded themselves" must be one query.
  await new Promise((r) => setTimeout(r, 150));   // audit() is fire-and-forget
  const own = (await db.query(
    `SELECT action, details FROM pms.audit_log
      WHERE tenant_id=$1 AND employee_id=$2 AND action='KRA_APPROVED'`, [tenantId, adminId])).rows;
  assert.equal(own.length, 1);
  assert.equal(own[0].details.self_action, true, 'stamped');

  // The same action on somebody else must NOT carry the flag, or the query
  // above stops meaning anything.
  const s = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'submitted') RETURNING id`,
    [tenantId, cycleId, reportId])).rows[0].id;
  assert.equal((await req('POST', `/pms/team/kra-sheets/${s}/decide`, adminTok, { decision: 'approved' })).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const other = (await db.query(
    `SELECT details FROM pms.audit_log
      WHERE tenant_id=$1 AND employee_id=$2 AND action='KRA_APPROVED'`, [tenantId, reportId])).rows;
  assert.equal(other.length, 1);
  assert.equal(other[0].details && other[0].details.self_action, undefined,
    'not a self-action, so not flagged');
});

test('the admin can rate and submit their OWN manager evaluation', { skip }, async () => {
  // The next approval level up, on themselves. This scores the 7
  // organisational parameters because that is one of the two ways an
  // annual overall rating can be set, and it is the one that exercises
  // the weighted engine. Until 23 Sep it was the ONLY way — the route
  // refused a directly-set annual rating — and when the parameters came
  // off every tab that refusal went with them. The route still works,
  // which is what this keeps honest.
  await db.query(`UPDATE pms.cycles SET phase='manager_eval' WHERE id=$1`, [cycleId]);
  const params = (await db.query(
    `SELECT id FROM pms.review_parameters WHERE tenant_id=$1 AND active=true`, [tenantId])).rows;
  assert.equal(params.length, 2, 'the fixture published them');
  const scores = Object.fromEntries(params.map((p) => [p.id, 4]));

  const put = await req('PUT', `/pms/team/parameter-scores/${adminId}`, adminTok, { scores });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const r = await req('POST', `/pms/team/evaluations/${adminId}/submit`, adminTok, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await db.query(
    `SELECT overall_rating, status FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, adminId])).rows[0];
  assert.equal(row.status, 'submitted');
  assert.equal(Number(row.overall_rating), 4, 'computed from the parameters, all scored 4');

  // …and it is marked as a self-action, like the KRA approval was.
  await new Promise((res) => setTimeout(res, 150));
  const a = (await db.query(
    `SELECT details FROM pms.audit_log
      WHERE tenant_id=$1 AND employee_id=$2 AND action LIKE 'MANAGER_EVAL%'`, [tenantId, adminId])).rows;
  assert.ok(a.length, 'the submission is audited');
  assert.ok(a.some((x) => x.details && x.details.self_action === true), 'and flagged as self-rated');

  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE id=$1`, [cycleId]);
});

test('a plain employee gains nothing from any of this', { skip }, async () => {
  // sa-report has no role row, so they default to 'employee' — no
  // pms_team_eval, so every team list stays shut.
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)
                  ON CONFLICT DO NOTHING`, [tenantId, 'sa-report@x.com', await bcrypt.hash('pass', 10)]);
  const tok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sa-report@x.com', password: 'pass' }),
  })).json()).token;

  for (const path of ['/pms/team/kra-sheets', '/pms/team/evaluations',
                      '/pms/team/overview', '/pms/team/development-plans']) {
    const r = await req('GET', path, tok);
    assert.equal(r.status, 403, `${path} must stay shut to an ordinary employee`);
  }
});
