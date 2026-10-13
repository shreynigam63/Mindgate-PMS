// node --test — the manager's Potential step (9-box build, 13 Oct).
//
// Potential used to be one Low/Medium/High chip on the evaluation, and
// calibration typed a 9-box cell beside it. The client's 9-box
// specification replaced both: the manager answers four questions, 1–5,
// which are averaged with the competency score, and HR moves a box only
// by overriding a band with a reason. These tests hold the manager's
// half: what may be answered, when, by whom — and that HR's override
// never rewrites what the manager said.
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

  // The Potential step belongs to the annual review, where the 9-box
  // is placed.
  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'PT Cycle','FY26','annual','manager_eval') RETURNING id`, [t.id])).rows[0].id;

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

const four = { learning_agility: 4, leadership: 5, ownership: 4, readiness: 5 };

test('a manager answers the four questions; three of four is not yet a score', { skip }, async () => {
  const part = await req('PUT', `/pms/team/evaluations/${empId}/potential`, mgrTok,
    { answers: { learning_agility: 4, leadership: 5, ownership: 4 } });
  assert.equal(part.status, 200, JSON.stringify(part.body));
  assert.equal(part.body.questions_score.answered, 3);
  assert.equal(part.body.questions_score.score, null);
  assert.equal(part.body.potential.score, null, 'no competency assessment and incomplete questions: no potential yet');

  const all = await req('PUT', `/pms/team/evaluations/${empId}/potential`, mgrTok, { answers: { readiness: 5 } });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.answers, four, 'a save merges into what was already answered');
  assert.equal(all.body.questions_score.score, 4.5);
  assert.equal(all.body.potential.score, 4.5);
  assert.equal(all.body.potential.partial, true, 'the questions alone, said as such');
  assert.equal(all.body.potential.from, 'questions');
});

test('an answer can be taken back — the old chip could not be cleared', { skip }, async () => {
  const r = await req('PUT', `/pms/team/evaluations/${empId}/potential`, mgrTok, { answers: { readiness: null } });
  assert.equal(r.status, 200);
  assert.equal(r.body.answers.readiness, undefined);
  assert.equal(r.body.questions_score.score, null);
  await req('PUT', `/pms/team/evaluations/${empId}/potential`, mgrTok, { answers: { readiness: 5 } });
});

test('every save is audited with what it was before', { skip }, async () => {
  const a = (await db.query(
    `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND employee_id=$2 AND action='POTENTIAL_ANSWERED' ORDER BY at`,
    [tenantId, empId])).rows;
  assert.equal(a.length, 4);
  assert.deepEqual(a[1].details.after, four);
  assert.equal(a[2].details.before.readiness, 5);
});

test('only while manager evaluation is open, and only for your own reports', { skip }, async () => {
  const stranger = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,'PT Stranger','pt-stranger@x.com','active','Executive','Delivery') RETURNING id`,
    [tenantId])).rows[0].id;
  const r = await req('PUT', `/pms/team/evaluations/${stranger}/potential`, mgrTok, { answers: { leadership: 3 } });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Not your report/);

  await db.query(`UPDATE pms.cycles SET phase='calibration' WHERE id=$1`, [cycleId]);
  const late = await req('PUT', `/pms/team/evaluations/${empId}/potential`, mgrTok, { answers: { leadership: 1 } });
  assert.equal(late.status, 409);
  const read = await req('GET', `/pms/team/evaluations/${empId}/potential`, mgrTok);
  assert.equal(read.body.editable, false, 'still readable, no longer editable');
});

test("HR's override moves the box, never the manager's answers", { skip }, async () => {
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, entries, overall_rating, status, submitted_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,4,'submitted',now())
     ON CONFLICT (cycle_id, employee_id) DO UPDATE SET overall_rating=4, status='submitted'`, [tenantId, cycleId, empId, mgrId]);
  const ov = await req('POST', '/pms/nine-box/override', adminTok,
    { employee_id: empId, axis: 'potential', band: 1, reason: 'Calibrated against the peer group' });
  assert.equal(ov.status, 200, JSON.stringify(ov.body));
  assert.equal(ov.body.placement.box_key, '2,1');
  assert.equal(ov.body.placement.computed_pot_band, 2, 'the scores still say High');
  const saved = (await db.query(`SELECT answers FROM pms.potential_answers WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0];
  assert.deepEqual(saved.answers, four, "the manager's answers are untouched");
});

test('a mid-year cycle has no Potential step', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  await db.query(`INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase) VALUES ($1,'PT Mid','FY27','midyear','manager_eval')`, [tenantId]);
  const r = await req('GET', `/pms/team/evaluations/${empId}/potential`, mgrTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.applies, false);
});
