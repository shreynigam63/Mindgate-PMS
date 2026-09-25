// node --test — the insight endpoints over a real database.
//
// Phase 5, sections 22 to 25. The pure arithmetic is covered in
// engagement-insights.test.js; this is about the parts only a real
// database can get wrong: which answers are allowed to reach the
// engine at all, who is allowed to read them, and whether a manager
// assessment attaches to the manager or to the person it is about.
//
// NO LISTENING AGENT — nothing here drafts or infers.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;
const ids = {};
const joined = (d) => { const x = new Date(); x.setUTCHours(12, 0, 0, 0); x.setUTCDate(x.getUTCDate() - d); return x.toISOString().slice(0, 10); };

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ins';
  process.env.TENANT_SLUG = 'ins-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  const add = async (k, name, email, x = {}) => {
    const r = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, date_of_joining, manager_id, last_appraisal_rating)
       VALUES ($1,$2,$3,COALESCE($4,'active'),$5,$6,$7,$8) RETURNING id`,
      [t.id, name, email, x.status || null, x.department || null, x.doj || null,
       x.manager_id || null, x.rating || null])).rows[0];
    ids[k] = r.id; return r.id;
  };
  await add('admin', 'Ins Admin', 'ins-admin@x.com', { department: 'HR', doj: joined(900) });
  const boss = await add('boss', 'Ins Boss', 'ins-boss@x.com', { department: 'Dev', doj: joined(900) });
  await add('struggler', 'Sam Struggling', 'sam@x.com', { department: 'Dev', doj: joined(31), manager_id: boss, rating: 'C' });
  await add('settling', 'Sal Settling', 'sal@x.com', { department: 'Dev', doj: joined(32), manager_id: boss, rating: 'B' });
  await add('thriving', 'Tom Thriving', 'tom@x.com', { department: 'Dev', doj: joined(33), manager_id: boss, rating: 'A' });
  await add('stranger', 'Not Mine', 'stranger@x.com', { department: 'Ops', doj: joined(34) });
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ins-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['ins-admin@x.com', 'ins-boss@x.com', 'sam@x.com', 'sal@x.com', 'tom@x.com', 'stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});
after(async () => { if (!HAS_DB) return; server.close(); await db.pool.end(); });

async function login(email) {
  return (await (await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) })).json()).token;
}
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

// Creates a survey from a lifecycle template, opens it, and answers it
// as each named person — the real path, so the dimensions and the
// template key come from the library rather than from this file.
async function runMilestone(tok, key, answersByEmail) {
  const s = (await api(`/engagement/templates/${key}/use`, tok,
    { method: 'POST', body: JSON.stringify({ trigger_type: 'manual', title: `${key} run` }) })).body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const qs = (await api(`/engagement/surveys/${s.id}/questions`, tok)).body.questions;
  for (const [email, pick] of Object.entries(answersByEmail)) {
    const t = await login(email);
    const answers = {};
    for (const q of qs) {
      const v = pick(q);
      if (v !== undefined) answers[q.id] = v;
    }
    const r = await api(`/engagement/surveys/${s.id}/respond`, t, { method: 'POST', body: JSON.stringify({ answers }) });
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
  }
  return s;
}
// A responder who rates everything at `n`, picks `blocker` for the
// productivity choice, and answers every other choice with its first
// option so required questions are satisfied.
const rater = (n, blocker, enps) => (q) => {
  if (q.qtype === 'scale') return { num: n };
  if (q.qtype === 'enps') return { num: enps };
  if (q.qtype === 'choice') {
    // Found by its OPTIONS, not by q.dimension: the employee-facing
    // questions endpoint does not return the dimension, and it should
    // not — that is analytics metadata, not something the person
    // answering needs.
    if ((q.options || []).includes(blocker)) return { text: blocker };
    return { text: (q.options || [])[0] };
  }
  if (q.qtype === 'multi') return { list: [] };
  if (q.qtype === 'text') return { text: 'n/a' };
  return undefined;
};

test('questions created from the library carry their dimension', { skip }, async () => {
  // Everything downstream depends on this: a trend cannot be built by
  // matching on wording, because HR is allowed to edit the wording.
  const tok = await login('ins-admin@x.com');
  const s = (await api('/engagement/templates/day_30/use', tok,
    { method: 'POST', body: JSON.stringify({ trigger_type: 'manual' }) })).body.survey;
  const rows = (await db.query(
    `SELECT dimension, count(*)::int AS n FROM engagement.questions
      WHERE survey_id=$1 AND qtype IN ('scale','enps','choice') GROUP BY 1`, [s.id])).rows;
  const nulls = rows.find((r) => r.dimension === null);
  assert.ok(!nulls, `every scorable question is dimensioned — got ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => r.dimension === 'role_clarity'));
  assert.ok(rows.some((r) => r.dimension === 'retention'));
});

test('the flag list names the person, the rule, the action and the owner', { skip }, async () => {
  const tok = await login('ins-admin@x.com');
  await runMilestone(tok, 'day_30', {
    'sam@x.com': rater(1, 'Lack of training', 2),     // red: intent to leave, plus ambers
    'tom@x.com': rater(5, 'No significant blocker', 10),
  });
  const r = await api('/engagement/insights/flags', tok);
  assert.equal(r.status, 200);
  const sam = r.body.people.find((p) => p.name === 'Sam Struggling');
  assert.ok(sam, 'the struggling new hire is on the list');
  assert.equal(sam.severity, 'red');
  assert.equal(sam.manager, 'Ins Boss', 'and who would act on it');
  const f = sam.flags.find((x) => x.key === 'intent_to_leave');
  assert.ok(f, `intent to leave fired — got ${JSON.stringify(sam.flags.map((x) => x.key))}`);
  assert.equal(f.owner, 'HR');
  assert.ok(f.action && f.follow_up_days > 0, 'with an action and a follow-up, not just a colour');
  assert.ok(sam.flags.some((x) => x.key === 'low_role_clarity'), 'and the ambers too');
  // Somebody who answered well is not on the list at all.
  assert.ok(!r.body.people.some((p) => p.name === 'Tom Thriving'), 'a green person is absent, not listed as green');
  assert.ok(r.body.counts.red >= 1);
});

test('an anonymous survey never reaches the engine', { skip }, async () => {
  // Structural anonymity: those responses are not joined to anybody,
  // so they cannot raise a flag against anybody either.
  const tok = await login('ins-admin@x.com');
  // The list BEFORE, so the comparison is against reality rather than
  // against a name. Checking that "Not Mine" is absent proves nothing:
  // an anonymous response has no name to be absent, so that assertion
  // passes even when the answers leak straight into the engine.
  const before = JSON.stringify((await api('/engagement/insights/flags', tok)).body);

  const s = (await api('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: 'Anonymous pulse', anonymity_default: true, allow_attribution_optin: false,
    questions: [{ qtype: 'enps', prompt: 'How likely are you to stay?', dimension: 'retention' }] }) })).body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const q = (await api(`/engagement/surveys/${s.id}/questions`, tok)).body.questions[0];
  const st = await login('stranger@x.com');
  // A 0 here would fire 'intent_to_leave' — red — if it reached the engine.
  await api(`/engagement/surveys/${s.id}/respond`, st,
    { method: 'POST', body: JSON.stringify({ answers: { [q.id]: { num: 0 } } }) });

  const anonRows = +(await db.query(
    `SELECT count(*)::int n FROM engagement.responses WHERE survey_id=$1 AND employee_id IS NULL`, [s.id])).rows[0].n;
  assert.equal(anonRows, 1, 'the answer was stored anonymously');

  const after = (await api('/engagement/insights/flags', tok)).body;
  assert.equal(JSON.stringify(after), before,
    'the worst possible anonymous answer changed nothing in the flag list');
  // ...and nothing nameless ever appears, which is what a leaked
  // anonymous response would look like.
  assert.ok(after.people.every((p) => p.name), 'every flagged row is a person with a name');
});

test('a 30/60/90 trend is built per dimension, in milestone order', { skip }, async () => {
  const tok = await login('ins-admin@x.com');
  // Sal improves across the three milestones.
  await runMilestone(tok, 'day_30', { 'sal@x.com': rater(2, 'Lack of clarity', 5) });
  await runMilestone(tok, 'day_60', { 'sal@x.com': rater(3, 'Dependency on others', 7) });
  await runMilestone(tok, 'day_90', { 'sal@x.com': rater(5, 'No significant blocker', 9) });

  const r = await api(`/engagement/insights/employee/${ids.settling}`, tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.employee.name, 'Sal Settling');
  assert.deepEqual(r.body.points.map((p) => p.milestone), [30, 60, 90], 'milestone order');
  const rc = r.body.rows.find((x) => x.dimension === 'role_clarity');
  assert.ok(rc, 'role clarity is tracked');
  assert.equal(rc.series.length, 3);
  assert.equal(rc.first, 25);
  assert.equal(rc.latest, 100);
  assert.equal(rc.direction, 'up');
  assert.ok(r.body.points[0].overall < r.body.points[2].overall, 'and the overall rose');
});

test('a manager may read their own reportee, and nobody else', { skip }, async () => {
  const boss = await login('ins-boss@x.com');
  assert.equal((await api(`/engagement/insights/employee/${ids.settling}`, boss)).status, 200);
  const notMine = await api(`/engagement/insights/employee/${ids.stranger}`, boss);
  assert.equal(notMine.status, 403);
  assert.match(notMine.body.error, /own reportees/i);
  const plain = await login('stranger@x.com');
  assert.equal((await api(`/engagement/insights/employee/${ids.settling}`, plain)).status, 403);
  assert.equal((await api('/engagement/insights/flags', plain)).status, 403);
  assert.equal((await api('/engagement/insights/new-hire', plain)).status, 403);
});

test('a manager assessment is filed against the person it is ABOUT', { skip }, async () => {
  // The answers are the manager's, but the record belongs to the
  // subject. Filing it under the manager would put every reportee's
  // assessment on the manager's own trend.
  const tok = await login('ins-admin@x.com');
  const s = (await api('/engagement/templates/manager_30/use', tok,
    { method: 'POST', body: JSON.stringify({ trigger_type: 'manual', title: 'Manager read' }) })).body.survey;
  await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  const bossTok = await login('ins-boss@x.com');
  const qs = (await api(`/engagement/surveys/${s.id}/questions`, bossTok)).body.questions;
  const inv = (await api('/engagement/my/invitations', bossTok)).body.invitations
    .filter((i) => i.id === s.id && i.subject_name === 'Tom Thriving');
  assert.equal(inv.length, 1);
  const answers = {};
  for (const q of qs) {
    if (q.qtype === 'scale') answers[q.id] = { num: 1 };
    else if (q.qtype === 'choice') answers[q.id] = { text: (q.options || []).includes('Significant') ? 'Significant' : (q.options || [])[0] };
    else if (q.qtype === 'text') answers[q.id] = { text: 'needs support' };
  }
  await api(`/engagement/surveys/${s.id}/respond`, bossTok, { method: 'POST',
    body: JSON.stringify({ answers, subject_employee_id: inv[0].subject_employee_id }) });

  const r = await api('/engagement/insights/flags', tok);
  const tom = r.body.people.find((p) => p.name === 'Tom Thriving');
  assert.ok(tom, 'the flag is against Tom, who was assessed');
  assert.equal(tom.severity, 'red', 'a "Significant" concern is red');
  assert.ok(tom.flags.some((f) => f.key === 'significant_concern'));
  const bossRow = r.body.people.find((p) => p.name === 'Ins Boss');
  assert.ok(!bossRow || !bossRow.flags.some((f) => f.key === 'significant_concern'),
    'and NOT against the manager who wrote it');
});

test('the new-hire dashboard reports the index, the blockers and the participation', { skip }, async () => {
  const tok = await login('ins-admin@x.com');
  const r = await api('/engagement/insights/new-hire', tok);
  assert.equal(r.status, 200);
  assert.ok(r.body.people >= 3, `everyone who answered a lifecycle survey — got ${r.body.people}`);
  assert.ok(r.body.overall > 0 && r.body.overall <= 100);
  assert.ok(r.body.dimensions.length > 3, 'several dimensions are scored');
  for (let i = 1; i < r.body.dimensions.length; i++) {
    assert.ok(r.body.dimensions[i - 1].score <= r.body.dimensions[i].score, 'weakest first');
  }
  assert.ok(r.body.blockers.length, 'the blockers people named are counted');
  assert.ok(!r.body.blockers.some((b) => /No significant blocker/i.test(b.blocker)));
  assert.ok(r.body.participation.length, 'and participation per milestone, so a thin index is visible as thin');
});

test('outcomes band people by score and report attrition and rating per band', { skip }, async () => {
  const tok = await login('ins-admin@x.com');
  // Sam has left.
  await db.query(`UPDATE core.employees SET status='inactive' WHERE id=$1`, [ids.struggler]);
  const r = await api('/engagement/insights/outcomes', tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.dimension, 'overall');
  const low = r.body.bands.find((b) => b.key === 'low');
  assert.ok(low.n >= 1, 'somebody scored low');
  assert.equal(low.attrition_pct, 100, 'and all of them have left');
  assert.equal(r.body.has_ratings, true, 'this fixture has appraisal ratings');
  assert.ok(Object.keys(low.ratings).length, 'and the ratings are broken out per band');

  // ...and it can be asked about one dimension.
  const bydim = await api('/engagement/insights/outcomes?dimension=manager_support', tok);
  assert.equal(bydim.body.dimension, 'manager_support');
  assert.ok(bydim.body.bands.some((b) => b.n > 0));
  await db.query(`UPDATE core.employees SET status='active' WHERE id=$1`, [ids.struggler]);
});

test('the thresholds are readable, and are rows rather than code', { skip }, async () => {
  const tok = await login('ins-admin@x.com');
  const r = await api('/engagement/insights/rules', tok);
  assert.ok(r.body.rules.length >= 10);
  const rule = r.body.rules.find((x) => x.key === 'low_role_clarity');
  assert.equal(Number(rule.threshold_num), 2);

  // Editing the row changes the behaviour, with no release.
  await db.query(`UPDATE engagement.flag_rules SET threshold_num=4 WHERE tenant_id=$1 AND key='low_role_clarity'`, [tenantId]);
  const after = await api('/engagement/insights/flags', tok);
  const sal = after.body.people.find((p) => p.name === 'Sal Settling');
  assert.ok(sal && sal.flags.some((f) => f.key === 'low_role_clarity'),
    'Sal scored 3 at day 60 and is now flagged, because the threshold moved');
  await db.query(`UPDATE engagement.flag_rules SET threshold_num=2 WHERE tenant_id=$1 AND key='low_role_clarity'`, [tenantId]);

  // ...and switching a rule off silences it entirely.
  await db.query(`UPDATE engagement.flag_rules SET active=false WHERE tenant_id=$1 AND key='intent_to_leave'`, [tenantId]);
  const off = await api('/engagement/insights/flags', tok);
  assert.ok(!off.body.people.some((p) => p.flags.some((f) => f.key === 'intent_to_leave')));
  await db.query(`UPDATE engagement.flag_rules SET active=true WHERE tenant_id=$1 AND key='intent_to_leave'`, [tenantId]);
});
