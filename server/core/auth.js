// Auth — Agentic PMS core.
// JWT sessions. Providers are pluggable: production is the client's IdP
// (Azure AD via OIDC — configured per instance), dev/break-glass is local
// credentials. Only ACTIVE employees can log in (AH rule, kept).

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');
const logger = require('./logger');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';

// The only paths reachable while an account still owes a password change.
// Matched on the full path so it cannot be widened by accident from
// inside a mounted router.
const OPEN_WHILE_LOCKED = new Set(['/api/v1/me', '/api/v1/auth/password']);

// `pwc` — "password change required". Carried IN THE TOKEN rather than
// looked up per request: this is checked on every authenticated call, and
// a database round trip on every call to answer a question that changes
// once per account is the wrong trade. Changing the password issues a new
// token without it (see changePassword), which is what unlocks the app.
//
// The cost of the choice, stated: if HR resets somebody's password while
// they are signed in, that session keeps running until it expires. That
// is what happens today anyway, and the lock does its job at the next
// sign-in, which is the "first login" this was asked for.
function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, tenant_id: user.tenant_id,
      pwc: !!user.must_change_password },
    JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Resolve an authenticated principal from the employee mirror + role table.
async function principalByEmail(tenantId, email) {
  const r = await db.query(
    `SELECT e.id, e.tenant_id, e.email, e.name, e.department, e.status,
            COALESCE(ur.role, 'employee') AS role
       FROM core.employees e
       LEFT JOIN core.user_roles ur ON ur.tenant_id = e.tenant_id AND LOWER(ur.email) = LOWER(e.email)
      WHERE e.tenant_id = $1 AND LOWER(e.email) = LOWER($2)`, [tenantId, email]);
  const u = r.rows[0];
  if (!u) return { error: 'unknown_user' };
  if (u.status !== 'active') return { error: 'inactive' };
  return { user: u };
}

// POST /auth/dev-login {email, password} — enabled only when AUTH_DEV=true.
//
// Wrapped in try/catch deliberately: found during a live debugging
// session that any unexpected failure inside this async handler (e.g. a
// missing JWT_SECRET) previously went unhandled — Express doesn't
// auto-catch async route errors, so the request never got ANY response
// and the caller's connection just hung indefinitely instead of failing
// fast with a clear error. This is the one login route that actually
// exists right now, so it hanging silently is worse than most.
async function devLogin(req, res) {
  try {
    if (process.env.AUTH_DEV !== 'true') return res.status(404).json({ error: 'not found' });
    const { email, password } = req.body || {};
    const tenantId = req.tenantId;
    const cred = (await db.query(
      `SELECT password_hash, must_change_password FROM core.local_credentials
        WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [tenantId, email || ''])).rows[0];
    if (!cred || !(await bcrypt.compare(password || '', cred.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const p = await principalByEmail(tenantId, email);
    if (p.error) return res.status(403).json({ error: p.error === 'inactive' ? 'Account inactive' : 'No employee record' });
    const user = { ...p.user, must_change_password: !!cred.must_change_password };
    res.json({ token: sign(user), user });
  } catch (e) {
    logger.error('dev-login failed', { error: e.message });
    res.status(500).json({ error: 'Login failed unexpectedly' });
  }
}

// Middleware: verify JWT, attach req.user. 401 on anything invalid.
// Accepts the token via the standard Authorization header (every normal
// API call) OR a ?token= query param, as a fallback ONLY for plain <a
// href> download links (file downloads, evidence/closure-letter PDFs)
// that can't attach custom headers — everywhere else in the app still
// uses the header.
function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || null);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    req.user = { id: claims.sub, email: claims.email, name: claims.name, role: claims.role,
                 tenant_id: claims.tenant_id, must_change_password: !!claims.pwc };
    // THE LOCK, and it is deliberately here rather than in the page.
    //
    // Asked for on 27 Sep and answered "compulsory" by the client: a
    // password HR issued from a published pattern has to be replaced at
    // the first sign-in. A screen the browser puts up is not that — it is
    // a suggestion anyone with curl can decline — so the API refuses
    // everything until the password has been changed.
    //
    // Two routes stay open, and only two: /me, because the page has to be
    // able to find out that it is locked, and the change itself.
    // originalUrl, not path: inside a mounted router `path` is relative to
    // the mount, so an allowlist read from it would match '/me' under any
    // prefix that happened to have one.
    if (req.user.must_change_password && !OPEN_WHILE_LOCKED.has(req.originalUrl.split('?')[0])) {
      return res.status(403).json({ error: 'Set your own password before using the app',
                                    must_change_password: true });
    }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// POST /auth/password {current_password, new_password} — the only way a
// person sets their own password, and the way out of the lock above.
//
// The current password is required even though the caller is already
// authenticated: a borrowed laptop with a live session must not be enough
// to take the account over.
async function changePassword(req, res) {
  try {
    const { current_password: current, new_password: next } = req.body || {};
    if (!next || String(next).length < 8) {
      return res.status(400).json({ error: 'Your new password must be at least 8 characters' });
    }
    if (String(next) === String(current || '')) {
      // Otherwise "change" clears the lock while leaving the issued
      // password in place, which is the whole thing this prevents.
      return res.status(400).json({ error: 'Your new password must be different from the current one' });
    }
    const cred = (await db.query(
      `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [req.user.tenant_id, req.user.email])).rows[0];
    if (!cred) return res.status(404).json({ error: 'No password is set on this account' });
    if (!(await bcrypt.compare(String(current || ''), cred.password_hash))) {
      return res.status(401).json({ error: 'That is not your current password' });
    }
    await db.query(
      `UPDATE core.local_credentials SET password_hash=$3, must_change_password=false
        WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [req.user.tenant_id, req.user.email, await bcrypt.hash(String(next), 10)]);
    logger.info('password changed by its owner', { tenantId: req.user.tenant_id, email: req.user.email });
    // A FRESH TOKEN, because the old one still carries pwc:true and would
    // keep the caller locked out of the app they just unlocked.
    const user = { ...req.user, must_change_password: false };
    res.json({ ok: true, token: sign(user), user });
  } catch (e) {
    logger.error('change password failed', { error: e.message });
    res.status(500).json({ error: 'Could not change your password' });
  }
}

module.exports = { authenticate, devLogin, changePassword, sign, principalByEmail, OPEN_WHILE_LOCKED };
