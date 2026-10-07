// Sending through Google Workspace's Gmail API, AS a person — no mailbox
// of the PMS's own, and no passwords.
//
// Asked for on 7 Oct ("why can't it be directly emails from spocs";
// Mindgate is on Google Workspace). IT creates a Google service account,
// downloads its key, and in the Google Admin console authorises its
// client ID for one scope — gmail.send — under domain-wide delegation.
// The PMS then asks Google for a short-lived token FOR a named person
// (the `sub` claim) and sends from that person's own Gmail: the email is
// from their address, sits in their Sent folder, and replies reach them.
//
// What that authorisation allows is wide: gmail.send for ANY user in the
// domain. So the PMS only ever asks for a token for an address it worked
// out itself (the activity's SPOC, the joiner's manager, buddy or HR POC,
// or the reminders sender HR set), never one taken from a request; every
// send is logged with who it was from; and the key is write-only, like
// the SMTP password — never returned by any API, never audited.
//
// No Google library: a token is an RS256-signed JWT exchanged at Google's
// token endpoint, and a send is one POST of the MIME message, which
// nodemailer (already a dependency) composes. The two endpoints can be
// pointed elsewhere for tests (GOOGLE_TOKEN_URL, GMAIL_API_BASE).
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const tokenUrl = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const apiBase = () => process.env.GMAIL_API_BASE || 'https://gmail.googleapis.com';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * A service-account key as Google hands it out (the downloaded .json).
 * Returns the parts the PMS keeps, or throws with a sentence.
 */
function parseKey(text) {
  let k;
  try { k = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('That file is not a Google key — it should be the .json file downloaded for the service account.'); }
  if (!k || k.type !== 'service_account') throw new Error('That is not a service-account key. In Google Cloud, open the service account → Keys → Add key → JSON.');
  if (!k.client_email || !k.private_key || !k.client_id) throw new Error('The key file is missing its client email, client ID or private key.');
  try { crypto.createPrivateKey(k.private_key); } catch { throw new Error('The private key inside the file could not be read. Download a fresh JSON key.'); }
  return { client_email: k.client_email, client_id: String(k.client_id), project_id: k.project_id || null, private_key: k.private_key };
}

// One token per person, reused until a minute before it expires.
const cache = new Map();

async function tokenFor(key, subject) {
  const id = `${key.client_email}|${subject}`;
  const hit = cache.get(id);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, sub: subject, scope: SCOPE, aud: tokenUrl(), iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.private_key));
  const r = await fetch(tokenUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Google token for ${subject}: ${j.error || r.status}${j.error_description ? ` — ${j.error_description}` : ''}`);
  }
  cache.set(id, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}

const compose = (msg) => new Promise((resolve, reject) => {
  const MailComposer = require('nodemailer/lib/mail-composer');
  new MailComposer({ from: msg.from, to: msg.to, cc: msg.cc || undefined, replyTo: msg.replyTo || undefined,
    subject: msg.subject, html: msg.html }).compile().build((e, m) => (e ? reject(e) : resolve(m)));
});

/** Send `msg` from `subject`'s own Gmail. Throws with Google's reason. */
async function sendAs(key, subject, msg) {
  const token = await tokenFor(key, subject);
  const raw = b64url(await compose(msg));
  const r = await fetch(`${apiBase()}/gmail/v1/users/me/messages/send`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const e = j.error || {};
    throw new Error(`Gmail send as ${subject}: ${e.status || r.status}${e.message ? ` — ${e.message}` : ''}`);
  }
}

/** Can the PMS send as this person? Gets a token, sends nothing. */
async function canSendAs(key, subject) {
  try { await tokenFor(key, subject); return { ok: true }; } catch (e) { return { ok: false, detail: e.message }; }
}

module.exports = { SCOPE, parseKey, sendAs, canSendAs, _cache: cache };
