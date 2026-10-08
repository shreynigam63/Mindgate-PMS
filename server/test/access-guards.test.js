// node --test — two access holes closed on 8 Oct, against a real database.
//
// 1. An HRBP could make anyone in their remit — themselves included — HR
//    or Super Admin, and set anyone's password, because the HRBP gateway
//    lends HR's people_admin for a request that names someone in the
//    remit. Asked for: "Only HR and Super Admins should have this access."
// 2. Any signed-in person could read every RnR nomination in the company
//    by typing the RnR Dashboard's address. Asked for: "it should not be
//    visible currently, in future if we want we will allow this display
//    access."

process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'access-guards-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../core/db');
const { devLogin } = require('../core/auth');
// Loading the performance module registers the HRBP gateway on the core
// and people routers, exactly as the app does.
require('../modules/performance');

const SLUG = `acg-test-${Date.now()}`;
let server; let base; let tenantId;
const ids = {}; const tok = {};

const call = async (who, path, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' },
  });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
};
const roleOf = async (email) => ((await db.query(
  `SELECT role FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [tenantId, email])).rows[0] || {}).role || 'employee';

before(async () => {
  // First in the suite alphabetically, so on a fresh database (the CI
  // runner's) nothing has created the schema yet.
  await require('../core/migrate').runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  const mk = async (key, email, location) => {
    ids[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, location)
       VALUES ($1,$2,$3,'active','Delivery',$4) RETURNING id`, [tenantId, key, email, location])).rows[0].id;
  };
  // The partner works in Pune and covers Pune, so they are in their own remit.
  await mk('partner', 'partner@x.com', 'Pune');
  await mk('hrPune', 'hr-pune@x.com', 'Pune');       // an HR person inside the remit
  await mk('emp', 'emp@x.com', 'Pune');
  await mk('mgr', 'mgr@x.com', 'Pune');
  await mk('hod', 'hod@x.com', 'Mumbai');
  await mk('boss', 'boss@x.com', null);
  await mk('empMum', 'emp-mum@x.com', 'Mumbai');
  await mk('mgrMum', 'mgr-mum@x.com', 'Mumbai');
  await db.query(`UPDATE core.employees SET manager_id=$2 WHERE id=$1`, [ids.emp, ids.mgr]);
  const roles = [['partner@x.com', 'hrbp'], ['hr-pune@x.com', 'hr'], ['mgr@x.com', 'manager'], ['hod@x.com', 'hod'], ['boss@x.com', 'admin'], ['mgr-mum@x.com', 'manager']];
  for (const [e, r] of roles) await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,$2,$3)`, [tenantId, e, r]);
  const grants = {
    employee: ['pms_self', 'people_view'],
    manager: ['pms_self', 'pms_team_eval', 'people_view'],
    hod: ['pms_self', 'pms_team_eval', 'pms_hod', 'people_view'],
    hrbp: ['pms_self', 'pms_hrbp', 'people_view'],
    hr: ['pms_self', 'pms_admin', 'pms_team_eval', 'pms_hod', 'pms_hrbp', 'people_admin', 'people_view'],
    admin: ['*'],
  };
  for (const [role, perms] of Object.entries(grants)) {
    for (const p of perms) await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, role, p]);
  }
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'partner@x.com','location','Pune','test')`, [tenantId]);

  // One RnR nomination, raised by the manager for the employee, waiting on HR.
  const award = (await db.query(
    `INSERT INTO rnr.awards (tenant_id,key,name,level,frequency) VALUES ($1,'acg','ACG Award','all','annual') RETURNING id`, [tenantId])).rows[0].id;
  const cycle = (await db.query(
    `INSERT INTO rnr.cycles (tenant_id,name,kind,nominations_open,nominations_close,status)
     VALUES ($1,'ACG cycle','annual',CURRENT_DATE,CURRENT_DATE + 30,'open') RETURNING id`, [tenantId])).rows[0].id;
  ids.nomination = (await db.query(
    `INSERT INTO rnr.nominations (tenant_id,cycle_id,award_id,employee_id,nominated_by,status)
     VALUES ($1,$2,$3,$4,$5,'pending_hr') RETURNING id`, [tenantId, cycle, award, ids.emp, ids.mgr])).rows[0].id;
  const nom = async (employeeId, by, status, team) => (await db.query(
    `INSERT INTO rnr.nominations (tenant_id,cycle_id,award_id,employee_id,nominated_by,status,team_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [tenantId, cycle, award, employeeId, by, status, team])).rows[0].id;
  ids.teamIn = await nom(null, ids.mgr, 'pending_hrbp', 'Pune Crew');        // raised in Pune
  ids.teamOut = await nom(null, ids.mgrMum, 'pending_hrbp', 'Mumbai Crew');  // raised in Mumbai
  ids.final = await nom(ids.emp, ids.mgr, 'final_approved', null);
  ids.earlier = await nom(ids.emp, ids.boss, 'rejected', null);              // part of emp's history
  ids.cycle = cycle; ids.award = award;

  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['partner@x.com', 'hr-pune@x.com', 'emp@x.com', 'mgr@x.com', 'hod@x.com', 'boss@x.com', 'mgr-mum@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/employees', require('../core/employees').router);
  app.use('/api/v1/people', require('../modules/people').router);
  app.use('/api/v1/pms', require('../modules/performance').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, e] of [['hrbp', 'partner@x.com'], ['hr', 'hr-pune@x.com'], ['emp', 'emp@x.com'], ['mgr', 'mgr@x.com'], ['hod', 'hod@x.com'], ['admin', 'boss@x.com']]) {
    tok[k] = (await (await fetch(`${base}/api/v1/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'pw' }),
    })).json()).token;
    assert.ok(tok[k], `login for ${e}`);
  }
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tenantId) {
    for (const t of ['rnr.quota_overrides', 'rnr.events', 'rnr.nominations', 'rnr.cycles', 'rnr.awards', 'core.notifications', 'core.audit_log',
      'core.department_heads', 'core.departments',
      'core.hrbp_scope', 'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.employees']) {
      await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
    }
    await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  }
  await db.pool.end();
});

test('AN HRBP CANNOT CHANGE A ROLE — not their own, not anyone in their remit', async () => {
  let r = await call('hrbp', `/employees/${ids.partner}/role`, { method: 'PUT', body: JSON.stringify({ role: 'admin' }) });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.match(r.body.error, /Only HR and Super Admin/);
  assert.equal(await roleOf('partner@x.com'), 'hrbp', 'still an HRBP');
  r = await call('hrbp', `/employees/${ids.emp}/role`, { method: 'PUT', body: JSON.stringify({ role: 'hr' }) });
  assert.equal(r.status, 403);
  assert.equal(await roleOf('emp@x.com'), 'employee');
});

test('AN HRBP CANNOT SET A PASSWORD — signing in as someone is the same power as taking their role', async () => {
  const before = (await db.query(`SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='hr-pune@x.com'`, [tenantId])).rows[0].password_hash;
  const r = await call('hrbp', `/employees/${ids.hrPune}/credentials`, { method: 'POST', body: JSON.stringify({ password: 'takeover-123' }) });
  assert.equal(r.status, 403);
  const after_ = (await db.query(`SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND email='hr-pune@x.com'`, [tenantId])).rows[0].password_hash;
  assert.equal(after_, before, 'the HR person\'s password is unchanged');
  assert.equal((await call('hrbp', '/employees/credentials/bulk', { method: 'POST', body: JSON.stringify({}) })).status, 403);
});

test('an HRBP still manages profiles in their remit, and HR and Super Admin still manage access', async () => {
  // Profile edits are the HRBP's job and still go through the gateway.
  const r = await call('hrbp', `/employees/${ids.emp}`, { method: 'PUT', body: JSON.stringify({ name: 'Emp Renamed' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // HR and Super Admin: roles and passwords as before.
  assert.equal((await call('hr', `/employees/${ids.emp}/role`, { method: 'PUT', body: JSON.stringify({ role: 'manager' }) })).status, 200);
  assert.equal(await roleOf('emp@x.com'), 'manager');
  assert.equal((await call('admin', `/employees/${ids.emp}/role`, { method: 'PUT', body: JSON.stringify({ role: 'employee' }) })).status, 200);
  assert.equal(await roleOf('emp@x.com'), 'employee');
  assert.equal((await call('hr', `/employees/${ids.emp}/credentials`, { method: 'POST', body: JSON.stringify({ password: 'new-pass-123' }) })).status, 200);
});

test('THE COMPANY-WIDE RnR LIST IS OPEN TO NOBODY — employees, managers, HODs, HRBPs and HR alike', async () => {
  for (const who of ['emp', 'mgr', 'hod', 'hrbp', 'hr']) {
    const r = await call(who, '/people/rnr/nominations');
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /not open at present/);
    // A status that is not an approval queue is the same list by another door.
    assert.equal((await call(who, '/people/rnr/nominations?status=final_approved')).status, 403, who);
  }
});

test('each approval stage still reads its own queue, and a nominator their own nominations', async () => {
  let r = await call('hr', '/people/rnr/nominations?status=pending_hr');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.nominations.map((n) => n.id), [ids.nomination]);
  assert.equal((await call('hod', '/people/rnr/nominations?status=pending_delivery_head')).status, 200);
  assert.equal((await call('emp', '/people/rnr/nominations?status=pending_hr')).status, 403, 'not the employee\'s queue');
  assert.equal((await call('hod', '/people/rnr/nominations?status=pending_hr')).status, 403, 'nor the HOD\'s');
  r = await call('mgr', '/people/rnr/nominations?mine=true');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.nominations.map((n) => n.id).sort(), [ids.nomination, ids.teamIn, ids.final].sort(), 'exactly the ones they raised');
  assert.ok(r.body.nominations.every((n) => n.nominated_by === ids.mgr));
  r = await call('emp', '/people/rnr/nominations?mine=true');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.nominations, [], 'the nominee raised nothing');
});

test('one nomination opens for its nominator, its current stage and HR — not for anyone else', async () => {
  const path = `/people/rnr/nominations/${ids.nomination}`;
  assert.equal((await call('mgr', path)).status, 200, 'the nominator');
  assert.equal((await call('hr', path)).status, 200, 'HR, whose stage it is');
  assert.equal((await call('emp', path)).status, 403, 'not the nominee before it is decided');
  assert.equal((await call('hod', path)).status, 403, 'not an HOD once it has left their stage');
});

// ---- The second round (8 Oct review of the fix) ----

test('LETTER CASE IS NOT A WAY ROUND THE GATEWAY: remits and department heads stay HR\'s', async () => {
  const scope = async () => (await db.query(`SELECT kind, value FROM core.hrbp_scope WHERE tenant_id=$1 AND email='partner@x.com' ORDER BY value`, [tenantId])).rows;
  const before = await scope();
  for (const path of ['/pms/hrbp/admin/partners/partner@x.com', '/pms/HRBP/admin/partners/partner@x.com', '/pms/Hrbp/Admin/Partners/partner@x.com']) {
    const r = await call('hrbp', path, { method: 'PUT', body: JSON.stringify({ email: 'partner@x.com', locations: ['Pune', 'Mumbai'], hods: [] }) });
    assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(await scope(), before, 'the HRBP\'s remit is unchanged');
  assert.equal((await call('hrbp', '/pms/Hrbp/Admin/partners')).status, 403, 'nor can the remits be read');
  for (const path of ['/employees/department-heads/Delivery', '/employees/Department-Heads/Delivery', '/employees/DEPARTMENT-HEADS/Finance']) {
    const r = await call('hrbp', path, { method: 'PUT', body: JSON.stringify({ employee_id: ids.emp }) });
    assert.equal(r.status, 403, path);
  }
  assert.equal((await db.query(`SELECT count(*)::int n FROM core.department_heads WHERE tenant_id=$1`, [tenantId])).rows[0].n, 0);
});

test('AN IN-REMIT ID IN THE BODY DOES NOT CARRY A WRITE ABOUT ANYONE ELSE', async () => {
  // Bulk remove of people outside the remit, Super Admin included.
  let r = await call('hrbp', '/employees', { method: 'DELETE', body: JSON.stringify({ ids: [ids.boss, ids.empMum], employee_id: ids.emp }) });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal((await db.query(`SELECT count(*)::int n FROM core.employees WHERE id = ANY($1) AND archived_at IS NULL`, [[ids.boss, ids.empMum]])).rows[0].n, 2);
  assert.equal((await db.query(`SELECT count(*)::int n FROM core.local_credentials WHERE tenant_id=$1 AND email='boss@x.com'`, [tenantId])).rows[0].n, 1, 'the Super Admin can still sign in');
  r = await call('hrbp', '/employees', { method: 'DELETE', body: JSON.stringify({ confirm_count: 99, employee_id: ids.emp }) });
  assert.equal(r.status, 403, 'nor the whole list');
  r = await call('hrbp', '/employees', { method: 'POST', body: JSON.stringify({ employee_id: ids.emp, name: 'Ghost', email: 'ghost@x.com', location: 'Mumbai' }) });
  assert.equal(r.status, 403, 'nor adding people');
  assert.equal((await call('hrbp', '/employees/departments', { method: 'POST', body: JSON.stringify({ employee_id: ids.emp, name: 'Shadow' }) })).status, 403);
  assert.equal((await call('hrbp', `/employees/${ids.emp}?purge=1`, { method: 'DELETE' })).status, 403, 'nor erasing for good');
});

test('HR\'S FINAL RnR STAGE IS HR\'S: an HRBP can neither read the queue nor decide it', async () => {
  assert.equal((await call('hrbp', '/people/rnr/nominations?status=pending_hr')).status, 403);
  assert.equal((await call('hrbp', `/people/rnr/nominations/${ids.nomination}/decide`, { method: 'POST', body: JSON.stringify({ action: 'approve', override_reason: 'because' }) })).status, 403);
  assert.equal((await db.query(`SELECT status FROM rnr.nominations WHERE id=$1`, [ids.nomination])).rows[0].status, 'pending_hr');
});

test('team nominations follow the remit of the manager who raised them', async () => {
  const r = await call('hrbp', '/people/rnr/nominations?status=pending_hrbp');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.nominations.map((n) => n.team_name), ['Pune Crew'], 'the Mumbai team award is not shown');
  assert.equal((await call('hrbp', `/people/rnr/nominations/${ids.teamOut}`)).status, 403);
  assert.equal((await call('hrbp', `/people/rnr/nominations/${ids.teamOut}/decide`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) })).status, 403);
  const ok = await call('hrbp', `/people/rnr/nominations/${ids.teamIn}/decide`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) });
  assert.equal(ok.status, 200, `the Pune HRBP decides the Pune team award: ${JSON.stringify(ok.body)}`);
});

test('a nominator sees their own nomination, not the nominee\'s earlier awards — and can only nominate their own team', async () => {
  let r = await call('mgr', `/people/rnr/nominations/${ids.final}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.history, [], 'no history for the nominator');
  r = await call('hr', `/people/rnr/nominations/${ids.final}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.history.length >= 1, 'HR sees it');
  r = await call('mgr', '/people/rnr/nominations', { method: 'POST',
    body: JSON.stringify({ cycle_id: ids.cycle, award_id: ids.award, employee_id: ids.empMum, justification: 'x' }) });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.ok(!r.body.reasons && !r.body.facts, 'nothing about that person comes back');
});

test('outside the stages, only the nominator resubmits and only HR marks an award given', async () => {
  assert.equal((await call('mgr', `/people/rnr/nominations/${ids.final}/decide`, { method: 'POST', body: JSON.stringify({ action: 'award' }) })).status, 403);
  assert.equal((await call('emp', `/people/rnr/nominations/${ids.final}/decide`, { method: 'POST', body: JSON.stringify({ action: 'award' }) })).status, 403);
  const r = await call('hr', `/people/rnr/nominations/${ids.final}/decide`, { method: 'POST', body: JSON.stringify({ action: 'award' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
