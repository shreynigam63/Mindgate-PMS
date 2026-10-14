// The MoM tab, parts 2 and 3 (14 Oct specification, changed by the client
// the same day: "transcription should be uploaded from the recording of
// Google Meet and not done on the server").
//
// Part 2 — the PMS records the call's audio in the manager's browser, with
// every attendee's acceptance of a recording notice first. The audio is
// uploaded in pieces while the call runs, so a closed tab or a dropped
// network loses seconds, not the meeting. Each piece is stored encrypted
// on the server's disk (mom-store.js); the rows here say where.
//
// Part 3 — Google Meet transcribes the call. The manager downloads the
// transcript Meet saves to their Drive and uploads it here; the PMS's AI
// service drafts the MoM from it. No speech-to-text runs on the server.
//
//   mom_uploads       a recording on its way in: pieces received so far
//   mom_recordings    the one recording a connect keeps, until it expires
//   mom_transcripts   the uploaded Google Meet transcript, until it expires
async function up(db) {
  // "recording consent per employee (accepted on, version of notice)".
  await db.query(`ALTER TABLE core.employee_consents ADD COLUMN IF NOT EXISTS notice_version text`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_uploads (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    meeting_id  uuid NOT NULL REFERENCES pms.mom_meetings(id) ON DELETE CASCADE,
    source      text NOT NULL CHECK (source IN ('browser','file')),
    mime        text NOT NULL,
    file_name   text,
    key_id      text NOT NULL,
    chunks      int NOT NULL DEFAULT 0,
    bytes       bigint NOT NULL DEFAULT 0,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','abandoned')),
    started_by  text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    last_chunk_at timestamptz
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS mom_uploads_open ON pms.mom_uploads (tenant_id, status)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_recordings (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    meeting_id   uuid NOT NULL UNIQUE REFERENCES pms.mom_meetings(id) ON DELETE CASCADE,
    upload_id    uuid NOT NULL,
    mime         text NOT NULL,
    size_bytes   bigint NOT NULL,
    duration_sec int,
    key_id       text NOT NULL,
    source       text NOT NULL,
    uploaded_by  text NOT NULL,
    uploaded_at  timestamptz NOT NULL DEFAULT now(),
    delete_after date NOT NULL,
    deleted_at   timestamptz
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_transcripts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL,
    meeting_id   uuid NOT NULL UNIQUE REFERENCES pms.mom_meetings(id) ON DELETE CASCADE,
    text         text,
    language     text,
    speakers     text[] NOT NULL DEFAULT '{}',
    source       text NOT NULL CHECK (source IN ('google_meet','paste')),
    file_name    text,
    uploaded_by  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    delete_after date NOT NULL,
    deleted_at   timestamptz
  )`);

  // The AI draft's run: how many tries, since when, and why the last failed.
  await db.query(`ALTER TABLE pms.mom_meetings ADD COLUMN IF NOT EXISTS draft_attempts int NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE pms.mom_meetings ADD COLUMN IF NOT EXISTS draft_error text`);
  await db.query(`ALTER TABLE pms.mom_meetings ADD COLUMN IF NOT EXISTS processing_since timestamptz`);
  // What the AI drafted from: the transcript, the stored draft (agentic.drafts
  // holds its input and output), and its notes for the organiser.
  await db.query(`ALTER TABLE pms.mom_minutes ADD COLUMN IF NOT EXISTS transcript_id uuid`);
  await db.query(`ALTER TABLE pms.mom_minutes ADD COLUMN IF NOT EXISTS ai_draft_id uuid`);
  await db.query(`ALTER TABLE pms.mom_minutes ADD COLUMN IF NOT EXISTS ai_notes jsonb`);
}

module.exports = { up };
