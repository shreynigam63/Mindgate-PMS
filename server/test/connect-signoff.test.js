// node --test — Manager sign-off on Quarterly Connect (BR-4.3), found
// missing during a full BRD re-audit. Real Postgres, skips cleanly
// without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, strangerId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-signoff';
  process.env.TENANT_SLUG = 'signoff-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SO Mgr','so-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'SO Emp','so-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'SO Stranger','so-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  strangerId = stranger.id;
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'so-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['so-mgr@x.com', 'so-emp@x.com', 'so-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/notifications', require('../core/notifications').router);
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
  return r.json();
}
async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

test('connect sign-off: a logged connect starts unsigned, manager can sign it off, employee is notified', { skip }, async () => {
  const mgrAuth = await login('so-mgr@x.com');
  const empAuth = await login('so-emp@x.com');

  const created = await api('/pms/connects', mgrAuth.token, { method: 'POST', body: JSON.stringify({ employee_id: empId, held_at: '2026-09-01', notes: 'good chat' }) });
  assert.equal(created.status, 200);

  const list = await api('/pms/connects', mgrAuth.token);
  const cn = list.body.connects[0];
  assert.equal(cn.signed_off, false, 'not signed off at creation');

  const signOff = await api(`/pms/connects/${cn.id}/sign-off`, mgrAuth.token, { method: 'POST' });
  assert.equal(signOff.status, 200);

  const list2 = await api('/pms/connects', mgrAuth.token);
  assert.equal(list2.body.connects[0].signed_off, true);
  assert.ok(list2.body.connects[0].signed_off_at);

  const empNotifs = await api('/notifications', empAuth.token);
  assert.ok(empNotifs.body.notifications.some((n) => n.kind === 'connect_signed_off'));
});

test('connect sign-off: cannot sign off twice, and an unrelated manager cannot sign someone else\'s connect', { skip }, async () => {
  const mgrAuth = await login('so-mgr@x.com');
  const strangerAuth = await login('so-stranger@x.com');
  const list = await api('/pms/connects', mgrAuth.token);
  const cn = list.body.connects[0];

  const again = await api(`/pms/connects/${cn.id}/sign-off`, mgrAuth.token, { method: 'POST' });
  assert.equal(again.status, 409);

  const created2 = await api('/pms/connects', mgrAuth.token, { method: 'POST', body: JSON.stringify({ employee_id: empId, held_at: '2026-10-01', notes: 'another chat' }) });
  const list2 = await api('/pms/connects', mgrAuth.token);
  const newCn = list2.body.connects.find((c) => c.notes === 'another chat');
  const wrongUser = await api(`/pms/connects/${newCn.id}/sign-off`, strangerAuth.token, { method: 'POST' });
  assert.equal(wrongUser.status, 403);
});

// Requested with a reference screenshot: Date/Duration/Topic/"What was
// discussed?" as their own fields, separate from the derived Achievements/
// Blockers/Feedback (migration 017).
test('connect: duration, topic, and discussion notes round-trip through create and list', { skip }, async () => {
  const mgrAuth = await login('so-mgr@x.com');
  const created = await api('/pms/connects', mgrAuth.token, {
    method: 'POST',
    body: JSON.stringify({
      employee_id: empId, held_at: '2026-11-01', duration_min: 30, topic: 'Mid-quarter check-in',
      discussion_notes: 'Discussed the Q3 launch timeline and blockers with legal.',
      achievements: 'Shipped the beta', blockers: 'Waiting on legal sign-off', feedback: 'Keep pushing on the timeline',
    }),
  });
  assert.equal(created.status, 200);

  const list = await api('/pms/connects', mgrAuth.token);
  const cn = list.body.connects.find((c) => c.topic === 'Mid-quarter check-in');
  assert.ok(cn, 'the new connect should be in the list');
  assert.equal(cn.duration_min, 30);
  assert.equal(cn.discussion_notes, 'Discussed the Q3 launch timeline and blockers with legal.');
  assert.equal(cn.achievements, 'Shipped the beta');
  assert.equal(cn.blockers, 'Waiting on legal sign-off');
  assert.equal(cn.feedback, 'Keep pushing on the timeline');
});

// Requested with the same reference screenshot: a "+ Add" action-items
// list built up while logging the connect (migration 018).
test('connect: action items are saved with the connect and can be toggled done independently', { skip }, async () => {
  const mgrAuth = await login('so-mgr@x.com');
  const created = await api('/pms/connects', mgrAuth.token, {
    method: 'POST',
    body: JSON.stringify({
      employee_id: empId, held_at: '2026-11-15', topic: 'Action items test',
      action_items: [{ description: 'Follow up with legal', due_date: '2026-11-22' }, { description: 'Share timeline doc' }],
    }),
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.id, 'create response includes the new connect id');

  const list = await api('/pms/connects', mgrAuth.token);
  const cn = list.body.connects.find((c) => c.topic === 'Action items test');
  assert.equal(cn.action_items.length, 2);
  assert.equal(cn.action_items[0].description, 'Follow up with legal');
  assert.equal(cn.action_items[0].due_date, '2026-11-22');
  assert.equal(cn.action_items[0].done, false);

  const toggle = await api(`/pms/connects/${cn.id}/action-items/${cn.action_items[0].id}`, mgrAuth.token, {
    method: 'PUT', body: JSON.stringify({ done: true }),
  });
  assert.equal(toggle.status, 200);

  const list2 = await api('/pms/connects', mgrAuth.token);
  const cn2 = list2.body.connects.find((c) => c.topic === 'Action items test');
  assert.equal(cn2.action_items[0].done, true, 'toggled item stays done');
  assert.equal(cn2.action_items[1].done, false, 'the other item is untouched');

  // An unrelated manager cannot toggle someone else's connect's action item.
  const strangerAuth = await login('so-stranger@x.com');
  const blocked = await api(`/pms/connects/${cn.id}/action-items/${cn.action_items[1].id}`, strangerAuth.token, {
    method: 'PUT', body: JSON.stringify({ done: true }),
  });
  assert.equal(blocked.status, 403);
});

// Requested alongside action items: the "Connect Cadence / Progress this
// cycle / Next due" header, backed by GET /connects/cadence/:employeeId.
test('connect cadence: computes expected/logged/next-due for a specific report, blocks an unrelated manager', { skip }, async () => {
  const mgrAuth = await login('so-mgr@x.com');
  const strangerAuth = await login('so-stranger@x.com');

  const r = await api(`/pms/connects/cadence/${empId}`, mgrAuth.token);
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.expected_total, 'number');
  assert.equal(typeof r.body.logged_count, 'number');
  assert.ok(r.body.next_due);

  const blocked = await api(`/pms/connects/cadence/${empId}`, strangerAuth.token);
  assert.equal(blocked.status, 403);
});

// Requested: an employee should be able to log their own 1-on-1
// discussion — previously POST /connects required pms_team_eval
// unconditionally, so a plain employee had no way to satisfy "Employee
// and date are required" at all (the "Select report" dropdown came from
// a pms_team_eval-gated endpoint and was always empty for them).
test('connect: an employee can self-log a connect without pms_team_eval, correctly attributed to their real manager', { skip }, async () => {
  const empAuth = await login('so-emp@x.com');
  const created = await api('/pms/connects', empAuth.token, {
    method: 'POST',
    body: JSON.stringify({ employee_id: empId, held_at: '2026-12-01', topic: 'Self-logged check-in', discussion_notes: 'Discussed my own progress with my manager.' }),
  });
  assert.equal(created.status, 200, 'no special permission required to log about yourself');

  const mgrAuth = await login('so-mgr@x.com');
  const list = await api('/pms/connects', mgrAuth.token);
  const cn = list.body.connects.find((c) => c.topic === 'Self-logged check-in');
  assert.ok(cn, 'the self-logged connect shows up in the real manager\'s list too');
  assert.equal(cn.logged_by_id, empId, 'logged_by_id records who actually submitted it');
});

test('connect: self-logging fails cleanly for someone with no manager on record', { skip }, async () => {
  const strangerAuth = await login('so-stranger@x.com'); // has no manager_id set
  const created = await api('/pms/connects', strangerAuth.token, {
    method: 'POST',
    body: JSON.stringify({ employee_id: strangerId, held_at: '2026-12-01', topic: 'No manager' }),
  });
  assert.equal(created.status, 422);
  assert.match(created.body.error, /no manager on record/);
});

// Requested: an employee should be able to see AI insights on their own
// logged connects, not just their manager. Only the pre-AI-call guard is
// tested here (no ANTHROPIC_API_KEY in this sandbox), same convention as
// connect-insights.test.js.
test('connect-insights: an employee can request insights about themselves without pms_team_eval', { skip }, async () => {
  const empAuth = await login('so-emp@x.com');
  const r = await api('/agentic/connect-insights', empAuth.token, { method: 'POST', body: JSON.stringify({ employee_id: empId }) });
  assert.notEqual(r.status, 403, 'self-view must not be blocked by the pms_team_eval guard');
});
