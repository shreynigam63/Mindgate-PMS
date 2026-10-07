// node --test — three fixes asked for on 8 Oct, on My Growth.
//
// 1. "long term goals will be editable till manager evaluation, it should
//    be locked once advanced to HOD cycle".
// 2. The Career Pathing Matrix said "Band 6", the employee master said
//    "E3 · Band 6", and the employee was told their path did not match
//    their level — the same rung written two ways.
// 3. Long-Term reads the matrix more than one rung ahead, and each tab's
//    milestones stay on that tab.
process.env.AUTH_DEV = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'career-level-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { levelMatches, parseLevel } = require('../modules/people/career-level');
const pm = require('../modules/performance/phase-machine');

test('a level is read as grade and band, so the same rung matches however it is written', () => {
  assert.deepEqual([parseLevel('E3 · Band 6').grade, parseLevel('E3 · Band 6').band], ['e3', '6']);
  assert.equal(levelMatches('Band 6', 'E3 · Band 6'), true, 'the matrix\'s "Band 6" fits an E3 at Band 6');
  assert.equal(levelMatches('E3', 'E3 · Band 6'), true);
  assert.equal(levelMatches('E3 · Band 6', 'E3 - band 6'), true, 'punctuation and case do not matter');
  assert.equal(levelMatches('E3 · Band 6', 'Band 6'), true, 'a band-only record fits a row naming that band');
  assert.equal(levelMatches('E2 · Band 6', 'E3 · Band 6'), false, 'E2 is not E3, though both are Band 6');
  assert.equal(levelMatches('Band 7', 'E3 · Band 6'), false);
  assert.equal(levelMatches('', 'anything'), true, 'blank means any level');
  assert.equal(levelMatches('Band 6', null), false, 'a level-specific row does not match someone with no band');
  assert.equal(levelMatches('Senior', 'senior'), true, 'text with no grade or band still matches exactly');
  assert.equal(levelMatches('Senior', 'Junior'), false);
});

test('LONG-TERM stays open through Manager Evaluation and locks at HOD Review; Short-Term is unchanged', () => {
  const lt = (phase) => pm.aspirationEditable(phase, { horizon: 'long_term', sheetStatus: 'approved' });
  const st = (phase) => pm.aspirationEditable(phase, { horizon: 'short_term', sheetStatus: 'approved' });
  for (const p of ['kra_open', 'mid_year_review', 'self_appraisal', 'manager_eval']) assert.equal(lt(p).ok, true, `long-term open in ${p}`);
  for (const p of ['hod_eval', 'calibration', 'publish', 'closed']) {
    assert.equal(lt(p).ok, false, `long-term locked in ${p}`);
    assert.equal(lt(p).reason, 'long_term_closed');
  }
  assert.equal(pm.aspirationEditable('hod_eval', { horizon: 'long_term', planStatus: 'returned' }).ok, false,
    'a returned plan does not reopen long-term past Manager Evaluation');
  assert.equal(st('self_appraisal').ok, true);
  assert.equal(st('manager_eval').ok, false, 'short-term keeps its own window');
  assert.equal(pm.aspirationEditable('kra_open', { horizon: 'long_term', sheetStatus: 'draft' }).reason, 'kra_not_submitted',
    'long-term still opens on the KRA submission, like short-term');
});

// ---- over HTTP, against a real database -----------------------------------
const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db; let server; let base; let tenantId; let tok; let cycleId; let empId;
const SLUG = `clvl-test-${Date.now()}`;
const api = async (method, path, body) => {
  const r = await fetch(`${base}/api/v1/people${path}`, { method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};
const phase = (p) => db.query(`UPDATE pms.cycles SET phase=$2 WHERE id=$1`, [cycleId, p]);

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const express = require('express');
  const bcrypt = require('bcryptjs');
  await require('../core/migrate').runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug,name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  empId = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,role_band)
     VALUES ($1,'Arun P','arun@x.com','active','Software Developer','Development','E3 · Band 6') RETURNING id`, [tenantId])).rows[0].id;
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'arun@x.com','employee')`, [tenantId]);
  await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'employee','pms_self'),($1,'employee','people_view') ON CONFLICT DO NOTHING`, [tenantId]);
  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase,cycle_type) VALUES ($1,'T','FY26-27','kra_open','annual') RETURNING id`, [tenantId])).rows[0].id;
  await db.query(`INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'approved')`, [tenantId, cycleId, empId]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'arun@x.com',$2)`, [tenantId, await bcrypt.hash('pw', 4)]);
  // The matrix as the screenshot had it: the same move written for four
  // departments, all saying just "Band 6"; then the next rung up.
  for (const dept of ['Development', 'QA', 'Support', null]) {
    await db.query(
      `INSERT INTO people.career_transitions (tenant_id, department, from_role, from_level, to_role, to_level, typical_time_months, required_competencies, active)
       VALUES ($1,$2,'Software Developer','Band 6','Senior Software Developer','Band 7',24,$3,true)`,
      [tenantId, dept, dept === 'Development' ? ['Code review', 'Estimation'] : ['Generic']]);
  }
  await db.query(
    `INSERT INTO people.career_transitions (tenant_id, from_role, from_level, to_role, to_level, typical_time_months, required_competencies, active)
     VALUES ($1,'Senior Software Developer','E4 · Band 7','Tech Lead','E5 · Band 8',30,$2,true)`, [tenantId, ['Mentoring']]);
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', require('../core/auth').devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  app.use('/api/v1/agentic', require('../modules/agentic').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await (await fetch(`${base}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'arun@x.com', password: 'pw' }) })).json()).token;
});

after(async () => {
  if (!HAS_DB || !db) return;
  if (server) await new Promise((r) => server.close(r));
  for (const t of ['people.career_milestones', 'people.career_paths', 'people.career_transitions', 'pms.kra_sheets', 'pms.cycles',
    'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  }
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});

test('"BAND 6" ON THE MATRIX MATCHES "E3 · BAND 6" ON THE MASTER — and the move is offered once, the department\'s own', { skip }, async () => {
  await phase('kra_open');
  const r = await api('GET', '/career/my-path');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.eligible_target_roles, ['Senior Software Developer']);
  assert.equal(r.body.path_diagnostics, null, 'no "does not match your level" any more');
  const { eligibleTransitionsFor } = require('../modules/people');
  const t = await eligibleTransitionsFor(tenantId, empId);
  assert.equal(t.length, 1, 'four departments\' copies of one move are one move');
  assert.deepEqual(t[0].required_competencies, ['Code review', 'Estimation'], 'their own department\'s version wins');
});

test('LONG-TERM looks further along the matrix — each step still a row HR wrote', { skip }, async () => {
  const r = await api('GET', '/career/my-path?horizon=long_term');
  assert.deepEqual([...r.body.eligible_target_roles].sort(), ['Senior Software Developer', 'Tech Lead']);
  assert.equal((await api('PUT', '/career/my-path', { horizon: 'long_term', target_role: 'Tech Lead' })).status, 200);
  assert.equal((await api('PUT', '/career/my-path', { horizon: 'short_term', target_role: 'Tech Lead' })).status, 422,
    'two rungs up is not a short-term move');
  const { targetsFor } = require('../modules/people');
  const lead = (await targetsFor(tenantId, empId, 'long_term')).find((x) => x.to_role === 'Tech Lead');
  assert.equal(lead.steps, 2);
  assert.equal(lead.typical_time_months, 54, 'the two steps\' times add up');
  assert.deepEqual(lead.via, ['Senior Software Developer']);
});

test('EACH TAB KEEPS ITS OWN MILESTONES', { skip }, async () => {
  await api('PUT', '/career/my-path', { horizon: 'short_term', target_role: 'Senior Software Developer' });
  assert.equal((await api('PUT', '/career/my-milestones', { horizon: 'long_term', milestones: [{ title: 'Lead a design review', target_date: '2027-06-30' }] })).status, 200);
  assert.equal((await api('PUT', '/career/my-milestones', { horizon: 'short_term', milestones: [{ title: 'Own estimation for a sprint', target_date: '2026-12-31' }] })).status, 200);
  const lt = await api('GET', '/career/my-path?horizon=long_term');
  const st = await api('GET', '/career/my-path?horizon=short_term');
  assert.deepEqual(lt.body.milestones.map((m) => m.title), ['Lead a design review']);
  assert.deepEqual(st.body.milestones.map((m) => m.title), ['Own estimation for a sprint']);
});

test('MANAGER EVALUATION: long-term still editable, short-term not; HOD REVIEW: both locked', { skip }, async () => {
  await phase('manager_eval');
  const lt = await api('GET', '/career/my-path?horizon=long_term');
  assert.equal(lt.body.editable, true);
  assert.equal((await api('PUT', '/career/my-path', { horizon: 'long_term', target_role: 'Tech Lead', plan: 'Lead the next release' })).status, 200);
  assert.equal((await api('PUT', '/career/my-milestones', { horizon: 'long_term', milestones: [{ title: 'Mentor two juniors', target_date: '2027-03-31' }] })).status, 200);
  assert.equal((await api('GET', '/career/my-path?horizon=short_term')).body.editable, false);
  assert.equal((await api('PUT', '/career/my-path', { horizon: 'short_term', target_role: 'Senior Software Developer' })).status, 409);

  await phase('hod_eval');
  const locked = await api('GET', '/career/my-path?horizon=long_term');
  assert.equal(locked.body.editable, false);
  assert.equal(locked.body.shut_because, 'long_term_closed');
  const refused = await api('PUT', '/career/my-path', { horizon: 'long_term', target_role: 'Tech Lead' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /locked — the cycle has moved on to HOD Review/);
  assert.equal((await api('PUT', '/career/my-milestones', { horizon: 'long_term', milestones: [] })).status, 409);
});

test('THE AI STARTS FROM WHAT IS ON THE FORM — unsaved, and on the tab being looked at', { skip }, async () => {
  await phase('manager_eval');
  const ai = require('../core/ai');
  const real = ai.narrate;
  let seen = null;
  ai.narrate = async (args) => { seen = args; return { draft: { aspirations: [], no_path_configured: false } }; };
  try {
    const r = await fetch(`${base}/api/v1/agentic/career-suggest`, { method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizon: 'long_term', draft: { target_role: 'Tech Lead', years_experience: '9',
        skills_interests: 'System design, mentoring', plan: '' } }) });
    assert.equal(r.status, 200);
    const input = seen.input;
    assert.match(input.horizon, /^long_term/);
    assert.equal(input.current_aspiration.target_role, 'Tech Lead', 'what is typed, not yet saved');
    assert.equal(input.self_reported.years_experience, 9);
    assert.equal(input.self_reported.skills_and_interests, 'System design, mentoring');
    assert.equal(input.current_aspiration.plan, 'Lead the next release', 'a blank field falls back to what was saved on that tab');
    assert.deepEqual(input.configured_transitions.map((t) => t.to_role).sort(), ['Senior Software Developer', 'Tech Lead']);
    assert.match(seen.system, /START FROM WHAT THE EMPLOYEE HAS WRITTEN/);
  } finally { ai.narrate = real; }
});

test('LONG-TERM BUILDS ON THE SHORT-TERM GOAL: it is sent, its blanks are filled from it, and the next rung is marked', { skip }, async () => {
  await db.query(`UPDATE people.career_paths SET years_experience=6, skills_interests='Estimation, APIs'
                   WHERE tenant_id=$1 AND employee_id=$2 AND horizon='short_term'`, [tenantId, empId]);
  const tab = await api('GET', '/career/my-path?horizon=long_term');
  assert.equal(tab.body.short_term_goal.target_role, 'Senior Software Developer', 'the tab shows what it builds on');
  assert.equal(Number(tab.body.short_term_goal.years_experience), 6);
  assert.equal((await api('GET', '/career/my-path?horizon=short_term')).body.short_term_goal, null);

  const ai = require('../core/ai');
  const real = ai.narrate;
  let seen = null;
  ai.narrate = async (args) => { seen = args; return { draft: { aspirations: [] } }; };
  try {
    await fetch(`${base}/api/v1/agentic/career-suggest`, { method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ horizon: 'long_term', draft: { target_role: '', years_experience: '', skills_interests: '', plan: '' } }) });
    const input = seen.input;
    assert.equal(input.short_term_goal.target_role, 'Senior Software Developer');
    assert.deepEqual(input.short_term_goal.milestones.map((m) => m.title), ['Own estimation for a sprint']);
    assert.equal(input.self_reported.years_experience, 6, 'blank on Long-Term — taken from Short-Term');
    assert.equal(input.self_reported.skills_and_interests, 'Estimation, APIs');
    const lead = input.configured_transitions.find((t) => t.to_role === 'Tech Lead');
    assert.equal(lead.builds_on_short_term_goal, true, 'Tech Lead comes after the short-term Senior Software Developer');
    assert.equal(input.configured_transitions.find((t) => t.to_role === 'Senior Software Developer').builds_on_short_term_goal, false);
    assert.match(seen.system, /LONG-TERM BUILDS ON SHORT-TERM/);
  } finally { ai.narrate = real; }
});
