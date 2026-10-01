// Loyalty awards do not consume an award slot.
//
// A 5-, 10- or 15-year award is not won against competition — it is a
// fact about a date. Inside a capped pool, the fifty-first person to
// reach ten years in a cycle of forty-two would be refused recognition
// for having worked here, which is not a decision anybody means to make,
// and the refusal would arrive as "quota exhausted" with no hint that the
// rule was never meant to apply.
//
// So the cap governs what it is for: the competitive quarterly awards a
// manager nominates somebody for. The flag is per award rather than per
// level, because which awards are discretionary is a client's decision
// and the next client's list will differ.
//
// The Founder's awards still count towards the quota. That was raised and
// not decided, so it keeps the behaviour it had rather than being changed
// on an assumption — one checkbox in the award master moves it.
async function up(db) {
  await db.query(`ALTER TABLE rnr.awards
    ADD COLUMN IF NOT EXISTS counts_towards_quota boolean NOT NULL DEFAULT true`);
  await db.query(`UPDATE rnr.awards SET counts_towards_quota=false WHERE key LIKE 'loyalty\\_%'`);
}
module.exports = { up };
