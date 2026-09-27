// node --test — the password HR issued is used once.
//
// Asked for on 27 Sep: "the password for all employees will be their
// name@123 and during login everyone should get change password option
// during first login", and compulsory on the client's own answer.
//
// THE POINT OF THESE TESTS. name@123 is guessable — that is not an
// accident, it is a pattern people are told. The whole safety of it
// rests on the password surviving exactly one sign-in, and on the lock
// being in the API rather than in a screen, because a screen is a
// suggestion that anyone with curl can decline. So the assertions below
// are mostly about what a TOKEN can still do, not about what a page
// shows.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, adminTok, empId;

const login = async (email, password) => {
  const r = await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const call = async (path, tok, opts = {}) => {
  const r = await fetch(`${base}${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-firstlogin';
  process.env.TENANT_SLUG = 'firstlogin-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin, changePassword, authenticate } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mk = async (name, email) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,$2,$3,'active','Executive','Delivery') RETURNING id`,
    [t.id, name, email])).rows[0].id;
  await mk('FL Admin', 'fl-admin@x.com');
  empId = await mk('Akshay Raut', 'fl-akshay@x.com');
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
    [t.id, 'fl-admin@x.com', await bcrypt.hash('adminpass1', 10)]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'fl-admin@x.com','admin')`, [t.id]);

  // Mounted exactly as server/index.js does, because the lock's allowlist
  // is matched on the full path — a test app that mounted /me somewhere
  // else would prove nothing about the real one.
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.post('/api/v1/auth/password', authenticate, changePassword);
  app.get('/api/v1/me', authenticate, (rq, rs) => rs.json({ user: rq.user, pages: null }));
  app.use('/api/v1/employees', require('../core/employees').router);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  adminTok = (await login('fl-admin@x.com', 'adminpass1')).body.token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the bulk run issues first-name@123 and marks it for replacement', { skip }, async () => {
  const r = await call('/employees/credentials/bulk', adminTok, {
    method: 'POST', body: JSON.stringify({ ids: [empId], mode: 'name' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);
  assert.equal(r.body.rows[0].password, 'akshay@123', '"Akshay Raut" — the rule the client asked for');
  assert.equal(r.body.must_change_password, true, 'and the report says so, so HR can tell people');

  const row = (await db.query(
    `SELECT must_change_password FROM core.local_credentials WHERE tenant_id=$1 AND email='fl-akshay@x.com'`,
    [tenantId])).rows[0];
  assert.equal(row.must_change_password, true);
});

test('the preview shows the exact password each person will get', { skip }, async () => {
  // A rule read off a slide is not the same as the string it produces for
  // a particular name. HR has to see "akshay@123" before it goes out.
  const r = await call('/employees/credentials/bulk', adminTok, {
    method: 'POST', body: JSON.stringify({ dry_run: true, mode: 'name', replace_existing: true }),
  });
  const row = r.body.rows.find((x) => x.email === 'fl-akshay@x.com');
  assert.equal(row.would_be, 'akshay@123');
  assert.equal(typeof r.body.short_passwords, 'number');
  // And not in the modes that do not use it — there is nothing to show.
  const other = await call('/employees/credentials/bulk', adminTok, {
    method: 'POST', body: JSON.stringify({ dry_run: true, mode: 'unique' }),
  });
  assert.ok(!other.body.rows.some((x) => x.would_be));
});

test('the issued password signs you in, and then opens nothing', { skip }, async () => {
  // THE ONE THAT MATTERS. A change-password SCREEN is a suggestion; this
  // asserts the API itself refuses, which is what makes "compulsory"
  // true for somebody holding the token rather than the page.
  const r = await login('fl-akshay@x.com', 'akshay@123');
  assert.equal(r.status, 200);
  assert.equal(r.body.user.must_change_password, true, 'the sign-in says a change is owed');
  const tok = r.body.token;

  for (const path of ['/employees', '/pms/home', '/pms/my/rating']) {
    const blocked = await call(path, tok);
    assert.equal(blocked.status, 403, `${path} is refused`);
    assert.equal(blocked.body.must_change_password, true,
      'and says why, so the page can send them to the right screen');
  }
});

test('two routes stay open, and only two', { skip }, async () => {
  const tok = (await login('fl-akshay@x.com', 'akshay@123')).body.token;
  // /me, because the page has to be able to learn that it is locked.
  const me = await call('/me', tok);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.must_change_password, true);
  // The change itself, reached while locked — otherwise the lock has no
  // exit and the account is simply dead.
  const bad = await call('/auth/password', tok, {
    method: 'POST', body: JSON.stringify({ current_password: 'wrong', new_password: 'Something9' }),
  });
  assert.equal(bad.status, 401, 'reachable, and still asks for the current password');
});

test('the current password is required, and the new one must be new', { skip }, async () => {
  const tok = (await login('fl-akshay@x.com', 'akshay@123')).body.token;
  const short = await call('/auth/password', tok, {
    method: 'POST', body: JSON.stringify({ current_password: 'akshay@123', new_password: 'abc' }),
  });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /at least 8/);

  // The one that would quietly defeat the whole thing: clearing the lock
  // while leaving the issued password in place.
  const same = await call('/auth/password', tok, {
    method: 'POST', body: JSON.stringify({ current_password: 'akshay@123', new_password: 'akshay@123' }),
  });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /different from the current/);
  assert.equal((await db.query(
    `SELECT must_change_password FROM core.local_credentials WHERE tenant_id=$1 AND email='fl-akshay@x.com'`,
    [tenantId])).rows[0].must_change_password, true, 'and the lock is still on');
});

test('changing it unlocks the app, in the same request', { skip }, async () => {
  const tok = (await login('fl-akshay@x.com', 'akshay@123')).body.token;
  const r = await call('/auth/password', tok, {
    method: 'POST', body: JSON.stringify({ current_password: 'akshay@123', new_password: 'MyOwnPass99' }),
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'a fresh token comes back');
  assert.equal(r.body.user.must_change_password, false);

  // The OLD token still carries the lock — it has to, it is a signed
  // claim — which is exactly why a new one is issued.
  assert.equal((await call('/pms/home', tok)).status, 403);
  assert.equal((await call('/pms/home', r.body.token)).status, 200, 'the new one works');

  // And the new password is the password.
  assert.equal((await login('fl-akshay@x.com', 'MyOwnPass99')).status, 200);
  assert.equal((await login('fl-akshay@x.com', 'akshay@123')).status, 401, 'the issued one is spent');
  assert.equal((await login('fl-akshay@x.com', 'MyOwnPass99')).body.user.must_change_password, false,
    'and signing in again does not ask twice');
});

test('a password HR sets for one person is one-use too', { skip }, async () => {
  // The Manage panel's own route, not the bulk one. Same reasoning: it is
  // a password chosen by somebody other than its owner.
  const r = await call(`/employees/${empId}/credentials`, adminTok, {
    method: 'POST', body: JSON.stringify({ password: 'ResetByHr1' }),
  });
  assert.equal(r.status, 200);
  const signIn = await login('fl-akshay@x.com', 'ResetByHr1');
  assert.equal(signIn.body.user.must_change_password, true);
  assert.equal((await call('/pms/home', signIn.body.token)).status, 403);
});

test('accounts that already had a password are not locked out by this', { skip }, async () => {
  // Nothing was backfilled, on purpose: flipping every existing
  // credential would have locked the client's own admin out of the PoC
  // at the moment of the deploy.
  const r = await login('fl-admin@x.com', 'adminpass1');
  assert.equal(r.body.user.must_change_password, false);
  assert.equal((await call('/pms/home', r.body.token)).status, 200);
});
