// node --test — the two settings screens built on 6 Oct.
//
// Email: live or simulated, and the SMTP account. The password must never
// come back out, a blank one must never wipe a working one, live must not
// be switchable on without a server, and an HRBP must not reach any of it.
//
// KRA rating settings: saving the bands and hours per day must not switch
// the overall timesheet score off as a side effect.
//
// Real Postgres; skips without DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';
const SLUG = `settings-test-${Date.now()}`;
let db, server, base, tenantId, hrTok, hrbpTok, empTok;

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
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-settings';
  process.env.AUTH_DEV = 'true';
  // The server's own environment must not leak into what this test sees.
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'SMTP_PORT', 'MAIL_PROVIDER']) delete process.env[k];
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  for (const [name, email, loc] of [['HR', 'hr@set.x', null], ['Partner', 'bp@set.x', null], ['Emp', 'emp@set.x', 'Pune']]) {
    await db.query(`INSERT INTO core.employees (tenant_id,name,email,status,location) VALUES ($1,$2,$3,'active',$4)`, [tenantId, name, email, loc]);
  }
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'hr@set.x','hr'),($1,'bp@set.x','hrbp')`, [tenantId]);
  await db.query(`INSERT INTO core.hrbp_scope (tenant_id,email,kind,value,created_by) VALUES ($1,'bp@set.x','location','Pune','t')`, [tenantId]);
  const hash = await bcrypt.hash('pw', 4);
  for (const e of ['hr@set.x', 'bp@set.x', 'emp@set.x']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,$2,$3)`, [tenantId, e, hash]);
  }
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/v1/pms`;
  const login = async (email) => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw' }),
  })).json()).token;
  hrTok = await login('hr@set.x'); hrbpTok = await login('bp@set.x'); empTok = await login('emp@set.x');
});

after(async () => {
  if (!HAS_DB) return;
  if (server) await new Promise((r) => server.close(r));
  for (const t of ['core.notif_log', 'core.admin_settings', 'pms.audit_log', 'core.audit_log', 'core.hrbp_scope',
    'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  }
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});

test('email starts simulated, with nothing configured, and cannot go live like that', { skip }, async () => {
  const r = await req('GET', '/hr/mail', hrTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'simulated');
  assert.equal(r.body.ready, false);
  const live = await req('PUT', '/hr/mail', hrTok, { mode: 'live' });
  assert.equal(live.status, 422);
  assert.match(live.body.error, /needs an SMTP server and a From address/);
});

test('THE PASSWORD IS WRITE-ONLY: saved, never returned, and a blank save keeps it', { skip }, async () => {
  const r = await req('PUT', '/hr/mail', hrTok, { smtp: { host: 'smtp.example.com', port: 587, user: 'pms@example.com', pass: 's3cret-value', from: 'PMS <pms@example.com>' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.smtp.pass_set, true);
  assert.ok(!JSON.stringify(r.body).includes('s3cret-value'), 'the password never comes back');
  assert.equal(r.body.ready, true);

  const again = await req('PUT', '/hr/mail', hrTok, { smtp: { host: 'smtp.example.com', pass: '' } });
  assert.equal(again.body.smtp.pass_set, true, 'a blank password field keeps the stored one');
  const stored = (await db.query(`SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='smtp'`, [tenantId])).rows[0].value;
  assert.equal(stored.pass, 's3cret-value');

  const audits = (await db.query(`SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='MAIL_SMTP_CHANGED'`, [tenantId])).rows;
  assert.ok(audits.length >= 1, 'the change is audited');
  assert.ok(!JSON.stringify(audits).includes('s3cret-value'), 'and the audit never holds the password');

  const cleared = await req('PUT', '/hr/mail', hrTok, { smtp: { clear_pass: true } });
  assert.equal(cleared.body.smtp.pass_set, false, 'clearing it is its own explicit act');
});

test('bad server details are refused with a sentence', { skip }, async () => {
  assert.equal((await req('PUT', '/hr/mail', hrTok, { smtp: { port: 99999 } })).status, 422);
  assert.equal((await req('PUT', '/hr/mail', hrTok, { smtp: { from: 'not an address' } })).status, 422);
  assert.equal((await req('PUT', '/hr/mail', hrTok, { mode: 'sometimes' })).status, 422);
});

test('live can be switched on once a server is set, and the test email goes through the real path', { skip }, async () => {
  const on = await req('PUT', '/hr/mail', hrTok, { mode: 'live' });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.mode, 'live');
  // No real SMTP server here: the send fails, and the failure is reported, not hidden.
  const t = await req('POST', '/hr/mail/test', hrTok);
  assert.equal(t.status, 200);
  assert.equal(t.body.to, 'hr@set.x');
  assert.equal(t.body.outcome, 'failed');
  assert.ok(t.body.detail, 'with the reason');
  const off = await req('PUT', '/hr/mail', hrTok, { mode: 'simulated' });
  assert.equal(off.body.mode, 'simulated');
  const sim = await req('POST', '/hr/mail/test', hrTok);
  assert.equal(sim.body.outcome, 'simulated');
});

test('an HRBP and an employee reach none of the email settings', { skip }, async () => {
  assert.equal((await req('GET', '/hr/mail', hrbpTok)).status, 403);
  assert.equal((await req('PUT', '/hr/mail', hrbpTok, { mode: 'simulated' })).status, 403);
  assert.equal((await req('POST', '/hr/mail/test', hrbpTok)).status, 403);
  assert.equal((await req('GET', '/hr/mail', empTok)).status, 403);
});

test('SAVING THE KRA BANDS DOES NOT SWITCH THE OVERALL SCORE OFF', { skip }, async () => {
  const cur = (await req('GET', '/timesheet/kra/scoring', hrTok)).body.scoring;
  const on = await req('PUT', '/timesheet/kra/scoring', hrTok, { ...cur, auto_score: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const bands = [{ label: 'A+', min: 100 }, { label: 'A', min: 85 }, { label: 'B+', min: 70 }, { label: 'B', min: 0 }];
  const r = await req('PUT', '/timesheet/kra/scoring', hrTok, { kra_bands: bands, hours_per_day: 9, min_mapped_pct: 75 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.scoring.auto_score, true, 'left as it was');
  assert.equal(r.body.scoring.hours_per_day, 9);
  assert.deepEqual(r.body.scoring.kra_bands, bands);
  assert.equal((await req('PUT', '/timesheet/kra/scoring', hrTok, { kra_bands: [{ label: 'A', min: 50 }] })).status, 422,
    'a ladder with no floor is refused');
  assert.equal((await req('PUT', '/timesheet/kra/scoring', hrbpTok, { hours_per_day: 7 })).status, 403,
    'the bands apply to everybody, so an HRBP cannot change them');
});
