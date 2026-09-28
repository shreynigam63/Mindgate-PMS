// node --test — read a survey before releasing it.
//
// Asked for on 28 Sep, on a screenshot of the survey list: "provide
// option of viewing draft before opening the survey to employees."
//
// WHY THIS MATTERS ENOUGH TO TEST. Opening a survey is not reversible
// in the way that counts: it writes an invitation row per person and,
// on this instance, 1,426 in-app notifications. Until now the only way
// to read what those people would be asked was to open it and look.
//
// So the preview has to answer BOTH halves of the decision — what the
// questions are, and who they reach — and it has to answer the second
// one the same way `open` will, or it is a second implementation
// waiting to disagree with the first.
//
// Real Postgres, real HTTP, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, adminId, empIds = [];
const tok = {};
const req = async (method, path, t, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const mkSurvey = async (title, opts = {}) => {
  const s = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id, title, description, status, audience_kind, created_by)
     VALUES ($1,$2,$3,'draft','self',$4) RETURNING id`,
    [tenantId, title, opts.description || null, 'admin@x.com'])).rows[0];
  let n = 0;
  for (const q of opts.questions || []) {
    await db.query(
      `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tenantId, s.id, q.qtype, q.prompt, q.options ? JSON.stringify(q.options) : null, !!q.required, ++n * 10]);
  }
  return s.id;
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-survey-preview';
  process.env.TENANT_SLUG = 'survey-preview-' + Date.now();
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

  const mk = async (name, email) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,date_of_joining)
     VALUES ($1,$2,$3,'active','Executive','Delivery','2023-01-01') RETURNING id`,
    [t.id, name, email])).rows[0].id;
  adminId = await mk('P Admin', 'admin@x.com');
  for (const n of ['P One', 'P Two', 'P Three']) empIds.push(await mk(n, `${n.split(' ')[1].toLowerCase()}@x.com`));
  for (const e of ['admin@x.com', 'one@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_permissions (tenant_id,email,permission) VALUES ($1,'admin@x.com','engagement_admin')
                  ON CONFLICT DO NOTHING`, [t.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['admin', 'admin@x.com'], ['emp', 'one@x.com']]) {
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

test('a draft can be read in full without being opened', { skip }, async () => {
  const id = await mkSurvey('Pulse', {
    description: 'How this quarter is going',
    questions: [
      { qtype: 'scale', prompt: 'I have what I need to do my job', required: true },
      { qtype: 'choice', prompt: 'What is blocking you?', options: ['Tooling', 'Clarity', 'Nothing'] },
      { qtype: 'text', prompt: 'Anything else?' },
    ],
  });
  const r = await req('GET', `/engagement/surveys/${id}/preview`, tok.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.survey.status, 'draft');
  assert.deepEqual(r.body.questions.map((q) => q.prompt),
    ['I have what I need to do my job', 'What is blocking you?', 'Anything else?'],
    'in the order the employee meets them');
  assert.deepEqual(r.body.questions[1].options, ['Tooling', 'Clarity', 'Nothing'],
    'with the options they will actually see — a preview that hides these cannot catch a wrong list');
  assert.equal(r.body.questions[0].required, true);

  // AND NOTHING WAS SENT. This is the whole point.
  const inv = await db.query(`SELECT COUNT(*)::int c FROM engagement.invitations WHERE survey_id=$1`, [id]);
  assert.equal(inv.rows[0].c, 0, 'previewing must not invite anybody');
  const st = await db.query(`SELECT status FROM engagement.surveys WHERE id=$1`, [id]);
  assert.equal(st.rows[0].status, 'draft', 'and must not change the status');
});

test('it says who it would reach, counted the same way open counts', { skip }, async () => {
  const id = await mkSurvey('Reach', { questions: [{ qtype: 'scale', prompt: 'Fine?' }] });
  const p = await req('GET', `/engagement/surveys/${id}/preview`, tok.admin);
  assert.equal(p.body.audience.count, 4, 'four active employees on this tenant');
  assert.ok(p.body.audience.description, 'and says in words who that is');

  // THE GUARANTEE: the preview's number is the number open actually
  // invites. Two different counts would be worse than no preview.
  const o = await req('POST', `/engagement/surveys/${id}/open`, tok.admin);
  assert.equal(o.status, 200);
  assert.equal(o.body.invited, p.body.audience.count,
    'the preview promised a number and open must honour it');
});

test('the two reasons open would refuse are named BEFORE it is pressed', { skip }, async () => {
  // No questions — open 422s on this, and a preview that did not say so
  // would send HR to a button that rejects them.
  const empty = await mkSurvey('Empty');
  const a = await req('GET', `/engagement/surveys/${empty}/preview`, tok.admin);
  assert.ok(a.body.blockers.some((b) => /No questions/i.test(b)), a.body.blockers.join(' | '));
  const refused = await req('POST', `/engagement/surveys/${empty}/open`, tok.admin);
  assert.equal(refused.status, 422, 'and the blocker was telling the truth about what open does');

  // A rule nobody matches. Opening it is legal and useless.
  const nobody = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id, title, status, audience_kind, audience_rule, created_by)
     VALUES ($1,'Nobody','draft','self',$2,'admin@x.com') RETURNING id`,
    [tenantId, JSON.stringify({ departments: ['Department That Does Not Exist'] })])).rows[0].id;
  await db.query(`INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, sort_order)
                  VALUES ($1,$2,'scale','Fine?',10)`, [tenantId, nobody]);
  const b = await req('GET', `/engagement/surveys/${nobody}/preview`, tok.admin);
  assert.equal(b.body.audience.count, 0);
  assert.ok(b.body.blockers.some((x) => /Nobody matches/i.test(x)), b.body.blockers.join(' | '));
});

test('a broken audience rule does not take the questions down with it', { skip }, async () => {
  // Reading the survey is the point; the count is the bonus. If
  // resolving the audience throws, the preview must still show what
  // would be asked and say plainly that the count failed.
  const id = await mkSurvey('Odd', { questions: [{ qtype: 'scale', prompt: 'Still readable?' }] });
  await db.query(`UPDATE engagement.surveys SET audience_rule=$2 WHERE id=$1`,
    [id, JSON.stringify({ manager_ids: ['not-a-uuid'] })]);
  const r = await req('GET', `/engagement/surveys/${id}/preview`, tok.admin);
  assert.equal(r.status, 200, 'a bad rule is not a 500');
  assert.equal(r.body.questions.length, 1, 'the questions still come back');
  assert.equal(r.body.questions[0].prompt, 'Still readable?');
});

test('preview is HR-only, like every other admin view of a survey', { skip }, async () => {
  const id = await mkSurvey('Private', { questions: [{ qtype: 'scale', prompt: 'Secret?' }] });
  const r = await req('GET', `/engagement/surveys/${id}/preview`, tok.emp);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /engagement_admin/);
});

test('an open survey can be read too — "what did we ask them?"', { skip }, async () => {
  const id = await mkSurvey('Live', { questions: [{ qtype: 'enps', prompt: 'Recommend us?' }] });
  await req('POST', `/engagement/surveys/${id}/open`, tok.admin);
  const r = await req('GET', `/engagement/surveys/${id}/preview`, tok.admin);
  assert.equal(r.status, 200);
  assert.equal(r.body.survey.status, 'open');
  assert.equal(r.body.questions[0].prompt, 'Recommend us?');
  assert.ok(r.body.already_invited > 0, 'and says how many are already invited, so a re-open is not a surprise');
  assert.deepEqual(r.body.blockers, [], 'a live survey with questions and an audience has nothing blocking it');
});

test('a survey from another tenant is not found, not leaked', { skip }, async () => {
  const other = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    ['sp-other-' + Date.now()])).rows[0].id;
  const id = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id, title, status, audience_kind, created_by)
     VALUES ($1,'Theirs','draft','self','x@y.com') RETURNING id`, [other])).rows[0].id;
  const r = await req('GET', `/engagement/surveys/${id}/preview`, tok.admin);
  assert.equal(r.status, 404);
});
