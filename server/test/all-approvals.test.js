// node --test — the consolidated approvals queue and its bulk approve.
//
// Asked for on 18 Sep and drawn in the UI prototype: "every pending
// decision across the whole company, in one place", with bulk approve,
// for HR and super admin.
//
// THE TESTS THAT CARRY THE WEIGHT:
//
//   - A MANAGER CANNOT OPEN IT. This queue is company-wide by design, so
//     the one way it becomes a leak is a missing permission check. Both
//     the read and the bulk write are asserted closed to pms_team_eval.
//   - ONLY SUBMITTED WORK IS DECIDABLE. A mid-year sign-off or an
//     evaluation is waiting on someone to WRITE their assessment; there
//     is nothing to approve. Those rows must arrive decidable:false, or
//     the UI offers an Approve button that would write an empty
//     evaluation in someone else's name.
//   - BULK REPORTS PER ROW. Nineteen good rows must not be lost to the
//     twentieth, and the caller must see WHICH one was refused and why —
//     the same rule the CSV importer follows.
//   - THE SHARED DECISION IS THE SAME ONE. The single-item endpoint and
//     the bulk endpoint run through approvals.decide(), so both write the
//     audit row and notify the employee. Asserted on both paths, because
//     a bulk action that skips the audit is exactly the regression this
//     refactor exists to prevent.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId;
let adminTok, mgrTok, hrTok;
let sheetA, sheetB, planA, empA, empB, mgrId;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-approvals';
  process.env.TENANT_SLUG = 'approvals-test-' + Date.now();
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
  await db.query(
    `INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order)
     VALUES ($1,'Delivery',60,10), ($1,'Collaboration',40,20)`, [t.id]);

  const mk = async (name, email, managerId) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active','Executive','Delivery',$4) RETURNING id`,
    [t.id, name, email, managerId || null])).rows[0].id;
  const adminId = await mk('AP Admin', 'ap-admin@x.com', null);
  await mk('AP HR', 'ap-hr@x.com', null);
  mgrId = await mk('AP Manager', 'ap-mgr@x.com', null);
  empA = await mk('AP Emp A', 'ap-a@x.com', mgrId);
  empB = await mk('AP Emp B', 'ap-b@x.com', mgrId);

  for (const email of ['ap-admin@x.com', 'ap-mgr@x.com', 'ap-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ap-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ap-mgr@x.com','manager')`, [t.id]);
  // A plain HR user, NOT a wildcard admin. The approvals panel reads the
  // record through the manager-facing endpoints, so this is the account
  // that proves those reads are actually open to the people who work
  // this queue.
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ap-hr@x.com','hr')`, [t.id]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'AP Cycle','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  // Two submitted KRA sheets and one submitted growth plan: the decidable
  // rows. Plus a submitted self-appraisal with no manager evaluation — a
  // row that is pending but NOT decidable.
  const sheet = async (emp) => (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now()) RETURNING id`, [t.id, cycleId, emp, mgrId])).rows[0].id;
  sheetA = await sheet(empA);
  sheetB = await sheet(empB);
  planA = (await db.query(
    `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now()) RETURNING id`, [t.id, cycleId, empA, mgrId])).rows[0].id;
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id,cycle_id,employee_id,status,submitted_at)
     VALUES ($1,$2,$3,'submitted',now())`, [t.id, cycleId, empB]);

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
  adminTok = await login('ap-admin@x.com');
  mgrTok = await login('ap-mgr@x.com');
  hrTok = await login('ap-hr@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('a manager cannot open the company-wide queue, or bulk approve with it', { skip }, async () => {
  const read = await req('GET', '/pms/approvals', mgrTok);
  assert.equal(read.status, 403);
  assert.match(read.body.error, /pms_admin/);
  const write = await req('POST', '/pms/approvals/bulk', mgrTok, { items: [{ kind: 'kra_sheet', id: sheetA }] });
  assert.equal(write.status, 403, 'the write must be closed too, not just the read');
});

test('the queue lists every pending kind, and marks what can actually be decided', { skip }, async () => {
  const { status, body } = await req('GET', '/pms/approvals', adminTok);
  assert.equal(status, 200);
  assert.equal(body.counts.kra_sheet, 2);
  assert.equal(body.counts.growth_plan, 1);
  assert.equal(body.counts.evaluation, 1, 'a submitted self-appraisal with no manager eval is pending');
  assert.equal(body.total, 4);

  const byKind = Object.fromEntries(body.items.map(i => [i.kind, i]));
  assert.equal(byKind.kra_sheet.decidable, true);
  assert.equal(byKind.growth_plan.decidable, true);
  assert.equal(byKind.evaluation.decidable, false,
    'nothing has been submitted to approve — this waits on the manager writing it');
  assert.equal(byKind.kra_sheet.waiting_on, 'AP Manager', 'every row names who it waits on');
});

test('every row names a real employee and has a unique key', { skip }, async () => {
  // The delivery-head and evaluation rows LEFT JOIN the record that may
  // not exist yet, and employee_id was being read from that side — so a
  // person whose evaluation had not been created came back with
  // employee_id null, several rows shared the key "hod_evaluation:null",
  // and the UI's type filter showed rows of the wrong type. Found by
  // filtering the page, so it is pinned here.
  const { body } = await req('GET', '/pms/approvals', adminTok);
  for (const i of body.items) {
    assert.ok(i.employee_id, `${i.kind} row for ${i.employee_name} has no employee_id`);
    assert.ok(i.row_key, `${i.kind} row has no row_key`);
    assert.ok(!i.row_key.includes('null'), `row_key "${i.row_key}" was built from a null`);
  }
  const keys = body.items.map((i) => i.row_key);
  assert.equal(new Set(keys).size, keys.length, 'row keys must be unique');
});

test('bulk approve decides every row and writes an audit row for each', { skip }, async () => {
  const r = await req('POST', '/pms/approvals/bulk', adminTok, {
    items: [{ kind: 'kra_sheet', id: sheetA }, { kind: 'growth_plan', id: planA }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.approved, 2);
  assert.equal(r.body.refused, 0);

  const sheet = (await db.query(`SELECT status FROM pms.kra_sheets WHERE id=$1`, [sheetA])).rows[0];
  const plan = (await db.query(`SELECT status FROM pms.development_plans WHERE id=$1`, [planA])).rows[0];
  assert.equal(sheet.status, 'approved');
  assert.equal(plan.status, 'approved');

  const audits = (await db.query(
    `SELECT action, details FROM pms.audit_log WHERE tenant_id=$1 AND employee_id=$2 ORDER BY at`,
    [tenantId, empA])).rows;
  assert.deepEqual(audits.map(a => a.action).sort(), ['DEVPLAN_APPROVED', 'KRA_APPROVED']);
  assert.ok(audits.every(a => a.details && a.details.bulk === true), 'a bulk decision is recorded as one');

  // The employee is told, exactly as a single approval tells them.
  const notes = (await db.query(
    `SELECT kind FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empA])).rows;
  assert.deepEqual(notes.map(n => n.kind).sort(), ['devplan_decided', 'kra_decided']);
});

test('a refused row names its reason and does not lose the good rows', { skip }, async () => {
  // sheetA is already approved by the test above; sheetB is still submitted.
  const r = await req('POST', '/pms/approvals/bulk', adminTok, {
    items: [
      { kind: 'kra_sheet', id: sheetA },                                     // already decided
      { kind: 'kra_sheet', id: sheetB },                                     // fine
      { kind: 'kra_sheet', id: '00000000-0000-0000-0000-000000000000' },     // gone
      { kind: 'nonsense', id: sheetB },                                      // not a kind
    ],
  });
  assert.equal(r.status, 200, 'a batch with bad rows is still a completed batch');
  assert.equal(r.body.approved, 1);
  assert.equal(r.body.refused, 3);
  const errors = r.body.results.filter(x => x.error).map(x => x.error);
  assert.match(errors[0], /not submitted/);
  assert.match(errors[1], /not found/);
  assert.match(errors[2], /unknown kind/);
  assert.equal((await db.query(`SELECT status FROM pms.kra_sheets WHERE id=$1`, [sheetB])).rows[0].status, 'approved');
});

test('a return still requires a comment, in bulk as well as singly', { skip }, async () => {
  const fresh = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now()) RETURNING id`,
    [tenantId, cycleId, mgrId, null])).rows[0].id;
  const r = await req('POST', '/pms/approvals/bulk', adminTok, {
    decision: 'returned', items: [{ kind: 'kra_sheet', id: fresh }],
  });
  assert.equal(r.body.approved, 0);
  assert.match(r.body.results[0].error, /needs a comment/);
  assert.equal((await db.query(`SELECT status FROM pms.kra_sheets WHERE id=$1`, [fresh])).rows[0].status,
    'submitted', 'a refused return must not have changed anything');
});

test('the single-item decide endpoint still works and still audits', { skip }, async () => {
  // A fresh employee: one sheet per person per cycle is a unique index,
  // and empA/empB already have theirs.
  const empC = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,'AP Emp C','ap-c@x.com','active','Executive','Delivery',$2) RETURNING id`,
    [tenantId, mgrId])).rows[0].id;
  const one = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now()) RETURNING id`,
    [tenantId, cycleId, empC, mgrId])).rows[0].id;
  const r = await req('POST', `/pms/team/kra-sheets/${one}/decide`, mgrTok,
    { decision: 'returned', comment: 'weights do not total 100' });
  assert.equal(r.status, 200);
  const row = (await db.query(`SELECT status, manager_comment FROM pms.kra_sheets WHERE id=$1`, [one])).rows[0];
  assert.equal(row.status, 'returned');
  assert.equal(row.manager_comment, 'weights do not total 100');
  const a = (await db.query(
    `SELECT action, details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_RETURNED'`, [tenantId])).rows;
  assert.equal(a.length, 1);
  assert.ok(!a[0].details.bulk, 'a single decision is not recorded as a bulk one');
});

test('a manager still cannot decide a sheet that is not theirs', { skip }, async () => {
  const stranger = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,'AP Stranger','ap-stranger@x.com','active','Executive','Delivery') RETURNING id`,
    [tenantId])).rows[0].id;
  const s = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status,submitted_at)
     VALUES ($1,$2,$3,'submitted',now()) RETURNING id`, [tenantId, cycleId, stranger])).rows[0].id;
  const r = await req('POST', `/pms/team/kra-sheets/${s}/decide`, mgrTok, { decision: 'approved' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Not your report/);
});

// ---- reading the record before deciding on it -----------------------------
//
// Asked for on 23 Sep: "return KRA option is missing, please add the same
// / also KRA view option is not available." The queue could bulk-approve
// and nothing else, so a reviewer approved scorecards sight unseen and
// had no way to send one back.
//
// The page reads the record through the MANAGER-facing endpoints rather
// than a new HR-only pair, so that All Approvals and Team KRA Sheets show
// the same thing. That only holds if those endpoints are actually open to
// whoever works this queue — which is what these two assert, as HR rather
// than as a wildcard admin. Both guards read `pms_team_eval` first and
// then allow pms_admin at the row; HR carries both, so the reads work.
// A future bundle change that drops pms_team_eval from HR would blank the
// View panel with a 403 and nothing else would notice.

test('HR can read the KRA sheet behind a queue row, not just approve it blind', { skip }, async () => {
  const r = await req('GET', `/pms/team/kra-sheets/${sheetA}/kras`, hrTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.sheet, 'the sheet itself comes back');
  assert.ok(Array.isArray(r.body.kras), 'and its KRAs');
  assert.ok(r.body.weights, 'and the weight total the panel warns on');
  // Super admin too, which is the account the page is written for.
  assert.equal((await req('GET', `/pms/team/kra-sheets/${sheetA}/kras`, adminTok)).status, 200);
});

test('HR can read the growth plan behind a queue row', { skip }, async () => {
  const r = await req('GET', `/pms/team/development-plans/${planA}/goals`, hrTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.plan);
  assert.ok(Array.isArray(r.body.goals));
});

test('an employee cannot read someone else\'s sheet through those endpoints', { skip }, async () => {
  // The View panel is HR's; widening the read to build it must not have
  // widened it for everybody.
  const bcrypt = require('bcryptjs');
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'ap-a@x.com',$2)`,
    [tenantId, await bcrypt.hash('pass', 10)]);
  const empTok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ap-a@x.com', password: 'pass' }),
  })).json()).token;
  assert.equal((await req('GET', `/pms/team/kra-sheets/${sheetB}/kras`, empTok)).status, 403);
  assert.equal((await req('GET', `/pms/team/development-plans/${planA}/goals`, empTok)).status, 403);
});

test('the queue can RETURN a sheet, with the comment reaching the employee', { skip }, async () => {
  // The other half of what was asked for. The bulk route already took a
  // decision and a comment; nothing in the UI ever sent 'returned', so
  // this asserts the whole path the Return button now uses — including
  // that the employee is told why, since a return is work landing back
  // on them.
  const empD = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,'AP Emp D','ap-d@x.com','active','Executive','Delivery',$2) RETURNING id`,
    [tenantId, mgrId])).rows[0].id;
  const sheetD = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now()) RETURNING id`,
    [tenantId, cycleId, empD, mgrId])).rows[0].id;

  const r = await req('POST', '/pms/approvals/bulk', adminTok, {
    decision: 'returned', comment: 'Weights total 95, not 100 — fix and resubmit.',
    items: [{ kind: 'kra_sheet', id: sheetD }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approved, 1);
  assert.equal(r.body.refused, 0);

  const row = (await db.query(`SELECT status, manager_comment FROM pms.kra_sheets WHERE id=$1`, [sheetD])).rows[0];
  assert.equal(row.status, 'returned');
  assert.equal(row.manager_comment, 'Weights total 95, not 100 — fix and resubmit.');

  const a = (await db.query(
    `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_RETURNED' AND employee_id=$2`,
    [tenantId, empD])).rows;
  assert.equal(a.length, 1, 'the return is audited');
  assert.equal(a[0].details.comment, 'Weights total 95, not 100 — fix and resubmit.');

  // THE COMMENT HAS TO TRAVEL. A return with the reason left behind in
  // the database is a sheet the employee finds reopened with no idea why.
  await new Promise((res) => setTimeout(res, 250));
  const n = (await db.query(
    `SELECT title, body FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, empD])).rows;
  assert.equal(n.length, 1, 'the employee is told');
  assert.match(n[0].title, /returned/i);
  assert.equal(n[0].body, 'Weights total 95, not 100 — fix and resubmit.');

  // And it is out of the queue.
  const q = await req('GET', '/pms/approvals', adminTok);
  assert.ok(!q.body.items.some((i) => i.id === sheetD), 'a returned sheet is no longer pending');
});
