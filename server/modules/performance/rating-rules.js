// Pure rating-rule helpers — no db, unit-tested directly (same pattern as
// phase-machine.js). Kept separate from modules/performance/index.js so the
// actual eligibility logic (not just "does it wire up") gets tested without
// a database.

// BR-6.5: "3 consecutive A/A+ ratings, with the most recent cycle rated A+."
// See migrations/007-super50.js for the letter-grade -> numeric mapping
// this implements (A/A+ = 4 or 5; A+ specifically = 5).
// `recentRatingsDesc` = final_rating values for an employee's published
// cycles of one cycle_type, most-recent-first, already limited to the last
// 3 by the caller's query. Returns false (not throws) on incomplete history
// — fewer than 3 published cycles is simply not yet eligible, not an error.
// BR-6.5: "3 consecutive A/A+ ratings, with the most recent cycle rated A+."
// This ONLY ever evaluates ANNUAL cycle history (see /publish below), and
// an annual cycle's own overall_rating comes from the separate 7-parameter
// weighted engine (this file's computeWeightedRating, always 1-5) — NOT
// from cycle.rating_scale, which is a different, midyear-facing field
// (the manual "Overall rating" dropdown on non-annual cycles) that was
// changed elsewhere to a 6-point A+/A/B+/B/C/D scale for display purposes.
// Those two scales are intentionally decoupled: this function keeps
// treating 4 as "A" and 5 as "A+" (the closest mapping onto the ACTUAL
// 1-5 range annual ratings can reach), same as before that change.
// Widening this to require a literal "6" would make Super 50 permanently
// unreachable for every annual cycle, since none can ever score above 5 —
// caught by testing the exact math before shipping, not assumed correct.
function isSuper50Eligible(recentRatingsDesc) {
  if (!Array.isArray(recentRatingsDesc) || recentRatingsDesc.length < 3) return false;
  const top3 = recentRatingsDesc.slice(0, 3).map(Number);
  if (top3.some((v) => Number.isNaN(v))) return false;
  const allTopTier = top3.every((v) => Math.round(v) >= 4);
  const mostRecentIsTopGrade = Math.round(top3[0]) === 5;
  return allTopTier && mostRecentIsTopGrade;
}

// BR-6.2/6.3: weighted overall rating from the 7 Organizational Driver
// parameters. `parameters` = active pms.review_parameters rows ({id,
// weight_pct}); `scores` = Map/object of parameter_id -> score (1-5).
// Only complete when every active parameter has a score — an incomplete
// weighted average would silently understate the rating if a parameter
// were simply left unscored, so callers must check `complete` before
// treating `rating` as final. Weight validity (summing to ~100) is a
// separate concern, checked at configuration time via phase-machine's
// weightsValid(), not here.
function computeWeightedRating(parameters, scores) {
  const get = (id) => (scores instanceof Map ? scores.get(id) : scores[id]);
  let weightedSum = 0; let weightSeen = 0; const missing = [];
  for (const p of parameters) {
    const s = get(p.id);
    if (s == null || Number.isNaN(Number(s))) { missing.push(p.id); continue; }
    weightedSum += Number(s) * (Number(p.weight_pct) / 100);
    weightSeen += Number(p.weight_pct);
  }
  const complete = missing.length === 0 && parameters.length > 0;
  // Partial rating still returned (rounded) so a "draft so far" figure can
  // be shown live in the UI as the manager scores each parameter — but
  // never treated as final while `complete` is false.
  const rating = parameters.length > 0 ? Math.round(weightedSum * 10) / 10 : null;
  return { rating, complete, missing };
}

module.exports = { isSuper50Eligible, computeWeightedRating };
