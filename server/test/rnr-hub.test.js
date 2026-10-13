// People Hub → Awards, read from RnR (13 Oct: "please link"). What any
// employee may see: the open cycle, the awards, their own awards, and the
// winners of each cycle once its award date has come. Never a nominee, a
// pending nomination, a justification or an award's money value.
process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rnr-hub-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db; let server; let base; let tenantId;
const tok = {}; const id = {};

const call = async (who, path) => {
  const r = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${tok[who]}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  await require('../core/migrate').runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [`rnrhub-${Date.now()}`])).rows[0].id;
  for (const [k, loc] of [['emp', 'Pune'], ['mgr', 'Pune'], ['past', 'Mumbai'], ['soon', 'Pune'], ['pending', 'Pune'], ['hrbp', 'Pune']]) {
    id[k] = (await db.query(`INSERT INTO core.employees (tenant_id,name,email,status,department,location) VALUES ($1,$2,$3,'active','Delivery',$4) RETURNING id`,
      [tenantId, `${k}-person`, `${k}@x.com`, loc])).rows[0].id;
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'mgr@x.com','manager'),($1,'hrbp@x.com','hrbp')`, [tenantId]);
  for (const [role, p] of [['employee', 'people_view'], ['manager', 'people_view'], ['manager', 'pms_team_eval'], ['hrbp', 'pms_hrbp'], ['hrbp', 'people_view']]) {
    await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, role, p]);
  }
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'hrbp@x.com','location','Pune','test')`, [tenantId]);
  const award = (await db.query(`INSERT INTO rnr.awards (tenant_id,key,name,level,frequency,criteria,award_value_paise)
    VALUES ($1,'star','Star Award','all','quarterly','For going beyond',500000) RETURNING id`, [tenantId])).rows[0].id;
  const team = (await db.query(`INSERT INTO rnr.awards (tenant_id,key,name,level,frequency,is_team)
    VALUES ($1,'team','Team Award','all','quarterly',true) RETURNING id`, [tenantId])).rows[0].id;
  const cyc = async (name, status, awardDays) => (await db.query(
    `INSERT INTO rnr.cycles (tenant_id,name,kind,nominations_open,nominations_close,award_date,status)
     VALUES ($1,$2,'quarterly',CURRENT_DATE - 60,CURRENT_DATE - 30,CURRENT_DATE + $3::int,$4) RETURNING id`, [tenantId, name, awardDays, status])).rows[0].id;
  const done = await cyc('Q1', 'closed', -5);
  const upcoming = await cyc('Q2', 'closed', 10);
  const open = (await db.query(`INSERT INTO rnr.cycles (tenant_id,name,kind,nominations_open,nominations_close,award_date,status)
    VALUES ($1,'Q3','quarterly',CURRENT_DATE,CURRENT_DATE + 20,CURRENT_DATE + 40,'open') RETURNING id`, [tenantId])).rows[0].id;
  const nom = (cycle, a, emp, status, extra = {}) => db.query(
    `INSERT INTO rnr.nominations (tenant_id,cycle_id,award_id,employee_id,nominated_by,status,justification,team_name,team_members)
     VALUES ($1,$2,$3,$4,$5,$6,'SECRET-JUSTIFICATION',$7,$8)`, [tenantId, cycle, a, emp, id.mgr, status, extra.team || null, extra.members || null]);
  await nom(done, award, id.past, 'awarded');
  await nom(done, team, null, 'final_approved', { team: 'Pune Crew', members: 'A, B, C' });
  await nom(done, award, id.pending, 'rejected');
  await nom(upcoming, award, id.soon, 'final_approved');
  await nom(open, award, id.pending, 'pending_hr');
  const hash = await bcrypt.hash('pw', 4);
  for (const k of ['emp', 'mgr', 'soon', 'hrbp']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, `${k}@x.com`, hash]);
  }
  require('../modules/performance/hrbp-gateway');
  const { devLogin } = require('../core/auth');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const k of ['emp', 'mgr', 'soon', 'hrbp']) {
    tok[k] = (await (await fetch(`${base}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${k}@x.com`, password: 'pw' }) })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise((r) => server.close(r));
  for (const t of ['rnr.nominations', 'rnr.cycles', 'rnr.awards', 'core.hrbp_scope', 'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  }
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});

test('THE WINNERS WALL: winners of cycles whose award date has come, for everyone — nobody else', { skip }, async () => {
  const r = await call('emp', '/people/rnr/hub');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.winners.map((g) => g.cycle_name), ['Q1'], 'Q2\'s award date is still to come');
  const q1 = r.body.winners[0].winners;
  assert.ok(q1.some((w) => w.name === 'past-person' && w.award_name === 'Star Award' && w.department === 'Delivery'));
  assert.ok(q1.some((w) => w.team_name === 'Pune Crew' && w.team_members === 'A, B, C'));
  const text = JSON.stringify(r.body);
  for (const hidden of ['pending-person', 'soon-person', 'SECRET-JUSTIFICATION', '500000', 'award_value']) {
    assert.ok(!text.includes(hidden), `the hub shows ${hidden}`);
  }
});

test('the open cycle, the awards, and your own awards — even before the award date', { skip }, async () => {
  const r = (await call('soon', '/people/rnr/hub')).body;
  assert.equal(r.open_cycle.name, 'Q3');
  assert.deepEqual(r.awards.map((a) => a.name).sort(), ['Star Award', 'Team Award']);
  assert.equal(r.awards.find((a) => a.name === 'Star Award').criteria, 'For going beyond');
  assert.deepEqual(r.mine.map((m) => [m.award_name, m.cycle_name, m.status]), [['Star Award', 'Q2', 'final_approved']]);
  assert.equal(r.can_nominate, false);
  assert.equal((await call('mgr', '/people/rnr/hub')).body.can_nominate, true, 'a manager is offered Nominate');
});

test('an HRBP sees the same company-wide wall, not one cut to their remit', { skip }, async () => {
  const r = await call('hrbp', '/people/rnr/hub');
  assert.equal(r.status, 200);
  assert.ok(r.body.winners[0].winners.some((w) => w.name === 'past-person'), 'a Mumbai winner was cut from a Pune HRBP\'s wall');
});
