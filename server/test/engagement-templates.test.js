// node --test — the survey library (phase 3, 25 Sep).
//
// "I would create a Survey Library" — so HR picks "Day 30 Connect"
// instead of typing twenty questions. The library only earns its place
// if it makes Mindgate's own rule true in practice:
//
//   "The most important point: don't ask the same questions at
//    30/60/90. The employee's questions should evolve with tenure."
//
// Typed by hand, five milestones become five copies of whatever was
// written first. Most of what is asserted below is therefore about the
// CONTENT being genuinely different per milestone, not just about the
// plumbing working.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { TEMPLATES, validateTemplates } = require('../modules/engagement/templates');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;

// ---- content, which needs no database --------------------------------
test('every shipped template passes the same validation the importer applies', () => {
  // This runs in the migration too, so a typo fails the boot rather
  // than reaching 1,400 people. Asserted here as well, because the
  // migration only runs on a deploy.
  assert.deepEqual(validateTemplates(), []);
});

test('the five lifecycle milestones are all present and each is a window', () => {
  const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
  for (const k of ['day_1', 'week_1', 'day_30', 'day_60', 'day_90']) {
    assert.ok(byKey[k], `${k} is in the library`);
    assert.equal(byKey[k].trigger_type, 'tenure', `${k} is a lifecycle survey`);
    assert.ok(byKey[k].trigger_window_days >= 1, `${k} has a catch-up window`);
  }
  assert.deepEqual(['day_1', 'week_1', 'day_30', 'day_60', 'day_90'].map((k) => byKey[k].trigger_day),
    [0, 5, 30, 60, 90]);
});

test('THE POINT: the milestones do not ask the same questions', () => {
  // The failure this library exists to prevent. If Day 30 and Day 60
  // were near-copies, the longitudinal data would be four readings of
  // one survey rather than a progression.
  const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
  const prompts = (k) => new Set(byKey[k].questions.map((q) => q.prompt.toLowerCase()));
  const overlap = (a, b) => {
    const [x, y] = [prompts(a), prompts(b)];
    const shared = [...x].filter((p) => y.has(p)).length;
    return shared / Math.min(x.size, y.size);
  };
  for (const [a, b] of [['day_1', 'week_1'], ['week_1', 'day_30'], ['day_30', 'day_60'], ['day_60', 'day_90']]) {
    const o = overlap(a, b);
    assert.ok(o < 0.35, `${a} and ${b} share ${Math.round(o * 100)}% of their questions — that is four copies of one survey`);
  }
  // And each milestone asks its own question, per the spec's framing:
  // welcomed -> oriented -> understanding the role -> productive ->
  // contributing and seeing a future.
  assert.match([...prompts('day_1')].join(' '), /welcomed/);
  assert.match([...prompts('week_1')].join(' '), /right decision in joining/);
  assert.match([...prompts('day_30')].join(' '), /preventing you from becoming fully productive/);
  assert.match([...prompts('day_60')].join(' '), /capability would help you become significantly more effective/);
  assert.match([...prompts('day_90')].join(' '), /current level of productivity/);
});

test('the blocker taxonomy is identical at 30 and 60, so the two are comparable', () => {
  // A different option list at each milestone would make the trend
  // uncomparable — the one thing a 30/60/90 sequence is for.
  const opts = (k, re) => {
    const t = TEMPLATES.find((x) => x.key === k);
    const q = t.questions.find((x) => re.test(x.prompt));
    return q && q.options;
  };
  const a = opts('day_30', /preventing you from becoming fully productive/);
  const b = opts('day_60', /affecting your productivity/);
  assert.ok(a && b);
  assert.deepEqual(a, b);
  assert.ok(a.includes('No significant blocker'), 'and "no blocker" is offered, or the data over-reports problems');
});

test('the onboarding templates are attributed, the pulse ones anonymous', () => {
  // Mindgate's spec wants a per-employee 30/60/90 trend and a named
  // retention warning; both need attributed answers. A pulse survey
  // that is not anonymous collects nothing worth having.
  const byKey = Object.fromEntries(TEMPLATES.map((t) => [t.key, t]));
  for (const k of ['day_1', 'week_1', 'day_30', 'day_60', 'day_90']) {
    assert.equal(byKey[k].anonymity_default, false, `${k} must be attributed to be actionable`);
  }
  for (const k of ['quarterly_pulse', 'annual_engagement', 'manager_effectiveness']) {
    assert.equal(byKey[k].anonymity_default, true, `${k} must be anonymous to be honest`);
  }
});

test('a template that cannot be released here says why, instead of pretending', () => {
  // Preboarding is real and wanted, but on this master nobody exists
  // before their joining date and a pre-joiner has no login. Shipping
  // it as a standing trigger would ship a survey that silently never
  // fires.
  const pre = TEMPLATES.find((t) => t.key === 'preboarding');
  assert.ok(pre, 'preboarding is in the library');
  assert.equal(pre.trigger_type, 'manual', 'not a lifecycle trigger it cannot honour');
  assert.match(pre.blocked_reason, /before their joining date/i);
  assert.match(pre.blocked_reason, /no login/i);
  // Nothing else claims to be blocked.
  assert.deepEqual(TEMPLATES.filter((t) => t.blocked_reason).map((t) => t.key), ['preboarding']);
});

test('no template asks a question the engine cannot render', () => {
  const OK = new Set(['scale', 'enps', 'text', 'choice', 'multi']);
  for (const t of TEMPLATES) {
    for (const q of t.questions) {
      assert.ok(OK.has(q.qtype), `${t.key}: "${q.prompt.slice(0, 40)}" is qtype ${q.qtype}`);
    }
  }
});

// ---- the library over HTTP -------------------------------------------
before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tpl';
  process.env.TENANT_SLUG = 'tpl-test-' + Date.now();
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
  const doj = new Date(); doj.setUTCDate(doj.getUTCDate() - 33);
  await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department, date_of_joining)
    VALUES ($1,'Tpl Admin','tpl-admin@x.com','active','HR',$2),
           ($1,'Tpl New','tpl-new@x.com','active','Development',$2)`, [t.id, doj.toISOString().slice(0, 10)]);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'tpl-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['tpl-admin@x.com', 'tpl-new@x.com']) {
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

test('the library is seeded for a new tenant, with its categories', { skip }, async () => {
  const tok = await login('tpl-admin@x.com');
  const r = await api('/engagement/templates', tok);
  assert.equal(r.status, 200);
  assert.equal(r.body.templates.length, TEMPLATES.length);
  const cats = [...new Set(r.body.templates.map((x) => x.category))];
  for (const c of ['Onboarding', 'New Hire Listening', 'Engagement', 'Development', 'Retention', 'Exit']) {
    assert.ok(cats.includes(c), `the ${c} category is in the library`);
  }
  const d30 = r.body.templates.find((x) => x.key === 'day_30');
  assert.equal(d30.question_count, TEMPLATES.find((t) => t.key === 'day_30').questions.length);
  assert.equal(d30.used, 0, 'nothing has been run from it yet');
  assert.equal(d30.trigger_day, 30);
});

test('only an engagement admin may read the library or use it', { skip }, async () => {
  const stranger = await login('tpl-new@x.com');
  assert.equal((await api('/engagement/templates', stranger)).status, 403);
  assert.equal((await api('/engagement/templates/day_30/use', stranger, { method: 'POST', body: '{}' })).status, 403);
});

test('using a template makes a DRAFT — twenty questions, nobody invited', { skip }, async () => {
  const tok = await login('tpl-admin@x.com');
  const r = await api('/engagement/templates/day_30/use', tok, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.survey.status, 'draft', 'a template never releases anything by itself');
  assert.equal(r.body.survey.template_key, 'day_30', 'and the survey remembers where it came from');
  assert.equal(r.body.survey.trigger_type, 'tenure');
  assert.equal(r.body.survey.trigger_day, 30);
  assert.equal(r.body.survey.anonymity_default, false);

  const qs = (await api(`/engagement/surveys/${r.body.survey.id}/questions`, tok)).body.questions;
  assert.equal(qs.length, TEMPLATES.find((t) => t.key === 'day_30').questions.length);
  // The choice question arrives WITH its options — the thing that was
  // broken until 25 Sep.
  const blocker = qs.find((q) => /preventing you from becoming fully productive/.test(q.prompt));
  assert.ok(blocker, 'the blocker question came across');
  assert.equal(blocker.qtype, 'choice');
  assert.ok(blocker.options.length >= 10, `with its option list — got ${JSON.stringify(blocker.options)}`);

  const inv = +(await db.query(`SELECT count(*)::int c FROM engagement.invitations WHERE survey_id=$1`,
    [r.body.survey.id])).rows[0].c;
  assert.equal(inv, 0, 'a draft invites nobody');
});

test('the audience and milestone can be set while using the template', { skip }, async () => {
  // "Day 30 Connect, Development only" is one decision, not two screens.
  const tok = await login('tpl-admin@x.com');
  const r = await api('/engagement/templates/day_60/use', tok, { method: 'POST', body: JSON.stringify({
    title: 'Day 60 — Development', audience_rule: { departments: ['Development'] },
    trigger_window_days: 10 }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.survey.title, 'Day 60 — Development');
  assert.deepEqual(r.body.survey.audience_rule.departments, ['Development']);
  assert.equal(r.body.survey.trigger_day, 60, 'the milestone came from the template');
  assert.equal(r.body.survey.trigger_window_days, 10, 'the window was overridden');
});

test('a nonsense override is refused rather than saved as a survey that never fires', { skip }, async () => {
  const tok = await login('tpl-admin@x.com');
  const r = await api('/engagement/templates/quarterly_pulse/use', tok,
    { method: 'POST', body: JSON.stringify({ trigger_type: 'tenure' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /needs a milestone/);
});

test('an unknown template is a 404, not an empty survey', { skip }, async () => {
  const tok = await login('tpl-admin@x.com');
  const r = await api('/engagement/templates/not_a_template/use', tok, { method: 'POST', body: '{}' });
  assert.equal(r.status, 404);
});

test('the library counts how often each template has been used', { skip }, async () => {
  const tok = await login('tpl-admin@x.com');
  const r = await api('/engagement/templates', tok);
  const by = Object.fromEntries(r.body.templates.map((x) => [x.key, x.used]));
  assert.equal(by.day_30, 1);
  assert.equal(by.day_60, 1);
  assert.equal(by.day_90, 0, 'one nobody has run yet reads zero');
});

test('a template edited by the tenant survives a re-seed', { skip }, async () => {
  // The house rule: clients configure, they never fork. A re-seed on
  // the next deploy must not overwrite their wording.
  const { seedTemplates } = require('../migrations/056-survey-templates');
  await db.query(`UPDATE engagement.survey_templates SET title='Our own 30-day chat'
                   WHERE tenant_id=$1 AND key='day_30'`, [tenantId]);
  const inserted = await seedTemplates(db, tenantId);
  assert.equal(inserted, 0, 'a re-seed inserts nothing that is already there');
  const after = (await db.query(`SELECT title FROM engagement.survey_templates
                                  WHERE tenant_id=$1 AND key='day_30'`, [tenantId])).rows[0];
  assert.equal(after.title, 'Our own 30-day chat', 'their edit stands');

  // ...and a template they deleted stays deleted rather than coming
  // back on every deploy.
  await db.query(`UPDATE engagement.survey_templates SET active=false
                   WHERE tenant_id=$1 AND key='exit'`, [tenantId]);
  await seedTemplates(db, tenantId);
  const gone = (await db.query(`SELECT active FROM engagement.survey_templates
                                 WHERE tenant_id=$1 AND key='exit'`, [tenantId])).rows[0];
  assert.equal(gone.active, false);
  const tok = await login('tpl-admin@x.com');
  assert.ok(!(await api('/engagement/templates', tok)).body.templates.some((x) => x.key === 'exit'));
});

test('using a template is audited', { skip }, async () => {
  const rows = (await db.query(
    `SELECT details FROM core.audit_log WHERE tenant_id=$1 AND action='SURVEY_CREATED_FROM_TEMPLATE'`,
    [tenantId])).rows;
  assert.ok(rows.length >= 2);
  assert.ok(rows.some((r) => r.details.template === 'day_30' && r.details.questions > 10),
    'and the entry names the template and how much came with it');
});

test('a survey made from a template releases like any other', { skip }, async () => {
  // The whole point: the library is a shortcut to the same object, not
  // a second kind of survey with its own rules.
  const tok = await login('tpl-admin@x.com');
  const s = (await api('/engagement/templates/day_30/use', tok,
    { method: 'POST', body: JSON.stringify({ title: 'Release me' }) })).body.survey;
  const open = await api(`/engagement/surveys/${s.id}/open`, tok, { method: 'POST' });
  assert.equal(open.status, 200);
  assert.equal(open.body.standing, true, 'it is a lifecycle survey');
  assert.equal(open.body.invited, 2, 'both fixtures joined 33 days ago, inside the 30-37 window');
  assert.match(open.body.audience, /joined between 30 and 37 days ago/);
});
