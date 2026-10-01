// Importing reviews from AmbitionBox, Glassdoor and the rest.
//
// There is no feed to connect: Glassdoor retired its public review API in
// 2021, AmbitionBox has never published one, and both prohibit scraping.
// So this is a spreadsheet HR pastes into — and the things worth pinning
// are the ones that make the difference between a useful import and a
// quietly wrong one.
//
//   * No row is ever attributed to a person. Reviews on those sites are
//     anonymous by design, and a stored guess about who wrote one would
//     be a fact invented about somebody who chose anonymity.
//   * A bad row is named with its reason, not dropped. "4 loaded" out of
//     six, with nothing saying what happened to the other two, is how an
//     importer loses trust.
//   * It refuses a survey real people are taking. Fabricated answers
//     beside genuine ones cannot be told apart afterwards.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'review-import-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');
const { seedTemplates } = require('../migrations/056-survey-templates');

const SLUG = `xri-test-${Date.now()}`;
let server; let base; let tenantId; let hrTok; let reviewSurveyId; let normalSurveyId;

const post = async (path, csv) => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'reviews.csv');
  const r = await fetch(`${base}/api/v1/engagement${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${hrTok}` }, body: fd,
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};

const HEAD = 'Site,Review date,Rating,Recommends,Employment,Pros,Cons,Role or department';

before(async () => {
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  await db.query(`INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'HR One','xr-hr@x.com','active')`, [tenantId]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'xr-hr@x.com','hr')`, [tenantId]);
  await db.query(
    `INSERT INTO core.role_permissions (tenant_id,role,permission)
     VALUES ($1,'hr','engagement_admin'),($1,'hr','pms_admin'),($1,'hr','pms_self') ON CONFLICT DO NOTHING`, [tenantId]);
  await seedTemplates(db, tenantId);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'xr-hr@x.com',$2)`,
    [tenantId, await bcrypt.hash('pw', 4)]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  hrTok = (await (await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'xr-hr@x.com', password: 'pw' }),
  })).json()).token;
  assert.ok(hrTok, 'the test login has to work');

  const made = await (await fetch(`${base}/api/v1/engagement/templates/external_review/use`, {
    method: 'POST', headers: { Authorization: `Bearer ${hrTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  reviewSurveyId = made.survey.id;
  assert.ok(reviewSurveyId, `the template has to be in the library: ${JSON.stringify(made).slice(0, 200)}`);

  normalSurveyId = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id,title,survey_type,status,anonymity_default)
     VALUES ($1,'A real survey','pulse','open',true) RETURNING id`, [tenantId])).rows[0].id;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    await db.query(`DELETE FROM engagement.answers WHERE response_id IN
      (SELECT id FROM engagement.responses WHERE tenant_id=$1)`, [tenantId]).catch(() => {});
    for (const t of ['engagement.responses', 'engagement.questions', 'engagement.invitations',
      'engagement.surveys', 'engagement.survey_templates', 'core.local_credentials',
      'core.user_roles', 'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('REVIEWS LOAD, AND EVERY BAD ROW IS NAMED WITH ITS REASON', async () => {
  const csv = [HEAD,
    'Glassdoor,2026-09-14,4,Yes,Current employee,Good people.,Appraisals unclear.,Engineer',
    'AmbitionBox,2026-08-02,3,No,Former employee,Decent learning.,Long hours.,QA',
    'AmbitionBox,2026-07-19,5,Yes,Current employee,Strong tech culture.,Canteen.,Cloud',
    'Indeed,,2,Not stated,Former employee,Nothing much.,Communication.,Support',
    'Facebook,2026-01-01,4,Yes,Current employee,x,y,z',
    'Glassdoor,2026-06-01,9,Yes,Current employee,a,b,c',
    'Glassdoor,2026-06-02,not-a-date-test,Yes,Current employee,a,b,c',
  ].join('\n');
  const r = await post(`/surveys/${reviewSurveyId}/import`, csv);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.loaded, 4);
  assert.equal(r.body.rejected.length, 3);
  assert.match(r.body.rejected[0].reason, /"Facebook" is not one of/);
  assert.match(r.body.rejected[1].reason, /rating "9" is not a number from 1 to 5/);
  assert.match(r.body.rejected[2].reason, /is not a number from 1 to 5/);
  for (const x of r.body.rejected) assert.ok(x.row > 0, 'a rejection has to say which line');
});

test('NOTHING IMPORTED IS ATTRIBUTED TO ANYBODY', async () => {
  // The rule the whole feature rests on. A row claiming to know who wrote
  // an anonymous public review would be a guess stored as a fact.
  const rows = (await db.query(
    `SELECT employee_id FROM engagement.responses WHERE survey_id=$1`, [reviewSurveyId])).rows;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.employee_id === null), 'an imported review was tied to an employee');
});

test('the answers land where the results can read them', async () => {
  const r = await (await fetch(`${base}/api/v1/engagement/surveys/${reviewSurveyId}/results`,
    { headers: { Authorization: `Bearer ${hrTok}` } })).json();
  const rating = r.questions.find((q) => /Overall rating/.test(q.prompt));
  assert.equal(rating.n, 4);
  assert.equal(rating.average, 3.5, 'ratings 4, 3, 5 and 2 average 3.5');
  const site = r.questions.find((q) => /Which site/.test(q.prompt));
  assert.equal(site.tally.find((x) => x.option === 'AmbitionBox').count, 2);
  const pros = r.questions.find((q) => /said was good/.test(q.prompt));
  assert.ok(pros.verbatims.some((v) => /Strong tech culture/.test(v)));
});

test('IT REFUSES A SURVEY REAL PEOPLE ARE ANSWERING', async () => {
  // Fabricated rows beside genuine ones cannot be separated afterwards,
  // and every average built on them would be wrong without saying so.
  const r = await post(`/surveys/${normalSurveyId}/import`, `${HEAD}\nGlassdoor,2026-09-14,4,Yes,Current employee,a,b,c`);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /only be imported into an "External reviews" survey/);
});

test('a file with the wrong headers is told which column is missing', async () => {
  const r = await post(`/surveys/${reviewSurveyId}/import`, 'Website,Stars\nGlassdoor,4');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /missing "Site"/);
  assert.ok(Array.isArray(r.body.headers_found), 'and shows what it did find, so the fix is obvious');
});

test('an empty file is refused rather than reported as a successful import of nothing', async () => {
  const r = await post(`/surveys/${reviewSurveyId}/import`, '');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /no rows/);
});

test('OPENING AN IMPORT-ONLY SURVEY INVITES NOBODY', async () => {
  // WHY THIS TEST EXISTS. Opening this survey on the client's instance
  // invited all 1,427 employees, because Open has always meant "work out
  // the audience and invite it" and the template's own description
  // saying nobody answers it is not something code reads. The
  // invitations and the notifications they produced had to be deleted by
  // hand. A description is not a control; this is.
  for (let i = 1; i <= 3; i++) {
    await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,$2,$3,'active')`,
      [tenantId, `Body ${i}`, `xr-body${i}@x.com`]);
  }
  const r = await (await fetch(`${base}/api/v1/engagement/surveys/${reviewSurveyId}/open`, {
    method: 'POST', headers: { Authorization: `Bearer ${hrTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  assert.equal(r.invited, 0, 'it invited somebody to a survey nobody can answer');
  assert.equal(r.import_only, true);
  assert.match(r.note, /Nobody has been invited/);
  const n = (await db.query(
    `SELECT count(*)::int n FROM engagement.invitations WHERE survey_id=$1`, [reviewSurveyId])).rows[0].n;
  assert.equal(n, 0, 'invitation rows were written anyway');
  // It IS open — that is what makes the results readable.
  const st = (await db.query(`SELECT status FROM engagement.surveys WHERE id=$1`, [reviewSurveyId])).rows[0].status;
  assert.equal(st, 'open');
});

test('and an ordinary survey still invites its audience', async () => {
  // The guard has to be about THIS survey, not about opening in general.
  await db.query(
    `INSERT INTO engagement.questions (tenant_id,survey_id,qtype,prompt,sort_order)
     VALUES ($1,$2,'scale','Are you happy here?',10)`, [tenantId, normalSurveyId]);
  const r = await (await fetch(`${base}/api/v1/engagement/surveys/${normalSurveyId}/open`, {
    method: 'POST', headers: { Authorization: `Bearer ${hrTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  assert.ok(r.invited > 0, `an ordinary survey invited nobody: ${JSON.stringify(r)}`);
});

test('a file of nothing but bad rows writes nothing at all', async () => {
  const before = (await db.query(`SELECT count(*)::int n FROM engagement.responses WHERE survey_id=$1`, [reviewSurveyId])).rows[0].n;
  const r = await post(`/surveys/${reviewSurveyId}/import`, `${HEAD}\nMySpace,2026-01-01,4,Yes,Current employee,a,b,c`);
  assert.equal(r.status, 422);
  const after = (await db.query(`SELECT count(*)::int n FROM engagement.responses WHERE survey_id=$1`, [reviewSurveyId])).rows[0].n;
  assert.equal(after, before, 'a refused import still wrote something');
});
