// 053 — timesheets.
//
// Asked for on 25 Sep with two files attached: a Zoho Sprints timesheet
// export and a compliance dashboard built from it.
//
//   "1: only upload option and their own report should be available for
//    employees and upload option should be available in 'self' tab.
//    2: dashboard attached in second HTML file should be available under
//    'manager' tab for reportees reporting to particular Manager.
//    3: under 'HR' tab dashboard for all employees should be available.
//    4: please create one tab naming 'timesheet' for all three tabs."
//
// TWO TABLES, and the reason for the split:
//
//   timesheet_batches   one row per upload. Who uploaded it, which file,
//                       which project, and the date range it covers.
//                       Without it there is no way to answer "where did
//                       this row come from" or to undo one upload.
//   timesheet_entries   one row per log line. Resolved to an employee at
//                       upload time, because every read is per person and
//                       matching 40k rows on an email string at read time
//                       is the wrong trade.
//
// THE ENTRY IS NOT UNIQUE ON (employee, date). Two logs on one day
// against two items is the normal case in the source data — the whole
// point of the compliance rule is that a day counts as filled when at
// least ONE log exists, not exactly one.
//
// RE-UPLOAD REPLACES A WINDOW, not the world. Committing a batch deletes
// that employee's existing entries between the file's first and last log
// date and inserts the file's. Re-uploading the same export twice is
// therefore a no-op, and uploading September does not silently erase
// August. Mirrors the KRA library's "an upload replaces what is in the
// file", which HR already knows.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.timesheet_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    uploaded_by_email text NOT NULL,
    source_file text,
    project_name text,
    team_name text,
    exported_on text,
    rows_loaded int NOT NULL DEFAULT 0,
    employees_touched int NOT NULL DEFAULT 0,
    first_log_date date,
    last_log_date date,
    created_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_batches_tenant
                    ON pms.timesheet_batches (tenant_id, created_at DESC)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.timesheet_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    batch_id uuid NOT NULL REFERENCES pms.timesheet_batches(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    -- Kept alongside employee_id on purpose: the export's own spelling of
    -- the owner is what a person will search for when a row looks wrong,
    -- and the employee record may be renamed later.
    owner_name text,
    owner_email text,
    log_date date NOT NULL,
    hours numeric(6,2) NOT NULL DEFAULT 0,
    item_id text,
    item_name text,
    item_type text,
    sprint text,
    log_type text,
    description text,
    billing_status text,
    approval_status text,
    approved_by text,
    logged_on text,
    project_name text,
    created_at timestamptz NOT NULL DEFAULT now())`);
  // The shape of every read: one employee, one date range.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_entries_emp_date
                    ON pms.timesheet_entries (tenant_id, employee_id, log_date)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_entries_date
                    ON pms.timesheet_entries (tenant_id, log_date)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_entries_batch
                    ON pms.timesheet_entries (batch_id)`);

  // THREE PAGES, three permissions — the same shape as 050.
  //   /my/timesheet    public: upload and your own report. An employee
  //                    must be able to reach their own page.
  //   /team/timesheet  pms_team_eval, like every other Manager page.
  //   /admin/timesheet pms_admin, like every other HR dashboard.
  const ADD = [
    ['my_timesheet',    '/my/timesheet',    null],
    ['team_timesheet',  '/team/timesheet',  'pms_team_eval'],
    ['hr_timesheet',    '/admin/timesheet', 'pms_admin'],
  ];
  const tenants = (await db.query(`SELECT DISTINCT tenant_id FROM core.page_permission`)).rows;
  for (const { tenant_id } of tenants) {
    for (const [page, route, perm] of ADD) {
      await db.query(
        `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenant_id, page, route, perm]);
    }
  }
};
