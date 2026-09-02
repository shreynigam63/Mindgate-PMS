// 022 — Career Pathing Matrix (CR-11 richer guardrails, phase 1 of 2).
//
// Requested with reference screenshots of a richer transition-based model
// than the simple role_band/level list in people.career_matrix (built the
// round before this one): specific FROM-role/level -> TO-role/level
// transitions, each with its own expected level change, time-in-role
// figures, required competencies, and notes.
//
// Scope explicitly agreed before building: min_time_months and
// typical_time_months are stored and shown, but NOT enforced — there is
// no field anywhere tracking when an employee moved into their CURRENT
// role (only date_of_joining, which is company tenure, not role tenure),
// so accurately enforcing a minimum time-in-role isn't possible with the
// data available today. Enforcing this later is a separate follow-up
// once role-start-date tracking exists — this migration only adds the
// storage and display, not the enforcement.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS people.career_transitions (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL,
    from_role              text NOT NULL,
    from_level             text,             -- blank/null = "any level"
    to_role                text NOT NULL,
    to_level               text,
    expected_level_change  integer,          -- usually +1 (next level) or +2 (skip)
    min_time_months        integer,          -- advisory only — not enforced, see comment above
    typical_time_months    integer,          -- advisory only — used for ETA display, not gating
    required_competencies  text[],           -- one entry per line in the UI
    notes                  text,
    active                 boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_career_transitions_tenant ON people.career_transitions(tenant_id, active)`);
};
