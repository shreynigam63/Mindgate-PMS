// node --test — adding and removing departments (migration 038).
//
// Asked for directly: "Department Heads add/remove department option which
// must be editable." Before this a department was not a thing you could
// manage — the page derived its list from `SELECT DISTINCT department FROM
// core.employees`, so a department could not be set up before its first
// hire, and a typo from one HRMS import stayed on the page for ever.
//
// THE RULE THAT CARRIES THE WEIGHT is "A DEPARTMENT WITH PEOPLE IN IT
// CANNOT BE REMOVED". Without it, removing a department leaves employees
// pointing at something no longer on the list — which is worse than not
// having the button at all.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, empTok, tenantId, headId;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const list = async () => (await req('GET', '/employees/department-heads', hrTok)).body.departments;
const find = async (name) => (await list()).find((d) => d.department.toLowerCase() === name.toLowerCase());

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deptreg';
  process.env.TENANT_SLUG = 'deptreg-test-' + Date.now();
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

  // Two people in Finance, nobody in anything else.
  for (const [name, email, dept] of [
    ['DR HR', 'dr-hr@x.com', 'Finance'],
    ['DR Emp', 'dr-emp@x.com', 'Finance'],
  ]) {
    const e = (await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
       VALUES ($1,$2,$3,'active','Executive',$4) RETURNING id`, [t.id, name, email, dept])).rows[0];
    if (email === 'dr-hr@x.com') headId = e.id;
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'dr-hr@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'dr-emp@x.com','employee')`, [t.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  hrTok = await login('dr-hr@x.com');
  empTok = await login('dr-emp@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

// NOTE ON THE FIXTURE: this harness creates the tenant and its employees
// AFTER runMigrations(), so migration 038's seed-from-employees step sees an
// empty table and registers nothing. That is a property of the test setup,
// not of the migration — on a real deploy the employees are already there
// and the seed fills the registry. What this test proves is the half that
// does not depend on the seed: a department people are IN is listed and
// cannot be removed, whether or not it was ever registered.
test('a department employees hold is listed, counted, and not removable', { skip }, async () => {
  const fin = await find('Finance');
  assert.ok(fin, 'Finance should be listed');
  assert.equal(fin.employees, 2);
  assert.equal(fin.in_use, true);
  assert.equal(fin.registered, false, 'derived only in this fixture — see the note above');
  assert.equal(fin.removable, false, 'a department with people in it is not removable');
});

test('HR ADDS A DEPARTMENT BEFORE ANYBODY IS IN IT', { skip }, async () => {
  const r = await req('POST', '/employees/departments', hrTok, { name: 'Cloud Ops' });
  assert.equal(r.status, 200);
  assert.equal(r.body.department, 'Cloud Ops');
  assert.equal(r.body.employees, 0);

  const d = await find('Cloud Ops');
  assert.ok(d, 'it appears on the page');
  assert.equal(d.employees, 0);
  assert.equal(d.in_use, false);
  assert.equal(d.registered, true);
  assert.equal(d.removable, true);
});

test('an empty department can be given a Delivery Head — the reason to add it early', { skip }, async () => {
  const r = await req('PUT', '/employees/department-heads/Cloud%20Ops', hrTok, { employee_id: headId });
  assert.equal(r.status, 200);
  const d = await find('Cloud Ops');
  assert.ok(d.head, 'the head sticks on a department nobody is in');
  assert.equal(d.head.employee_id, headId);
});

test('the refusals are stated, not silent', { skip }, async () => {
  const blank = await req('POST', '/employees/departments', hrTok, { name: '   ' });
  assert.equal(blank.status, 422);
  assert.match(blank.body.error, /needs a name/i);

  const dupe = await req('POST', '/employees/departments', hrTok, { name: 'Cloud Ops' });
  assert.equal(dupe.status, 409);
  assert.match(dupe.body.error, /already on the list/i);

  // Case-insensitive: "cloud ops" is the same department to every human.
  const ci = await req('POST', '/employees/departments', hrTok, { name: 'cloud ops' });
  assert.equal(ci.status, 409, 'case must not create a second Cloud Ops');

  const long = await req('POST', '/employees/departments', hrTok, { name: 'x'.repeat(121) });
  assert.equal(long.status, 422);
  assert.match(long.body.error, /121 characters/);
});

test('A DEPARTMENT WITH PEOPLE IN IT CANNOT BE REMOVED', { skip }, async () => {
  const r = await req('DELETE', '/employees/departments/Finance', hrTok);
  assert.equal(r.status, 409);
  assert.equal(r.body.employees, 2);
  assert.match(r.body.error, /2 active employees are still in "Finance"/);

  // And nothing was removed by the attempt.
  const fin = await find('Finance');
  assert.ok(fin, 'Finance is still listed');
  assert.equal(fin.employees, 2);
  const still = (await db.query(
    `SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1 AND department='Finance'`, [tenantId])).rows[0].n;
  assert.equal(still, 2, 'no employee record was touched');
});

test('removing an empty department clears its head and changes no employee', { skip }, async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId])).rows[0].n;

  const r = await req('DELETE', '/employees/departments/Cloud%20Ops', hrTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.head_cleared, true, 'the Delivery Head mapping goes with it');

  assert.equal(await find('Cloud Ops'), undefined, 'gone from the page');
  const head = (await db.query(
    `SELECT count(*)::int AS n FROM core.department_heads WHERE tenant_id=$1 AND department='Cloud Ops'`, [tenantId])).rows[0].n;
  assert.equal(head, 0, 'no orphan head row left to resurrect it');

  const after_ = (await db.query(`SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(after_, before, 'no employee record was touched');
});

test('removing something not on the list says so', { skip }, async () => {
  const r = await req('DELETE', '/employees/departments/Nope', hrTok);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /not on the list/i);
});

test('an ordinary employee cannot add or remove a department', { skip }, async () => {
  const add = await req('POST', '/employees/departments', empTok, { name: 'Shadow IT' });
  assert.equal(add.status, 403);
  const del = await req('DELETE', '/employees/departments/Finance', empTok);
  assert.equal(del.status, 403);
  assert.equal(await find('Shadow IT'), undefined, 'and nothing was created');
});

test('adding a department employees are ALREADY in registers it rather than refusing', { skip }, async () => {
  // Finance is held but never registered (see the fixture note above), which
  // is exactly this branch: don't refuse, register it — that is what turns a
  // derived-only name into one HR can manage. The employees are untouched.
  const before = (await db.query(
    `SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1 AND department='Finance'`, [tenantId])).rows[0].n;

  const r = await req('POST', '/employees/departments', hrTok, { name: 'Finance' });
  assert.equal(r.status, 200);
  assert.equal(r.body.employees, 2);
  assert.match(r.body.note, /2 employees already in it/);

  const fin = await find('Finance');
  assert.equal(fin.registered, true, 'now manageable');
  assert.equal(fin.in_use, true);
  assert.equal(fin.removable, false, 'still not removable — people are in it');
  assert.equal((await db.query(
    `SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1 AND department='Finance'`, [tenantId])).rows[0].n,
    before, 'no employee record was touched');

  // And a second attempt is now the duplicate case.
  const again = await req('POST', '/employees/departments', hrTok, { name: 'Finance' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already on the list/i);
});

test('every add and remove is audited', { skip }, async () => {
  await req('POST', '/employees/departments', hrTok, { name: 'Audit Me' });
  await req('DELETE', '/employees/departments/Audit%20Me', hrTok);
  await new Promise((r) => setTimeout(r, 150));   // the audit write is fire-and-forget
  const rows = (await db.query(
    `SELECT action, details FROM core.audit_log
      WHERE tenant_id=$1 AND action IN ('DEPARTMENT_ADDED','DEPARTMENT_REMOVED')
        AND details->>'department'='Audit Me' ORDER BY action`, [tenantId])).rows;
  assert.deepEqual(rows.map((r) => r.action), ['DEPARTMENT_ADDED', 'DEPARTMENT_REMOVED']);
});
