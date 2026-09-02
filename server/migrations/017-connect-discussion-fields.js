// 017 — Quarterly Connect: Duration, Topic, and a "What was discussed?"
// catch-all narrative, separate from the derived Achievements/Blockers/
// Feedback fields added in migration 014.
//
// Requested with a reference screenshot: the manager should log Date,
// Duration, Topic, and what was actually discussed — and Achievements/
// Blockers/Feedback should be DERIVED from that discussion (via the
// agentic module's new /connect-extract draft), not typed separately
// from scratch as three unrelated boxes. discussion_notes is the raw
// input that gets extracted from; achievements/blockers/feedback remain
// editable after extraction, same "draft, then a human edits it" pattern
// as every other AI feature in this app.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS duration_min integer`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS topic text`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS discussion_notes text`);
};
