// node --test — the mid-year rating is part of the KRA process.
//
// Mid-year scoring was already per-KRA, but it lived only on its own page
// and fed nothing afterwards: the KRA sheet showed what someone signed up
// to and nothing about how it was going, and the Annual Review
// consolidation — which exists precisely to bring the year together — did
// not mention it. This covers the join in both directions.
//
// Deliberately NOT asserted anywhere: that mid-year moves the final
// rating. How much a halfway reading should count is a policy decision
// nobody has made, and quietly weighting it would be making it here.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, sheetId, kraA, kraB;

const api = async (path, token, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mkp';
  process.env.TENANT_SLUG = 'mkp-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'MKP Mgr','mkp-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  mgrId = mgr.id;
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'MKP Emp','mkp-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  empId = emp.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'mkp-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['mkp-mgr@x.com', 'mkp-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const scale = JSON.stringify([{ value: 5, label: 'A' }, { value: 4, label: 'B+' }, { value: 3, label: 'B' }]);
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, rating_scale) VALUES ($1,'MKP Cycle','FYMKP','annual','kra_open',$2) RETURNING id`,
    [t.id, scale])).rows[0];
  cycleId = cycle.id;
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
    [t.id, cycle.id, empId, mgrId])).rows[0];
  sheetId = sheet.id;
  const ks = (await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES
      ($1,$2,'On-Time Delivery',60,10),($1,$2,'Code Quality',40,20) RETURNING id`,
    [t.id, sheet.id])).rows;
  kraA = ks[0].id; kraB = ks[1].id;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
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

test('with no mid-year on record the KRA sheet says so with null, not an empty shell', { skip }, async () => {
  // A caller has to be able to tell "mid-year never happened" from
  // "mid-year happened and this KRA was not rated" — the second is worth
  // showing on screen, the first is not.
  const token = await login('mkp-emp@x.com');
  const r = await api('/pms/my/kra-sheet', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.midyear, null);
  assert.deepEqual(r.body.kras.map((k) => k.midyear), [null, null]);
});

test('a check-in with both sides empty still counts as no mid-year', { skip }, async () => {
  // ensureMidyearCheckin creates a row the moment someone opens the page.
  // A bare row is not a mid-year rating, and rendering an empty panel off
  // it would be worse than rendering nothing.
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4)`,
    [tenantId, cycleId, empId, mgrId]);
  const token = await login('mkp-emp@x.com');
  assert.equal((await api('/pms/my/kra-sheet', token)).body.midyear, null);
});

test('mid-year ratings reach the employee’s own KRA sheet, against the right KRA', { skip }, async () => {
  await db.query(
    `UPDATE pms.midyear_checkins
        SET self_entries=$2, manager_entries=$3, self_rating=4.4, manager_rating=3.6,
            self_status='submitted', manager_status='submitted'
      WHERE cycle_id=$1 AND employee_id=$4`,
    [cycleId,
     JSON.stringify({ [kraA]: { rating: 5, narrative: 'Every milestone on plan' }, [kraB]: { rating: 3, narrative: 'Two UAT bugs' } }),
     JSON.stringify({ [kraA]: { rating: 4, narrative: 'Agreed, strong' } }),
     empId]);

  const token = await login('mkp-emp@x.com');
  const r = await api('/pms/my/kra-sheet', token);
  const byId = Object.fromEntries(r.body.kras.map((k) => [k.id, k]));

  assert.equal(byId[kraA].midyear.self.rating, 5);
  assert.equal(byId[kraA].midyear.self.narrative, 'Every milestone on plan');
  assert.equal(byId[kraA].midyear.manager.rating, 4);
  // Rated by the employee, not yet by the manager — the distinction has to
  // survive, so the page can show one and a dash for the other.
  assert.equal(byId[kraB].midyear.self.rating, 3);
  assert.equal(byId[kraB].midyear.manager, null);
  assert.equal(Number(r.body.midyear.self_overall), 4.4);
  assert.equal(r.body.midyear.manager_status, 'submitted');
});

test('the manager sees the same mid-year ratings on their report’s sheet', { skip }, async () => {
  const token = await login('mkp-mgr@x.com');
  const r = await api(`/pms/team/kra-sheets/${sheetId}/kras`, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = Object.fromEntries(r.body.kras.map((k) => [k.id, k]));
  assert.equal(byId[kraA].midyear.self.rating, 5);
  assert.equal(byId[kraA].midyear.manager.rating, 4);
  assert.equal(Number(r.body.midyear.manager_overall), 3.6);
});

test('the Annual Review carries mid-year as the mid-point, alongside self and manager', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='self_appraisal' WHERE id=$1`, [cycleId]);
  await db.query(
    `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status, entries) VALUES ($1,$2,$3,'submitted',$4)`,
    [tenantId, cycleId, empId, JSON.stringify({ [kraA]: { self_rating: 5, narrative: 'Finished strong' } })]);
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status, entries) VALUES ($1,$2,$3,$4,'submitted',$5)`,
    [tenantId, cycleId, empId, mgrId, JSON.stringify({ [kraA]: { rating: 5, comment: 'Agreed' } })]);

  const token = await login('mkp-emp@x.com');
  const r = await api('/pms/my/annual-review', token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body.kra.outcomes.find((k) => k.id === kraA);

  // The shape of the year on one row: 5 at mid-year, 5 now.
  assert.equal(a.midyear.self.rating, 5);
  assert.equal(a.midyear.manager.rating, 4);
  assert.equal(a.self.self_rating, 5);
  assert.equal(a.manager.rating, 5);
  assert.equal(Number(r.body.midyear.self_overall), 4.4);
});

test('mid-year is shown next to the final rating, never folded into it', { skip }, async () => {
  // The official rating comes from the 7 organisational parameters on an
  // annual cycle. Mid-year must not have moved it — if a future change
  // starts blending them, this fails.
  const token = await login('mkp-emp@x.com');
  const r = await api('/pms/my/annual-review', token);
  assert.equal(r.body.parameter_scores.weighted_rating, null,
    'no parameters scored, so no rating — a mid-year average must not have leaked in');
  assert.equal(r.body.parameter_scores.complete, false);
});
