// The MoM tab (14 Oct, "MoM Tab – PMS Build Specification"), part 1:
// each team's daily connect on one fixed Google Meet link, the minutes
// written in the PMS, and the action items tracked until they close.
// Recording, transcription and the AI draft come in parts 2 and 3; the
// columns they fill are already here so nothing is re-shaped later.
//
// A TEAM is a manager and their direct reports — the PMS has no other
// team record. HR switches a team on (the client chose a pilot rather
// than every team at once); until then it gets no daily connects.
//
//   mom_teams         the manager's fixed Meet link, daily time, attendees
//   mom_meetings      one per team per working day (and any other type)
//   mom_minutes       the MoM itself, one per meeting
//   mom_versions      every publish, kept readable (v1, v2, …)
//   mom_action_items  tasks with an owner and a due date, carried forward
//                     into the team's next MoM until done
//   mom_acks          attendees' acknowledgements, per version
async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_teams (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    manager_id  uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    meet_link   text,
    daily_time  text NOT NULL DEFAULT '10:00' CHECK (daily_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    duration_min int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 240),
    -- NULL = the manager's direct reports as they are on the day.
    attendee_ids uuid[],
    enabled     boolean NOT NULL DEFAULT false,
    updated_by  text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mom_teams_one_per_manager UNIQUE (tenant_id, manager_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_meetings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    team_id       uuid NOT NULL REFERENCES pms.mom_teams(id) ON DELETE CASCADE,
    type          text NOT NULL DEFAULT 'daily_connect',
    title         text NOT NULL,
    organiser_id  uuid REFERENCES core.employees(id) ON DELETE SET NULL,
    attendee_ids  uuid[] NOT NULL DEFAULT '{}',
    meeting_date  date NOT NULL,
    start_time    text,
    end_time      text,
    meet_link     text,
    status        text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','processing','draft_ready','published','missing','cancelled')),
    cancel_reason text,
    reminded_at   timestamptz,
    missing_notified_at timestamptz,
    created_by    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mom_meetings_one_a_day UNIQUE (team_id, meeting_date, type)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS mom_meetings_date ON pms.mom_meetings (tenant_id, meeting_date DESC)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_minutes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    meeting_id    uuid NOT NULL UNIQUE REFERENCES pms.mom_meetings(id) ON DELETE CASCADE,
    version       int NOT NULL DEFAULT 0,
    summary       text,
    discussion    jsonb NOT NULL DEFAULT '[]'::jsonb,
    decisions     jsonb NOT NULL DEFAULT '[]'::jsonb,
    blockers      jsonb NOT NULL DEFAULT '[]'::jsonb,
    attendance    jsonb NOT NULL DEFAULT '{}'::jsonb,
    carried_forward jsonb NOT NULL DEFAULT '[]'::jsonb,
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    source        text NOT NULL DEFAULT 'manual',
    ai_confidence text,
    published_by  text,
    published_at  timestamptz,
    updated_by    text,
    updated_at    timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_versions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    minutes_id  uuid NOT NULL REFERENCES pms.mom_minutes(id) ON DELETE CASCADE,
    version     int NOT NULL,
    snapshot    jsonb NOT NULL,
    changed     text[] NOT NULL DEFAULT '{}',
    changed_by  text NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mom_versions_once UNIQUE (minutes_id, version)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_action_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    minutes_id  uuid NOT NULL REFERENCES pms.mom_minutes(id) ON DELETE CASCADE,
    team_id     uuid NOT NULL REFERENCES pms.mom_teams(id) ON DELETE CASCADE,
    task        text NOT NULL CHECK (btrim(task) <> ''),
    owner_id    uuid REFERENCES core.employees(id) ON DELETE SET NULL,
    due_date    date,
    priority    text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
    closed_on   date,
    closed_by   text,
    carried_forward_count int NOT NULL DEFAULT 0,
    due_reminded_on date,
    overdue_reminded_on date,
    manager_alerted_on date,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS mom_action_items_open ON pms.mom_action_items (tenant_id, team_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS mom_action_items_owner ON pms.mom_action_items (tenant_id, owner_id, status)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.mom_acks (
    tenant_id   uuid NOT NULL,
    minutes_id  uuid NOT NULL REFERENCES pms.mom_minutes(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    version     int NOT NULL,
    comment     text,
    acknowledged_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (minutes_id, employee_id, version)
  )`);
}

module.exports = { up };
