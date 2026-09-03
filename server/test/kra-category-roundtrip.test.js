// node --test — the KRA sheet's "Parameters" column (pms.kras.category)
// survives a save, and the picker has something to offer.
//
// THE BUG THIS PINS. Both KRA save paths DELETE every KRA on the sheet and
// re-insert them, and the insert omitted category. So one press of "Save
// draft" silently wiped every Parameters value the bulk import had stored
// — on a save that changed nothing else, because the page never rendered
// the field and so never sent it back. Nothing failed, nothing logged; the
// only reader (review-assist) just quietly started grouping by null.
//
// A round-trip test is the only kind that catches this: the INSERT was
// valid SQL, the GET returned the column, and every individual piece
// looked right. Real Postgres; skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, hrId;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kcr';
  process.env.TENANT_SLUG = 'kcr-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const cors = require('cors');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'KCR Mgr','kcr-mgr@x.com','active') RETURNING id`, [t.id])).rows[0];
  const emp = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, manager_id) VALUES ($1,'KCR Emp','kcr-emp@x.com','active',$2) RETURNING id`, [t.id, mgr.id])).rows[0];
  const hr = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,'KCR HR','kcr-hr@x.com','active') RETURNING id`, [t.id])).rows[0];
  empId = emp.id; hrId = hr.id;
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'kcr-hr@x.com','hr')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['kcr-emp@x.com', 'kcr-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  // kra_open, so the save paths are actually reachable.
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase) VALUES ($1,'KCR Cycle','FYKCR','annual','kra_open') RETURNING id`,
    [t.id])).rows[0];
  cycleId = cycle.id;

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

const catsOf = async () => (await db.query(
  `SELECT k.title, k.category FROM pms.kras k JOIN pms.kra_sheets s ON s.id = k.sheet_id
    WHERE s.cycle_id=$1 AND s.employee_id=$2 ORDER BY k.sort_order`, [cycleId, empId])).rows;

test('an employee save keeps the Parameter on each KRA', { skip }, async () => {
  const { token } = await login('kcr-emp@x.com');
  await api('/pms/my/kra-sheet', token); // creates the sheet
  const put = await api('/pms/my/kra-sheet/kras', token, {
    method: 'PUT',
    body: JSON.stringify({ kras: [
      { title: 'Project Budget Adherence', weight: 60, category: 'Financial', measures: 'Within allocated budget' },
      { title: 'Team Retention', weight: 40, category: 'People' },
    ] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await catsOf(), [
    { title: 'Project Budget Adherence', category: 'Financial' },
    { title: 'Team Retention', category: 'People' },
  ]);
});

test('a second save that changes nothing does not wipe the Parameters', { skip }, async () => {
  // The exact reported shape: re-send what the GET just handed back. This
  // is what pressing "Save draft" twice does, and it used to clear the
  // column because the payload never carried it.
  const { token } = await login('kcr-emp@x.com');
  const get = await api('/pms/my/kra-sheet', token);
  const put = await api('/pms/my/kra-sheet/kras', token, { method: 'PUT', body: JSON.stringify({ kras: get.body.kras }) });
  assert.equal(put.status, 200);
  assert.deepEqual(await catsOf(), [
    { title: 'Project Budget Adherence', category: 'Financial' },
    { title: 'Team Retention', category: 'People' },
  ]);
});

test('the GET returns the Parameter, so the page can render and return it', { skip }, async () => {
  const { token } = await login('kcr-emp@x.com');
  const get = await api('/pms/my/kra-sheet', token);
  assert.equal(get.status, 200);
  assert.equal(get.body.kras[0].category, 'Financial');
  assert.equal(get.body.kras[1].category, 'People');
});

test('known_categories offers what the tenant already uses, sorted and deduped', { skip }, async () => {
  const { token } = await login('kcr-emp@x.com');
  const get = await api('/pms/my/kra-sheet', token);
  assert.deepEqual(get.body.known_categories, ['Financial', 'People']);
});

test('a blank or whitespace-only Parameter is stored as NULL, not as an empty group', { skip }, async () => {
  // "" and "   " are the same thing as "unset" — storing them would make
  // the grouping show two separate empty headings.
  const { token } = await login('kcr-emp@x.com');
  const put = await api('/pms/my/kra-sheet/kras', token, {
    method: 'PUT',
    body: JSON.stringify({ kras: [
      { title: 'Project Budget Adherence', weight: 60, category: 'Financial' },
      { title: 'Loose End', weight: 25, category: '   ' },
      { title: 'Other Loose End', weight: 15, category: '' },
    ] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await catsOf(), [
    { title: 'Project Budget Adherence', category: 'Financial' },
    { title: 'Loose End', category: null },
    { title: 'Other Loose End', category: null },
  ]);
  const get = await api('/pms/my/kra-sheet', token);
  assert.deepEqual(get.body.known_categories, ['Financial'], 'and a blank never becomes a pickable option');
});

test('HR entering KRAs on behalf keeps the Parameter too', { skip }, async () => {
  // The same delete-and-reinsert, in the second handler. Fixing one and
  // not the other would mean the value survived until HR touched it.
  const { token } = await login('kcr-hr@x.com');
  const put = await api(`/pms/hr/kra-sheet/${empId}/kras`, token, {
    method: 'PUT',
    body: JSON.stringify({ kras: [
      { title: 'Customer Escalations', weight: 100, category: 'Customer' },
    ] }),
  });
  assert.equal(put.status, 200);
  assert.deepEqual(await catsOf(), [{ title: 'Customer Escalations', category: 'Customer' }]);
  const get = await api(`/pms/hr/kra-sheet/${empId}`, token);
  assert.deepEqual(get.body.known_categories, ['Customer'], 'the HR view offers the picker options as well');
});
