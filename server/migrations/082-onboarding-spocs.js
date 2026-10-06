// Emailing the SPOC of an onboarding task.
//
// Asked for on 6 Oct, pointing at the First-Week Journey: "steps are only
// viewable and clickable, we need to create it in such a way that
// clicking on each option should initiate email to particular spoc
// working for that task."
//
// TWO THINGS ARE NEEDED to know where a task's email goes:
//
//   1. WHO, per activity — spoc_roles. The workbook's Owner column says it
//      in prose ("HR Ops to IT", "Hrops on the mail of recruiter"); this
//      is the same thing as a list of roles, read row by row. Where the
//      owner is "A to B" the mail goes to B, the one doing the work.
//   2. THE ADDRESS, per role. Three roles are the joiner's own people and
//      come from their record: Manager (the employee master), Buddy, and
//      HR (the joiner's HR POC when one is set). The rest — Recruiter,
//      HR Ops, HRBP, IT, Admin, SME, L&D — are company-wide desks, kept in
//      people.onboarding_spocs and set by HR. Nothing is seeded there: an
//      address nobody gave us would be dummy data, and a task whose SPOC
//      is unset says so on screen rather than mailing nobody.
//
// Every email sent is kept (people.onboarding_task_emails), so "was IT
// told about this laptop" is a query, not a search through inboxes.

const ROLES = ['Recruiter', 'HR Ops', 'HR', 'HRBP', 'IT', 'Admin', 'Manager', 'Buddy', 'SME', 'L&D'];
// Roles answered from the joiner's own record rather than the directory.
const PER_JOINER = ['Manager', 'Buddy'];

// activity code -> roles the task email goes to. Read from the workbook's
// Owner column, one row at a time.
const SPOC_ROLES = {
  1: ['Recruiter'], 2: ['Recruiter'], 3: ['HR Ops'], 4: ['IT'], 5: ['Admin'], 6: ['HR Ops'],
  7: ['HR Ops'], 8: ['HR Ops'], 9: ['HR Ops'], 10: ['Admin'], 11: ['IT'], 12: ['Manager'], 13: ['Manager'],
  14: ['Buddy'], 15: ['Recruiter'], 16: ['HR'],
  17: ['HRBP'], 18: ['HRBP'], 19: ['HR Ops'], 20: ['HRBP'], 21: ['HR'],
  22: ['Manager'], 23: ['Manager'], 24: ['Manager'], 25: ['Manager'], 26: ['Manager'], 27: ['Manager', 'SME'], 28: ['Manager'],
  29: ['IT', 'Manager'], 30: ['Manager', 'SME'], 31: ['Manager'], 32: ['Manager', 'Buddy'], 33: ['IT'], 34: ['Manager'],
  35: ['Manager'], 36: ['Manager'], 37: ['Buddy'], 38: ['HR'],
  39: ['HRBP'], 40: ['HRBP'], 41: ['L&D'], 42: ['Manager'], 43: ['Manager'],
  44: ['HR'], 45: ['Manager'], 46: ['HR'], 47: ['HR', 'IT', 'Manager'], 48: ['Manager'],
};

// Also called at boot (index.js) — the core.tenants trap: a tenant made
// after migrations ran would otherwise have activities with no SPOCs.
// Fills only rows with none, so a mapping HR changed is never put back.
async function ensureSpocRoles(db, tenantId) {
  for (const [code, roles] of Object.entries(SPOC_ROLES)) {
    await db.query(
      `UPDATE people.onboarding_activities SET spoc_roles=$3
        WHERE tenant_id=$1 AND code=$2 AND (spoc_roles IS NULL OR cardinality(spoc_roles)=0)`,
      [tenantId, Number(code), roles]);
  }
}

async function up(db) {
  await db.query(`ALTER TABLE people.onboarding_activities ADD COLUMN IF NOT EXISTS spoc_roles text[]`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_spocs (
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id),
    role       text NOT NULL,
    name       text,
    email      text NOT NULL CHECK (email ~ '^[^@\\s]+@[^@\\s]+$'),
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, role)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS people.onboarding_task_emails (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id),
    task_id    uuid NOT NULL REFERENCES people.onboarding_tasks(id) ON DELETE CASCADE,
    to_emails  text[] NOT NULL,
    subject    text NOT NULL,
    mode       text NOT NULL,
    outcome    text NOT NULL,
    sent_by    text NOT NULL,
    sent_at    timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_onb_task_emails ON people.onboarding_task_emails(tenant_id, task_id)`);
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await ensureSpocRoles(db, id);
}

module.exports = { up, ensureSpocRoles, SPOC_ROLES, ROLES, PER_JOINER };
