// Why a KRA sheet came back to the employee.
//
// From 17 Sep a sheet can be reopened by something other than a manager:
// changing an employee's department, designation or role reopens it
// automatically, because the sheet describes a job they no longer hold.
// Both routes land on status='returned' with a comment — which is right,
// since 'returned' is the one state the whole product already understands
// as "yours again, with a reason attached" — but the page said "Returned
// by your manager" over a message no manager wrote.
//
// A column rather than sniffing the comment text: the banner is the first
// thing the employee reads after an unexpected change, and a wording tweak
// somewhere else must not be able to start misattributing it.
//
// NULL means a manager returned it, which is every row that exists today
// and stays the default for a manual return.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.kra_sheets ADD COLUMN IF NOT EXISTS reopened_reason text`);
};
