// 043 — potential on the manager's evaluation, alongside the one
// calibration already sets.
//
// Asked for on 23 Sep: "potential should [be] in for both". Potential was
// only ever captured at Calibration, as the 9-box cell on pms.top_talent —
// a judgement made in the room, with the distribution on screen. The
// manager, who has spent the year with the person, had nowhere to record
// their own view of it.
//
// TWO COLUMNS, NOT ONE MOVED. The manager's potential and the calibrated
// potential are different claims by different people at different times,
// and "why did this change" has to stay answerable — the same reason
// rating adjustments are their own table rather than an overwrite. So:
//
//   pms.manager_evaluations.potential_rating  what the manager judged
//   pms.top_talent.potential_rating           what calibration settled on
//
// Calibration shows the manager's value as its starting point, and the
// 9-box falls back to the manager's when calibration has not touched a
// person yet — so a manager's judgement is visible immediately rather
// than waiting for a session that may be months away.
//
// The scale is the same three values the 9-box already uses, kept as a
// CHECK rather than an enum so a tenant that relabels them (this repo's
// rule: labels live in tables) is not blocked by a type change.
module.exports.up = async (db) => {
  await db.query(
    `ALTER TABLE pms.manager_evaluations
       ADD COLUMN IF NOT EXISTS potential_rating text`);
  await db.query(
    `ALTER TABLE pms.manager_evaluations
       DROP CONSTRAINT IF EXISTS manager_evaluations_potential_rating_check`);
  await db.query(
    `ALTER TABLE pms.manager_evaluations
       ADD CONSTRAINT manager_evaluations_potential_rating_check
       CHECK (potential_rating IS NULL OR potential_rating IN ('low','mid','high'))`);
};
