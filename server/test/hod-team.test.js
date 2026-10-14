// node --test — HOD Review → Team analysis (15 Oct): the Delivery Head's
// reporting line — direct reportees, and each manager's team below them —
// with the cycle's progress and ratings. Pure rules, then the route on
// real Postgres (skipped without DATABASE_URL).
//
//   HOD ── Mgr ── A1 (A, by the HOD), A2 (B+, by the manager), A3 (draft only)
//    └─── B1 (no reports, A+)
//   Other ── O1   (not the HOD's)
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { summarise, groupsOf } = require('../modules/performance/hod-team');

test('the figures for a group: progress counted, the standing rating graded, drafts ignored', () => {
  const s = summarise([
    { kra_status: 'approved', self_status: 'submitted', manager_status: 'submitted', hod_status: 'submitted', final_rating: 4 },
    { kra_status: 'submitted', self_status: 'in_progress', manager_status: 'submitted', final_rating: 3 },
    { kra_status: 'draft', manager_status: 'pending', final_rating: null },
    { final_rating: 5 },
  ], null);
  assert.equal(s.headcount, 4);
  assert.deepEqual([s.kra_approved, s.kra_waiting, s.kra_not_submitted], [1, 1, 2]);
  assert.deepEqual([s.self_submitted, s.manager_submitted, s.hod_submitted], [1, 2, 1]);
  assert.equal(s.rated, 3);
  assert.equal(s.avg_rating, 4);
  assert.equal(s.avg_grade, 'A');
  assert.deepEqual(s.distribution, [{ label: 'A+', count: 1 }, { label: 'A', count: 1 }, { label: 'B+', count: 1 }, { label: 'B', count: 0 }, { label: 'C', count: 0 }]);
  assert.equal(summarise([], null).avg_rating, null);
});

test('groups: direct reportees first, then each manager\'s whole team below them', () => {
  const people = [
    { id: 'm', name: 'Mgr', manager_id: 'hod' }, { id: 'b', name: 'B1', manager_id: 'hod' },
    { id: 'a1', name: 'A1', manager_id: 'm' }, { id: 'l', name: 'Lead', manager_id: 'm' }, { id: 'x', name: 'X', manager_id: 'l' },
  ];
  const g = groupsOf(people, 'hod', null);
  assert.deepEqual(g.map((x) => [x.key, x.headcount]), [['direct', 2], ['m', 3]], 'B1 has no team; Mgr\'s includes the lead\'s report');
  assert.equal(g[1].title, "Mgr's team");
});

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';
let db, server, base;
const id = {};
const tok = {};
const get = async (p, who) => {
  const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${tok[who]}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-hodteam';
  process.env.TENANT_SLUG = 'hodteam-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  const mk = async (key, managerId, dept = 'Engineering') => {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status, designation)
       VALUES ($1,$2,$3,$4,$5,'active','Engineer') RETURNING id`, [t.id, `HT ${key}`, `ht-${key}@x.com`, dept, managerId || null])).rows[0].id;
  };
  await mk('hod'); await mk('mgr', id.hod); await mk('a1', id.mgr); await mk('a2', id.mgr); await mk('a3', id.mgr);
  await mk('b1', id.hod, 'Sales'); await mk('other'); await mk('o1', id.other);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'ht-hod@x.com','hod'),($1,'ht-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 4);
  for (const k of ['hod', 'mgr']) await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, `ht-${k}@x.com`, hash]);
  const c = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'HT FY','FY26-27','annual','hod_eval') RETURNING id`, [t.id])).rows[0].id;
  const me = async (k, rating, status = 'submitted') => db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, entries, overall_rating, status) VALUES ($1,$2,$3,$4,'{}',$5,$6)`,
    [t.id, c, id[k], id.mgr, rating, status]);
  await me('a1', 3); await me('a2', 3); await me('a3', 5, 'pending'); await me('b1', 5); await me('o1', 1);
  await db.query(`INSERT INTO pms.hod_evaluations (tenant_id, cycle_id, employee_id, hod_id, overall_rating, status) VALUES ($1,$2,$3,$4,4,'submitted')`, [t.id, c, id.a1, id.hod]);
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved'),($1,$2,$4,'submitted')`, [t.id, c, id.a1, id.a2]);
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const k of ['hod', 'mgr']) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `ht-${k}@x.com`, password: 'pass' }) })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the HOD\'s analysis covers their reporting line, across departments, and nobody else', { skip }, async () => {
  const r = await get('/pms/hod/team/analysis', 'hod');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(new Set(r.body.people.map((p) => p.id)), new Set([id.mgr, id.a1, id.a2, id.a3, id.b1]));
  assert.equal(r.body.overall.headcount, 5);
  assert.equal(r.body.overall.manager_submitted, 3, 'A3\'s is a draft');
  assert.equal(r.body.overall.hod_submitted, 1);
  assert.equal(r.body.overall.rated, 3, 'A1 (the HOD\'s 4), A2 (the manager\'s 3), B1 (5)');
  assert.equal(r.body.overall.avg_rating, 4);
  assert.deepEqual([r.body.overall.kra_approved, r.body.overall.kra_waiting, r.body.overall.kra_not_submitted], [1, 1, 3]);
  assert.deepEqual(r.body.groups.map((g) => [g.title, g.headcount]), [['Your direct reportees', 2], ['HT mgr\'s team', 3]]);
  const a1 = r.body.people.find((p) => p.id === id.a1);
  assert.equal(a1.final_rating, 4, 'the HOD\'s rating stands over the manager\'s');
  assert.equal(a1.final_grade, 'A');
  assert.equal(r.body.people.find((p) => p.id === id.mgr).is_manager, true);
  assert.equal((await get('/pms/hod/team/analysis', 'mgr')).status, 403);
});
