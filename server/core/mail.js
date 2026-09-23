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

// The one entry point modules use. Returns {sent, mode}.
async function sendMail(tenantId, { to, subject, html, kind }) {
  await ensureLogTable();
  const mode = await sendMode(tenantId);
  let outcome = 'simulated', detail = null;
  if (mode === 'live') {
    try {
      const cfg = await smtpConfig(tenantId);
      // Default to smtp once a host is configured: an instance that has
      // filled in SMTP has said what it wants, and making them ALSO set
      // MAIL_PROVIDER was a second switch nobody could see was off.
      const provider = process.env.MAIL_PROVIDER || (cfg.host ? 'smtp' : 'none');
      if (provider === 'smtp') {
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
        await tx.sendMail({ from: cfg.from, to, subject, html });
      } else if (provider === 'graph') {
        throw new Error('graph provider not configured in this build');
      } else throw new Error('MAIL_PROVIDER not set');
    } catch (e) { outcome = 'failed'; detail = e.message; logger.warn('mail send failed', { to, subject, error: e.message }); }
    if (!detail) outcome = 'sent';
  }
  await db.query(`INSERT INTO core.notif_log (tenant_id, to_email, subject, kind, mode, outcome, detail)
                  VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tenantId, to, subject, kind || 'generic', mode, outcome, detail]);
  return { sent: outcome === 'sent', mode, outcome };
}

module.exports = { sendMail, sendMode };
