// 014 — Quarterly Connect: structured Achievements / Blockers / Feedback
// fields (BR-4.2: "a structured log of achievements, blockers, and
// feedback").
//
// FOUND MISSING during QA testing round 1 (fix guide item #8): pms.connects
// (migration 003) only ever had a single free-text `notes` column — every
// connect was one undifferentiated block of text rather than the three
// distinct fields the BRD calls for. `notes` is kept (nullable, unused by
// new writes) rather than dropped, so any connects already logged before
// this migration keep their original text instead of silently losing data.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS achievements text`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS blockers text`);
  await db.query(`ALTER TABLE pms.connects ADD COLUMN IF NOT EXISTS feedback text`);
};
