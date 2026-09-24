// node --test — the competency mapping system, end to end.
//
// Asked for on 24 Sep with the client's own workbook attached:
// "Consider 3rd excel sheet for creating employee competency mapping
// system for evaluation self and manager to have complete competency of
// the organization."
//
// Real Postgres, real HTTP, real migrations — the seeded framework, the
// two assessments, the locks, the permissions and the org roll-up.
// Skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, empId, mgrId, icId;
let empTok, mgrTok, adminTok;

const call = async (tok, path, method = 'GET', body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = r.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-comp';
  process.env.TENANT_SLUG = 'comp-test-' + Date.now();
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
  // The framework is seeded per tenant by 049, which ran before this
  // tenant existed — so seed this one the same way 049 would.
  await require('../migrations/049-competency-mapping').up(db);

  const mk = async (name, email, managerId, designation, department) => (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
     VALUES ($1,$2,$3,'active',$4,$5,$6) RETURNING id`,
    [t.id, name, email, designation, department, managerId || null])).rows[0].id;

  const adminId = await mk('CM Admin', 'cm-admin@x.com', null, 'Manager', 'HR');
  mgrId = await mk('CM Manager', 'cm-mgr@x.com', null, 'Lead', 'Development');
  empId = await mk('CM Report', 'cm-emp@x.com', mgrId, 'Software Developer', 'Development');
  // Somebody the manager does NOT manage, for the row-scope test.
  icId = await mk('CM Stranger', 'cm-far@x.com', null, 'Software Developer', 'Cyber Security');

  for (const email of ['cm-admin@x.com', 'cm-mgr@x.com', 'cm-emp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`,
      [t.id, email, await bcrypt.hash('pass', 10)]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'cm-admin@x.com','admin')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'cm-mgr@x.com','manager')`, [t.id]);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,cycle_type,phase)
     VALUES ($1,'CM Cycle','FY26','annual','kra_open') RETURNING id`, [t.id])).rows[0].id;

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }),
  })).json()).token;
  adminTok = await login('cm-admin@x.com');
  mgrTok = await login('cm-mgr@x.com');
  empTok = await login('cm-emp@x.com');
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the client\'s own Competency Master is what gets seeded', { skip }, async () => {
  const r = await call(adminTok, '/pms/competencies/framework');
  assert.equal(r.status, 200);
  const byCat = {};
  for (const c of r.body.competencies) byCat[c.category] = (byCat[c.category] || 0) + 1;
  // The four categories and the counts from the workbook they sent.
  assert.deepEqual(byCat, {
    'FUNCTIONAL / TECHNICAL COMPETENCY': 10,
    'BEHAVIOURAL COMPETENCY': 13,
    'LEADERSHIP COMPETENCY': 10,
    'DIGITAL & FUTURE SKILLS': 7,
  });
  assert.equal(r.body.competencies.length, 40);
  assert.deepEqual(r.body.scale.map((s) => s.label),
    ['Awareness', 'Developing', 'Proficient', 'Advanced', 'Expert']);

  // THE SORT ORDERS MUST NOT OVERLAP BETWEEN CATEGORIES. They did at
  // first — BEHAVIOURAL ran 21..33 straight through LEADERSHIP's 31..40
  // — and the framework page rendered the same heading twice.
  const ranges = new Map();
  for (const c of r.body.competencies) {
    const cur = ranges.get(c.category) || [Infinity, -Infinity];
    ranges.set(c.category, [Math.min(cur[0], c.sort_order), Math.max(cur[1], c.sort_order)]);
  }
  const spans = [...ranges.values()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i][0] > spans[i - 1][1],
      `category sort ranges overlap: ${JSON.stringify(spans)}`);
  }
  // Two names appear in two categories on purpose, so the key is
  // (category, name) and not name.
  const dupes = ['Decision-making', 'Stakeholder management'];
  for (const n of dupes) {
    assert.equal(r.body.competencies.filter((c) => c.name === n).length, 2, `${n} exists twice`);
  }
});

test('an individual contributor is not asked about leadership; a manager is', { skip }, async () => {
  const e = await call(empTok, '/pms/competencies/me');
  assert.equal(e.status, 200);
  assert.equal(e.body.rows.length, 30, '40 less the 10 leadership ones');
  assert.ok(!e.body.rows.some((r) => r.category.startsWith('LEADERSHIP')));

  const m = await call(mgrTok, '/pms/competencies/me');
  assert.equal(m.body.rows.length, 40, 'somebody with reports gets all four categories');
  assert.ok(m.body.rows.some((r) => r.name === 'Delegation'));
});

test('the required level is snapshotted, so re-levelling cannot rewrite a measured gap', { skip }, async () => {
  const before = await call(empTok, '/pms/competencies/me');
  const row = before.body.rows.find((r) => r.name === 'Process knowledge');
  assert.equal(row.required_level, 4, 'the workbook ships every competency at 4');

  // HR levels Software Developer at 2 for that competency, AFTER the
  // assessment was created.
  const set = await call(adminTok, `/pms/competencies/framework/${row.competency_id}/level`, 'POST',
    { designation: 'Software Developer', required_level: 2 });
  assert.equal(set.status, 201, JSON.stringify(set.body));

  const after = await call(empTok, '/pms/competencies/me');
  assert.equal(after.body.rows.find((r) => r.name === 'Process knowledge').required_level, 4,
    'the existing assessment keeps the level it was created under');

  // A NEW assessment picks the new level up. The stranger has the same
  // designation in a different department, and the level was set with
  // no department, so it applies to them.
  const fresh = await call(adminTok, `/pms/competencies/team/${icId}`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.rows.find((r) => r.name === 'Process knowledge').required_level, 2,
    'a new assessment is created at the current level');
});

test('the self form validates, locks on submit, and refuses a part-finished one', { skip }, async () => {
  const me = await call(empTok, '/pms/competencies/me');
  const first = me.body.rows[0].competency_id;

  const bad = await call(empTok, '/pms/competencies/me', 'PUT', { entries: { [first]: { rating: 9 } } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /between 1 and 5/);
  // NOTHING may have been written by a rejected save.
  const afterBad = await call(empTok, '/pms/competencies/me');
  assert.equal(afterBad.body.rows[0].self_rating, null, 'a refused save writes nothing');

  await call(empTok, '/pms/competencies/me', 'PUT',
    { entries: { [first]: { rating: 4, evidence: 'Ran the Q2 migration.' } },
      top_responsibilities: 'Ship the payments integration.' });
  const partial = await call(empTok, '/pms/competencies/me/submit', 'POST');
  assert.equal(partial.status, 422);
  assert.match(partial.body.error, /29 still blank/);
  assert.ok(partial.body.missing.length === 29);

  // Fill everything and submit.
  const entries = {};
  me.body.rows.forEach((r, i) => { entries[r.competency_id] = { rating: (i % 5) + 1 }; });
  assert.equal((await call(empTok, '/pms/competencies/me', 'PUT', { entries })).status, 200);
  assert.equal((await call(empTok, '/pms/competencies/me/submit', 'POST')).status, 200);

  const locked = await call(empTok, '/pms/competencies/me', 'PUT', { entries: { [first]: { rating: 5 } } });
  assert.equal(locked.status, 409, 'a submitted assessment is locked');
  const done = await call(empTok, '/pms/competencies/me');
  assert.equal(done.body.editable, false);
  assert.equal(done.body.assessment.self_status, 'submitted');
  assert.ok(done.body.assessment.top_responsibilities, 'the narrative survived');
});

test('the manager rates independently, sees the gap, and only their own reports', { skip }, async () => {
  const list = await call(mgrTok, '/pms/competencies/team');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.team.map((t) => t.name), ['CM Report'],
    'my reports only — the Manager tab has no whole-company view');

  const d = await call(mgrTok, `/pms/competencies/team/${empId}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.rows.length, 30);
  assert.ok(d.body.rows.every((r) => r.manager_rating === null), 'nothing is prefilled from the self-rating');
  assert.ok(d.body.rows.some((r) => r.self_rating !== null), 'but the self-rating is visible');

  // Rate everything at 2 against a required level of 4 — every row is a gap.
  const entries = {};
  d.body.rows.forEach((r) => { entries[r.competency_id] = { rating: 2, comment: 'Observed.' }; });
  const saved = await call(mgrTok, `/pms/competencies/team/${empId}`, 'PUT',
    { entries, manager_summary: 'Needs depth.' });
  assert.equal(saved.status, 200);
  assert.ok(saved.body.summary.overall.avg_gap < 0);

  const sub = await call(mgrTok, `/pms/competencies/team/${empId}/submit`, 'POST');
  assert.equal(sub.status, 200);
  assert.equal((await call(mgrTok, `/pms/competencies/team/${empId}`, 'PUT', { entries: {} })).status, 409);

  // ROW SCOPE. Somebody who is not their report is refused, whatever
  // the route table says.
  const nope = await call(mgrTok, `/pms/competencies/team/${icId}`);
  assert.equal(nope.status, 403);
  assert.match(nope.body.error, /Not your report/);
});

test('the employee sees their manager\'s view only once it is submitted', { skip }, async () => {
  const me = await call(empTok, '/pms/competencies/me');
  assert.equal(me.body.assessment.manager_status, 'submitted');
  assert.ok(me.body.rows.every((r) => r.manager_rating === 2), 'and then they see it');
});

test('every competency surface is closed to somebody without the permission', { skip }, async () => {
  for (const path of ['/pms/competencies/team', '/pms/competencies/framework',
                      '/pms/competencies/dashboard', '/pms/competencies/dashboard/gaps.xlsx']) {
    const r = await call(empTok, path);
    assert.equal(r.status, 403, `${path} must refuse an employee`);
  }
  // A manager may run their team but not the company framework.
  assert.equal((await call(mgrTok, '/pms/competencies/team')).status, 200);
  assert.equal((await call(mgrTok, '/pms/competencies/framework')).status, 403);
  assert.equal((await call(mgrTok, '/pms/competencies/dashboard')).status, 403);
});

test('the dashboard reports coverage alongside its averages', { skip }, async () => {
  const r = await call(adminTok, '/pms/competencies/dashboard');
  assert.equal(r.status, 200);
  // COVERAGE IS THE POINT. An average over one person out of four is not
  // a company figure, and the payload has to carry the denominator or
  // the page cannot say so.
  assert.equal(r.body.coverage.employees, 4);
  assert.equal(r.body.coverage.self_submitted, 1);
  assert.equal(r.body.coverage.manager_submitted, 1);
  assert.ok(r.body.coverage.started >= 1);

  const f = r.body.categories.find((c) => c.category === 'FUNCTIONAL / TECHNICAL COMPETENCY');
  assert.equal(f.avg_manager, 2, 'the manager rated everything 2');
  assert.equal(f.avg_required, 4);
  assert.equal(f.avg_gap, -2);
  assert.equal(f.priority, 'High');

  // Leadership was never asked of this employee, so it has no data —
  // and must say so rather than reporting zero.
  const l = r.body.categories.find((c) => c.category === 'LEADERSHIP COMPETENCY');
  if (l) { assert.equal(l.avg_manager, null); assert.equal(l.priority, null); }

  assert.ok(r.body.weakest.length, 'the weakest competencies are named');
  assert.ok(r.body.departments.some((d) => d.department === 'Development'));
});

test('the gap export is a real workbook, one row per person per unmet competency', { skip }, async () => {
  const r = await call(adminTok, '/pms/competencies/dashboard/gaps.xlsx');
  assert.equal(r.status, 200);
  assert.equal(r.buf.slice(0, 2).toString(), 'PK', 'a zip, which is what an xlsx is');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.buf);
  const ws = wb.getWorksheet('Competency Gaps');
  assert.ok(ws);
  assert.equal(ws.getRow(1).getCell(1).value, 'Employee');
  // 30 competencies, all rated 2 against 4 — except the one HR
  // re-levelled, which was snapshotted at 4 and so is also a gap.
  assert.equal(ws.rowCount, 31, 'header + one row per unmet competency');
  assert.equal(ws.getRow(2).getCell(1).value, 'CM Report');
});

test('a competency somebody has been rated on is retired, never deleted', { skip }, async () => {
  const fw = await call(adminTok, '/pms/competencies/framework');
  const used = fw.body.competencies.find((c) => c.name === 'Communication');
  const r = await call(adminTok, `/pms/competencies/framework/${used.id}`, 'DELETE');
  assert.equal(r.status, 200);
  assert.equal(r.body.deactivated, true, 'deleting would cascade away ratings a decision was made on');
  assert.ok(r.body.ratings > 0);
  // The rating survives, and the existing assessment still shows it.
  const still = await call(mgrTok, `/pms/competencies/team/${empId}`);
  assert.ok(still.body.rows.some((x) => x.name === 'Communication'));

  // One nobody has been rated on IS deleted.
  const add = await call(adminTok, '/pms/competencies/framework', 'POST',
    { category: 'DIGITAL & FUTURE SKILLS', name: 'Prompt engineering', default_required_level: 3 });
  assert.equal(add.status, 201);
  const gone = await call(adminTok, `/pms/competencies/framework/${add.body.competency.id}`, 'DELETE');
  assert.equal(gone.body.deleted, true);
});

test('reopening is HR-only, audited, and needs a reason', { skip }, async () => {
  assert.equal((await call(mgrTok, `/pms/competencies/reopen/${empId}`, 'POST', { side: 'self', reason: 'x' })).status, 403);
  const noReason = await call(adminTok, `/pms/competencies/reopen/${empId}`, 'POST', { side: 'self' });
  assert.equal(noReason.status, 422);
  assert.match(noReason.body.error, /reason is required/);

  const ok = await call(adminTok, `/pms/competencies/reopen/${empId}`, 'POST',
    { side: 'self', reason: 'Rated against the wrong role.' });
  assert.equal(ok.status, 200);
  assert.equal((await call(empTok, '/pms/competencies/me')).body.editable, true);

  const trail = (await db.query(
    `SELECT action, details FROM pms.audit_log
      WHERE tenant_id=$1 AND action IN ('COMPETENCY_REOPENED','COMPETENCY_MANAGER_SUBMITTED')
      ORDER BY at`, [tenantId])).rows;
  assert.ok(trail.some((a) => a.action === 'COMPETENCY_MANAGER_SUBMITTED'),
    'a rating that feeds development decisions is audited');
  const reopened = trail.find((a) => a.action === 'COMPETENCY_REOPENED');
  assert.ok(reopened, 'and so is undoing one');
  assert.equal(reopened.details.reason, 'Rated against the wrong role.');
});
