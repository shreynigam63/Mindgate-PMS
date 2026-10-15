// node --test — Queries (15 Oct): title, the people it is raised to (told
// by email), description; People Hub shows what you raised and what was
// raised to you; HR's inbox is HR → Queries, and HR answers there.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-queries';
process.env.AUTH_DEV = 'true';
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
let db, server, base, tenantId;
const ids = {};

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('Q Co',$1) RETURNING id`, [`q-${Date.now()}`])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  await require('../migrations/096-queries').ensureQueryPages(db, tenantId);
  const hash = await bcrypt.hash('pass', 4);
  for (const [k, role] of [['emp', 'employee'], ['mgr', 'manager'], ['other', 'employee'], ['hr', 'hr'], ['gone', 'employee']]) {
    const email = `${k}@q.test`;
    ids[k] = (await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, `Q ${k}`, email, k === 'gone' ? 'inactive' : 'active'])).rows[0].id;
    await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, email, role]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [tenantId, email, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const tokens = {};
async function call(who, path, body) {
  if (!tokens[who]) {
    const r = await fetch(`${base}/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${who}@q.test`, password: 'pass' }) });
    tokens[who] = (await r.json()).token;
  }
  const r = await fetch(`${base}/people${path}`, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const notices = async (who, kind) => (await db.query(
  `SELECT title, body, link FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind=$3 ORDER BY created_at`, [tenantId, ids[who], kind])).rows;
let qid;

test('raise a query: title, whom to raise it to, description', { skip }, async () => {
  assert.match((await call('emp', '/queries', { to: [ids.mgr], description: 'x' })).body.error, /title/);
  assert.match((await call('emp', '/queries', { title: 'x', to: [ids.mgr] })).body.error, /Describe/);
  assert.match((await call('emp', '/queries', { title: 'x', description: 'y', to: [ids.emp] })).body.error, /yourself/);
  assert.match((await call('emp', '/queries', { title: 'x', description: 'y', to: [ids.gone] })).body.error, /active/);
  const r = await call('emp', '/queries', { title: 'My mid-year rating', to: [ids.mgr, ids.hr], description: 'Why was KRA 2 rated B?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  qid = r.body.query.id;
  assert.match(r.body.message, /Q mgr, Q hr|Q hr, Q mgr/);
  const m = await notices('mgr', 'query_raised');
  assert.equal(m.length, 1);
  assert.match(m[0].title, /raised a query: My mid-year rating/);
  assert.equal(m[0].link, '/people?tab=queries');
  assert.equal((await notices('hr', 'query_raised'))[0].link, '/admin/queries', 'HR answer from the HR tab');
  assert.equal((await notices('other', 'query_raised')).length, 0);
});

test('whom to raise it to: colleagues by name or email', { skip }, async () => {
  assert.deepEqual((await call('emp', '/queries/people?q=m')).body.people, [], 'two letters at least');
  const byEmail = (await call('emp', '/queries/people?q=mgr@q.test')).body.people;
  assert.deepEqual(byEmail.map((p) => p.id), [ids.mgr]);
  const all = (await call('emp', '/queries/people?q=q.test')).body.people.map((p) => p.id);
  assert.ok(!all.includes(ids.emp), 'not yourself');
  assert.ok(!all.includes(ids.gone), 'not someone who has left');
});

test('People Hub shows what you raised and what was raised to you; HR answers on the HR tab', { skip }, async () => {
  const emp = (await call('emp', '/queries')).body.queries;
  assert.equal(emp.length, 1);
  assert.equal(emp[0].mine, true);
  assert.equal(emp[0].title, 'My mid-year rating');
  assert.deepEqual(emp[0].raised_to.map((p) => p.name).sort(), ['Q hr', 'Q mgr']);
  const mgr = (await call('mgr', '/queries')).body.queries;
  assert.equal(mgr.length, 1);
  assert.equal(mgr[0].mine, false, 'raised to the manager');
  assert.equal((await call('other', '/queries')).body.queries.length, 0);
  const hrSelf = await call('hr', '/queries');
  assert.equal(hrSelf.body.queries.length, 0, "HR's People Hub does not repeat the HR inbox");
  assert.ok(hrSelf.body.admin);
  const inbox = (await call('hr', '/queries?view=all')).body.queries;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].to_me, true);
  assert.equal((await call('mgr', '/queries?view=all')).status, 403, 'the inbox is HR only');
});

test('the thread: who may read, answer and close it', { skip }, async () => {
  assert.equal((await call('other', `/queries/${qid}/messages`)).status, 403);
  const t = await call('mgr', `/queries/${qid}/messages`);
  assert.equal(t.status, 200);
  assert.equal(t.body.messages[0].body, 'Why was KRA 2 rated B?');
  assert.equal((await call('other', `/queries/${qid}/reply`, { body: 'hi' })).status, 403);

  assert.equal((await call('mgr', `/queries/${qid}/reply`, { body: 'Two deliverables slipped.' })).status, 200);
  let q = (await call('emp', '/queries')).body.queries[0];
  assert.equal(q.status, 'answered');
  const told = await notices('emp', 'query_reply');
  assert.match(told[0].title, /Reply on your query/);
  assert.equal(told[0].link, '/people?tab=queries');

  await call('emp', `/queries/${qid}/reply`, { body: 'One was blocked by the client.' });
  q = (await call('emp', '/queries')).body.queries[0];
  assert.equal(q.status, 'open', "the raiser's reply waits on an answer again");
  assert.equal((await notices('mgr', 'query_reply')).length, 1);

  assert.equal((await call('hr', `/queries/${qid}/close`, {})).status, 200);
  assert.equal((await call('emp', '/queries')).body.queries[0].status, 'closed');
  assert.equal((await call('emp', `/queries/${qid}/reply`, { body: 'more' })).status, 409);
  assert.equal((await call('emp', `/queries/${qid}/close`, {})).status, 409);
  assert.equal((await notices('emp', 'query_closed')).length, 1);
});

test('nobody named: the query goes to HR', { skip }, async () => {
  const r = await call('other', '/queries', { subject: 'Payslip', body: 'Old form still works' });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /HR/);
  const inbox = (await call('hr', '/queries?view=all&status=open')).body.queries;
  const q = inbox.find((x) => x.id === r.body.query.id);
  assert.equal(q.to_hr, true);
  assert.deepEqual(q.raised_to, []);
  assert.equal((await call('hr', `/queries/${q.id}/messages`)).status, 200, 'HR reads every query');
});
