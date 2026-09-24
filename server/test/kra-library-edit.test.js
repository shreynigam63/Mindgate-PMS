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

// ---------------------------------------------------------------------
// ADDING ONE KRA, AND EMPTYING THE LIBRARY.
//
// Asked for on 24 Sep: "please provide option of clearing previous data
// on this page for uploading new data. also provide add and delete
// option for uploading/adding single KRA."
//
// Editing and removing one entry already existed (above). Adding one did
// not, so putting a single line on a shelf meant re-uploading the whole
// designation — which REPLACES it, so you had to reconstruct every other
// row first to add one.

test('ADDING ONE KRA lands it at the end of its own shelf', { skip }, async () => {
  const before = (await db.query(
    `SELECT count(*)::int AS n FROM pms.kra_library WHERE tenant_id=$1 AND designation='Executive'`,
    [tenantId])).rows[0].n;

  const r = await req('POST', '/pms/hr/kra-library/entry', hrTok, {
    designation: 'Executive', category: 'Customer', title: 'Answer the phone',
    measures: 'Within three rings', suggested_weight: '12.5',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.entry.title, 'Answer the phone');
  assert.equal(Number(r.body.entry.suggested_weight), 12.5, 'two decimal places, as the column stores');

  // At the END, not the top: adding a line must not reorder a shelf HR
  // has already published and people are reading.
  const shelf = (await db.query(
    `SELECT title, sort_order FROM pms.kra_library
      WHERE tenant_id=$1 AND designation='Executive' ORDER BY sort_order`, [tenantId])).rows;
  assert.equal(shelf.length, before + 1);
  assert.equal(shelf[shelf.length - 1].title, 'Answer the phone');
});

test('a hand-added KRA is indistinguishable from an uploaded one', { skip }, async () => {
  // Blank department means the company-wide shelf, stored as NULL —
  // which is exactly what the uploader does with a blank cell. If these
  // diverged, a hand-added row would match differently from an uploaded
  // one and nobody would know why.
  const r = await req('POST', '/pms/hr/kra-library/entry', hrTok, {
    designation: 'Executive', title: 'Company-wide line', department: '   ',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.entry.department, null, 'a blank department is NULL, not an empty string');
  assert.equal(r.body.entry.suggested_weight, null, 'and a blank weight is NULL, not 0');
});

test('the additions that are refused', { skip }, async () => {
  const bad = async (body, re) => {
    const r = await req('POST', '/pms/hr/kra-library/entry', hrTok, body);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, re);
  };
  await bad({ designation: 'Executive' }, /cannot be empty/i);
  await bad({ designation: 'Executive', title: '   ' }, /cannot be empty/i);
  await bad({ title: 'orphan' }, /designation/i);
  await bad({ designation: 'Executive', title: 'x', suggested_weight: 150 }, /between 0 and 100/);
  await bad({ designation: 'Executive', title: 'x', suggested_weight: -1 }, /between 0 and 100/);
  await bad({ designation: 'Executive', title: 'x', suggested_weight: 'abc' }, /must be a number/);
  assert.equal((await req('POST', '/pms/hr/kra-library/entry', empTok,
    { designation: 'Executive', title: 'x' })).status, 403, 'an employee cannot publish');
});

test('adding is audited', { skip }, async () => {
  await new Promise((r) => setTimeout(r, 200));
  const rows = (await db.query(
    `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_LIBRARY_ENTRY_ADDED'`,
    [tenantId])).rows;
  assert.ok(rows.length, 'a published shelf is configuration; changing one is audited');
  assert.ok(rows.some((r) => r.details.title === 'Answer the phone'));
});

test('EMPTYING THE LIBRARY needs the count, and matches it exactly', { skip }, async () => {
  const have = (await db.query(
    `SELECT count(*)::int AS n FROM pms.kra_library WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.ok(have > 1, 'there is something to clear');

  // No count at all.
  let r = await req('DELETE', '/pms/hr/kra-library', hrTok, {});
  assert.equal(r.status, 422);
  assert.match(r.body.error, /confirm_count is required/);
  assert.equal(r.body.have, have, 'and it tells you the number to send');

  // THE RACE THIS EXISTS FOR: the page loaded when the library held one
  // number, somebody published a shelf, and the count no longer matches.
  // Deleting anyway would silently take their work with it.
  r = await req('DELETE', '/pms/hr/kra-library', hrTok, { confirm_count: have - 1 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /changed since the page loaded/);

  assert.equal((await db.query(
    `SELECT count(*)::int AS n FROM pms.kra_library WHERE tenant_id=$1`, [tenantId])).rows[0].n,
    have, 'and not one row went');

  assert.equal((await req('DELETE', '/pms/hr/kra-library', empTok, { confirm_count: have })).status, 403,
    'an employee cannot empty the library');

  // Now for real.
  r = await req('DELETE', '/pms/hr/kra-library', hrTok, { confirm_count: have });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed, have);
  assert.equal((await db.query(
    `SELECT count(*)::int AS n FROM pms.kra_library WHERE tenant_id=$1`, [tenantId])).rows[0].n, 0);

  // Twice is not an error with a confusing message.
  r = await req('DELETE', '/pms/hr/kra-library', hrTok, { confirm_count: 0 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already empty/);
});

test('EMPTYING THE LIBRARY DOES NOT TOUCH WHAT PEOPLE ALREADY PICKED', { skip }, async () => {
  // The whole reason this is safe to offer. A KRA on somebody's sheet is
  // a COPY in pms.kras from the moment they pick it, so clearing the
  // library loses the menu, not the orders. If this ever stops being
  // true, the button above becomes the most destructive thing in the
  // product and this test is what says so.
  const kept = (await db.query(
    `SELECT count(*)::int AS n FROM pms.kras k
       JOIN pms.kra_sheets s ON s.id = k.sheet_id WHERE s.tenant_id=$1`, [tenantId])).rows[0].n;
  assert.ok(kept > 0, 'the earlier test left a picked KRA on a sheet');

  const still = (await db.query(
    `SELECT title FROM pms.kras k JOIN pms.kra_sheets s ON s.id = k.sheet_id
      WHERE s.tenant_id=$1`, [tenantId])).rows;
  assert.ok(still.length, 'and it is still there with the library gone');
});

test('the emptying is audited, with the number removed', { skip }, async () => {
  await new Promise((r) => setTimeout(r, 200));
  const rows = (await db.query(
    `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_LIBRARY_EMPTIED'`,
    [tenantId])).rows;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].details.removed > 0, 'how many went is part of the record');
});
