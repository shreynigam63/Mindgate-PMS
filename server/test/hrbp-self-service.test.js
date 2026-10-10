// An HRBP's OWN appraisal, against a real database (10 Oct).
//
// The gateway used to treat an HRBP's Self pages like HR's: a save that
// named nobody was refused ("HR can do it"), and their own sheet was
// narrowed away whenever they sat outside their own remit. So an HRBP
// could not save their own KRAs. Worse, one INSIDE their own remit was
// lent HR's powers over their own record.
//
// Three partners pin the three shapes: outside their own remit, inside
// it, and with no remit at all.

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hrbp-self-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { runMigrations } = require('../core/migrate');
const { devLogin } = require('../core/auth');
const gw = require('../modules/performance/hrbp-gateway');

const SLUG = `hself-test-${Date.now()}`;
let server; let base; let tenantId;
const tok = {};
const id = {};

const call = async (who, path, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};
const put = (who, path, body) => call(who, path, { method: 'PUT', body: JSON.stringify(body) });
const post = (who, path, body) => call(who, path, { method: 'POST', body: JSON.stringify(body || {}) });

// The gateway's own refusals, and only those. A handler's 400 or 404 means
// the gateway stepped aside, which is what these tests are about.
const GATEWAY = /remit|HR can do it|whole company|your own record|decided by the manager/i;
const refusedByGateway = (r) => r.status === 403 && GATEWAY.test(String(r.body && r.body.error));

before(async () => {
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  const mk = async (key, email, location) => {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, location)
       VALUES ($1,$2,$3,'active','Delivery',$4) RETURNING id`, [tenantId, key, email, location])).rows[0].id;
  };
  await mk('boss', 'boss@x.com', 'Mumbai');
  await mk('outside', 'outside@x.com', 'Mumbai');   // an HRBP for Pune who works in Mumbai
  await mk('inside', 'inside@x.com', 'Pune');       // an HRBP for Pune who works in Pune
  await mk('unset', 'unset@x.com', 'Pune');         // an HRBP with no remit yet
  await mk('pune1', 'p1@x.com', 'Pune');
  await mk('pune2', 'p2@x.com', 'Pune');
  await mk('mumbai1', 'm1@x.com', 'Mumbai');
  // Everyone reports to the boss, so a self-logged connect has a default.
  await db.query(`UPDATE core.employees SET manager_id=$2 WHERE tenant_id=$1 AND id<>$2`, [tenantId, id.boss]);

  await db.query(
    `INSERT INTO core.user_roles (tenant_id,email,role) VALUES
       ($1,'outside@x.com','hrbp'),($1,'inside@x.com','hrbp'),($1,'unset@x.com','hrbp'),($1,'boss@x.com','admin')`,
    [tenantId]);
  // What the role really holds: pms_compensation is re-granted at every
  // start-up, which is what made an HRBP's own increment reachable.
  for (const p of ['pms_hrbp', 'pms_self', 'pms_compensation', 'engagement_take', 'people_view']) {
    await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'hrbp',$2) ON CONFLICT DO NOTHING`, [tenantId, p]);
  }
  await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'admin','*') ON CONFLICT DO NOTHING`, [tenantId]);
  for (const e of ['outside@x.com', 'inside@x.com']) {
    await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,$2,'location','Pune','test')`, [tenantId, e]);
  }
  await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase,cycle_type) VALUES ($1,'T','FY26-27','kra_open','annual')`, [tenantId]);

  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['outside@x.com', 'inside@x.com', 'unset@x.com', 'boss@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/people', require('../modules/people').router);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  app.use('/api/v1/engagement', require('../modules/engagement').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['outside', 'inside', 'unset', 'boss']) {
    tok[who] = (await (await fetch(`${base}/api/v1/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${who}@x.com`, password: 'pw' }),
    })).json()).token;
    assert.ok(tok[who], `${who} could not sign in`);
  }
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    for (const t of ['people.appraisal_query_messages', 'people.appraisal_queries', 'pms.pip_records', 'pms.kras',
      'pms.kra_sheets', 'pms.development_plans', 'pms.rating_adjustments', 'pms.cycles', 'core.audit_log',
      'core.hrbp_scope', 'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('AN HRBP OUTSIDE THEIR OWN REMIT SAVES THEIR OWN KRAs — the reported bug', async () => {
  const g = await call('outside', '/pms/my/kra-sheet');
  assert.equal(g.status, 200);
  assert.ok(g.body.sheet, 'their own sheet was narrowed away');
  assert.equal(g.body.sheet.employee_id, id.outside);
  assert.equal(g.body.scoped_to_remit, undefined, 'a Self page was treated as an HR page');

  const s = await put('outside', '/pms/my/kra-sheet/kras', { kras: [{ title: 'Own KRA', kpi: 'k', weight: 100 }] });
  assert.equal(s.status, 200, `own save refused: ${JSON.stringify(s.body)}`);
  const again = await call('outside', '/pms/my/kra-sheet');
  assert.deepEqual(again.body.kras.map((k) => k.title), ['Own KRA']);
});

test('an HRBP with no remit at all still has their own pages', async () => {
  const g = await call('unset', '/pms/my/kra-sheet');
  assert.equal(g.status, 200);
  assert.ok(g.body.sheet, 'an empty remit hid their own sheet');
  const s = await put('unset', '/pms/my/kra-sheet/kras', { kras: [{ title: 'Mine', kpi: 'k', weight: 100 }] });
  assert.equal(s.status, 200, `an empty remit blocked their own save: ${JSON.stringify(s.body)}`);
});

test('own saves on every router get past the gateway', async () => {
  const tries = [
    ['timesheet upload', () => post('outside', '/pms/timesheet/upload')],
    ['connect', () => post('outside', '/pms/connects', { employee_id: id.outside, held_at: '2026-10-01', topic: 'mine' })],
    ['appraisal query', () => post('outside', '/people/queries', { subject: 'My rating', body: 'A question' })],
    ['career path', () => put('outside', '/people/career/my-path', { horizon: 'short' })],
    ['AI review assist', () => post('outside', '/agentic/review-assist', { stage: 'midyear' })],
    ['survey answer', () => post('outside', `/engagement/surveys/${id.boss}/respond`, { answers: [] })],
  ];
  for (const [what, go] of tries) {
    const r = await go();
    assert.ok(!refusedByGateway(r), `${what} was refused by the gateway: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const q = await call('outside', '/people/queries');
  assert.equal(q.status, 200);
  assert.equal(q.body.admin, false, 'People Hub treated the HRBP as HR');
  assert.ok(q.body.queries.some((x) => x.employee_id === id.outside), 'their own query is not listed');
});

test('nothing is lent on a Self page: the Dashboard is an employee\'s', async () => {
  const r = await call('outside', '/pms/home');
  assert.equal(r.status, 200);
  assert.equal(r.body.admin, undefined, 'the HRBP Dashboard carried company-wide HR counts');
  assert.equal(r.body.scoped_to_remit, undefined);
});

test('HR\'S POWERS OVER THEIR OWN RECORD ARE REFUSED, even inside their own remit', async () => {
  const tries = [
    ['calibration rating', () => post('inside', '/pms/calibration/adjust', { employee_id: id.inside, to_rating: 5, reason: 'x' })],
    ['KRA sheet reopen', () => post('inside', `/pms/hr/kra-sheet/${id.inside}/reopen`, { reason: 'x' })],
    ['own increment', () => put('inside', `/pms/calibration/allocation/${id.inside}`, { standard_pct: 50 })],
  ];
  for (const [what, go] of tries) {
    const r = await go();
    assert.equal(r.status, 403, `${what} on their own record was allowed: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Only HR and Super Admin/);
  }
  const adj = await db.query(`SELECT 1 FROM pms.rating_adjustments WHERE tenant_id=$1`, [tenantId]).catch(() => ({ rows: [] }));
  assert.equal(adj.rows.length, 0, 'a rating adjustment was written anyway');
});

test('and the same HRBP still acts on the rest of their remit', async () => {
  const r = await post('inside', `/pms/hr/development-plan/${id.pune1}/reopen`, {});
  assert.ok(!refusedByGateway(r), `the gateway refused an in-remit write: ${r.status} ${JSON.stringify(r.body)}`);
});

test('HR\'s pages do not show an HRBP their own record', async () => {
  const r = await call('inside', '/pms/reports/completion');
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.ok(text.includes(id.pune1), 'the report lost the remit');
  assert.ok(!text.includes(id.inside), 'the HRBP saw their own row on an HR page');
  const hr = await call('boss', '/pms/reports/completion');
  assert.ok(JSON.stringify(hr.body).includes(id.inside), 'HR lost sight of the HRBP');
});

test('ALL APPROVALS STAYS READ-ONLY — an in-remit decoy no longer carries the items through', async () => {
  const sheet = (await db.query(
    `SELECT s.id FROM pms.kra_sheets s WHERE s.tenant_id=$1 AND s.employee_id=$2`, [tenantId, id.outside])).rows[0];
  const r = await post('inside', '/pms/approvals/bulk',
    { employee_id: id.pune1, items: [{ kind: 'kra_sheet', id: sheet ? sheet.id : id.mumbai1 }] });
  assert.equal(r.status, 403, `bulk approvals went through: ${JSON.stringify(r.body)}`);
  assert.match(r.body.error, /decided by the manager or by HR/);
});

test('the Improvement Plan page still shows an HRBP their own plan', async () => {
  const p = (await db.query(
    `INSERT INTO pms.pip_records (tenant_id, employee_id, status) VALUES ($1,$2,'open') RETURNING id`,
    [tenantId, id.outside])).rows[0];
  await db.query(`INSERT INTO pms.pip_records (tenant_id, employee_id, status) VALUES ($1,$2,'open')`, [tenantId, id.mumbai1]);
  const list = await call('outside', '/pms/pip');
  assert.equal(list.status, 200);
  const text = JSON.stringify(list.body);
  assert.ok(text.includes(p.id), 'their own plan was narrowed out of the list');
  assert.ok(!text.includes(id.mumbai1), 'a plan outside the remit reached the HRBP');
  const one = await call('outside', `/pms/pip/${p.id}`);
  assert.equal(one.status, 200);
  assert.ok(one.body.pip, 'their own plan was narrowed away');
});

// ---- the pure half -------------------------------------------------------

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const req = (method, baseUrl) => ({ method, baseUrl, user: { id: ME } });

test('matchesRoute: exact templates, keyed on the router, and :me is only me', () => {
  const m = (method, baseUrl, path) => gw.matchesRoute(gw.SELF_SERVICE, req(method, baseUrl), path);
  assert.ok(m('PUT', '/api/v1/pms', '/my/kra-sheet/kras'));
  assert.ok(m('GET', '/api/v1/pms', '/my/kra-sheet/'), 'a trailing slash reaches the same route');
  assert.ok(m('HEAD', '/api/v1/pms', '/my/kra-sheet'), 'HEAD is answered by the GET route');
  assert.ok(!m('POST', '/api/v1/pms', '/my/kra-sheet/kras'), 'the method matters');
  assert.ok(!m('PUT', '/api/v1/pms', '/my/kra-sheet/kras/extra'), 'a template is not a prefix');
  assert.ok(!m('GET', '/api/v1/engagement', '/my/kra-sheet'), 'the router matters');
  assert.ok(m('GET', '/api/v1/pms', `/review/kras/${ME}`));
  assert.ok(!m('GET', '/api/v1/pms', `/review/kras/${OTHER}`), 'somebody else\'s KRAs stay behind the gateway');
  assert.ok(!m('POST', '/api/v1/pms', '/approvals/bulk'));
  assert.ok(!m('GET', '/api/v1/pms', '/reports/completion'), 'HR pages are not self-service');
});

test('no self-service route sits under a tenant-wide or HR-only prefix', () => {
  for (const [, rows] of Object.entries(gw.SELF_SERVICE)) {
    for (const [, template] of rows) {
      for (const p of [...gw.HR_ONLY, ...gw.TENANT_WIDE, ...gw.HR_DECIDES]) {
        assert.ok(!template.startsWith(p), `${template} sits under ${p}`);
      }
    }
  }
});
