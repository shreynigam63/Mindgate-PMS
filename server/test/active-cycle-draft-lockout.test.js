// node --test — a draft cycle must not become "the" active cycle.
//
// THE BUG. "The active cycle" was, in six places across four modules, the
// most recently CREATED cycle whose phase is not closed or cancelled. A
// cycle starts life in 'draft', and 'draft' is one of the two phases that
// shut KRAs (phase-machine.js, KRA_SHUT). So the day HR created next
// year's cycle, that brand-new draft became the active cycle for the whole
// company: every employee still working in the live cycle was told "KRA
// submission is not open", with no error that explained why, and the only
// way out was deleting the draft HR had just made.
//
// It was not only My KRAs. The same resolver picks the cycle the AI drafts
// scope against, the one Aspiring Career reads its phase from, and the one
// the nightly reminder sweep schedules against.
//
// THE TESTS THAT CARRY THE WEIGHT:
//   - a live cycle wins over a draft created AFTERWARDS. This is the bug.
//   - KRAs stay editable through the whole thing, end to end over HTTP.
//   - a draft is still resolved when it is the ONLY cycle, so a fresh
//     instance does not report "no cycle" instead of showing its first one.
//   - among started cycles the tie-break is unchanged, so nothing about
//     today's behaviour moves until a draft exists beside a live cycle.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, empId, empTok, ac, pm;

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// created_at is what the resolver tie-breaks on, so it is set explicitly
// rather than left to clock resolution — two rows inserted in the same
// millisecond would make the ordering a coin toss and the test flaky.
const mkCycle = async (name, phase, minutesAgo) => (await db.query(
  `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, created_at)
   VALUES ($1,$2,'FY26','annual',$3, now() - ($4 || ' minutes')::interval) RETURNING id`,
  [tenantId, name, phase, String(minutesAgo)])).rows[0].id;
const dropCycles = async () => db.query(`DELETE FROM pms.cycles WHERE tenant_id=$1`, [tenantId]);

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-draftlock';
  process.env.TENANT_SLUG = 'draftlock-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  ac = require('../modules/performance/active-cycle');
  pm = require('../modules/performance/phase-machine');

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation)
     VALUES ($1,'DL Emp','dl-emp@x.com','active','Executive') RETURNING id`, [t.id])).rows[0].id;
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
    [t.id, 'dl-emp@x.com', await bcrypt.hash('pass', 10)]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  empTok = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'dl-emp@x.com', password: 'pass' }),
  })).json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('A DRAFT CYCLE CREATED TODAY DOES NOT STEAL THE LIVE ONE', { skip }, async () => {
  await dropCycles();
  const live = await mkCycle('FY26 live', 'kra_open', 60);
  const draft = await mkCycle('FY27 draft', 'draft', 1);          // created LATER

  const c = await ac.activeCycle(tenantId);
  assert.equal(c.id, live, 'the started cycle wins, though the draft is newer');
  assert.notEqual(c.id, draft);
});

test('…AND THE EMPLOYEE CAN STILL EDIT THEIR KRAs — the whole point', { skip }, async () => {
  // The end-to-end assertion. Everything above is machinery; this is what
  // the employee experienced: "KRA submission is not open" on a cycle that
  // was plainly open.
  await dropCycles();
  await mkCycle('FY26 live', 'kra_open', 60);

  const before = await req('GET', '/pms/my/kra-sheet', empTok);
  assert.equal(before.status, 200);
  assert.equal(before.body.cycle.phase, 'kra_open');

  // HR starts drafting next year.
  await mkCycle('FY27 draft', 'draft', 0);

  const after = await req('GET', '/pms/my/kra-sheet', empTok);
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.cycle.phase, 'kra_open', 'still their live cycle, not the new draft');

  const save = await req('PUT', '/pms/my/kra-sheet/kras', empTok, {
    kras: [{ title: 'Still editable', weight: 100 }],
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  const submit = await req('POST', '/pms/my/kra-sheet/submit', empTok);
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
});

test('a draft IS resolved when it is the only cycle there is', { skip }, async () => {
  // A fresh instance whose first cycle is unstarted must resolve to it,
  // not report "no cycle" — HR has to be able to see the thing they made.
  await dropCycles();
  const only = await mkCycle('First ever', 'draft', 5);
  const c = await ac.activeCycle(tenantId);
  assert.equal(c.id, only);
  // …and KRAs are correctly shut on it, which is the phase machine's job,
  // not the resolver's. The two rules stay separate.
  assert.equal(pm.phaseAllows('draft', 'kra_edit'), false);
});

test('among STARTED cycles the tie-break is unchanged — most recent wins', { skip }, async () => {
  // Proof that this fix does not move today's behaviour except in the
  // broken case. No draft involved, so nothing should differ.
  await dropCycles();
  await mkCycle('older', 'kra_open', 120);
  const newer = await mkCycle('newer', 'manager_eval', 10);
  assert.equal((await ac.activeCycle(tenantId)).id, newer);
});

test('closed and cancelled cycles are still ignored, draft or not', { skip }, async () => {
  await dropCycles();
  await mkCycle('closed one', 'closed', 1);
  await mkCycle('cancelled one', 'cancelled', 2);
  assert.equal(await ac.activeCycle(tenantId), null, 'no live cycle at all');

  const live = await mkCycle('the live one', 'self_appraisal', 90);
  assert.equal((await ac.activeCycle(tenantId)).id, live);
});

test('the cycle_type filter still narrows, and still prefers a started cycle', { skip }, async () => {
  await dropCycles();
  const live = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase,created_at)
     VALUES ($1,'HY live','FY26','half_yearly','kra_open', now() - interval '60 minutes') RETURNING id`,
    [tenantId])).rows[0].id;
  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase,created_at)
     VALUES ($1,'HY draft','FY27','half_yearly','draft', now())`, [tenantId]);
  await mkCycle('annual live', 'kra_open', 30);

  assert.equal((await ac.activeCycle(tenantId, 'half_yearly')).id, live);
  assert.equal((await ac.activeCycle(tenantId, 'annual')).name, 'annual live');
});

test('Mid-Year still prefers a cycle AT or PAST mid-year over a newer one', { skip }, async () => {
  // The pre-existing rule this fix generalises rather than replaces: the
  // newest started cycle can be at kra_open while the one HR actually
  // advanced to mid_year_review is older.
  await dropCycles();
  const mid = await mkCycle('at mid-year', 'mid_year_review', 120);
  await mkCycle('newer, earlier phase', 'kra_open', 10);
  assert.equal((await ac.activeCycleForMidyear(tenantId)).id, mid);
});

test('Mid-Year falls back to the general rule — and that rule skips drafts too', { skip }, async () => {
  await dropCycles();
  const live = await mkCycle('kra_open live', 'kra_open', 60);
  await mkCycle('draft', 'draft', 1);
  // Nothing has reached mid-year, so it falls through to activeCycle() —
  // which must NOT hand back the draft.
  assert.equal((await ac.activeCycleForMidyear(tenantId)).id, live);
});

test('every module reads the SAME resolver, so they cannot drift apart', { skip }, async () => {
  // Six copies of this query existed across four modules, all with the
  // same bug. A future copy is the thing to prevent, so this asserts on
  // identity rather than on behaviour.
  const perf = require('../modules/performance/active-cycle');
  // kra-autoassign re-exports the shared function itself, so identity is
  // assertable. The other modules destructure it at require time and hold
  // it in a closure, which is not reachable from here — so the grep below
  // is what covers them, and it is the assertion that actually matters:
  // it fails the moment anyone writes a seventh copy of the predicate.
  assert.equal(require('../modules/performance/kra-autoassign').activeCycleFor, perf.activeCycle);

  // No module carries its own copy of the predicate any more.
  const { execSync } = require('node:child_process');
  const hits = execSync(
    "grep -rl \"phase NOT IN ('closed','cancelled')\" modules/ --include=*.js || true",
    { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' }).trim();
  assert.equal(hits, 'modules/performance/active-cycle.js',
    `only the shared resolver may hold this predicate; found it in: ${hits || '(none)'}`);
});
