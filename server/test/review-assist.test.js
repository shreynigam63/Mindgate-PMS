// node --test — the mid-year / annual "AI assist": does it actually read
// the four sources it promises, and does it refuse cleanly when there is
// nothing to organise the answer under?
//
// The model itself is STUBBED — core/ai.narrate is replaced with a capture
// that records exactly what it was handed. That is the part worth testing:
// whether the endpoint gathers a person's connects, their target
// achievements (with achieved/not-achieved resolved), and their Aspiring
// Career, and hands all of it over. Whether Claude then writes good
// bullets is not something a unit test can assert, and pretending
// otherwise would just be a test of a canned string.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, ai, empId, cycleId, tenantId, mgrId;
let captured = null;

const post = async (token, body) => {
  const r = await fetch(`${base}/api/v1/agentic/review-assist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ra';
  process.env.TENANT_SLUG = 'ra-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  // Stubbed BEFORE the agentic router is required, though it would work
  // either way — the router holds the module object, not the function.
  ai = require('../core/ai');
  ai.narrate = async (args) => {
    captured = args;
    return { id: 'stub', created_at: new Date().toISOString(), draft: { by_kra: [], cross_cutting: {}, career_progress: [], sources_missing: [] } };
  };

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'RA Mgr','ra-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, manager_id, designation) VALUES ($1,'RA Emp','ra-emp@x.com','active',$2,'Engineer') RETURNING id`,
    [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ra-mgr@x.com', 'ra-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, opens_at)
     VALUES ($1,'RA Cycle','FYRA','annual','mid_year_review','2025-04-01') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (!HAS_DB) return; server.close(); await db.pool.end(); });

async function login(email) {
  const r = await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  });
  return (await r.json()).token;
}

test('an unknown stage is rejected before anything is read', { skip }, async () => {
  const token = await login('ra-emp@x.com');
  const r = await post(token, { stage: 'quarterly' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /midyear.*annual/);
  const none = await post(token, {});
  assert.equal(none.status, 400);
});

test('with no KRAs mapped it refuses, and says why rather than inventing headings', { skip }, async () => {
  const token = await login('ra-emp@x.com');
  const r = await post(token, { stage: 'midyear' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No KRAs are mapped to you/);
});

test('it reads all four sources and resolves each goal to achieved / overdue / in progress', { skip }, async () => {
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
    [tenantId, cycleId, empId, mgrId])).rows[0];
  await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, measures, category, sort_order) VALUES
      ($1,$2,'On-Time Delivery',60,'100% milestone achievement','Project / Process',10),
      ($1,$2,'Code Quality',40,'<2 critical bugs in UAT','Project / Process',20)`,
    [tenantId, sheet.id]);
  await db.query(
    `INSERT INTO pms.connects (tenant_id, employee_id, manager_id, held_at, topic, discussion_notes, achievements, blockers, feedback)
     VALUES ($1,$2,$3,'2025-08-12','Sprint review','Went through the release','Shipped the August release','Waiting on vendor sign-off','Good communication')`,
    [tenantId, empId, mgrId]);
  const plan = (await db.query(
    `INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
    [tenantId, cycleId, empId])).rows[0];
  await db.query(
    `INSERT INTO pms.development_goals (tenant_id, plan_id, title, target_date, progress_pct, sort_order) VALUES
      ($1,$2,'Finish the Kubernetes course','2025-06-30',100,10),
      ($1,$2,'Run a design review',        '2025-05-31', 20,20),
      ($1,$2,'Mentor a junior',            '2099-12-31', 50,30)`,
    [tenantId, plan.id]);
  await db.query(
    `INSERT INTO people.career_paths (tenant_id, employee_id, target_role, target_timeline, plan)
     VALUES ($1,$2,'Technical Manager','18 months','Lead a delivery workstream')`,
    [tenantId, empId]);

  captured = null;
  const token = await login('ra-emp@x.com');
  const r = await post(token, { stage: 'midyear' });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const input = captured.input;
  assert.equal(input.kras.length, 2);
  assert.equal(input.kras[0].category, 'Project / Process', 'the KRA category from the goal sheet travels through');
  assert.equal(input.one_on_one_connects.length, 1);
  assert.equal(input.one_on_one_connects[0].achievements, 'Shipped the August release');
  assert.equal(input.aspiring_career.target_role, 'Technical Manager');

  // The achieved / not-achieved call is made HERE, from the data, and
  // handed to the model as a fact — not left for it to infer from a
  // percentage and a date it might read either way.
  const states = Object.fromEntries(input.target_achievements_for_the_year.map((g) => [g.title, g.state]));
  assert.deepEqual(states, {
    'Finish the Kubernetes course': 'achieved',
    'Run a design review': 'overdue and incomplete',
    'Mentor a junior': 'in progress',
  });

  // The counts come back so a thin answer can be explained by a thin record.
  assert.deepEqual(r.body.evidence_counts,
    { kras: 2, connects: 1, goals: 3, goals_achieved: 1, aspiring_career_set: true });
});

test('the prompt forbids a rating and demands per-KRA bullets', { skip }, async () => {
  // Both are load-bearing: this feature sits directly next to a rating
  // control, and the whole request was "bullets grouped by KRA".
  assert.match(captured.system, /Never suggest, imply or hint at a rating/);
  assert.match(captured.system, /never paragraphs/i);
  assert.match(captured.system, /EXACT title/);
  assert.equal(captured.kind, 'midyear_assist');
});

test('the annual stage reads the same record under its own draft kind', { skip }, async () => {
  captured = null;
  const token = await login('ra-emp@x.com');
  const r = await post(token, { stage: 'annual' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(captured.kind, 'annual_assist');
  assert.match(captured.input.stage, /annual self-appraisal/);
  assert.equal(captured.input.kras.length, 2);
});

test('it is about you and nobody else — there is no employee_id to pass', { skip }, async () => {
  // The manager has no KRAs of their own, so asking as them returns THEIR
  // (empty) record rather than their reportee's. Proves the endpoint reads
  // req.user and ignores anything in the body.
  const token = await login('ra-mgr@x.com');
  const r = await post(token, { stage: 'midyear', employee_id: empId });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No KRAs are mapped to you/);
});
