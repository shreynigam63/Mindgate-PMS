// The HRBP gateway, against a real database.
//
// This file exists because of a counting problem. There are 104 pms_admin
// guards in the performance module, each over a handler that queries the
// whole company. An HRBP now runs all of them. Testing "does KRA Overview
// scope correctly" one page at a time would be 20 tests that still prove
// nothing about the twenty-first.
//
// So the test that matters is the SWEEP: walk every HR endpoint as an
// HRBP, collect every employee the payload names, and assert the set is a
// subset of the remit. One assertion, every page, and a page added later
// that forgets to scope fails it without anybody remembering to come back
// here.
//
// The rest pin the parts a sweep cannot see: that writes are checked
// before they happen, that tenant-wide writes are refused outright, and
// that an empty remit yields nothing rather than everything.

// Set BEFORE the requires below: core/auth.js reads the secret when it
// loads, so setting it inside before() is too late and every login 500s.
process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hrbp-gateway-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');
const gw = require('../modules/performance/hrbp-gateway');

const SLUG = `hgw-test-${Date.now()}`;
let server; let base; let tenantId;
let hrbpTok; let adminTok;
let inRemit = []; let outsideIds = [];

const api = async (tok, path, opts = {}) => {
  const r = await fetch(`${base}/api/v1/pms${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* html error page */ }
  return { status: r.status, body: j };
};

before(async () => {
  process.env.AUTH_DEV = 'true';
  const t = await db.query(
    `INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [SLUG]);
  tenantId = t.rows[0].id;

  const mk = async (name, email, location) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, location)
     VALUES ($1,$2,$3,'active','Delivery',$4) RETURNING id`,
    [tenantId, name, email, location])).rows[0].id;

  const pune = [await mk('Pune One', 'p1@x.com', 'Pune'), await mk('Pune Two', 'p2@x.com', 'Pune')];
  const mumbai = [await mk('Mumbai One', 'm1@x.com', 'Mumbai'), await mk('Mumbai Two', 'm2@x.com', 'Mumbai')];
  const partner = await mk('The Partner', 'partner@x.com', null);
  const boss = await mk('The Admin', 'boss@x.com', null);
  inRemit = pune; outsideIds = [...mumbai];

  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'partner@x.com','hrbp'),($1,'boss@x.com','admin')`, [tenantId]);
  for (const p of ['pms_hrbp', 'pms_self']) {
    await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'hrbp',$2) ON CONFLICT DO NOTHING`, [tenantId, p]);
  }
  await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'admin','*') ON CONFLICT DO NOTHING`, [tenantId]);
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'partner@x.com','location','Pune','test')`, [tenantId]);

  // The tenant has to be on the request BEFORE dev-login reads it.
  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['partner@x.com', 'boss@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = async (email) => (await (await fetch(`${base}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pw' }),
  })).json()).token;
  hrbpTok = await login('partner@x.com');
  adminTok = await login('boss@x.com');
  assert.ok(hrbpTok && adminTok, 'both test logins have to work');
  void boss; void partner;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    for (const t of ['pms.cycles', 'core.hrbp_scope', 'core.local_credentials', 'core.user_roles',
      'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

// Every uuid the payload uses to say whose record a row is.
function peopleNamed(node, acc = new Set(), depth = 0) {
  if (depth > 9 || !node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const x of node) peopleNamed(x, acc, depth + 1); return acc; }
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'employee_id' || k === 'employeeId') && typeof v === 'string') acc.add(v);
    if (k === 'employee' && v && typeof v === 'object' && v.id) acc.add(v.id);
    if (k === 'id' && typeof v === 'string' && typeof node.email === 'string') acc.add(v);
    if (v && typeof v === 'object') peopleNamed(v, acc, depth + 1);
  }
  return acc;
}

// The HR-facing reads. Kept here rather than derived from the router so
// that deleting a route does not silently shrink the sweep.
const HR_READS = [
  '/approvals', '/kra/org-overview', '/reports/completion', '/nine-box', '/calibration',
  '/calibration/kitty', '/watchlist', '/closure-letters', '/connects', '/pip', '/home',
  '/cycles', '/hr/settings', '/hr/kra-library', '/compensation', '/increment-matrix',
  '/increment-simulations', '/review-parameters', '/meetings',
];

test('NO RECORD OUTSIDE THE REMIT REACHES AN HRBP — every HR read, in one sweep', async () => {
  const allowed = new Set(inRemit);
  const leaks = [];
  for (const path of HR_READS) {
    const r = await api(hrbpTok, path);
    if (r.status >= 500) { leaks.push(`${path} -> ${r.status} ${JSON.stringify(r.body)}`); continue; }
    if (r.status === 403) continue;                       // refused outright is fine
    for (const id of peopleNamed(r.body || {})) {
      if (!allowed.has(id)) leaks.push(`${path} named ${id}`);
    }
  }
  assert.deepEqual(leaks, [], `an HRBP was shown somebody outside their remit:\n${leaks.join('\n')}`);
});

test('and the sweep is not vacuous — the same reads DO carry their own people', async () => {
  // WRITTEN TWICE. The first version of the sweep above passed against a
  // tenant with no data at all, which is the failure mode of every
  // "assert nothing bad appears" test: empty is always clean. This one
  // fails if the scoping has quietly become "return nothing".
  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase,cycle_type)
     VALUES ($1,'T','FY26-27','manager_eval','annual')`, [tenantId]);
  const r = await api(hrbpTok, '/reports/completion');
  assert.equal(r.status, 200);
  const named = peopleNamed(r.body || {});
  assert.ok(named.size > 0, 'the completion report named nobody at all — scoping may be returning nothing');
  for (const id of named) assert.ok(inRemit.includes(id), `${id} is not in the remit`);
});

test('AN HRBP CANNOT WRITE A SETTING THAT APPLIES TO EVERYBODY', async () => {
  const r = await api(hrbpTok, '/hr/settings', { method: 'PUT', body: JSON.stringify({ green_pct: 10 }) });
  assert.equal(r.status, 403, 'a tenant-wide write was allowed');
  assert.match(r.body.error, /whole company/i, 'and the refusal says why, not just "denied"');
  const after = await api(adminTok, '/hr/settings');
  assert.notEqual(after.body && after.body.green_pct, 10, 'the setting changed anyway');
});

test('A WRITE AIMED AT SOMEBODY OUTSIDE THE REMIT IS REFUSED BEFORE IT HAPPENS', async () => {
  const outsider = outsideIds[0];
  const r = await api(hrbpTok, `/hr/development-plan/${outsider}/reopen`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 403, 'an HRBP acted on somebody outside their remit');
  assert.match(r.body.error, /not in your remit/i);
});

test('a write aimed at somebody INSIDE the remit gets past the gateway', async () => {
  // It may still fail on the handler's own rules — there is no plan to
  // reopen — but it must not be refused BY THE GATEWAY, or "can act" is
  // a fiction. The gateway's refusal is the only one that says remit.
  const r = await api(hrbpTok, `/hr/development-plan/${inRemit[0]}/reopen`, { method: 'POST', body: '{}' });
  assert.ok(!(r.status === 403 && /remit/i.test(JSON.stringify(r.body))),
    `the gateway refused a write on their own person: ${r.status} ${JSON.stringify(r.body)}`);
});

test('AN EMPTY REMIT IS NO ACCESS, not the whole company', async () => {
  await db.query(`DELETE FROM core.hrbp_scope WHERE tenant_id=$1 AND email='partner@x.com'`, [tenantId]);
  const r = await api(hrbpTok, '/reports/completion');
  assert.equal(r.status, 200);
  assert.deepEqual([...peopleNamed(r.body || {})], [], 'an unassigned partner saw people');
  const w = await api(hrbpTok, `/hr/development-plan/${inRemit[0]}/reopen`, { method: 'POST', body: '{}' });
  assert.equal(w.status, 403, 'an unassigned partner could still write');
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'partner@x.com','location','Pune','test')`, [tenantId]);
});

test('a real HR admin is untouched by any of this', async () => {
  const r = await api(adminTok, '/reports/completion');
  assert.equal(r.status, 200);
  assert.ok(r.body.scoped_to_remit === undefined, 'the gateway narrowed an admin response');
  const named = peopleNamed(r.body || {});
  assert.ok([...named].some((id) => outsideIds.includes(id)),
    'HR lost sight of people outside one partner\'s remit');
});

// ---- the pure half -------------------------------------------------------

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

test('narrow() recomputes a total and keeps the org-wide one beside it', () => {
  const ids = new Set([U1]);
  const body = { items: [{ employee_id: U1 }, { employee_id: U2 }], total: 2 };
  gw.narrow(body, ids);
  assert.deepEqual(body.items, [{ employee_id: U1 }]);
  assert.equal(body.total, 1);
  assert.equal(body.org_total, 2, 'without this the page cannot say "1 of 2"');
  assert.equal(body.scoped_to_remit, true);
});

test('narrow() reaches people nested inside another object', () => {
  const ids = new Set([U1]);
  const body = { report: { team: [{ employee: { id: U1 } }, { employee: { id: U2 } }] } };
  gw.narrow(body, ids);
  assert.equal(body.report.team.length, 1, 'a nested list was left unfiltered');
});

test('narrow() leaves rows that name nobody alone', () => {
  // A cycle, a grade band, a KRA library entry: not a person's record, and
  // dropping them would empty pages that have nothing to do with scoping.
  const ids = new Set([U1]);
  const body = { cycles: [{ id: U2, name: 'FY26' }, { id: U1, name: 'FY27' }] };
  gw.narrow(body, ids);
  assert.equal(body.cycles.length, 2);
});
