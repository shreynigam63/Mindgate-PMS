// node --test — the manager's rating stays hidden from the employee until
// HR publishes, and publishing stays with HR / Super Admin.
//
// Asked for on 17 Sep:
//   "Rating provided by Manager and upper management should not be visible
//    to employees until it is published by HR or Super Admin as it is
//    changed at HOD stage."
//   "Final publish rights should remain only with HR and Super Admin."
//
// The reason is the whole point: a manager's number is NOT final. The
// Delivery Head can change it and calibration can change it again, so an
// employee who saw the first version reads every later one as a demotion.
//
// WITHHELD AT THE API, not hidden in the page — a field the browser
// receives is a field anyone can read.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empTok, mgrTok, hrTok, tenantId, cycleId, empId, mgrId, sheetId, kraId;

const get = async (path, tok) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const publishRow = () => db.query(
  `INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating, rating_label)
   VALUES ($1,$2,$3,3.4,'Meets Expectations') ON CONFLICT DO NOTHING`, [tenantId, empId, cycleId]);

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mrv';
  process.env.TENANT_SLUG = 'mrv-test-' + Date.now();
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

  mgrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation) VALUES ($1,'MRV Mgr','mrv-mgr@x.com','active','Manager') RETURNING id`,
    [t.id])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,manager_id) VALUES ($1,'MRV Emp','mrv-emp@x.com','active','Executive',$2) RETURNING id`,
    [t.id, mgrId])).rows[0].id;
  const hrId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'MRV HR','mrv-hr@x.com','active') RETURNING id`,
    [t.id])).rows[0].id;
  for (const [email, role] of [['mrv-emp@x.com', 'employee'], ['mrv-mgr@x.com', 'manager'], ['mrv-hr@x.com', 'hr']]) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
    await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,$2,$3)`, [t.id, email, role]);
  }

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase) VALUES ($1,'MRV','FY26','hod_eval') RETURNING id`,
    [t.id])).rows[0].id;
  sheetId = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
    [t.id, cycleId, empId, mgrId])).rows[0].id;
  kraId = (await db.query(
    `INSERT INTO pms.kras (tenant_id,sheet_id,title,weight) VALUES ($1,$2,'Deliver the thing',100) RETURNING id`,
    [t.id, sheetId])).rows[0].id;

  // The manager has rated: per-KRA, an overall, and narrative text.
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id,cycle_id,employee_id,manager_id,status,entries,overall_rating,strengths,improvement_areas)
     VALUES ($1,$2,$3,$4,'submitted',$5::jsonb,4.0,'Strong delivery','Broaden exposure')`,
    [t.id, cycleId, empId, mgrId, JSON.stringify({ [kraId]: { rating: 4, comment: 'exceeded the SLA' } })]);
  // The per-KRA entry maps matter: midyearEntriesFor() treats a check-in
  // with both maps empty as "no mid-year" and returns null, however the
  // overall columns are set.
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id,cycle_id,employee_id,manager_id,self_rating,manager_rating,self_status,manager_status,self_entries,manager_entries)
     VALUES ($1,$2,$3,$4,4.0,3.0,'submitted','submitted',$5::jsonb,$6::jsonb)`,
    [t.id, cycleId, empId, mgrId,
     JSON.stringify({ [kraId]: { rating: 4, narrative: 'halfway, on track' } }),
     JSON.stringify({ [kraId]: { rating: 3, narrative: 'manager halfway view' } })]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  empTok = await login('mrv-emp@x.com');
  mgrTok = await login('mrv-mgr@x.com');
  hrTok = await login('mrv-hr@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test("THE EMPLOYEE CANNOT SEE THE MANAGER'S RATING BEFORE PUBLISH", { skip }, async () => {
  const r = await get('/pms/my/annual-review', empTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.published, false);
  assert.equal(r.body.manager_ratings_withheld, true);

  assert.equal(r.body.manager_evaluation, null, "the manager's evaluation must not be sent");
  const outcome = r.body.kra.outcomes[0];
  assert.equal(outcome.manager, null, 'nor the per-KRA manager rating');
  assert.equal(r.body.midyear.manager_overall, null, 'nor the mid-year manager number');

  // Belt and braces: the manager's actual words must not appear ANYWHERE
  // in the payload, whatever shape a future refactor gives it.
  const blob = JSON.stringify(r.body);
  for (const secret of ['exceeded the SLA', 'Strong delivery', 'Broaden exposure']) {
    assert.ok(!blob.includes(secret), `"${secret}" leaked into the employee's payload`);
  }
});

test('the employee still sees their OWN side of it', { skip }, async () => {
  const r = await get('/pms/my/annual-review', empTok);
  assert.ok(r.body.kra.outcomes.length, 'their KRAs are still listed');
  assert.equal(r.body.midyear.self_overall, 4, 'their own mid-year rating is theirs to see');
  assert.equal(r.body.midyear.self_status, 'submitted');
  const blob = JSON.stringify(r.body);
  assert.ok(blob.includes('halfway, on track'), 'their own mid-year narrative is still theirs');
  assert.ok(!blob.includes('manager halfway view'), "but not the manager's");
});

test('THE MANAGER AND HR SEE EVERYTHING — the gate is on the employee view only', { skip }, async () => {
  for (const [who, tok] of [['manager', mgrTok], ['hr', hrTok]]) {
    const r = await get(`/pms/team/annual-review/${empId}`, tok);
    assert.equal(r.status, 200, `${who} should be able to read it`);
    assert.ok(r.body.manager_evaluation, `${who} sees the manager evaluation`);
    assert.equal(r.body.manager_evaluation.overall_rating, 4);
    assert.ok(JSON.stringify(r.body).includes('exceeded the SLA'), `${who} sees the per-KRA comment`);
  }
});

test('ONCE HR PUBLISHES, THE EMPLOYEE SEES IT', { skip }, async () => {
  await publishRow();
  const r = await get('/pms/my/annual-review', empTok);
  assert.equal(r.body.published, true);
  assert.equal(r.body.manager_ratings_withheld, false);
  assert.ok(r.body.manager_evaluation, 'the evaluation is released');
  assert.equal(r.body.manager_evaluation.overall_rating, 4);
  assert.equal(r.body.kra.outcomes[0].manager.rating, 4, 'and the per-KRA rating');
  assert.equal(r.body.midyear.manager_overall, 3, 'and the mid-year number');
});

test('publishing is refused for an employee and for a manager', { skip }, async () => {
  const asEmp = await post('/pms/publish', empTok);
  assert.equal(asEmp.status, 403);
  assert.match(asEmp.body.error, /pms_admin/);

  const asMgr = await post('/pms/publish', mgrTok);
  assert.equal(asMgr.status, 403, 'a manager cannot publish final ratings');
});

test('PUBLISH RIGHTS SIT WITH HR (and the wildcard Super Admin), nobody else', { skip }, async () => {
  // Which roles actually carry pms_admin, read from the permission table
  // rather than asserted from memory.
  const rows = (await db.query(
    `SELECT role FROM core.role_permissions WHERE tenant_id=$1 AND permission='pms_admin' ORDER BY role`,
    [tenantId])).rows.map((r) => r.role);
  assert.deepEqual(rows, ['hr'], 'only the hr role grants pms_admin directly');

  const wildcard = (await db.query(
    `SELECT role FROM core.role_permissions WHERE tenant_id=$1 AND permission='*' ORDER BY role`,
    [tenantId])).rows.map((r) => r.role);
  assert.deepEqual(wildcard, ['admin'], 'and admin is the Super Admin wildcard');

  for (const role of ['manager', 'hod', 'employee']) {
    const has = (await db.query(
      `SELECT 1 FROM core.role_permissions WHERE tenant_id=$1 AND role=$2 AND permission IN ('pms_admin','*')`,
      [tenantId, role])).rowCount;
    assert.equal(has, 0, `${role} must not be able to publish`);
  }
});

test('HR reaches the publish route — it refuses on the phase, not on permission', { skip }, async () => {
  // The cycle is in hod_eval, so publish is not open yet. A 409 proves the
  // permission check passed; a 403 would mean HR had been locked out.
  const r = await post('/pms/publish', hrTok);
  assert.equal(r.status, 409, `expected a phase refusal, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.match(r.body.error, /Publish is not open/);
});

test('MY KRAs DOES NOT LEAK THE MANAGER\'S MID-YEAR RATING EITHER', { skip }, async () => {
  await db.query(`DELETE FROM pms.employee_performance_history WHERE employee_id=$1 AND cycle_id=$2`, [empId, cycleId]);
  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE id=$1`, [cycleId]);
  const r = await get('/pms/my/kra-sheet', empTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.manager_ratings_withheld, true);
  assert.equal(r.body.midyear.manager_overall, null, 'the overall is withheld');
  assert.equal(r.body.kras[0].midyear.manager, null, 'and the per-KRA one');
  assert.ok(r.body.kras[0].midyear.self, 'but their own self rating is still there');
  assert.ok(!JSON.stringify(r.body).includes('manager halfway view'),
    "the manager's mid-year narrative must not appear");
});

test('THE MID-YEAR PAGE WITHHOLDS THE MANAGER HALF, KEEPS THE STATUS', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='mid_year_review' WHERE id=$1`, [cycleId]);
  const r = await get('/pms/my/midyear-review', empTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.manager_ratings_withheld, true);
  assert.equal(r.body.checkin.manager_rating, null);
  assert.equal(r.body.checkin.manager_narrative, null);
  assert.deepEqual(r.body.checkin.manager_entries, {});
  // Status is not a rating, and hiding it would leave the employee unable
  // to tell whether the halfway conversation had happened at all.
  assert.equal(r.body.checkin.manager_status, 'submitted', 'the status stays');
  // Their own half is untouched.
  assert.equal(Number(r.body.checkin.self_rating), 4);
  assert.ok(JSON.stringify(r.body.checkin.self_entries).includes('halfway, on track'));
});

test('ONCE PUBLISHED, ALL THREE EMPLOYEE VIEWS RELEASE THE MANAGER RATINGS', { skip }, async () => {
  await publishRow();
  const kra = await get('/pms/my/kra-sheet', empTok);
  assert.equal(kra.body.manager_ratings_withheld, false);
  assert.equal(kra.body.kras[0].midyear.manager.rating, 3);

  const mid = await get('/pms/my/midyear-review', empTok);
  assert.equal(mid.body.manager_ratings_withheld, false);
  assert.equal(Number(mid.body.checkin.manager_rating), 3);
  assert.ok(JSON.stringify(mid.body.checkin.manager_entries).includes('manager halfway view'));

  await db.query(`UPDATE pms.cycles SET phase='hod_eval' WHERE id=$1`, [cycleId]);
  const ann = await get('/pms/my/annual-review', empTok);
  assert.equal(ann.body.manager_ratings_withheld, false);
  assert.ok(ann.body.manager_evaluation);
});

test('NO RATING THE EMPLOYEE DID NOT GIVE APPEARS ON ANY OF THEIR ROUTES', { skip }, async () => {
  // The catch-all. Every phrase here was written by the manager; none may
  // reach the employee before publish, whatever shape a refactor gives the
  // payloads.
  await db.query(`DELETE FROM pms.employee_performance_history WHERE employee_id=$1 AND cycle_id=$2`, [empId, cycleId]);
  const SECRETS = ['exceeded the SLA', 'Strong delivery', 'Broaden exposure', 'manager halfway view'];
  for (const path of ['/pms/my/kra-sheet', '/pms/my/midyear-review', '/pms/my/annual-review', '/pms/my/self-appraisal']) {
    const r = await get(path, empTok);
    assert.equal(r.status, 200, `${path} -> ${r.status}`);
    const blob = JSON.stringify(r.body);
    for (const secret of SECRETS) {
      assert.ok(!blob.includes(secret), `"${secret}" leaked from ${path}`);
    }
  }
});
