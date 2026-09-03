// node --test — the HR-only AI analysis of an annual review meeting,
// against the seven organisational parameters.
//
// This feature is a confidential assessment of a named person, derived
// from a recording, that the person cannot see. Almost everything worth
// testing is therefore about restraint rather than output:
//
//   - the employee, their manager and a Delivery Head are all refused
//   - it does not run without the employee's recorded consent
//   - it mints no rating, and stripRatingSuggestions is not what saves us
//   - a parameter the conversation missed comes back as not_discussed
//     against the real configured row, rather than vanishing
//   - the weightage is the configured number, never the model's
//   - reads are audited, not just writes
//   - the employee's own data export does not contain it; HR's does
//
// The model is stubbed: what it writes is not testable, what the endpoint
// does with what it writes is.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, hodId, meetingId, params;
let captured = null;
let stubDraft = null;

const api = async (path, token, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pa';
  process.env.TENANT_SLUG = 'pa-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const ai = require('../core/ai');
  ai.narrate = async (args) => {
    captured = args;
    return { id: '22222222-2222-4222-8222-222222222222', created_at: new Date().toISOString(), draft: stubDraft };
  };

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await require('../migrations/008-review-parameters').ensureDefaultParameters(db, t.id);

  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PA HR','pa-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PA Mgr','pa-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const hod = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'PA Hod','pa-hod@x.com','active') RETURNING id`, [t.id])).rows[0];
  hodId = hod.id;
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, manager_id, department) VALUES ($1,'PA Emp','pa-emp@x.com','active',$2,'Engineering') RETURNING id`,
    [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'pa-hr@x.com','hr'),($1,'pa-mgr@x.com','manager'),($1,'pa-hod@x.com','hod')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['pa-hr@x.com', 'pa-mgr@x.com', 'pa-hod@x.com', 'pa-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'PA Cycle','FYPA','annual','calibration') RETURNING id`,
    [t.id])).rows[0];
  cycleId = cycle.id;
  params = (await db.query(`SELECT id, name, weight_pct FROM pms.review_parameters WHERE tenant_id=$1 ORDER BY sort_order`, [t.id])).rows;

  // The manager's real scores on two parameters — what the official rating
  // is built from, and what the analysis is shown next to.
  await db.query(
    `INSERT INTO pms.parameter_scores (tenant_id, cycle_id, employee_id, parameter_id, score, scored_by, scored_by_role)
     VALUES ($1,$2,$3,$4,5,'pa-mgr@x.com','manager'), ($1,$2,$3,$5,2,'pa-mgr@x.com','manager')`,
    [t.id, cycle.id, empId, params[0].id, params[1].id]);

  const m = (await db.query(
    `INSERT INTO pms.review_meetings (tenant_id, cycle_id, employee_id, context, provider, meeting_url, created_by)
     VALUES ($1,$2,$3,'annual','manual','https://meet.google.com/annual-review',$4) RETURNING id`,
    [t.id, cycle.id, empId, hr.id])).rows[0];
  meetingId = m.id;

  // The model's reply: two parameters covered, the rest untouched — which
  // is what a real hour-long conversation looks like.
  stubDraft = {
    by_parameter: [
      { parameter: params[0].name, signal: 'strong', summary: ['Delivered the platform migration on plan'], evidence: ['Manager: the migration landed in March'], alignment: ['Followed the change-approval process throughout'] },
      { parameter: params[1].name, signal: 'concern', summary: ['Two escalations reached the client unflagged'], evidence: ['Employee: I should have raised those sooner'], alignment: [] },
      { parameter: 'A Parameter Nobody Configured', signal: 'strong', summary: ['Invented'], evidence: ['nope'], alignment: [] },
    ],
    went_well: ['The migration'], went_wrong: ['Escalation handling'],
    improvement_areas: ['Raise risks earlier'], achievements: ['Platform migration delivered'],
    meeting_gaps: ['Career direction never came up'],
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/consent', require('../core/consent').router);
  app.use('/api/v1/gdpr', require('../core/gdpr').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (!HAS_DB) return; server.close(); await db.pool.end(); });

async function login(email) {
  const r = await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }),
  });
  return (await r.json()).token;
}

const RUN = (token) => api('/agentic/parameter-analysis', token, { method: 'POST', body: JSON.stringify({ meeting_id: meetingId }) });

test('the employee it is about cannot run it or read it', { skip }, async () => {
  const token = await login('pa-emp@x.com');
  const run = await RUN(token);
  assert.equal(run.status, 403);
  assert.match(run.body.error, /HR only/i);
  assert.equal((await api(`/agentic/parameter-analysis?employee_id=${empId}`, token)).status, 403);
  assert.equal((await api('/agentic/parameter-analysis/index', token)).status, 403);
});

test('their MANAGER cannot either — that is the point of the feature', { skip }, async () => {
  // The manager sat in the meeting and has pms_team_eval over this person.
  // Neither grants them this.
  const token = await login('pa-mgr@x.com');
  assert.equal((await RUN(token)).status, 403);
  assert.equal((await api(`/agentic/parameter-analysis?employee_id=${empId}`, token)).status, 403);
});

test('a Delivery Head cannot either — pms_hod is not pms_admin', { skip }, async () => {
  const token = await login('pa-hod@x.com');
  assert.equal((await RUN(token)).status, 403);
});

test('a transcript cannot even be stored without consent, so the analysis has nothing to read', { skip }, async () => {
  // Storing the transcript is itself consent-gated (BRD §6), so with no
  // consent on record the analysis is starved at source rather than
  // refused at the end.
  const token = await login('pa-hr@x.com');
  const put = await api(`/pms/meetings/${meetingId}/transcript`, token, {
    method: 'PUT', body: JSON.stringify({ content: 'HR: shall we start.' }),
  });
  assert.equal(put.status, 403);
  assert.match(put.body.error, /consent/i);

  const r = await RUN(token);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No transcript is stored/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.parameter_ai_analyses WHERE tenant_id=$1`, [tenantId])).rows[0].n, 0);
});

test('REVOKING consent stops the analysis, even though the transcript is already there', { skip }, async () => {
  // The case the re-check at use actually exists for. Consent was given
  // when the meeting was captured; withdrawing it withdraws permission
  // for precisely this use of the recording.
  const empToken = await login('pa-emp@x.com');
  const hrToken = await login('pa-hr@x.com');
  await api('/consent/me', empToken, { method: 'PUT', body: JSON.stringify({ granted: true }) });
  await api(`/pms/meetings/${meetingId}/transcript`, hrToken, {
    method: 'PUT', body: JSON.stringify({ content: 'HR: shall we start. Manager: the migration landed in March.' }),
  });
  await api('/consent/me', empToken, { method: 'PUT', body: JSON.stringify({ granted: false }) });

  const r = await RUN(hrToken);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /consent/i);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.parameter_ai_analyses WHERE tenant_id=$1`, [tenantId])).rows[0].n, 0,
    'and nothing was written');
  // The transcript itself stays — the meeting happened; only the AI use stops.
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.meeting_transcripts WHERE meeting_id=$1`, [meetingId])).rows[0].n, 1);
});

test('with consent it runs, and stitches to the CONFIGURED parameters', { skip }, async () => {
  const empToken = await login('pa-emp@x.com');
  await api('/consent/me', empToken, { method: 'PUT', body: JSON.stringify({ granted: true }) });
  const hrToken = await login('pa-hr@x.com');
  await api(`/pms/meetings/${meetingId}/transcript`, hrToken, {
    method: 'PUT', body: JSON.stringify({ content: 'HR: shall we start. Manager: the migration landed in March. Employee: I should have raised those escalations sooner.' }),
  });

  captured = null;
  const r = await RUN(hrToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(captured.kind, 'parameter_analysis');
  assert.match(captured.input.transcript, /migration landed in March/);

  // Every configured parameter comes back, in configured order — a real
  // meeting covers two or three, and the report has to show the rest as
  // untouched rather than omitting them.
  assert.equal(r.body.by_parameter.length, params.length);
  assert.deepEqual(r.body.by_parameter.map((p) => p.parameter), params.map((p) => p.name));

  const covered = r.body.by_parameter[0];
  assert.equal(covered.signal, 'strong');
  assert.deepEqual(covered.summary, ['Delivered the platform migration on plan']);
  assert.deepEqual(covered.alignment, ['Followed the change-approval process throughout']);

  const untouched = r.body.by_parameter[2];
  assert.equal(untouched.signal, 'not_discussed');
  assert.deepEqual(untouched.summary, []);
});

test('a parameter the model invented is discarded, not shown as real', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const r = await api(`/agentic/parameter-analysis?employee_id=${empId}`, token);
  const names = r.body.by_parameter.map((p) => p.parameter);
  assert.ok(!names.includes('A Parameter Nobody Configured'),
    'the report is the tenant’s parameter list, not whatever the model chose to name');
});

test('the weightage is the configured number, never the model’s', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const r = await api(`/agentic/parameter-analysis?employee_id=${empId}`, token);
  const configured = Object.fromEntries(params.map((p) => [p.name, Number(p.weight_pct)]));
  for (const p of r.body.by_parameter) assert.equal(p.weight_pct, configured[p.parameter], p.parameter);
  // And the model was never asked to compute anything with them.
  assert.match(captured.system, /never so it can|never produce a rating|NEVER PRODUCE A RATING/i);
});

test('the manager’s real scores travel with it, so the two are never confused', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const r = await api(`/agentic/parameter-analysis?employee_id=${empId}`, token);
  const byName = Object.fromEntries(r.body.by_parameter.map((p) => [p.parameter, p]));
  // Manager scored the first parameter 5 while the conversation read
  // "strong", and the second 2 while it read "concern" — the comparison
  // HR actually wants.
  assert.equal(byName[params[0].name].manager_score, 5);
  assert.equal(byName[params[0].name].signal, 'strong');
  assert.equal(byName[params[1].name].manager_score, 2);
  assert.equal(byName[params[1].name].signal, 'concern');
  assert.equal(byName[params[2].name].manager_score, null, 'unscored is null, not zero');
});

test('no rating is minted anywhere in the response', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const r = await api(`/agentic/parameter-analysis?employee_id=${empId}`, token);
  // Walk the whole payload: nothing that looks like an AI-produced rating
  // for a parameter or for the person. manager_score/self_score are the
  // HUMAN scores read from the database and are expected.
  const HUMAN = new Set(['manager_score', 'self_score']);
  const offenders = [];
  (function walk(o, path) {
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        if (/rating|score|grade|band/i.test(k) && !HUMAN.has(k)) offenders.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    }
  })(r.body, '');
  assert.deepEqual(offenders, [], 'the analysis must not carry a rating of its own');
  // And the prompt says so, rather than relying on stripRatingSuggestions
  // to catch it after the fact.
  assert.match(captured.system, /YOU NEVER PRODUCE A RATING/);
});

test('opening it is audited, not only running it', { skip }, async () => {
  const before = (await db.query(
    `SELECT count(*)::int AS n FROM pms.audit_log WHERE tenant_id=$1 AND action='PARAMETER_ANALYSIS_VIEWED'`, [tenantId])).rows[0].n;
  const token = await login('pa-hr@x.com');
  await api(`/agentic/parameter-analysis?employee_id=${empId}`, token);
  const rows = await db.query(
    `SELECT actor_email, employee_id FROM pms.audit_log WHERE tenant_id=$1 AND action='PARAMETER_ANALYSIS_VIEWED' ORDER BY id DESC LIMIT 1`, [tenantId]);
  const after = (await db.query(
    `SELECT count(*)::int AS n FROM pms.audit_log WHERE tenant_id=$1 AND action='PARAMETER_ANALYSIS_VIEWED'`, [tenantId])).rows[0].n;
  assert.equal(after, before + 1, 'a confidential report nobody can trace being read is unanswerable later');
  assert.equal(rows.rows[0].actor_email, 'pa-hr@x.com');
  assert.equal(rows.rows[0].employee_id, empId);
});

test('re-running replaces, so there is never a second contradictory hidden assessment', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  stubDraft = { ...stubDraft, went_well: ['Something else entirely'] };
  await RUN(token);
  const rows = await db.query(
    `SELECT overall FROM pms.parameter_ai_analyses WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empId]);
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(rows.rows[0].overall.went_well, ['Something else entirely']);
});

test('a mid-year or connect meeting is refused — this is the annual review', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const other = (await db.query(
    `INSERT INTO pms.review_meetings (tenant_id, cycle_id, employee_id, context, meeting_url) VALUES ($1,$2,$3,'midyear','https://x.test/m') RETURNING id`,
    [tenantId, cycleId, empId])).rows[0];
  const r = await api('/agentic/parameter-analysis', token, { method: 'POST', body: JSON.stringify({ meeting_id: other.id }) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /recorded as "midyear"/);
});

test('a meeting with no transcript says so rather than inventing a conversation', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const bare = (await db.query(
    `INSERT INTO pms.review_meetings (tenant_id, cycle_id, employee_id, context, meeting_url) VALUES ($1,$2,$3,'annual','https://x.test/bare') RETURNING id`,
    [tenantId, cycleId, mgrId])).rows[0];
  const r = await api('/agentic/parameter-analysis', token, { method: 'POST', body: JSON.stringify({ meeting_id: bare.id }) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No transcript is stored/);
});

test('the employee’s own data export does NOT contain it', { skip }, async () => {
  // "Not visible in the product" was the request, and the self-serve
  // export is part of the product.
  const token = await login('pa-emp@x.com');
  const r = await fetch(`${base}/api/v1/gdpr/export`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  assert.equal(r.status, 200);
  assert.equal(data.hr_only, undefined);
  assert.ok(!JSON.stringify(data).includes('platform migration'), 'no trace of the analysis anywhere in it');
  // The rest of their export still works — this is a carve-out, not a break.
  assert.ok(Array.isArray(data.review_meetings));
});

test('HR’s export of that employee DOES contain it, under hr_only', { skip }, async () => {
  // So a formal subject access request can be answered completely, by a
  // person who knows what they are releasing.
  const token = await login('pa-hr@x.com');
  const r = await fetch(`${base}/api/v1/gdpr/export/${empId}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();
  assert.equal(r.status, 200);
  const analyses = data.hr_only.annual_review_parameter_ai_analysis;
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].cycle_name, 'PA Cycle');
  assert.ok(JSON.stringify(analyses[0].entries).includes('platform migration'));
});

test('HR can retract one, and it is audited', { skip }, async () => {
  const token = await login('pa-hr@x.com');
  const row = (await db.query(`SELECT id FROM pms.parameter_ai_analyses WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empId])).rows[0];
  assert.equal((await api(`/agentic/parameter-analysis/${row.id}`, token, { method: 'DELETE' })).status, 200);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.parameter_ai_analyses WHERE id=$1`, [row.id])).rows[0].n, 0);
  const audited = await db.query(
    `SELECT count(*)::int AS n FROM pms.audit_log WHERE tenant_id=$1 AND action='PARAMETER_ANALYSIS_DELETED'`, [tenantId]);
  assert.equal(audited.rows[0].n, 1);
  assert.equal((await api(`/agentic/parameter-analysis?employee_id=${empId}`, token)).status, 404);
});
