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

function sign(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, tenant_id: user.tenant_id },
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
      `SELECT password_hash FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [tenantId, email || ''])).rows[0];
    if (!cred || !(await bcrypt.compare(password || '', cred.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const p = await principalByEmail(tenantId, email);
    if (p.error) return res.status(403).json({ error: p.error === 'inactive' ? 'Account inactive' : 'No employee record' });
    res.json({ token: sign(p.user), user: p.user });
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
    req.user = { id: claims.sub, email: claims.email, name: claims.name, role: claims.role, tenant_id: claims.tenant_id };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { authenticate, devLogin, sign, principalByEmail };
