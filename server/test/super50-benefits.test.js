// node --test — Super 50 benefits (15 Oct): tiers by consecutive years,
// the one budget, claims decided by HR alone, the lapse, the exports and
// the certificate. The pure rules run without a database; the rest runs
// against real Postgres and skips cleanly without DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const {
  basisYearOf, streakAt, tierFor, validatePolicy, claimProblem, DEFAULT_POLICY,
} = require('../modules/performance/super50-benefits');
const { DEFAULT_SCALE, DEFAULT_RULE } = require('../modules/performance/rating-rules');

const years = (o) => Object.entries(o).map(([y, r]) => ({ sort_year: Number(y), rating: r, fiscal_year: `FY${y}` }))
  .sort((a, b) => b.sort_year - a.sort_year);

test('the appraisal year is read the way the history reads it', () => {
  assert.equal(basisYearOf('FY25-26'), 2025);
  assert.equal(basisYearOf('2025-26'), 2025);
  assert.equal(basisYearOf('FY2025'), 2025);
  assert.equal(basisYearOf('no year'), null);
});

test('consecutive Super 50 years, each judged on the ratings up to it', () => {
  const s = (o) => streakAt(years(o), DEFAULT_SCALE, DEFAULT_RULE, 2025);
  assert.equal(s({ 2025: 5, 2024: 5, 2023: 5, 2022: 4, 2021: 4 }), 3, 'three A+ years over A years: Elite');
  assert.equal(s({ 2025: 5, 2024: 5, 2023: 4, 2022: 4 }), 2, 'last year qualified too: Twice');
  assert.equal(s({ 2025: 5, 2024: 4, 2023: 5, 2022: 4 }), 1, 'last year was not A+: the run is one');
  assert.equal(s({ 2025: 5, 2023: 5, 2022: 5, 2021: 5 }), 1, 'a year with no rating ends the run');
  assert.equal(s({ 2024: 5, 2023: 5, 2022: 5 }), 0, 'no rating for the appraisal year: no tier');
  assert.equal(s({ 2025: 4, 2024: 5, 2023: 5 }), 0, 'this year is not A+');
});

test('the higher tier replaces the lower one', () => {
  const t = DEFAULT_POLICY.tiers;
  assert.equal(tierFor(t, 0), null);
  assert.equal(tierFor(t, 1).key, 'super50');
  assert.equal(tierFor(t, 2).key, 'twice');
  assert.equal(tierFor(t, 3).key, 'elite');
  assert.equal(tierFor(t, 7).key, 'elite');
  assert.deepEqual(t.map((x) => x.amount), [30000, 30000, 50000]);
});

test('a policy is checked whole', () => {
  const ok = validatePolicy(DEFAULT_POLICY);
  assert.ok(ok.policy, ok.error);
  assert.equal(ok.policy.basis_year, 2025);
  assert.equal(ok.policy.hubs.length, 4);
  const swap = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  swap.tiers[1].min_streak = 1;
  assert.match(validatePolicy(swap).error, /more consecutive years/);
  assert.match(validatePolicy({ ...DEFAULT_POLICY, hubs: [] }).error, /hub/);
  assert.match(validatePolicy({ ...DEFAULT_POLICY, ends_on: '2026-01-01' }).error, /ends before/);
  assert.match(validatePolicy({ ...DEFAULT_POLICY, basis_fiscal_year: 'next' }).error, /year/);
});

test('what a claim may be', () => {
  const policy = { status: 'active', starts_on: '2026-07-01', ends_on: '2027-06-30', hubs: DEFAULT_POLICY.hubs };
  const award = { status: 'active' };
  const bill = { mimetype: 'application/pdf', size: 1000 };
  const base = { policy, award, today: '2026-10-15', hub: 'tech', amount: 1000, remaining: 30000, bill };
  assert.equal(claimProblem(base), null);
  assert.match(claimProblem({ ...base, amount: 30001 }), /remaining balance/);
  assert.match(claimProblem({ ...base, today: '2027-07-01' }), /lapsed/);
  assert.match(claimProblem({ ...base, today: '2026-06-30' }), /open on/);
  assert.match(claimProblem({ ...base, hub: 'travel' }), /hub/);
  assert.match(claimProblem({ ...base, bill: null }), /bill/);
  assert.match(claimProblem({ ...base, bill: { mimetype: 'text/plain', size: 1 } }), /PDF/);
  assert.match(claimProblem({ ...base, amount: 10.123 }), /paise/);
  assert.match(claimProblem({ ...base, award: { status: 'withdrawn' } }), /tier/);
});

// ------------------------------------------------------------ end to end

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db, server, base, tenantId;
const ids = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-s50b';
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  const slug = `s50b-${Date.now()}`;
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('S50 Benefits Co',$1) RETURNING id`, [slug])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  await require('../migrations/095-super50-benefits').ensureSuper50Pages(db, tenantId);
  const hash = await bcrypt.hash('pass', 4);
  const people = {
    hr: { role: 'hr', r: { 2025: 5, 2024: 4, 2023: 5 } },        // Super 50 herself
    hr2: { role: 'employee', r: {} },                              // pms_admin, no pay
    elite: { role: 'employee', r: { 2025: 5, 2024: 5, 2023: 5, 2022: 4, 2021: 4 } },
    twice: { role: 'employee', r: { 2025: 5, 2024: 5, 2023: 4, 2022: 4 } },
    one: { role: 'employee', r: { 2025: 5, 2024: 4, 2023: 4 } },
    none: { role: 'employee', r: { 2025: 4, 2024: 4, 2023: 4 } },
  };
  for (const [k, p] of Object.entries(people)) {
    const email = `${k}@s50b.test`;
    ids[k] = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, emp_code) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
      [tenantId, `S50 ${k}`, email, `E-${k}`])).rows[0].id;
    await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, email, p.role]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [tenantId, email, hash]);
    for (const [y, r] of Object.entries(p.r)) {
      await db.query(`INSERT INTO pms.prior_ratings (tenant_id, employee_id, fiscal_year, rating, sort_year) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, ids[k], `FY${String(y).slice(2)}-${String(Number(y) + 1).slice(2)}`, r, Number(y)]);
    }
  }
  await db.query(`INSERT INTO core.user_permissions (tenant_id, email, permission) VALUES ($1,'hr2@s50b.test','pms_admin')`, [tenantId]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1/pms/super50`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const tokens = {};
async function tok(who) {
  if (!tokens[who]) {
    const r = await fetch(`${base.replace('/pms/super50', '')}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${who}@s50b.test`, password: 'pass' }) });
    tokens[who] = (await r.json()).token;
  }
  return tokens[who];
}
async function call(who, path, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts,
    headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${await tok(who)}` } });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, type, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const json = (b) => ({ method: 'POST', body: JSON.stringify(b) });
function claimForm({ hub = 'tech', amount, bill = true, type = 'application/pdf' }) {
  const fd = new FormData();
  fd.append('hub', hub);
  fd.append('amount', String(amount));
  fd.append('item', 'Claude certification');
  if (bill) fd.append('bill', new Blob(['%PDF-1.4 bill'], { type }), 'bill.pdf');
  return { method: 'POST', body: fd };
}
const dayFrom = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let policyId;

test('HR creates the benefits year from the sheet and sets the tiers', { skip }, async () => {
  const c = await call('hr', '/policies', json({ from_default: true }));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  policyId = c.body.policy.id;
  assert.equal(c.body.policy.basis_year, 2025);
  assert.equal((await call('hr', '/policies', json({ from_default: true }))).status, 409, 'one benefits year per appraisal');
  // Dated around today, so the claims below are inside the year whenever this runs.
  const put = await call('hr', `/policies/${policyId}`, { method: 'PUT', body: JSON.stringify({ starts_on: dayFrom(-30), ends_on: dayFrom(200) }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const a = await call('hr', `/policies/${policyId}/assign`, { method: 'POST' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual(a.body.by_tier, { super50: 2, twice: 1, elite: 1 });
  assert.equal(a.body.problem, null);
  assert.equal(a.body.rated_for_year, 5);
  assert.equal(a.body.awarded, 4);
  assert.equal(a.body.notified, 4);
  const n = (await db.query(`SELECT title FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind='super50_tier'`, [tenantId, ids.elite])).rows;
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Super 50 Elite/);

  const again = await call('hr', `/policies/${policyId}/assign`, { method: 'POST' });
  assert.equal(again.body.unchanged, 4, 'setting the tiers twice changes nothing and tells nobody again');
  assert.equal(again.body.notified, 0);

  const list = await call('hr', `/policies/${policyId}/awards`);
  const elite = list.body.awards.find((x) => x.employee_id === ids.elite);
  assert.equal(elite.tier, 'elite');
  assert.equal(elite.amount, 50000);
  assert.equal(elite.streak, 3);
});

test('My Super 50: tier, benefits and balance; nothing for someone without a tier', { skip }, async () => {
  const me = await call('elite', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.award.label, 'Super 50 Elite');
  assert.equal(me.body.award.remaining, 50000);
  assert.ok(me.body.award.benefits.some((b) => /125%/.test(b)));
  assert.equal(me.body.claims_open, true);
  assert.equal((await call('none', '/me')).body.award, null);
  assert.equal((await call('none', '/policies')).status, 403, 'the HR side is HR only');
});

test('claims: within the balance, with a bill, decided by HR alone', { skip }, async () => {
  assert.equal((await call('twice', '/me/claims', claimForm({ amount: 30001 }))).status, 422, 'more than the balance');
  assert.match((await call('twice', '/me/claims', claimForm({ amount: 100, bill: false }))).body.error, /bill/);
  assert.match((await call('twice', '/me/claims', claimForm({ amount: 100, type: 'text/plain' }))).body.error, /PDF/);
  assert.match((await call('twice', '/me/claims', claimForm({ amount: 100, hub: 'travel' }))).body.error, /hub/);
  assert.equal((await call('none', '/me/claims', claimForm({ amount: 100 }))).status, 403);

  const c1 = await call('twice', '/me/claims', claimForm({ amount: 20000 }));
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  let me = await call('twice', '/me');
  assert.equal(me.body.award.pending, 20000);
  assert.equal(me.body.award.remaining, 10000);
  assert.equal((await call('twice', '/me/claims', claimForm({ amount: 10001 }))).status, 422, 'a claim waiting on HR holds its amount');

  assert.equal((await call('twice', `/claims/${c1.body.id}/decide`, json({ decision: 'approve' }))).status, 403, 'not the employee');
  assert.equal((await call('hr', `/claims/${c1.body.id}/decide`, json({ decision: 'return' }))).status, 422, 'a return says why');
  const ret = await call('hr', `/claims/${c1.body.id}/decide`, json({ decision: 'return', note: 'The bill is not in your name.' }));
  assert.equal(ret.status, 200);
  const told = (await db.query(`SELECT body FROM core.notifications WHERE employee_id=$1 AND kind='super50_claim_returned'`, [ids.twice])).rows[0];
  assert.match(told.body, /not in your name/);
  me = await call('twice', '/me');
  assert.equal(me.body.award.remaining, 30000, 'a returned claim gives its amount back');

  const c2 = await call('twice', '/me/claims', claimForm({ amount: 25000 }));
  const ok = await call('hr', `/claims/${c2.body.id}/decide`, json({ decision: 'approve' }));
  assert.equal(ok.status, 200);
  assert.equal((await call('hr', `/claims/${c2.body.id}/decide`, json({ decision: 'approve' }))).status, 409, 'decided once');
  me = await call('twice', '/me');
  assert.equal(me.body.award.used, 25000);
  assert.equal(me.body.award.remaining, 5000);

  // The bill: the owner and HR open it, nobody else.
  const own = await call('twice', `/me/claims/${c2.body.id}/bill`);
  assert.equal(own.status, 200);
  assert.equal(own.type, 'application/pdf');
  assert.equal((await call('hr', `/claims/${c2.body.id}/bill`)).status, 200);
  assert.equal((await call('elite', `/me/claims/${c2.body.id}/bill`)).status, 404);
  assert.equal((await call('elite', `/claims/${c2.body.id}/bill`)).status, 403);

  // Withdrawn while waiting, and only then.
  const c3 = await call('twice', '/me/claims', claimForm({ amount: 1000 }));
  assert.equal((await call('twice', `/me/claims/${c3.body.id}/withdraw`, { method: 'POST' })).status, 200);
  assert.equal((await call('twice', `/me/claims/${c3.body.id}/withdraw`, { method: 'POST' })).status, 409);

  // HR's own claim goes to another HR.
  const mine = await call('hr', '/me/claims', claimForm({ amount: 500 }));
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal((await call('hr', `/claims/${mine.body.id}/decide`, json({ decision: 'approve' }))).status, 403);
  assert.equal((await call('hr2', `/claims/${mine.body.id}/decide`, json({ decision: 'approve' }))).status, 200);
});

test('the IIT/IIM programme: Twice picks a course, Elite a refresher; HR marks it done', { skip }, async () => {
  const course = await call('hr', `/policies/${policyId}/programmes`, json({ name: 'IIM Leadership Programme', provider: 'IIM', kind: 'course' }));
  const refresher = await call('hr', `/policies/${policyId}/programmes`, json({ name: 'IIT 2-day refresher', provider: 'IIT', kind: 'refresher' }));
  assert.equal(course.status, 200);
  const twice = await call('twice', '/me');
  assert.deepEqual(twice.body.programmes.map((p) => p.id), [course.body.programme.id]);
  assert.equal((await call('twice', '/me/programme', json({ programme_id: refresher.body.programme.id }))).status, 422);
  assert.equal((await call('twice', '/me/programme', json({ programme_id: course.body.programme.id }))).status, 200);
  assert.equal((await call('one', '/me/programme', json({ programme_id: course.body.programme.id }))).status, 409, 'Super 50 has no programme');
  const award = (await call('twice', '/me')).body.award;
  assert.equal(award.programme_status, 'chosen');
  assert.equal((await call('hr', `/awards/${award.id}/programme`, { method: 'PUT', body: JSON.stringify({ status: 'completed' }) })).status, 200);
  assert.equal((await call('twice', '/me')).body.award.programme_status, 'completed');
});

test('exports: entitlements (variable only with pay permission) and approved claims', { skip }, async () => {
  const ExcelJS = require('exceljs');
  const read = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb.worksheets[0]; };
  const ent = await read((await call('hr', `/policies/${policyId}/export.xlsx?kind=entitlements`)).body);
  const head = ent.getRow(1).values.filter(Boolean);
  assert.ok(head.includes('Single punch') && head.includes('Mandatory EL days') && head.includes('Variable (% of last year)'));
  assert.equal(ent.rowCount, 5, 'header + four awardees');
  const noPay = await read((await call('hr2', `/policies/${policyId}/export.xlsx?kind=entitlements`)).body);
  assert.ok(!noPay.getRow(1).values.includes('Variable (% of last year)'), 'no pay permission, no variable column');
  const cl = await read((await call('hr', `/policies/${policyId}/export.xlsx?kind=claims`)).body);
  assert.equal(cl.getRow(2).getCell(8).value, 500);
  assert.equal(cl.rowCount, 4, 'header, two approved claims, total');
});

test('the certificate, for the person and for HR', { skip }, async () => {
  const mine = await call('elite', '/me/certificate.pdf');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.slice(0, 4).toString(), '%PDF');
  assert.equal((await call('none', '/me/certificate.pdf')).status, 404);
  const award = (await call('elite', '/me')).body.award;
  assert.equal((await call('hr', `/awards/${award.id}/certificate.pdf`)).status, 200);
  assert.equal((await call('elite', `/awards/${award.id}/certificate.pdf`)).status, 403);
});

test('tiers follow the ratings: an upgrade is told, a lost tier withdrawn; Calibration sees the tier', { skip }, async () => {
  // Twice → Elite: 2023 becomes an A+ year with two A years under it.
  await db.query(`UPDATE pms.prior_ratings SET rating=5 WHERE employee_id=$1 AND sort_year=2023`, [ids.twice]);
  await db.query(`INSERT INTO pms.prior_ratings (tenant_id, employee_id, fiscal_year, rating, sort_year) VALUES ($1,$2,'FY21-22',4,2021)`, [tenantId, ids.twice]);
  await db.query(`DELETE FROM pms.prior_ratings WHERE employee_id=$1`, [ids.one]);
  const r = await call('hr', `/policies/${policyId}/assign`, { method: 'POST' });
  assert.equal(r.body.upgraded, 1);
  assert.equal(r.body.withdrawn, 1);
  const n = (await db.query(`SELECT title FROM core.notifications WHERE employee_id=$1 AND kind='super50_tier' ORDER BY created_at DESC LIMIT 1`, [ids.twice])).rows[0];
  assert.match(n.title, /now Super 50 Elite/);
  assert.equal((await call('one', '/me')).body.award, null);
  const tiers = await require('../modules/performance/super50-benefits').tiersNow(tenantId);
  assert.equal(tiers.get(ids.elite).tier, 'elite');
  assert.equal(tiers.get(ids.elite).fast_track, true);
  assert.equal(tiers.has(ids.none), false);
});

test('publishing the annual cycle the policy is based on sets the tiers', { skip }, async () => {
  const { afterAnnualPublish } = require('../modules/performance/super50-benefits');
  const req = { user: { tenant_id: tenantId, email: 'hr@s50b.test' } };
  const done = await afterAnnualPublish(req, { id: null, fiscal_year: '2025-26' });
  assert.equal(done.length, 1);
  assert.equal(done[0].policy_id, policyId);
  assert.deepEqual(await afterAnnualPublish(req, { id: null, fiscal_year: 'FY24-25' }), [], 'another year has no benefits year');
});

test('a run that can award nobody says why', { skip }, async () => {
  await db.query(`INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'super50_min_grade','"Exceeds"')`, [tenantId]);
  const r = await call('hr', `/policies/${policyId}/assign`, { method: 'POST' });
  assert.match(r.body.problem, /not grades on this cycle's rating scale.*Settings/);
  assert.equal(r.body.kept_with_claims, 2, 'paid awards are kept; HR decides a reversal');
  await db.query(`DELETE FROM core.admin_settings WHERE tenant_id=$1 AND key='super50_min_grade'`, [tenantId]);
  assert.equal((await call('hr', `/policies/${policyId}/assign`, { method: 'POST' })).body.problem, null);
});

test('the lapse: a reminder once before, no claims after, and the year closes', { skip }, async () => {
  const { tick } = require('../modules/performance/super50-benefits');
  await call('hr', `/policies/${policyId}`, { method: 'PUT', body: JSON.stringify({ ends_on: dayFrom(10), lapse_reminder_days: 30 }) });
  const t1 = await tick(tenantId);
  assert.equal(t1.reminded, 3, 'everyone with money left: elite, twice (upgraded) and HR');
  assert.equal((await tick(tenantId)).reminded, 0, 'once');
  await call('hr', `/policies/${policyId}`, { method: 'PUT', body: JSON.stringify({ starts_on: dayFrom(-60), ends_on: dayFrom(-1) }) });
  const late = await call('elite', '/me/claims', claimForm({ amount: 100 }));
  assert.equal(late.status, 422);
  assert.match(late.body.error, /lapsed/);
  assert.equal((await tick(tenantId)).closed, 1);
  const me = await call('elite', '/me');
  assert.equal(me.body.claims_open, false);
  assert.match(me.body.claims_note, /closed/);
});
