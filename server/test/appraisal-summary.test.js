// node --test — the AI Appraisal Summary (two stages, two audiences) and
// AI recommendations that survive the page being closed.
//
// The model is STUBBED. What is worth testing here is not the prose: it is
// who may ask for which stage, that the two stages really are different
// instructions over the same evidence, that the evidence is the app's own
// consolidation rather than a second gatherer, and that a kept
// recommendation can be accepted or turned down and stays turned down.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, strangerId, kraA;
let captured = null;

const api = async (path, token, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-as';
  process.env.TENANT_SLUG = 'as-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const ai = require('../core/ai');
  ai.narrate = async (args) => {
    captured = args;
    return { id: '11111111-1111-4111-8111-111111111111', created_at: new Date().toISOString(),
      draft: { by_kra: [], cross_cutting: {}, discussion_points: [], evidence_gaps: [] } };
  };

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'AS Mgr','as-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'AS Emp','as-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const s = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'AS Stranger','as-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  strangerId = s.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'as-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['as-mgr@x.com', 'as-emp@x.com', 'as-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'AS Cycle','FYAS','annual','manager_eval') RETURNING id`,
    [t.id])).rows[0];
  cycleId = cycle.id;
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
    [t.id, cycle.id, empId, mgrId])).rows[0];
  kraA = (await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'On-Time Delivery',100,10) RETURNING id`,
    [t.id, sheet.id])).rows[0].id;
  // A full year on record, so the summary has something real to narrate.
  await db.query(`INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id, self_entries, self_rating, self_status)
                  VALUES ($1,$2,$3,$4,$5,3,'submitted')`,
    [t.id, cycle.id, empId, mgrId, JSON.stringify({ [kraA]: { rating: 3, narrative: 'Slipping' } })]);
  await db.query(`INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status, entries) VALUES ($1,$2,$3,'submitted',$4)`,
    [t.id, cycle.id, empId, JSON.stringify({ [kraA]: { self_rating: 5, narrative: 'Recovered and shipped' } })]);

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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }),
  });
  return (await r.json()).token;
}

test('an unknown stage is rejected', { skip }, async () => {
  const token = await login('as-mgr@x.com');
  const r = await api('/agentic/appraisal-summary', token, { method: 'POST', body: JSON.stringify({ stage: 'final', employee_id: empId }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /pre_publish.*employee/);
});

test('the pre-read is NOT the employee’s to pull about themselves', { skip }, async () => {
  // It names where their own evidence is weakest, written for someone
  // weighing a rating. That is decision support, not self-service.
  const token = await login('as-emp@x.com');
  const r = await api('/agentic/appraisal-summary', token, { method: 'POST', body: JSON.stringify({ stage: 'pre_publish' }) });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /manager, Delivery Head or HR/);
});

test('an unrelated employee gets neither stage', { skip }, async () => {
  const token = await login('as-stranger@x.com');
  assert.equal((await api('/agentic/appraisal-summary', token, { method: 'POST', body: JSON.stringify({ stage: 'pre_publish', employee_id: empId }) })).status, 403);
  assert.equal((await api('/agentic/appraisal-summary', token, { method: 'POST', body: JSON.stringify({ stage: 'employee', employee_id: empId }) })).status, 403);
});

test('the pre-read narrates the app’s own consolidation, not a second gathering', { skip }, async () => {
  captured = null;
  const token = await login('as-mgr@x.com');
  const r = await api('/agentic/appraisal-summary', token, { method: 'POST', body: JSON.stringify({ stage: 'pre_publish', employee_id: empId }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(captured.kind, 'appraisal_summary_pre');

  // The same KRA outcomes the Annual Review page renders, mid-year
  // included — which is the whole point of exporting
  // buildAnnualReviewSummary rather than writing a second gatherer.
  const k = captured.input.kra_outcomes[0];
  assert.equal(k.kra, 'On-Time Delivery');
  assert.equal(k.midyear.self.rating, 3);
  assert.equal(k.self.self_rating, 5, 'the divergence the pre-read exists to surface is in the input');
});

test('the two stages are genuinely different instructions, not one with a new header', { skip }, async () => {
  const mgrToken = await login('as-mgr@x.com');
  await api('/agentic/appraisal-summary', mgrToken, { method: 'POST', body: JSON.stringify({ stage: 'pre_publish', employee_id: empId }) });
  const pre = captured.system;

  const empToken = await login('as-emp@x.com');
  const r = await api('/agentic/appraisal-summary', empToken, { method: 'POST', body: JSON.stringify({ stage: 'employee' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const own = captured.system;

  assert.notEqual(pre, own);
  assert.equal(captured.kind, 'appraisal_summary_employee');
  // The pre-read is for a decision: divergence and thin evidence.
  assert.match(pre, /thin/i);
  assert.match(pre, /differ/i);
  // The employee's is written to them and must not relitigate the rating.
  assert.match(own, /second person/i);
  assert.match(own, /never state, restate, justify, question or hint at it/i);
  // Neither may propose a rating. \s+ rather than a literal space: the
  // prompt is hard-wrapped, so a test tied to where the line breaks would
  // fail on a reflow that changed nothing that matters.
  assert.match(pre, /never suggest, imply or hint at a\s+rating/i);
  assert.match(own, /never state, restate, justify, question or hint at it/i);
});

test('with no KRAs there is nothing to summarise a year against, and it says so', { skip }, async () => {
  const token = await login('as-stranger@x.com');
  const r = await api('/agentic/appraisal-summary', token, { method: 'POST', body: JSON.stringify({ stage: 'employee' }) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No KRAs are mapped/);
});

// ---------------------------------------------------------------------------
// Recommendations that stick
// ---------------------------------------------------------------------------

let recId;

test('a suggestion can be kept, and comes back as its own row', { skip }, async () => {
  const token = await login('as-mgr@x.com');
  const r = await api('/agentic/recommendations', token, {
    method: 'POST',
    body: JSON.stringify({
      about_employee_id: empId, kind: 'appraisal_pre_publish', cycle_id: cycleId,
      draft_id: '11111111-1111-4111-8111-111111111111',
      items: [
        { title: 'Ask why mid-year read 3 and year-end reads 5', ref: { kra: 'On-Time Delivery' } },
        { title: 'No connects logged in Q3 — check whether they happened' },
      ],
    }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.recommendations.length, 2, 'a row each — they are accepted or turned down one at a time');
  assert.equal(r.body.recommendations[0].status, 'suggested');
  recId = r.body.recommendations[0].id;

  const list = await api(`/agentic/recommendations?about_employee_id=${empId}&kind=appraisal_pre_publish`, token);
  assert.equal(list.body.recommendations.length, 2);
});

test('an item with no title is refused, naming which one', { skip }, async () => {
  const token = await login('as-mgr@x.com');
  const r = await api('/agentic/recommendations', token, {
    method: 'POST',
    body: JSON.stringify({ about_employee_id: empId, kind: 'x', items: [{ title: 'fine' }, { detail: 'no title' }] }),
  });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /item 2/);
});

test('a dismissal without a reason is refused', { skip }, async () => {
  // A dismissal with no reason teaches nobody anything. Requiring one is
  // what turns "the AI keeps suggesting rubbish" into a readable list.
  const token = await login('as-mgr@x.com');
  const r = await api(`/agentic/recommendations/${recId}`, token, { method: 'PUT', body: JSON.stringify({ status: 'dismissed' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /why you are dismissing/i);
  const still = await db.query(`SELECT status FROM agentic.recommendations WHERE id=$1`, [recId]);
  assert.equal(still.rows[0].status, 'suggested');
});

test('accept then mark done, with who decided and when recorded', { skip }, async () => {
  const token = await login('as-mgr@x.com');
  const acc = await api(`/agentic/recommendations/${recId}`, token, { method: 'PUT', body: JSON.stringify({ status: 'accepted' }) });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.recommendation.status, 'accepted');
  assert.equal(acc.body.recommendation.decided_by, 'as-mgr@x.com');
  assert.ok(acc.body.recommendation.decided_at);

  const done = await api(`/agentic/recommendations/${recId}`, token, { method: 'PUT', body: JSON.stringify({ status: 'done' }) });
  assert.equal(done.body.recommendation.status, 'done');
});

test('a dismissal keeps its reason, and the row stays for the record', { skip }, async () => {
  const token = await login('as-mgr@x.com');
  const list = await api(`/agentic/recommendations?about_employee_id=${empId}`, token);
  const other = list.body.recommendations.find((x) => x.id !== recId);
  const r = await api(`/agentic/recommendations/${other.id}`, token, {
    method: 'PUT', body: JSON.stringify({ status: 'dismissed', note: 'Connects were held, just logged late' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.recommendation.decision_note, 'Connects were held, just logged late');

  const after = await api(`/agentic/recommendations?about_employee_id=${empId}&status=dismissed`, token);
  assert.equal(after.body.recommendations.length, 1, 'dismissed is a state, not a delete — the pattern has to stay readable');
});

test('an unknown status is refused rather than stored', { skip }, async () => {
  const token = await login('as-mgr@x.com');
  const r = await api(`/agentic/recommendations/${recId}`, token, { method: 'PUT', body: JSON.stringify({ status: 'maybe' }) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /status must be one of/);
});

test('an unrelated employee can neither read nor decide someone else’s recommendations', { skip }, async () => {
  const token = await login('as-stranger@x.com');
  assert.equal((await api(`/agentic/recommendations?about_employee_id=${empId}`, token)).status, 403);
  assert.equal((await api(`/agentic/recommendations/${recId}`, token, { method: 'PUT', body: JSON.stringify({ status: 'accepted' }) })).status, 403);
  assert.equal((await api('/agentic/recommendations', token, {
    method: 'POST', body: JSON.stringify({ about_employee_id: empId, kind: 'x', items: [{ title: 'sneaky' }] }),
  })).status, 403);
});

test('the employee can see and decide recommendations kept about them', { skip }, async () => {
  // They are the person who will act on them — a suggestion about someone's
  // development that only their manager can see is half a feature.
  const token = await login('as-emp@x.com');
  const list = await api('/agentic/recommendations', token);
  assert.equal(list.status, 200);
  assert.ok(list.body.recommendations.length >= 2);
});
