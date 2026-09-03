// node --test — every employee-facing AI draft asks the model for BULLETS,
// and the ones that are not about a single KRA say so instead of asking
// for a grouping their schema has no room for.
//
// Requested after the Development Plan's "Suggest goals from my KRAs"
// came back as dense paragraphs. That was not a rendering fault: the
// route's schema literally asked for "why":"1-2 sentences" and its prompt
// was the one that never had the bullet rules injected. A route quietly
// missing them looks identical to a route that has them until someone
// reads the output, so this asserts on the prompt that is actually sent.
//
// The model is stubbed — what it writes is not testable here; what the
// endpoint ASKS FOR is, and that is the thing that regressed.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, kraIds, connectId;
let captured = null;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-adb';
  process.env.TENANT_SLUG = 'adb-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  const ai = require('../core/ai');
  await runMigrations();

  // Same stubbing convention as parameter-analysis.test.js: replace
  // narrate() so no key is needed and the arguments are inspectable.
  ai.narrate = async (args) => {
    captured = args;
    return { id: '33333333-3333-4333-8333-333333333333', created_at: new Date().toISOString(), draft: {} };
  };

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, designation) VALUES ($1,'ADB Mgr','adb-mgr@x.com','active','Manager') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, designation, manager_id) VALUES ($1,'ADB Emp','adb-emp@x.com','active','Engineer',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'adb-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['adb-mgr@x.com', 'adb-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  // mid_year_review, so activeCycleForMidyear and activeCycle agree.
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'ADB Cycle','FYADB','annual','mid_year_review') RETURNING id`,
    [t.id])).rows[0];

  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
    [t.id, cycle.id, emp.id])).rows[0];
  const k1 = (await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, measures, sort_order) VALUES ($1,$2,'Scope Management',60,'No overrun on agreed scope',1) RETURNING id`,
    [t.id, sheet.id])).rows[0];
  const k2 = (await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, measures, sort_order) VALUES ($1,$2,'Quality Assurance',40,'Defect escape rate',2) RETURNING id`,
    [t.id, sheet.id])).rows[0];
  kraIds = [k1.id, k2.id];

  // A justification already written, or justification-review 422s.
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id, self_entries)
     VALUES ($1,$2,$3,$4,$5)`,
    [t.id, cycle.id, emp.id, mgr.id, JSON.stringify({ [k1.id]: { rating: 4, narrative: 'Held scope on both releases this half.' } })]);

  const cn = (await db.query(
    `INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, discussion_notes, achievements, blockers, feedback)
     VALUES ($1,$2,$3,CURRENT_DATE,'Talked through the release scope and the defect backlog.','Closed the March scope change cleanly','Vendor test environment still down','Keep flagging scope creep earlier') RETURNING id`,
    [t.id, mgr.id, emp.id])).rows[0];
  connectId = cn.id;

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

async function login(email) {
  const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) });
  return r.json();
}
async function api(path, token, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
}

// The format clauses every one of them must carry. Asserted as the literal
// sentences the rules use, so reflowing the prompt cannot quietly detach
// a route from them the way a string-replace once did.
function assertBulletFormat(system, where) {
  assert.match(system, /Write BULLETS, never paragraphs/, `${where}: no bullet rules in the prompt`);
  assert.match(system, /at most 18 words/, `${where}: no length limit`);
  assert.match(system, /at most 3 bullets per list/i, `${where}: no list limit`);
  assert.match(system, /return it empty rather than padding it/, `${where}: padding not forbidden`);
}

test('devplan-suggest asks for bullets grouped by the KRA each goal serves', { skip }, async () => {
  captured = null;
  const { token } = await login('adb-emp@x.com');
  const r = await api('/agentic/devplan-suggest', token);
  assert.equal(r.status, 200);
  assertBulletFormat(captured.system, 'devplan-suggest');
  assert.match(captured.system, /EXACT title/, 'grouping by exact KRA title is required here');
  // The schema itself, not just the rules — this is the field that came
  // back as a paragraph, and it came back that way because it was ASKED
  // for as one.
  assert.match(captured.system, /"why":\[/, 'why must be requested as an array');
  assert.match(captured.system, /"how_to_measure":\[/, 'how_to_measure must be requested as an array');
  assert.doesNotMatch(captured.system, /"why":"1-2 sentences"/, 'the old prose schema is gone');
});

test('justification-review asks for bullets and, being about one KRA, asks for no grouping', { skip }, async () => {
  captured = null;
  const { token } = await login('adb-emp@x.com');
  const r = await api('/agentic/justification-review', token, { kra_id: kraIds[0], perspective: 'self' });
  assert.equal(r.status, 200);
  assertBulletFormat(captured.system, 'justification-review');
  // grouped:false — a review of ONE KRA has nothing to group under, and
  // asking for it invites a nesting the schema cannot hold.
  assert.doesNotMatch(captured.system, /Group every bullet under/, 'no grouping clause for a single-KRA review');
  assert.match(captured.system, /"evidence_strength":\[/, 'evidence_strength must be requested as an array');
  // The deliberate exception: the worked example stays prose, because it
  // models the paragraph the employee should write in their own box.
  assert.match(captured.system, /"stronger_example":"PROSE, not bullets/);
});

test('connect-autotag asks for one bullet per suggested KRA, not one sentence for all of them', { skip }, async () => {
  captured = null;
  const { token } = await login('adb-mgr@x.com');
  const r = await api('/agentic/connect-autotag', token, { connect_id: connectId });
  assert.equal(r.status, 200);
  assertBulletFormat(captured.system, 'connect-autotag');
  assert.match(captured.system, /"reasoning":\[/, 'reasoning must be requested as an array');
  assert.doesNotMatch(captured.system, /"reasoning":"one sentence"/, 'the old single-sentence schema is gone');
});

test('connect-extract asks for its three categories as bullet lists', { skip }, async () => {
  captured = null;
  const { token } = await login('adb-mgr@x.com');
  const r = await api('/agentic/connect-extract', token, { discussion_notes: 'Scope change handled well; test env still blocked.' });
  assert.equal(r.status, 200);
  assertBulletFormat(captured.system, 'connect-extract');
  assert.doesNotMatch(captured.system, /Group every bullet under/, 'the three categories ARE the grouping');
  assert.match(captured.system, /"achievements":\["short bullets"\]/);
  assert.match(captured.system, /"blockers":\["short bullets"\]/);
  assert.match(captured.system, /"feedback":\["short bullets"\]/);
});

test('connect-insights already returns lists, and now states the same checkable limits', { skip }, async () => {
  captured = null;
  const { token } = await login('adb-mgr@x.com');
  const r = await api('/agentic/connect-insights', token, { employee_id: empId });
  assert.equal(r.status, 200);
  // Its themes and follow-ups were always arrays of short sentences, so
  // only the caps are new. Grouping by KRA is the renderer's job here:
  // each theme carries related_kra, which the panel groups on.
  assert.match(captured.system, /under 20 words/);
  assert.match(captured.system, /"themes":\[/);
  assert.match(captured.system, /"suggested_followups":\[/);
});

// The knob itself, without a database or a server.
test('bulletRules(grouped:false) drops the grouping clause and keeps every other rule', () => {
  const { bulletRules } = require('../modules/agentic');
  const grouped = bulletRules();
  const flat = bulletRules({ grouped: false });

  assert.match(grouped, /Group every bullet under the KRA it concerns/);
  assert.doesNotMatch(flat, /Group every bullet under/);
  for (const rule of [/Write BULLETS, never paragraphs/, /at most 18 words/, /at most 3 bullets per list/i, /Plain professional English/]) {
    assert.match(flat, rule, 'a non-grouped list still obeys every other rule');
  }
});

test('bulletRules composes grouped and crossCutting independently', () => {
  const { bulletRules } = require('../modules/agentic');
  // The four combinations a caller can ask for. Both off is the shape
  // connect-extract and justification-review use; both on is the default.
  assert.match(bulletRules({ grouped: true, crossCutting: true }), /Group every bullet under/);
  assert.match(bulletRules({ grouped: true, crossCutting: true }), /cross-cutting section/);
  assert.doesNotMatch(bulletRules({ grouped: true, crossCutting: false }), /cross-cutting section/);
  assert.match(bulletRules({ grouped: true, crossCutting: false }), /Group every bullet under/);
  assert.doesNotMatch(bulletRules({ grouped: false, crossCutting: false }), /Group every bullet under/);
  assert.doesNotMatch(bulletRules({ grouped: false, crossCutting: false }), /cross-cutting section/);
});
