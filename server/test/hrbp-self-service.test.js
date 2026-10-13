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
const GATEWAY = /remit|HR can do it|whole company|your own record|decided by the manager|not one of the changes an HRBP makes|address is not valid/i;
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
  app.use('/api/v1/employees', require('../core/employees').router);
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
    for (const t of ['people.onboarding_tasks', 'people.onboarding_joiners', 'people.appraisal_query_messages', 'people.appraisal_queries', 'pms.review_meetings',
      'pms.connects', 'pms.top_talent', 'core.notifications', 'pms.audit_log', 'pms.pip_records', 'pms.kras',
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

test('meetings: the HRBP\'s own are self-service; a remit employee\'s keep the lent path', async () => {
  // Their own review meeting, outside their own remit: an employee's request.
  const own = await post('outside', '/pms/meetings', { context: 'midyear', meeting_url: 'https://meet.example/own' });
  assert.equal(own.status, 201, `own meeting refused: ${JSON.stringify(own.body)}`);
  const mine = await call('outside', '/pms/meetings?context=midyear');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.meetings.length, 1, 'their own meeting is not listed');

  // A connect that asked HR to join lists its meetings for the HRBP named
  // on it, under the EMPLOYEE's id. Found by review on 10 Oct: making all
  // of /meetings self-service turned every such row into "Not your meeting".
  const list = await call('inside', `/pms/meetings?context=connect&employee_id=${id.pune1}`);
  assert.equal(list.status, 200, `an included HRBP lost a remit employee's meetings: ${JSON.stringify(list.body)}`);
  const add = await post('inside', '/pms/meetings',
    { employee_id: id.pune1, context: 'connect', meeting_url: 'https://meet.example/p1' });
  assert.equal(add.status, 201, `an included HRBP could not add the link: ${JSON.stringify(add.body)}`);
  const away = await post('inside', '/pms/meetings',
    { employee_id: id.mumbai1, context: 'connect', meeting_url: 'https://meet.example/m1' });
  assert.ok(refusedByGateway(away), 'a meeting outside the remit got past the gateway');
});

// ---- the two older gaps, closed on 13 Oct ---------------------------------

test('A DECOY NO LONGER CARRIES A COMPANY-WIDE ACTION: publish and month overrides are refused', async () => {
  await db.query(`UPDATE pms.cycles SET phase='publish' WHERE tenant_id=$1`, [tenantId]);
  const pub = await post('inside', '/pms/publish', { employee_id: id.pune1 });
  assert.equal(pub.status, 403, `an HRBP published with a decoy: ${JSON.stringify(pub.body)}`);
  assert.match(pub.body.error, /not one of the changes an HRBP makes/);
  const hist = await db.query(`SELECT 1 FROM pms.employee_performance_history WHERE tenant_id=$1`, [tenantId]);
  assert.equal(hist.rows.length, 0, 'ratings were published anyway');
  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE tenant_id=$1`, [tenantId]);

  const ov = await put('inside', `/pms/timesheet/kra/month/${id.boss}/override`,
    { employee_id: id.pune1, score: 100, grade: 'Green', reason: 'x' });
  assert.equal(ov.status, 403);
  assert.match(ov.body.error, /not one of the changes an HRBP makes/);
});

test('an HRBP change that names a record nobody owns is refused, decoy or not', async () => {
  const r = await put('inside', '/pms/pip/33333333-3333-4333-8333-333333333333', { employee_id: id.pune1, plan: 'x' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /cannot be checked against your remit/);
});

test('READS BY ID ARE CHECKED: nobody else\'s summary, and not their own, from HR\'s pages', async () => {
  const away = await call('inside', `/pms/team/annual-review/${id.mumbai1}`);
  assert.equal(away.status, 403, `read an outsider's review: ${JSON.stringify(away.body).slice(0, 200)}`);
  assert.match(away.body.error, /not in your remit/);

  const self = await call('inside', `/pms/team/annual-review/${id.inside}`);
  assert.equal(self.status, 403, 'read their own manager rating before publish');
  assert.match(self.body.error, /Self pages/);

  const ai = await call('inside', `/agentic/parameter-analysis?employee_id=${id.mumbai1}`);
  assert.equal(ai.status, 403, 'read an outsider\'s AI reading');

  const m = (await db.query(
    `INSERT INTO pms.review_meetings (tenant_id, employee_id, context, provider, meeting_url, created_by)
     VALUES ($1,$2,'connect','manual','https://meet.example/m',$2) RETURNING id`, [tenantId, id.mumbai1])).rows[0];
  const tr = await call('inside', `/pms/meetings/${m.id}/transcript`);
  assert.equal(tr.status, 403, 'opened an outsider\'s meeting transcript by id');

  const inRemit = await call('inside', `/pms/team/annual-review/${id.pune1}`);
  assert.ok(!refusedByGateway(inRemit), `an in-remit read was refused: ${inRemit.status} ${JSON.stringify(inRemit.body)}`);
});

// ---- ids read the way the database reads them (13 Oct) -------------------
//
// Found by review: the gateway knew only the canonical spelling of an id,
// and read the path still percent-encoded. Express hands a route its params
// decoded, and Postgres reads '{<id>}', upper case and the id without its
// hyphens as the same row. So an id the gateway could not see went through
// unchecked, carried past the remit check by an in-remit decoy where one
// was needed, and needing none on a read.

const spell = (u) => ({
  'percent-encoded': `%${u.charCodeAt(0).toString(16)}${u.slice(1)}`,
  'without hyphens': u.replace(/-/g, ''),
  'in braces': `{${u}}`,
  'upper case': u.toUpperCase(),
});
const inBody = (u) => { const s = spell(u); delete s['percent-encoded']; return s; };

test('A PATH ID IN ANY SPELLING IS CHECKED — an outsider\'s review and their own', async () => {
  for (const [who, why] of [['mumbai1', /not in your remit/], ['inside', /Self pages/]]) {
    for (const [how, v] of Object.entries(spell(id[who]))) {
      const r = await call('inside', `/pms/team/annual-review/${encodeURI(v).replace(/%25/g, '%')}`);
      assert.ok(refusedByGateway(r), `${who}'s review, id ${how}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.match(r.body.error, why, `${who}, ${how}`);
    }
  }
});

test('a query id in any spelling is checked, and so is a list of them', async () => {
  for (const [how, v] of Object.entries(inBody(id.mumbai1))) {
    const r = await call('inside', `/agentic/parameter-analysis?employee_id=${encodeURIComponent(v)}`);
    assert.ok(refusedByGateway(r), `an outsider's AI reading, id ${how}: ${r.status}`);
  }
  const two = await call('inside', `/agentic/parameter-analysis?employee_id=${id.pune1}&employee_id=${id.mumbai1}`);
  assert.ok(refusedByGateway(two), `an outsider beside an in-remit id: ${two.status}`);
});

test('A WRITE NAMING SOMEBODY IN ANOTHER SPELLING IS CHECKED, decoy or not', async () => {
  for (const [how, v] of Object.entries(inBody(id.inside))) {
    const own = await post('inside', '/pms/calibration/adjust', { employee_id: v, employeeId: id.pune1, to_rating: 5, reason: 'x' });
    assert.equal(own.status, 403, `own rating, id ${how}: ${JSON.stringify(own.body)}`);
    assert.match(own.body.error, /Only HR and Super Admin can change your own record/);
  }
  for (const [how, v] of Object.entries(inBody(id.mumbai1))) {
    const away = await post('inside', '/pms/calibration/top-talent', { employee_id: v, email: 'p1@x.com', potential_rating: 3 });
    assert.ok(refusedByGateway(away), `an outsider's potential, id ${how}: ${away.status} ${JSON.stringify(away.body)}`);
  }
  for (const [how, v] of Object.entries(spell(id.mumbai1))) {
    const path = encodeURI(v).replace(/%25/g, '%');
    const kras = await put('inside', `/pms/hr/kra-sheet/${path}/kras`, { employee_id: id.pune1, kras: [] });
    assert.ok(refusedByGateway(kras), `KRAs onto an outsider's sheet, id ${how}: ${kras.status} ${JSON.stringify(kras.body)}`);
    const map = await post('inside', `/pms/timesheet/kra/employee/${path}/map/bulk`, { employee_id: id.pune1, mappings: [] });
    assert.ok(refusedByGateway(map), `an outsider's timesheet mapping, id ${how}: ${map.status} ${JSON.stringify(map.body)}`);
  }
  const adj = await db.query(`SELECT 1 FROM pms.rating_adjustments WHERE tenant_id=$1`, [tenantId]).catch(() => ({ rows: [] }));
  assert.equal(adj.rows.length, 0, 'a rating adjustment was written anyway');
  const top = await db.query(`SELECT 1 FROM pms.top_talent WHERE tenant_id=$1`, [tenantId]).catch(() => ({ rows: [] }));
  assert.equal(top.rows.length, 0, 'a potential rating was written anyway');
});

test('a path the gateway cannot decode is refused, not waved through', async () => {
  const r = await call('inside', `/pms/team/annual-review/%FF${id.mumbai1}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /address is not valid/);
});

test('MEETINGS: an included HRBP takes down their own link and adds its transcript; not an outsider\'s', async () => {
  const add = await post('inside', '/pms/meetings',
    { employee_id: id.pune1, context: 'connect', meeting_url: 'https://meet.example/p1-again' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const mid = add.body.meeting ? add.body.meeting.id : add.body.id;
  assert.ok(mid, `no meeting id in ${JSON.stringify(add.body)}`);
  const tr = await put('inside', `/pms/meetings/${mid}/transcript`, { content: 'Notes.' });
  assert.ok(!refusedByGateway(tr) && tr.body.error !== 'Not your meeting',
    `transcript on a remit employee's meeting: ${tr.status} ${JSON.stringify(tr.body)}`);
  const del = await call('inside', `/pms/meetings/${mid}`, { method: 'DELETE' });
  assert.equal(del.status, 200, `could not take the link down: ${JSON.stringify(del.body)}`);

  const m = (await db.query(
    `INSERT INTO pms.review_meetings (tenant_id, employee_id, context, provider, meeting_url, created_by)
     VALUES ($1,$2,'connect','manual','https://meet.example/m2',$2) RETURNING id`, [tenantId, id.mumbai1])).rows[0];
  const away = await call('inside', `/pms/meetings/${m.id}`, { method: 'DELETE' });
  assert.ok(refusedByGateway(away), `deleted an outsider's meeting: ${away.status} ${JSON.stringify(away.body)}`);
  const awayTr = await put('inside', `/pms/meetings/${m.id}/transcript`, { content: 'x' });
  assert.ok(refusedByGateway(awayTr), `wrote an outsider's transcript: ${awayTr.status}`);
  assert.equal((await db.query(`SELECT 1 FROM pms.review_meetings WHERE id=$1`, [m.id])).rows.length, 1);
});

test('meetings an HRBP is a party to without HR\'s powers stay theirs: their own, and their own report\'s', async () => {
  const own = (await db.query(
    `SELECT id FROM pms.review_meetings WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id.outside])).rows[0];
  assert.ok(own, 'the earlier test left no own meeting');
  const del = await call('outside', `/pms/meetings/${own.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, `could not delete their own meeting: ${JSON.stringify(del.body)}`);

  // An HRBP for Pune who manages somebody in Mumbai, outside the remit.
  id.mrep = (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, location, manager_id)
     VALUES ($1,'mrep','mrep@x.com','active','Delivery','Mumbai',$2) RETURNING id`, [tenantId, id.outside])).rows[0].id;
  const add = await post('outside', '/pms/meetings',
    { employee_id: id.mrep, context: 'connect', meeting_url: 'https://meet.example/rep' });
  assert.equal(add.status, 201, `a manager could not add a link for their own report: ${JSON.stringify(add.body)}`);
  const list = await call('outside', `/pms/meetings?context=connect&employee_id=${id.mrep}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.meetings.length, 1, 'their report\'s meeting is not listed');
  const gone = await call('outside', `/pms/meetings/${list.body.meetings[0].id}`, { method: 'DELETE' });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
});

test('the First-Week Journey: an HRBP edits a joiner in their remit, not one outside it', async () => {
  const mk = async (who) => (await db.query(
    `INSERT INTO people.onboarding_joiners (tenant_id, employee_id, doj, started_by)
     VALUES ($1,$2,'2026-10-01','test') RETURNING id`, [tenantId, id[who]])).rows[0].id;
  const pj = await mk('pune2');
  const mj = await mk('mumbai1');
  const ok = await call('inside', `/people/onboarding/joiners/${pj}`, { method: 'PATCH', body: JSON.stringify({ personal_email: 'j@home.com' }) });
  assert.ok(!refusedByGateway(ok), `an in-remit joiner edit was refused: ${ok.status} ${JSON.stringify(ok.body)}`);
  const no = await call('inside', `/people/onboarding/joiners/${mj}`, { method: 'PATCH', body: JSON.stringify({ personal_email: 'j@home.com' }) });
  assert.ok(refusedByGateway(no), `an outsider joiner edit got past the gateway: ${no.status}`);
});

// ---- downloads cut to the remit (13 Oct) ----------------------------------
//
// A JSON page is narrowed after the handler builds it; a spreadsheet is
// bytes by then, so until 13 Oct an HRBP's Employees, Completion Report
// and Calibration downloads covered the whole company — salaries included.

const download = async (who, path) => {
  const r = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${tok[who]}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!/spreadsheetml/.test(r.headers.get('content-type') || '')) return { status: r.status, text: buf.toString('utf8') };
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const cells = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value)))));
  return { status: r.status, text: cells.join('\n') };
};

test('AN HRBP\'S DOWNLOADS HOLD THEIR REMIT ONLY — not the company, not themselves; HR\'s hold everyone', async () => {
  await db.query(`UPDATE core.employees SET designation='Engineer' WHERE tenant_id=$1`, [tenantId]);
  for (const path of ['/employees/export.csv', '/employees/export.xlsx', '/pms/reports/completion/export.csv',
    '/pms/reports/completion/export.xlsx', '/pms/calibration/export']) {
    const r = await download('inside', path);
    assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /\bpune1\b/, `${path} lost the remit`);
    // 'boss' stays: everyone's manager, named in the Manager column.
    for (const who of ['mumbai1', 'm1@x.com', 'inside']) {
      assert.ok(!new RegExp(`\\b${who}\\b`).test(r.text), `${path} carries ${who}`);
    }
    const hr = await download('boss', path);
    assert.equal(hr.status, 200);
    for (const who of ['pune1', 'mumbai1', 'inside']) assert.match(hr.text, new RegExp(`\\b${who}\\b`), `HR's ${path} lost ${who}`);
  }
});

test('THE 9-BOX HOLDS THE REMIT ONLY, and counts it — a cell names its people by id alone', async () => {
  const c = (await db.query(`SELECT id FROM pms.cycles WHERE tenant_id=$1`, [tenantId])).rows[0].id;
  for (const who of ['pune1', 'mumbai1']) {
    await db.query(`INSERT INTO pms.top_talent (tenant_id, cycle_id, employee_id, potential_rating, nine_box_cell, noted_by)
      VALUES ($1,$2,$3,5,'high-high','boss@x.com')`, [tenantId, c, id[who]]);
  }
  const placed = (r) => r.body.groups.flatMap((g) => Object.values(g.cells).flat()).map((p) => p.id).sort();
  const hrbp = await call('inside', '/pms/nine-box');
  assert.equal(hrbp.status, 200, JSON.stringify(hrbp.body));
  assert.deepEqual(placed(hrbp), [id.pune1], 'the HRBP\'s 9-box is not their remit');
  assert.equal(hrbp.body.groups[0].total, 1, 'the group count still counts the company');
  const hr = await call('boss', '/pms/nine-box');
  assert.deepEqual(placed(hr), [id.pune1, id.mumbai1].sort(), 'HR lost somebody');
});

test('THE CYCLE ACTIVITY FEED HOLDS THE REMIT: not an outsider\'s rating reason, not their own', async () => {
  const c = (await db.query(`SELECT id FROM pms.cycles WHERE tenant_id=$1`, [tenantId])).rows[0].id;
  for (const who of ['pune1', 'mumbai1', 'inside']) {
    await db.query(`INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details)
      VALUES ($1,'boss@x.com','RATING_ADJUSTED',$2,$3,$4)`, [tenantId, c, id[who], JSON.stringify({ reason: `why-${who}` })]);
  }
  await db.query(`INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, details)
    VALUES ($1,'boss@x.com','PHASE_CHANGED',$2,'{}')`, [tenantId, c]);
  const hrbp = await call('inside', `/pms/cycles/${c}/activity`);
  assert.equal(hrbp.status, 200, JSON.stringify(hrbp.body));
  const text = JSON.stringify(hrbp.body.events);
  assert.match(text, /why-pune1/, 'the remit\'s events went missing');
  assert.match(text, /PHASE_CHANGED/, 'an event about the cycle went missing');
  assert.ok(!/why-mumbai1|why-inside/.test(text), `an outsider's or their own event reached the HRBP: ${text}`);
  const hr = JSON.stringify((await call('boss', `/pms/cycles/${c}/activity`)).body.events);
  for (const who of ['pune1', 'mumbai1', 'inside']) assert.match(hr, new RegExp(`why-${who}`), `HR lost ${who}`);
});

test('narrowing drops a list row that names an outsider by id alone, and leaves rows that are not people', () => {
  const body = { cells: [{ id: ME, name: 'in' }, { id: OTHER, name: 'out' }, { id: 'c0ffee00-0000-4000-8000-000000000000', name: 'a cycle' }] };
  gw.narrow(body, new Set([ME]), 0, new Set([ME, OTHER]));
  assert.deepEqual(body.cells.map((r) => r.name), ['in', 'a cycle']);
  const legacy = { cells: [{ id: OTHER, name: 'out' }] };
  gw.narrow(legacy, new Set([ME]));
  assert.equal(legacy.cells.length, 1, 'without the employee list nothing is guessed');
});

test('A SURVEY\'S RESULTS DOWNLOAD HOLDS THE REMIT: no named answer from outside it', async () => {
  const sid = (await db.query(
    `INSERT INTO engagement.surveys (tenant_id,title,survey_type,status,anonymity_default,allow_attribution_optin)
     VALUES ($1,'Stay Interview','pulse','closed',true,true) RETURNING id`, [tenantId])).rows[0].id;
  const qid = (await db.query(
    `INSERT INTO engagement.questions (tenant_id,survey_id,qtype,prompt,sort_order)
     VALUES ($1,$2,'text','What would make you leave?',20) RETURNING id`, [tenantId, sid])).rows[0].id;
  const rids = [];
  for (const who of ['pune1', 'pune2', 'mumbai1']) {
    const r = (await db.query(`INSERT INTO engagement.responses (tenant_id,survey_id,employee_id,submitted_at)
      VALUES ($1,$2,$3,now()) RETURNING id`, [tenantId, sid, id[who]])).rows[0].id;
    rids.push(r);
    await db.query(`INSERT INTO engagement.answers (response_id,question_id,value_text) VALUES ($1,$2,$3)`, [r, qid, `answer-of-${who}`]);
  }
  try {
    const hrbp = await download('inside', `/engagement/surveys/${sid}/results.xlsx`);
    assert.equal(hrbp.status, 200, hrbp.text.slice(0, 200));
    assert.match(hrbp.text, /Your remit only/, 'the file does not say it is cut to the remit');
    assert.match(hrbp.text, /answer-of-pune1/);
    assert.ok(!/answer-of-mumbai1/.test(hrbp.text), 'a named answer from outside the remit reached the HRBP');
    const hr = await download('boss', `/engagement/surveys/${sid}/results.xlsx`);
    assert.match(hr.text, /answer-of-mumbai1/, 'HR lost an answer');
  } finally {
    await db.query(`DELETE FROM engagement.answers WHERE response_id = ANY($1::uuid[])`, [rids]);
    await db.query(`DELETE FROM engagement.responses WHERE survey_id=$1`, [sid]);
    await db.query(`DELETE FROM engagement.questions WHERE survey_id=$1`, [sid]);
    await db.query(`DELETE FROM engagement.surveys WHERE id=$1`, [sid]);
  }
});

test('the scope helper keeps every row when no hook narrowed the request, and none that name nobody when one did', () => {
  const { visibleRows } = require('../core/scope-hooks');
  const rows = [{ employee_id: ME }, { employee_id: OTHER }, { name: 'a total' }];
  assert.deepEqual(visibleRows({}, rows), rows);
  assert.deepEqual(visibleRows({ remitVisible: new Set([OTHER]) }, rows), [{ employee_id: OTHER }]);
  assert.deepEqual(visibleRows({ remitVisible: new Set([ME]) }, rows, 'id'), []);
});

// ---- the pure half -------------------------------------------------------

test('uuidOf reads every spelling Postgres reads, and nothing else', () => {
  const U = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  for (const v of [U, U.toUpperCase(), U.replace(/-/g, ''), `{${U}}`, 'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11']) {
    assert.equal(gw.uuidOf(v), U, v);
  }
  for (const v of ['', 'x', U.slice(1), `${U}0`, null, 42, [U], { id: U }]) assert.equal(gw.uuidOf(v), null, String(v));
});

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
  // Whether a meeting is the caller's is settled in the database first.
  const meetings = (party) => gw.matchesRoute(gw.SELF_SERVICE,
    { ...req('GET', '/api/v1/pms'), _hrbpMeetingParty: party }, '/meetings');
  assert.ok(meetings(true), 'a meeting the caller is a party to');
  assert.ok(!meetings(false), 'somebody else\'s meetings stay behind the gateway');
  assert.ok(!meetings(undefined), 'never self-service before the gateway has looked');
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
