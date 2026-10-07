// node --test — the five changes asked for on 7 Oct:
//   1. connects with anyone, and "do you need HR as part of this connect"
//   2. KRA, KPI and weightage editable during mid-year and annual review
//   3. the Final Rating as a chain: annual review, manager, HOD, HR
//   4. the manager's Performance Improvement Plan: description, targeted
//      areas, gates
//   5. the HOD's Team Competencies, every employee, by department
// Real HTTP against a real Postgres, like pip.test.js; SKIPS without one.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, S;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-7oct';
  process.env.TENANT_SLUG = 'oct7-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const slug = process.env.TENANT_SLUG;
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [slug])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await require('../migrations/084-connects-pip-hod-competencies').ensurePages(db, t.id);

  const add = async (name, email, dept, managerId, role, extra = {}) => {
    const e = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, manager_id, location, hod_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [t.id, name, email, extra.status || 'active', dept, managerId || null, extra.location || null, extra.hod_name || null])).rows[0];
    if (role) await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)`, [t.id, email, role]);
    return e.id;
  };
  const hod = await add('Oct HOD', 'o-hod@x.com', 'Delivery', null, 'hod');
  const mgr = await add('Oct Mgr', 'o-mgr@x.com', 'Delivery', hod, 'manager');
  const emp = await add('Oct Emp', 'o-emp@x.com', 'Delivery', mgr, null, { location: 'Pune' });
  const peer = await add('Oct Peer', 'o-peer@x.com', 'Delivery', mgr, null);
  const fin = await add('Oct Fin', 'o-fin@x.com', 'Finance', null, null);
  const gone = await add('Oct Gone', 'o-gone@x.com', 'Delivery', mgr, null, { status: 'inactive' });
  const hr = await add('Oct HR', 'o-hr@x.com', 'Human Resources', null, 'hr');
  const hrbp = await add('Oct HRBP', 'o-hrbp@x.com', 'Human Resources', null, 'hrbp');
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id, email, kind, value) VALUES ($1,'o-hrbp@x.com','location','Pune')`, [t.id]);
  await db.query(`INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,'Delivery',$2)`, [t.id, hod]);
  const hash = await bcrypt.hash('pass', 4);
  for (const email of ['o-hod@x.com', 'o-mgr@x.com', 'o-emp@x.com', 'o-peer@x.com', 'o-fin@x.com', 'o-hr@x.com', 'o-hrbp@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, email, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase) VALUES ($1,'Oct Cycle','FY27','kra_open') RETURNING id`, [t.id])).rows[0];
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id, status) VALUES ($1,$2,$3,$4,'approved') RETURNING id`,
    [t.id, cycle.id, emp, mgr])).rows[0];
  const k1 = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, measures, weight, sort_order) VALUES ($1,$2,'Delivery','90% sprint scope',60,1) RETURNING id`, [t.id, sheet.id])).rows[0];
  const k2 = (await db.query(`INSERT INTO pms.kras (tenant_id, sheet_id, title, measures, weight, sort_order) VALUES ($1,$2,'Quality','< 2 escaped defects',40,2) RETURNING id`, [t.id, sheet.id])).rows[0];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;

  const tok = {};
  for (const [k, email] of Object.entries({ hod: 'o-hod@x.com', mgr: 'o-mgr@x.com', emp: 'o-emp@x.com', peer: 'o-peer@x.com', fin: 'o-fin@x.com', hr: 'o-hr@x.com', hrbp: 'o-hrbp@x.com' })) {
    const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pass' }) });
    tok[k] = (await r.json()).token;
  }
  S = { t: t.id, hod, mgr, emp, peer, fin, gone, hr, hrbp, cycle: cycle.id, sheet: sheet.id, k1: k1.id, k2: k2.id, tok };
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

async function api(path, token, opts = {}) {
  const r = await fetch(`${base}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
}
const post = (path, token, body) => api(path, token, { method: 'POST', body: JSON.stringify(body) });
const put = (path, token, body) => api(path, token, { method: 'PUT', body: JSON.stringify(body) });
const setPhase = (phase) => db.query(`UPDATE pms.cycles SET phase=$2 WHERE id=$1`, [S.cycle, phase]);

test('CONNECTS: anyone can connect with anyone, and the person picked signs it off', { skip }, async () => {
  const people = await api('/pms/connects/people', S.tok.emp);
  assert.equal(people.status, 200);
  const ids = people.body.people.map((p) => p.id);
  assert.ok(ids.includes(S.peer) && ids.includes(S.fin), 'colleagues in any department are offered');
  assert.ok(!ids.includes(S.emp), 'not yourself');
  assert.ok(!ids.includes(S.gone), 'not someone inactive');
  assert.equal(people.body.my_manager_id, S.mgr);

  const r = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-01', topic: 'Peer sync', with_id: S.fin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.with_id, S.fin);

  const finList = await api('/pms/connects', S.tok.fin);
  const cn = finList.body.connects.find((c) => c.id === r.body.id);
  assert.ok(cn, 'the person connected with sees it');
  assert.equal(cn.manager_name, 'Oct Fin');
  const so = await post(`/pms/connects/${r.body.id}/sign-off`, S.tok.fin, {});
  assert.equal(so.status, 200, 'and signs it off');

  // Left out, it is still the manager — the behaviour before 7 Oct.
  const d = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-02' });
  assert.equal(d.body.with_id, S.mgr);

  assert.equal((await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-02', with_id: S.emp })).status, 422, 'not with yourself');
  assert.equal((await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-02', with_id: S.gone })).status, 422, 'not with someone inactive');
});

test('CONNECTS: "do you need HR" — yes brings in the HRBP covering the employee, who can then read it', { skip }, async () => {
  const people = await api('/pms/connects/people', S.tok.emp);
  assert.deepEqual(people.body.hr.map((h) => h.id).sort(), [S.hr, S.hrbp].sort(), 'HR and HRBP are offered');
  assert.equal(people.body.suggested_hr_id, S.hrbp, 'the HRBP whose remit covers Pune is suggested');

  const r = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-03', with_id: S.peer, include_hr: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.hr_id, S.hrbp);
  const row = (await db.query(`SELECT include_hr, hr_id FROM pms.connects WHERE id=$1`, [r.body.id])).rows[0];
  assert.equal(row.include_hr, true);
  const seen = await api('/pms/connects', S.tok.hrbp);
  const cn = seen.body.connects.find((c) => c.id === r.body.id);
  assert.ok(cn, 'HR included can read the connect');
  assert.equal(cn.hr_name, 'Oct HRBP');
  const n = (await db.query(`SELECT count(*)::int n FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind='connect_hr_included'`,
    [S.t, S.hrbp])).rows[0].n;
  assert.ok(n >= 1, 'and is told');

  const pick = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-03', include_hr: true, hr_id: S.hr });
  assert.equal(pick.body.hr_id, S.hr, 'an explicit pick is honoured');
  const bad = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-03', include_hr: true, hr_id: S.peer });
  assert.equal(bad.status, 422, 'only someone holding an HR role');
  const no = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-03', include_hr: false, hr_id: S.hr });
  assert.equal(no.body.hr_id, null, 'no means no HR, whatever else is sent');
});

test('KRAs IN REVIEW: editable in mid-year and annual review only, same KRAs, weights to 100, audited', { skip }, async () => {
  const body = (w1, w2, extra = {}) => ({ kras: [
    { id: S.k1, title: 'Delivery predictability', measures: '95% sprint scope', weight: w1, ...extra },
    { id: S.k2, title: 'Quality', measures: '< 1 escaped defect', weight: w2 },
  ] });

  await setPhase('kra_open');
  let g = await api(`/pms/review/kras/${S.emp}`, S.tok.emp);
  assert.equal(g.body.editable, false, 'not in KRA setting — the normal sheet rules apply there');
  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.emp, body(50, 50))).status, 409);

  await setPhase('mid_year_review');
  g = await api(`/pms/review/kras/${S.emp}`, S.tok.emp);
  assert.equal(g.body.editable, true);
  assert.equal(g.body.kras.length, 2);
  const r = await put(`/pms/review/kras/${S.emp}`, S.tok.emp, body(50, 50));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k1 = r.body.kras.find((k) => k.id === S.k1);
  assert.equal(k1.title, 'Delivery predictability');
  assert.equal(k1.measures, '95% sprint scope');
  assert.equal(Number(k1.weight), 50);
  assert.equal((await db.query(`SELECT status FROM pms.kra_sheets WHERE id=$1`, [S.sheet])).rows[0].status, 'approved', 'the sheet stays approved');
  const a = (await db.query(`SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_EDITED_IN_REVIEW' ORDER BY id DESC LIMIT 1`, [S.t])).rows[0];
  assert.ok(a && a.details.changes.some((c) => c.field === 'weight' && c.from === '60' && c.to === '50'), 'field-by-field audit');

  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.emp, body(50, 40))).status, 422, 'weights must total 100');
  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.emp, { kras: [{ id: S.k1, title: 'x', weight: 100 }] })).status, 422, 'no removing a KRA');
  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.emp, { kras: [...body(40, 40).kras, { title: 'New', weight: 20 }] })).status, 422, 'no adding one');

  await setPhase('manager_eval');
  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.mgr, body(70, 30))).status, 200, 'the manager, in the annual review');
  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.peer, body(70, 30))).status, 403, 'not a colleague');
  await setPhase('hod_eval');
  assert.equal((await put(`/pms/review/kras/${S.emp}`, S.tok.mgr, body(60, 40))).status, 409, 'closed once the HOD has it');
  await setPhase('kra_open');
});

test('FINAL RATING: annual review, then manager, HOD, HR — withheld from the employee until published', { skip }, async () => {
  await setPhase('calibration');
  await db.query(`INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, status, overall_self_rating) VALUES ($1,$2,$3,'submitted',4)`, [S.t, S.cycle, S.emp]);
  await db.query(`INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, status, overall_rating) VALUES ($1,$2,$3,$4,'submitted',3)`, [S.t, S.cycle, S.emp, S.mgr]);
  await db.query(`INSERT INTO pms.hod_evaluations (tenant_id, cycle_id, employee_id, hod_id, status, overall_rating, comment) VALUES ($1,$2,$3,$4,'submitted',4,'Stronger than rated')`, [S.t, S.cycle, S.emp, S.hod]);
  await db.query(`INSERT INTO pms.rating_adjustments (tenant_id, cycle_id, employee_id, from_rating, to_rating, reason, adjusted_by) VALUES ($1,$2,$3,4,5,'Calibrated up','o-hr@x.com')`, [S.t, S.cycle, S.emp]);

  const mine = await api('/pms/my/annual-review', S.tok.emp);
  const ch = mine.body.rating_chain;
  assert.equal(ch.self.rating, 4, 'your own rating is always yours to see');
  assert.equal(ch.manager.withheld, true);
  assert.equal(ch.hod.withheld, true);
  assert.equal(ch.hr.withheld, true);
  assert.equal(ch.final.withheld, true);
  assert.equal(ch.manager.rating, undefined, 'no number leaks before publish');

  const team = await api(`/pms/team/annual-review/${S.emp}`, S.tok.mgr);
  const tc = team.body.rating_chain;
  assert.equal(tc.manager.rating, 3);
  assert.equal(tc.hod.rating, 4);
  assert.equal(tc.hod.comment, 'Stronger than rated');
  assert.equal(tc.hr.rating, 5);
  assert.equal(tc.hr.adjusted, true);
  assert.equal(tc.final.rating, 5, 'HR calibration, else HOD, else manager — the order publish uses');
  assert.equal(tc.final.published, false);

  await db.query(`INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating, rating_label) VALUES ($1,$2,$3,5,'Outstanding')`, [S.t, S.emp, S.cycle]);
  const after = await api('/pms/my/annual-review', S.tok.emp);
  assert.equal(after.body.rating_chain.manager.rating, 3, 'all of it after publish');
  assert.equal(after.body.rating_chain.final.rating, 5);
  assert.equal(after.body.rating_chain.final.published, true);
  await setPhase('kra_open');
});

test('PIP: the manager writes the concern, the targeted areas and the gates; the employee reads it', { skip }, async () => {
  const plan = {
    employee_id: S.peer,
    performance_description: 'Missed 3 of the last 4 sprint commitments; two escalations from the client.',
    target_areas: [{ area: 'Delivery predictability', expected: '90% of committed scope' }, { area: '' }],
    gates: [
      { title: '30-day review', due_date: '2026-11-10', success_measure: '2 sprints at 80%+' },
      { title: '60-day review', due_date: '2026-12-10', success_measure: '4 sprints at 90%' },
    ],
    start_date: '2026-10-10', end_date: '2026-12-31',
  };
  assert.equal((await post('/pms/pip', S.tok.peer, { ...plan, employee_id: S.peer })).status, 403, 'not for yourself');
  assert.equal((await post('/pms/pip', S.tok.fin, plan)).status, 403, 'not for someone else\'s report');
  assert.equal((await post('/pms/pip', S.tok.mgr, { ...plan, performance_description: ' ' })).status, 422, 'the concern is required');
  assert.equal((await post('/pms/pip', S.tok.mgr, { ...plan, target_areas: [] })).status, 422, 'an area is required');
  assert.equal((await post('/pms/pip', S.tok.mgr, { ...plan, gates: [] })).status, 422, 'a gate is required');
  assert.equal((await post('/pms/pip', S.tok.mgr, { ...plan, gates: [{ title: 'Late', due_date: '2027-03-01' }] })).status, 422, 'gates sit inside the plan');

  const r = await post('/pms/pip', S.tok.mgr, plan);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pip.target_areas.length, 1, 'blank areas are dropped');
  assert.equal(r.body.pip.gates.length, 2);
  assert.equal((await post('/pms/pip', S.tok.mgr, plan)).status, 409, 'one plan per person per cycle');

  const mine = await api(`/pms/pip/${r.body.id}`, S.tok.peer);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.can_edit, false, 'the employee reads it');
  assert.equal(mine.body.pip.performance_description, plan.performance_description);
  assert.equal((await put(`/pms/pip/${r.body.id}`, S.tok.peer, { performance_description: 'nope' })).status, 403);

  const gate = r.body.pip.gates[0];
  assert.equal((await post(`/pms/pip/${r.body.id}/gates/${gate.id}/review`, S.tok.mgr, { status: 'met' })).status, 422, 'a review says what was seen');
  const rv = await post(`/pms/pip/${r.body.id}/gates/${gate.id}/review`, S.tok.mgr, { status: 'met', review_note: '2 sprints at 85%' });
  assert.equal(rv.status, 200);
  assert.equal(rv.body.pip.gates[0].status, 'met');
  assert.equal(rv.body.pip.status, 'in_progress');

  const drop = await put(`/pms/pip/${r.body.id}`, S.tok.mgr, { gates: [{ id: r.body.pip.gates[1].id, title: '60-day review', due_date: '2026-12-10' }] });
  assert.equal(drop.status, 409, 'a reviewed gate stays on the plan');
  const edit = await put(`/pms/pip/${r.body.id}`, S.tok.mgr, {
    gates: [...rv.body.pip.gates.map((g) => ({ id: g.id, title: g.title, due_date: String(g.due_date).slice(0, 10) })), { title: 'Final review', due_date: '2026-12-30' }],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.pip.gates.length, 3);
  assert.equal(edit.body.pip.gates[0].status, 'met', 'the review survives an edit');

  const list = await api('/pms/pip', S.tok.mgr);
  const row = list.body.pips.find((p) => p.id === r.body.id);
  assert.equal(row.gates_total, 3);
  assert.equal(row.gates_met, 1);

  assert.equal((await put(`/pms/pip/${r.body.id}`, S.tok.mgr, { status: 'closed_successful', closed_reason: 'Improved' })).status, 200);
  assert.equal((await put(`/pms/pip/${r.body.id}`, S.tok.mgr, { performance_description: 'late edit' })).status, 409, 'a closed plan is a record');
});

test('HOD TEAM COMPETENCIES: every employee in the departments they head, by department', { skip }, async () => {
  const all = await api('/pms/competencies/hod', S.tok.hod);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.departments, ['Delivery']);
  const ids = all.body.team.map((x) => x.employee_id);
  assert.ok(ids.includes(S.emp) && ids.includes(S.peer) && ids.includes(S.mgr), 'not only direct reports');
  assert.ok(!ids.includes(S.fin), 'not another department');
  assert.ok(!ids.includes(S.gone), 'not someone inactive');
  assert.equal(all.body.department_summary[0].department, 'Delivery');

  assert.equal((await api('/pms/competencies/hod?department=Finance', S.tok.hod)).status, 403, 'not a department they head');
  assert.equal((await api(`/pms/competencies/hod/${S.fin}`, S.tok.hod)).status, 403);
  const one = await api(`/pms/competencies/hod/${S.emp}`, S.tok.hod);
  assert.equal(one.status, 200);
  assert.equal(one.body.editable, false, 'read-only — the rating is the manager\'s');

  const hr = await api('/pms/competencies/hod?department=Finance', S.tok.hr);
  assert.equal(hr.status, 200, 'HR sees every department');
  assert.deepEqual(hr.body.team.map((x) => x.employee_id), [S.fin]);
  assert.equal((await api('/pms/competencies/hod', S.tok.emp)).status, 403, 'needs pms_hod');

  const pages = (await db.query(`SELECT route, required_permission FROM core.page_permission WHERE tenant_id=$1 AND page IN ('hod_competencies','team_pip') ORDER BY page`, [S.t])).rows;
  assert.deepEqual(pages, [{ route: '/hod/competencies', required_permission: 'pms_hod' }, { route: '/team/pip', required_permission: 'pms_team_eval' }]);
});

test('CONNECTS: HR also means an HR department or designation, matched as a word', { skip }, async () => {
  const ins = async (name, email, dept, desig) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
     VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`, [S.t, name, email, dept, desig])).rows[0].id;
  const byDept = await ins('Oct People Ops', 'o-pops@x.com', 'Human Resources', 'Executive');
  const byDesig = await ins('Oct Head HR', 'o-headhr@x.com', 'Leadership', 'Head of HR');
  const notHr = await ins('Oct Chrome', 'o-chrome@x.com', 'Delivery', 'Chrome Engineer');
  const r = await api('/pms/connects/people', S.tok.emp);
  const ids = r.body.hr.map((h) => h.id);
  assert.ok(ids.includes(byDept), 'someone in the Human Resources department is HR');
  assert.ok(ids.includes(byDesig), 'a Head of HR in another department is HR');
  assert.ok(!ids.includes(notHr), '"hr" inside another word does not count');
  assert.equal(r.body.hr.find((h) => h.id === byDept).matched_by, 'department');
  assert.equal(ids[0], S.hrbp, 'role holders still come first');
  const ok = await post('/pms/connects', S.tok.emp, { employee_id: S.emp, held_at: '2026-10-04', include_hr: true, hr_id: byDesig });
  assert.equal(ok.status, 200, 'and can be picked');
  assert.equal(ok.body.hr_id, byDesig);
});
