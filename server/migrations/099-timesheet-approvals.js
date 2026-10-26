// Timesheet approvals (26 Oct).
//
// "Once uploaded by HR, manager should have approval option for editing
// ratings generated per system and approve timesheet uploaded on system.
// In case manager is not approving the timesheet after cutoff time, these
// data should be received on upper level manager as per reporting matrix
// ... For manager there will be one system generated KRA title as
// 'Timesheet Approval'." Decided with the client the same day:
//   * the cutoff is N working days after HR's upload (HR sets N, default 5),
//     and the upper manager then has N more;
//   * a missed cutoff changes nothing about the employee's own rating —
//     it is the manager's "Timesheet Approval" KRA that shows it;
//   * that KRA is a fixed 10% of the manager's sheet.
//
// ONE ROW PER PERSON PER MONTH (the compliance cycle), created when HR's
// upload first carries logs for that month and reset to pending when a
// later upload changes it. The manager and upper manager are copied in at
// upload time: the clock and the person it runs for are decided then, not
// re-derived from a reporting line that may change before the cutoff.
//
// kra_overrides holds the manager's edits to the system's per-KRA ratings
// for the month: { kra_id: { rating, reason } }; month_override the edit
// to the month's average rating. The system figures are never overwritten —
// both are shown, so an edit is visible as an edit.
async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.timesheet_approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    period_start date NOT NULL,
    period_end date NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    manager_id uuid,
    due_on date NOT NULL,
    upper_manager_id uuid,
    escalation_due_on date NOT NULL,
    approved_at timestamptz,
    approved_by_id uuid,
    approved_by_email text,
    approved_as text CHECK (approved_as IS NULL OR approved_as IN ('manager','upper_manager','hrbp','hr')),
    on_time_by_manager boolean NOT NULL DEFAULT false,
    kra_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
    month_override jsonb,
    note text,
    escalation_notified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, employee_id, period_start))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_approvals_manager
                    ON pms.timesheet_approvals (tenant_id, manager_id, period_start)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_approvals_upper
                    ON pms.timesheet_approvals (tenant_id, upper_manager_id, period_start)`);
  // A KRA the system put on a sheet, and why. 'timesheet_approval' is the
  // manager's "Timesheet Approval" KRA, rated from this table rather than
  // from logged hours.
  await db.query(`ALTER TABLE pms.kras ADD COLUMN IF NOT EXISTS system_kind text`);
}

module.exports = { up };
