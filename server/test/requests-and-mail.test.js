// node --test — submissions as REQUESTS: visible from both ends, and mailed.
//
// Asked for on 23 Sep:
//   "every KRA submission, my growth submission or any submission to
//    Manager and above role should initiate auto mails so they are aware
//    of requests initiated"
//   "all requests initiated should be visible on dashboard of everyone
//    showing 'requested to manager' in employees dashboard, 'pending
//    requests' in manager and above roles dashboard"
//
// THE THING WORTH TESTING is that the two ends agree. A submission is ONE
// row that is a sent request to the employee and a pending request to
// their manager. If the two are computed with different tests they drift,
// and then an employee is told something is waiting on their manager
// after the manager has already dealt with it — which is exactly the bug
// this file's last test pins, because I wrote it and caught it in review.
//
// Mail runs in SIMULATED mode here (the default): nothing leaves the
// machine, and every attempt is still written to core.notif_log with its
// outcome. That log is what proves a mail was raised, so the assertions
// read it rather than a mock.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId;
const tok = {};

const get = async (p, t) => {
  const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (p, t, body) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const mails = async () => (await db.query(
  `SELECT to_email, subject, kind, mode, outcome FROM core.notif_log
    WHERE tenant_id=$1 ORDER BY at`, [tenantId])).rows;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-req';
  process.env.TENANT_SLUG = 'req-test-' + Date.now();
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
  await db.query(`INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order)
                  VALUES ($1,'Delivery',100,10)`, [t.id]);

  const mk = async (name, email, managerId) => {
    const id = (await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
       VALUES ($1,$2,$3,'active','Executive','Delivery',$4) RETURNING id`,
      [t.id, name, email, managerId || null])).rows[0].id;
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
    return id;
  };
  mgrId = await mk('R Manager', 'req-mgr@x.com', null);
  empId = await mk('R Report', 'req-emp@x.com', mgrId);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'req-mgr@x.com','manager')`, [t.id]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'R Cycle','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['mgr', 'req-mgr@x.com'], ['emp', 'req-emp@x.com']]) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('before anything is submitted, neither end shows a request', { skip }, async () => {
  const emp = await get('/pms/home', tok.emp);
  assert.deepEqual(emp.body.me.requested, []);
  const mgr = await get('/pms/home', tok.mgr);
  assert.equal(mgr.body.team.pending_requests.total, 0);
});

test('submitting a KRA sheet raises a MAIL to the manager', { skip }, async () => {
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'draft')`, [tenantId, cycleId, empId, mgrId]);
  const sheet = (await db.query(
    `SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
  await db.query(
    `INSERT INTO pms.kras (tenant_id,sheet_id,title,weight,sort_order)
     VALUES ($1,$2,'Ship the thing',100,1)`, [tenantId, sheet.id]);

  const before = (await mails()).length;
  const r = await post('/pms/my/kra-sheet/submit', tok.emp);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const sent = await mails();
  assert.equal(sent.length, before + 1, 'exactly one mail, to one recipient');
  const m = sent[sent.length - 1];
  assert.equal(m.to_email, 'req-mgr@x.com', 'the manager, not the submitter');
  assert.equal(m.kind, 'kra_submitted');
  assert.match(m.subject, /KRA sheet submitted/);
  // Simulated is the safe default: nothing left the machine, and the
  // attempt is on the record either way.
  assert.equal(m.mode, 'simulated');
  assert.equal(m.outcome, 'simulated');
});

test('and the same submission appears on BOTH dashboards, agreeing', { skip }, async () => {
  const emp = await get('/pms/home', tok.emp);
  assert.equal(emp.body.me.requested.length, 1);
  assert.equal(emp.body.me.requested[0].label, 'KRA sheet');
  assert.equal(emp.body.me.requested[0].waiting_on, 'R Manager',
    'the employee is told WHO it is with, not just that it is out');
  assert.ok(emp.body.me.requested[0].since, 'and since when');

  const mgr = await get('/pms/home', tok.mgr);
  assert.equal(mgr.body.team.pending_requests.kra, 1);
  assert.equal(mgr.body.team.pending_requests.total, 1);
  // The BANNER still reads kra_due, because this manager has not
  // submitted their own sheet and their own work outranks work they owe
  // others. The queue is not hidden by that — it is the count above, and
  // the desk tile on the page. Asserted so the two are not confused: a
  // banner about something else does not mean the requests were lost.
  assert.equal(mgr.body.action.kind, 'kra_due');
});

test('an employee is never shown anyone else\'s requests', { skip }, async () => {
  // requested is "what I sent", so a manager with nothing outstanding of
  // their own has an empty list even while three people wait on them.
  const mgr = await get('/pms/home', tok.mgr);
  assert.deepEqual(mgr.body.me.requested, []);
  const emp = await get('/pms/home', tok.emp);
  assert.equal(emp.body.team, null, 'and an employee has no pending-request block at all');
});

test('deciding it clears BOTH ends, and mails the employee back', { skip }, async () => {
  const sheet = (await db.query(
    `SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId])).rows[0];
  const before = (await mails()).length;
  const r = await post(`/pms/team/kra-sheets/${sheet.id}/decide`, tok.mgr,
    { decision: 'returned', comment: 'Weights do not total 100' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const sent = await mails();
  assert.equal(sent.length, before + 1);
  assert.equal(sent[sent.length - 1].to_email, 'req-emp@x.com',
    'a return is work landing back on the employee — they get told');

  const emp = await get('/pms/home', tok.emp);
  assert.deepEqual(emp.body.me.requested, [], 'no longer waiting on anyone');
  const mgr = await get('/pms/home', tok.mgr);
  assert.equal(mgr.body.team.pending_requests.total, 0, 'and no longer pending on the manager');
});

test('THE ASYMMETRY: an evaluated self-appraisal is pending on nobody, on either dashboard', { skip }, async () => {
  // Caught in review of my own first cut. The manager's pending count
  // excluded a self-appraisal that already had a submitted manager
  // evaluation; the employee's "requested" list did not. So the employee
  // was told their appraisal was still with their manager days after the
  // manager had finished with it — two readings of one row, disagreeing.
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id,cycle_id,employee_id,status,submitted_at)
     VALUES ($1,$2,$3,'submitted',now())`, [tenantId, cycleId, empId]);

  let emp = await get('/pms/home', tok.emp);
  let mgr = await get('/pms/home', tok.mgr);
  assert.equal(emp.body.me.requested.length, 1, 'submitted and not yet evaluated: waiting');
  assert.equal(mgr.body.team.pending_requests.appraisal, 1, 'and pending on the manager');

  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id,cycle_id,employee_id,manager_id,status,submitted_at)
     VALUES ($1,$2,$3,$4,'submitted',now())`, [tenantId, cycleId, empId, mgrId]);

  emp = await get('/pms/home', tok.emp);
  mgr = await get('/pms/home', tok.mgr);
  assert.equal(mgr.body.team.pending_requests.appraisal, 0);
  assert.deepEqual(emp.body.me.requested, [],
    'the employee must not still be told it is with their manager');
});
