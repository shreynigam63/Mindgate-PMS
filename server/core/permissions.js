// Access control — the table-driven design ported from AH, whole.
//
// Effective permissions = role grants ∪ per-user grants; '*' is wildcard.
// Route rules match method + LONGEST path prefix; enforced=false logs
// WOULD-DENY, enforced=true 403s with the needed permission named in the
// response (the `needs` field self-diagnoses the next misconfiguration —
// proven in production). New rules start log-only and are promoted after a
// clean observation window.
//
// Carried lesson (the expense-parity incident): route rules cover COARSE
// all-or-nothing routes only; row-scoped decisions live in handlers. Reads
// and writes get separate method-scoped rows — never one flat prefix over
// mixed read/write routes.

const db = require('./db');
const logger = require('./logger');

let cache = { rows: new Map(), at: 0 }; // tenant -> rules
async function routeRules(tenantId) {
  const now = Date.now();
  if (now - cache.at < 60000 && cache.rows.has(tenantId)) return cache.rows.get(tenantId);
  const r = await db.query(
    `SELECT method, path_pattern, required_permission, enforced FROM core.route_permission WHERE tenant_id=$1`, [tenantId]);
  cache.rows.set(tenantId, r.rows); cache.at = now;
  return r.rows;
}
function bustRuleCache() { cache = { rows: new Map(), at: 0 }; }

async function effectivePermissions(user) {
  const [roleP, userP] = await Promise.all([
    db.query(`SELECT permission FROM core.role_permissions WHERE tenant_id=$1 AND role=$2`, [user.tenant_id, user.role]),
    db.query(`SELECT permission FROM core.user_permissions WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [user.tenant_id, user.email]),
  ]);
  const set = new Set([...roleP.rows, ...userP.rows].map(r => r.permission));
  return { permissions: set, wildcard: set.has('*') };
}

// Route-table gate. Mount after authenticate on every router.
async function apiPermissionParity(req, res, next) {
  try {
    const rules = await routeRules(req.user.tenant_id);
    const path = req.baseUrl + req.path;
    const match = rules
      .filter(r => (r.method === '*' || r.method === req.method) && path.startsWith(r.path_pattern))
      .sort((a, b) => b.path_pattern.length - a.path_pattern.length)[0];
    if (!match) return next();
    const { permissions, wildcard } = await effectivePermissions(req.user);
    if (wildcard || permissions.has(match.required_permission)) return next();
    db.query(`INSERT INTO core.api_denial_log (tenant_id,email,method,path,needed,enforced)
              VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.tenant_id, req.user.email, req.method, path, match.required_permission, match.enforced]).catch(() => {});
    if (!match.enforced) {
      logger.warn('WOULD DENY (log-only rule)', { email: req.user.email, path, needs: match.required_permission });
      return next();
    }
    return res.status(403).json({ error: 'Access denied', needs: match.required_permission });
  } catch (e) {
    logger.error('parity gate error', { error: e.message });
    next(); // gate failure must not take the API down; handlers still guard
  }
}

// Convenience for handler guards.
async function hasPermission(user, permission) {
  const { permissions, wildcard } = await effectivePermissions(user);
  return wildcard || permissions.has(permission);
}

module.exports = { apiPermissionParity, effectivePermissions, hasPermission, bustRuleCache };
