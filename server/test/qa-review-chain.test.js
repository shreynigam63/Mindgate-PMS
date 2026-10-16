// node --test — the review chain's locks (16 Oct, from the client's QA):
// a submitted manager evaluation is locked and HR reopens it with a
// reason; submitting needs every KRA rated and a direct report; a HOD
// rates only their own departments, never themselves, only after the
// manager has submitted, on the scale, and a submitted HOD rating is
// locked. Real Postgres, skips cleanly without DATABASE_URL.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-qarc';
process.env.AUTH_DEV = 'true';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db, server, base, tenantId, cycleId;
const id = {}; const kra = {};

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('QARC',$1) RETURNING id`, [`qarc-${Date.now()}`])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  const hash = await bcrypt.hash('pass', 4);
  const add = async (k, role, dept, managerKey) => {
    id[k] = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department, manager_id) VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`,
      [tenantId, `QARC ${k}`, `${k}@qarc.test`, dept, managerKey ? id[managerKey] : null])).rows[0].id;
    if (role !== 'employee') await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)`, [tenantId, `${k}@qarc.test`, role]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [tenantId, `${k}@qarc.test`, hash]);
  };
  await add('hr', 'hr', 'People');
  await add('hod', 'hod', 'Delivery');
  await add('hod2', 'hod', 'Sales');
  await add('mgr', 'manager', 'Delivery');
  await add('mgr2', 'manager', 'Delivery');
  await add('emp', 'employee', 'Delivery', 'mgr');
  await add('sales', 'employee', 'Sales', 'mgr');
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Delivery',$2),($1,'Sales',$3)`, [tenantId, id.hod, id.hod2]);
  const scale = JSON.stringify([{ value: 5, label: 'A+' }, { value: 4, label: 'A' }, { value: 3, label: 'B+' }, { value: 2, label: 'B' }, { value: 1, label: 'C' }]);
  cycleId = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, rating_scale) VALUES ($1,'QARC','FYQA','midyear','manager_eval',$2) RETURNING id`,
    [tenantId, scale])).rows[0].id;
  for (const who of ['emp', 'sales']) {
    const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
      [tenantId, cycleId, id[who], id.mgr])).rows[0].id;
    kra[who] = [];
    for (const [title, w] of [['Ship', 60], ['Support', 40]]) {
      kra[who].push((await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,$3,$4,1) RETURNING id`, [tenantId, sheet, title, w])).rows[0].id);
    }
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
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

const tok = {};
async function call(who, method, path, body) {
  if (!tok[who]) {
    tok[who] = (await (await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${who}@qarc.test`, password: 'pass' }) })).json()).token;
  }
  const r = await fetch(`${base}/pms${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const phase = (p) => db.query(`UPDATE pms.cycles SET phase=$2 WHERE id=$1`, [cycleId, p]);

test('manager evaluation: every KRA rated, only for a direct report, then locked', { skip }, async () => {
  let r = await call('mgr', 'PUT', `/team/evaluations/${id.emp}`, { entries: { [kra.emp[0]]: { rating: 4 } } });
  assert.equal(r.status, 200);
  r = await call('mgr', 'POST', `/team/evaluations/${id.emp}/submit`);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Rate every KRA/);
  r = await call('mgr2', 'POST', `/team/evaluations/${id.emp}/submit`);
  assert.equal(r.status, 403, 'not their report');
  r = await call('mgr', 'PUT', `/team/evaluations/${id.emp}`, { entries: { [kra.emp[0]]: { rating: 4 }, [kra.emp[1]]: { rating: 5 } } });
  assert.equal(Number(r.body.overall_rating), 4.4);
  assert.equal((await call('mgr', 'POST', `/team/evaluations/${id.emp}/submit`)).status, 200);
  r = await call('mgr', 'PUT', `/team/evaluations/${id.emp}`, { overall_rating: 1 });
  assert.equal(r.status, 409, 'a submitted evaluation is locked');
  assert.match(r.body.error, /HR can reopen/);
  const stored = (await db.query(`SELECT overall_rating FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, id.emp])).rows[0];
  assert.equal(Number(stored.overall_rating), 4.4, 'the rating did not move');
});

test('HR reopens a submitted evaluation with a reason the manager is told', { skip }, async () => {
  assert.equal((await call('mgr', 'POST', `/team/evaluations/${id.emp}/reopen`, { reason: 'x' })).status, 403, 'HR only');
  assert.equal((await call('hr', 'POST', `/team/evaluations/${id.emp}/reopen`, {})).status, 422, 'a reason is needed');
  const r = await call('hr', 'POST', `/team/evaluations/${id.emp}/reopen`, { reason: 'KRA 2 was rated against the wrong sheet' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ev = (await db.query(`SELECT status FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, id.emp])).rows[0];
  assert.equal(ev.status, 'pending');
  const n = (await db.query(`SELECT body, link FROM core.notifications WHERE employee_id=$1 AND kind='eval_reopened'`, [id.mgr])).rows[0];
  assert.match(n.body, /wrong sheet/);
  assert.equal(n.link, '/team/eval');
  assert.equal((await call('hr', 'POST', `/team/evaluations/${id.emp}/reopen`, { reason: 'again' })).status, 409, 'only a submitted one');
  // Submit again, and the sales report too, for the HOD tests.
  assert.equal((await call('mgr', 'POST', `/team/evaluations/${id.emp}/submit`)).status, 200);
  await call('mgr', 'PUT', `/team/evaluations/${id.sales}`, { entries: { [kra.sales[0]]: { rating: 3 }, [kra.sales[1]]: { rating: 3 } } });
  assert.equal((await call('mgr', 'POST', `/team/evaluations/${id.sales}/submit`)).status, 200);
  await phase('hod_eval');
  assert.equal((await call('hr', 'POST', `/team/evaluations/${id.emp}/reopen`, { reason: 'late' })).status, 409, 'closed after manager evaluation');
});

test('HOD rating: own departments, not themselves, after the manager, on the scale, then locked', { skip }, async () => {
  let r = await call('hod', 'PUT', `/hod/queue/${id.sales}`, { overall_rating: 4 });
  assert.equal(r.status, 403, 'Sales is not their department');
  r = await call('hod', 'PUT', `/hod/queue/${id.hod}`, { overall_rating: 5 });
  assert.equal(r.status, 403, 'never their own rating');
  r = await call('hod', 'PUT', `/hod/queue/${id.mgr}`, { overall_rating: 4 });
  assert.equal(r.status, 409, 'no submitted manager evaluation');
  assert.equal((await call('hod', 'PUT', `/hod/queue/${id.emp}`, { overall_rating: 6 })).status, 422);
  assert.equal((await call('hod', 'PUT', `/hod/queue/${id.emp}`, { overall_rating: 3.3 })).status, 422, 'half steps only');
  assert.equal((await call('hod', 'PUT', `/hod/queue/${id.emp}`, { submit: true })).status, 422, 'no rating to submit');
  r = await call('hod', 'PUT', `/hod/queue/${id.emp}`, { overall_rating: 4.5, comment: 'Strong half' });
  assert.equal(r.status, 200);
  let q = await call('hod', 'GET', '/hod/queue');
  const row = q.body.queue.find((x) => x.employee_id === id.emp);
  assert.equal(row.hod_comment, 'Strong half', 'the saved comment comes back');
  assert.equal(row.manager_name, 'QARC mgr', 'search by manager has a name to match');
  assert.ok(!q.body.queue.some((x) => x.employee_id === id.sales), 'only their departments');
  assert.equal((await call('hod', 'PUT', `/hod/queue/${id.emp}`, { submit: true })).status, 200);
  r = await call('hod', 'PUT', `/hod/queue/${id.emp}`, { overall_rating: 1, submit: true });
  assert.equal(r.status, 409, 'a submitted HOD rating is locked');
  const he = (await db.query(`SELECT overall_rating, status FROM pms.hod_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, id.emp])).rows[0];
  assert.deepEqual([Number(he.overall_rating), he.status], [4.5, 'submitted']);
  assert.equal((await call('hod2', 'PUT', `/hod/queue/${id.sales}`, { overall_rating: 3, submit: true })).status, 200, 'the Sales HOD rates Sales');
});

test('an empty HOD queue says why', { skip }, async () => {
  await db.query(`DELETE FROM core.department_heads WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id.hod2]);
  const q = await call('hod2', 'GET', '/hod/queue');
  assert.equal(q.body.queue.length, 0);
  assert.equal(q.body.empty_reason, 'no_departments');
});

test('notifications point at real pages', { skip }, async () => {
  const src = require('fs').readFileSync(require.resolve('../modules/performance/index.js'), 'utf8')
    + require('fs').readFileSync(require.resolve('../modules/performance/approvals.js'), 'utf8')
    + require('fs').readFileSync(require.resolve('../modules/performance/reminders.js'), 'utf8')
    + require('fs').readFileSync(require.resolve('../modules/performance/profile-change.js'), 'utf8');
  for (const dead of ["'/pms/self-appraisal'", "'/pms/midyear-review'", "'/pms/my-rating'", "'/pms/my-growth'", "'/pms/team'", "'/pms/connects'", "'/pms/my/kras'", "'/my/midyear-review')", "link: '/pms'"]) {
    assert.ok(!src.includes(dead), `${dead} is not a page`);
  }
});
