// node --test — Forgot password (15 Oct): a one-time code by email, no
// account enumeration, three a hour, five tries, 30 minutes, once.
// Real Postgres and HTTP; skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, sentHtml;
const post = async (p, body) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const lastCode = async () => {
  const html = (await db.query(`SELECT subject FROM core.notif_log WHERE tenant_id=$1 AND kind='password_reset' ORDER BY id DESC LIMIT 1`, [tenantId])).rows[0];
  assert.ok(html, 'a reset email was logged');
  return sentHtml.match(/letter-spacing:4px;margin:12px 0">([A-Z0-9]{8})</)[1];
};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-reset';
  process.env.TENANT_SLUG = 'reset-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();
  // Capture what would be emailed: the code is only ever in the email.
  const mail = require('../core/mail');
  const realSend = mail.sendMail;
  mail.sendMail = async (t, m) => { sentHtml = m.html; return realSend(t, m); };
  const { forgotPassword, resetPassword } = require('../core/password-reset');
  const { devLogin } = require('../core/auth');
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`, [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await db.query(`INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'mail_send_mode','{"mode":"live"}')
                  ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`, [t.id]);
  for (const [k, status] of [['amy', 'active'], ['gone', 'inactive']]) {
    await db.query(`INSERT INTO core.employees (tenant_id, name, email, status) VALUES ($1,$2,$3,$4)`, [t.id, `Reset ${k}`, `reset-${k}@x.com`, status]);
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, `reset-${k}@x.com`, await bcrypt.hash('old-password', 4)]);
  }
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.post('/api/v1/auth/forgot-password', forgotPassword);
  app.post('/api/v1/auth/reset-password', resetPassword);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  // SMTP is not configured in tests: a "live" send fails and is logged as
  // failed, which is all this test needs — the code is captured above.
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

test('the same answer for an account, no account and an inactive one — nobody can be looked up', { skip }, async () => {
  const a = await post('/auth/forgot-password', { email: 'Reset-Amy@x.com ' });
  const b = await post('/auth/forgot-password', { email: 'nobody@x.com' });
  const c = await post('/auth/forgot-password', { email: 'reset-gone@x.com' });
  assert.deepStrictEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.strictEqual(a.body.message, b.body.message);
  assert.strictEqual(a.body.message, c.body.message);
  const sent = (await db.query(`SELECT lower(email) AS email FROM core.password_resets WHERE tenant_id=$1`, [tenantId])).rows.map((r) => r.email);
  assert.deepStrictEqual(sent, ['reset-amy@x.com'], 'a code only for the active account');
  assert.strictEqual((await post('/auth/forgot-password', { email: 'not an email' })).status, 422);
});

test('the code resets the password once; wrong codes count; the old password stops working', { skip }, async () => {
  const code = await lastCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
  const stored = (await db.query(`SELECT code_hash FROM core.password_resets WHERE tenant_id=$1`, [tenantId])).rows[0].code_hash;
  assert.ok(!stored.includes(code), 'stored hashed');
  let r = await post('/auth/reset-password', { email: 'reset-amy@x.com', code: 'AAAAAAAA', new_password: 'new-password-1' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /not right/);
  r = await post('/auth/reset-password', { email: 'reset-amy@x.com', code, new_password: 'short' });
  assert.strictEqual(r.status, 422);
  r = await post('/auth/reset-password', { email: 'RESET-AMY@x.com', code: code.toLowerCase().replace(/(.{4})/, '$1 '), new_password: 'new-password-1' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  r = await post('/auth/reset-password', { email: 'reset-amy@x.com', code, new_password: 'new-password-2' });
  assert.strictEqual(r.status, 400, 'once only');
  assert.match(r.body.error, /expired or was already used/);
  assert.strictEqual((await post('/auth/dev-login', { email: 'reset-amy@x.com', password: 'old-password' })).status, 401);
  assert.strictEqual((await post('/auth/dev-login', { email: 'reset-amy@x.com', password: 'new-password-1' })).status, 200);
  const audit = (await db.query(`SELECT action FROM core.audit_log WHERE tenant_id=$1 AND action='PASSWORD_RESET'`, [tenantId])).rows;
  assert.strictEqual(audit.length, 1);
});

test('five wrong tries spend a code; a new request replaces the old code; three an hour at most', { skip }, async () => {
  await post('/auth/forgot-password', { email: 'reset-amy@x.com' });
  const first = await lastCode();
  await post('/auth/forgot-password', { email: 'reset-amy@x.com' });
  const second = await lastCode();
  let r = await post('/auth/reset-password', { email: 'reset-amy@x.com', code: first, new_password: 'another-pass' });
  assert.strictEqual(r.status, 400, 'the earlier code was replaced');
  for (let i = 0; i < 5; i++) await post('/auth/reset-password', { email: 'reset-amy@x.com', code: 'ZZZZZZZZ', new_password: 'another-pass' });
  r = await post('/auth/reset-password', { email: 'reset-amy@x.com', code: second, new_password: 'another-pass' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /Too many tries/);
  const before = Number((await db.query(`SELECT count(*) FROM core.password_resets WHERE tenant_id=$1`, [tenantId])).rows[0].count);
  await post('/auth/forgot-password', { email: 'reset-amy@x.com' });
  const afterCount = Number((await db.query(`SELECT count(*) FROM core.password_resets WHERE tenant_id=$1`, [tenantId])).rows[0].count);
  assert.strictEqual(afterCount, before, 'the fourth in an hour sends nothing');
});

test('an expired code is refused; with email switched off the page says to ask HR', { skip }, async () => {
  await db.query(`DELETE FROM core.password_resets WHERE tenant_id=$1`, [tenantId]);
  await post('/auth/forgot-password', { email: 'reset-amy@x.com' });
  const code = await lastCode();
  await db.query(`UPDATE core.password_resets SET expires_at = now() - interval '1 minute' WHERE tenant_id=$1`, [tenantId]);
  const r = await post('/auth/reset-password', { email: 'reset-amy@x.com', code, new_password: 'another-pass' });
  assert.strictEqual(r.status, 400);
  await db.query(`UPDATE core.admin_settings SET value='{"mode":"simulated"}' WHERE tenant_id=$1 AND key='mail_send_mode'`, [tenantId]);
  const off = await post('/auth/forgot-password', { email: 'nobody-else@x.com' });
  assert.match(off.body.message, /Ask HR to reset your password/);
});
