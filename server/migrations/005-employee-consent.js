// 005 — Employee consent capture (BRD §6 NFR: "explicit employee consent
// required before any meeting recording/transcription is used for AI
// insights"; project plan: "prevent meeting-based features from running
// without it").
//
// Consent is a STANDING employee preference, not tied to a single cycle —
// it belongs in core (next to core.employees), the same way a person's
// email or department does not reset each performance cycle. Any future
// meeting-recording/transcription/calendar-pull feature is required to
// call core/consent.js's requireConsent() before it runs; this migration
// just lays down the table and the audit trail for grants/revocations.
//
// One row per (tenant, employee, consent_type) so additional consent types
// (e.g. a future "calendar_read" scope, separate from "recording") can be
// added without a schema change — only a new consent_type value.

module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS core.employee_consents (
    tenant_id     uuid NOT NULL,
    employee_id   uuid NOT NULL,
    consent_type  text NOT NULL DEFAULT 'meeting_ai_insights',
    -- meeting_ai_insights: recording/transcription of 1-on-1s for AI-assisted
    -- theme/sentiment extraction and calendar-based discussion-point pulls.
    granted       boolean NOT NULL DEFAULT false,
    granted_at    timestamptz,
    revoked_at    timestamptz,
    updated_by    text NOT NULL,   -- the acting user's email; normal flow is the employee themself
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, employee_id, consent_type)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_consents_tenant_emp ON core.employee_consents(tenant_id, employee_id)`);

  // Marks a connect log as populated from a recorded/transcribed meeting or
  // a calendar/meeting-tool pull, as opposed to typed in directly — this is
  // exactly the distinction the consent gate above needs to enforce.
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS meeting_based boolean NOT NULL DEFAULT false`);
};
