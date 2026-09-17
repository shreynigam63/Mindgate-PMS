// node --test — who may write a KRA sheet, and when.
//
// Asked for on 17 Sep: "KRA should be open for all in entire cycle, but
// once KRA is submitted by employee it should be locked for him unless
// manager returns the KRA with any feedback."
//
// Before this, kra_open was the only phase in which a sheet could be
// touched, so HR rolled the WHOLE TENANT back to kra_open to let one late
// joiner write their KRAs — and that rollback reopened everybody else's
// sheet as a side effect, which is the opposite of locking. The lock now
// lives on the sheet, so one person can be reopened without disturbing
// anyone.
//
// The hole this closes is worth naming: PUT /my/kra-sheet/kras used to
// refuse only an 'approved' sheet. A submitted one was accepted, and the
// same transaction then set the status back to 'draft' — silently
// un-submitting the sheet and dropping it out of the manager's queue. The
// page hid the editor so nobody hit it by hand, but the route was open,
// and it becomes reachable the moment editing is open all year.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, empTok, mgrTok, hrTok, cycleId, empId, sheetId;

const as = (tok) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });
const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: as(tok), body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const phase = async (p) => db.query(`UPDATE pms.cycles SET phase=$1 WHERE id=$2`, [p, cycleId]);
const status = async () => (await db.query(`SELECT status FROM pms.kra_sheets WHERE id=$1`, [sheetId])).rows[0].status;
const setStatus = async (s) => db.query(`UPDATE pms.kra_sheets SET status=$1 WHERE id=$2`, [s, sheetId]);

const TWO = [{ title: 'Ship the thing', weight: 60 }, { title: 'Keep it up', weight: 40 }];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-lock';
  process.env.TENANT_SLUG = 'lock-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mgr = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'Lock Mgr','lock-mgr@x.com','active') RETURNING id`,
    [t.id])).rows[0];
  const emp = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,manager_id) VALUES ($1,'Lock Emp','lock-emp@x.com','active',$2) RETURNING id`,
    [t.id, mgr.id])).rows[0];
  empId = emp.id;
  const hr = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'Lock HR','lock-hr@x.com','active') RETURNING id`,
    [t.id])).rows[0];

  for (const [email, role] of [['lock-mgr@x.com', 'manager'], ['lock-hr@x.com', 'admin']]) {
    await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,$2,$3)`, [t.id, email, role]);
  }
  const hash = await bcrypt.hash('pass', 10);
  for (const email of ['lock-emp@x.com', 'lock-mgr@x.com', 'lock-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const c = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'Lock Cycle','FYL','annual','kra_open') RETURNING id`, [t.id])).rows[0];
  cycleId = c.id;
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,manager_id,status)
     VALUES ($1,$2,$3,$4,'draft') RETURNING id`, [t.id, cycleId, empId, mgr.id])).rows[0];
  sheetId = sheet.id;

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
  empTok = await login('lock-emp@x.com');
  mgrTok = await login('lock-mgr@x.com');
  hrTok = await login('lock-hr@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('A DRAFT SHEET IS EDITABLE IN EVERY RUNNING PHASE, not just KRA Setting', { skip }, async () => {
  for (const p of ['kra_open', 'mid_year_review', 'self_appraisal', 'manager_eval',
                   'hod_eval', 'calibration', 'publish']) {
    await phase(p);
    await setStatus('draft');
    const r = await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO });
    assert.equal(r.status, 200, `editing should be open in ${p}, got ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('a submitted sheet is LOCKED to the employee — the hole this closes', { skip }, async () => {
  await phase('kra_open');
  await setStatus('draft');
  assert.equal((await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO })).status, 200);
  assert.equal((await req('POST', '/pms/my/kra-sheet/submit', empTok, {})).status, 200);
  assert.equal(await status(), 'submitted');

  const save = await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: [{ title: 'Sneaky rewrite', weight: 100 }] });
  assert.equal(save.status, 409, 'a submitted sheet must refuse the save');
  assert.match(save.body.error, /submitted/);
  // The sharp end: the old route accepted this and reset the status to
  // draft, so the sheet vanished from the manager's pending queue.
  assert.equal(await status(), 'submitted', 'the refused save must not un-submit the sheet');
  const kras = (await db.query(`SELECT title FROM pms.kras WHERE sheet_id=$1`, [sheetId])).rows;
  assert.ok(!kras.some((k) => k.title === 'Sneaky rewrite'), 'and must not have written anything');
});

test('submitting twice is refused, rather than re-stamping the sheet', { skip }, async () => {
  await setStatus('submitted');
  const again = await req('POST', '/pms/my/kra-sheet/submit', empTok, {});
  assert.equal(again.status, 409);
});

test('A RETURN WITH FEEDBACK UNLOCKS IT AGAIN — and only with feedback', { skip }, async () => {
  await setStatus('submitted');
  const noComment = await req('POST', `/pms/team/kra-sheets/${sheetId}/decide`, mgrTok, { decision: 'returned' });
  assert.equal(noComment.status, 422, 'a return without a comment tells the employee nothing');
  assert.equal(await status(), 'submitted');

  const returned = await req('POST', `/pms/team/kra-sheets/${sheetId}/decide`, mgrTok,
    { decision: 'returned', comment: 'Weights look off on the second one.' });
  assert.equal(returned.status, 200);
  assert.equal(await status(), 'returned');

  const save = await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO });
  assert.equal(save.status, 200, 'a returned sheet is the employee\'s again');
  assert.equal((await req('POST', '/pms/my/kra-sheet/submit', empTok, {})).status, 200);
  assert.equal(await status(), 'submitted', 'and can go straight back');
});

test('the manager can still return a sheet LATE in the cycle', { skip }, async () => {
  // The reason kra_decide had to open too: a sheet submitted in kra_open
  // and looked at in calibration was previously impossible to return.
  await phase('calibration');
  await setStatus('submitted');
  const r = await req('POST', `/pms/team/kra-sheets/${sheetId}/decide`, mgrTok,
    { decision: 'returned', comment: 'Late look, please revise.' });
  assert.equal(r.status, 200);
  assert.equal((await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO })).status, 200);
});

test('an approved sheet stays locked, and HR reopens it without a rollback', { skip }, async () => {
  await phase('manager_eval');
  await setStatus('approved');
  const blocked = await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /approved/);

  // This used to 409 with "roll the cycle back to KRA Setting first",
  // which reopened every other employee's sheet to fix one.
  const reopen = await req('POST', `/pms/hr/kra-sheet/${empId}/reopen`, hrTok, { comment: 'Two KRAs moved teams.' });
  assert.equal(reopen.status, 200, `reopen should work in manager_eval: ${JSON.stringify(reopen.body)}`);
  assert.equal(await status(), 'returned');
  assert.equal((await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO })).status, 200);
});

test('a closed cycle is shut to everybody, whatever the sheet says', { skip }, async () => {
  await phase('closed');
  await setStatus('draft');
  const r = await req('PUT', '/pms/my/kra-sheet/kras', empTok, { kras: TWO });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /not open/);
});
