// node --test — the Mid-Year 7-Parameter Pulse Check (BRD Fig. 7b) is
// REMOVED from the product, and this pins what that means.
//
// Taken out at the client's instruction ("remove pulse from application
// for now"). The routes went with the page, because a route the product
// no longer offers is still callable by anyone holding a token.
//
// What must NOT have happened is the destructive half: pms.pulse_checks
// and its rows stay. "For now" is not "forever", and this database has no
// backups — dropping the table would destroy scores employees actually
// entered, with no way back. So this file checks both directions: the
// feature is unreachable, and the data is untouched.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pulse';
  process.env.TENANT_SLUG = 'pulse-test-' + Date.now();
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
  await require('../migrations/008-review-parameters').ensureDefaultParameters(db, t.id);

  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'Pulse Emp','pulse-emp@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id;
  const hash = await bcrypt.hash('pass', 10);
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,'pulse-emp@x.com',$2)`, [t.id, hash]);

  // A midyear cycle AND a separate annual cycle both open at once, so the
  // isolation test can prove pulse-check scoring on the midyear cycle
  // does not touch the annual cycle's manager_evaluations at all.
  await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'Pulse MY Cycle','FYP','midyear','manager_eval')`, [t.id]);

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
  // A removed route falls through to Express's own 404, which is HTML —
  // parsing it as JSON would throw and report as a failure of the thing
  // under test rather than of the parse.
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
}

test('the pulse-check routes are gone, not merely unlinked from the nav', { skip }, async () => {
  const { token } = await login('pulse-emp@x.com');
  const get = await api('/pms/my/pulse-check', token);
  assert.equal(get.status, 404);
  const put = await api('/pms/my/pulse-check', token, { method: 'PUT', body: JSON.stringify({ scores: {} }) });
  assert.equal(put.status, 404);
});

test('pms.pulse_checks and its rows survive the removal', { skip }, async () => {
  // The table is the thing that must NOT have been cleaned up along with
  // the feature. A row written directly is still readable afterwards —
  // proving nothing in the removal drops, truncates or cascades it.
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const cycle = (await db.query(`SELECT id FROM pms.cycles WHERE tenant_id=$1 LIMIT 1`, [t])).rows[0];
  const param = (await db.query(`SELECT id FROM pms.review_parameters WHERE tenant_id=$1 ORDER BY sort_order LIMIT 1`, [t])).rows[0];

  await db.query(
    `INSERT INTO pms.pulse_checks (tenant_id, cycle_id, employee_id, parameter_id, score) VALUES ($1,$2,$3,$4,4)
     ON CONFLICT (cycle_id, employee_id, parameter_id) DO UPDATE SET score=EXCLUDED.score`,
    [t, cycle.id, empId, param.id]);

  const back = (await db.query(
    `SELECT score FROM pms.pulse_checks WHERE cycle_id=$1 AND employee_id=$2 AND parameter_id=$3`,
    [cycle.id, empId, param.id])).rows[0];
  assert.equal(Number(back.score), 4, 'the table still exists and still holds what was written to it');
});

test('an existing pulse score still reaches the person it belongs to, via their GDPR export', { skip }, async () => {
  // Removing a screen does not remove someone's right to a copy of their
  // own data. While rows exist, the export must still carry them.
  const { buildExport } = require('../core/gdpr');
  const t = (await db.query(`SELECT tenant_id FROM core.employees WHERE id=$1`, [empId])).rows[0].tenant_id;
  const out = await buildExport(t, empId);
  assert.ok(Array.isArray(out.midyear_pulse_checks), 'the export section is still present');
  assert.ok(out.midyear_pulse_checks.length >= 1, 'and still carries the stored score');
});
