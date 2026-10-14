// Forgot password (15 Oct: "Forgot Password Option during login").
//
// POST /auth/forgot-password {email}
//   Emails a one-time code to an active employee who signs in with a PMS
//   password. The answer is the same whether or not the address has an
//   account, so the form cannot be used to find out who works here. At
//   most three codes an hour per address, so it cannot be used to flood
//   someone's inbox. A new code replaces any earlier one.
// POST /auth/reset-password {email, code, new_password}
//   Sets the new password with a code that is unused, under 30 minutes old
//   and not past its five tries. Same password rule as changing it (8+).
//
// WHY A CODE, NOT A LINK: a link needs the site's public address. Taken
// from the request, anyone could ask for a victim's reset with a forged
// Host and have the email point at their own site, token and all. A code
// typed into the page that asked for it has no address to forge. When
// APP_URL is set, the email also carries a plain link to the sign-in page.
//
// Only where password sign-in is on (AUTH_DEV=true, as dev-login).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const logger = require('./logger');
const { sendMail, sendMode } = require('./mail');
const { principalByEmail } = require('./auth');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LENGTH = 8;
const LIFE_MINUTES = 30;
const MAX_TRIES = 5;
const PER_HOUR = 3;

const norm = (e) => String(e || '').trim().toLowerCase();
const hashOf = (tenantId, email, code) => crypto.createHash('sha256').update(`${tenantId}|${norm(email)}|${String(code).toUpperCase()}`).digest('hex');
function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SENT = 'If that email has a PMS account, a reset code is on its way. It works for 30 minutes.';

async function forgotPassword(req, res) {
  try {
    if (process.env.AUTH_DEV !== 'true') return res.status(404).json({ error: 'not found' });
    const tenantId = req.tenantId;
    const email = norm((req.body || {}).email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(422).json({ error: 'Enter your work email address.' });
    const mode = await sendMode(tenantId);
    // Said to everyone alike: it is about the instance, not the address.
    const noMail = mode !== 'live' ? 'Email is not switched on for this PMS yet, so no code can be sent. Ask HR to reset your password.' : null;
    const cred = (await db.query(`SELECT 1 FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=$2`, [tenantId, email])).rows[0];
    const p = cred ? await principalByEmail(tenantId, email) : { error: 'none' };
    if (!p.error) {
      const recent = Number((await db.query(
        `SELECT count(*) FROM core.password_resets WHERE tenant_id=$1 AND lower(email)=$2 AND created_at > now() - interval '1 hour'`,
        [tenantId, email])).rows[0].count);
      if (recent >= PER_HOUR) {
        logger.warn('password reset: hourly limit reached', { email });
      } else {
        const code = newCode();
        await db.query(`UPDATE core.password_resets SET used_at=now() WHERE tenant_id=$1 AND lower(email)=$2 AND used_at IS NULL`, [tenantId, email]);
        await db.query(
          `INSERT INTO core.password_resets (tenant_id, email, code_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(mins => $4))`,
          [tenantId, email, hashOf(tenantId, email, code), LIFE_MINUTES]);
        const site = (process.env.APP_URL || '').replace(/\/$/, '');
        await sendMail(tenantId, {
          to: email, kind: 'password_reset', subject: 'Your PMS password reset code',
          html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#101f3d">
            <p>Someone asked to reset the password for ${esc(email)} on the Performance Management System.</p>
            <p style="font-size:22px;font-weight:bold;letter-spacing:4px;margin:12px 0">${code}</p>
            <p>Enter this code on the sign-in page under <b>Forgot password?</b> It works for ${LIFE_MINUTES} minutes, once.</p>
            ${site ? `<p><a href="${esc(site)}/" style="color:#1b3b6f;font-weight:bold">Open the sign-in page</a></p>` : ''}
            <p style="color:#7d95bb;font-size:12px">If you did not ask for this, ignore this email — your password has not changed.</p></div>`,
        });
        logger.info('password reset code sent', { email, mode });
      }
    }
    res.json({ ok: true, message: noMail || SENT });
  } catch (e) {
    logger.error('forgot password failed', { error: e.message });
    res.status(500).json({ error: 'Could not send a reset code. Try again in a minute.' });
  }
}

async function resetPassword(req, res) {
  try {
    if (process.env.AUTH_DEV !== 'true') return res.status(404).json({ error: 'not found' });
    const tenantId = req.tenantId;
    const b = req.body || {};
    const email = norm(b.email);
    const code = String(b.code || '').replace(/\s+/g, '').toUpperCase();
    const next = String(b.new_password || '');
    if (!email || !code) return res.status(422).json({ error: 'Enter your email and the code from the email.' });
    if (next.length < 8) return res.status(422).json({ error: 'Your new password must be at least 8 characters.' });
    const r = (await db.query(
      `SELECT id, code_hash, attempts, expires_at < now() AS expired FROM core.password_resets
        WHERE tenant_id=$1 AND lower(email)=$2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`, [tenantId, email])).rows[0];
    if (!r || r.expired) return res.status(400).json({ error: 'That code has expired or was already used. Ask for a new one.' });
    if (r.attempts >= MAX_TRIES) return res.status(400).json({ error: 'Too many tries with that code. Ask for a new one.' });
    const want = Buffer.from(r.code_hash, 'hex');
    const got = Buffer.from(hashOf(tenantId, email, code), 'hex');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      await db.query(`UPDATE core.password_resets SET attempts=attempts+1 WHERE id=$1`, [r.id]);
      return res.status(400).json({ error: 'That code is not right. Check the email and try again.' });
    }
    const p = await principalByEmail(tenantId, email);
    if (p.error) return res.status(403).json({ error: 'This account is not active.' });
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const u = await client.query(
        `UPDATE core.local_credentials SET password_hash=$3, must_change_password=false WHERE tenant_id=$1 AND LOWER(email)=$2`,
        [tenantId, email, await bcrypt.hash(next, 10)]);
      if (!u.rowCount) throw Object.assign(new Error('No password is set on this account.'), { status: 404 });
      await client.query(`UPDATE core.password_resets SET used_at=now() WHERE id=$1`, [r.id]);
      await client.query(
        `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details) VALUES ($1,$2,'PASSWORD_RESET','employee',$3,$4)`,
        [tenantId, email, p.user.id, JSON.stringify({ via: 'emailed code' })]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    logger.info('password reset by emailed code', { email });
    res.json({ ok: true, message: 'Your password is changed. Sign in with it now.' });
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    logger.error('reset password failed', { error: e.message });
    res.status(500).json({ error: 'Could not reset your password. Try again in a minute.' });
  }
}

module.exports = { forgotPassword, resetPassword, newCode, ALPHABET, CODE_LENGTH };
