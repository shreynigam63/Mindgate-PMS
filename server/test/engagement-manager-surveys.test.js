// node --test — surveys ABOUT somebody else (phase 4, 25 Sep).
//
// "BUT — YOU SHOULD ALSO SURVEY THE MANAGER. This is critical. If you
// only ask employees, your PMS will capture perception, but not the
// manager's assessment."
//
// Every survey before this was answered by an invited employee about
// themselves, and the schema said so: one invitation per person per
// survey, enforced by the primary key. A manager with four new joiners
// needs four invitations to one survey. Most of what is asserted below
// is about that change not breaking the two things it could:
// re-inviting everybody every night, and letting a manager assess
// somebody who is not theirs.
//
// Real Postgres, real HTTP surface. Skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, sweepTenureSurveys;
const ids = {};

const joined = (daysAgo) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mgr';
  process.env.TENANT_SLUG = 'mgr-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  ({ sweepTenureSurveys } = require('../modules/engagement'));

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const add = async (key, name, email, x = {}) => {
    const r = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, designation, date_of_joining, manager_id)
       VALUES ($1,$2,$3,COALESCE($4,'active'),$5,$6,$7,$8) RETURNING id`,
      [t.id, name, email, x.status || null, x.department || null, x.designation || null,
       x.doj || null, x.manager_id || null])).rows[0];
    ids[key] = r.id;
    return r.id;
  };

  await add('admin', 'Mgr Admin', 'mgr-admin@x.com', { department: 'HR', doj: joined(900) });
  // ONE manager, THREE new joiners at day 30 — the case the old
  // primary key made impossible.
  const boss = await add('boss', 'Bess Boss', 'boss@x.com', { department: 'Development', doj: joined(1200) });
  await add('n1', 'New One', 'n1@x.com', { department: 'Development', designation: 'Software Developer', doj: joined(31), manager_id: boss });
  await add('n2', 'New Two', 'n2@x.com', { department: 'Development', designation: 'Software Developer', doj: joined(33), manager_id: boss });
  await add('n3', 'New Three', 'n3@x.com', { department: 'Cloud', designation: 'Cloud Engineer', doj: joined(35), manager_id: boss });
  // A second manager with one reportee, to prove invitations do not
  // leak across managers.
  const boss2 = await add('boss2', 'Other Boss', 'boss2@x.com', { department: 'Cloud', doj: joined(1000) });
  await add('n4', 'New Four', 'n4@x.com', { department: 'Cloud', designation: 'Cloud Engineer', doj: joined(32), manager_id: boss2 });
  // In the cohort but with NOBODY to assess them.
  await add('orphan', 'No Manager', 'orphan@x.com', { department: 'Development', doj: joined(32) });
  // In the cohort, but their manager has left.
  const gone = await add('gone', 'Departed Boss', 'gone@x.com', { status: 'inactive', doj: joined(2000) });
  await add('n5', 'New Five', 'n5@x.com', { department: 'Development', doj: joined(34), manager_id: gone });
  // Arrives in the window later, for the sweep.
  await add('later', 'Arrives Later', 'later@x.com', { department: 'Development', doj: joined(20), manager_id: boss });

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'mgr-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['mgr-admin@x.com', 'boss@x.com', 'boss2@x.com', 'n1@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
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
  return (await r.json()).token;
}
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}
const MGR = { audience_kind: 'manager_about_reportee', trigger_type: 'tenure',
  trigger_day: 30, trigger_window_days: 7 };

async function makeManagerSurvey(tok, extra = {}) {
  const r = await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Manager 30-Day Review', ...MGR, anonymity_default: false,
    questions: [
      { qtype: 'scale', prompt: 'The employee has understood their role.' },
      { qtype: 'choice', prompt: 'Are there any performance concerns?', options: ['No', 'Minor', 'Significant'] },
    ], ...extra }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.survey;
}

test('the preview counts SUBJECTS, and names who cannot be assessed', { skip }, async () => {
  const tok = await login('mgr-admin@x.com');
  const r = await api('/engagement/audience/preview', tok, { method: 'POST', body: JSON.stringify(MGR) });
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, 'manager_about_reportee');
  // n1, n2, n3 (Bess) and n4 (Other Boss). Not the orphan, not the one
  // whose manager left, not "Arrives Later" at day 20.
  assert.equal(r.body.count, 4);
  assert.equal(r.body.managers, 2, 'two managers are being asked');
  assert.equal(r.body.no_manager, 1, 'the person with no manager is counted, not dropped');
  assert.equal(r.body.manager_inactive, 1, 'and so is the one whose manager has left');
  assert.match(r.body.description, /reporting manager of/);
});

test('one manager, three reportees, three invitations — the old key forbade this', { skip }, async () => {
  // THE SCHEMA CHANGE. invitations was keyed (survey_id, employee_id),
  // so Bess could only ever be invited once to one survey.
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok);
  const open = await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  assert.equal(open.status, 200);
  assert.equal(open.body.invited, 4);
  assert.equal(open.body.kind, 'manager_about_reportee');

  const bess = (await db.query(
    `SELECT subj.name FROM engagement.invitations i JOIN core.employees subj ON subj.id=i.subject_employee_id
      WHERE i.survey_id=$1 AND i.employee_id=$2 ORDER BY subj.name`, [s.id, ids.boss])).rows.map((r) => r.name);
  assert.deepEqual(bess, ['New One', 'New Three', 'New Two']);
  const other = (await db.query(
    `SELECT subj.name FROM engagement.invitations i JOIN core.employees subj ON subj.id=i.subject_employee_id
      WHERE i.survey_id=$1 AND i.employee_id=$2`, [s.id, ids.boss2])).rows.map((r) => r.name);
  assert.deepEqual(other, ['New Four'], 'and invitations do not leak across managers');
  // Nobody is invited about themselves.
  const selfInv = +(await db.query(
    `SELECT count(*)::int n FROM engagement.invitations WHERE survey_id=$1 AND employee_id=subject_employee_id`,
    [s.id])).rows[0].n;
  assert.equal(selfInv, 0);
});

test('releasing twice, and the nightly sweep, invite nobody twice', { skip }, async () => {
  // The NULLS NOT DISTINCT index is what makes this true. Without it
  // two NULL subjects count as different rows and every self survey
  // would re-invite the whole company on every sweep.
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok, { title: 'Idempotent' });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const again = await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  assert.equal(again.body.invited, 0);
  const quiet = await sweepTenureSurveys(tenantId);
  assert.equal(quiet.invited, 0, 'the sweep adds nobody on a second pass');

  // ...and a SELF survey is equally idempotent, which is the case the
  // NULL subject could have broken.
  const self = (await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Self idempotent', trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7,
    questions: [{ qtype: 'scale', prompt: 'I understand my role.' }] }) })).body.survey;
  await api(`/engagement/surveys/${self.id}/open`, tok, { method: 'POST' });
  const n1 = +(await db.query(`SELECT count(*)::int n FROM engagement.invitations WHERE survey_id=$1`, [self.id])).rows[0].n;
  await sweepTenureSurveys(tenantId);
  await sweepTenureSurveys(tenantId);
  const n2 = +(await db.query(`SELECT count(*)::int n FROM engagement.invitations WHERE survey_id=$1`, [self.id])).rows[0].n;
  assert.equal(n2, n1, `two sweeps must not duplicate a self survey's invitations — ${n1} became ${n2}`);
});

test('a new joiner reaching the window gets their manager invited, with nobody pressing anything', { skip }, async () => {
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok, { title: 'Standing manager review' });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const before = +(await db.query(`SELECT count(*)::int n FROM engagement.invitations WHERE survey_id=$1`, [s.id])).rows[0].n;
  await db.query(`UPDATE core.employees SET date_of_joining=$2 WHERE id=$1`, [ids.later, joined(30)]);
  await sweepTenureSurveys(tenantId);
  const after = (await db.query(
    `SELECT subj.name FROM engagement.invitations i JOIN core.employees subj ON subj.id=i.subject_employee_id
      WHERE i.survey_id=$1 ORDER BY subj.name`, [s.id])).rows.map((r) => r.name);
  assert.equal(after.length, before + 1);
  assert.ok(after.includes('Arrives Later'));
  // Put the fixture back. Every test below makes its own survey, so
  // the invitation this one created is harmless — but leaving this
  // person inside the 30-day window changes the cohort size that the
  // later tests count, which is how a passing suite starts failing
  // from one test's side effect.
  await db.query(`UPDATE core.employees SET date_of_joining=$2 WHERE id=$1`, [ids.later, joined(20)]);
});

test('a manager answers once per reportee, and completing one leaves the rest open', { skip }, async () => {
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok, { title: 'Answer per reportee' });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });

  const bossTok = await login('boss@x.com');
  const mine = (await api('/engagement/my/invitations', bossTok)).body.invitations
    .filter((i) => i.title === 'Answer per reportee');
  assert.equal(mine.length, 3, 'three rows, one per reportee');
  assert.ok(mine.every((i) => i.subject_name), 'each says who it is about');
  assert.deepEqual(mine.map((i) => i.subject_name).sort(), ['New One', 'New Three', 'New Two']);

  const qs = (await api(`/engagement/surveys/${s.id}/questions`, bossTok)).body.questions;
  const answers = { [qs[0].id]: { num: 4 }, [qs[1].id]: { text: 'No' } };
  const one = mine.find((i) => i.subject_name === 'New One');
  const r = await api(`/engagement/surveys/${s.id}/respond`, bossTok, { method: 'POST',
    body: JSON.stringify({ answers, subject_employee_id: one.subject_employee_id }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const left = (await api('/engagement/my/invitations', bossTok)).body.invitations
    .filter((i) => i.title === 'Answer per reportee' && !i.completed_at);
  assert.equal(left.length, 2, 'the other two are still to do');

  // ...and the same one cannot be answered twice.
  const twice = await api(`/engagement/surveys/${s.id}/respond`, bossTok, { method: 'POST',
    body: JSON.stringify({ answers, subject_employee_id: one.subject_employee_id }) });
  assert.equal(twice.status, 409);
});

test('a manager cannot assess somebody who is not theirs', { skip }, async () => {
  // The authorisation check IS the invitation lookup: no row exists for
  // (survey, this manager, that subject), so there is nothing to answer.
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok, { title: 'Scope check' });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const bossTok = await login('boss@x.com');
  const qs = (await api(`/engagement/surveys/${s.id}/questions`, bossTok)).body.questions;
  const answers = { [qs[0].id]: { num: 5 }, [qs[1].id]: { text: 'No' } };

  const notMine = await api(`/engagement/surveys/${s.id}/respond`, bossTok, { method: 'POST',
    body: JSON.stringify({ answers, subject_employee_id: ids.n4 }) });   // Other Boss's reportee
  assert.equal(notMine.status, 403);
  assert.match(notMine.body.error, /not one of your reportees/i);

  // ...and answering with no subject at all is refused on a manager
  // survey, rather than silently recording an assessment of nobody.
  const noSubject = await api(`/engagement/surveys/${s.id}/respond`, bossTok,
    { method: 'POST', body: JSON.stringify({ answers }) });
  assert.equal(noSubject.status, 403);

  const stranger = await login('n1@x.com');
  const notInvited = await api(`/engagement/surveys/${s.id}/respond`, stranger, { method: 'POST',
    body: JSON.stringify({ answers, subject_employee_id: ids.n2 }) });
  assert.equal(notInvited.status, 403);
  assert.match(notInvited.body.error, /Not invited/i);
});

test('a manager survey cannot be anonymous — refused, not quietly accepted', { skip }, async () => {
  // The record is "what X's manager said about X". Anonymous would be
  // a lie on the form, and storing a subject on an otherwise anonymous
  // response would hand HR a way to identify respondents on a survey
  // that promised it would not.
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok, { title: 'Tried to hide', anonymity_default: true });
  assert.equal(s.anonymity_default, false, 'the request was overridden, not honoured');

  // And the database refuses it outright, so no other code path can.
  await assert.rejects(
    db.query(`UPDATE engagement.surveys SET anonymity_default=true WHERE id=$1`, [s.id]),
    /surveys_manager_not_anonymous/,
    'the constraint is the real guarantee');
});

test('an unknown audience kind is refused rather than treated as self', { skip }, async () => {
  // Treating a typo as 'self' would send an assessment to the very
  // people it is about.
  const tok = await login('mgr-admin@x.com');
  const r = await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Typo', audience_kind: 'manager', questions: [{ qtype: 'scale', prompt: 'x' }] }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Unknown audience/);
});

test('results carry a per-employee scorecard, weakest first', { skip }, async () => {
  // An average across the cohort is the least useful thing in a
  // manager assessment. "What did each manager say about each of their
  // new joiners" is the point.
  const tok = await login('mgr-admin@x.com');
  const s = await makeManagerSurvey(tok, { title: 'Scorecard' });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const bossTok = await login('boss@x.com');
  const qs = (await api(`/engagement/surveys/${s.id}/questions`, bossTok)).body.questions;
  const mine = (await api('/engagement/my/invitations', bossTok)).body.invitations
    .filter((i) => i.title === 'Scorecard');
  const say = (subject, score, concern) => api(`/engagement/surveys/${s.id}/respond`, bossTok,
    { method: 'POST', body: JSON.stringify({ subject_employee_id: subject,
      answers: { [qs[0].id]: { num: score }, [qs[1].id]: { text: concern } } }) });
  await say(mine.find((i) => i.subject_name === 'New One').subject_employee_id, 5, 'No');
  await say(mine.find((i) => i.subject_name === 'New Two').subject_employee_id, 2, 'Significant');

  const res = (await api(`/engagement/surveys/${s.id}/results`, tok)).body;
  assert.equal(res.survey.audience_kind, 'manager_about_reportee');
  assert.ok(Array.isArray(res.subjects), 'a per-subject breakdown is returned');
  assert.equal(res.subjects.length, 2);
  assert.equal(res.subjects[0].name, 'New Two', 'weakest first — that is the one HR must see');
  assert.equal(res.subjects[0].average, 2);
  assert.equal(res.subjects[0].manager, 'Bess Boss', 'and who said it');
  assert.ok(res.subjects[0].answers.some((a) => a.value === 'Significant'),
    'the concern is on the record, not just the number');
  assert.equal(res.subjects[1].name, 'New One');
});

test('a self survey returns no subject breakdown at all', { skip }, async () => {
  // Anonymity is structural: a self survey's responses must stay
  // unjoined to anybody, so this key must be absent rather than empty.
  const tok = await login('mgr-admin@x.com');
  const s = (await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Plain pulse', questions: [{ qtype: 'scale', prompt: 'I am happy.' }] }) })).body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const res = (await api(`/engagement/surveys/${s.id}/results`, tok)).body;
  assert.equal(res.subjects, undefined);
  assert.equal(res.survey.audience_kind, 'self');
});

test('the three manager templates are in the library and release correctly', { skip }, async () => {
  const tok = await login('mgr-admin@x.com');
  const lib = (await api('/engagement/templates', tok)).body.templates;
  const mgrs = lib.filter((t) => t.audience_kind === 'manager_about_reportee');
  assert.deepEqual(mgrs.map((t) => t.key), ['manager_30', 'manager_60', 'manager_90']);
  for (const t of mgrs) {
    assert.equal(t.anonymity_default, false, `${t.key} is attributed`);
    assert.equal(t.trigger_type, 'tenure', `${t.key} is a lifecycle survey`);
  }
  const used = await api('/engagement/templates/manager_30/use', tok,
    { method: 'POST', body: JSON.stringify({ title: 'From the library' }) });
  assert.equal(used.status, 200);
  assert.equal(used.body.survey.audience_kind, 'manager_about_reportee');
  assert.equal(used.body.survey.anonymity_default, false);
  const open = await api(`/engagement/surveys/${used.body.survey.id}/open`, tok, { method: 'POST' });
  assert.equal(open.body.kind, 'manager_about_reportee');
  assert.ok(open.body.invited > 0, 'and it reaches the managers');
});
