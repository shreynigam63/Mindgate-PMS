// node --test — meetings for connects / mid-year / annual, and the
// KRA-wise summary of what was said.
//
// The client's instruction was "keep the provision for integrating Google
// Meet, we strictly do not have to connect it now", so the two things most
// worth asserting are that Google Meet is REFUSED — with a reason, not a
// crash — and that a transcript cannot be stored or summarised without the
// employee's consent. Both are properties that would be easy to lose in a
// later change and expensive to lose in production.
//
// The model is stubbed; what is tested is the gate and the gathering.
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, empId, mgrId, strangerId, cycleId, meetingId;
let captured = null;

const call = async (token, method, path, body) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mt';
  process.env.TENANT_SLUG = 'mt-test-' + Date.now();
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
    return { id: 'stub', created_at: new Date().toISOString(), draft: { by_kra: [], cross_cutting: {}, kras_not_discussed: [], follow_up_needed: [] } };
  };

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'MT Mgr','mt-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'MT Emp','mt-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const s = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'MT Stranger','mt-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  strangerId = s.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'mt-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['mt-mgr@x.com', 'mt-emp@x.com', 'mt-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'MT Cycle','FYMT','annual','mid_year_review') RETURNING id`,
    [t.id])).rows[0];
  cycleId = cycle.id;
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
    [t.id, cycle.id, empId, mgrId])).rows[0];
  await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'On-Time Delivery',100,10)`,
    [t.id, sheet.id]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  app.use('/api/v1/consent', require('../core/consent').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (!HAS_DB) return; server.close(); await db.pool.end(); });

async function login(email) {
  const r = await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  });
  return (await r.json()).token;
}

test('providers list names Google Meet as unavailable, with a reason — it is not hidden', { skip }, async () => {
  const token = await login('mt-emp@x.com');
  const r = await call(token, 'GET', '/pms/meetings/providers');
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.body.providers.map((p) => [p.id, p]));
  assert.equal(byId.manual.available, true);
  assert.equal(byId.google_meet.available, false);
  assert.match(byId.google_meet.unavailable_reason, /not connected/i);
  assert.equal(byId.google_meet.captures_transcripts, true, 'the capability is declared even though it is off');
});

test('asking for Google Meet is refused with 501 and the reason, not a crash', { skip }, async () => {
  const token = await login('mt-emp@x.com');
  const r = await call(token, 'POST', '/pms/meetings', {
    context: 'midyear', provider: 'google_meet', meeting_url: 'https://meet.google.com/abc-defg-hij' });
  // 501, not 400: the request is well-formed and will be valid once the
  // integration exists. Telling the caller they got it wrong would be a lie.
  assert.equal(r.status, 501);
  assert.match(r.body.error, /not connected/i);
  const none = await db.query(`SELECT count(*)::int AS n FROM pms.review_meetings WHERE tenant_id=$1`, [tenantId]);
  assert.equal(none.rows[0].n, 0, 'and nothing is written');
});

test('a pasted link works today, for each of the three contexts', { skip }, async () => {
  const token = await login('mt-emp@x.com');
  for (const context of ['connect', 'midyear', 'annual']) {
    const r = await call(token, 'POST', '/pms/meetings', { context, meeting_url: `https://meet.google.com/${context}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.meeting.provider, 'manual');
    if (context === 'midyear') meetingId = r.body.meeting.id;
  }
  const bad = await call(token, 'POST', '/pms/meetings', { context: 'quarterly', meeting_url: 'https://x.test' });
  assert.equal(bad.status, 400);
  const notALink = await call(token, 'POST', '/pms/meetings', { context: 'midyear', meeting_url: 'meet.google.com/x' });
  assert.equal(notALink.status, 400, 'a bare hostname is not a link anyone can click');
});

test('the manager can see and add the meeting; an unrelated employee cannot', { skip }, async () => {
  const mgrToken = await login('mt-mgr@x.com');
  const mine = await call(mgrToken, 'GET', `/pms/meetings?employee_id=${empId}&context=midyear`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.meetings.length, 1);

  const strangerToken = await login('mt-stranger@x.com');
  const nope = await call(strangerToken, 'GET', `/pms/meetings?employee_id=${empId}`);
  assert.equal(nope.status, 403);
  const nopeWrite = await call(strangerToken, 'POST', '/pms/meetings', {
    employee_id: empId, context: 'midyear', meeting_url: 'https://x.test/y' });
  assert.equal(nopeWrite.status, 403);
});

test('a transcript cannot be stored without the employee’s consent', { skip }, async () => {
  const mgrToken = await login('mt-mgr@x.com');
  const r = await call(mgrToken, 'PUT', `/pms/meetings/${meetingId}/transcript`, { content: 'We discussed the release.' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /consent/i);
  const none = await db.query(`SELECT count(*)::int AS n FROM pms.meeting_transcripts WHERE tenant_id=$1`, [tenantId]);
  assert.equal(none.rows[0].n, 0);
});

test('the manager cannot grant that consent on their report’s behalf', { skip }, async () => {
  // A consent a manager can grant for someone else is not consent.
  const mgrToken = await login('mt-mgr@x.com');
  const r = await call(mgrToken, 'PUT', '/consent/me', { consent_type: 'meeting_ai_insights', granted: true, employee_id: empId });
  // Whatever the route does with the extra field, it must not end up
  // granting for the employee.
  const granted = await db.query(
    `SELECT granted FROM core.employee_consents WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empId]);
  assert.ok(!granted.rows[0] || granted.rows[0].granted === false,
    `manager's call must not grant for the employee (status ${r.status})`);
});

test('with consent, the transcript stores and the summary is organised by KRA', { skip }, async () => {
  const empToken = await login('mt-emp@x.com');
  const grant = await call(empToken, 'PUT', '/consent/me', { consent_type: 'meeting_ai_insights', granted: true });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  const mgrToken = await login('mt-mgr@x.com');
  const put = await call(mgrToken, 'PUT', `/pms/meetings/${meetingId}/transcript`, {
    content: 'Manager: the August release landed on time. Employee: vendor sign-off is still blocking the next one.' });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  captured = null;
  const sum = await call(mgrToken, 'POST', '/agentic/meeting-summary', { meeting_id: meetingId });
  assert.equal(sum.status, 200, JSON.stringify(sum.body));
  assert.equal(captured.kind, 'meeting_summary');
  assert.match(captured.input.transcript, /vendor sign-off/);
  assert.equal(captured.input.kras[0].title, 'On-Time Delivery');
  assert.match(captured.system, /Never suggest, imply or hint at a rating/);
  assert.match(captured.system, /never paragraphs/i);
  // The consent that allowed capture is recorded ON the row, so a later
  // revocation cannot make this look like it was taken without permission.
  const row = await db.query(`SELECT consent_employee_id, consent_checked_at FROM pms.meeting_transcripts WHERE meeting_id=$1`, [meetingId]);
  assert.equal(row.rows[0].consent_employee_id, empId);
  assert.ok(row.rows[0].consent_checked_at);
});

test('revoking consent stops the summary, and leaves the record of the meeting alone', { skip }, async () => {
  const empToken = await login('mt-emp@x.com');
  await call(empToken, 'PUT', '/consent/me', { consent_type: 'meeting_ai_insights', granted: false });

  const mgrToken = await login('mt-mgr@x.com');
  const sum = await call(mgrToken, 'POST', '/agentic/meeting-summary', { meeting_id: meetingId });
  assert.equal(sum.status, 403, 'consent is re-checked at use, not assumed from the row existing');

  const still = await db.query(`SELECT count(*)::int AS n FROM pms.meeting_transcripts WHERE meeting_id=$1`, [meetingId]);
  assert.equal(still.rows[0].n, 1, 'the meeting happened — the record stays, only the AI use stops');
  await call(empToken, 'PUT', '/consent/me', { consent_type: 'meeting_ai_insights', granted: true });
});

test('summarising a meeting with no transcript says so, rather than inventing one', { skip }, async () => {
  const empToken = await login('mt-emp@x.com');
  const made = await call(empToken, 'POST', '/pms/meetings', { context: 'annual', meeting_url: 'https://x.test/empty' });
  const r = await call(empToken, 'POST', '/agentic/meeting-summary', { meeting_id: made.body.meeting.id });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No transcript is stored/);
});

test('an unrelated employee cannot read the transcript or its summary', { skip }, async () => {
  const strangerToken = await login('mt-stranger@x.com');
  assert.equal((await call(strangerToken, 'GET', `/pms/meetings/${meetingId}/transcript`)).status, 403);
  assert.equal((await call(strangerToken, 'POST', '/agentic/meeting-summary', { meeting_id: meetingId })).status, 403);
});

test('deleting a meeting takes its transcript with it', { skip }, async () => {
  const empToken = await login('mt-emp@x.com');
  assert.equal((await call(empToken, 'DELETE', `/pms/meetings/${meetingId}`)).status, 200);
  const left = await db.query(`SELECT count(*)::int AS n FROM pms.meeting_transcripts WHERE meeting_id=$1`, [meetingId]);
  assert.equal(left.rows[0].n, 0, 'ON DELETE CASCADE — no orphan recording of a conversation');
});
