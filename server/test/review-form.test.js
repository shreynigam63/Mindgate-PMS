// node --test — Mindgate's own PMS form, on the Mid-Year Review.
//
// Asked for on 28 Sep with the workbook attached ("PMS_Form.xlsx") and a
// screenshot of the Mid-Year Review page: "Please find attached
// screenshot and headers on PMS form in mid-year review."
//
// The workbook is 53 columns of their live Google Form. Migration 061
// says which of them this product already covered and which it did not;
// what these tests pin is the part that is new — the sections are data,
// an answer is checked against the question it claims to answer, and a
// required question actually stops a signature.
//
// The pure half needs no database and runs anywhere. The HTTP half
// skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const rf = require('../modules/performance/review-form');

const SCALE = [
  { value: 1, label: 'Needs Improvement' }, { value: 2, label: 'Developing' },
  { value: 3, label: 'Meets Expectations' }, { value: 4, label: 'Exceeds' },
  { value: 5, label: 'Outstanding' },
];

// ---- pure ----------------------------------------------------------------

test('a rating is only accepted if it is ON the cycle scale', () => {
  const q = { id: 'q1', label: 'Go Getter', kind: 'rating' };
  assert.equal(rf.validateAnswer(q, { rating: 4 }, SCALE).rating, 4);
  // 4.5 is between two points. Nobody awarded it, so it is not a rating.
  const bad = rf.validateAnswer(q, { rating: 4.5 }, SCALE);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /4 \(Exceeds\)/, 'the refusal lists what IS allowed');
  assert.equal(rf.validateAnswer(q, { rating: 9 }, SCALE).ok, false);
  // Blank is not an error — most of this form is optional.
  assert.deepEqual(rf.validateAnswer(q, { rating: '' }, SCALE), { ok: true, rating: null, answer_text: null });
});

test('yes_no takes yes or no, in any case, and nothing else', () => {
  const q = { id: 'q2', label: 'Are you handling Team?', kind: 'yes_no' };
  assert.equal(rf.validateAnswer(q, { answer_text: 'Yes' }, SCALE).answer_text, 'yes');
  assert.equal(rf.validateAnswer(q, { answer_text: 'NO' }, SCALE).answer_text, 'no');
  assert.equal(rf.validateAnswer(q, { answer_text: 'maybe' }, SCALE).ok, false);
});

test('a text answer is trimmed, and a paste is refused rather than truncated', () => {
  const q = { id: 'q3', label: 'Technology Used', kind: 'text' };
  assert.equal(rf.validateAnswer(q, { answer_text: '  Java, Kafka  ' }, SCALE).answer_text, 'Java, Kafka');
  // Whitespace is not an answer.
  assert.equal(rf.validateAnswer(q, { answer_text: '   ' }, SCALE).answer_text, null);
  // Silently cutting the end off what somebody wrote about their own
  // appraisal is not an acceptable way to fail.
  const long = rf.validateAnswer(q, { answer_text: 'x'.repeat(4001) }, SCALE);
  assert.equal(long.ok, false);
  assert.match(long.reason, /4000/);
});

test('an answer to a question that is not on the form is refused, not ignored', () => {
  // A stale browser tab posting a question HR has since removed must be
  // told, not quietly dropped — the person would think it saved.
  const m = rf.mergeAnswers({ questions: [{ id: 'q1', label: 'A', kind: 'text' }], incoming: { 'gone': { answer_text: 'x' } }, scale: SCALE });
  assert.equal(m.ok, false);
  assert.equal(m.writes.length, 0);
  assert.equal(m.errors[0].question_id, 'gone');
});

test('every bad answer is named, not just the first', () => {
  // Fifteen questions refused one at a time is fifteen round trips.
  const questions = [
    { id: 'a', label: 'Go Getter', kind: 'rating' },
    { id: 'b', label: 'Passion', kind: 'rating' },
    { id: 'c', label: 'Technology Used', kind: 'text' },
  ];
  const m = rf.mergeAnswers({ questions, incoming: {
    a: { rating: 9 }, b: { rating: 7 }, c: { answer_text: 'Java' },
  }, scale: SCALE });
  assert.equal(m.ok, false);
  assert.deepEqual(m.errors.map((e) => e.label).sort(), ['Go Getter', 'Passion']);
  assert.deepEqual(m.writes, [{ question_id: 'c', rating: null, answer_text: 'Java' }],
    'the good answer is still reported — the caller decides what to do with a partial set');
});

test('only the questions SENT are written', () => {
  // The page can save one section without blanking the other four.
  const questions = [
    { id: 'a', label: 'A', kind: 'text' }, { id: 'b', label: 'B', kind: 'text' },
  ];
  const m = rf.mergeAnswers({ questions, incoming: { a: { answer_text: 'kept' } }, scale: SCALE });
  assert.deepEqual(m.writes.map((w) => w.question_id), ['a']);
});

test('a required question is missing until it is actually answered', () => {
  const questions = [
    { id: 'a', label: 'Total Years of Experience', kind: 'text', required: true },
    { id: 'b', label: 'Go Getter', kind: 'rating', required: true },
    { id: 'c', label: 'Passion', kind: 'rating', required: false },
  ];
  assert.deepEqual(rf.missingRequired(questions, []), ['Total Years of Experience', 'Go Getter']);
  // Whitespace does not count.
  assert.deepEqual(rf.missingRequired(questions, [{ question_id: 'a', answer_text: '  ' }]),
    ['Total Years of Experience', 'Go Getter']);
  assert.deepEqual(rf.missingRequired(questions, [
    { question_id: 'a', answer_text: '9 years' }, { question_id: 'b', rating: 3 },
  ]), []);
  // A rating of 0 is an answer. `!a.rating` would call it a blank.
  assert.deepEqual(rf.missingRequired([{ id: 'b', label: 'Go Getter', kind: 'rating', required: true }],
    [{ question_id: 'b', rating: 0 }]), []);
});

test('assemble reads in form order, and drops what is switched off', () => {
  const sections = [
    { id: 's2', title: 'Second', sort_order: 20, active: true },
    { id: 's1', title: 'First', sort_order: 10, active: true },
    { id: 's3', title: 'Retired', sort_order: 30, active: false },
    { id: 's4', title: 'Emptied', sort_order: 40, active: true },
  ];
  const questions = [
    { id: 'q2', section_id: 's1', label: 'Second question', kind: 'text', sort_order: 20, active: true },
    { id: 'q1', section_id: 's1', label: 'First question', kind: 'text', sort_order: 10, active: true },
    { id: 'q3', section_id: 's2', label: 'Rating', kind: 'rating', sort_order: 10, active: true },
    { id: 'q4', section_id: 's4', label: 'Switched off', kind: 'text', sort_order: 10, active: false },
  ];
  const out = rf.assemble({ sections, questions, answers: [{ question_id: 'q3', rating: '4' }] });
  assert.deepEqual(out.map((s) => s.title), ['First', 'Second'],
    'sorted by sort_order; an inactive section and one with no live questions are both gone');
  assert.deepEqual(out[0].questions.map((q) => q.label), ['First question', 'Second question']);
  assert.strictEqual(out[1].questions[0].rating, 4, 'numeric, not the string Postgres hands back');
});

// ---- over HTTP -----------------------------------------------------------

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, sheetId;
const tok = {};
const req = async (method, path, t, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const qid = (form, label) => {
  for (const s of form) for (const q of s.questions) if (q.label === label) return q.id;
  throw new Error(`no question called ${label}`);
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-review-form';
  process.env.TENANT_SLUG = 'review-form-' + Date.now();
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
  // The form is seeded per tenant by 061, which ran before this tenant
  // existed — so seed this one the same way the migration does.
  await require('../migrations/061-review-form').up(db);

  const mk = async (name, email, managerId) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id,emp_code,date_of_joining)
     VALUES ($1,$2,$3,'active','Executive','Delivery',$4,$5,'2021-06-01') RETURNING id`,
    [t.id, name, email, managerId || null, email.split('@')[0].toUpperCase()])).rows[0].id;
  mgrId = await mk('F Manager', 'f-mgr@x.com', null);
  empId = await mk('F Employee', 'f-emp@x.com', mgrId);
  for (const e of ['f-mgr@x.com', 'f-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Delivery',$2)
                  ON CONFLICT DO NOTHING`, [t.id, mgrId]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase,rating_scale)
     VALUES ($1,'FY26','FY26','annual','mid_year_review',$2) RETURNING id`,
    [t.id, JSON.stringify(SCALE)])).rows[0].id;
  sheetId = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'approved') RETURNING id`, [t.id, cycleId, empId, mgrId])).rows[0].id;
  await db.query(`INSERT INTO pms.kras (tenant_id,sheet_id,title,weight,sort_order) VALUES ($1,$2,'Delivery',100,1)`, [t.id, sheetId]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['mgr', 'f-mgr@x.com'], ['emp', 'f-emp@x.com']]) {
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

test('the whole of their form is there, in their words', { skip }, async () => {
  const r = await req('GET', '/pms/my/midyear-review', tok.emp);
  assert.equal(r.status, 200);
  const titles = r.body.form.map((s) => s.title);
  assert.deepEqual(titles,
    ['About you', 'Attitude & Drive', 'Discipline & Quality', 'Learning & Training', 'Team & Capability Building']);
  const labels = r.body.form.flatMap((s) => s.questions.map((q) => q.label));
  // Spot-checked against PMS_Form.xlsx verbatim, including the tool name
  // and the years, which are theirs and not to be tidied up here.
  for (const l of ['Go Getter', 'Availability during critical deliverables', 'Customer Focus',
    'Ability to Handle Pressure', 'Passion', 'Adherence to Timelines', 'Adherence to Process',
    'Adherence to Org Policies', 'Support org Initiatives (Zoho / Hiring)', 'Quality Focus',
    'Training attended year 2024-2025', 'Training Required for 2025-2026', 'Are you handling Team?',
    'Mentoring and Grooming within Team', 'No Dependencies, backups created',
    'Create Knowledge repositories / documents', 'System rather than people focus',
    'Contribute towards capability building initiatives']) {
    assert.ok(labels.includes(l), `the form lost "${l}"`);
  }
  assert.equal(labels.length, 20);
});

test('what is already on record is never asked for again', { skip }, async () => {
  // Eleven of their 53 columns are identity. Re-typing your own employee
  // code into an appraisal is how a form earns a bad reputation, so none
  // of them is a question here.
  //
  // They were briefly SHOWN at the top of the page as an "On record"
  // block. Mindgate asked for that block to go on 28 Sep ("exclude
  // this"), so the page no longer displays them and the API no longer
  // sends them — but they must not come back as questions either, which
  // is what this pins.
  const r = await req('GET', '/pms/my/midyear-review', tok.emp);
  const labels = r.body.form.flatMap((s) => s.questions.map((q) => q.label));
  for (const asked of ['Employee Name', 'Employee Code', 'Date of Joining',
    'Reporting Manager :', 'Email ID of Reporting Manager', 'Delivery Head', 'Designation']) {
    assert.ok(!labels.includes(asked), `"${asked}" is on the employee record and must not be a question`);
  }
  assert.equal(r.body.profile, undefined, 'and the payload does not carry what no screen shows');

  // The two the master genuinely cannot answer ARE questions.
  assert.ok(labels.includes('Total Years of Experience'));
  assert.ok(labels.includes('Technology Used'));
});

test('answers save, come back, and a bad one is refused by name', { skip }, async () => {
  const form = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form;
  const ok = await req('PUT', '/pms/my/midyear-review/form', tok.emp, {
    answers: {
      [qid(form, 'Total Years of Experience')]: { answer_text: '9 years' },
      [qid(form, 'Go Getter')]: { rating: 4 },
      [qid(form, 'Are you handling Team?')]: { answer_text: 'yes' },
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.saved, 3);

  const back = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form;
  const find = (label) => back.flatMap((s) => s.questions).find((q) => q.label === label);
  assert.equal(find('Total Years of Experience').answer_text, '9 years');
  assert.equal(find('Go Getter').rating, 4);
  assert.equal(find('Are you handling Team?').answer_text, 'yes');

  const bad = await req('PUT', '/pms/my/midyear-review/form', tok.emp, {
    answers: { [qid(form, 'Passion')]: { rating: 9 } },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.rejected[0].label, 'Passion');
  assert.match(bad.body.rejected[0].reason, /Outstanding/);

  // And the refusal wrote nothing.
  const after = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form;
  assert.equal(after.flatMap((s) => s.questions).find((q) => q.label === 'Passion').rating, null);
});

test('saving one section does not blank the others', { skip }, async () => {
  const form = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form;
  await req('PUT', '/pms/my/midyear-review/form', tok.emp, {
    answers: { [qid(form, 'Quality Focus')]: { rating: 5 } },
  });
  const back = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form.flatMap((s) => s.questions);
  assert.equal(back.find((q) => q.label === 'Quality Focus').rating, 5);
  assert.equal(back.find((q) => q.label === 'Go Getter').rating, 4, 'the earlier section survived');
  assert.equal(back.find((q) => q.label === 'Total Years of Experience').answer_text, '9 years');
});

test('a required question stops the signature, by name', { skip }, async () => {
  // Clear the one required answer and rate the KRA, so the ONLY thing
  // standing between this person and a signature is the form.
  await db.query(`DELETE FROM pms.review_form_answers a USING pms.review_form_questions q
                   WHERE a.question_id=q.id AND q.label='Total Years of Experience'
                     AND a.tenant_id=$1 AND a.employee_id=$2`, [tenantId, empId]);
  const kra = (await db.query(`SELECT id FROM pms.kras WHERE sheet_id=$1`, [sheetId])).rows[0].id;
  await req('PUT', '/pms/my/midyear-review', tok.emp, {
    entries: { [kra]: { rating: 4, narrative: 'went well' } }, self_narrative: 'A good half.',
  });

  const refused = await req('POST', '/pms/my/midyear-review/submit', tok.emp);
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /Total Years of Experience/,
    'it names the question — "one answer missing" sends somebody hunting through five sections');

  const form = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form;
  await req('PUT', '/pms/my/midyear-review/form', tok.emp, {
    answers: { [qid(form, 'Total Years of Experience')]: { answer_text: '9 years' } },
  });
  const signed = await req('POST', '/pms/my/midyear-review/submit', tok.emp);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
});

test('a signed review is closed to further answers', { skip }, async () => {
  const form = (await req('GET', '/pms/my/midyear-review', tok.emp)).body.form;
  const r = await req('PUT', '/pms/my/midyear-review/form', tok.emp, {
    answers: { [qid(form, 'Passion')]: { rating: 5 } },
  });
  assert.equal(r.status, 409, 'the form obeys the same lock as the rest of the review');
});

test('the manager reads the answers, and the form is not open to them', { skip }, async () => {
  const r = await req('GET', `/pms/team/midyear-review/${empId}`, tok.mgr);
  assert.equal(r.status, 200);
  const qs = r.body.form.flatMap((s) => s.questions);
  assert.equal(qs.find((q) => q.label === 'Go Getter').rating, 4,
    'the manager sees it while writing their half, like the per-KRA self ratings');
  assert.equal(r.body.profile, undefined);
  // There is no write route for the manager's side of the form. If one
  // is ever added it is a decision, not an accident.
  const w = await req('PUT', `/pms/team/midyear-review/${empId}/form`, tok.mgr, { answers: {} });
  assert.equal(w.status, 404);
});

test('the form is shut when the phase is shut', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE id=$1`, [cycleId]);
  try {
    const r = await req('PUT', '/pms/my/midyear-review/form', tok.emp, { answers: {} });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not open/);
  } finally {
    await db.query(`UPDATE pms.cycles SET phase='mid_year_review' WHERE id=$1`, [cycleId]);
  }
});
