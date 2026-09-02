// 003 — Performance & Growth schema (module: performance).
// Faithful to the AH pms.* structures per the spec (§3), adapted: tenant_id
// everywhere, uuid PKs, and the employee references point at the core
// mirror. Idempotent throughout.

module.exports.up = async (db) => {
  await db.query(`CREATE SCHEMA IF NOT EXISTS pms`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.cycles (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    name          text NOT NULL,
    fiscal_year   text NOT NULL,
    cycle_type    text NOT NULL DEFAULT 'annual',   -- annual | midyear
    phase         text NOT NULL DEFAULT 'draft',
    -- draft|kra_open|self_appraisal|manager_eval|hod_eval|calibration|publish|closed|cancelled
    rating_scale  jsonb NOT NULL DEFAULT '[{"value":1,"label":"Needs Improvement"},{"value":2,"label":"Developing"},{"value":3,"label":"Meets Expectations"},{"value":4,"label":"Exceeds"},{"value":5,"label":"Outstanding"}]',
    bell_curve    jsonb NOT NULL DEFAULT '{"1":5,"2":15,"3":55,"4":20,"5":5}',
    phase_windows jsonb NOT NULL DEFAULT '{}',
    opens_at      date, closes_at date,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cycles_tenant ON pms.cycles(tenant_id, phase)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.kra_sheets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL,
    manager_id  uuid,
    status      text NOT NULL DEFAULT 'draft',  -- draft | submitted | approved | returned
    manager_comment text,
    submitted_at timestamptz, decided_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.kras (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    sheet_id    uuid NOT NULL REFERENCES pms.kra_sheets(id) ON DELETE CASCADE,
    title       text NOT NULL,
    description text,
    weight      numeric(5,2) NOT NULL DEFAULT 0,
    measures    text,
    sort_order  integer NOT NULL DEFAULT 10
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_kras_sheet ON pms.kras(sheet_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.self_appraisals (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL,
    status      text NOT NULL DEFAULT 'not_started', -- not_started|in_progress|submitted
    entries     jsonb NOT NULL DEFAULT '{}',          -- kra_id -> {self_rating, narrative}
    overall_self_rating numeric(3,1),
    went_well   text, could_improve text,
    submitted_at timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.evidence (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    appraisal_id uuid NOT NULL REFERENCES pms.self_appraisals(id) ON DELETE CASCADE,
    kra_id      uuid,
    filename    text NOT NULL,
    storage_key text NOT NULL,
    uploaded_at timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.manager_evaluations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL,
    manager_id  uuid NOT NULL,
    status      text NOT NULL DEFAULT 'pending',     -- pending|submitted
    entries     jsonb NOT NULL DEFAULT '{}',          -- kra_id -> {rating, comment}
    overall_rating numeric(3,1),
    strengths   text, improvement_areas text,
    submitted_at timestamptz,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.hod_evaluations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL,
    hod_id      uuid NOT NULL,
    status      text NOT NULL DEFAULT 'pending',
    overall_rating numeric(3,1),
    comment     text,
    submitted_at timestamptz,
    UNIQUE (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.calibration_sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL,
    cycle_id   uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    name       text NOT NULL,
    department text,
    status     text NOT NULL DEFAULT 'open',  -- open | closed
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  // The audit answer to "why did my rating change": explicit, reasoned rows.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.rating_adjustments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL,
    employee_id uuid NOT NULL,
    session_id  uuid REFERENCES pms.calibration_sessions(id),
    from_rating numeric(3,1), to_rating numeric(3,1) NOT NULL,
    reason      text NOT NULL,
    adjusted_by text NOT NULL,
    at          timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.top_talent (
    tenant_id uuid NOT NULL, cycle_id uuid NOT NULL, employee_id uuid NOT NULL,
    potential_rating text, nine_box_cell text, noted_by text, at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.pip_records (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL, employee_id uuid NOT NULL, cycle_id uuid,
    status text NOT NULL DEFAULT 'open', -- open|in_progress|closed_successful|closed_unsuccessful
    plan text, opened_by text, opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.connects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL, manager_id uuid NOT NULL, employee_id uuid NOT NULL,
    held_at date NOT NULL, notes text, kra_ids uuid[] DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.employee_performance_history (
    tenant_id uuid NOT NULL, employee_id uuid NOT NULL, cycle_id uuid NOT NULL,
    final_rating numeric(3,1) NOT NULL, rating_label text,
    published_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (employee_id, cycle_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.closure_letters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL, cycle_id uuid NOT NULL, employee_id uuid NOT NULL,
    storage_key text, generated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.dropdown_options (
    tenant_id uuid NOT NULL, category text NOT NULL, value text NOT NULL,
    sort_order integer NOT NULL DEFAULT 10, active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id, category, value)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.audit_log (
    id bigserial PRIMARY KEY, tenant_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
    actor_email text, action text NOT NULL, cycle_id uuid, employee_id uuid, details jsonb
  )`);
};
