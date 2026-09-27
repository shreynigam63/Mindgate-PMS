// node --test — giving a lot of people a login at once.
//
// Asked for on 27 Sep: "please build create bulk credentials option for
// Admin/HR login so they can create bulk credentials for employees from
// front end."
//
// WHAT THESE TESTS ARE REALLY FOR. A bulk credential run is one of the
// few things in this product that can lock a person out or let the wrong
// person in, and both failures are silent — "1,401 done" looks identical
// whether or not it quietly reset the CEO's password. So the assertions
// below are about who was PASSED OVER and why, about a password actually
// working afterwards, and about the plaintext never reaching the log or
// the audit row.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { generatePassword, decide, plan } = require('../core/bulk-credentials');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

// ---- the pure half: no database needed -------------------------------
test('a generated password is long, mixed, and never the same twice', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generatePassword();
    assert.ok(!seen.has(p), 'every password is its own');
    seen.add(p);
    assert.equal(p.replace(/-/g, '').length, 16);
    assert.match(p, /[a-z]/); assert.match(p, /[A-Z]/); assert.match(p, /[0-9]/);
    // The characters people misread when a password is dictated or
    // copied off a printout. One of these in a handout is a support call.
    assert.ok(!/[O0Il1o]/.test(p), `no ambiguous characters — got ${p}`);
  }
});

test('the pattern password is the first name, lower-cased, plus @123', () => {
  const { derivedPassword } = require('../core/bulk-credentials');
  const p = (name, email) => derivedPassword({ name, email: email === undefined ? 'x.y@mindgate.in' : email });
  assert.equal(p('Akshay Raut'), 'akshay@123');
  assert.equal(p('  Lohit  Lala  '), 'lohit@123', 'the double spaces in the HRMS export');
  assert.equal(p('PRIYA'), 'priya@123', 'lower-cased, or nobody can type it from the rule');
  // "M. Harikrishnan" must not become `M.@123` — the punctuation goes,
  // even though what is left is short. Short is what the client chose
  // when the alternatives were put to them; it is safe because the
  // password is replaced at the first sign-in.
  assert.equal(p('M. Harikrishnan'), 'm@123');
  assert.equal(p('R S Akshaya'), 'r@123');
  // A first token with no letters at all would leave a bare '@123',
  // which is not a password. The whole name is used instead.
  assert.equal(p('. Ramesh'), 'ramesh@123');
  assert.equal(p('-- --'), 'xy@123', 'and with no letters anywhere, the address');
  assert.equal(p('', ''), 'employee@123', 'never an empty password, whatever the row holds');
});

test('who is passed over, and for which reason', () => {
  const me = 'me-id';
  const base = { id: 'x', status: 'active', archived_at: null, has_login: false };
  assert.equal(decide({ ...base }), 'create');
  assert.equal(decide({ ...base, has_login: true }), 'skip_has_login');
  assert.equal(decide({ ...base, has_login: true }, { replaceExisting: true }), 'reset');
  assert.equal(decide({ ...base, id: me }, { actorId: me }), 'skip_self',
    'a bulk run does not change the password of the person running it');
  assert.equal(decide({ ...base, archived_at: new Date() }), 'skip_archived');
  assert.equal(decide({ ...base, status: 'inactive' }), 'skip_inactive',
    'sign-in is refused for inactive employees, so a password would be a lie');
  // Order matters: somebody archived who also has a login is reported as
  // archived, which is the fact that decides it.
  assert.equal(decide({ ...base, archived_at: new Date(), has_login: true }, { replaceExisting: true }),
    'skip_archived');
});

test('a placeholder address is flagged, never skipped', () => {
  // THE JUDGEMENT CALL THIS PINS DOWN. Somebody with no email on record
  // is a real employee and a login works for them; what does not work is
  // mailing them the password. Skipping them would leave HR counting a
  // short run and wondering what broke, so they are counted separately
  // and the row says so.
  const p = plan([
    { id: '1', name: 'A', email: 'a@x.com', status: 'active', has_login: false },
    { id: '2', name: 'B', email: 'b@no-email.invalid', status: 'active', has_login: false,
      email_is_placeholder: true },
  ]);
  assert.equal(p.will_write, 2);
  assert.equal(p.no_email_on_record, 1);
  assert.equal(p.rows[1].outcome, 'create');
  assert.equal(p.rows[1].placeholder_email, true);
});

test('the plan says who gets a short password, rather than leaving it to be found', () => {
  // Twenty people on the real master have a first name of three letters
  // or fewer once punctuation is stripped. HR should see that number
  // before the run, not hear it from a support call.
  const p = plan([
    { id: '1', name: 'Akshay Raut', email: 'a@x', status: 'active', has_login: false },
    { id: '2', name: 'M. Harikrishnan', email: 'b@x', status: 'active', has_login: false },
    { id: '3', name: 'Om Singh', email: 'c@x', status: 'active', has_login: false },
    // Already has one, so their short password is not about to be issued
    // and must not be counted.
    { id: '4', name: 'E Elasachin', email: 'd@x', status: 'active', has_login: true },
  ], { mode: 'name' });
  assert.equal(p.short_passwords, 2, 'm@123 and om@123 — not the one nobody is getting');
  assert.equal(p.rows[0].would_be, 'akshay@123');
});

test('the plan counts every row it was given', () => {
  const p = plan([
    { id: '1', name: 'A', email: 'a@x', status: 'active', has_login: false },
    { id: '2', name: 'B', email: 'b@x', status: 'active', has_login: true },
    { id: '3', name: 'C', email: 'c@x', status: 'inactive', has_login: false },
  ]);
  assert.deepEqual(p.counts, { create: 1, skip_has_login: 1, skip_inactive: 1 });
  assert.equal(p.will_write, 1);
  assert.equal(p.rows.length, 3, 'nobody vanishes from their own report');
  assert.ok(p.rows.every((r) => r.reason), 'and every row carries a sentence, not just a code');
});

// ---- the endpoint ----------------------------------------------------
let db, server, base, tenantId, ids = {};
const tok = {};

const call = async (path, t, opts = {}) => {
  const r = await fetch(`${base}${path}`, {
    ...opts, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (path, t, body) => call(path, t, { method: 'POST', body: JSON.stringify(body) });

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-bulkcreds';
  process.env.TENANT_SLUG = 'bulkcreds-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mk = async (key, name, email, extra = {}) => {
    const r = (await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,emp_code,archived_at)
       VALUES ($1,$2,$3,$4,'Executive','Delivery',$5,$6) RETURNING id`,
      [t.id, name, email, extra.status || 'active', extra.emp_code || null, extra.archived_at || null])).rows[0];
    ids[key] = r.id;
    return r.id;
  };
  await mk('admin', 'BC Admin', 'bc-admin@x.com', { emp_code: '00001' });
  await mk('plain', 'BC Plain', 'bc-plain@x.com', { emp_code: '00042' });
  await mk('withlogin', 'BC HasLogin', 'bc-has@x.com');
  await mk('inactive', 'BC Inactive', 'bc-inactive@x.com', { status: 'inactive' });
  await mk('archived', 'BC Archived', 'bc-arch@x.com', { archived_at: new Date() });
  await mk('noemail', 'BC NoEmail', 'bc-noemail@no-email.invalid');
  await mk('employee', 'BC Employee', 'bc-emp@x.com');

  for (const e of ['bc-admin@x.com', 'bc-has@x.com', 'bc-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass1234', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'bc-admin@x.com','admin')`, [t.id]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['admin', 'bc-admin@x.com'], ['employee', 'bc-emp@x.com']]) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'pass1234' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('an ordinary employee cannot issue credentials', { skip }, async () => {
  const r = await post('/employees/credentials/bulk', tok.employee, { dry_run: true });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /people_admin/);
});

test('the dry run writes nothing and explains every row', { skip }, async () => {
  const before = (await db.query(`SELECT count(*)::int n FROM core.local_credentials WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  const r = await post('/employees/credentials/bulk', tok.admin, { dry_run: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.committed, false);
  // Six on the list; the archived one is off it and is not swept in.
  assert.equal(r.body.rows.length, 6, `everyone on the list — got ${r.body.rows.map((x) => x.name).join(', ')}`);
  assert.ok(!r.body.rows.some((x) => x.name === 'BC Archived'), 'somebody off the list is not "everybody"');
  // admin is the caller (skip_self); plain and noemail have no login;
  // has-login and employee already have one; inactive cannot sign in.
  assert.deepEqual(r.body.counts,
    { create: 2, skip_has_login: 2, skip_inactive: 1, skip_self: 1 });
  assert.equal(r.body.will_write, 2);
  assert.equal(r.body.no_email_on_record, 1);
  const after_ = (await db.query(`SELECT count(*)::int n FROM core.local_credentials WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(after_, before, 'a dry run writes nothing');
});

test('a commit without ids is refused — the preview is what names the people', { skip }, async () => {
  const r = await post('/employees/credentials/bulk', tok.admin, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ids are required/);
});

test('the password it hands back is the password that signs you in', { skip }, async () => {
  // THE ONE THAT MATTERS. Everything else could pass while the stored
  // hash was of something else entirely, and nobody would find out until
  // 1,400 people tried to sign in.
  const r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.plain] });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);
  const row = r.body.rows.find((x) => x.email === 'bc-plain@x.com');
  assert.ok(row.password, 'the plaintext comes back once');

  const login = await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bc-plain@x.com', password: row.password }),
  });
  assert.equal(login.status, 200, 'and it works');

  const stored = (await db.query(
    `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='bc-plain@x.com'`,
    [tenantId])).rows[0].password_hash;
  assert.ok(stored.startsWith('$2'), 'stored as a bcrypt hash, not as the password');
  assert.ok(!stored.includes(row.password));
});

test('an existing login is left alone unless replacing is asked for', { skip }, async () => {
  const hashBefore = (await db.query(
    `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='bc-has@x.com'`,
    [tenantId])).rows[0].password_hash;

  let r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.withlogin] });
  assert.equal(r.body.created, 0);
  assert.equal(r.body.skipped, 1);
  assert.equal(r.body.rows[0].outcome, 'skip_has_login');
  assert.ok(!r.body.rows[0].password, 'and no password is invented for a row nobody touched');
  const same = (await db.query(
    `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='bc-has@x.com'`,
    [tenantId])).rows[0].password_hash;
  assert.equal(same, hashBefore, 'their working login is untouched');

  r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.withlogin], replace_existing: true });
  assert.equal(r.body.reset, 1);
  const changed = (await db.query(
    `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='bc-has@x.com'`,
    [tenantId])).rows[0].password_hash;
  assert.notEqual(changed, hashBefore);
  assert.ok(await bcrypt.compare(r.body.rows[0].password, changed));
});

test('the runner cannot reset their own password by sweeping everybody', { skip }, async () => {
  // Left out on purpose: somebody clearing "replace existing" over the
  // whole company would otherwise change the password they are signed in
  // with, discover it at the next sign-in, and have nobody to ask.
  const mine = (await db.query(
    `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='bc-admin@x.com'`,
    [tenantId])).rows[0].password_hash;
  const r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.admin], replace_existing: true });
  assert.equal(r.body.rows[0].outcome, 'skip_self');
  assert.equal((await db.query(
    `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='bc-admin@x.com'`,
    [tenantId])).rows[0].password_hash, mine);
});

test('inactive and archived people are named and refused, not given a dead login', { skip }, async () => {
  const r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.inactive, ids.archived] });
  assert.equal(r.body.created, 0);
  const by = Object.fromEntries(r.body.rows.map((x) => [x.name, x.outcome]));
  assert.deepEqual(by, { 'BC Inactive': 'skip_inactive', 'BC Archived': 'skip_archived' },
    'a row that was pointed at comes back with a reason');
  assert.equal((await db.query(
    `SELECT count(*)::int n FROM core.local_credentials WHERE tenant_id=$1 AND email IN ('bc-inactive@x.com','bc-arch@x.com')`,
    [tenantId])).rows[0].n, 0);
});

test('one password for everyone is allowed, but not a weak one', { skip }, async () => {
  let r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.noemail], mode: 'same', password: 'short' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 8 characters/);

  r = await post('/employees/credentials/bulk', tok.admin, { ids: [ids.noemail], mode: 'same', password: 'Mindgate#2026' });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.rows[0].password, 'Mindgate#2026');
  assert.equal(r.body.rows[0].placeholder_email, true, 'and the fact nobody can be told is carried on the row');
  const login = await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bc-noemail@no-email.invalid', password: 'Mindgate#2026' }),
  });
  assert.equal(login.status, 200);
});

test('the audit row records the run and NOT the passwords', { skip }, async () => {
  // A password written into core.audit_log is a password stored in
  // plaintext forever, in the one table nobody ever deletes from.
  const rows = (await db.query(
    `SELECT details::text FROM core.audit_log
      WHERE tenant_id=$1 AND action='EMPLOYEE_CREDENTIALS_BULK' ORDER BY at DESC`, [tenantId])).rows;
  assert.ok(rows.length >= 3, `every committing run is audited — got ${rows.length}`);
  for (const r of rows) {
    assert.ok(!/Mindgate#2026/.test(r.details), 'the shared password is not in the audit trail');
  }
  // Asserted as an exact key set rather than by grepping for the word
  // "password": the row legitimately records THAT a change is required,
  // and a grep would either trip on that or be loosened until it caught
  // nothing. An exact set fails the moment a new field appears, which is
  // when somebody should look at whether it belongs here.
  const latest = JSON.parse(rows[0].details);
  assert.deepEqual(Object.keys(latest).sort(),
    ['created', 'emails', 'mode', 'must_change_password', 'replace_existing', 'reset', 'skipped']);
  assert.ok(Array.isArray(latest.emails) && latest.emails.every((e) => typeof e === 'string' && e.includes('@')),
    'addresses only — never a password beside them');
});

test('a batch bigger than the cap is refused with the cap named', { skip }, async () => {
  // bcryptjs is ~90ms a hash, so an uncapped run of 1,427 is over two
  // minutes of one held request. The page batches; this is what tells it
  // the size to batch by.
  const many = Array.from({ length: 201 }, () => ids.plain);
  const r = await post('/employees/credentials/bulk', tok.admin, { ids: many });
  assert.equal(r.status, 413);
  assert.equal(r.body.max, 200);
  assert.match(r.body.error, /batches/);
});

test('a malformed id is a bad request, not a server error', { skip }, async () => {
  const r = await post('/employees/credentials/bulk', tok.admin, { ids: ['not-a-uuid'] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /employee ids/);
  assert.ok(!/uuid|syntax/i.test(r.body.error), 'and the database error is not handed to the caller');
});

test('unique mode really does give everyone a different password', { skip }, async () => {
  const fresh = [];
  for (let i = 0; i < 5; i++) {
    fresh.push((await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
       VALUES ($1,$2,$3,'active','Executive','Delivery') RETURNING id`,
      [tenantId, `Bulk ${i}`, `bulk-${i}@x.com`])).rows[0].id);
  }
  const r = await post('/employees/credentials/bulk', tok.admin, { ids: fresh });
  assert.equal(r.body.created, 5);
  const pws = r.body.rows.map((x) => x.password);
  assert.equal(new Set(pws).size, 5, 'five people, five passwords');
  // And each one opens its OWN account and not a neighbour's.
  for (const row of r.body.rows) {
    const ok = await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: row.email, password: row.password }),
    });
    assert.equal(ok.status, 200, `${row.email} can sign in`);
  }
  const wrong = await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: r.body.rows[0].email, password: r.body.rows[1].password }),
  });
  assert.equal(wrong.status, 401, "and not with somebody else's");
});
