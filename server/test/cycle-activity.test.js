// node --test — GET /cycles/:id/activity: a dedicated view of one cycle's
// own history. pms.audit_log already recorded every phase advance,
// rollback, and cancellation with who/when — this was the first thing
// that ever read it back, requested and confirmed after finding the
// table was write-only everywhere else too. Real Postgres, real HTTP
// surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, cycleId, otherCycleId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ca';
  process.env.TENANT_SLUG = 'ca-test-' + Date.now();
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

  const admin = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CA Admin','ca-admin@x.com','active') RETURNING id`, [t.id])).rows[0];
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CA Stranger','ca-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ca-admin@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['ca-admin@x.com', 'ca-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'CA Cycle','FYCA','annual','draft') RETURNING id`, [t.id])).rows[0];
  cycleId = cycle.id;
  const otherCycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'CA Other','FYCA2','annual','draft') RETURNING id`, [t.id])).rows[0];
  otherCycleId = otherCycle.id;

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
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

test('activity requires admin, 404s on an unknown cycle, empty for a cycle with no events yet', { skip }, async () => {
  const strangerAuth = await login('ca-stranger@x.com');
  const blocked = await api(`/pms/cycles/${cycleId}/activity`, strangerAuth.token);
  assert.equal(blocked.status, 403);

  const adminAuth = await login('ca-admin@x.com');
  const missing = await api(`/pms/cycles/00000000-0000-0000-0000-000000000000/activity`, adminAuth.token);
  assert.equal(missing.status, 404);

  const empty = await api(`/pms/cycles/${cycleId}/activity`, adminAuth.token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.events, []);
});

test('advancing, rolling back, and cancelling this cycle each land in ITS OWN activity — not another cycle\'s', { skip }, async () => {
  const { token } = await login('ca-admin@x.com');
  await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ to: 'kra_open' }) });
  await api(`/pms/cycles/${cycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ rollback: true, to: 'draft' }) });
  // A second, unrelated cycle's own advance must NOT show up here.
  await api(`/pms/cycles/${otherCycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ to: 'kra_open' }) });

  const r = await api(`/pms/cycles/${cycleId}/activity`, token);
  assert.equal(r.status, 200);
  assert.equal(r.body.events.length, 2, 'exactly this cycle\'s own advance + rollback, not the other cycle\'s event');
  assert.equal(r.body.events[0].action, 'PHASE_ROLLBACK', 'most recent first');
  assert.equal(r.body.events[1].action, 'PHASE_ADVANCE');
  assert.equal(r.body.events[0].actor_email, 'ca-admin@x.com');
  assert.equal(r.body.events[1].details.to, 'kra_open');

  const other = await api(`/pms/cycles/${otherCycleId}/activity`, token);
  assert.equal(other.body.events.length, 1);
  assert.equal(other.body.events[0].action, 'PHASE_ADVANCE');
});

test('cancelling is recorded too, with from/to detail intact', { skip }, async () => {
  const { token } = await login('ca-admin@x.com');
  await api(`/pms/cycles/${otherCycleId}/phase`, token, { method: 'POST', body: JSON.stringify({ cancel: true }) });
  const r = await api(`/pms/cycles/${otherCycleId}/activity`, token);
  const cancelEvent = r.body.events.find((e) => e.action === 'CYCLE_CANCELLED');
  assert.ok(cancelEvent);
  assert.equal(cancelEvent.details.to, 'cancelled');
});
