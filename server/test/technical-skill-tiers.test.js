// Technical skills, named by tier.
//
// Two things are worth pinning. The first is that the four boxes store
// four separate answers and come back as four separate answers — the
// ordinary round trip.
//
// The second is the one that would be a real failure: these are the
// EMPLOYEE'S statement of their own skills, and the manager's save route
// walks a shared list of free-text fields on the same row. Putting the
// tiers in that list would have let a manager quietly rewrite what
// somebody said their primary skill is, with nothing on screen to show
// it had changed. The manager sees them and cannot edit them.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'tech-tier-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');

const SLUG = `tst-test-${Date.now()}`;
let server; let base; let tenantId; let empId; let empTok; let mgrTok;

const api = async (tok, path, opts = {}) => {
  const r = await fetch(`${base}/api/v1/pms/competencies${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};

before(async () => {
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  const mgrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,'Tier Manager','tt-mgr@x.com','active','Lead','Delivery') RETURNING id`, [tenantId])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,'Tier Person','tt-emp@x.com','active','Engineer','Delivery',$2) RETURNING id`,
    [tenantId, mgrId])).rows[0].id;
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'tt-emp@x.com','employee'),($1,'tt-mgr@x.com','manager')`, [tenantId]);
  await db.query(
    `INSERT INTO core.role_permissions (tenant_id,role,permission)
     VALUES ($1,'employee','pms_self'),($1,'manager','pms_self'),($1,'manager','pms_team_eval')
     ON CONFLICT DO NOTHING`, [tenantId]);
  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase,cycle_type)
     VALUES ($1,'T','FY26-27','self_appraisal','annual')`, [tenantId]);
  // One technical competency, so the dropdown has something to offer.
  await db.query(
    `INSERT INTO pms.competencies (tenant_id,category,name,default_required_level,active,sort_order)
     VALUES ($1,'FUNCTIONAL / TECHNICAL COMPETENCY','Tools / systems proficiency',3,true,1),
            ($1,'BEHAVIOURAL COMPETENCY','Work attitude',3,true,2)`, [tenantId]);
  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['tt-emp@x.com', 'tt-mgr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email) => (await (await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw' }),
  })).json()).token;
  empTok = await login('tt-emp@x.com');
  mgrTok = await login('tt-mgr@x.com');
  assert.ok(empTok && mgrTok, 'both test logins have to work');
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    for (const t of ['pms.competency_ratings', 'pms.competency_assessments', 'pms.competencies',
      'pms.competency_scale', 'pms.cycles', 'core.local_credentials', 'core.user_roles',
      'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('FOUR TIERS ARE FOUR ANSWERS, and they round-trip', async () => {
  const w = await api(empTok, '/me', { method: 'PUT', body: JSON.stringify({
    tech_primary: 'Java', tech_secondary: 'SQL', tech_tertiary: 'Kubernetes',
    tech_basic: 'Docker, Jenkins',
  }) });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const r = await api(empTok, '/me');
  const a = r.body.assessment;
  assert.equal(a.tech_primary, 'Java');
  assert.equal(a.tech_secondary, 'SQL');
  assert.equal(a.tech_tertiary, 'Kubernetes');
  assert.equal(a.tech_basic, 'Docker, Jenkins', 'Basic holds more than one on purpose');
});

test('the form carries the four boxes and what may go in them', async () => {
  const r = await api(empTok, '/me');
  assert.deepEqual(r.body.technical_tiers.map((t) => t.label), ['Primary', 'Secondary', 'Tertiary', 'Basic']);
  // The options are HR's TECHNICAL competencies only — offering the
  // behavioural ones as skills would teach people the two are the same.
  assert.deepEqual(r.body.technical_options, ['Tools / systems proficiency']);
  assert.ok(r.body.technical_tiers.every((t) => t.hint), 'each box says what it means');
});

test('A MANAGER CANNOT REWRITE WHAT SOMEBODY SAID THEIR PRIMARY SKILL IS', async () => {
  // The real risk in putting these on the assessment row: the manager's
  // save route walks a shared list of free-text fields on that same row.
  const w = await api(mgrTok, `/team/${empId}`, { method: 'PUT', body: JSON.stringify({
    tech_primary: 'COBOL', manager_summary: 'fine',
  }) });
  assert.ok(w.status < 400, JSON.stringify(w.body));
  const r = await api(empTok, '/me');
  assert.equal(r.body.assessment.tech_primary, 'Java',
    'the manager overwrote the employee’s own statement of their primary skill');
});

test('but the manager SEES them — they are the point of the conversation', async () => {
  const r = await api(mgrTok, `/team/${empId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.assessment.tech_primary, 'Java');
  assert.deepEqual(r.body.technical_tiers.map((t) => t.label), ['Primary', 'Secondary', 'Tertiary', 'Basic']);
});

test('clearing a box clears it, rather than leaving the old answer', async () => {
  // '' has to mean "I took that back". Stored as an empty string it would
  // read as answered on every report that tests for presence.
  await api(empTok, '/me', { method: 'PUT', body: JSON.stringify({ tech_tertiary: '   ' }) });
  const r = await api(empTok, '/me');
  assert.equal(r.body.assessment.tech_tertiary, null);
  assert.equal(r.body.assessment.tech_primary, 'Java', 'clearing one cleared another');
});

test('an absurdly long answer is refused with the field named', async () => {
  const w = await api(empTok, '/me', { method: 'PUT', body: JSON.stringify({ tech_primary: 'x'.repeat(400) }) });
  assert.equal(w.status, 422);
  assert.equal(w.body.field, 'tech_primary');
  const r = await api(empTok, '/me');
  assert.equal(r.body.assessment.tech_primary, 'Java', 'the refused save still wrote something');
});
