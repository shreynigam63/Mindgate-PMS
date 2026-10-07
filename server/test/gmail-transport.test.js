// node --test — sending through Google Workspace as each person
// (core/gmail.js), added 7 Oct: Mindgate is on Gmail, and the onboarding
// emails are to come from each SPOC's own address with no PMS mailbox.
//
// Google is stood in for by a local server that does what Google does:
// it checks the token request's RS256 signature against the key's public
// half, issues a token for the `sub` named, refuses a group address and an
// unauthorised client the way Google words it, and records each message.
// The key is generated here, at run time — none is kept in the repo.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  type: 'service_account', project_id: 'pms-test', client_id: '1234567890',
  client_email: 'pms-sender@pms-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const sent = [];
const tokens = [];
let google;

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

before(async () => {
  google = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (c) => { body += c; });
    rq.on('end', () => {
      const reply = (code, j) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(j)); };
      if (rq.url === '/token') {
        const jwt = new URLSearchParams(body).get('assertion') || '';
        const [h, c, sig] = jwt.split('.');
        if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, fromB64url(sig))) return reply(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        const claims = JSON.parse(fromB64url(c));
        if (claims.scope !== 'https://www.googleapis.com/auth/gmail.send') return reply(400, { error: 'invalid_scope' });
        if (claims.sub === 'blocked@mg.x') return reply(401, { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method' });
        if (claims.sub === 'it-group@mg.x') return reply(400, { error: 'invalid_grant', error_description: 'Not a valid email or user ID.' });
        tokens.push(claims.sub);
        return reply(200, { access_token: `tok:${claims.sub}`, expires_in: 3600 });
      }
      if (rq.url === '/gmail/v1/users/me/messages/send') {
        const who = String(rq.headers.authorization || '').replace('Bearer tok:', '');
        sent.push({ as: who, raw: fromB64url(JSON.parse(body).raw).toString() });
        return reply(200, { id: 'm1' });
      }
      reply(404, {});
    });
  });
  await new Promise((r) => google.listen(0, r));
  const base = `http://127.0.0.1:${google.address().port}`;
  process.env.GOOGLE_TOKEN_URL = `${base}/token`;
  process.env.GMAIL_API_BASE = base;
});
after(async () => { if (google) await new Promise((r) => google.close(r)); });

test('a service-account key is checked, and anything else is refused with a sentence', () => {
  const { parseKey } = require('../core/gmail');
  assert.equal(parseKey(JSON.stringify(KEY)).client_email, KEY.client_email);
  assert.throws(() => parseKey('not json'), /not a Google key/);
  assert.throws(() => parseKey(JSON.stringify({ ...KEY, type: 'authorized_user' })), /not a service-account key/);
  assert.throws(() => parseKey(JSON.stringify({ ...KEY, private_key: 'nope' })), /could not be read/);
});

test('AN EMAIL IS SENT FROM THE PERSON\'S OWN GMAIL — token for them, From is them', async () => {
  const { sendAs } = require('../core/gmail');
  sent.length = 0;
  await sendAs(KEY, 'it.desk@mg.x', { from: '"IT Desk" <it.desk@mg.x>', to: 'joiner@mg.x', replyTo: 'it.desk@mg.x', subject: 'Your laptop', html: '<p>Hi</p>' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].as, 'it.desk@mg.x', 'sent from the SPOC\'s own mailbox');
  assert.match(sent[0].raw, /^From: IT Desk <it\.desk@mg\.x>/m);
  assert.match(sent[0].raw, /^To: joiner@mg\.x/m);
  // The token is reused, not fetched per email.
  const before = tokens.length;
  await sendAs(KEY, 'it.desk@mg.x', { from: 'it.desk@mg.x', to: 'joiner@mg.x', subject: 'Again', html: '<p>x</p>' });
  assert.equal(tokens.length, before);
});

test('Google\'s refusals come back in words HR and IT can act on', async () => {
  const { canSendAs } = require('../core/gmail');
  const { explain } = require('../core/mail');
  const group = await canSendAs(KEY, 'it-group@mg.x');
  assert.equal(group.ok, false);
  assert.match(explain(group.detail), /not a user in Mindgate’s Google Workspace/);
  const blocked = await canSendAs(KEY, 'blocked@mg.x');
  assert.match(explain(blocked.detail), /Domain-wide delegation/);
  assert.match(explain('Gmail send as x@mg.x: 403 — Gmail API has not been used in project 1 before or it is disabled'), /Gmail API is switched off/);
});

// The settings and the onboarding check, end to end over HTTP.
let db, server, apiBase, tenantId, hrTok;
process.env.SERVER_PUBLIC_IP = process.env.SERVER_PUBLIC_IP || '203.0.113.7';
const SLUG = `gmail-test-${Date.now()}`;
const req = async (method, path, body) => {
  const r = await fetch(`${apiBase}${path}`, { method, headers: { Authorization: `Bearer ${hrTok}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j, text: JSON.stringify(j) };
};

test('HR connects Google Workspace: the key is never shown back, the test goes from the reminders sender, Live follows', { skip }, async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-gmail';
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  await require('../core/migrate').runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (slug, name) VALUES ($1,$1) RETURNING id`, [SLUG])).rows[0].id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, tenantId);
  await db.query(`INSERT INTO core.employees (tenant_id,name,email,status) VALUES ($1,'HR','hr@mg.x','active')`, [tenantId]);
  await db.query(`INSERT INTO core.user_roles (tenant_id,email,role) VALUES ($1,'hr@mg.x','hr')`, [tenantId]);
  await db.query(`INSERT INTO core.local_credentials (tenant_id,email,password_hash) VALUES ($1,'hr@mg.x',$2)`, [tenantId, await bcrypt.hash('pw', 4)]);
  const app = express();
  app.use(express.json());
  app.use((rq, _rs, next) => { rq.tenantId = tenantId; next(); });
  app.post('/api/v1/auth/dev-login', require('../core/auth').devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  app.use('/api/v1/people', require('../modules/people').router);
  await new Promise((r) => { server = app.listen(0, r); });
  const port = server.address().port;
  apiBase = `http://127.0.0.1:${port}/api/v1`;
  hrTok = (await (await fetch(`http://127.0.0.1:${port}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hr@mg.x', password: 'pw' }) })).json()).token;

  assert.equal((await req('PUT', '/pms/hr/mail', { google: { key_json: '{"type":"nope"}' } })).status, 422);
  const on = await req('PUT', '/pms/hr/mail', { transport: 'google', google: { key_json: JSON.stringify(KEY), sender: 'HR@mg.x' } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.transport, 'google');
  assert.equal(on.body.google.connected, true);
  assert.equal(on.body.google.client_id, '1234567890', 'shown, so IT can authorise it');
  assert.equal(on.body.google.sender, 'hr@mg.x');
  assert.ok(!/PRIVATE KEY/.test(on.text), 'the private key never comes back');
  assert.equal(on.body.stage, 'untested');

  sent.length = 0;
  const t = await req('POST', '/pms/hr/mail/test');
  assert.equal(t.body.outcome, 'sent', t.text);
  assert.equal(sent[0].as, 'hr@mg.x');
  assert.match(sent[0].raw, /^From: Performance Management System <hr@mg\.x>/m);
  assert.equal((await req('PUT', '/pms/hr/mail', { mode: 'live' })).body.stage, 'live');

  // Live, a product email from a SPOC goes from that SPOC's own Gmail.
  sent.length = 0;
  const r = await require('../core/mail').sendMail(tenantId, { to: 'joiner@mg.x', subject: 'Welcome', html: '<p>Hi</p>', kind: 'onboarding_task', from: '"Admin Desk" <admin@mg.x>' });
  assert.equal(r.outcome, 'sent');
  assert.equal(sent[0].as, 'admin@mg.x');

  // Each SPOC address checked without sending anything.
  await db.query(`INSERT INTO people.onboarding_spocs (tenant_id, role, name, email) VALUES ($1,'IT','IT group','it-group@mg.x'),($1,'Admin','Admin Desk','admin@mg.x')`, [tenantId]);
  sent.length = 0;
  const chk = await req('GET', '/people/onboarding/spocs/check');
  assert.equal(chk.status, 200, chk.text);
  assert.equal(chk.body.checkable, true);
  const by = Object.fromEntries(chk.body.spocs.map((x) => [x.role, x]));
  assert.equal(by.Admin.ok, true);
  assert.equal(by.IT.ok, false);
  assert.match(by.IT.hint, /Google Group/);
  assert.equal(sent.length, 0, 'checking sends nothing');

  // Back to a mailbox: a different way out, so back to recorded-only until tested.
  const back = await req('PUT', '/pms/hr/mail', { transport: 'smtp' });
  assert.equal(back.body.transport, 'smtp');
  assert.equal(back.body.mode, 'simulated');
});

after(async () => {
  if (!HAS_DB || !db) return;
  if (server) await new Promise((r) => server.close(r));
  for (const t of ['people.onboarding_spocs', 'core.notif_log', 'core.admin_settings', 'pms.audit_log', 'core.audit_log',
    'core.local_credentials', 'core.user_roles', 'core.role_permissions', 'core.user_permissions', 'core.page_permission', 'core.employees']) {
    await db.query(`DELETE FROM ${t} WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  }
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});
