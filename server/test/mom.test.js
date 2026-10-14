// node --test — the MoM tab, part 1, against the client's build
// specification (14 Oct). Real Postgres, real HTTP surface; skips cleanly
// without DATABASE_URL.
//
// One team (Mgr with A1 and A2) switched on, a second (Mgr2 with R3) left
// off, and an outsider. The clock is driven by calling tick() with fixed
// India times in March 2027:
//   Mon 1   the first connect: created, reminded, written, published, revised
//   Tue 2   the next connect carries the open items forward
//   Wed 3   no MoM by 6 pm: Missing; an item falls due
//   Thu 4   the item is overdue
//   Fri 5   a holiday: no connect
//   Sat 6   no connect; the item is three days overdue: the manager is told
process.env.TZ = 'Asia/Kolkata';
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, mom;
const id = {};
const tok = {};
const meeting = {};

const call = async (method, path, who, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = (path, who) => call('GET', path, who);
const at = (s) => new Date(`${s}+05:30`);
const notes = async (who, kind) => (await db.query(
  `SELECT title, body, link FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind=$3 ORDER BY created_at`,
  [tenantId, id[who], kind])).rows;
const meetingOn = async (date) => (await db.query(
  `SELECT * FROM pms.mom_meetings WHERE tenant_id=$1 AND meeting_date=$2`, [tenantId, date])).rows;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mom';
  process.env.TENANT_SLUG = 'mom-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  mom = require('../modules/performance/mom');

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  const mk = async (key, name, managerId) => {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status, date_of_joining, location, designation)
       VALUES ($1,$2,$3,'Engineering',$4,'active','2020-01-01','Pune','Engineer') RETURNING id`,
      [t.id, name, `mom-${key}@x.com`, managerId || null])).rows[0].id;
  };
  await mk('hr', 'MoM HR');
  await mk('mgr', 'MoM Mgr');
  await mk('mgr2', 'MoM Mgr2');
  await mk('out', 'MoM Outsider');
  await mk('a1', 'MoM A1', id.mgr);
  await mk('a2', 'MoM A2', id.mgr);
  await mk('r3', 'MoM R3', id.mgr2);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'mom-hr@x.com','hr'),($1,'mom-mgr@x.com','manager'),($1,'mom-mgr2@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 4);
  const who = ['hr', 'mgr', 'mgr2', 'out', 'a1', 'a2'];
  for (const k of who) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, `mom-${k}@x.com`, hash]);
  }
  // Friday 5 March 2027 is a holiday on HR's calendar.
  await db.query(`INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'timesheet',$2::jsonb)
                  ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`, [t.id, JSON.stringify({ holidays: ['2027-03-05'] })]);

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const k of who) {
    tok[k] = (await (await fetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `mom-${k}@x.com`, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('rules: Meet links, working days, what publishing needs, what a revision changed', { skip: !HAS_DB && skip }, () => {
  assert.strictEqual(mom.meetLink('https://meet.google.com/ABC-defg-hij?authuser=0'), 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(mom.meetLink('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij');
  for (const bad of ['http://meet.google.com/abc-defg-hij', 'https://zoom.us/j/123', 'https://meet.google.com/abcdefghij', '', null]) {
    assert.strictEqual(mom.meetLink(bad), null, String(bad));
  }
  assert.strictEqual(mom.isWorkingDay('2027-03-01'), true);
  assert.strictEqual(mom.isWorkingDay('2027-03-06'), false);
  assert.strictEqual(mom.isWorkingDay('2027-03-07'), false);
  assert.strictEqual(mom.isWorkingDay('2027-03-05', ['2027-03-05']), false);
  const p = mom.publishProblems({ discussion: [' '], action_items: [{ task: 'X' }] });
  assert.deepStrictEqual(p, ['Add at least one discussion point.', 'Action item 1 ("X") has no owner.', 'Action item 1 ("X") has no due date.']);
  assert.deepStrictEqual(mom.publishProblems({ discussion: ['a'], action_items: [{ task: 'X', owner_id: 'u', due_date: '2027-01-01' }] }), []);
  const v = { summary: 's', discussion: ['a'], decisions: [], blockers: [], attendance: {}, start_time: '10:00', end_time: '10:30', action_items: [] };
  assert.deepStrictEqual(mom.changedSections(v, { ...v, decisions: ['d'], end_time: '10:40' }), ['decisions', 'times']);
});

test('team settings: a valid Meet link, only HR switches a team on, attendees from the team', { skip }, async () => {
  let r = await call('PUT', `/pms/mom/teams/${id.mgr}`, 'mgr', { meet_link: 'https://zoom.us/j/1' });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error, 'Enter a valid Google Meet link');
  r = await call('PUT', `/pms/mom/teams/${id.mgr}`, 'mgr', { meet_link: 'https://meet.google.com/abc-defg-hij', enabled: true });
  assert.strictEqual(r.status, 422, 'a manager cannot switch daily connects on');
  r = await call('PUT', `/pms/mom/teams/${id.mgr}`, 'mgr', { attendee_ids: [id.r3] });
  assert.strictEqual(r.status, 422, 'attendees come from the manager\'s reports');
  r = await call('PUT', `/pms/mom/teams/${id.mgr}`, 'mgr2', { meet_link: 'https://meet.google.com/abc-defg-hij' });
  assert.strictEqual(r.status, 403);
  r = await call('PUT', `/pms/mom/teams/${id.out}`, 'hr', { meet_link: 'https://meet.google.com/abc-defg-hij' });
  assert.strictEqual(r.status, 409, 'no reports, no team');

  r = await call('PUT', `/pms/mom/teams/${id.mgr}`, 'mgr', { meet_link: 'https://meet.google.com/ABC-defg-hij?authuser=1', daily_time: '10:00', duration_min: 30 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.team.meet_link, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(r.body.team.enabled, false);

  r = await call('PUT', `/pms/mom/teams/${id.mgr2}`, 'hr', { enabled: true });
  assert.strictEqual(r.status, 422, 'no link, no daily connects');
  assert.match(r.body.error, /Google Meet link/);

  // Switched on by HR — but no connect is made yet for the dates under
  // test (the switch makes today's, whatever today is).
  r = await call('PUT', `/pms/mom/teams/${id.mgr}`, 'hr', { enabled: true });
  assert.strictEqual(r.status, 200);
  const audit = (await db.query(`SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='MOM_TEAM_UPDATED' ORDER BY id`, [tenantId])).rows;
  assert.strictEqual(audit.length, 2);
  assert.strictEqual(audit[1].details.after.enabled, true);

  r = await get('/pms/mom/teams', 'mgr');
  assert.deepStrictEqual(r.body.teams.map((x) => x.manager_id), [id.mgr], 'a manager sees their own team');
  assert.strictEqual(r.body.hr, false);
  r = await get('/pms/mom/teams', 'hr');
  assert.deepStrictEqual(new Set(r.body.teams.map((x) => x.manager_id)), new Set([id.mgr, id.mgr2]));
  assert.strictEqual(r.body.without_link, 1);
  r = await get('/pms/mom/teams', 'a1');
  assert.strictEqual(r.body.teams.length, 0);
  assert.strictEqual(r.body.can_manage, false);
  r = await get(`/pms/mom/teams/${id.mgr}/reports`, 'a1');
  assert.strictEqual(r.status, 403);
});

test('daily connects: working days only, one a day, a reminder 15 minutes before', { skip }, async () => {
  let out = await mom.tick(tenantId, at('2027-03-06T10:00:00'));
  assert.strictEqual(out.created, 0, 'Saturday');
  out = await mom.tick(tenantId, at('2027-03-05T08:00:00'));
  assert.strictEqual(out.created, 0, 'a holiday');
  assert.strictEqual((await meetingOn('2027-03-05')).length, 0);

  out = await mom.tick(tenantId, at('2027-03-01T08:00:00'));
  assert.strictEqual(out.created, 1, 'only the switched-on team');
  out = await mom.tick(tenantId, at('2027-03-01T08:05:00'));
  assert.strictEqual(out.created, 0, 'one a day');
  const [m] = await meetingOn('2027-03-01');
  meeting.d1 = m.id;
  assert.strictEqual(m.organiser_id, id.mgr);
  assert.deepStrictEqual(new Set(m.attendee_ids), new Set([id.a1, id.a2]));
  assert.strictEqual(m.start_time, '10:00');
  assert.strictEqual(m.end_time, '10:30');
  assert.strictEqual(m.meet_link, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(m.status, 'scheduled');

  out = await mom.tick(tenantId, at('2027-03-01T09:40:00'));
  assert.strictEqual(out.reminded, 0, '20 minutes before is too early');
  out = await mom.tick(tenantId, at('2027-03-01T09:46:00'));
  assert.strictEqual(out.reminded, 1);
  out = await mom.tick(tenantId, at('2027-03-01T09:51:00'));
  assert.strictEqual(out.reminded, 0, 'once');
  for (const k of ['mgr', 'a1', 'a2']) {
    const n = await notes(k, 'mom_reminder');
    assert.strictEqual(n.length, 1, k);
    assert.match(n[0].body, /meet\.google\.com\/abc-defg-hij/);
  }
  assert.strictEqual((await notes('out', 'mom_reminder')).length, 0);
});

test('a draft is the organiser\'s and HR\'s until it is published', { skip }, async () => {
  let r = await get(`/pms/mom/meetings/${meeting.d1}`, 'out');
  assert.strictEqual(r.status, 403);
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr2');
  assert.strictEqual(r.status, 403);
  r = await call('PUT', `/pms/mom/meetings/${meeting.d1}/minutes`, 'mgr', {
    summary: 'Draft summary', discussion: ['Sprint status'], decisions: [], blockers: [{ issue: 'VPN', help_from: 'IT' }],
    attendance: { [id.a1]: 'present', [id.a2]: 'absent' },
    action_items: [{ task: 'Fix login', owner_id: id.a1, due_date: '2027-03-03', priority: 'high' }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `/pms/mom/meetings/${meeting.d1}/minutes`, 'a1', { discussion: ['x'] });
  assert.strictEqual(r.status, 403, 'an attendee does not write the MoM');

  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.minutes, null, 'the attendee does not see the draft');
  assert.deepStrictEqual(r.body.action_items, []);
  assert.strictEqual(r.body.draft_exists, true);
  assert.strictEqual(r.body.can_edit, false);
  assert.strictEqual(r.body.can_ack, false);
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'hr');
  assert.strictEqual(r.body.minutes.summary, 'Draft summary');
  assert.strictEqual(r.body.can_edit, true);
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr');
  assert.strictEqual(r.body.action_items.length, 1);
  assert.ok(r.body.people.some((p) => p.id === id.a1), 'the owner list has the team');

  r = await get('/pms/mom/action-items?scope=mine', 'a1');
  assert.strictEqual(r.body.items.length, 0, 'a draft\'s items are not tasks yet');
});

test('publish: needs a discussion point and every item\'s owner and due date; then attendees are told', { skip }, async () => {
  let r = await call('POST', `/pms/mom/meetings/${meeting.d1}/publish`, 'mgr', {
    discussion: [], action_items: [{ task: 'Docs', owner_id: null, due_date: null }],
  });
  assert.strictEqual(r.status, 422);
  assert.deepStrictEqual(r.body.errors, ['Add at least one discussion point.', 'Action item 1 ("Docs") has no owner.', 'Action item 1 ("Docs") has no due date.']);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/publish`, 'mgr', {
    discussion: ['x'], action_items: [{ task: 'Docs', owner_id: '00000000-0000-0000-0000-000000000000', due_date: '2027-02-30x' }],
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.errors.length, 2, 'an unknown owner and a bad date');

  const cur = (await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr')).body;
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/publish`, 'mgr', {
    summary: 'Sprint 12 kick-off', discussion: ['Sprint status', 'Release plan'], decisions: [],
    blockers: [{ issue: 'VPN', help_from: 'IT' }], attendance: { [id.a1]: 'present', [id.a2]: 'absent' },
    start_time: '10:02', end_time: '10:31',
    action_items: [
      { id: cur.action_items[0].id, task: 'Fix login', owner_id: id.a1, due_date: '2027-03-03', priority: 'high' },
      { task: 'Docs', owner_id: id.a2, due_date: '2027-03-01', priority: 'low' },
    ],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.version, 1);
  const [m] = await meetingOn('2027-03-01');
  assert.strictEqual(m.status, 'published');
  assert.strictEqual(m.start_time, '10:02');
  const items = (await db.query(`SELECT task, id FROM pms.mom_action_items WHERE tenant_id=$1 ORDER BY created_at`, [tenantId])).rows;
  assert.deepStrictEqual(items.map((x) => x.task), ['Fix login', 'Docs'], 'the draft\'s item kept, not duplicated');
  meeting.fix = items[0].id;
  meeting.docs = items[1].id;

  for (const k of ['a1', 'a2']) assert.strictEqual((await notes(k, 'mom_published')).length, 1, k);
  assert.strictEqual((await notes('mgr', 'mom_published')).length, 0, 'not the organiser who published');
  assert.match((await notes('a1', 'mom_action_assigned'))[0].title, /1 action item for you/);
  assert.match((await notes('a1', 'mom_published'))[0].link, new RegExp(`tab=mom&mom=${meeting.d1}`));
  const audit = (await db.query(`SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='MOM_PUBLISHED'`, [tenantId])).rows;
  assert.strictEqual(audit.length, 1);

  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/publish`, 'mgr', { discussion: ['x'] });
  assert.strictEqual(r.status, 409);
  r = await call('PUT', `/pms/mom/meetings/${meeting.d1}/minutes`, 'mgr', { discussion: ['x'] });
  assert.strictEqual(r.status, 409, 'after publish a change is a revision');

  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.body.minutes.summary, 'Sprint 12 kick-off');
  assert.strictEqual(r.body.action_items.length, 2);
  assert.strictEqual(r.body.can_ack, true);
});

test('acknowledge, and a revision is a new version with what changed', { skip }, async () => {
  let r = await call('POST', `/pms/mom/meetings/${meeting.d1}/acknowledge`, 'out', {});
  assert.strictEqual(r.status, 403);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/acknowledge`, 'a1', { comment: 'I was 5 minutes late' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await notes('mgr', 'mom_ack_comment')).length, 1);
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr');
  assert.deepStrictEqual(r.body.pending_acks.map((p) => p.id), [id.a2]);
  assert.strictEqual(r.body.acks.length, 1);
  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.body.can_ack, false);
  assert.strictEqual(r.body.my_ack.comment, 'I was 5 minutes late');

  const cur = (await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr')).body;
  const body = {
    summary: cur.minutes.summary, discussion: cur.minutes.discussion, decisions: cur.minutes.decisions,
    blockers: cur.minutes.blockers, attendance: cur.minutes.attendance,
    action_items: cur.action_items.map((a) => ({ id: a.id, task: a.task, owner_id: a.owner_id, due_date: a.due_date, priority: a.priority })),
  };
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/revise`, 'mgr', body);
  assert.strictEqual(r.status, 409, 'nothing changed');

  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/revise`, 'mgr', {
    ...body, decisions: ['Ship on Friday'], action_items: [...body.action_items, { task: 'Temp', owner_id: id.a1, due_date: '2027-03-10' }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.version, 2);
  assert.deepStrictEqual(r.body.changed, ['decisions', 'action_items']);
  assert.match((await notes('a2', 'mom_revised'))[0].body, /decisions, action_items/);

  const after2 = (await get(`/pms/mom/meetings/${meeting.d1}`, 'mgr')).body;
  const temp = after2.action_items.find((a) => a.task === 'Temp');
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/revise`, 'hr', {
    ...body, decisions: ['Ship on Friday'],
  });
  assert.strictEqual(r.status, 200, 'HR edits any MoM');
  assert.strictEqual(r.body.version, 3);
  assert.deepStrictEqual(r.body.changed, ['action_items']);
  const t = (await db.query(`SELECT status, closed_by FROM pms.mom_action_items WHERE id=$1`, [temp.id])).rows[0];
  assert.deepStrictEqual(t, { status: 'cancelled', closed_by: 'mom-hr@x.com' }, 'a removed item is cancelled, not deleted');

  r = await get(`/pms/mom/meetings/${meeting.d1}`, 'a1');
  assert.strictEqual(r.body.can_ack, true, 'a new version is acknowledged again');
  assert.strictEqual(r.body.my_ack, null);
  assert.deepStrictEqual(r.body.versions.map((v) => v.version), [1, 2, 3]);
  r = await get(`/pms/mom/meetings/${meeting.d1}/versions/1`, 'a1');
  assert.deepStrictEqual(r.body.version.snapshot.decisions, [], 'v1 stays readable as it was');
  assert.strictEqual(r.body.version.snapshot.action_items.length, 2);
  r = await get(`/pms/mom/meetings/${meeting.d1}/versions/1`, 'out');
  assert.strictEqual(r.status, 403);
});

test('carried forward: open items appear in the team\'s next MoM until done', { skip }, async () => {
  const out = await mom.tick(tenantId, at('2027-03-02T08:00:00'));
  assert.strictEqual(out.created, 1);
  assert.strictEqual(out.missing, 0, 'the published connect is not missing');
  const [m2] = await meetingOn('2027-03-02');
  meeting.d2 = m2.id;
  let r = await get(`/pms/mom/meetings/${meeting.d2}`, 'mgr');
  assert.deepStrictEqual(r.body.carried_forward.map((a) => a.task), ['Docs', 'Fix login']);

  // The owner updates their own item; nobody else on the team does.
  r = await call('PUT', `/pms/mom/action-items/${meeting.docs}`, 'a1', { status: 'done' });
  assert.strictEqual(r.status, 403);
  r = await call('PUT', `/pms/mom/action-items/${meeting.docs}`, 'mgr2', { status: 'done' });
  assert.strictEqual(r.status, 403);
  r = await call('PUT', `/pms/mom/action-items/${meeting.docs}`, 'a2', { status: 'finished' });
  assert.strictEqual(r.status, 422);
  r = await call('PUT', `/pms/mom/action-items/${meeting.docs}`, 'a2', { status: 'done' });
  assert.strictEqual(r.status, 200);

  r = await get(`/pms/mom/meetings/${meeting.d2}`, 'mgr');
  assert.deepStrictEqual(r.body.carried_forward.map((a) => a.task), ['Fix login']);
  r = await call('POST', `/pms/mom/meetings/${meeting.d2}/publish`, 'mgr', { discussion: ['Login fix in review'] });
  assert.strictEqual(r.status, 200);
  r = await get(`/pms/mom/meetings/${meeting.d2}`, 'a1');
  assert.deepStrictEqual(r.body.minutes.carried_forward_snapshot.map((a) => a.task), ['Fix login'], 'frozen at publish');
  const fix = (await db.query(`SELECT carried_forward_count FROM pms.mom_action_items WHERE id=$1`, [meeting.fix])).rows[0];
  assert.strictEqual(fix.carried_forward_count, 1);
});

test('6 pm: no MoM is Missing; items due, overdue, and three days overdue to the manager', { skip }, async () => {
  let out = await mom.tick(tenantId, at('2027-03-03T08:00:00'));
  assert.strictEqual(out.created, 1);
  assert.strictEqual(out.due, 0, 'before 9 am');
  out = await mom.tick(tenantId, at('2027-03-03T17:59:00'));
  assert.strictEqual(out.missing, 0);
  assert.strictEqual(out.due, 1, 'Fix login is due today');
  assert.strictEqual((await notes('a1', 'mom_action_due')).length, 1);
  out = await mom.tick(tenantId, at('2027-03-03T18:00:00'));
  assert.strictEqual(out.missing, 1);
  assert.strictEqual(out.due, 0, 'once');
  const [m3] = await meetingOn('2027-03-03');
  meeting.d3 = m3.id;
  assert.strictEqual(m3.status, 'missing');
  assert.ok((await notes('mgr', 'mom_missing')).some((n) => /2027-03-03/.test(n.title)));

  out = await mom.tick(tenantId, at('2027-03-04T09:30:00'));
  assert.strictEqual(out.created, 1);
  assert.strictEqual(out.overdue, 1);
  assert.strictEqual(out.escalated, 0, 'one day overdue');
  const [m4] = await meetingOn('2027-03-04');
  meeting.d4 = m4.id;

  out = await mom.tick(tenantId, at('2027-03-05T09:30:00'));
  assert.strictEqual(out.created, 0, 'the holiday');
  assert.strictEqual(out.missing, 1, 'Thursday\'s connect, caught up the next day');
  out = await mom.tick(tenantId, at('2027-03-06T09:30:00'));
  assert.strictEqual(out.created, 0);
  assert.strictEqual(out.overdue, 0, 'the owner was told once');
  assert.strictEqual(out.escalated, 1);
  const esc = await notes('mgr', 'mom_action_overdue_manager');
  assert.strictEqual(esc.length, 1);
  assert.match(esc[0].title, /MoM A1: action item 3 days overdue/);
  out = await mom.tick(tenantId, at('2027-03-08T09:30:00'));
  assert.strictEqual(out.escalated, 0, 'once');

  // A Missing MoM can still be written by hand and published.
  let r = await call('POST', `/pms/mom/meetings/${meeting.d3}/publish`, 'mgr', { discussion: ['Written up late'] });
  assert.strictEqual(r.status, 200);
});

test('a connect not held, the lists, and HR\'s daily report', { skip }, async () => {
  let r = await call('POST', `/pms/mom/meetings/${meeting.d4}/cancel`, 'mgr', { reason: '' });
  assert.strictEqual(r.status, 422);
  r = await call('POST', `/pms/mom/meetings/${meeting.d4}/cancel`, 'a1', { reason: 'x' });
  assert.strictEqual(r.status, 403);
  r = await call('POST', `/pms/mom/meetings/${meeting.d4}/cancel`, 'mgr', { reason: 'Team offsite' });
  assert.strictEqual(r.status, 200);
  r = await call('PUT', `/pms/mom/meetings/${meeting.d4}/minutes`, 'mgr', { discussion: ['x'] });
  assert.strictEqual(r.status, 409);
  r = await call('POST', `/pms/mom/meetings/${meeting.d1}/cancel`, 'mgr', { reason: 'x' });
  assert.strictEqual(r.status, 409, 'a published MoM was held');

  r = await get('/pms/mom/meetings?from=2027-03-01&to=2027-03-31', 'a1');
  assert.strictEqual(r.body.meetings.length, 5);
  const d1 = r.body.meetings.find((m) => m.id === meeting.d1);
  assert.strictEqual(d1.version, 3);
  assert.strictEqual(d1.acknowledged, false);
  r = await get('/pms/mom/meetings?from=2027-03-01&to=2027-03-31&status=missing', 'mgr');
  assert.strictEqual(r.body.meetings.length, 0, 'the missing one was written up');
  r = await get('/pms/mom/meetings?from=2027-03-01&to=2027-03-31', 'out');
  assert.strictEqual(r.body.meetings.length, 0);
  r = await get('/pms/mom/meetings?from=2027-03-01&to=2027-03-31', 'hr');
  assert.strictEqual(r.body.meetings.length, 5);
  assert.deepStrictEqual(r.body.managers.map((m) => m.manager_id), [id.mgr]);

  r = await get('/pms/mom/action-items?scope=mine', 'a1');
  assert.deepStrictEqual(r.body.items.map((a) => a.task), ['Fix login']);
  assert.strictEqual(r.body.items[0].can_update, true);
  r = await get('/pms/mom/action-items?scope=team&status=any', 'mgr');
  assert.deepStrictEqual(r.body.items.map((a) => a.task).sort(), ['Docs', 'Fix login', 'Temp']);
  r = await get('/pms/mom/action-items?scope=all', 'mgr');
  assert.strictEqual(r.status, 403);
  r = await get('/pms/mom/action-items?scope=all&status=any', 'hr');
  assert.strictEqual(r.body.items.length, 3);

  r = await get('/pms/mom/compliance?date=2027-03-01', 'mgr');
  assert.strictEqual(r.status, 403);
  r = await get('/pms/mom/compliance?date=2027-03-04', 'hr');
  assert.strictEqual(r.body.working_day, true);
  assert.deepStrictEqual(r.body.totals, { teams: 1, published: 0, missing: 0, scheduled: 0, cancelled: 1 });
  r = await get('/pms/mom/compliance?date=2027-03-02', 'hr');
  assert.strictEqual(r.body.totals.published, 1);
  assert.strictEqual(r.body.teams[0].open_items, 1);
  r = await get('/pms/mom/compliance?date=2027-03-05', 'hr');
  assert.strictEqual(r.body.working_day, false);
  assert.strictEqual(r.body.teams[0].status, null);
});
