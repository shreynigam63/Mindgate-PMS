// node --test — editing a published KRA in place.
//
// Asked for on 17 Sep: "KRAs and weightage should be editable for HR and
// admin login under KRA library." Before this the only way to fix a typo
// in a published KRA was to re-upload the whole designation — which
// nobody does for one word, so the typo stayed on every employee's shelf.
//
// The rule that matters most is the LAST test: editing the shelf must not
// touch KRAs already copied onto somebody's appraisal. The library is a
// menu; what an employee picked is theirs from that moment.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, hrTok, empTok, tenantId, entryId;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const entry = async (id) => (await db.query(
  `SELECT * FROM pms.kra_library WHERE id=$1`, [id || entryId])).rows[0];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kedit';
  process.env.TENANT_SLUG = 'kedit-test-' + Date.now();
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
  for (const [name, email] of [['KE HR', 'ke-hr@x.com'], ['KE Emp', 'ke-emp@x.com']]) {
    await db.query(`INSERT INTO core.employees (tenant_id,name,email,status,designation) VALUES ($1,$2,$3,'active','Executive')`,
      [t.id, name, email]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ke-hr@x.com','admin')`, [t.id]);

  entryId = (await db.query(
    `INSERT INTO pms.kra_library (tenant_id, designation, category, title, measures, description, suggested_weight, sort_order)
     VALUES ($1,'Executive','Delivery','Delivar the thing','Sprints closed','a note',20,10) RETURNING id`,
    [t.id])).rows[0].id;

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
  hrTok = await login('ke-hr@x.com');
  empTok = await login('ke-emp@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('HR FIXES THE TYPO AND THE WEIGHT, IN ONE ROW', { skip }, async () => {
  const r = await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok, {
    title: 'Deliver the thing', suggested_weight: 25,
    category: 'Delivery', measures: 'Sprints closed on plan', description: 'a note',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = await entry();
  assert.equal(e.title, 'Deliver the thing');
  assert.equal(Number(e.suggested_weight), 25);
  assert.equal(e.measures, 'Sprints closed on plan');
});

test('a blank weight means "no suggested weight", not zero', { skip }, async () => {
  // 0% and "not specified" read differently to the employee picking from
  // the shelf, so they are stored differently.
  await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok, { title: 'Deliver the thing', suggested_weight: '' });
  assert.equal((await entry()).suggested_weight, null);
  await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok, { title: 'Deliver the thing', suggested_weight: 0 });
  assert.equal(Number((await entry()).suggested_weight), 0, 'an explicit zero is still a zero');
});

test('the edits that are refused', { skip }, async () => {
  const bad = async (body, re) => {
    const r = await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok, body);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, re);
  };
  await bad({ title: '   ' }, /cannot be empty/);
  await bad({ title: 'x', suggested_weight: 'soon' }, /must be a number/);
  await bad({ title: 'x', suggested_weight: 101 }, /between 0 and 100/);
  await bad({ title: 'x', suggested_weight: -5 }, /between 0 and 100/);
  // …and none of them changed anything.
  assert.equal((await entry()).title, 'Deliver the thing');
});

test('a decimal weight is kept to two places, as the column stores it', { skip }, async () => {
  await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok, { title: 'Deliver the thing', suggested_weight: 12.345 });
  assert.equal(Number((await entry()).suggested_weight), 12.35);
});

test('an ordinary employee cannot edit or remove, and a bad id is a clean 404/400', { skip }, async () => {
  assert.equal((await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, empTok, { title: 'mine now' })).status, 403);
  assert.equal((await req('DELETE', `/pms/hr/kra-library/entry/${entryId}`, empTok)).status, 403);
  assert.equal((await entry()).title, 'Deliver the thing');

  const gone = await req('PUT', '/pms/hr/kra-library/entry/11111111-1111-1111-1111-111111111111', hrTok, { title: 'x' });
  assert.equal(gone.status, 404);
  // Not a uuid at all — a 400 from the guard, never a 500 with a driver message.
  assert.equal((await req('PUT', '/pms/hr/kra-library/entry/not-a-uuid', hrTok, { title: 'x' })).status, 400);
});

test('the edit is audited, with what it was before', { skip }, async () => {
  // pms.audit_log, not core.audit_log — this module's audit() helper
  // writes to the performance log, as every other KRA action here does.
  await db.query(`DELETE FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_LIBRARY_ENTRY_EDITED'`, [tenantId]);
  await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok, { title: 'Deliver the thing, well', suggested_weight: 30 });
  // audit() is fire-and-forget by design (a failed audit must not fail
  // the edit), so give the insert a moment rather than racing it.
  await new Promise((r) => setTimeout(r, 150));
  const rows = (await db.query(
    `SELECT actor_email, details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_LIBRARY_ENTRY_EDITED'`,
    [tenantId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_email, 'ke-hr@x.com');
  assert.equal(rows[0].details.before.title, 'Deliver the thing');
  assert.equal(rows[0].details.after.title, 'Deliver the thing, well');
});

test('removing one line leaves the rest of the shelf alone', { skip }, async () => {
  const second = (await db.query(
    `INSERT INTO pms.kra_library (tenant_id, designation, title, suggested_weight, sort_order)
     VALUES ($1,'Executive','Second KRA',40,20) RETURNING id`, [tenantId])).rows[0].id;
  assert.equal((await req('DELETE', `/pms/hr/kra-library/entry/${second}`, hrTok)).status, 200);
  assert.equal(await entry(second), undefined);
  assert.ok(await entry(), 'the other KRA on the shelf survives');
  assert.equal((await req('DELETE', `/pms/hr/kra-library/entry/${second}`, hrTok)).status, 404, 'removing it twice is a 404');
});

test('EDITING THE SHELF DOES NOT TOUCH WHAT SOMEBODY ALREADY PICKED', { skip }, async () => {
  // The whole contract of the library: an employee's KRA is a COPY taken
  // when they chose it. If an edit here reached their sheet, HR could
  // silently rewrite objectives somebody is already being appraised on.
  const emp = (await db.query(`SELECT id FROM core.employees WHERE email='ke-emp@x.com'`)).rows[0];
  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'KE Cycle','FYKE','annual','kra_open') RETURNING id`, [tenantId])).rows[0];
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'draft') RETURNING id`,
    [tenantId, cycle.id, emp.id])).rows[0];
  const lib = await entry();
  await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, measures, weight, sort_order)
     VALUES ($1,$2,$3,$4,$5,10)`,
    [tenantId, sheet.id, lib.title, lib.measures, lib.suggested_weight]);

  await req('PUT', `/pms/hr/kra-library/entry/${entryId}`, hrTok,
    { title: 'COMPLETELY REWRITTEN BY HR', suggested_weight: 5 });

  const onSheet = (await db.query(`SELECT title, weight FROM pms.kras WHERE sheet_id=$1`, [sheet.id])).rows[0];
  assert.equal(onSheet.title, 'Deliver the thing, well', 'the copy on the appraisal is untouched');
  assert.equal(Number(onSheet.weight), 30);

  // …and removing the library row does not delete it from the sheet either.
  await req('DELETE', `/pms/hr/kra-library/entry/${entryId}`, hrTok);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.kras WHERE sheet_id=$1`, [sheet.id])).rows[0].n, 1);
});
