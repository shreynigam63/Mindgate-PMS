// Onboarding emails go TO THE JOINER, FROM the SPOC who owns the activity.
//
// Corrected on 7 Oct: "1st week onboarding mails should be shooted to new
// joiner from certain spoc persons owning the certain activity … these
// spoc emails should be the email ids from whom particular mails should be
// shooted to new joiners as per owner and activity." 082 had it the other
// way round — mailing the SPOC about the joiner.
//
// sender_role, per activity: the role named FIRST in the workbook's Owner
// column, because that is who owns it. "HR Ops → IT" is HR Ops' activity
// (they get IT to act), so HR Ops writes to the joiner. "Manager/SME" is the
// manager's. Manager and Buddy resolve to the joiner's own manager and buddy;
// every other role to the SPOCs list. 082's spoc_roles column is left in
// place, unused, rather than dropped: it is history, not harm.
//
// personal_email: a joiner usually has no working company mailbox before
// Day 1, so Pre-Day 1 mails go to a personal address when HR has one.
//
// Also: "Checkbox … should be managed by HR Ops team and accessible to HRBP
// and HRs." That is a permission, onboarding_ops, held by a new hr_ops role
// and added to the hr and hrbp bundles (002). An hr_ops person reaches the
// tracker on its own page, /hrops/onboarding, registered here.

const SENDER = {
  1: 'Recruiter', 2: 'Recruiter', 3: 'HR Ops', 4: 'HR Ops', 5: 'HR Ops', 6: 'HR Ops',
  7: 'HR Ops', 8: 'HR Ops', 9: 'HR Ops', 10: 'Admin', 11: 'IT', 12: 'Manager', 13: 'Manager',
  14: 'Buddy', 15: 'Recruiter', 16: 'HR',
  17: 'HRBP', 18: 'HRBP', 19: 'HR Ops', 20: 'HRBP', 21: 'HR',
  22: 'Manager', 23: 'Manager', 24: 'Manager', 25: 'Manager', 26: 'Manager', 27: 'Manager', 28: 'Manager',
  29: 'IT', 30: 'Manager', 31: 'Manager', 32: 'Manager', 33: 'IT', 34: 'Manager',
  35: 'Manager', 36: 'Manager', 37: 'Buddy', 38: 'HR',
  39: 'HRBP', 40: 'HRBP', 41: 'L&D', 42: 'Manager', 43: 'Manager',
  44: 'HR', 45: 'Manager', 46: 'HR', 47: 'HR', 48: 'Manager',
};

// Boot-time too (index.js) — the core.tenants trap. Fills only rows with
// none, so a sender HR changed is never put back.
async function ensureSenders(db, tenantId) {
  for (const [code, role] of Object.entries(SENDER)) {
    await db.query(
      `UPDATE people.onboarding_activities SET sender_role=$3
        WHERE tenant_id=$1 AND code=$2 AND sender_role IS NULL`, [tenantId, Number(code), role]);
  }
  await db.query(
    `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
     VALUES ($1,'hrops_onboarding','/hrops/onboarding','onboarding_ops')
     ON CONFLICT (tenant_id, page) DO NOTHING`, [tenantId]);
}

async function up(db) {
  await db.query(`ALTER TABLE people.onboarding_activities ADD COLUMN IF NOT EXISTS sender_role text`);
  await db.query(`ALTER TABLE people.onboarding_joiners ADD COLUMN IF NOT EXISTS personal_email text`);
  await db.query(`ALTER TABLE people.onboarding_task_emails ADD COLUMN IF NOT EXISTS from_email text`);
  await db.query(`ALTER TABLE people.onboarding_task_emails ADD COLUMN IF NOT EXISTS sender_role text`);
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await ensureSenders(db, id);
    for (const [role, perm] of [['hr', 'onboarding_ops'], ['hrbp', 'onboarding_ops'],
      ['hr_ops', 'onboarding_ops'], ['hr_ops', 'pms_self'], ['hr_ops', 'engagement_take'], ['hr_ops', 'people_view']]) {
      await db.query(`INSERT INTO core.role_permissions (tenant_id, role, permission) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, role, perm]);
    }
  }
}

module.exports = { up, ensureSenders, SENDER };
