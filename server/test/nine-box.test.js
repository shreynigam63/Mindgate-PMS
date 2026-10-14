// node --test — the 9-box, end to end, against the client's build
// specification (13 Oct). Real Postgres, real HTTP surface; skips cleanly
// without DATABASE_URL.
//
// The people, and where the spec says each one lands:
//   Top     4.2 / 4.5   (2,2) Top Performer, succession pool
//   Under   2.8 / 2.5   (0,0) Underperformer, PIP at publish
//   Rough   2.0 / 4.5   (0,2) Rough Diamond — a 30-day action, NO PIP
//   Core    3.5 / 3.5   (1,1) Core Player
//   Joiner  4.5 / —     joined 1 Jan, the day after the cut-off: Not placed
//   NoPot   2.4 / —     no potential input: Not placed, still gets a PIP
//   Other   3.5 / 3.5   (1,1), in another manager's team and department
// India time, as the client's servers run: a DATE read as a local Date
// lands on the previous day in UTC, which once let a 1 January joiner
// past the 31 December cut-off.
process.env.TZ = 'Asia/Kolkata';
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, cycleId, cycle2Id;
const id = {};
const tok = {};

const call = async (method, path, who, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a file */ }
  return { status: r.status, body: json, type: r.headers.get('content-type') };
};
const get = (path, who) => call('GET', path, who);

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-9box';
  process.env.TENANT_SLUG = 'ninebox-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  const mk = async (key, name, dept, managerId, doj = '2020-01-01') => {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status, date_of_joining, location, designation)
       VALUES ($1,$2,$3,$4,$5,'active',$6,'Pune','Engineer') RETURNING id`,
      [t.id, name, `nb-${key}@x.com`, dept, managerId || null, doj])).rows[0].id;
  };
  await mk('hr', 'NB HR', 'HR');
  await mk('hod', 'NB HOD', 'Engineering');
  await mk('mgr', 'NB Mgr', 'Engineering');
  await mk('mgr2', 'NB Mgr2', 'Sales');
  await mk('top', 'NB Top', 'Engineering', id.mgr);
  await mk('under', 'NB Under', 'Engineering', id.mgr);
  await mk('rough', 'NB Rough', 'Sales', id.mgr);
  await mk('core', 'NB Core', 'Engineering', id.mgr);
  await mk('joiner', 'NB Joiner', 'Engineering', id.mgr, '2027-01-01');
  await mk('nopot', 'NB NoPot', 'Engineering', id.mgr);
  await mk('other', 'NB Other', 'Sales', id.mgr2);
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Engineering',$2)`, [t.id, id.hod]);
  await db.query(
    `INSERT INTO core.user_roles (tenant_id, email, role) VALUES
       ($1,'nb-hr@x.com','hr'),($1,'nb-hod@x.com','hod'),($1,'nb-mgr@x.com','manager'),($1,'nb-mgr2@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 4);
  for (const k of ['hr', 'hod', 'mgr', 'mgr2', 'top']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, `nb-${k}@x.com`, hash]);
  }

  // FY26-27 is appraised in July 2027: joiners up to 31 Dec 2026 count.
  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase)
     VALUES ($1,'NB FY26-27','FY26-27','annual','manager_eval') RETURNING id`, [t.id])).rows[0].id;
  const comps = [];
  for (const [i, name] of ['Delivery', 'Collaboration'].entries()) {
    comps.push((await db.query(
      `INSERT INTO pms.competencies (tenant_id, category, name, sort_order) VALUES ($1,'CORE',$2,$3) RETURNING id`,
      [t.id, name, i])).rows[0].id);
  }
  global.__nb = { comps };

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/gdpr', require('../core/gdpr').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const k of ['hr', 'hod', 'mgr', 'mgr2', 'top']) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `nb-${k}@x.com`, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

// One person's cycle inputs, written as the product would have them.
async function seed(cycle, key, rating, comp, mgrId = id.mgr) {
  await db.query(
    `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, entries, overall_rating, status, submitted_at)
     VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,'submitted',now())
     ON CONFLICT (cycle_id, employee_id) DO UPDATE SET overall_rating=EXCLUDED.overall_rating, status='submitted'`,
    [tenantId, cycle, id[key], mgrId, rating]);
  if (!comp) return;
  const a = (await db.query(
    `INSERT INTO pms.competency_assessments (tenant_id, cycle_id, employee_id, manager_id, manager_status)
     VALUES ($1,$2,$3,$4,'submitted') ON CONFLICT (tenant_id, cycle_id, employee_id) DO UPDATE SET manager_status='submitted'
     RETURNING id`, [tenantId, cycle, id[key], mgrId])).rows[0].id;
  for (const [i, c] of global.__nb.comps.entries()) {
    await db.query(
      `INSERT INTO pms.competency_ratings (tenant_id, assessment_id, competency_id, required_level, manager_rating)
       VALUES ($1,$2,$3,3,$4) ON CONFLICT (assessment_id, competency_id) DO UPDATE SET manager_rating=EXCLUDED.manager_rating`,
      [tenantId, a, c, comp[i]]);
  }
}
const answers = (a, b) => ({ learning_agility: a, leadership: b, ownership: a, readiness: b });
const phase = (cycle, to, rollback = false) => call('POST', `/pms/cycles/${cycle}/phase`, 'hr', { to, rollback });
const boxOf = (body, key) => Object.values(body.boxes).find((b) => b.people.some((p) => p.employee_id === id[key]));
const everyone = (body) => [...Object.values(body.boxes).flatMap((b) => b.people), ...body.not_placed.people].map((p) => p.employee_id);

test('setup: ratings, competencies and the manager\'s potential answers', { skip }, async () => {
  await seed(cycleId, 'top', 4.2, [4, 5]);
  await seed(cycleId, 'under', 2.8, [2, 3]);
  await seed(cycleId, 'rough', 2.0, [4, 5]);
  await seed(cycleId, 'core', 3.5, [3, 4]);
  await seed(cycleId, 'joiner', 4.5, [5, 5]);
  await seed(cycleId, 'nopot', 2.4, null);
  await seed(cycleId, 'other', 3.5, [3, 4], id.mgr2);
  for (const [k, a, b] of [['top', 4, 5], ['under', 2, 3], ['rough', 4, 5], ['core', 3, 4], ['joiner', 5, 5]]) {
    const r = await call('PUT', `/pms/team/evaluations/${id[k]}/potential`, 'mgr', { answers: answers(a, b) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const o = await call('PUT', `/pms/team/evaluations/${id.other}/potential`, 'mgr2', { answers: answers(3, 4) });
  assert.equal(o.status, 200);
});

test('the Potential step: four questions, the competency score beside them, a live potential', { skip }, async () => {
  const r = await get(`/pms/team/evaluations/${id.top}/potential`, 'mgr');
  assert.equal(r.status, 200);
  assert.equal(r.body.applies, true);
  assert.deepEqual(r.body.questions.map((q) => q.key), ['learning_agility', 'leadership', 'ownership', 'readiness']);
  assert.equal(r.body.competency.score, 4.5);
  assert.equal(r.body.questions_score.score, 4.5);
  assert.equal(r.body.potential.score, 4.5);
  assert.equal(r.body.potential.band_name, 'High');
});

test('only whole numbers 1–5, only this cycle\'s questions, only your own reports', { skip }, async () => {
  const bad = await call('PUT', `/pms/team/evaluations/${id.core}/potential`, 'mgr', { answers: { leadership: 7, charisma: 3 } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors.length, 2);
  const theirs = await call('PUT', `/pms/team/evaluations/${id.core}/potential`, 'mgr2', { answers: { leadership: 1 } });
  assert.equal(theirs.status, 403);
  const chip = await call('PUT', `/pms/team/evaluations/${id.core}`, 'mgr', { potential_rating: 'high' });
  assert.equal(chip.status, 422, 'the old Low/Medium/High chip is refused, not silently dropped');
  const a = (await db.query(`SELECT 1 FROM pms.audit_log WHERE tenant_id=$1 AND action='POTENTIAL_ANSWERED' AND employee_id=$2`,
    [tenantId, id.top])).rows;
  assert.equal(a.length, 1, 'each save of the answers is audited');
});

test('ACCEPTANCE: the boxes, live at calibration', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='calibration' WHERE id=$1`, [cycleId]);
  const r = await get('/pms/nine-box?view=company', 'hr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'provisional');
  assert.equal(boxOf(r.body, 'top').key, '2,2');
  assert.equal(boxOf(r.body, 'top').name, 'Top Performer');
  assert.equal(boxOf(r.body, 'under').key, '0,0');
  assert.equal(boxOf(r.body, 'rough').key, '0,2');
  assert.equal(boxOf(r.body, 'core').key, '1,1');
  const np = Object.fromEntries(r.body.not_placed.people.map((p) => [p.employee_id, p.not_placed_reason]));
  assert.equal(np[id.joiner], 'new_joiner');
  assert.equal(np[id.nopot], 'no_potential');
  assert.equal(r.body.settings.band_text, 'Low below 3.0 · Medium 3.0–3.9 · High 4.0 and above');
});

test('ACCEPTANCE: box counts match the lists behind them and add up to everyone placed', { skip }, async () => {
  const r = await get('/pms/nine-box?view=company', 'hr');
  let sum = 0;
  for (const b of Object.values(r.body.boxes)) { assert.equal(b.count, b.people.length, b.key); sum += b.count; }
  assert.equal(sum, r.body.totals.placed);
  assert.equal(r.body.totals.placed + r.body.totals.not_placed, r.body.totals.in_view);
  assert.equal(r.body.totals.placed, 5);
  assert.equal(r.body.totals.not_placed, 2);
});

// 15 Oct: the HOD's 9-box "only for his team" — the reporting line, not
// every employee of the departments they head.
test('THE HOD\'S OWN TEAM: the reporting view is their reporting line, across departments, and nobody else', { skip }, async () => {
  await db.query(`UPDATE core.employees SET manager_id=$1 WHERE id=$2`, [id.hod, id.mgr]);
  try {
    const r = await get('/pms/nine-box?view=reporting', 'hod');
    assert.equal(r.status, 200);
    const seen = new Set(everyone(r.body));
    for (const k of ['top', 'under', 'rough', 'core', 'joiner', 'nopot']) assert.ok(seen.has(id[k]), `${k} reports to the HOD through the manager`);
    assert.ok(seen.has(id.rough), 'Sales, but on his reporting line');
    assert.ok(!seen.has(id.other), 'another manager\'s team is not his, whatever its department');
    assert.ok(!seen.has(id.hod), 'never himself');
    assert.equal((await get('/pms/nine-box?view=reporting', 'mgr')).status, 403, 'a Delivery Head view');
  } finally {
    await db.query(`UPDATE core.employees SET manager_id=NULL WHERE id=$1`, [id.mgr]);
  }
});

test('ACCEPTANCE: a manager sees only their own team; a Delivery Head only their departments', { skip }, async () => {
  const mine = await get('/pms/nine-box?view=team', 'mgr');
  assert.equal(mine.status, 200);
  assert.deepEqual(new Set(everyone(mine.body)), new Set([id.top, id.under, id.rough, id.core, id.joiner, id.nopot]));
  assert.equal(mine.body.boxes['2,2'].people[0].super50, undefined, 'Super 50 is HR\'s');
  const theirs = await get('/pms/nine-box?view=team', 'mgr2');
  assert.deepEqual(everyone(theirs.body), [id.other]);
  assert.equal((await get('/pms/nine-box?view=company', 'mgr')).status, 403);
  assert.equal((await get('/pms/nine-box?view=departments', 'mgr')).status, 403);

  const hod = await get('/pms/nine-box?view=departments', 'hod');
  assert.equal(hod.status, 200);
  assert.ok(everyone(hod.body).every((e) => e !== id.rough && e !== id.other), 'Sales is not theirs');
  assert.ok(everyone(hod.body).includes(id.top));
  assert.equal((await get('/pms/nine-box?view=company', 'hod')).status, 403);
});

test('ACCEPTANCE: an employee cannot see their own box — nor can anybody else see theirs', { skip }, async () => {
  for (const v of ['company', 'departments', 'team']) {
    assert.equal((await get(`/pms/nine-box?view=${v}`, 'top')).status, 403, v);
  }
  assert.equal((await get(`/pms/nine-box/movement?view=team`, 'top')).status, 403);
  const hr = await get('/pms/nine-box?view=company', 'hr');
  assert.ok(!everyone(hr.body).includes(id.hr), 'HR is not shown their own box');
});

test('filters narrow the grid and the options come from the view', { skip }, async () => {
  const r = await get('/pms/nine-box?view=company&department=Sales', 'hr');
  assert.deepEqual(new Set(everyone(r.body)), new Set([id.rough, id.other]));
  assert.ok(r.body.filters.departments.includes('Engineering'), 'options are the whole view, not the filtered rows');
  const m = await get(`/pms/nine-box?view=company&manager_id=${id.mgr2}`, 'hr');
  assert.deepEqual(everyone(m.body), [id.other]);
});

test('ACCEPTANCE: an override moves the box only with a reason, and is logged', { skip }, async () => {
  const none = await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.core, axis: 'potential', band: 2, reason: '  ' });
  assert.equal(none.status, 422);
  assert.match(none.body.error, /reason is required/);
  const before = (await db.query(`SELECT count(*)::int c FROM pms.nine_box_overrides WHERE tenant_id=$1`, [tenantId])).rows[0].c;
  assert.equal(before, 0, 'nothing written without a reason');

  const ok = await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.core, axis: 'potential', band: 2, reason: 'Led the platform migration' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.placement.box_key, '1,2');
  assert.equal(ok.body.placement.overridden.potential.reason, 'Led the platform migration');
  const log = (await db.query(`SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='NINE_BOX_OVERRIDDEN'`, [tenantId])).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].details.reason, 'Led the platform migration');
  assert.equal(log[0].details.from, 1);
  assert.equal(log[0].details.to, 2);

  const grid = await get('/pms/nine-box?view=company', 'hr');
  assert.equal(boxOf(grid.body, 'core').key, '1,2');
  // A manager sees that it was overridden, not the room's reasoning.
  const team = await get('/pms/nine-box?view=team', 'mgr');
  const c = boxOf(team.body, 'core').people.find((p) => p.employee_id === id.core);
  assert.deepEqual(c.overridden.potential, { band: 2 });

  const same = await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.core, axis: 'potential', band: 2, reason: 'again' });
  assert.equal(same.status, 409);
  const back = await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.core, axis: 'potential', band: null, reason: 'Agreed to leave it to the scores' });
  assert.equal(back.status, 200);
  assert.equal(back.body.placement.box_key, '1,1');
  assert.equal((await call('POST', '/pms/nine-box/override', 'mgr', { employee_id: id.core, axis: 'potential', band: 2, reason: 'x' })).status, 403);
});

test('the hand-typed cell is gone: top-talent answers 410', { skip }, async () => {
  const r = await call('POST', '/pms/calibration/top-talent', 'hr', { employee_id: id.core, nine_box_cell: 'high-high' });
  assert.equal(r.status, 410);
});

test('calibration rows carry the live box', { skip }, async () => {
  const r = await get('/pms/calibration', 'hr');
  assert.equal(r.status, 200);
  const top = r.body.rows.find((x) => x.employee_id === id.top);
  assert.equal(top.nine_box.box_key, '2,2');
  assert.equal(top.nine_box.performance_score, 4.2);
  assert.equal(top.nine_box.potential_score, 4.5);
  assert.equal(r.body.nine_box.boxes['0,0'].name, 'Underperformer');
});

test('ACCEPTANCE: changing the band limits re-places people before publish', { skip }, async () => {
  const s = await get(`/pms/nine-box/settings?cycle_id=${cycleId}`, 'hr');
  assert.equal(s.status, 200);
  assert.equal(s.body.locked, null);
  const body = { ...s.body.settings, mid_from: 2.5 };
  const r = await call('PUT', `/pms/nine-box/settings/${cycleId}`, 'hr', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.moved, 1, 'Under (2.8 / 2.5) is the one person a 2.5 limit moves');
  const g = await get('/pms/nine-box?view=company', 'hr');
  assert.equal(boxOf(g.body, 'under').key, '1,1', '2.8 / 2.5 is Medium on both once Low ends at 2.5');
  const audit = (await db.query(`SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='NINE_BOX_SETTINGS_UPDATED'`, [tenantId])).rows;
  assert.equal(audit.length, 1);
  assert.equal(Number(audit[0].details.after.mid_from), 2.5);

  const bad = await call('PUT', `/pms/nine-box/settings/${cycleId}`, 'hr', { ...body, mid_from: 4.5 });
  assert.equal(bad.status, 422);
  const q = await call('PUT', `/pms/nine-box/settings/${cycleId}`, 'hr', { ...body, mid_from: 3.0, questions: [...body.questions, { label: 'Resilience' }] });
  assert.equal(q.status, 422, 'answers exist, so the question set is fixed');
  const back = await call('PUT', `/pms/nine-box/settings/${cycleId}`, 'hr', { ...body, mid_from: 3.0 });
  assert.equal(back.status, 200);
  assert.equal(boxOf((await get('/pms/nine-box?view=company', 'hr')).body, 'under').key, '0,0');
  assert.equal((await call('PUT', `/pms/nine-box/settings/${cycleId}`, 'mgr', body)).status, 403);
});

let published;
test('ACCEPTANCE: publish places everyone, opens the (0,0) PIP, fills the succession pool', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='publish' WHERE id=$1`, [cycleId]);
  const r = await call('POST', '/pms/publish', 'hr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  published = r.body;
  assert.equal(r.body.failures.length, 0, JSON.stringify(r.body.failures));
  assert.equal(r.body.nine_box.placed, 5);
  assert.equal(r.body.nine_box.not_placed, 2);
  assert.equal(r.body.nine_box.by_box['2,2'], 1);
  assert.equal(r.body.nine_box.succession_added, 1);

  const pl = Object.fromEntries((await db.query(
    `SELECT employee_id, status, box_key, box_name, settings FROM pms.nine_box_placements WHERE cycle_id=$1`, [cycleId])).rows
    .map((x) => [x.employee_id, x]));
  assert.equal(pl[id.top].box_key, '2,2');
  assert.equal(pl[id.joiner].status, 'not_placed');
  assert.equal(Number(pl[id.top].settings.mid_from), 3, 'the settings used are kept with the placement');

  const pool = (await db.query(`SELECT employee_id, department FROM pms.succession_pool WHERE cycle_id=$1`, [cycleId])).rows;
  assert.deepEqual(pool.map((x) => x.employee_id), [id.top]);
  assert.equal(pool[0].department, 'Engineering');

  // The PIP rule the client chose: (0,0), plus anybody below 3.0 who
  // could not be placed. NOT (0,2).
  const pips = new Set((await db.query(`SELECT employee_id FROM pms.pip_records WHERE cycle_id=$1`, [cycleId])).rows.map((x) => x.employee_id));
  assert.ok(pips.has(id.under), '(0,0) gets a PIP');
  assert.ok(pips.has(id.nopot), 'below 3.0 and not placed still gets a PIP');
  assert.ok(!pips.has(id.rough), '(0,2) Rough Diamond does not');
  assert.equal(pips.size, 2);
  assert.equal(r.body.pips_opened, 2);

  const acts = (await db.query(
    `SELECT employee_id, kind, title, assignee_id, due_date, pip_id FROM pms.nine_box_actions WHERE cycle_id=$1`, [cycleId])).rows;
  const rough = acts.find((a) => a.employee_id === id.rough);
  assert.equal(rough.kind, 'development_plan');
  assert.equal(rough.assignee_id, id.mgr);
  const days = Math.round((new Date(rough.due_date) - Date.now()) / 86400000);
  assert.ok(days >= 29 && days <= 31, `due in ${days} days`);
  assert.ok(acts.find((a) => a.employee_id === id.under).pip_id, 'the (0,0) action points at its PIP');
  assert.equal(acts.length, 5, 'one action per placed person');

  const placedAudit = (await db.query(`SELECT count(*)::int c FROM pms.audit_log WHERE tenant_id=$1 AND cycle_id=$2
    AND action IN ('NINE_BOX_PLACED','NINE_BOX_NOT_PLACED')`, [tenantId, cycleId])).rows[0].c;
  assert.equal(placedAudit, 7, 'every placement is logged');

  const mirror = Object.fromEntries((await db.query(`SELECT id, nine_box_cell, potential_rating FROM core.employees WHERE tenant_id=$1`,
    [tenantId])).rows.map((x) => [x.id, x]));
  assert.equal(mirror[id.top].nine_box_cell, 'high-high');
  assert.equal(mirror[id.joiner].nine_box_cell, null);
});

test('notifications: managers and HR get a digest; nothing an employee gets names a box', { skip }, async () => {
  const n = (await db.query(`SELECT employee_id, kind, title, body FROM core.notifications WHERE tenant_id=$1`, [tenantId])).rows;
  const names = ['Top Performer', 'Underperformer', 'Rough Diamond', 'Core Player', '9-box', '(2,2)', '(0,0)'];
  for (const k of ['top', 'under', 'rough', 'core', 'joiner', 'nopot', 'other']) {
    for (const x of n.filter((y) => y.employee_id === id[k])) {
      for (const w of names) assert.ok(!`${x.title} ${x.body || ''}`.includes(w), `${k} was told "${w}": ${x.title}`);
    }
  }
  assert.ok(n.some((x) => x.employee_id === id.mgr && x.kind === 'nine_box_digest'));
  assert.ok(n.some((x) => x.employee_id === id.hr && x.kind === 'nine_box_digest'));
  assert.ok(n.some((x) => x.employee_id === id.under && x.kind === 'pip_opened'));
});

test('the employee\'s own data export carries no box; HR\'s does', { skip }, async () => {
  const mine = await get('/gdpr/export', 'top');
  assert.equal(mine.status, 200);
  const text = JSON.stringify(mine.body);
  assert.ok(!('nine_box_cell' in mine.body.profile));
  assert.ok(!text.includes('high-high'));
  const hr = await get(`/gdpr/export/${id.top}`, 'hr');
  assert.equal(hr.body.hr_only.nine_box_current.nine_box_cell, 'high-high');
  assert.equal(hr.body.hr_only.nine_box_placements[0].box_key, '2,2');
});

test('published: the grid reads what was published, and its settings are locked', { skip }, async () => {
  const g = await get('/pms/nine-box?view=company', 'hr');
  assert.equal(g.body.status, 'published');
  assert.equal(boxOf(g.body, 'top').key, '2,2');
  const s = await get(`/pms/nine-box/settings?cycle_id=${cycleId}`, 'hr');
  assert.ok(s.body.locked);
  const r = await call('PUT', `/pms/nine-box/settings/${cycleId}`, 'hr', { ...s.body.settings, mid_from: 2.5 });
  assert.equal(r.status, 409);
});

test('re-publishing does not duplicate a PIP, an action or a pool entry', { skip }, async () => {
  const r = await call('POST', '/pms/publish', 'hr');
  assert.equal(r.status, 200);
  assert.equal(r.body.pips_opened, 0);
  assert.equal(r.body.nine_box.actions_created, 0);
  assert.equal(r.body.nine_box.succession_added, 0);
});

test('the manager closes an action with a note; nobody else can', { skip }, async () => {
  const a = await get('/pms/nine-box/actions?view=team', 'mgr');
  assert.equal(a.status, 200);
  const rough = a.body.actions.find((x) => x.employee_id === id.rough);
  assert.equal((await call('PUT', `/pms/nine-box/actions/${rough.id}`, 'mgr', { status: 'done' })).status, 422);
  assert.equal((await call('PUT', `/pms/nine-box/actions/${rough.id}`, 'mgr2', { status: 'done', note: 'x' })).status, 403);
  const ok = await call('PUT', `/pms/nine-box/actions/${rough.id}`, 'mgr', { status: 'done', note: 'Coaching plan agreed' });
  assert.equal(ok.status, 200);
  const row = (await db.query(`SELECT status, close_note FROM pms.nine_box_actions WHERE id=$1`, [rough.id])).rows[0];
  assert.equal(row.status, 'done');
});

test('reports: by department, succession, and an Excel export', { skip }, async () => {
  const r = await get('/pms/nine-box/reports?view=company', 'hr');
  assert.equal(r.status, 200);
  const eng = r.body.by_department.find((d) => d.department === 'Engineering');
  assert.equal(eng.boxes['2,2'], 1);
  assert.equal(eng.total, eng.not_placed + Object.values(eng.boxes).reduce((a, b) => a + b, 0));
  assert.equal(r.body.succession.find((d) => d.department === 'Engineering').ready_now[0].employee_id, id.top);
  assert.equal(r.body.previous_cycle, null);
  const x = await get('/pms/nine-box/export.xlsx?view=company', 'hr');
  assert.equal(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  assert.equal((await get('/pms/nine-box/export.xlsx?view=company', 'mgr')).status, 403);
});

test('next cycle: two cycles in (0,0) escalate to HR; a (2,2) who drops alerts HR and the manager', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  cycle2Id = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, created_at)
     VALUES ($1,'NB FY27-28','FY27-28','annual','publish', now() + interval '1 second') RETURNING id`, [tenantId])).rows[0].id;
  await db.query(`UPDATE core.employees SET super50_flag=true WHERE id=$1`, [id.top]);
  await seed(cycle2Id, 'top', 4.5, [3, 4]);
  await seed(cycle2Id, 'under', 2.5, [2, 2]);
  await seed(cycle2Id, 'core', 3.6, [4, 5]);
  for (const [k, a, b] of [['top', 3, 4], ['under', 2, 2], ['core', 4, 5]]) {
    await db.query(`INSERT INTO pms.potential_answers (tenant_id, cycle_id, employee_id, answers) VALUES ($1,$2,$3,$4)`,
      [tenantId, cycle2Id, id[k], JSON.stringify(answers(a, b))]);
  }
  const r = await call('POST', '/pms/publish', 'hr');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nine_box.escalations, 1);
  assert.equal(r.body.nine_box.retention_alerts, 1);

  const esc = (await db.query(`SELECT employee_id FROM pms.nine_box_actions WHERE cycle_id=$1 AND action_key='escalation'`, [cycle2Id])).rows;
  assert.deepEqual(esc.map((x) => x.employee_id), [id.under]);
  const alerts = (await db.query(`SELECT employee_id, body FROM core.notifications WHERE tenant_id=$1 AND kind='nine_box_retention_alert'`, [tenantId])).rows;
  assert.ok(alerts.some((x) => x.employee_id === id.hr));
  assert.ok(alerts.some((x) => x.employee_id === id.mgr));
  assert.ok(!alerts.some((x) => x.employee_id === id.top), 'never to the person themselves');
  assert.match(alerts[0].body, /Super 50/);
  assert.ok((await db.query(`SELECT 1 FROM core.notifications WHERE tenant_id=$1 AND kind='nine_box_escalation' AND employee_id=$2`,
    [tenantId, id.hr])).rows.length);

  // The escalation is HR's to decide: the manager sees it, cannot close it.
  const acts = await get('/pms/nine-box/actions?view=team', 'mgr');
  const e = acts.body.actions.find((a) => a.action_key === 'escalation');
  assert.equal(e.can_close, false);
  assert.equal(acts.body.actions.find((a) => a.action_key === 'box:0,0').can_close, true);
  const refused = await call('PUT', `/pms/nine-box/actions/${e.id}`, 'mgr', { status: 'done', note: 'no need' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /with HR/);
  const hrActs = await get('/pms/nine-box/actions?view=company', 'hr');
  assert.equal(hrActs.body.actions.find((a) => a.id === e.id).can_close, true);
});

test('nobody sees their own box: calibration, override, activity feed, HR\'s own export', { skip }, async () => {
  // HR is evaluated in this cycle too, by the manager.
  await seed(cycle2Id, 'hr', 3.5, null);
  const cal = await get('/pms/calibration', 'hr');
  const own = cal.body.rows.find((r) => r.employee_id === id.hr);
  assert.ok(own, 'HR is a calibration row like anybody');
  assert.equal(own.nine_box, null);
  assert.equal(own.nine_box_hidden, true);
  assert.ok(cal.body.rows.find((r) => r.employee_id === id.top).nine_box, 'everybody else still has theirs');

  await phase(cycle2Id, 'calibration', true);
  const self = await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.hr, axis: 'potential', band: 2, reason: 'me' });
  assert.equal(self.status, 403);
  await phase(cycle2Id, 'publish');
  assert.equal((await call('POST', '/pms/publish', 'hr')).status, 200);

  const feed = await get(`/pms/cycles/${cycle2Id}/activity`, 'hr');
  assert.equal(feed.status, 200);
  assert.ok(!feed.body.events.some((e) => e.employee_id === id.hr && /^NINE_BOX_/.test(e.action)), 'HR\'s own placement is not in their feed');
  assert.ok(feed.body.events.some((e) => e.employee_id === id.top && e.action === 'NINE_BOX_PLACED'), 'other people\'s are');

  const exp = await get(`/gdpr/export/${id.hr}`, 'hr');
  assert.equal(exp.status, 200);
  assert.equal(exp.body.hr_only.nine_box_current, undefined);
  assert.equal(exp.body.hr_only.nine_box_placements, undefined);
});

test('a re-publish that moves somebody out of (0,0) withdraws the untouched PIP and the escalation; moving back reopens them', { skip }, async () => {
  const pipOf = async () => (await db.query(`SELECT status FROM pms.pip_records WHERE cycle_id=$1 AND employee_id=$2`, [cycle2Id, id.under])).rows[0];
  const actsOf = async () => Object.fromEntries((await db.query(
    `SELECT action_key, status FROM pms.nine_box_actions WHERE cycle_id=$1 AND employee_id=$2`, [cycle2Id, id.under])).rows
    .map((a) => [a.action_key, a.status]));
  assert.equal((await pipOf()).status, 'open');

  assert.equal((await phase(cycle2Id, 'calibration', true)).status, 200);
  const live = await get('/pms/nine-box?view=company', 'hr');
  assert.equal(live.body.status, 'provisional', 'rolled back: worked out live again');
  const ov = await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.under, axis: 'potential', band: 1, reason: 'New evidence from the client review' });
  assert.equal(ov.body.placement.box_key, '0,1');
  await phase(cycle2Id, 'publish');
  const before = await get('/pms/nine-box?view=company', 'hr');
  assert.equal(before.body.status, 'provisional', 'at publish but not yet published again: no stale boxes');
  assert.equal(boxOf(before.body, 'under').key, '0,1');
  const s = await get(`/pms/nine-box/settings?cycle_id=${cycle2Id}`, 'hr');
  assert.equal(s.body.locked, null, 'and its settings are not locked yet');

  const r = await call('POST', '/pms/publish', 'hr');
  assert.equal(r.body.nine_box.pips_withdrawn, 1);
  assert.equal((await pipOf()).status, 'closed_withdrawn');
  let a = await actsOf();
  assert.equal(a.escalation, 'superseded');
  assert.equal(a['box:0,0'], 'superseded');
  assert.equal(a['box:0,1'], 'open');
  assert.ok((await db.query(`SELECT 1 FROM core.notifications WHERE employee_id=$1 AND kind='pip_withdrawn'`, [id.under])).rows.length);

  await phase(cycle2Id, 'calibration', true);
  await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.under, axis: 'potential', band: null, reason: 'Back to the scores' });
  await phase(cycle2Id, 'publish');
  const again = await call('POST', '/pms/publish', 'hr');
  assert.equal(again.body.pips_opened, 1, 'the withdrawn plan is opened again');
  assert.equal((await pipOf()).status, 'open');
  a = await actsOf();
  assert.equal(a.escalation, 'open');
  assert.equal(a['box:0,0'], 'open', 'the box action comes back rather than leaving nothing open');
  assert.equal(a['box:0,1'], 'superseded');
});

test('movement: each person\'s box over the cycles, with the direction', { skip }, async () => {
  const m = await get('/pms/nine-box/movement?view=company', 'hr');
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.cycles.length, 2);
  const top = m.body.people.find((p) => p.employee_id === id.top);
  assert.deepEqual(top.boxes.map((b) => b && b.box_key), ['2,2', '2,1']);
  assert.equal(top.current_movement, 'down');
  const core = m.body.people.find((p) => p.employee_id === id.core);
  assert.equal(core.current_movement, 'up');
  const under = m.body.people.find((p) => p.employee_id === id.under);
  assert.equal(under.current_movement, 'same');

  const rep = await get('/pms/nine-box/reports?view=company', 'hr');
  assert.equal(rep.body.previous_cycle.id, cycleId);
  const d22 = rep.body.distribution.find((x) => x.key === '2,2');
  assert.equal(d22.prev_count, 1);
  assert.equal(d22.count, 0);
  assert.equal(d22.delta, -1);
  // An earlier cycle stays readable after it closes.
  const old = await get(`/pms/nine-box?view=company&cycle_id=${cycleId}`, 'hr');
  assert.equal(old.status, 200);
  assert.equal(boxOf(old.body, 'top').key, '2,2');
});

test('a cycle somebody was not evaluated in breaks the streak: no escalation across a gap', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycle2Id]);
  const c3 = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, created_at)
     VALUES ($1,'NB FY28-29','FY28-29','annual','publish', now() + interval '2 seconds') RETURNING id`, [tenantId])).rows[0].id;
  await seed(c3, 'core', 3.5, [3, 4]);
  assert.equal((await call('POST', '/pms/publish', 'hr')).status, 200);
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [c3]);
  const c4 = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, created_at)
     VALUES ($1,'NB FY29-30','FY29-30','annual','publish', now() + interval '3 seconds') RETURNING id`, [tenantId])).rows[0].id;
  await seed(c4, 'under', 2.0, [2, 2]);
  await db.query(`INSERT INTO pms.potential_answers (tenant_id, cycle_id, employee_id, answers) VALUES ($1,$2,$3,$4)`,
    [tenantId, c4, id.under, JSON.stringify(answers(2, 2))]);
  const r = await call('POST', '/pms/publish', 'hr');
  assert.equal(r.body.nine_box.by_box['0,0'], 1);
  assert.equal(r.body.nine_box.escalations, 0, 'FY28-29 had no row for them, so this is not two in a row');
  const pl = (await db.query(`SELECT prev_box_key, movement FROM pms.nine_box_placements WHERE cycle_id=$1 AND employee_id=$2`, [c4, id.under])).rows[0];
  assert.equal(pl.prev_box_key, null);
  assert.equal(pl.movement, 'new');
});

test('re-publish: a started automatic PIP is kept for HR, an untouched one withdrawn and taken over by the manager; a stale retention alert is renamed; closing needs a fresh publish', { skip }, async () => {
  const c4 = (await db.query(`SELECT id FROM pms.cycles WHERE tenant_id=$1 AND fiscal_year='FY29-30'`, [tenantId])).rows[0].id;
  // Top was Top Performer in FY29-30 (written straight in: that cycle is history).
  await db.query(
    `INSERT INTO pms.nine_box_placements (tenant_id, cycle_id, employee_id, status, box_key, box_name, perf_band, pot_band, settings, placed_by)
     VALUES ($1,$2,$3,'placed','2,2','Top Performer',2,2,'{}'::jsonb,'test')`, [tenantId, c4, id.top]);
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [c4]);
  const c5 = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, phase, created_at)
     VALUES ($1,'NB FY30-31','FY30-31','annual','publish', now() + interval '4 seconds') RETURNING id`, [tenantId])).rows[0].id;
  for (const k of ['rough', 'core']) await seed(c5, k, 2.0, [2, 2]);
  await seed(c5, 'top', 4.5, [3, 4]);
  for (const [k, a, b] of [['rough', 2, 2], ['core', 2, 2], ['top', 3, 4]]) {
    await db.query(`INSERT INTO pms.potential_answers (tenant_id, cycle_id, employee_id, answers) VALUES ($1,$2,$3,$4)`,
      [tenantId, c5, id[k], JSON.stringify(answers(a, b))]);
  }
  const first = await call('POST', '/pms/publish', 'hr');
  assert.equal(first.body.pips_opened, 2);
  assert.equal(first.body.nine_box.retention_alerts, 1);
  const pip = async (k) => (await db.query(`SELECT id, status, opened_by FROM pms.pip_records WHERE cycle_id=$1 AND employee_id=$2`, [c5, id[k]])).rows[0];
  // The manager starts on Rough's plan: a weekly note moves it to in progress.
  const started = await call('POST', `/pms/pip/${(await pip('rough')).id}/entries`, 'mgr', { week_ending: '2031-07-04', notes: 'First check-in held' });
  assert.equal(started.status, 200);
  assert.equal((await pip('rough')).status, 'in_progress');

  await phase(c5, 'calibration', true);
  for (const k of ['rough', 'core']) {
    await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id[k], axis: 'potential', band: 1, reason: 'Client feedback reviewed' });
  }
  await call('POST', '/pms/nine-box/override', 'hr', { employee_id: id.top, axis: 'performance', band: 1, reason: 'Calibrated with peers' });
  await phase(c5, 'publish');
  // Rolled back and brought forward without publishing: not closable yet.
  const early = await phase(c5, 'closed');
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Publish ratings again/);

  const again = await call('POST', '/pms/publish', 'hr');
  assert.equal(again.body.nine_box.pips_withdrawn, 1, 'Core\'s untouched plan');
  assert.equal(again.body.nine_box.pips_to_review, 1, 'Rough\'s started plan');
  assert.equal((await pip('rough')).status, 'in_progress', 'a started plan is never closed by publish');
  assert.equal((await pip('core')).status, 'closed_withdrawn');
  assert.ok((await db.query(`SELECT 1 FROM core.notifications WHERE employee_id=$1 AND kind='nine_box_pip_review'`, [id.hr])).rows.length);
  const alert = (await db.query(`SELECT title, box_key, status FROM pms.nine_box_actions WHERE cycle_id=$1 AND employee_id=$2 AND action_key='retention_alert'`,
    [c5, id.top])).rows[0];
  assert.equal(alert.status, 'open');
  assert.equal(alert.box_key, '1,1', 'from High Performer (2,1) to Core Player (1,1) on the performance override');
  assert.match(alert.title, /Core Player \(1,1\)/, 'the open alert names where they are now');

  // The manager can still open a plan for Core: it takes over the withdrawn row.
  const withdrawnId = (await pip('core')).id;
  const own = await call('POST', '/pms/pip', 'mgr', {
    employee_id: id.core, performance_description: 'Delivery dates slipping', target_areas: [{ area: 'Estimation', expected: 'Within 10%' }],
    gates: [{ title: 'First review', due_date: '2031-08-01' }], start_date: '2031-07-01', end_date: '2031-09-30' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.id, withdrawnId);
  const now = await pip('core');
  assert.equal(now.status, 'open');
  assert.equal(now.opened_by, 'nb-mgr@x.com', 'now the manager\'s plan, which a later publish leaves alone');

  assert.equal((await phase(c5, 'closed')).status, 200, 'published again, it closes');
});
