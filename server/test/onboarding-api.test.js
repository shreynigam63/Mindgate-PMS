// node --test — the First-Week Journey over HTTP, as HR and as an HRBP.
//
// What has to hold:
//   - a joiner is picked from the employee master and gets exactly one
//     task per active activity (the workbook had 55 rows for 48);
//   - planned dates, statuses and the dashboard are computed for the
//     Report Date asked for, the way the workbook did;
//   - an HRBP sees and touches only joiners in their remit — including in
//     the COUNTS, which the gateway cannot filter for them;
//   - holidays are company-wide, so an HRBP cannot change them.
//
// Real Postgres; skips without DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
const SLUG = `onb-test-${Date.now()}`;

let db, server, base, tenantId, hrTok, hrbpTok, empTok;
const ids = {};

const req = async (method, path, tok, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-onboarding';
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  // The tenant is created AFTER migrations ran, which is exactly the
  // fresh-install case — the boot-time seed is what gives it a matrix.
  await require('../migrations/081-onboarding').seedFor(db, tenantId);

  const mk = async (key, name, location, doj, managerId = null) => {
    ids[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id,name,email,status,department,designation,location,date_of_joining,manager_id)
       VALUES ($1,$2,$3,'active','Finance','Executive',$4,$5,$6) RETURNING id`,
      [tenantId, name, `${key}@onb.x`, location, doj, managerId])).rows[0].id;
  };
  await mk('mgr', 'Anil Desai', 'Pune', '2015-01-01');
  await mk('pune', 'Riya Sharma', 'Pune', '2026-09-24', ids.mgr);
  await mk('mum', 'Kunal Joshi', 'Mumbai', '2026-09-25');
  await mk('nodoj', 'No Date', 'Pune', null);
  await mk('hr', 'The HR', null, '2010-01-01');
  await mk('partner', 'The Partner', null, '2012-01-01');
  await mk('emp', 'Plain Employee', 'Pune', '2020-01-01');

  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'hr@onb.x','hr'),($1,'partner@onb.x','hrbp')`, [tenantId]);
  for (const p of ['pms_hrbp', 'pms_self']) {
    await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,'hrbp',$2) ON CONFLICT DO NOTHING`, [tenantId, p]);
  }
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'partner@onb.x','location','Pune','test')`, [tenantId]);
  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['hr@onb.x', 'partner@onb.x', 'emp@onb.x']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  require('../modules/performance');   // registers the HRBP gateway
  app.use('/api/v1/people', require('../modules/people').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/v1/people/onboarding`;
  const login = async (email) => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw' }),
  })).json()).token;
  hrTok = await login('hr@onb.x'); hrbpTok = await login('partner@onb.x'); empTok = await login('emp@onb.x');
  assert.ok(hrTok && hrbpTok && empTok, 'all three logins have to work');
});

after(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise((r) => server.close(r));
  for (const t of ['people.onboarding_task_emails', 'people.onboarding_spocs', 'core.notif_log', 'people.onboarding_feedback', 'people.onboarding_tasks', 'people.onboarding_joiners',
    'people.onboarding_activities', 'people.onboarding_days', 'people.onboarding_feedback_questions',
    'people.onboarding_holidays', 'core.audit_log', 'core.hrbp_scope', 'core.local_credentials', 'core.user_roles',
    'core.role_permissions', 'core.user_permissions', 'core.employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  }
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});

test('the seed is the workbook, and running it again changes nothing', { skip }, async () => {
  const n = async (t) => (await db.query(`SELECT count(*)::int n FROM people.${t} WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  assert.equal(await n('onboarding_activities'), 48);
  assert.equal(await n('onboarding_days'), 8);
  assert.equal(await n('onboarding_feedback_questions'), 7);
  assert.equal(await n('onboarding_holidays'), 3);
  await require('../migrations/081-onboarding').seedFor(db, tenantId);
  assert.equal(await n('onboarding_activities'), 48);
});

test('somebody without New Hire Insights is refused, and told what they lack', { skip }, async () => {
  const r = await req('GET', '/', empTok);
  assert.equal(r.status, 403);
  assert.equal(r.body.needs, 'onboarding_ops');
});

test('HR starts a joiner from the master: one task per activity, dated from the DOJ', { skip }, async () => {
  const c = await req('GET', '/candidates', hrTok);
  assert.equal(c.status, 200);
  const r = await req('POST', '/joiners', hrTok, { employee_id: ids.pune, buddy_id: ids.emp });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.tasks, 48, 'forty-eight, not the workbook\'s fifty-five');
  ids.puneJoiner = r.body.id;

  const again = await req('POST', '/joiners', hrTok, { employee_id: ids.pune });
  assert.equal(again.status, 409, 'a joiner is on the tracker once');
  const nodoj = await req('POST', '/joiners', hrTok, { employee_id: ids.nodoj });
  assert.equal(nodoj.status, 400);
  assert.match(nodoj.body.error, /no date of joining/);
  const stranger = await req('POST', '/joiners', hrTok, { employee_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(stranger.status, 400);

  const w = await req('GET', `/joiners/${ids.puneJoiner}?asOf=2026-10-06`, hrTok);
  assert.equal(w.status, 200);
  const j = w.body.joiner;
  assert.equal(j.manager_name, 'Anil Desai', 'manager comes from the master, not retyped');
  assert.equal(j.buddy_name, 'Plain Employee');
  assert.equal(j.day7_date, '2026-10-05');
  assert.equal(j.current_day, 'After Day 7');
  const intimation = j.tasks.find((t) => t.code === 1);
  assert.equal(intimation.day, 'Pre-Day 1');
  assert.equal(intimation.planned_date, '2026-09-22');
  assert.equal(j.tasks.find((t) => t.code === 48).planned_date, '2026-10-05');
  assert.equal(j.overdue, 48);
  assert.equal(j.status, '48 overdue');
  assert.equal(w.body.questions.length, 7);
});

test('marking work done moves the joiner, the day and the dashboard', { skip }, async () => {
  const w = (await req('GET', `/joiners/${ids.puneJoiner}?asOf=2026-10-06`, hrTok)).body.joiner;
  const pre = w.tasks.filter((t) => t.day === 'Pre-Day 1').map((t) => t.id);
  const done = await req('POST', `/joiners/${ids.puneJoiner}/complete`, hrTok, { task_ids: pre, completed_on: '2026-09-22' });
  assert.equal(done.body.updated, 6);

  const future = await req('PATCH', `/tasks/${w.tasks[10].id}`, hrTok, { completed_on: '2999-01-01' });
  assert.equal(future.status, 400, 'nothing is completed in the future');
  const issue = await req('PATCH', `/tasks/${w.tasks[10].id}`, hrTok, { issue: 'VPN not issued', action_owner: 'IT' });
  assert.equal(issue.status, 200);

  const d = (await req('GET', '/?asOf=2026-10-06', hrTok)).body;
  assert.equal(d.kpis.in_onboarding, 1);
  assert.equal(d.kpis.overdue, 42);
  assert.equal(d.kpis.open_issues, 1);
  assert.equal(d.by_day.find((x) => x.day === 'Pre-Day 1').pct, 100);
  const hr = d.by_owner.find((o) => o.owner === 'HR');
  assert.ok(hr && hr.completed >= 6, 'the six readiness rows are HR\'s');
  assert.ok(d.by_owner.find((o) => o.owner === 'IT'), 'a shared "HR Ops → IT" row counts for IT too');
  assert.equal(d.joiners[0].tasks, undefined, 'the list does not carry every task');
});

test('Day-7 feedback is 1 to 5 per statement and averaged', { skip }, async () => {
  const bad = await req('PUT', `/joiners/${ids.puneJoiner}/feedback`, hrTok, { ratings: { Q1: 7 } });
  assert.equal(bad.status, 400);
  const ok = await req('PUT', `/joiners/${ids.puneJoiner}/feedback`, hrTok, {
    feedback_date: '2026-10-05', ratings: { Q1: 5, Q2: 4, Q3: 4, Q4: 5, Q5: 4, Q6: 5, Q7: 4 }, worked_best: 'Buddy support',
  });
  assert.equal(ok.status, 200);
  const d = (await req('GET', '/?asOf=2026-10-06', hrTok)).body;
  assert.equal(d.kpis.feedback_avg, 4.43, 'the workbook\'s 4.4286, to two places');
});

test('an HRBP sees only their remit — in the list AND in the counts', { skip }, async () => {
  const mum = await req('POST', '/joiners', hrTok, { employee_id: ids.mum });
  assert.equal(mum.status, 201);
  ids.mumJoiner = mum.body.id;

  const hr = (await req('GET', '/?asOf=2026-10-06', hrTok)).body;
  assert.equal(hr.joiners.length, 2);

  const p = await req('GET', '/?asOf=2026-10-06', hrbpTok);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.joiners.map((j) => j.name), ['Riya Sharma']);
  assert.equal(p.body.kpis.in_onboarding, 1, 'the Mumbai joiner is not counted for a Pune partner');
  assert.equal(p.body.kpis.overdue, 42, 'nor are their 48 overdue tasks');

  assert.equal((await req('GET', `/joiners/${ids.mumJoiner}`, hrbpTok)).status, 404);
  const task = (await db.query(`SELECT id FROM people.onboarding_tasks WHERE joiner_id=$1 LIMIT 1`, [ids.mumJoiner])).rows[0].id;
  assert.equal((await req('PATCH', `/tasks/${task}`, hrbpTok, { remarks: 'x' })).status, 403);
  assert.equal((await req('POST', '/joiners', hrbpTok, { employee_id: ids.mum })).status, 403);

  const own = (await db.query(`SELECT id FROM people.onboarding_tasks WHERE joiner_id=$1 LIMIT 1`, [ids.puneJoiner])).rows[0].id;
  assert.equal((await req('PATCH', `/tasks/${own}`, hrbpTok, { remarks: 'Welcomed' })).status, 200, 'their own joiner they can work');

  const cands = (await req('GET', '/candidates', hrbpTok)).body.candidates || [];
  assert.ok(!cands.some((c) => c.employee_id === ids.mum));
});

test('holidays are company-wide: HR moves every plan, an HRBP cannot', { skip }, async () => {
  assert.equal((await req('POST', '/holidays', hrbpTok, { date: '2026-09-25', name: 'X' })).status, 403);
  assert.equal((await req('POST', '/holidays', hrTok, { date: '2026-09-25', name: 'Office closed' })).status, 200);
  const j = (await req('GET', `/joiners/${ids.puneJoiner}?asOf=2026-10-06`, hrTok)).body.joiner;
  assert.equal(j.day7_date, '2026-10-06', 'one more holiday in the week pushes Day 7 by a working day');
  assert.equal((await req('DELETE', '/holidays/2026-09-25', hrTok)).body.removed, 1);
});

test('taking a joiner off removes their tasks and feedback, and is audited', { skip }, async () => {
  assert.equal((await req('DELETE', `/joiners/${ids.mumJoiner}`, hrTok)).status, 200);
  const left = (await db.query(`SELECT count(*)::int n FROM people.onboarding_tasks WHERE joiner_id=$1`, [ids.mumJoiner])).rows[0].n;
  assert.equal(left, 0);
  const a = (await db.query(`SELECT count(*)::int n FROM core.audit_log WHERE tenant_id=$1 AND entity='onboarding' AND action='onboarding_remove'`, [tenantId])).rows[0].n;
  assert.equal(a, 1);
});

test('A TASK EMAIL GOES TO THE JOINER, FROM THE SPOC WHO OWNS THE ACTIVITY', { skip }, async () => {
  // Corrected on 7 Oct: "1st week onboarding mails should be shooted to new
  // joiner from certain spoc persons owning the certain activity".
  await require('../migrations/082-onboarding-spocs').ensureSpocRoles(db, tenantId);
  await require('../migrations/083-onboarding-senders').ensureSenders(db, tenantId);
  const w = (await req('GET', `/joiners/${ids.puneJoiner}?asOf=2026-10-06`, hrTok)).body.joiner;
  const byCode = (c) => w.tasks.find((t) => t.code === c);

  // Manager Connect (13): from the joiner's manager, to the joiner.
  const mgr = await req('GET', `/tasks/${byCode(13).id}/email`, hrTok);
  assert.equal(mgr.status, 200, JSON.stringify(mgr.body));
  assert.equal(mgr.body.from.email, 'mgr@onb.x');
  assert.equal(mgr.body.to.email, 'pune@onb.x', 'the joiner, at their company address after joining');
  assert.match(mgr.body.body, /^Dear Riya,/);
  assert.match(mgr.body.body, /Regards,\nAnil Desai \(Manager\)/);

  // Intimation Mail (1): the Recruiter's, before joining.
  const rec = await req('GET', `/tasks/${byCode(1).id}/email`, hrTok);
  assert.match(rec.body.from.missing, /No Recruiter SPOC email is set/);
  assert.equal((await req('POST', `/tasks/${byCode(1).id}/email`, hrTok, { subject: 's', body: 'b' })).status, 400,
    'nothing is sent with no sender');
  assert.equal((await req('PUT', '/spocs/Recruiter', hrbpTok, { email: 'r@onb.x' })).status, 403, 'the SPOC list is HR\'s');
  assert.equal((await req('PUT', '/spocs/Recruiter', hrTok, { email: 'not-an-address' })).status, 400);
  assert.equal((await req('PUT', '/spocs/Recruiter', hrTok, { name: 'Bhawana M', email: 'recruiter@onb.x' })).status, 200);

  // Before joining, a personal address wins when HR has one.
  assert.equal((await req('PATCH', `/joiners/${ids.puneJoiner}`, hrTok, { personal_email: 'riya.personal@mail.x' })).status, 200);
  const pre = await req('GET', `/tasks/${byCode(1).id}/email`, hrTok);
  assert.equal(pre.body.from.email, 'recruiter@onb.x');
  assert.equal(pre.body.to.email, 'riya.personal@mail.x', 'Pre-Day 1 goes to the personal address');
  assert.equal((await req('GET', `/tasks/${byCode(13).id}/email`, hrTok)).body.to.email, 'pune@onb.x',
    'after joining it is the company address again');

  // "HR Ops → IT": HR Ops owns it, so HR Ops writes to the joiner.
  assert.equal((await req('GET', `/tasks/${byCode(4).id}/email`, hrTok)).body.from.role, 'HR Ops');

  const sent = await req('POST', `/tasks/${byCode(1).id}/email`, hrTok, { subject: 'Welcome', body: 'Dear Riya, <b>see you</b>' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.to, 'riya.personal@mail.x');
  assert.equal(sent.body.from, 'recruiter@onb.x');
  assert.equal(sent.body.mode, 'simulated', 'the product default until HR turns live mail on');
  const log = (await db.query(`SELECT to_email FROM core.notif_log WHERE tenant_id=$1 AND kind='onboarding_task'`, [tenantId])).rows;
  assert.deepEqual(log.map((x) => x.to_email), ['riya.personal@mail.x']);
  const again = (await req('GET', `/joiners/${ids.puneJoiner}?asOf=2026-10-06`, hrTok)).body.joiner;
  assert.equal(again.tasks.find((t) => t.code === 1).last_emailed_from, 'recruiter@onb.x');
});

test('THE TICK IS HR OPS\', HR\'S AND HRBP\'S — not anybody who can open the page', { skip }, async () => {
  // "Checkbox … should be managed by HR Ops team and accessible to HRBP and HRs."
  const bcrypt = require('bcryptjs');
  const ops = (await db.query(
    `INSERT INTO core.employees (tenant_id,name,email,status,location) VALUES ($1,'Ops Person','ops@onb.x','active','Mumbai') RETURNING id`,
    [tenantId])).rows[0].id;
  void ops;
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'ops@onb.x','hr_ops')`, [tenantId]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'ops@onb.x',$2)`, [tenantId, await bcrypt.hash('pw', 4)]);
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  const opsTok = (await (await fetch(`${base.replace('/api/v1/people/onboarding', '')}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ops@onb.x', password: 'pw' }),
  })).json()).token;

  const w = (await req('GET', `/joiners/${ids.puneJoiner}`, opsTok));
  assert.equal(w.status, 200, `HR Ops opens the tracker — ${JSON.stringify(w.body)} perms=${JSON.stringify((await db.query(`SELECT permission FROM core.role_permissions WHERE tenant_id=$1 AND role='hr_ops'`, [tenantId])).rows)}`);
  assert.equal(w.body.can_operate, true);
  const t = w.body.joiner.tasks.find((x) => !x.completed_on);
  const a1 = await req('PATCH', `/tasks/${t.id}`, opsTok, { completed_on: '2026-10-01' });
  assert.equal(a1.status, 200, `HR Ops ticks it — ${JSON.stringify(a1.body)}`);
  const a2 = await req('PATCH', `/tasks/${t.id}`, hrbpTok, { completed_on: null });
  assert.equal(a2.status, 200, `an HRBP may too, in their remit — ${JSON.stringify(a2.body)}`);
  assert.equal((await req('PATCH', `/tasks/${t.id}`, hrTok, { completed_on: '2026-10-01' })).status, 200, 'and HR');

  // Somebody holding only New Hire Insights' permission reads the tracker
  // but cannot tick it.
  // (A grant to the person, not a role: a login token carries the role it
  // was issued with, while person grants are read on every request.)
  await db.query(`INSERT INTO core.user_permissions (tenant_id,email,permission) VALUES ($1,'emp@onb.x','engagement_admin')`, [tenantId]);
  const v = await req('GET', `/joiners/${ids.puneJoiner}`, empTok);
  assert.equal(v.status, 200);
  assert.equal(v.body.can_operate, false);
  const no = await req('PATCH', `/tasks/${t.id}`, empTok, { completed_on: '2026-10-02' });
  assert.equal(no.status, 403);
  assert.equal(no.body.needs, 'onboarding_ops');
  assert.equal((await req('POST', `/joiners/${ids.puneJoiner}/complete`, empTok, { task_ids: [t.id] })).status, 403);
  assert.equal((await req('PATCH', `/tasks/${t.id}`, empTok, { remarks: 'noted' })).status, 200, 'remarks are not the tick');
  await db.query(`DELETE FROM core.user_permissions WHERE tenant_id=$1 AND email='emp@onb.x'`, [tenantId]);
});
