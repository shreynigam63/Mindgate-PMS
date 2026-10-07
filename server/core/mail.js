// Mail — provider interface behind SEND-MODE (proven AH pattern).
// mode 'live' sends via the configured provider; 'simulated' renders, logs,
// sends NOTHING — essential for demos and for testing governance mail
// without spamming a client's employees. Every send (real or simulated) is
// logged to core.notif_log with outcome. Providers: 'smtp' | 'graph' | 'none'
// — the concrete transport is configured per instance; 'none' + simulated is
// a valid dev setup.
const db = require('./db');
const logger = require('./logger');

async function sendMode(tenantId) {
  const r = await db.query(`SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='mail_send_mode'`, [tenantId]);
  return (r.rows[0] && r.rows[0].value && r.rows[0].value.mode) || 'simulated'; // safe default
}

// SMTP settings, from the tenant's own settings row first and the
// environment second. Stored per tenant because a SaaS instance sends as
// each client, and read fresh on every send so changing them takes effect
// without a restart — HR pasting a password into Settings should not need
// a deploy.
//
// The password is never returned by the settings API (see the redaction in
// the settings route); it is only ever read here.
async function smtpConfig(tenantId) {
  const r = await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='smtp'`, [tenantId]);
  const v = (r.rows[0] && r.rows[0].value) || {};
  const host = v.host || process.env.SMTP_HOST;
  const port = Number(v.port || process.env.SMTP_PORT || 587);
  const user = v.user || process.env.SMTP_USER;
  const pass = v.pass || process.env.SMTP_PASS;
  const from = v.from || process.env.MAIL_FROM || user;
  // secure=true means implicit TLS, which is port 465. Everything else
  // starts plain and upgrades with STARTTLS, which is what 587 does.
  const secure = v.secure != null ? !!v.secure : port === 465;
  return { host, port, user, pass, from, secure };
}

async function ensureLogTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS core.notif_log (
    id bigserial PRIMARY KEY, tenant_id uuid, at timestamptz NOT NULL DEFAULT now(),
    to_email text, subject text, kind text, mode text, outcome text, detail text)`);
}

// Hand one message to the configured mail server. Throws with the
// server's own reason when it cannot. Used by sendMail in live mode, and
// by the settings screen's test, which must reach the real server even
// while everything else is still simulated — that is the point of a test.
async function deliver(cfg, msg, limitMs = 20000) {
  // Default to smtp once a host is configured: an instance that has
  // filled in SMTP has said what it wants, and making them ALSO set
  // MAIL_PROVIDER was a second switch nobody could see was off.
  const provider = process.env.MAIL_PROVIDER || (cfg.host ? 'smtp' : 'none');
  if (provider === 'graph') throw new Error('graph provider not configured in this build');
  if (provider !== 'smtp') throw new Error('MAIL_PROVIDER not set');
  if (!cfg.host) throw new Error('SMTP host is not configured — set it in Settings, or SMTP_HOST');
  if (!cfg.from) throw new Error('No From address — set MAIL_FROM, or the SMTP user');
  const nodemailer = require('nodemailer');
  const tx = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    // A mail server that will not answer must not hold an HTTP
    // request open: the submission has already been saved and the
    // notification is in-app regardless.
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
  // One limit for the whole attempt. The per-step timeouts above apply to
  // each address a server name resolves to, and Microsoft 365's resolves to
  // many — an unreachable one took 80 seconds to give up, with a person
  // watching "Working…" on the settings screen.
  let timer;
  try {
    await Promise.race([
      tx.sendMail({ from: msg.from || cfg.from, to: msg.to, subject: msg.subject, html: msg.html,
        replyTo: msg.replyTo || undefined, cc: msg.cc || undefined }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Connection timeout — ${cfg.host}:${cfg.port} did not answer within ${Math.round(limitMs / 1000)} seconds`)), limitMs); }),
    ]);
  } finally { clearTimeout(timer); tx.close(); }
}

// A mail server's error, in a sentence HR can act on. The raw text is
// kept alongside it (the IT person will want it); this is the line on top.
// Matched on the codes and phrases the common servers actually send.
function explain(detail) {
  const d = String(detail || '');
  if (/SmtpClientAuthentication is disabled|5\.7\.139|basic authentication is disabled/i.test(d)) {
    return 'Microsoft 365 refused password sign-in for this mailbox. IT needs to turn on "Authenticated SMTP" for it in the Microsoft 365 admin centre — or, if the company has switched password sign-in off altogether, tell us and we will set up "Sign in with Microsoft" instead.';
  }
  if (/Application-specific password required|InvalidSecondFactor|5\.7\.9\b/i.test(d)) {
    return 'Google needs an app password for this mailbox, not its normal password. Create one under the mailbox\'s Google Account → Security → App passwords, and paste that here.';
  }
  if (/\b535\b|Invalid login|authentication (failed|unsuccessful)|Username and Password not accepted|EAUTH/i.test(d)) {
    return 'The mailbox or password was not accepted. Check both — and for Microsoft 365, that IT has turned on "Authenticated SMTP" for this mailbox.';
  }
  if (/SendAsDenied|not allowed to send as|5\.7\.60|Sender address rejected/i.test(d)) {
    return 'The mail server will not let this mailbox send as that address. Use the PMS mailbox as the sender, or ask IT to grant Send-As.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(d)) return 'The mail server name could not be found. Check the server under Advanced.';
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|Greeting never received|Connection timeout/i.test(d)) {
    return 'Could not reach the mail server. Ask IT whether the PMS server is allowed to send mail out on this port — and, if you chose Other, check the server and port under Advanced.';
  }
  if (/certificate|self.signed|wrong version number|SSL routines/i.test(d)) {
    return 'The secure connection failed. Try switching "Use SSL from the start" under Advanced (on for port 465, off for 587).';
  }
  if (/not configured|No From address|MAIL_PROVIDER/i.test(d)) return 'The mailbox is not set up yet — fill in the mailbox and password and save.';
  return d ? 'The mail server refused the email — the server\'s reason is below; IT will know what it means.' : null;
}

// The one entry point modules use. Returns {sent, mode}.
// `from` / `replyTo` / `cc` are optional. A caller that names a `from`
// gets it only when it is an address the account may send as — see
// onboarding.js, which decides that from the "send as the SPOC" setting;
// otherwise the configured From is kept and the person is Reply-To.
async function sendMail(tenantId, { to, subject, html, kind, from, replyTo, cc }) {
  await ensureLogTable();
  const mode = await sendMode(tenantId);
  let outcome = 'simulated', detail = null;
  if (mode === 'live') {
    try {
      await deliver(await smtpConfig(tenantId), { to, subject, html, from, replyTo, cc });
    } catch (e) { outcome = 'failed'; detail = e.message; logger.warn('mail send failed', { to, subject, error: e.message }); }
    if (!detail) outcome = 'sent';
  }
  await db.query(`INSERT INTO core.notif_log (tenant_id, to_email, subject, kind, mode, outcome, detail)
                  VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, to, subject, kind || 'generic', mode, outcome, detail]);
  // detail is the SMTP error, so a test send can say why it failed.
  return { sent: outcome === 'sent', mode, outcome, detail };
}

module.exports = { sendMail, sendMode, smtpConfig, deliver, explain, ensureLogTable };
