// 004 — Engagement + People (hrbp) schemas.
// ANONYMITY IS STRUCTURAL (spec §4): invitations and responses are separate
// tables with NO linking column for anonymous responses. Participation
// tracking (who was invited, who completed) can never de-anonymize answers:
// completion is a flag on the invitation; the response row carries
// employee_id ONLY when the respondent explicitly opted in to attribution on
// a survey that allows it. Nothing may add a join path — reviews enforce.

module.exports.up = async (db) => {
  await db.query(`CREATE SCHEMA IF NOT EXISTS engagement`);
  await db.query(`CREATE SCHEMA IF NOT EXISTS people`);

  // ---- Engagement -----------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS engagement.surveys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    title       text NOT NULL,
    survey_type text NOT NULL DEFAULT 'pulse',        -- pulse | enps | full
    description text,
    target_audience text NOT NULL DEFAULT 'all',      -- all | department:<d> | custom
    anonymity_default boolean NOT NULL DEFAULT true,
    allow_attribution_optin boolean NOT NULL DEFAULT true,
    opens_at    timestamptz NOT NULL DEFAULT now(),
    closes_at   timestamptz,
    status      text NOT NULL DEFAULT 'draft',        -- draft | open | closed | archived
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS engagement.questions (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    survey_id uuid NOT NULL REFERENCES engagement.surveys(id) ON DELETE CASCADE,
    qtype     text NOT NULL DEFAULT 'scale',          -- scale | enps | text | choice
    prompt    text NOT NULL,
    options   jsonb,                                   -- for choice
    required  boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 10
  )`);

  // Who was asked + whether they completed. NEVER what they answered.
  await db.query(`CREATE TABLE IF NOT EXISTS engagement.invitations (
    tenant_id   uuid NOT NULL,
    survey_id   uuid NOT NULL REFERENCES engagement.surveys(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL,
    invited_at  timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (survey_id, employee_id)
  )`);

  // Answers. employee_id populated ONLY on explicit opt-in attribution.
  await db.query(`CREATE TABLE IF NOT EXISTS engagement.responses (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    survey_id   uuid NOT NULL REFERENCES engagement.surveys(id) ON DELETE CASCADE,
    employee_id uuid,                                  -- NULL = anonymous (the default)
    submitted_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS engagement.answers (
    response_id uuid NOT NULL REFERENCES engagement.responses(id) ON DELETE CASCADE,
    question_id uuid NOT NULL REFERENCES engagement.questions(id) ON DELETE CASCADE,
    value_num   numeric,
    value_text  text,
    PRIMARY KEY (response_id, question_id)
  )`);

  // ---- People ---------------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS people.award_programs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    name text NOT NULL, description text, active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.award_cycles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    program_id uuid NOT NULL REFERENCES people.award_programs(id) ON DELETE CASCADE,
    name text NOT NULL, status text NOT NULL DEFAULT 'open',   -- open | judging | announced
    opens_at date, closes_at date
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.award_nominations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    cycle_id uuid NOT NULL REFERENCES people.award_cycles(id) ON DELETE CASCADE,
    nominee_id uuid NOT NULL, nominated_by uuid NOT NULL,
    citation text NOT NULL,
    status text NOT NULL DEFAULT 'submitted',  -- submitted | shortlisted | won | not_selected
    decided_by text, decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS people.events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    title text NOT NULL, description text, location text,
    starts_at timestamptz NOT NULL, ends_at timestamptz,
    created_by text, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.event_rsvps (
    tenant_id uuid NOT NULL, event_id uuid NOT NULL REFERENCES people.events(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL, response text NOT NULL DEFAULT 'yes',   -- yes | no | maybe
    at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS people.csr_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    title text NOT NULL, description text, event_date date, hours_credit numeric(5,2) DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.csr_participations (
    tenant_id uuid NOT NULL, csr_event_id uuid NOT NULL REFERENCES people.csr_events(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL, hours numeric(5,2), at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (csr_event_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS people.campus_drives (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    college text NOT NULL, drive_date date, roles text, status text NOT NULL DEFAULT 'planned',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.campus_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    drive_id uuid NOT NULL REFERENCES people.campus_drives(id) ON DELETE CASCADE,
    name text NOT NULL, email text, phone text, stage text NOT NULL DEFAULT 'applied',
    notes text, updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  // Appraisal queries: the rating-dispute channel, out of email.
  await db.query(`CREATE TABLE IF NOT EXISTS people.appraisal_queries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    employee_id uuid NOT NULL, cycle_id uuid, subject text NOT NULL,
    status text NOT NULL DEFAULT 'open',   -- open | answered | closed
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.appraisal_query_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    query_id uuid NOT NULL REFERENCES people.appraisal_queries(id) ON DELETE CASCADE,
    author_id uuid NOT NULL, body text NOT NULL, at timestamptz NOT NULL DEFAULT now()
  )`);

  // Career framework (shared with Performance's Growth half).
  await db.query(`CREATE TABLE IF NOT EXISTS people.career_matrix (
    tenant_id uuid NOT NULL, role_band text NOT NULL, level text NOT NULL,
    expectations text, PRIMARY KEY (tenant_id, role_band, level)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.career_paths (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
    employee_id uuid NOT NULL, target_role text, plan text,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
};
