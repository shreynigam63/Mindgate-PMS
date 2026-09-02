// 009 — Development Plan / Org IDP (BR-2.1/2.2/2.3).
//
// FOUND MISSING 28-Aug-2026: the project plan and CONTEXT.md both marked
// this "Completed" and it appeared nowhere — no table, no route, no
// frontend page. This migration and the routes/frontend built alongside
// it are the actual, first implementation.
//
// Mirrors the KRA sheet structure deliberately (pms.kra_sheets/pms.kras)
// for the same reason it exists there: employee drafts -> manager
// approves/returns -> tracked, one plan per employee per cycle, opened at
// the same point in the cycle as KRA setting (phase-machine.js's kra_open
// window, new devplan_* action names within it).

module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.development_plans (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL,
    cycle_id        uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id     uuid NOT NULL,
    manager_id      uuid,
    status          text NOT NULL DEFAULT 'draft',  -- draft | submitted | approved | returned
    manager_comment text,
    submitted_at    timestamptz, decided_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.development_goals (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    plan_id       uuid NOT NULL REFERENCES pms.development_plans(id) ON DELETE CASCADE,
    title         text NOT NULL,
    description   text,
    target_date   date,
    progress_pct  integer NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
    sort_order    integer NOT NULL DEFAULT 10
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_devgoals_plan ON pms.development_goals(plan_id)`);

  // people.career_paths (migration 004) had no unique constraint on
  // (tenant_id, employee_id) — found while adding the employee-facing
  // career-path routes alongside Development Plan; without this, an
  // ON CONFLICT upsert for "set my career path" has nothing to conflict
  // against and fails at runtime. Adding it here rather than editing
  // migration 004 (already-run migrations are never rewritten). Postgres
  // has no ADD CONSTRAINT IF NOT EXISTS, so check pg_constraint first —
  // this migration file itself only ever runs once per tenant DB anyway
  // (migrations/runner tracks it by filename), but a manual re-apply
  // during development must not error on a constraint that already exists.
  const exists = await db.query(
    `SELECT 1 FROM pg_constraint WHERE conname='uq_career_paths_tenant_employee'`);
  if (!exists.rows.length) {
    await db.query(`ALTER TABLE people.career_paths ADD CONSTRAINT uq_career_paths_tenant_employee UNIQUE (tenant_id, employee_id)`);
  }
};
