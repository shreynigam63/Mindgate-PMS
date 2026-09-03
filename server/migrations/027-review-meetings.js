// 027 — meetings and their transcripts.
//
// PROVISION ONLY. The client was explicit: keep the provision for
// integrating Google Meet, but strictly do not connect it now. So this
// migration adds the shape a meeting integration needs and nothing that
// talks to Google: no OAuth tokens, no calendar identifiers we cannot yet
// populate, no dependency. Today a link is pasted by a human; when Meet is
// connected, the same rows get filled by a provider instead. That is the
// whole point of putting the table in now — connecting Meet later becomes
// an implementation, not a redesign.
//
// ONE TABLE FOR ALL THREE CONTEXTS. The request named one-on-one connects,
// the mid-year review and the annual appraisal. Three columns on three
// different tables would mean three sets of routes, three permission
// checks and three places to change when a provider arrives — so meetings
// live in one table keyed by (context, ref_id) instead.
//
// provider is text, not an enum: 'manual' today, 'google_meet' later, and
// an enum would need a migration to add each one for no benefit. The set
// that is actually accepted is enforced in core/meetings.js, where it can
// also say WHY a provider is unavailable.
//
// TRANSCRIPTS ARE SEPARATE FROM MEETINGS, and deliberately so. A meeting
// is a link and a time — harmless. A transcript is a recording of two
// people talking about someone's performance, it exists only with that
// employee's consent (core/consent.js, which was written for this), and it
// is the row that would have to be deleted on a GDPR erasure. Keeping it
// in its own table means "delete the transcripts, keep the schedule" is a
// single statement rather than a careful UPDATE.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.review_meetings (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    cycle_id     uuid,
    employee_id  uuid NOT NULL,
    -- 'connect' | 'midyear' | 'annual'
    context      text NOT NULL,
    -- the row this meeting is about: a pms.connects id for a connect, the
    -- cycle's check-in/appraisal for the other two. Nullable because a
    -- meeting can be scheduled before the row it will be about exists.
    ref_id       uuid,
    provider     text NOT NULL DEFAULT 'manual',
    meeting_url  text,
    scheduled_at timestamptz,
    -- The provider's own id for the event, once there is a provider. Unused
    -- today; present so a later integration has somewhere to put it without
    -- another migration during a deploy.
    external_event_id text,
    created_by   uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_meetings_employee
    ON pms.review_meetings (tenant_id, employee_id, context)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_meetings_ref
    ON pms.review_meetings (tenant_id, context, ref_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.meeting_transcripts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    meeting_id   uuid NOT NULL REFERENCES pms.review_meetings(id) ON DELETE CASCADE,
    provider     text NOT NULL DEFAULT 'manual',
    external_transcript_id text,
    content      text NOT NULL,
    -- WHO the consent came from and WHEN it was checked, recorded on the
    -- row itself. core.employee_consents holds the live answer, but a
    -- transcript captured a year ago needs to show that consent existed AT
    -- CAPTURE TIME — a later revocation must not make the record look as
    -- though it was taken without permission, and a later grant must not
    -- retroactively excuse one that was.
    consent_employee_id uuid NOT NULL,
    consent_checked_at  timestamptz NOT NULL DEFAULT now(),
    captured_by  uuid,
    captured_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (meeting_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_meeting_transcripts_tenant
    ON pms.meeting_transcripts (tenant_id)`);
};
