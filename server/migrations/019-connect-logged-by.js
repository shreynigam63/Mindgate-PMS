// 019 — Quarterly Connect: who actually logged it, and self-logging.
//
// FOUND MISSING: only managers could log a connect (POST /connects
// required pms_team_eval unconditionally) — an employee reporting that a
// 1-on-1 happened had no way to say so themselves, and the "Select
// report" dropdown showed nothing for them (pms_team_eval-gated), which
// is exactly why an employee hit "Employee and date are required" with no
// way to satisfy it. This is fixed at the route level (performance/
// index.js), not here; this migration just adds logged_by_id so the UI
// can show "Logged by you" vs "Logged by <manager>" once either party can
// create one.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS logged_by_id uuid`);
};
