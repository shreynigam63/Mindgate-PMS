// The reopen-on-role-change flag for the Mid-Year Review — the third and
// last artifact that locks on submission.
//
// Asked for on 17 Sep: "apply the same changes to mid-year tab as well",
// after the KRA sheet (037) and the growth plan (039).
//
// MID-YEAR IS SHAPED DIFFERENTLY, AND THIS IS THE PART TO UNDERSTAND.
//
// The KRA sheet and the growth plan each have ONE status with a 'returned'
// value in it, and a manager_comment column to say why. Mid-year has
// NEITHER:
//
//   self_status    not_started | in_progress | submitted
//   manager_status not_started | in_progress | submitted
//
// There is no 'returned' — nothing in the product has ever handed a
// mid-year back, from a manager or from HR. And there is no comment
// column: self_narrative and manager_narrative are the two parties' OWN
// writing, and overwriting either to carry a system message would destroy
// work somebody did.
//
// So a reopened mid-year lands on 'in_progress' — the state the save route
// already accepts (it refuses only 'submitted'), so no new state has to be
// taught to the page, the reminder sweep or the manager's queue. That is
// the same reasoning 037 used for choosing 'returned' on the sheet: land on
// what the product already understands.
//
// TWO COLUMNS, not one:
//   reopened_reason  'profile_change' — the flag, same values as 037/039,
//                    so the page can tell an automatic reopen from anything
//                    else without parsing prose.
//   reopened_note    the sentence the employee reads. It needs its own
//                    column precisely BECAUSE there is no manager_comment
//                    here to borrow, and the narratives are not ours.
//
// Ratings and narratives are untouched by a reopen. Only the status moves
// back, so the employee (and the manager) can review and resubmit exactly
// what they had if the change does not affect it.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.midyear_checkins
                    ADD COLUMN IF NOT EXISTS reopened_reason text`);
  await db.query(`ALTER TABLE pms.midyear_checkins
                    ADD COLUMN IF NOT EXISTS reopened_note text`);
};
