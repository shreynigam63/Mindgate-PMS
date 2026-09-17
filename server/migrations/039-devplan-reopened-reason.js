// The same column migration 037 added to pms.kra_sheets, on the growth plan.
//
// Asked for on 17 Sep: the reopen-on-role-change behaviour documented in
// CHANGE-KRA-REOPEN-ON-ROLE-CHANGE.md "should be applicable for My Growth
// Page as well."
//
// It is the identical trap. Submitting the growth plan hands it to the
// manager and closes it to the employee (growthEditable() in
// phase-machine.js locks 'submitted' and 'approved'), and the plan describes
// how somebody will grow INTO a job. Move them from Executive to Senior
// Executive, or Admin to Finance, and the development goals and the career
// aspiration are aimed at a role they no longer hold — with no way back
// except HR noticing and reopening it by hand.
//
// WHY A STORED COLUMN RATHER THAN READING THE COMMENT TEXT: exactly the
// reason 037 gives. Two different things land on status='returned' — a
// manager returning the plan with feedback, and an automatic reopen after a
// job change — and they must never be confused, because this is the first
// line an employee reads after an unexpected change. Sniffing the comment
// would let a wording tweak start blaming the manager for HR's edit.
//
// NOTE: this one column covers BOTH halves of My Growth. The career
// aspiration in people.career_paths has no status of its own; its lock is
// the development plan's status (see growthEditable), so reopening the plan
// reopens the aspiration with it.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.development_plans
                    ADD COLUMN IF NOT EXISTS reopened_reason text`);
};
