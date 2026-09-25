// node --test — releasing a survey to a category, and the lifecycle
// sweep that keeps releasing it as people reach the milestone.
//
// Asked for on 25 Sep: "create engagement form in the engagement survey
// which will be pushed to all employees who are fitting in that
// employees categories", with Day 1 / Week 1 / 30 / 60 / 90 driven off
// the date of joining.
//
// Real Postgres, real HTTP surface, real dates — the tenure window is
// the one thing that cannot be tested honestly against a stub, because
// the bug it guards against is an off-by-one against current_date.
// Skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, sweepTenureSurveys;
const ids = {};

// Joined N days ago, as a date literal the employee master would hold.
const joined = (daysAgo) => {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-eng';
  process.env.TENANT_SLUG = 'eng-test-' + Date.now();
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

  const add = async (key, name, email, extra = {}) => {
    const r = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, designation, role_band, date_of_joining, manager_id)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8) RETURNING id`,
      [t.id, name, email, extra.department || null, extra.designation || null,
       extra.role_band || null, extra.doj || null, extra.manager_id || null])).rows[0];
    ids[key] = r.id;
    return r.id;
  };

  await add('admin', 'Eng Admin', 'eng-admin@x.com', { department: 'HR', doj: joined(900) });
  const boss = await add('boss', 'Eng Boss', 'eng-boss@x.com', { department: 'Development', doj: joined(1200) });

  // The 30-day cohort: one dead on 30, one mid-window, one at the very
  // edge. The real master has almost nobody on exactly 30.
  await add('d30a', 'Thirty Exact', 'd30a@x.com', { department: 'Development', designation: 'Software Developer', role_band: 'E2', doj: joined(30), manager_id: boss });
  await add('d30b', 'Thirty Mid', 'd30b@x.com', { department: 'Development', designation: 'Software Developer', role_band: 'E2', doj: joined(33), manager_id: boss });
  await add('d30c', 'Thirty Edge', 'd30c@x.com', { department: 'Cloud', designation: 'Cloud Engineer', role_band: 'E2', doj: joined(37), manager_id: boss });
  // Just outside, both sides.
  await add('young', 'Too New', 'young@x.com', { department: 'Development', designation: 'Software Developer', doj: joined(29) });
  await add('old', 'Too Old', 'old@x.com', { department: 'Development', designation: 'Software Developer', doj: joined(38) });
  // Tomorrow's arrival into the window, used by the sweep test.
  await add('soon', 'Arrives Tomorrow', 'soon@x.com', { department: 'Development', designation: 'Software Developer', doj: joined(29) });
  // No joining date at all — must be counted, never silently dropped.
  await add('nodoj', 'No Joining Date', 'nodoj@x.com', { department: 'Development', designation: 'Software Developer' });

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'eng-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['eng-admin@x.com', 'd30a@x.com', 'young@x.com']) {
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
const preview = (tok, body) => api('/engagement/audience/preview', tok, { method: 'POST', body: JSON.stringify(body) });
const invitedNames = async (surveyId) => (await db.query(
  `SELECT e.name FROM engagement.invitations i JOIN core.employees e ON e.id=i.employee_id
    WHERE i.survey_id=$1 ORDER BY e.name`, [surveyId])).rows.map((r) => r.name);

// ---- the preview -----------------------------------------------------
test('the preview counts the audience before anything is written', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const all = await preview(tok, {});
  assert.equal(all.status, 200);
  assert.equal(all.body.count, 9, 'an empty rule is everybody');
  assert.match(all.body.description, /everyone on the employee list/);

  // Development holds boss, the three 30-day fixtures that are in it,
  // Too New, Too Old, Arrives Tomorrow and No Joining Date.
  const dev = await preview(tok, { audience_rule: { departments: ['Development'] } });
  assert.equal(dev.body.count, 7);
  assert.match(dev.body.description, /everyone in Development/);

  // Nothing was written by previewing.
  const n = +(await db.query(`SELECT count(*)::int c FROM engagement.invitations WHERE tenant_id=$1`, [tenantId])).rows[0].c;
  assert.equal(n, 0, 'a preview must not invite anybody');
});

test('the preview reports who a tenure rule had to skip for want of a joining date', { skip }, async () => {
  // No silent failure: a cohort that is quietly one short looks exactly
  // like a cohort that is genuinely that size.
  const tok = await login('eng-admin@x.com');
  const r = await preview(tok, { trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7 });
  assert.equal(r.body.no_joining_date, 1, 'the employee with no DOJ is counted, not swallowed');
  assert.ok(!r.body.sample.includes('No Joining Date'), 'and is not in the audience');
});

test('a Day 30 window catches 30, 33 and 37 — and nobody at 29 or 38', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const r = await preview(tok, { trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7 });
  const got = r.body.sample.sort();
  assert.deepEqual(got, ['Thirty Edge', 'Thirty Exact', 'Thirty Mid']);
  assert.equal(r.body.count, 3);
});

test('category AND milestone compose — a Day 30 for Development only', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const r = await preview(tok, { trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7,
    audience_rule: { departments: ['Development'] } });
  assert.deepEqual(r.body.sample.sort(), ['Thirty Exact', 'Thirty Mid'], 'Thirty Edge is in Cloud');
  assert.match(r.body.description, /everyone in Development, who joined between 30 and 37 days ago/);
});

test('a half-configured trigger is refused rather than sitting open reaching nobody', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const noDay = await preview(tok, { trigger_type: 'tenure' });
  assert.equal(noDay.status, 422);
  assert.match(noDay.body.error, /needs a milestone/);
  const badWin = await preview(tok, { trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 0 });
  assert.equal(badWin.status, 422);
  assert.match(badWin.body.error, /catch-up window/);
});

test('only an engagement admin may preview an audience or read the options', { skip }, async () => {
  const stranger = await login('young@x.com');
  assert.equal((await preview(stranger, {})).status, 403);
  assert.equal((await api('/engagement/audience/options', stranger)).status, 403);
});

test('the option lists come off the employee master, so a rule cannot name a ghost', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const r = await api('/engagement/audience/options', tok);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.departments.sort(), ['Cloud', 'Development', 'HR']);
  assert.ok(r.body.designations.includes('Software Developer'));
  assert.ok(r.body.role_bands.includes('E2'));
  assert.equal(r.body.managers.length, 1);
  assert.equal(r.body.managers[0].name, 'Eng Boss');
  assert.equal(r.body.milestones.length, 5, 'the picker gets the five milestones');
});

// ---- releasing to a category ----------------------------------------
const makeSurvey = async (tok, body) => {
  const r = await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    questions: [{ qtype: 'scale', prompt: 'I understand my responsibilities.' }], ...body }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.survey;
};

test('a survey released to a category reaches that category and nobody else', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const s = await makeSurvey(tok, { title: 'Cloud pulse', audience_rule: { departments: ['Cloud'] } });
  assert.equal(s.status, 'draft');
  assert.equal((await invitedNames(s.id)).length, 0, 'a draft invites nobody');

  const open = await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  assert.equal(open.status, 200);
  assert.equal(open.body.invited, 1);
  assert.match(open.body.audience, /everyone in Cloud/);
  assert.equal(open.body.standing, false, 'a manual survey is a one-off release');
  assert.deepEqual(await invitedNames(s.id), ['Thirty Edge']);
});

test('releasing twice invites nobody twice', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const s = await makeSurvey(tok, { title: 'Twice', audience_rule: { departments: ['Cloud'] } });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const again = await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  assert.equal(again.body.invited, 0, 'the second release adds nobody');
  assert.equal(again.body.audience_size, 1, 'but still reports the audience honestly');
  assert.equal((await invitedNames(s.id)).length, 1);
});

test("an open survey's audience is frozen — it cannot be edited underneath the people already invited", { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const s = await makeSurvey(tok, { title: 'Frozen', audience_rule: { departments: ['Cloud'] } });
  const draftEdit = await api(`/engagement/surveys/${s.id}`, tok,
    { method: 'PUT', body: JSON.stringify({ audience_rule: { departments: ['Development'] } }) });
  assert.equal(draftEdit.status, 200, 'a draft can be edited freely');

  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const after = await api(`/engagement/surveys/${s.id}`, tok,
    { method: 'PUT', body: JSON.stringify({ audience_rule: { departments: ['HR'] } }) });
  assert.equal(after.status, 409);
  assert.match(after.body.error, /already open/);
});

// ---- the lifecycle sweep ---------------------------------------------
test('a lifecycle survey keeps releasing itself as people reach the milestone', { skip }, async () => {
  // THE POINT OF PHASE 2. HR presses Open once; the survey then catches
  // each new joiner on their own day 30, for as long as it stays open.
  const tok = await login('eng-admin@x.com');
  const s = await makeSurvey(tok, { title: 'Day 30 Connect', trigger_type: 'tenure',
    trigger_day: 30, trigger_window_days: 7, audience_rule: { departments: ['Development'] } });
  assert.equal(s.trigger_type, 'tenure');

  const open = await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  assert.equal(open.body.standing, true, 'a lifecycle survey stays open and keeps inviting');
  assert.deepEqual(await invitedNames(s.id), ['Thirty Exact', 'Thirty Mid']);

  // Nothing changes on a sweep with no new arrivals.
  const quiet = await sweepTenureSurveys(tenantId);
  assert.equal(quiet.invited, 0, 'an idempotent sweep invites nobody twice');

  // "Arrives Tomorrow" was at 29 days; age them into the window.
  await db.query(`UPDATE core.employees SET date_of_joining = $2 WHERE id=$1`, [ids.soon, joined(31)]);
  const swept = await sweepTenureSurveys(tenantId);
  assert.equal(swept.invited, 1, 'the new arrival is picked up without HR touching anything');
  assert.deepEqual(await invitedNames(s.id), ['Arrives Tomorrow', 'Thirty Exact', 'Thirty Mid']);

  // Somebody who ages PAST the window is not chased retrospectively...
  await db.query(`UPDATE core.employees SET date_of_joining = $2 WHERE id=$1`, [ids.young, joined(200)]);
  const late = await sweepTenureSurveys(tenantId);
  assert.equal(late.invited, 0, 'day 200 is not day 30');
  // ...and the person already invited stays invited.
  assert.ok((await invitedNames(s.id)).includes('Thirty Exact'));
});

test('a closed lifecycle survey stops sweeping', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const s = await makeSurvey(tok, { title: 'Stops', trigger_type: 'tenure', trigger_day: 60, trigger_window_days: 7 });
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  await api(`/engagement/surveys/${s.id}/close`, tok, { method: 'POST' });
  await db.query(`UPDATE core.employees SET date_of_joining=$2 WHERE id=$1`, [ids.old, joined(62)]);
  const r = await sweepTenureSurveys(tenantId);
  assert.ok(!r.per_survey.some((x) => x.id === s.id), 'a closed survey is not swept');
  assert.equal((await invitedNames(s.id)).length, 0);
});

test('a sweep is audited, so "who was this sent to" has an answer', { skip }, async () => {
  const rows = (await db.query(
    `SELECT action, details FROM core.audit_log
      WHERE tenant_id=$1 AND action IN ('SURVEY_OPENED','SURVEY_SWEEP_INVITED','SURVEY_CREATED')`,
    [tenantId])).rows;
  const opened = rows.filter((r) => r.action === 'SURVEY_OPENED');
  assert.ok(opened.length, 'releases are written down');
  assert.ok(opened.some((r) => r.details.audience && r.details.invited != null),
    'and the entry names the audience and how many it reached');
  assert.ok(rows.some((r) => r.action === 'SURVEY_SWEEP_INVITED'), 'so are the sweeps');
});

// ---- choice and multi-select (the defect found on 25 Sep) -------------
test('a choice question renders its options, tallies, and is not an average', { skip }, async () => {
  // THE BUG. 'choice' was in the schema and implemented nowhere: it
  // rendered to the employee as a 1-5 scale and the results said
  // "n=0 · avg" while four answers sat unread in the table. It hit the
  // most useful question in a 30-day survey — the one naming what is
  // blocking somebody.
  const tok = await login('eng-admin@x.com');
  const OPTS = ['Lack of training', 'Lack of system access', 'Dependency on others', 'No significant blocker'];
  const r = await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Blockers', anonymity_default: false,
    questions: [
      { qtype: 'choice', prompt: 'What is preventing you from becoming fully productive?', options: OPTS },
      { qtype: 'multi', prompt: 'Which documents did you receive?', options: ['Location', 'Working hours', 'IT equipment'], required: false },
    ] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });

  const qs = (await api(`/engagement/surveys/${s.id}/questions`, tok)).body.questions;
  const choice = qs.find((q) => q.qtype === 'choice');
  const multi = qs.find((q) => q.qtype === 'multi');
  assert.deepEqual(choice.options, OPTS, 'the options reach the employee');

  const answer = async (email, pick, list) => {
    const t = await login(email);
    return api(`/engagement/surveys/${s.id}/respond`, t, { method: 'POST', body: JSON.stringify({
      answers: { [choice.id]: { text: pick }, [multi.id]: { list } } }) });
  };
  assert.equal((await answer('eng-admin@x.com', 'Lack of training', ['Location', 'IT equipment'])).status, 200);
  assert.equal((await answer('d30a@x.com', 'Lack of training', ['Location'])).status, 200);
  assert.equal((await answer('young@x.com', 'Dependency on others', [])).status, 200);

  const res = (await api(`/engagement/surveys/${s.id}/results`, tok)).body;
  const cq = res.questions.find((q) => q.qtype === 'choice');
  assert.equal(cq.n, 3, 'answered count, not zero');
  assert.equal(cq.average, undefined, 'a blocker is not an average');
  assert.deepEqual(cq.tally.map((t) => [t.option, t.count]), [
    ['Lack of training', 2], ['Dependency on others', 1],
    ['Lack of system access', 0], ['No significant blocker', 0]],
    'biggest first, and every offered option listed so a zero shows as a zero');
  assert.equal(cq.tally[0].pct, 67);

  const mq = res.questions.find((q) => q.qtype === 'multi');
  const by = Object.fromEntries(mq.tally.map((t) => [t.option, t.count]));
  assert.deepEqual(by, { Location: 2, 'IT equipment': 1, 'Working hours': 0 });
  assert.equal(mq.n, 2, 'the person who picked nothing is not counted as answering');
});

test('an option nobody offered is refused, so the tally cannot grow a category', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const s = (await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Strays', questions: [{ qtype: 'choice', prompt: 'Pick one', options: ['A', 'B'] }] }) })).body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const q = (await api(`/engagement/surveys/${s.id}/questions`, tok)).body.questions[0];
  const t = await login('d30a@x.com');
  const bad = await api(`/engagement/surveys/${s.id}/respond`, t,
    { method: 'POST', body: JSON.stringify({ answers: { [q.id]: { text: 'Z' } } }) });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /not one of the options/);
});

test('a choice question with fewer than two options is refused at creation', { skip }, async () => {
  // Saved, it would render as an empty box the employee cannot answer —
  // discovered by the first person to open the survey rather than by HR.
  const tok = await login('eng-admin@x.com');
  const r = await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Broken', questions: [{ qtype: 'choice', prompt: 'Pick one', options: ['Only one'] }] }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /needs at least two options/);
});

test('a required choice is not satisfied by an empty pick', { skip }, async () => {
  const tok = await login('eng-admin@x.com');
  const s = (await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Required', questions: [{ qtype: 'choice', prompt: 'Pick one', options: ['A', 'B'], required: true }] }) })).body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const q = (await api(`/engagement/surveys/${s.id}/questions`, tok)).body.questions[0];
  const t = await login('young@x.com');
  const blank = await api(`/engagement/surveys/${s.id}/respond`, t,
    { method: 'POST', body: JSON.stringify({ answers: { [q.id]: { text: '  ' } } }) });
  assert.equal(blank.status, 422);
  assert.match(blank.body.error, /unanswered/);
});
