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
      const provider = process.env.MAIL_PROVIDER || 'none';
      if (provider === 'smtp') {
        // Wire nodemailer here at client implementation; deliberately not a
        // dependency until an instance needs it.
        throw new Error('smtp provider not configured in this build');
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
