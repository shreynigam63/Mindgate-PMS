// node --test — potential is recorded in BOTH places, and neither
// overwrites the other.
//
// Asked for on 23 Sep: "potential should [be] in for both". It was only
// ever captured at Calibration, as the 9-box cell on pms.top_talent — a
// judgement made in the room with the distribution on screen. The
// manager, who has spent the year with the person, had nowhere to record
// their own view.
//
// THE TEST THAT CARRIES THE WEIGHT is `calibration does not overwrite the
// manager, and the manager does not overwrite calibration`. Two people
// making the same call at different times is exactly the shape that
// invites one value quietly clobbering the other, and then nobody can
// answer "whose judgement is this?" — the same reason rating adjustments
// are a separate table rather than an overwrite.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, mgrId, empId;
let adminTok, mgrTok;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-potential';
  process.env.TENANT_SLUG = 'potential-test-' + Date.now();
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
  await mk('PT Admin', 'pt-admin@x.com', null);
  mgrId = await mk('PT Manager', 'pt-mgr@x.com', null);
  empId = await mk('PT Report', 'pt-emp@x.com', mgrId);

  for (const email of ['pt-admin@x.com', 'pt-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'pt-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'pt-mgr@x.com','manager')`, [t.id]);

  // A mid-year cycle: the annual one refuses a directly typed overall
  // rating (the 7-parameter engine owns it), and this test is about
  // potential, not about that gate.
  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'PT Cycle','FY26','midyear','manager_eval') RETURNING id`, [t.id])).rows[0].id;

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
  adminTok = await login('pt-admin@x.com');
  mgrTok = await login('pt-mgr@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('a manager records potential with their evaluation', { skip }, async () => {
  const r = await req('PUT', `/pms/team/evaluations/${empId}`, mgrTok, { potential_rating: 'high' });
  assert.equal(r.status, 200);
  const row = (await db.query(
    `SELECT potential_rating FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  assert.equal(row.potential_rating, 'high');
});

test('it is audited, because potential feeds the 9-box', { skip }, async () => {
  const a = (await db.query(
    `SELECT action, details FROM pms.audit_log
      WHERE tenant_id=$1 AND employee_id=$2 AND action='POTENTIAL_SET_BY_MANAGER'`,
    [tenantId, empId])).rows;
  assert.equal(a.length, 1);
  assert.equal(a[0].details.potential_rating, 'high');
});

test('only low, mid or high is accepted', { skip }, async () => {
  const r = await req('PUT', `/pms/team/evaluations/${empId}`, mgrTok, { potential_rating: 'stellar' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /low.*mid.*high/);
  const row = (await db.query(
    `SELECT potential_rating FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  assert.equal(row.potential_rating, 'high', 'the refused value must not have landed');
});

test('saving other fields leaves potential alone', { skip }, async () => {
  await req('PUT', `/pms/team/evaluations/${empId}`, mgrTok, { strengths: 'Owns delivery end to end' });
  const row = (await db.query(
    `SELECT potential_rating, strengths FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  assert.equal(row.strengths, 'Owns delivery end to end');
  assert.equal(row.potential_rating, 'high', 'an unrelated save must not clear it');
});

test('calibration does not overwrite the manager, and the manager does not overwrite calibration', { skip }, async () => {
  // Calibration settles on something different from the manager's read.
  // The phase has to move for that, exactly as it does in a real cycle:
  // the top-talent write is gated on the calibration phase, and the
  // manager's edit on manager_eval. Moving it here rather than starting
  // the cycle in calibration keeps both halves of this test real.
  await db.query(`UPDATE pms.cycles SET phase='calibration' WHERE id=$1`, [cycleId]);
  const cal = await req('POST', '/pms/calibration/top-talent', adminTok,
    { employee_id: empId, nine_box_cell: 'mid-mid' });
  assert.equal(cal.status, 200);

  const tt = (await db.query(
    `SELECT nine_box_cell FROM pms.top_talent WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  const me = (await db.query(
    `SELECT potential_rating FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  assert.equal(tt.nine_box_cell, 'mid-mid', 'calibration owns the cell');
  assert.equal(me.potential_rating, 'high', "the manager's judgement survives calibration");

  // And the manager revising theirs afterwards does not move the cell.
  await db.query(`UPDATE pms.cycles SET phase='manager_eval' WHERE id=$1`, [cycleId]);
  const rev = await req('PUT', `/pms/team/evaluations/${empId}`, mgrTok, { potential_rating: 'mid' });
  assert.equal(rev.status, 200);
  const after = (await db.query(
    `SELECT nine_box_cell FROM pms.top_talent WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  assert.equal(after.nine_box_cell, 'mid-mid', 'calibration keeps the last word on placement');
});

test("calibration's list shows the manager's potential as its starting point", { skip }, async () => {
  await db.query(
    `UPDATE pms.manager_evaluations SET status='submitted', overall_rating=4, submitted_at=now()
      WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, empId]);
  const r = await req('GET', '/pms/calibration', adminTok);
  assert.equal(r.status, 200);
  const row = (r.body.rows || []).find(x => x.employee_id === empId);
  assert.ok(row, 'the employee appears in calibration');
  assert.equal(row.manager_potential, 'mid', "the manager's own read is carried through");
  assert.equal(row.nine_box_cell, 'mid-mid', 'alongside the calibrated cell, not instead of it');
});

test('a manager cannot set potential on someone who is not their report', { skip }, async () => {
  const stranger = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,'PT Stranger','pt-stranger@x.com','active','Executive','Delivery') RETURNING id`,
    [tenantId])).rows[0].id;
  const r = await req('PUT', `/pms/team/evaluations/${stranger}`, mgrTok, { potential_rating: 'high' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Not your report/);
});
