// node --test — My Rating stays shut until something is published.
//
// Asked for on 27 Sep: "my rating option should be visible to employee
// only when appraisal is published or it can be unclickable until
// appraisal is published."
//
// The number the menu and the two Home tiles read is
// me.published_count / GET /pms/my/rating/status. What these tests exist
// to pin down is WHICH count that is. The obvious reading — "is this
// cycle published" — is wrong, and wrong in a way nobody would notice
// until the following April: it takes last year's rating away from
// somebody the moment HR opens a new cycle, on a page whose entire
// purpose is the history.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, oldCycle, newCycle, empId, otherId;
const tok = {};

const get = async (path, t) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-rating-gate';
  process.env.TENANT_SLUG = 'rating-gate-' + Date.now();
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

  const mk = async (name, email) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department)
     VALUES ($1,$2,$3,'active','Executive','Delivery') RETURNING id`,
    [t.id, name, email])).rows[0].id;
  empId = await mk('R Employee', 'r-emp@x.com');
  otherId = await mk('R Other', 'r-other@x.com');
  for (const e of ['r-emp@x.com', 'r-other@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, await bcrypt.hash('pass', 10)]);
  }

  // Last year, closed. This year, just opened. activeCycle() picks the
  // open one, which is the whole point of the pair.
  oldCycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'FY25 Annual','FY25','annual','closed') RETURNING id`, [t.id])).rows[0].id;
  newCycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'FY26 Annual','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const [k, e] of [['employee', 'r-emp@x.com'], ['other', 'r-other@x.com']]) {
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

test('nothing published: the gate is shut, on both surfaces that read it', { skip }, async () => {
  const s = await get('/pms/my/rating/status', tok.employee);
  assert.equal(s.status, 200);
  assert.deepEqual(s.body, { count: 0, has_published: false });

  const h = await get('/pms/home', tok.employee);
  assert.equal(h.body.me.published_count, 0,
    'the Home tiles read this, and they must agree with the menu');

  // And the page itself is still honest rather than empty-looking.
  const r = await get('/pms/my/rating', tok.employee);
  assert.deepEqual(r.body.history, []);
});

test('a rating published in a CLOSED cycle opens the gate', { skip }, async () => {
  // THE BUG THIS PREVENTS. me.published is the CURRENT cycle's row, and
  // it is null here — FY26 has only just opened. Gating on it would hide
  // this person's FY25 rating for the whole of FY26, which is the one
  // thing My Rating exists to show.
  await db.query(
    `INSERT INTO pms.employee_performance_history
       (tenant_id, employee_id, cycle_id, final_rating, rating_label)
     VALUES ($1,$2,$3,4.0,'Exceeds')`, [tenantId, empId, oldCycle]);

  const h = await get('/pms/home', tok.employee);
  assert.equal(h.body.cycle.name, 'FY26 Annual', 'the open cycle is the current one');
  assert.equal(h.body.me.published, null, 'and nothing is published IN it');
  assert.equal(h.body.me.published_count, 1, 'yet the gate is open, because last year was');

  const s = await get('/pms/my/rating/status', tok.employee);
  assert.deepEqual(s.body, { count: 1, has_published: true });
});

test('the count is the caller\'s own, never anybody else\'s', { skip }, async () => {
  // Two employees, one published rating between them. A count read off
  // the tenant instead of the person would open the menu for the whole
  // company the moment one rating landed.
  const s = await get('/pms/my/rating/status', tok.other);
  assert.deepEqual(s.body, { count: 0, has_published: false });
  const h = await get('/pms/home', tok.other);
  assert.equal(h.body.me.published_count, 0);
});

test('every published cycle counts, not just the latest', { skip }, async () => {
  await db.query(
    `INSERT INTO pms.employee_performance_history
       (tenant_id, employee_id, cycle_id, final_rating, rating_label)
     VALUES ($1,$2,$3,3.5,'Meets')`, [tenantId, empId, newCycle]);
  const s = await get('/pms/my/rating/status', tok.employee);
  assert.deepEqual(s.body, { count: 2, has_published: true });
  const h = await get('/pms/home', tok.employee);
  assert.equal(h.body.me.published_count, 2);
  assert.equal(Number(h.body.me.published.final_rating), 3.5,
    'and the current cycle still reports its own rating separately');
});

test('between cycles the gate still reads, rather than disappearing', { skip }, async () => {
  // home() returns early when no cycle is open — the branch that used to
  // carry no `me` at all. Somebody sitting between cycles would then have
  // had My Rating locked with a published rating in hand.
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE tenant_id=$1`, [tenantId]);
  const h = await get('/pms/home', tok.employee);
  assert.equal(h.body.cycle, null, 'no cycle is open');
  assert.equal(h.body.me.published_count, 2, 'and the gate is still answerable');
  assert.equal(h.body.action.kind, 'no_cycle');
  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE id=$1`, [newCycle]);
});
