// Pure rating-rule helpers — no db, unit-tested directly (same pattern as
// phase-machine.js). Kept separate from modules/performance/index.js so the
// actual eligibility logic (not just "does it wire up") gets tested without
// a database.

// SUPER 50 — BR-6.5, restated by the client on 24 Sep:
// "ratings will be derived from last three annual reviews and ratings
// should be A or A+ with current year ratings as A+."
//
// That is the rule this already implemented. What changed on 24 Sep is
// that it no longer HARDCODES which numbers mean A and A+.
//
// The old version tested `>= 4` and `=== 5` with a comment explaining
// that 4 is A and 5 is A+ on a 1-5 scale. That is true of this tenant —
// their scale really is A+=5, A=4, B+=3, B=2, C=1 — but it is a fact
// about their DATA, written into code, and the house rule is that
// labels and thresholds live in tables. A client who adds a grade above
// A+, or renumbers, would silently get a rule that can never fire, with
// no error to explain why. So the grades are now looked up in the
// cycle's own rating_scale by LABEL.
//
// `rule` is { window, minGrade, latestGrade } — how many annual reviews
// to look at, the lowest grade any of them may be, and the grade the
// most recent one must be. It comes from admin_settings, so HR can
// change "three years of A with an A+ this year" to something else
// without a deploy.

const DEFAULT_RULE = { window: 3, minGrade: 'A', latestGrade: 'A+' };

// Turn a grade LABEL into the numeric value that scale gives it.
// Returns null when the label is not on the scale — which is a
// misconfiguration worth surfacing, not a reason to guess.
function gradeValue(scale, label) {
  const want = String(label || '').trim().toLowerCase();
  const row = (scale || []).find((s) => String(s.label || '').trim().toLowerCase() === want);
  return row ? Number(row.value) : null;
}

// Why somebody is or is not on the list. Returned rather than a bare
// boolean because an empty Super 50 page with no explanation is the
// thing HR cannot act on: "two of three cycles" and "no cycle has
// published yet" are different problems with different fixes.
//
// `ratingsDesc` = final_rating values for this employee's annual
// reviews, most recent first. `scale` = the cycle's rating_scale rows.
function super50Check(ratingsDesc, scale, rule) {
  const r = { ...DEFAULT_RULE, ...(rule || {}) };
  const min = gradeValue(scale, r.minGrade);
  const latest = gradeValue(scale, r.latestGrade);
  if (min == null || latest == null) {
    return { eligible: false, reason: 'scale_mismatch', have: 0, need: r.window,
      detail: `The rule asks for "${r.minGrade}" and "${r.latestGrade}", which are not grades on this cycle's rating scale.` };
  }
  const list = Array.isArray(ratingsDesc) ? ratingsDesc.map(Number).filter((v) => !Number.isNaN(v)) : [];
  if (list.length < r.window) {
    return { eligible: false, reason: 'not_enough_history', have: list.length, need: r.window,
      detail: `${list.length} of ${r.window} annual reviews on record.` };
  }
  const top = list.slice(0, r.window);
  // The most recent one is checked FIRST, because "you had a great year
  // but not this year" is the commonest near miss and the one worth
  // naming precisely.
  if (Math.round(top[0]) !== latest) {
    return { eligible: false, reason: 'latest_not_top', have: r.window, need: r.window,
      detail: `This year is not ${r.latestGrade}.` };
  }
  const short = top.filter((v) => Math.round(v) < min).length;
  if (short > 0) {
    return { eligible: false, reason: 'streak_broken', have: r.window, need: r.window,
      // "1 of the last 3 review is" — the plural belongs to the three,
      // the verb to the one.
      detail: `${short} of the last ${r.window} reviews ${short === 1 ? 'is' : 'are'} below ${r.minGrade}.` };
  }
  return { eligible: true, reason: 'qualifies', have: r.window, need: r.window,
    detail: `${r.window} consecutive reviews at ${r.minGrade} or better, this year at ${r.latestGrade}.` };
}

// The boolean the publish path has always called. Kept so every existing
// caller and test keeps working, and so there is exactly one place the
// rule lives. The scale defaults to this product's own 1-5 A+..C scale,
// which is what every caller passed implicitly before.
const DEFAULT_SCALE = [
  { label: 'A+', value: 5 }, { label: 'A', value: 4 }, { label: 'B+', value: 3 },
  { label: 'B', value: 2 }, { label: 'C', value: 1 },
];
function isSuper50Eligible(recentRatingsDesc, scale, rule) {
  return super50Check(recentRatingsDesc, scale && scale.length ? scale : DEFAULT_SCALE, rule).eligible;
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

module.exports = { isSuper50Eligible, super50Check, gradeValue, computeWeightedRating,
                   DEFAULT_RULE, DEFAULT_SCALE };
