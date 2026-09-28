// node --test — the form you submitted, read back on My Surveys.
//
// Step three of the Customer Feedback flow, as it finally settled. It
// was briefly a team-recognition panel on My KRAs; on 28 Sep Mindgate
// asked to "remove from MY KRA page and save the submitted form in my
// survey page", so what is kept is the plainer thing: the answers a
// person gave, on the page where they gave them.
//
// THE INTERESTING CASE IS THE ONE THAT CANNOT BE ANSWERED. An
// anonymous response is stored with employee_id NULL — there is no key
// from a person to their answers, by construction — so "show me what I
// said" has no truthful answer, and the route must say which case it
// is rather than return an empty list that reads as data loss.
//
// Real Postgres, real HTTP, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, surveyId, qTeam, qKind, qMsg, qQual, qOverall;
const emp = {};
const tok = {};

const get = async (path, t) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// One response: who gave it (null = anonymous), which teams it names,
// what it appreciated, the message, and the two numeric answers.
async function feedback({ from = null, teams = [], kinds = [], message = null, quality = null, overall = null }) {
  const r = (await db.query(
    `INSERT INTO engagement.responses (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, surveyId, from])).rows[0];
  const ans = async (qid, { num = null, text = null, list = null }) => db.query(
    `INSERT INTO engagement.answers (response_id, question_id, value_num, value_text, value_list)
     VALUES ($1,$2,$3,$4,$5)`, [r.id, qid, num, text, list]);
  if (teams.length) await ans(qTeam, { list: teams });
  if (kinds.length) await ans(qKind, { list: kinds });
  if (message) await ans(qMsg, { text: message });
  if (quality != null) await ans(qQual, { num: quality });
  if (overall) await ans(qOverall, { text: overall });
  return r.id;
}

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-recognition';
  process.env.TENANT_SLUG = 'recognition-' + Date.now();
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

  const mk = async (name, email, dept) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,$2,$3,'active','Executive',$4) RETURNING id`, [t.id, name, email, dept])).rows[0].id;
  emp.qa = await mk('Q Tester', 'qa@x.com', 'Testing');
  emp.dev = await mk('D Dev', 'dev@x.com', 'Delivery');
  emp.recon = await mk('R Recon', 'recon@x.com', 'Recon');
  emp.nodept = await mk('N Nobody', 'nodept@x.com', null);
  for (const e of ['qa@x.com', 'dev@x.com', 'recon@x.com', 'nodept@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass', 10)]);
  }

  surveyId = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id, title, status, audience_kind, created_by)
     VALUES ($1,'Customer Feedback','open','self','hr@x.com') RETURNING id`, [t.id])).rows[0].id;
  const q = async (qtype, prompt, dimension) => (await db.query(
    `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, sort_order, dimension)
     VALUES ($1,$2,$3,$4,10,$5) RETURNING id`, [t.id, surveyId, qtype, prompt, dimension])).rows[0].id;
  qOverall = await q('choice', 'Overall satisfaction with the team', 'service_overall');
  qQual = await q('scale', 'Quality of service / deliverables', 'service_quality');
  qTeam = await q('multi', 'Which team would you like to recognise?', 'recognition_team');
  qKind = await q('multi', 'What would you like to appreciate?', 'recognition_kind');
  qMsg = await q('text', 'Add a short appreciation message', 'recognition_message');

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['qa', 'qa@x.com'], ['dev', 'dev@x.com'], ['recon', 'recon@x.com'], ['nodept', 'nodept@x.com']]) {
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

test('nothing submitted yet is an empty list, not an error', { skip }, async () => {
  const r = await get('/engagement/my/submissions', tok.qa);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.submissions, []);
});

test('an attributed submission comes back in full, in question order', { skip }, async () => {
  await feedback({ from: emp.qa, teams: ['Delivery'], kinds: ['Quick response', 'Quality of work'],
    message: 'Turned the settlement defect around over a weekend.', quality: 5, overall: 'Excellent' });

  const r = await get('/engagement/my/submissions', tok.qa);
  assert.equal(r.body.submissions.length, 1);
  const sub = r.body.submissions[0];
  assert.equal(sub.title, 'Customer Feedback');
  assert.ok(sub.submitted_at);

  const by = Object.fromEntries(sub.answers.map((a) => [a.prompt, a.value]));
  assert.equal(by['Overall satisfaction with the team'], 'Excellent');
  assert.strictEqual(by['Quality of service / deliverables'], 5, 'a number, not the string Postgres returns');
  assert.deepEqual(by['Which team would you like to recognise?'], ['Delivery']);
  assert.deepEqual(by['What would you like to appreciate?'], ['Quick response', 'Quality of work'],
    'a multi-select keeps every pick, in the order it was given');
  assert.equal(by['Add a short appreciation message'], 'Turned the settlement defect around over a weekend.');
});

test('THE ANONYMITY CASE: an anonymous answer cannot be read back, and that is the point',
  { skip }, async () => {
    // Stored with employee_id NULL. There is no key from this person to
    // these answers, so the route cannot and must not produce them.
    await feedback({ teams: ['Delivery'], kinds: ['Collaboration'], message: 'Quietly excellent.', quality: 4 });
    const r = await get('/engagement/my/submissions', tok.recon);
    assert.deepEqual(r.body.submissions, [],
      'an anonymous response must never be retrievable by its author — that is the guarantee, not a gap');
  });

test('one person never sees another person\'s submission', { skip }, async () => {
  await feedback({ from: emp.dev, teams: ['Testing'], kinds: ['Problem solving'], quality: 3 });
  const qa = await get('/engagement/my/submissions', tok.qa);
  assert.equal(qa.body.submissions.length, 1, "still only their own");
  const flat = JSON.stringify(qa.body);
  assert.ok(!flat.includes('Problem solving'), "the other person's answers are not in the payload at all");
});

test('a skipped question is absent, not silently rendered as answered', { skip }, async () => {
  // The page prints "not answered" for a missing value. That only works
  // if the API distinguishes a blank from a zero.
  await feedback({ from: emp.recon, teams: ['Delivery'], quality: 0 });
  const r = await get('/engagement/my/submissions', tok.recon);
  const sub = r.body.submissions[0];
  const quality = sub.answers.find((a) => a.prompt === 'Quality of service / deliverables');
  assert.strictEqual(quality.value, 0, 'zero is an answer and must survive as one');
  assert.ok(!sub.answers.some((a) => a.prompt === 'Add a short appreciation message'),
    'a question never answered simply is not there');
});

test('submissions are newest first', { skip }, async () => {
  const r = await get('/engagement/my/submissions', tok.qa);
  const times = r.body.submissions.map((s) => new Date(s.submitted_at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('another tenant\'s submissions never appear', { skip }, async () => {
  const other = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    ['sub-other-' + Date.now()])).rows[0].id;
  const os = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id, title, status, audience_kind, created_by)
     VALUES ($1,'Theirs','open','self','x@y.com') RETURNING id`, [other])).rows[0].id;
  // Same employee id, different tenant row — the shape that a missing
  // tenant filter would leak.
  await db.query(`INSERT INTO engagement.responses (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3)`,
    [other, os, emp.qa]);
  const r = await get('/engagement/my/submissions', tok.qa);
  assert.ok(!r.body.submissions.some((s) => s.title === 'Theirs'));
});

test('a template added to the library reaches a tenant that already has some', { skip }, async () => {
  // THE BUG THIS PREVENTS, found on 28 Sep by driving the new template
  // through the real flow rather than trusting its unit tests. It was
  // in the code, its own tests passed, and it was invisible on every
  // tenant that already had templates — which is all of them. The
  // guard was "does this tenant have ANY", so the first batch a tenant
  // received was also the last, and migrations cannot help because
  // they never run twice.
  const app = require('express')();
  app.use(require('express').json());
  app.use((rq, _rs, next) => { rq.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', require('../core/auth').devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  const srv = app.listen(0);
  try {
    const b = `http://localhost:${srv.address().port}/api/v1`;
    await db.query(`INSERT INTO core.user_permissions (tenant_id,email,permission)
                    VALUES ($1,'qa@x.com','engagement_admin') ON CONFLICT DO NOTHING`, [tenantId]);
    const t = (await (await fetch(`${b}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'qa@x.com', password: 'pass' }),
    })).json()).token;

    // Seed the library, then delete ONE key — the shape of "this
    // tenant has templates, but not the new one".
    await fetch(`${b}/engagement/templates`, { headers: { Authorization: `Bearer ${t}` } });
    await db.query(`DELETE FROM engagement.survey_templates WHERE tenant_id=$1 AND key='customer_feedback'`, [tenantId]);
    const before = (await (await fetch(`${b}/engagement/templates`,
      { headers: { Authorization: `Bearer ${t}` } })).json()).templates;
    assert.ok(before.some((x) => x.key === 'customer_feedback'),
      'the missing template must be seeded back, not skipped because others exist');
  } finally { srv.close(); }
});
