// node --test — saving a KRA sheet must KEEP the id of every KRA it keeps.
//
// Reported from the client's instance on 17 Sep: "KRAs are not updated in
// My Growth Page and Mid Year page after it is changed and submitted from
// My KRAs page." The pages read KRAs live, so the titles were right — what
// was wrong is that everything POINTING at a KRA had been orphaned.
//
// PUT /my/kra-sheet/kras used to DELETE every row and re-INSERT, handing
// each KRA a brand-new uuid on every save. Three things reference those
// uuids:
//     pms.midyear_checkins.self_entries / .manager_entries  (keyed by kra_id)
//     pms.development_goals.kra_id
//     pms.evidence.kra_id / pms.connects.kra_ids
// so fixing a typo in ONE KRA silently threw away every mid-year rating and
// narrative the employee had written.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tok, tenantId, cycleId, empId;

const req = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sheetKras = async () => (await req('GET', '/pms/my/kra-sheet')).body.kras;
const save = (kras) => req('PUT', '/pms/my/kra-sheet/kras', { kras });

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kraid';
  process.env.TENANT_SLUG = 'kraid-test-' + Date.now();
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
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation) VALUES ($1,'KI Emp','ki-emp@x.com','active','Executive') RETURNING id`,
    [t.id])).rows[0].id;
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'ki-emp@x.com',$2)`,
    [t.id, await bcrypt.hash('pass', 10)]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ki-emp@x.com','employee')`, [t.id]);
  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase) VALUES ($1,'KI','FY26','kra_open') RETURNING id`,
    [t.id])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  tok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ki-emp@x.com', password: 'pass' }),
  })).json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('EDITING A KRA KEEPS ITS ID', { skip }, async () => {
  // GET first: the sheet row is created on read, and the PUT needs it.
  await req('GET', '/pms/my/kra-sheet');
  const first = await save([
    { title: 'KRA one', weight: 60, measures: 'm1', category: 'Financial' },
    { title: 'KRA two', weight: 40, measures: 'm2', category: 'Customer' },
  ]);
  assert.equal(first.status, 200, `save failed: ${JSON.stringify(first.body)}`);
  const before_ = await sheetKras();
  assert.equal(before_.length, 2);

  // Reword one, leave the other alone — the commonest edit there is.
  await save(before_.map((k, i) => (i === 0 ? { ...k, title: 'KRA one, reworded' } : k)));
  const after_ = await sheetKras();

  assert.deepEqual(after_.map((k) => k.id), before_.map((k) => k.id), 'ids must survive an edit');
  assert.equal(after_[0].title, 'KRA one, reworded');
  assert.equal(after_[1].title, 'KRA two');
});

test('A MID-YEAR RATING SURVIVES AN EDIT TO THE KRA SHEET', { skip }, async () => {
  // The bug in one test: rate both KRAs at mid-year, then edit the sheet.
  const kras = await sheetKras();
  await db.query(
    `INSERT INTO pms.midyear_checkins (tenant_id,cycle_id,employee_id,self_status,self_entries)
     VALUES ($1,$2,$3,'in_progress',$4::jsonb)
     ON CONFLICT (cycle_id,employee_id) DO UPDATE SET self_entries=EXCLUDED.self_entries`,
    [tenantId, cycleId, empId, JSON.stringify({
      [kras[0].id]: { rating: 4, narrative: 'went well' },
      [kras[1].id]: { rating: 3, narrative: 'steady' },
    })]);

  await save(kras.map((k) => ({ ...k, measures: (k.measures || '') + ' (clarified)' })));

  const after_ = await sheetKras();
  const stored = (await db.query(
    `SELECT self_entries FROM pms.midyear_checkins WHERE cycle_id=$1 AND employee_id=$2`,
    [cycleId, empId])).rows[0].self_entries;

  const orphaned = Object.keys(stored).filter((id) => !after_.some((k) => k.id === id));
  assert.equal(orphaned.length, 0, 'no mid-year rating may be orphaned by a sheet edit');
  assert.equal(stored[after_[0].id].rating, 4, 'and the rating is still the one they gave');
  assert.equal(stored[after_[1].id].narrative, 'steady');
});

test('a development goal keeps its link to the KRA it serves', { skip }, async () => {
  const kras = await sheetKras();
  const plan = (await db.query(
    `INSERT INTO pms.development_plans (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'draft')
     ON CONFLICT (cycle_id,employee_id) DO UPDATE SET status='draft' RETURNING id`,
    [tenantId, cycleId, empId])).rows[0];
  await db.query(
    `INSERT INTO pms.development_goals (tenant_id,plan_id,title,kra_id,serves_kra,sort_order)
     VALUES ($1,$2,'Build the capability',$3,$4,10)`,
    [tenantId, plan.id, kras[0].id, kras[0].title]);

  await save(kras.map((k) => ({ ...k, weight: k.id === kras[0].id ? 55 : 45 })));

  const goal = (await db.query(`SELECT kra_id FROM pms.development_goals WHERE plan_id=$1`, [plan.id])).rows[0];
  const after_ = await sheetKras();
  assert.ok(after_.some((k) => k.id === goal.kra_id), 'the goal still points at a KRA that exists');
});

test('a KRA the employee REMOVES is actually deleted', { skip }, async () => {
  const kras = await sheetKras();
  await save([kras[0]]);
  const after_ = await sheetKras();
  assert.equal(after_.length, 1);
  assert.equal(after_[0].id, kras[0].id, 'the survivor kept its id');
  const gone = (await db.query(`SELECT count(*)::int AS n FROM pms.kras WHERE id=$1`, [kras[1].id])).rows[0].n;
  assert.equal(gone, 0, 'the removed one is gone, not merely hidden');
});

test('a genuinely new KRA gets a new id', { skip }, async () => {
  const kras = await sheetKras();
  await save([...kras, { title: 'A brand new KRA', weight: 10, category: 'People' }]);
  const after_ = await sheetKras();
  assert.equal(after_.length, kras.length + 1);
  const fresh = after_.find((k) => k.title === 'A brand new KRA');
  assert.ok(fresh && !kras.some((k) => k.id === fresh.id), 'new row, new id');
});

test("an id from somebody else's sheet is treated as new, not trusted", { skip }, async () => {
  // Otherwise a crafted payload could point a row at another sheet.
  const other = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'KI Other','ki-other@x.com','active') RETURNING id`,
    [tenantId])).rows[0].id;
  const otherSheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'draft') RETURNING id`,
    [tenantId, cycleId, other])).rows[0].id;
  const foreign = (await db.query(
    `INSERT INTO pms.kras (tenant_id,sheet_id,title,weight) VALUES ($1,$2,'Not yours',10) RETURNING id`,
    [tenantId, otherSheet])).rows[0].id;

  await save([{ id: foreign, title: 'Trying to hijack', weight: 100 }]);

  const mine = await sheetKras();
  assert.equal(mine.length, 1);
  assert.notEqual(mine[0].id, foreign, 'the foreign id was not adopted');
  const theirs = (await db.query(`SELECT title, sheet_id FROM pms.kras WHERE id=$1`, [foreign])).rows[0];
  assert.equal(theirs.title, 'Not yours', "the other sheet's KRA is untouched");
  assert.equal(theirs.sheet_id, otherSheet, 'and still on their sheet');
});
