// node --test — Connects, 15 Oct: the discussion sorted by AI with no
// typing, Team Connects for the manager, the Delivery Head's whole
// reporting line, the HRBP's remit and HR, and training suggestions from
// connects. Real Postgres and HTTP; the AI is a stand-in for
// api.anthropic.com. Skips cleanly without DATABASE_URL.
//
//   HOD ── Mgr ── A1, A2          (Pune)
//    └─── B1                       (Mumbai)
//   Out: nobody's report; HRBP: remit = Pune; HR
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId;
const id = {};
const tok = {};
const cid = {};

let aiReply = null;
const aiCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.anthropic.com')) {
    aiCalls.push(JSON.parse(opts.body));
    if (aiReply === 'down') return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 });
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(aiReply) }], stop_reason: 'end_turn', usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
const call = async (method, p, who, body) => {
  const r = await realFetch(`${base}${p}`, {
    method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = (p, who) => call('GET', p, who);
async function sorted(connectId) {
  for (let i = 0; i < 200; i++) {
    const r = (await db.query(`SELECT ai_status FROM pms.connects WHERE id=$1`, [connectId])).rows[0];
    if (!['pending', 'working'].includes(r.ai_status)) return r.ai_status;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('still sorting');
}

before(async () => {
  if (!HAS_DB) return;
  process.env.ANTHROPIC_API_KEY = 'test-key-for-the-stand-in';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tc';
  process.env.TENANT_SLUG = 'tc-test-' + Date.now();
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
  const mk = async (key, name, managerId, location = 'Pune') => {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, department, manager_id, status, date_of_joining, location, designation)
       VALUES ($1,$2,$3,'Engineering',$4,'active','2020-01-01',$5,'Engineer') RETURNING id`,
      [t.id, name, `tc-${key}@x.com`, managerId || null, location])).rows[0].id;
  };
  await mk('hr', 'TC HR', null, 'Delhi');
  await mk('hrbp', 'TC HRBP', null, 'Delhi');
  await mk('hod', 'TC HOD', null, 'Delhi');
  await mk('mgr', 'TC Mgr', id.hod);
  await mk('a1', 'TC A1', id.mgr);
  await mk('a2', 'TC A2', id.mgr);
  await mk('b1', 'TC B1', id.hod, 'Mumbai');
  await mk('out', 'TC Out', null, 'Mumbai');
  const roles = { hr: 'hr', hrbp: 'hrbp', hod: 'hod', mgr: 'manager' };
  for (const [k, role] of Object.entries(roles)) await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)`, [t.id, `tc-${k}@x.com`, role]);
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id, email, kind, value) VALUES ($1,'tc-hrbp@x.com','location','Pune')`, [t.id]);
  const hash = await bcrypt.hash('pass', 4);
  const who = Object.keys(id);
  for (const k of who) await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, `tc-${k}@x.com`, hash]);
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  for (const k of who) {
    tok[k] = (await (await realFetch(`${base}/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `tc-${k}@x.com`, password: 'pass' }),
    })).json()).token;
  }
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
  globalThis.fetch = realFetch;
});

test('the discussion is sorted by AI after the save — nothing typed into the three parts', { skip }, async () => {
  aiReply = { achievements: ['Shipped the login fix'], blockers: ['Staging VPN keeps dropping — needs IT'], feedback: ['Write smaller pull requests'] };
  let r = await call('POST', '/pms/connects', 'a1', { employee_id: id.a1, held_at: '2026-10-10', topic: 'Sprint check-in',
    discussion_notes: 'I shipped the login fix. The staging VPN keeps dropping and I need IT. Manager asked for smaller PRs.', with_id: id.mgr });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  cid.a1 = r.body.id;
  assert.strictEqual(await sorted(cid.a1), 'done');
  const cn = (await db.query(`SELECT achievements, blockers, feedback, ai_categorised_at FROM pms.connects WHERE id=$1`, [cid.a1])).rows[0];
  assert.deepStrictEqual([cn.achievements, cn.blockers, cn.feedback],
    ['- Shipped the login fix', '- Staging VPN keeps dropping — needs IT', '- Write smaller pull requests']);
  assert.ok(cn.ai_categorised_at);
  const sent = aiCalls[aiCalls.length - 1].messages[0].content;
  assert.match(sent, /Sprint check-in/);
  assert.match(sent, /staging VPN keeps dropping/);
  const note = (await db.query(`SELECT link FROM core.notifications WHERE employee_id=$1 AND kind='connect_logged_by_report'`, [id.mgr])).rows[0];
  assert.strictEqual(note.link, '/team/team-connects', 'their manager finds it under Team Connects');

  // A caller that sends the parts itself keeps them; nothing to sort.
  r = await call('POST', '/pms/connects', 'mgr', { employee_id: id.a2, held_at: '2026-10-11', discussion_notes: 'Quick sync', achievements: 'Typed by hand' });
  cid.a2 = r.body.id;
  const typed = (await db.query(`SELECT achievements, ai_status FROM pms.connects WHERE id=$1`, [cid.a2])).rows[0];
  assert.deepStrictEqual(typed, { achievements: 'Typed by hand', ai_status: null });
});

test('a failed sort is shown and can be tried again; the discussion is kept as written', { skip }, async () => {
  aiReply = 'down';
  let r = await call('POST', '/pms/connects', 'mgr', { employee_id: id.a1, held_at: '2026-10-12', discussion_notes: 'Talked about the export report and a course on SQL.' });
  const c = r.body.id;
  assert.strictEqual(await sorted(c), 'failed');
  r = await get('/pms/connects?view=team&scope=manager', 'mgr');
  const row = r.body.connects.find((x) => x.id === c);
  assert.ok(row.ai_error);
  assert.strictEqual(row.discussion_notes, 'Talked about the export report and a course on SQL.');
  aiReply = { achievements: [], blockers: [], feedback: ['Take an SQL course'] };
  r = await call('POST', `/pms/connects/${c}/categorise`, 'out', {});
  assert.strictEqual(r.status, 403);
  r = await call('POST', `/pms/connects/${c}/categorise`, 'mgr', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ai_status, 'done');
  assert.deepStrictEqual([r.body.achievements, r.body.feedback], [null, '- Take an SQL course'], 'an empty part stays empty');
});

test('Self shows your own connects; your reports\' move to Team Connects', { skip }, async () => {
  // A2 logs a connect with A1, a colleague — A1 signs it off from Self.
  const r0 = await call('POST', '/pms/connects', 'a2', { employee_id: id.a2, held_at: '2026-10-13', discussion_notes: 'Pairing on the export', with_id: id.a1 });
  cid.pair = r0.body.id;
  await sorted(cid.pair).catch(() => {});
  let r = await get('/pms/connects?view=self', 'a1');
  assert.deepStrictEqual(new Set(r.body.connects.map((c) => c.id)), new Set([cid.a1, cid.pair].concat(
    (await db.query(`SELECT id FROM pms.connects WHERE employee_id=$1 AND id<>$2`, [id.a1, cid.a1])).rows.map((x) => x.id))));
  r = await get('/pms/connects?view=self', 'mgr');
  assert.strictEqual(r.body.connects.length, 0, 'the manager\'s Self tab holds none of the reports\' connects');

  r = await get('/pms/connects?view=team&scope=manager', 'mgr');
  assert.ok(r.body.connects.every((c) => [id.a1, id.a2].includes(c.employee_id)));
  assert.ok(r.body.connects.some((c) => c.id === cid.pair), 'a report\'s connect with anyone is the team\'s');
  r = await get(`/pms/connects?view=team&scope=manager&employee_id=${id.a2}`, 'mgr');
  assert.ok(r.body.connects.every((c) => c.employee_id === id.a2));
  r = await get('/pms/connects?view=team&scope=manager', 'a1');
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.needs, 'pms_team_eval');
});

test('Team Connects: the HOD sees the whole reporting line, the HRBP the remit, HR everyone', { skip }, async () => {
  const b1 = (await call('POST', '/pms/connects', 'hod', { employee_id: id.b1, held_at: '2026-10-14', discussion_notes: 'Quarterly chat' })).body.id;
  const out = (await call('POST', '/pms/connects', 'out', { employee_id: id.out, held_at: '2026-10-14', discussion_notes: 'Mine', with_id: id.hr })).body.id;
  const ids = async (who, scope) => new Set((await get(`/pms/connects?view=team&scope=${scope}`, who)).body.connects.map((c) => c.employee_id));
  assert.deepStrictEqual(await ids('hod', 'hod'), new Set([id.a1, id.a2, id.b1]), 'reports of reports included; the HOD\'s own connects not');
  assert.deepStrictEqual(await ids('hrbp', 'hrbp'), new Set([id.a1, id.a2]), 'Pune only');
  assert.deepStrictEqual(await ids('hr', 'hr'), new Set([id.a1, id.a2, id.b1, id.out]));
  assert.strictEqual((await get('/pms/connects?view=team&scope=hr', 'hod')).status, 403);
  assert.strictEqual((await get('/pms/connects?view=team&scope=hod', 'mgr')).status, 403);
  assert.strictEqual((await get('/pms/connects?view=team&scope=nonsense', 'hr')).status, 400);
  assert.ok(b1 && out);
});

test('training suggestions come from the person\'s connects, for them or whoever looks after them', { skip }, async () => {
  aiReply = { themes: ['Unstable staging environment'], trainings: [
    { title: 'SQL for analysts', type: 'course', why: 'Asked for in the 12 Oct connect', from: ['2026-10-12', 'soon'], priority: 'high' },
    { title: 'Pairing with a senior on PR reviews', type: 'buddy', why: 'Smaller PRs', priority: 'urgent' },
    { title: '' },
  ], notes: [] };
  let r = await call('POST', '/pms/connects/training-suggestions', 'mgr', { employee_id: id.a1 });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.trainings.map((x) => [x.title, x.type, x.priority, x.from]), [
    ['SQL for analysts', 'course', 'high', ['2026-10-12']],
    ['Pairing with a senior on PR reviews', 'course', 'medium', []],
  ]);
  assert.ok(r.body.connects_used === 2, 'both of A1\'s connects');
  const input = aiCalls[aiCalls.length - 1].messages[0].content;
  assert.match(input, /Take an SQL course/);
  assert.match(aiCalls[aiCalls.length - 1].system, /Never rate or judge/);
  assert.strictEqual((await call('POST', '/pms/connects/training-suggestions', 'a1', {})).status, 200, 'for yourself');
  assert.strictEqual((await call('POST', '/pms/connects/training-suggestions', 'hod', { employee_id: id.a1 })).status, 200, 'the HOD, two levels up');
  assert.strictEqual((await call('POST', '/pms/connects/training-suggestions', 'out', { employee_id: id.a1 })).status, 403);
  assert.strictEqual((await call('POST', '/pms/connects/training-suggestions', 'hrbp', { employee_id: id.b1 })).status, 403, 'outside the remit');
  r = await call('POST', '/pms/connects/training-suggestions', 'hr', { employee_id: id.hrbp });
  assert.strictEqual(r.status, 422);
  assert.match(r.body.error, /No connects are logged/);
});
