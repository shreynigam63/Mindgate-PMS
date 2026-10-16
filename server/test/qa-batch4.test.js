// node --test — the client's QA list, last part (16 Oct): RnR stages
// belong to the nominee's own HOD, nominations close on their date, a
// send-back reason reaches the nominator; a closed PIP is a record; the
// Manager Dashboard puts the manager's own work first and the Dashboard
// names the phase; work a manager submitted stays theirs after the
// reporting line changes; weight edits recompute the overall; a query
// raised to nobody reaches HR; HR reopens a competency assessment from a
// list. Real Postgres, skips cleanly without DATABASE_URL.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-qab4';
process.env.AUTH_DEV = 'true';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db, server, base, tenantId, cycleId;
const id = {}; const kra = {}; const rnr = {};

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('QAB4',$1) RETURNING id`, [`qab4-${Date.now()}`])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  const hash = await bcrypt.hash('pass', 4);
  const add = async (k, role, dept, managerKey) => {
    id[k] = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status, department, manager_id) VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`,
      [tenantId, `QAB4 ${k}`, `${k}@qab4.test`, dept, managerKey ? id[managerKey] : null])).rows[0].id;
    if (role !== 'employee') await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)`, [tenantId, `${k}@qab4.test`, role]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [tenantId, `${k}@qab4.test`, hash]);
  };
  await add('hr', 'hr', 'People');
  await add('hod', 'hod', 'Delivery');
  await add('hod2', 'hod', 'Sales');
  await add('mgr', 'manager', 'Delivery');
  await add('mgr2', 'manager', 'Delivery');
  await add('emp', 'employee', 'Delivery', 'mgr');
  await add('emp2', 'employee', 'Delivery', 'mgr');
  await add('stranger', 'employee', 'Sales');
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Delivery',$2),($1,'Sales',$3)`, [tenantId, id.hod, id.hod2]);
  const scale = JSON.stringify([{ value: 5, label: 'A+' }, { value: 4, label: 'A' }, { value: 3, label: 'B+' }, { value: 2, label: 'B' }, { value: 1, label: 'C' }]);
  cycleId = (await db.query(`INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, rating_scale) VALUES ($1,'QAB4','FYQ4','annual','self_appraisal',$2) RETURNING id`,
    [tenantId, scale])).rows[0].id;
  for (const who of ['emp', 'emp2', 'mgr']) {
    const sheet = (await db.query(`INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, cycleId, id[who], who === 'mgr' ? null : id.mgr, who === 'mgr' ? 'returned' : 'approved'])).rows[0].id;
    kra[who] = [];
    for (const [title, w] of [['Ship', 50], ['Support', 50]]) {
      kra[who].push((await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,$3,$4,1) RETURNING id`, [tenantId, sheet, title, w])).rows[0].id);
    }
  }
  // RnR: one open cycle, one closed by date, one award, a nomination each
  // for a Delivery employee and a Sales employee, both at the HOD stage.
  rnr.award = (await db.query(`INSERT INTO rnr.awards (tenant_id,key,name,level,frequency) VALUES ($1,'star','Star Award','all','annual') RETURNING id`, [tenantId])).rows[0].id;
  rnr.open = (await db.query(`INSERT INTO rnr.cycles (tenant_id,name,kind,nominations_open,nominations_close,status)
    VALUES ($1,'Open cycle','annual',CURRENT_DATE - 5,CURRENT_DATE + 30,'open') RETURNING id`, [tenantId])).rows[0].id;
  rnr.late = (await db.query(`INSERT INTO rnr.cycles (tenant_id,name,kind,nominations_open,nominations_close,status)
    VALUES ($1,'Late cycle','annual',CURRENT_DATE - 30,CURRENT_DATE - 2,'open') RETURNING id`, [tenantId])).rows[0].id;
  const nom = async (employeeId) => (await db.query(
    `INSERT INTO rnr.nominations (tenant_id,cycle_id,award_id,employee_id,nominated_by,status,justification)
     VALUES ($1,$2,$3,$4,$5,'pending_delivery_head','Did great work') RETURNING id`, [tenantId, rnr.open, rnr.award, employeeId, id.mgr])).rows[0].id;
  rnr.delivery = await nom(id.emp);
  rnr.sales = await nom(id.stranger);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/people', require('../modules/people').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const tok = {};
async function call(who, method, path, body) {
  if (!tok[who]) {
    tok[who] = (await (await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${who}@qab4.test`, password: 'pass' }) })).json()).token;
  }
  const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const notices = async (who, kind) => (await db.query(
  `SELECT title, body, link FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind=$3`, [tenantId, id[who], kind])).rows;

test('RnR: the HOD stage is the nominee\'s own HOD; another department\'s HOD cannot list, open or decide it', { skip }, async () => {
  const mine = await call('hod', 'GET', '/people/rnr/nominations?status=pending_delivery_head');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.nominations.map((n) => n.id), [rnr.delivery]);
  const theirs = await call('hod2', 'GET', '/people/rnr/nominations?status=pending_delivery_head');
  assert.deepEqual(theirs.body.nominations.map((n) => n.id), [rnr.sales]);
  assert.equal((await call('hod2', 'GET', `/people/rnr/nominations/${rnr.delivery}`)).status, 403);
  const decide = await call('hod2', 'POST', `/people/rnr/nominations/${rnr.delivery}/decide`, { action: 'approve' });
  assert.equal(decide.status, 403);
  assert.match(decide.body.error, /another department/);
  assert.equal((await call('hr', 'GET', '/people/rnr/nominations?status=pending_delivery_head')).body.nominations.length, 2, 'HR is not limited');
});

test('RnR: a send-back reason shows in the nominator\'s own list; the next stage is told when it arrives', { skip }, async () => {
  const back = await call('hod', 'POST', `/people/rnr/nominations/${rnr.delivery}/decide`, { action: 'send_back', reason: 'Add the client numbers' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const list = await call('mgr', 'GET', '/people/rnr/nominations?mine=true');
  assert.equal(list.body.nominations.find((n) => n.id === rnr.delivery).last_reason, 'Add the client numbers');
  // A nomination approved at the HRBP stage reaches HR, and HR is told.
  const fresh = (await db.query(
    `INSERT INTO rnr.nominations (tenant_id,cycle_id,award_id,employee_id,nominated_by,status) VALUES ($1,$2,$3,$4,$5,'pending_hrbp') RETURNING id`,
    [tenantId, rnr.open, rnr.award, id.stranger, id.mgr])).rows[0].id;
  const r = await call('hr', 'POST', `/people/rnr/nominations/${fresh}/decide`, { action: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending_hr');
  const hr = await notices('hr', 'rnr');
  assert.ok(hr.some((n) => /pending final HR approval/.test(n.body) && n.link === '/rnr/approvals/hr'), JSON.stringify(hr));
});

test('RnR: nominations close on their date; the page is told', { skip }, async () => {
  const r = await call('mgr', 'POST', '/people/rnr/nominations', { cycle_id: rnr.late, award_id: rnr.award, employee_id: id.emp, justification: 'x' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed on/);
  const o = await call('mgr', 'GET', `/people/rnr/nominate/options?cycle_id=${rnr.late}`);
  assert.match(o.body.window.shut, /closed on/);
  assert.equal((await call('mgr', 'GET', `/people/rnr/nominate/options?cycle_id=${rnr.open}`)).body.window.shut, null);
});

test('PIP: a closed plan cannot be changed; nobody writes notes on their own; no second plan without a cycle', { skip }, async () => {
  const plan = {
    employee_id: id.emp2, performance_description: 'Missed commitments.',
    target_areas: [{ area: 'Delivery', expected: '90%' }],
    gates: [{ title: '30-day', due_date: '2026-11-10', success_measure: '80%' }],
    start_date: '2026-10-10', end_date: '2026-12-31',
  };
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  try {
    const first = await call('mgr', 'POST', '/pms/pip', plan);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const again = await call('mgr', 'POST', '/pms/pip', plan);
    assert.equal(again.status, 409, 'one running plan, even with no cycle');
    assert.equal((await call('emp2', 'POST', `/pms/pip/${first.body.id}/entries`, { week_ending: '2026-10-17', notes: 'mine' })).status, 403);
    assert.equal((await call('mgr', 'PUT', `/pms/pip/${first.body.id}`, { status: 'closed_successful', closed_reason: 'Improved' })).status, 200);
    const late = await call('mgr', 'PUT', `/pms/pip/${first.body.id}`, { status: 'open' });
    assert.equal(late.status, 409, 'a closed plan is a record');
    assert.equal((await call('mgr', 'PUT', `/pms/pip/${first.body.id}`, { closed_reason: 'Rewritten' })).status, 409);
  } finally {
    await db.query(`UPDATE pms.cycles SET phase='self_appraisal' WHERE id=$1`, [cycleId]);
  }
});

test('Dashboards: the manager\'s own returned KRA sheet comes first; the employee Dashboard names the phase', { skip }, async () => {
  const team = await call('mgr', 'GET', '/pms/team/home');
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.equal(team.body.action.kind, 'kra_returned');
  assert.equal(team.body.action.own, true);
  const home = await call('emp', 'GET', '/pms/home');
  assert.equal(home.body.action.phase, 'self_appraisal');
  assert.match(home.body.action.phase_note, /Annual Review/);
});

test('A weight-only edit in review works the self-rating out again', { skip }, async () => {
  await db.query(`INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status, entries, overall_self_rating) VALUES ($1,$2,$3,'in_progress',$4,3.5)`,
    [tenantId, cycleId, id.emp, JSON.stringify({ [kra.emp[0]]: { self_rating: 5 }, [kra.emp[1]]: { self_rating: 2 } })]);
  const kras = [{ id: kra.emp[0], title: 'Ship', weight: 80 }, { id: kra.emp[1], title: 'Support', weight: 20 }];
  const r = await call('emp', 'PUT', `/pms/review/kras/${id.emp}`, { kras });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.recomputed.self, { from: 3.5, to: 4.4 });
  const row = (await db.query(`SELECT overall_self_rating FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, id.emp])).rows[0];
  assert.equal(Number(row.overall_self_rating), 4.4);
  const a = (await db.query(`SELECT 1 FROM pms.audit_log WHERE tenant_id=$1 AND action='SELF_RATING_RECOMPUTED' AND employee_id=$2`, [tenantId, id.emp])).rows;
  assert.equal(a.length, 1, 'audited');
});

test('Reporting line change: a submitted evaluation stays with the manager who submitted it; evidence is listed for them', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='manager_eval' WHERE id=$1`, [cycleId]);
  const sa = (await db.query(`SELECT id FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, id.emp])).rows[0].id;
  await db.query(`INSERT INTO pms.evidence (tenant_id, appraisal_id, kra_id, filename, storage_key, file_data, content_type, file_size) VALUES ($1,$2,$3,'proof.pdf','k',$4,'application/pdf',4)`,
    [tenantId, sa, kra.emp[0], Buffer.from('%PDF')]);
  assert.equal((await call('mgr', 'PUT', `/pms/team/evaluations/${id.emp}`, { entries: { [kra.emp[0]]: { rating: 4 }, [kra.emp[1]]: { rating: 4 } } })).status, 200);
  assert.equal((await call('mgr', 'POST', `/pms/team/evaluations/${id.emp}/submit`)).status, 200);
  let ev = await call('mgr', 'GET', `/pms/team/evaluations/${id.emp}/evidence`);
  assert.deepEqual(ev.body.evidence.map((x) => [x.filename, x.kra_title]), [['proof.pdf', 'Ship']]);
  assert.equal((await call('stranger', 'GET', `/pms/team/evaluations/${id.emp}/evidence`)).status, 403);

  await db.query(`UPDATE core.employees SET manager_id=$2 WHERE id=$1`, [id.emp, id.mgr2]);
  const old = await call('mgr', 'GET', '/pms/team/evaluations');
  const row = old.body.team.find((t) => t.employee_id === id.emp);
  assert.ok(row, 'still on the old manager\'s list');
  assert.equal(row.former_report, true);
  assert.equal(row.eval_status, 'submitted');
  assert.equal((await call('mgr', 'GET', `/pms/team/evaluations/${id.emp}/kras`)).status, 200, 'and readable');
  assert.equal((await call('mgr', 'PUT', `/pms/team/evaluations/${id.emp}`, { strengths: 'x' })).status, 403, 'not editable by them');
  ev = await call('mgr', 'GET', `/pms/team/evaluations/${id.emp}/evidence`);
  assert.equal(ev.status, 200);
  // emp2 had nothing submitted: it follows the new manager.
  await db.query(`UPDATE core.employees SET manager_id=$2 WHERE id=$1`, [id.emp2, id.mgr2]);
  const after2 = await call('mgr', 'GET', '/pms/team/evaluations');
  assert.ok(!after2.body.team.some((t) => t.employee_id === id.emp2), 'unsubmitted work moves');
  const now = await call('mgr2', 'GET', '/pms/team/evaluations');
  assert.ok(now.body.team.some((t) => t.employee_id === id.emp2 && !t.former_report));
});

test('A query raised to nobody is announced to HR', { skip }, async () => {
  const r = await call('emp', 'POST', '/people/queries', { title: 'Payslip', description: 'My bonus is missing.' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const hr = await notices('hr', 'query_raised');
  assert.equal(hr.length, 1);
  assert.match(hr[0].title, /Payslip/);
});

test('Competencies: HR lists submitted assessments and reopens one with a reason the person is sent', { skip }, async () => {
  await db.query(`INSERT INTO pms.competency_assessments (tenant_id, cycle_id, employee_id, manager_id, self_status, manager_status) VALUES ($1,$2,$3,$4,'submitted','not_started')`,
    [tenantId, cycleId, id.emp, id.mgr2]);
  const list = await call('hr', 'GET', '/pms/competencies/submitted');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.rows.map((x) => x.employee_id), [id.emp]);
  assert.equal((await call('mgr', 'GET', '/pms/competencies/submitted')).status, 403);
  const r = await call('hr', 'POST', `/pms/competencies/reopen/${id.emp}`, { side: 'self', reason: 'Wrong role picked' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const n = await notices('emp', 'competency_reopened');
  assert.equal(n.length, 1);
  assert.match(n[0].body, /Wrong role picked/);
});
