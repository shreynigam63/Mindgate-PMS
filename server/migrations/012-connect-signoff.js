// 012 — Manager sign-off on Quarterly Connect logs (BR-4.3: "Managers
// confirm and sign off each logged conversation, so both parties agree
// on what was discussed").
//
// FOUND MISSING during a full BRD re-audit, 28-Aug-2026: pms.connects
// (migration 003) had no status/sign-off column at all — a log was just
// a plain insert with nothing distinguishing "logged" from "confirmed/
// signed off". Sign-off is added as an explicit, separate action rather
// than assuming logging IS sign-off, matching the BRD's Fig. 6
// description of sign-off as its own step alongside the log fields.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS signed_off boolean NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS signed_off_at timestamptz`);
};
