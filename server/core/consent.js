// Employee consent capture — core/consent.js
//
// BRD §6 NFR: "explicit employee consent required before any meeting
// recording/transcription is used for AI insights." Project plan: "prevent
// meeting-based features from running without it."
//
// Design:
//   - Consent can ONLY be granted or revoked by the employee themselves
//     (pms_self). A manager or HR can VIEW status but never set it on
//     someone else's behalf — a consent a manager could grant for their
//     report is not consent.
//   - hasConsent()/requireConsent() are the gate. Any current or future
//     feature that records, transcribes, or pulls calendar/meeting content
//     for AI use MUST call requireConsent() before doing so. Today that is
//     wired into POST /pms/connects when meeting_based=true (see
//     modules/performance/index.js); it is written as a small, reusable
//     export specifically so the calendar/meeting-tool integration (still
//     unbuilt) has a ready-made gate to call into rather than reinventing
//     this check.
//   - Every grant/revoke is written to core.audit_log — "who approved it,
//     and when" must be answerable the same way it is for AI drafts.

const express = require('express');
const db = require('./db');
const { authenticate } = require('./auth');
const { guardUuidParams } = require('./http');
const { apiPermissionParity, hasPermission } = require('./permissions');

const DEFAULT_TYPE = 'meeting_ai_insights';

async function hasConsent(tenantId, employeeId, consentType = DEFAULT_TYPE) {
  const r = await db.query(
    `SELECT granted FROM core.employee_consents WHERE tenant_id=$1 AND employee_id=$2 AND consent_type=$3`,
    [tenantId, employeeId, consentType]);
  return !!(r.rows[0] && r.rows[0].granted);
}

// Throws a shaped error (status 403) a route handler can let propagate to
// its catch block — matches the { status, message } convention core/ai.js
// already uses, so callers don't need a new error-handling pattern.
async function requireConsent(tenantId, employeeId, consentType = DEFAULT_TYPE) {
  if (!(await hasConsent(tenantId, employeeId, consentType))) {
    const err = new Error(`Employee has not given consent (${consentType}) — this feature cannot run without it`);
    err.status = 403;
    throw err;
  }
}

const router = express.Router();
router.use(authenticate, apiPermissionParity);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);
const T = (req) => req.user.tenant_id;

// GET /consent/me — the employee's own consent status (all types on record).
router.get('/me', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT consent_type, granted, granted_at, revoked_at FROM core.employee_consents
        WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id]);
    res.json({ consents: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /consent/me  { consent_type?, granted: true|false } — self only.
// This is the ONLY way consent changes; there is deliberately no
// "set on behalf of" route for managers/HR.
router.put('/me', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_self'))) return res.status(403).json({ error: "Requires 'pms_self'" });
    const { consent_type = DEFAULT_TYPE, granted } = req.body || {};
    if (typeof granted !== 'boolean') return res.status(400).json({ error: 'granted (boolean) required' });
    await db.query(
      `INSERT INTO core.employee_consents (tenant_id, employee_id, consent_type, granted, granted_at, revoked_at, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, employee_id, consent_type) DO UPDATE SET
         granted=EXCLUDED.granted, granted_at=EXCLUDED.granted_at, revoked_at=EXCLUDED.revoked_at,
         updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [T(req), req.user.id, consent_type, granted, granted ? new Date() : null, granted ? null : new Date(), req.user.email]);
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,$3,'employee_consent',$4,$5)`,
      [T(req), req.user.email, granted ? 'CONSENT_GRANTED' : 'CONSENT_REVOKED', req.user.id, JSON.stringify({ consent_type })]);
    res.json({ ok: true, consent_type, granted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /consent/:employeeId — view-only, for a manager/HR checking before
// offering a meeting-based feature. Cannot set anything.
router.get('/:employeeId', async (req, res) => {
  try {
    const isSelf = req.params.employeeId === req.user.id;
    if (!isSelf && !(await hasPermission(req.user, 'pms_team_eval')) && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: "Requires 'pms_team_eval' or 'pms_admin'" });
    }
    const r = await db.query(
      `SELECT consent_type, granted, granted_at, revoked_at FROM core.employee_consents
        WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.params.employeeId]);
    res.json({ employee_id: req.params.employeeId, consents: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, hasConsent, requireConsent, DEFAULT_TYPE };
