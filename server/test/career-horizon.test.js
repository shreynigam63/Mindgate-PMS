// Aspiring Career: two horizons, stored separately.
//
// "Two tabs" sounds like a UI change, and it is not. people.career_paths
// was unique on (tenant, employee) — there was literally nowhere to put
// the second answer — so the thing worth testing is that the second
// aspiration EXISTS alongside the first rather than overwriting it.
//
// The other half is the one that would break quietly: every reader
// written before the split (the annual review, the team overview, the HR
// pathing matrix, the AI suggester) expects ONE row per person. A second
// row doubles a LEFT JOIN or makes `.rows[0]` a coin toss, and neither
// announces itself.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'career-horizon-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');

const SLUG = `chz-test-${Date.now()}`;
let server; let base; let tenantId; let tok; let empId;

const api = async (path, opts = {}) => {
  const r = await fetch(`${base}/api/v1/people${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};

before(async () => {
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,'Horizon Person','hz@x.com','active','Executive','Delivery') RETURNING id`, [tenantId])).rows[0].id;
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'hz@x.com','employee')`, [tenantId]);
  await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'employee','pms_self'),($1,'employee','people_view') ON CONFLICT DO NOTHING`, [tenantId]);
  // The card is phase-gated to career_edit, so the cycle has to be in a
  // phase that allows it or every write below 409s.
  const cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase,cycle_type)
     VALUES ($1,'T','FY26-27','kra_open','annual') RETURNING id`, [tenantId])).rows[0].id;
  // The gate is phase AND a submitted sheet — "it opens the moment you
  // submit your KRAs". Both halves have to be satisfied or every write
  // below 409s, which is the gate working, not the feature failing.
  await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status)
     VALUES ($1,$2,$3,'approved')`, [tenantId, cycleId, empId]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'hz@x.com',$2)`,
    [tenantId, await bcrypt.hash('pw', 4)]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hz@x.com', password: 'pw' }),
  })).json()).token;
  assert.ok(tok, 'the test login has to work');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    for (const t of ['people.career_milestones', 'people.career_paths', 'pms.kra_sheets', 'pms.cycles', 'core.local_credentials',
      'core.user_roles', 'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('SHORT-TERM AND LONG-TERM ARE TWO ANSWERS, not one overwritten twice', async () => {
  const a = await api('/career/my-path', { method: 'PUT', body: JSON.stringify({ horizon: 'short_term', target_role: 'Senior Executive', plan: 'next move' }) });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await api('/career/my-path', { method: 'PUT', body: JSON.stringify({ horizon: 'long_term', target_role: 'Delivery Head', plan: 'eventually' }) });
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const short = await api('/career/my-path?horizon=short_term');
  const long = await api('/career/my-path?horizon=long_term');
  assert.equal(short.body.path.target_role, 'Senior Executive', 'the long-term save overwrote the short-term one');
  assert.equal(long.body.path.target_role, 'Delivery Head');
  assert.equal(short.body.path.plan, 'next move');
  assert.equal(long.body.path.plan, 'eventually');
});

test('the tab strip is told which horizons already have an answer', async () => {
  // Without this an unfilled tab and a tab whose fetch failed look the
  // same, and the first reading somebody reaches for is "it is broken".
  const r = await api('/career/my-path?horizon=long_term');
  assert.deepEqual([...r.body.horizons_filled].sort(), ['long_term', 'short_term']);
});

test('no horizon means short-term — every reader written before the split', async () => {
  const r = await api('/career/my-path');
  assert.equal(r.body.horizon, 'short_term');
  assert.equal(r.body.path.target_role, 'Senior Executive');
});

test('a horizon that is not one of the two is not stored as itself', async () => {
  // It falls back to short-term rather than creating a third row that no
  // tab can ever show and no CHECK constraint would have allowed anyway.
  const w = await api('/career/my-path', { method: 'PUT', body: JSON.stringify({ horizon: 'whenever', target_role: 'Principal' }) });
  assert.equal(w.status, 200);
  const rows = (await db.query(`SELECT horizon FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, empId])).rows;
  assert.deepEqual(rows.map((x) => x.horizon).sort(), ['long_term', 'short_term']);
});

test('THE DIRECTORY DOES NOT DOUBLE now that a person can have two', async () => {
  // The failure this is here for: every pre-split reader LEFT JOINs
  // career_paths on (tenant, employee) and expects one row. Two rows turn
  // one employee into two lines, silently, on pages that have nothing to
  // do with this feature.
  const rows = (await db.query(
    `SELECT e.id FROM core.employees e
       LEFT JOIN people.career_paths cp ON cp.tenant_id=e.tenant_id AND cp.employee_id=e.id
        AND cp.horizon='short_term'
      WHERE e.tenant_id=$1`, [tenantId])).rows;
  assert.equal(rows.length, 1, 'one employee with two aspirations came back as two people');
});
