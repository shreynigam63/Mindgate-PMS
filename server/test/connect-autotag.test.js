// node --test — "AI auto-tag KRAs" + PUT /connects/:id (editing an
// already-saved connect's linked KRAs). Requested with a reference
// screenshot after confirming the app previously had no such feature —
// only manual KRA-linking at creation time. Widened in a later round so
// the connect's own EMPLOYEE can use both, not just the manager — an
// employee should be able to tag KRAs on a connect that's about them,
// regardless of who logged it. Real Postgres, real HTTP surface, skips
// cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId, kraAId, kraBId, connectId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cat';
  process.env.TENANT_SLUG = 'cat-test-' + Date.now();
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

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CAT Mgr','cat-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'CAT Emp','cat-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const stranger = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'CAT Stranger','cat-stranger@x.com','active') RETURNING id`, [t.id])).rows[0];
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'cat-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['cat-mgr@x.com', 'cat-emp@x.com', 'cat-stranger@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'CAT Cycle','FYCAT','annual','manager_eval') RETURNING id`, [t.id])).rows[0];
  const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`, [t.id, cycle.id, empId])).rows[0];
  const kraA = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Client Delivery Excellence',60,10) RETURNING id`, [t.id, sheet.id])).rows[0];
  const kraB = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'Team Mentorship',40,20) RETURNING id`, [t.id, sheet.id])).rows[0];
  kraAId = kraA.id; kraBId = kraB.id;

  const cn = (await db.query(
    `INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, topic, discussion_notes, achievements) VALUES ($1,$2,$3,'2026-06-01','Delivery check-in','Discussed the client rollout timeline','Shipped the client migration ahead of schedule') RETURNING id`,
    [t.id, mgr.id, empId])).rows[0];
  connectId = cn.id;

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

test('PUT /connects/:id updates linked KRAs, is manager-only, and locks once signed off', { skip }, async () => {
  const mgrAuth = await login('cat-mgr@x.com');
  const strangerAuth = await login('cat-stranger@x.com');

  const blocked = await api(`/pms/connects/${connectId}`, strangerAuth.token, { method: 'PUT', body: JSON.stringify({ kra_ids: [kraAId] }) });
  assert.equal(blocked.status, 403);

  const put = await api(`/pms/connects/${connectId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ kra_ids: [kraAId, kraBId] }) });
  assert.equal(put.status, 200);

  const list = await api('/pms/connects', mgrAuth.token);
  const cn = list.body.connects.find((c) => c.id === connectId);
  assert.equal(cn.linked_kras.length, 2);
  assert.deepEqual(cn.linked_kras.map((k) => k.title).sort(), ['Client Delivery Excellence', 'Team Mentorship']);

  await api(`/pms/connects/${connectId}/sign-off`, mgrAuth.token, { method: 'POST' });
  const afterSignOff = await api(`/pms/connects/${connectId}`, mgrAuth.token, { method: 'PUT', body: JSON.stringify({ kra_ids: [] }) });
  assert.equal(afterSignOff.status, 409, 'locked once signed off');
});

test('connect-autotag: requires connect_id, blocks an unrelated manager, returns only valid KRA ids', { skip }, async () => {
  const mgrAuth = await login('cat-mgr@x.com');
  const strangerAuth = await login('cat-stranger@x.com');

  const noId = await api('/agentic/connect-autotag', mgrAuth.token, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(noId.status, 400);

  const blocked = await api('/agentic/connect-autotag', strangerAuth.token, { method: 'POST', body: JSON.stringify({ connect_id: connectId }) });
  assert.equal(blocked.status, 403);

  // No ANTHROPIC_API_KEY in this sandbox — asserting it gets PAST the
  // ownership/KRA-lookup guards (a 503 from the AI call itself, not a
  // 400/403/422) is what confirms the endpoint is wired up correctly,
  // same convention as every other agentic route's test in this project.
  const r = await api('/agentic/connect-autotag', mgrAuth.token, { method: 'POST', body: JSON.stringify({ connect_id: connectId }) });
  assert.notEqual(r.status, 400);
  assert.notEqual(r.status, 403);
  assert.notEqual(r.status, 422, 'the employee has KRAs configured, so this should not be the "no KRAs" guard');
});

// The connectId used above got signed off at the end of the first test,
// so this uses a fresh connect — the employee it's ABOUT should be able
// to auto-tag and edit its KRA links themselves, even though their
// manager is the one who logged it.
test('the connect\'s own employee can also auto-tag and edit KRA links, not just the manager — a truly unrelated person still cannot', { skip }, async () => {
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const mgr = (await db.query(`SELECT id FROM core.employees WHERE email='cat-mgr@x.com' AND tenant_id=$1`, [t])).rows[0];
  const cn2 = (await db.query(
    `INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, topic, discussion_notes) VALUES ($1,$2,$3,'2026-06-15','Follow-up','Second connect, logged by the manager') RETURNING id`,
    [t, mgr.id, empId])).rows[0];

  const empAuth = await login('cat-emp@x.com');
  const strangerAuth = await login('cat-stranger@x.com');

  const stillBlocked = await api('/agentic/connect-autotag', strangerAuth.token, { method: 'POST', body: JSON.stringify({ connect_id: cn2.id }) });
  assert.equal(stillBlocked.status, 403, 'a truly unrelated person is still blocked after the widening');

  const autotag = await api('/agentic/connect-autotag', empAuth.token, { method: 'POST', body: JSON.stringify({ connect_id: cn2.id }) });
  assert.notEqual(autotag.status, 403, 'the employee this connect is ABOUT can now use auto-tag, even though their manager logged it');

  const put = await api(`/pms/connects/${cn2.id}`, empAuth.token, { method: 'PUT', body: JSON.stringify({ kra_ids: [kraAId] }) });
  assert.equal(put.status, 200, 'and can save the result themselves');
});
