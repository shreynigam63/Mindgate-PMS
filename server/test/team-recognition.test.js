// node --test — the kudos a team received, on the team's own My KRAs.
//
// Step three of the Customer Feedback flow asked for on 28 Sep: HR
// creates the form under Engagement Surveys, it reaches the employee's
// home page, and what it produces "will be displayed on My KRAs page"
// — confirmed as the recognition a person's OWN TEAM received, not a
// receipt of what they submitted.
//
// The thing that can silently go wrong here is the join. "Your team" is
// the caller's department on the employee master, and the recognition
// names a team as free-ish text chosen from a list. If those two ever
// stop being the same strings, every panel in the company goes blank
// and nothing errors. That is what most of these tests are about.
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

test('nobody thanked yet: an honest empty, not a zeroed panel', { skip }, async () => {
  const r = await get('/engagement/my/recognition', tok.qa);
  assert.equal(r.status, 200);
  assert.equal(r.body.responses, 0);
  assert.deepEqual(r.body.kudos, []);
  assert.equal(r.body.department, 'Testing', 'it still says whose team it was looking for');
});

test('kudos reach the team they name, and only that team', { skip }, async () => {
  await feedback({ from: emp.recon, teams: ['Testing'], kinds: ['Quick response', 'Quality of work'],
    message: 'Turned the settlement defect around over a weekend.', quality: 5, overall: 'Excellent' });
  await feedback({ from: emp.dev, teams: ['Testing'], kinds: ['Quick response'], quality: 4 });
  // Aimed at somebody else entirely.
  await feedback({ from: emp.recon, teams: ['Delivery'], kinds: ['Collaboration'], quality: 2 });

  const qa = (await get('/engagement/my/recognition', tok.qa)).body;
  assert.equal(qa.responses, 2, 'the Delivery one is not theirs');
  assert.deepEqual(qa.kudos, [
    { kind: 'Quick response', count: 2 },
    { kind: 'Quality of work', count: 1 },
  ], 'tallied, biggest first — the point of a closed list');
  assert.equal(qa.avg_service, 4.5);

  const dev = (await get('/engagement/my/recognition', tok.dev)).body;
  assert.equal(dev.responses, 1);
  assert.equal(dev.avg_service, 2, "and Delivery's 2 does not leak into Testing's average");
});

test('THE JOIN: a team named with different spacing or case still lands', { skip }, async () => {
  // HR is allowed to edit the options. "  testing " must not silently
  // empty every panel in the department.
  await feedback({ from: emp.dev, teams: ['  testing '], kinds: ['Collaboration'], quality: 5 });
  const qa = (await get('/engagement/my/recognition', tok.qa)).body;
  assert.equal(qa.responses, 3, 'trimmed and case-folded on both sides');
  assert.ok(qa.kudos.some((k) => k.kind === 'Collaboration'));
});

test('one response naming two teams counts for both', { skip }, async () => {
  const before = (await get('/engagement/my/recognition', tok.dev)).body.responses;
  await feedback({ from: emp.recon, teams: ['Testing', 'Delivery'], kinds: ['Going above & beyond'], quality: 4 });
  const dev = (await get('/engagement/my/recognition', tok.dev)).body;
  assert.equal(dev.responses, before + 1, 'a multi-select is not a single choice');
});

test('an attributed message names its sender; an anonymous one does not', { skip }, async () => {
  await feedback({ teams: ['Recon'], message: 'Quietly excellent all quarter.', quality: 5 });
  await feedback({ from: emp.qa, teams: ['Recon'], message: 'Always answer first time.', quality: 4 });

  const recon = (await get('/engagement/my/recognition', tok.recon)).body;
  const named = recon.messages.find((m) => m.text === 'Always answer first time.');
  const anon = recon.messages.find((m) => m.text === 'Quietly excellent all quarter.');
  assert.equal(named.from_name, 'Q Tester');
  assert.equal(named.from_department, 'Testing', 'who said it, and from where — that is what makes kudos land');
  // Anonymity is structural: the response carries no identity, so
  // there is nothing here to withhold in the first place.
  assert.equal(anon.from_name, null);
});

test('somebody with no department is told why, not shown an empty box', { skip }, async () => {
  const r = await get('/engagement/my/recognition', tok.nodept);
  assert.equal(r.status, 200);
  assert.equal(r.body.department, null);
  assert.equal(r.body.reason, 'no_department',
    'the page needs to be able to say why rather than render a blank panel');
});

test('ratings are grouped per dimension, not averaged into one number', { skip }, async () => {
  const qa = (await get('/engagement/my/recognition', tok.qa)).body;
  const quality = qa.ratings.find((x) => x.dimension === 'service_quality');
  assert.ok(quality, 'the dimension, not the wording, is what it is keyed on');
  assert.equal(quality.label, 'Quality of service / deliverables');
  assert.ok(quality.n >= 3);
});

test('READ BY DIMENSION: rewording a question does not break the panel', { skip }, async () => {
  // HR is explicitly allowed to edit these. Matching on prompts would
  // break the panel the first time they did, and break it silently.
  const before = (await get('/engagement/my/recognition', tok.qa)).body;
  await db.query(`UPDATE engagement.questions SET prompt='Kudos — who deserves it?' WHERE id=$1`, [qKind]);
  await db.query(`UPDATE engagement.questions SET prompt='Which crew helped you out?' WHERE id=$1`, [qTeam]);
  try {
    const after = (await get('/engagement/my/recognition', tok.qa)).body;
    assert.equal(after.responses, before.responses);
    assert.deepEqual(after.kudos, before.kudos);
  } finally {
    await db.query(`UPDATE engagement.questions SET prompt='What would you like to appreciate?' WHERE id=$1`, [qKind]);
    await db.query(`UPDATE engagement.questions SET prompt='Which team would you like to recognise?' WHERE id=$1`, [qTeam]);
  }
});

test('another tenant\'s kudos never appear', { skip }, async () => {
  const other = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    ['rec-other-' + Date.now()])).rows[0].id;
  const os = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id, title, status, audience_kind, created_by)
     VALUES ($1,'Theirs','open','self','x@y.com') RETURNING id`, [other])).rows[0].id;
  const oq = (await db.query(
    `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, sort_order, dimension)
     VALUES ($1,$2,'multi','Which team?',10,'recognition_team') RETURNING id`, [other, os])).rows[0].id;
  const orr = (await db.query(
    `INSERT INTO engagement.responses (tenant_id, survey_id) VALUES ($1,$2) RETURNING id`, [other, os])).rows[0].id;
  await db.query(`INSERT INTO engagement.answers (response_id, question_id, value_list) VALUES ($1,$2,$3)`,
    [orr, oq, ['Testing']]);

  const before = 3 + 1; // the Testing responses created above
  const qa = (await get('/engagement/my/recognition', tok.qa)).body;
  assert.equal(qa.responses, before, "another tenant also has a 'Testing' team; it must not count here");

  // HONEST NOTE ON WHAT THIS PROVES. The isolation comes from scoping
  // the QUESTIONS to the tenant — another tenant's recognition_team
  // question is never selected, so its answers are never reached. The
  // `r.tenant_id=$1` clause beside it is the house rule's belt and
  // braces (tenant_id in every WHERE) and is NOT exercised by this
  // test: removing it alone leaves this passing. It is kept because
  // the convention is worth more than the line, not because anything
  // here would catch its removal.
});
