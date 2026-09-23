// node --test — a shelf published WITH a department must still be found.
//
// Reported from the PoC on 23 Sep: "after changing department and
// designation, new KRAs were not fetched in view library."
//
// Reproduced, and it is not a caching problem — the server re-reads the
// employee's designation on every request. The hole is in the matching.
// Three queries look for a shelf, in order: the department the viewer
// ASKED for, the department they are IN (only when department matching is
// switched on), and finally the company-wide shelf, which demands the
// department column be BLANK. So a library uploaded with departments
// filled in, on a tenant left at the DEFAULT scope of 'designation', has
// no query that can reach it. The picker then reported
//
//     "No KRA library has been published for Cloud Engineer"
//
// while two rows for Cloud Engineer sat in pms.kra_library.
//
// That is the failure this file pins, and it is worse than an empty
// state: it tells HR an upload did not land and sends them to do it
// again. Matching on designation alone is precisely what
// scope='designation' means, so serving those rows is the setting doing
// its job.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;
const tok = {};

const get = async (path, t) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-dos';
  process.env.TENANT_SLUG = 'dos-test-' + Date.now();
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
  // NOTE: kra_library_scope is deliberately NOT set. The default is
  // 'designation', which is the configuration the bug needs — and the one
  // every tenant has until somebody changes it.

  const people = [
    ['Cloud One', 'dos-cloud@x.com', 'Technology', 'Cloud Engineer'],
    ['Split Person', 'dos-split@x.com', 'Sales', 'Solution Architect'],
    ['Plain Person', 'dos-plain@x.com', 'Finance', 'Accountant'],
  ];
  for (const [name, email, dept, desig] of people) {
    await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
       VALUES ($1,$2,$3,'active',$4,$5)`, [t.id, name, email, dept, desig]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }

  // Cloud Engineer: two rows, BOTH carrying a department, none company-wide.
  // Solution Architect: rows under two different departments, so there is
  //   no single honest answer to "which department's shelf is this".
  // Accountant: an ordinary company-wide shelf, to prove the common path
  //   is untouched by the fix.
  const lib = [
    ['Technology', 'Cloud Engineer', 'Platform uptime and incident response', 40],
    ['Technology', 'Cloud Engineer', 'Cost optimisation on cloud spend', 30],
    ['Sales', 'Solution Architect', 'Pre-sales solution design', 50],
    ['Delivery', 'Solution Architect', 'Delivery handover quality', 50],
    [null, 'Accountant', 'Monthly close on time', 60],
  ];
  for (const [dept, desig, title, w] of lib) {
    await db.query(
      `INSERT INTO pms.kra_library (tenant_id, department, designation, title, suggested_weight, sort_order)
       VALUES ($1,$2,$3,$4,$5,1)`, [t.id, dept, desig, title, w]);
  }

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['cloud', 'dos-cloud@x.com'], ['split', 'dos-split@x.com'], ['plain', 'dos-plain@x.com']]) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('THE BUG: a shelf that only exists under a department is still served', { skip }, async () => {
  const { status, body } = await get('/pms/my/kra-library', tok.cloud);
  assert.equal(status, 200);
  assert.equal(body.scope, 'designation', 'the default scope, which is where this broke');
  assert.equal(body.reason, null,
    'claiming "no library" while rows for this designation exist is a false empty state');
  assert.deepEqual(body.entries.map(e => e.title).sort(), [
    'Cost optimisation on cloud spend',
    'Platform uptime and incident response',
  ]);
});

test('and it says which department wrote them, rather than passing them off as company-wide', { skip }, async () => {
  const { body } = await get('/pms/my/kra-library', tok.cloud);
  assert.equal(body.matched_department, 'Technology');
  assert.equal(body.matched_scope, 'department');
  assert.equal(body.served_across_departments, false);
});

test('rows from several departments are served together, and SAID to be', { skip }, async () => {
  // There is no single department that wrote this title's shelf, so
  // naming one would be a claim the data does not support.
  const { body } = await get('/pms/my/kra-library', tok.split);
  assert.equal(body.reason, null);
  assert.equal(body.entries.length, 2);
  assert.equal(body.matched_department, null, 'no one department can be credited');
  assert.equal(body.served_across_departments, true);
});

test('the ordinary company-wide shelf is untouched by the fallback', { skip }, async () => {
  const { body } = await get('/pms/my/kra-library', tok.plain);
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].title, 'Monthly close on time');
  assert.equal(body.matched_department, null);
  assert.equal(body.served_across_departments, false,
    'it came from the company-wide shelf, not from a merge');
});

test('a designation with nothing published still says so honestly', { skip }, async () => {
  // The fallback must not turn a genuine empty state into a wrong one by
  // reaching for some other title's rows.
  await db.query(`UPDATE core.employees SET designation='Nobody Holds This'
                   WHERE tenant_id=$1 AND email='dos-plain@x.com'`, [tenantId]);
  const { body } = await get('/pms/my/kra-library', tok.plain);
  assert.equal(body.reason, 'no_library');
  assert.equal(body.entries.length, 0);
});
