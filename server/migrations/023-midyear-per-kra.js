// 023 — Mid-Year Review: per-KRA ratings for both journeys.
//
// Requested: at mid-year, the employee (self) and the reporting manager
// (for a reportee) should each rate EVERY KRA mapped to the employee,
// with the overall mid-year rating derived only once all KRAs are rated
// — rather than the single free-standing rating migration 020 shipped.
//
// SHAPE: jsonb maps, kra_id -> {rating, narrative}, mirroring
// pms.self_appraisals.entries exactly. That table proved the pattern
// (per-KRA entries in jsonb, overall derived with
// computeWeightedRating() from KRA weights), so mid-year reuses both the
// storage shape and that same tested function instead of inventing a
// child table and a second averaging implementation.
//
// WHY THE OVERALL STAYS IN THIS TABLE: on an ANNUAL cycle,
// pms.self_appraisals.overall_self_rating is deliberately driven only by
// the 7-parameter engine, with the per-KRA average reserved for
// non-annual cycles specifically so the two computations never fight
// over one column (see the comment in PUT /my/self-appraisal).
// Mid-year is a PHASE of an annual cycle, so its derived overall must
// land in midyear_checkins.self_rating / .manager_rating and nowhere
// near the annual columns. Migration 020 already separated these tables
// to stop mid-year sign-off from locking the annual appraisal; that same
// separation is what makes this safe.
//
// ADDITIVE AND IDEMPOTENT: existing rows keep their single self_rating /
// manager_rating and simply carry empty entry maps. Nothing is
// backfilled and nothing is dropped — a mid-year already signed off
// under the old shape stays exactly as it was recorded, which is the
// honest outcome for a rating someone already gave.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.midyear_checkins
    ADD COLUMN IF NOT EXISTS self_entries jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await db.query(`ALTER TABLE pms.midyear_checkins
    ADD COLUMN IF NOT EXISTS manager_entries jsonb NOT NULL DEFAULT '{}'::jsonb`);
};
