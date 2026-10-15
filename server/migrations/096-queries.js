// Queries (15 Oct: "Appraisal Queries" becomes "Queries").
//
// A query now names WHOM it is raised to: one or more colleagues, picked
// by name or email, who are told in the app and by email and can answer
// it. People Hub → Queries shows what you raised and what was raised to
// you. HR's inbox of every query is its own page in the HR tab, and a
// query raised to someone in HR is answered there, not from People Hub.
//
// The table keeps its old name: the rows in it are the same queries.
//   appraisal_query_recipients   who a query is raised to. None means HR.
const PAGES = [
  ['hr_queries', '/admin/queries', 'people_admin'],
];

async function ensureQueryPages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenantId, page, route, perm]);
  }
}

async function up(db) {
  await db.query(`ALTER TABLE people.appraisal_queries ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await db.query(`ALTER TABLE people.appraisal_queries ADD COLUMN IF NOT EXISTS closed_at timestamptz`);
  await db.query(`ALTER TABLE people.appraisal_queries ADD COLUMN IF NOT EXISTS closed_by uuid`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.appraisal_query_recipients (
    tenant_id   uuid NOT NULL,
    query_id    uuid NOT NULL REFERENCES people.appraisal_queries(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    PRIMARY KEY (query_id, employee_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS appraisal_query_recipients_emp ON people.appraisal_query_recipients (tenant_id, employee_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS appraisal_queries_emp ON people.appraisal_queries (tenant_id, employee_id)`);
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await ensureQueryPages(db, id);
}

module.exports = { up, ensureQueryPages, PAGES };
