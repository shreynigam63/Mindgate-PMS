// HR's Events & CSR page (13 Oct: "apart from awards, there is no option
// for HR to start Events from HR Admin tab ... linked with People Hub").
// What HR schedules is what People Hub shows; HR alone schedules it.
process.env.AUTH_DEV = 'true';
// The deploy's own zone (docker-compose sets TZ=Asia/Kolkata). A DATE read
// as local midnight here is the day before in UTC, which is how a CSR
// date used to slip back a day on every save (found by review, 13 Oct).
process.env.TZ = 'Asia/Kolkata';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'events-admin-test';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db; let server; let base; let tenantId;
const tok = {};
const id = {};

const call = async (who, path, opts = {}) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    ...opts, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};
const send = (who, method, path, body) => call(who, path, { method, body: JSON.stringify(body || {}) });

before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  await require('../core/migrate').runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [`events-${Date.now()}`])).rows[0].id;
  for (const [key, loc] of [['hr', 'Mumbai'], ['emp', 'Pune'], ['hrbp', 'Pune'], ['gone', 'Pune']]) {
    id[key] = (await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, location) VALUES ($1,$2,$3,$4,'Delivery',$5) RETURNING id`,
      [tenantId, key, `${key}@x.com`, key === 'gone' ? 'inactive' : 'active', loc])).rows[0].id;
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'hr@x.com','hr'),($1,'hrbp@x.com','hrbp')`, [tenantId]);
  for (const [role, p] of [['hr', 'people_admin'], ['hr', 'pms_admin'], ['employee', 'people_view'],
    ['hrbp', 'pms_hrbp'], ['hrbp', 'pms_self'], ['hrbp', 'people_view']]) {
    await db.query(`INSERT INTO core.role_permissions (tenant_id,role,permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, role, p]);
  }
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'hrbp@x.com','location','Pune','test')`, [tenantId]);
  const hash = await bcrypt.hash('pw', 4);
  for (const who of ['hr', 'emp', 'hrbp']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, `${who}@x.com`, hash]);
  }
  require('../modules/performance/hrbp-gateway');   // registers the gateway on the people router's scope hooks
  const { devLogin } = require('../core/auth');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/people', require('../modules/people').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['hr', 'emp', 'hrbp']) {
    tok[who] = (await (await fetch(`${base}/api/v1/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${who}@x.com`, password: 'pw' }),
    })).json()).token;
    assert.ok(tok[who], `${who} could not sign in`);
  }
});

after(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise((r) => server.close(r));
  for (const t of ['people.event_rsvps', 'people.events', 'people.csr_participations', 'people.csr_events', 'core.notifications',
    'core.audit_log', 'core.hrbp_scope', 'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  }
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});

const soon = (days, hour = 15) => { const d = new Date(Date.now() + days * 86400000); d.setUTCHours(hour, 0, 0, 0); return d.toISOString(); };

test('HR SCHEDULES AN EVENT, PEOPLE HUB SHOWS IT, AND EVERYONE ACTIVE IS TOLD IN THE APP', { skip }, async () => {
  const made = await send('hr', 'POST', '/people/events', { title: '  Diwali party ', starts_at: soon(7), ends_at: soon(7, 18), location: 'Pune office' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.event.title, 'Diwali party', 'trimmed');
  id.event = made.body.event.id;
  const seen = await call('emp', '/people/events');
  assert.ok(seen.body.events.some((e) => e.id === id.event), 'People Hub does not show it');
  assert.equal(made.body.notified, 3, 'HR is told how many were told');
  const told = (await db.query(`SELECT employee_id FROM core.notifications WHERE tenant_id=$1 AND kind='event_scheduled'`, [tenantId])).rows.map((r) => r.employee_id);
  assert.deepEqual(told.sort(), [id.hr, id.emp, id.hrbp].sort(), 'every ACTIVE employee once, nobody who has left');
  const audit = (await db.query(`SELECT action FROM core.audit_log WHERE tenant_id=$1 AND entity='people_events'`, [tenantId])).rows;
  assert.deepEqual(audit.map((a) => a.action), ['EVENT_CREATED']);
});

test('an event is checked before it is saved', { skip }, async () => {
  for (const [body, why] of [[{ starts_at: soon(1) }, /title/], [{ title: 'X' }, /start/], [{ title: 'X', starts_at: 'not a date' }, /start/],
    [{ title: 'X', starts_at: soon(2), ends_at: soon(1) }, /ends before it starts/], [{ title: 'X', starts_at: soon(1), ends_at: 'soon' }, /end date/],
    // Loose text is refused, not guessed at, and so is a time with no zone
    // (each server would read it in its own) — found by review, 13 Oct.
    [{ title: 'X', starts_at: '1' }, /start/], [{ title: 'X', starts_at: 'Diwali 12' }, /start/], [{ title: 'X', starts_at: '2026-10-20T15:00' }, /start/],
    [{ title: 'X', starts_at: '+010000-01-01T00:00:00Z' }, /start/]]) {
    const r = await send('hr', 'POST', '/people/events', { ...body, notify: false });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
});

test('employees answer it; HR sees who answered; an HRBP and an employee do not', { skip }, async () => {
  assert.equal((await send('emp', 'POST', `/people/events/${id.event}/rsvp`, { response: 'yes' })).status, 200);
  assert.equal((await send('hrbp', 'POST', `/people/events/${id.event}/rsvp`, { response: 'maybe' })).status, 200, 'an HRBP RSVPs like anyone');
  const list = await call('hr', `/people/events/${id.event}/rsvps`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.rsvps.map((r) => [r.name, r.response]).sort(), [['emp', 'yes'], ['hrbp', 'maybe']]);
  assert.equal((await call('emp', `/people/events/${id.event}/rsvps`)).status, 403);
  assert.equal((await call('hrbp', `/people/events/${id.event}/rsvps`)).status, 403, 'the gateway\'s lent people_admin does not open it');
});

test('ONLY HR SCHEDULES, EDITS OR DELETES — an employee and an HRBP are refused', { skip }, async () => {
  for (const who of ['emp', 'hrbp']) {
    assert.equal((await send(who, 'POST', '/people/events', { title: 'Mine', starts_at: soon(3) })).status, 403, `${who} created an event`);
    assert.equal((await send(who, 'PUT', `/people/events/${id.event}`, { title: 'Renamed' })).status, 403, `${who} edited an event`);
    assert.equal((await send(who, 'DELETE', `/people/events/${id.event}`)).status, 403, `${who} deleted an event`);
    assert.equal((await send(who, 'POST', '/people/csr', { title: 'Mine' })).status, 403, `${who} created a CSR activity`);
  }
  const still = (await db.query(`SELECT title FROM people.events WHERE id=$1`, [id.event])).rows[0];
  assert.equal(still.title, 'Diwali party');
});

test('HR edits only what it sends, and deleting takes the RSVPs with it', { skip }, async () => {
  const ed = await send('hr', 'PUT', `/people/events/${id.event}`, { location: 'Pune office, 5th floor' });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.event.location, 'Pune office, 5th floor');
  assert.equal(ed.body.event.title, 'Diwali party', 'a field not sent is kept');
  assert.equal((await send('hr', 'PUT', `/people/events/${id.event}`, { ends_at: soon(6) })).status, 400, 'an end before the start is refused on edit too');
  assert.equal((await send('hr', 'DELETE', `/people/events/${id.event}`)).status, 200);
  assert.equal((await db.query(`SELECT 1 FROM people.event_rsvps WHERE event_id=$1`, [id.event])).rows.length, 0);
  const late = await send('emp', 'POST', `/people/events/${id.event}/rsvp`, { response: 'yes' });
  assert.equal(late.status, 404, 'an RSVP to a removed event is a plain answer, not a database error');
  assert.equal((await send('hr', 'DELETE', `/people/events/${id.event}`)).status, 404);
});

test('CSR: HR adds, edits and removes an activity; people take part; HR sees who', { skip }, async () => {
  const made = await send('hr', 'POST', '/people/csr', { title: 'Tree plantation', event_date: '2026-11-02', hours_credit: 4, description: 'Bring water' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const cid = made.body.csr.id;
  assert.equal((await db.query(`SELECT count(*)::int n FROM core.notifications WHERE tenant_id=$1 AND kind='csr_scheduled'`, [tenantId])).rows[0].n, 3);
  for (const [body, why] of [[{ title: '' }, /title/], [{ title: 'X', event_date: '02/11/2026' }, /date/], [{ title: 'X', hours_credit: -1 }, /Hours credit/]]) {
    const r = await send('hr', 'POST', '/people/csr', { ...body, notify: false });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error, why);
  }
  assert.equal((await send('emp', 'POST', `/people/csr/${cid}/participate`, { hours: 3 })).status, 200);
  assert.equal((await send('emp', 'POST', `/people/csr/${cid}/participate`, { hours: 'lots' })).status, 400);
  // A blank answer signs up; it never wipes hours already logged (review, 13 Oct).
  assert.equal((await send('emp', 'POST', `/people/csr/${cid}/participate`, { hours: null })).status, 200);
  const mine = (await call('emp', '/people/csr')).body.csr.find((x) => x.id === cid);
  assert.equal(Number(mine.my_hours), 3, 'a blank answer wiped the hours');
  assert.equal(mine.joined, true);
  assert.equal((await call('hr', '/people/csr')).body.csr.find((x) => x.id === cid).joined, false, 'HR did not take part');
  const who = await call('hr', `/people/csr/${cid}/participants`);
  assert.deepEqual(who.body.participants.map((p) => [p.name, Number(p.hours)]), [['emp', 3]]);
  assert.equal(made.body.csr.event_date, '2026-11-02', 'the date as written');
  assert.equal((await call('emp', '/people/csr')).body.csr.find((x) => x.id === cid).event_date, '2026-11-02', 'People Hub shows the day HR chose');
  const ed = await send('hr', 'PUT', `/people/csr/${cid}`, { hours_credit: 5 });
  assert.equal(Number(ed.body.csr.hours_credit), 5);
  assert.equal(ed.body.csr.title, 'Tree plantation');
  assert.equal(ed.body.csr.event_date, '2026-11-02', 'an edit that leaves the date alone keeps it, not the day before');
  const twice = await send('hr', 'PUT', `/people/csr/${cid}`, { title: 'Tree plantation drive' });
  assert.equal(twice.body.csr.event_date, '2026-11-02');
  assert.equal((await send('hr', 'POST', '/people/csr', { title: 'X', event_date: '2026-02-30', notify: false })).status, 400, 'an impossible date is refused with a reason');
  assert.equal((await send('hr', 'DELETE', `/people/csr/${cid}`)).status, 200);
  assert.equal((await send('emp', 'POST', `/people/csr/${cid}/participate`, { hours: 1 })).status, 404);
});

test('the page is HR\'s: its row opens it to people_admin, so HR and Super Admin, not an HRBP', { skip }, async () => {
  await require('../migrations/087-people-events-admin').ensureEventPages(db, tenantId);
  const row = (await db.query(`SELECT required_permission FROM core.page_permission WHERE tenant_id=$1 AND route='/admin/events'`, [tenantId])).rows[0];
  assert.equal(row.required_permission, 'people_admin');
  await db.query(`DELETE FROM core.page_permission WHERE tenant_id=$1`, [tenantId]);
});

test('AN EVENT THAT IS OVER TAKES NO MORE ANSWERS — at its end, or without one at the end of its day', { skip }, async () => {
  const past = await send('hr', 'POST', '/people/events', { title: 'Last week', starts_at: soon(-3), notify: false });
  assert.equal(past.status, 200);
  const late = await send('emp', 'POST', `/people/events/${past.body.event.id}/rsvp`, { response: 'yes' });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /ended/);
  // Started an hour ago with no end time: still on today, so still open.
  const now = await send('hr', 'POST', '/people/events', { title: 'Town hall', starts_at: new Date(Date.now() - 3600000).toISOString(), notify: false });
  const today = new Date(); const ist = today.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata', hour12: false });
  if (!/ 00:/.test(ist)) {   // not in the first hour of an IST day, when an hour ago was yesterday
    assert.equal((await send('emp', 'POST', `/people/events/${now.body.event.id}/rsvp`, { response: 'yes' })).status, 200);
  }
  assert.equal((await call('emp', '/people/events')).body.timezone, 'Asia/Kolkata', 'People Hub is told the company zone');
});
