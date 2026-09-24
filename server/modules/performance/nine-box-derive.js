// Deriving a 9-box placement from data the cycle already holds.
//
// Asked for on 24 Sep: "after analyzing competency mapping of employees
// in Annual review cycle, please confirm how 9 box grid will be
// displayed."
//
// Until now the grid showed ONLY cells HR typed on the Calibration
// screen. Nothing computed a placement, and the endpoint said why: a
// derived cell needs performance bands, and this repo keeps thresholds
// in tables rather than inventing cut-offs in a query.
//
// Competency mapping supplies the missing half. So:
//
//   PERFORMANCE  <- the annual final rating. What was delivered.
//   POTENTIAL    <- the competency assessment, over the FORWARD-LOOKING
//                   categories only: Leadership, and Digital & Future
//                   Skills. Not the functional ones — "knows the job
//                   they already do" is performance, and counting it as
//                   potential would put the same fact on both axes and
//                   turn the grid into a diagonal line.
//
// THE DERIVED CELL NEVER OVERWRITES THE CALIBRATED ONE. It is shown
// beside it. Calibration is a judgment made by people in a room, and a
// computed suggestion that silently replaced it would be the product
// deciding something it was not asked to decide. Where the two differ,
// that difference is the useful output — it is the question to put in
// the room.
//
// Pure — no db, no express — so the bands are testable directly.

// The bands, as fractions of the scale rather than raw numbers, so a
// client on a 1-5 scale and a client on a 1-10 scale get the same
// meaning without either being hardcoded. Stated on screen too: a cut
// off nobody can see is a cut-off nobody can argue with.
// 0.75 and 0.4 are chosen so that on this client's own A+..C scale the
// split is A+/A high, B+ mid, B/C low. That is not arbitrary: Super 50
// already treats A and A+ as one top tier, and a grid that called an A
// "mid performance" while the watchlist called it top-tier would have
// the product contradicting itself on the same rating.
const PERFORMANCE_BANDS = [
  { band: 'high', atLeast: 0.75, label: 'Top two grades' },
  { band: 'mid', atLeast: 0.4, label: 'Middle of the scale' },
  { band: 'low', atLeast: 0, label: 'Bottom two grades' },
];

// Potential is read as a GAP against what the role requires, not as a
// raw average: "4 out of 5" means something different for a job that
// needs 3 and a job that needs 5, and the whole point of the
// competency framework is that it knows the difference.
const POTENTIAL_BANDS = [
  { band: 'high', atLeast: 0, label: 'At or above what the role needs' },
  { band: 'mid', atLeast: -0.75, label: 'Within three-quarters of a level' },
  { band: 'low', atLeast: -Infinity, label: 'More than three-quarters of a level short' },
];

const FORWARD_CATEGORIES = [/^LEADERSHIP/i, /FUTURE SKILLS/i, /^DIGITAL/i];
const isForward = (category) => FORWARD_CATEGORIES.some((re) => re.test(String(category || '')));

// Where a rating sits on its own scale, 0..1. Returns null for a
// missing rating — which is "not placed", a different thing from "placed
// at the bottom", and the caller must keep them apart.
function scalePosition(rating, scale) {
  if (rating == null || Number.isNaN(Number(rating))) return null;
  const values = (scale || []).map((s) => Number(s.value)).filter((v) => !Number.isNaN(v));
  if (values.length < 2) return null;
  const lo = Math.min(...values); const hi = Math.max(...values);
  if (hi === lo) return null;
  const clamped = Math.min(hi, Math.max(lo, Number(rating)));
  return (clamped - lo) / (hi - lo);
}

function performanceBand(rating, scale) {
  const pos = scalePosition(rating, scale);
  if (pos == null) return null;
  return PERFORMANCE_BANDS.find((b) => pos >= b.atLeast).band;
}

// rows: this employee's competency rating rows ({ category,
// required_level, manager_rating }). Only MANAGER ratings count — a
// self-assessment must not be able to move somebody up the potential
// axis on their own say-so.
function potentialFromCompetencies(rows) {
  const forward = (rows || []).filter((r) => isForward(r.category) && r.manager_rating != null);
  if (!forward.length) return { band: null, avg_gap: null, rated: 0, categories: [] };
  const gap = forward.reduce((a, r) => a + (Number(r.manager_rating) - Number(r.required_level)), 0) / forward.length;
  const avg = Math.round(gap * 100) / 100;
  return {
    band: POTENTIAL_BANDS.find((b) => avg >= b.atLeast).band,
    avg_gap: avg,
    rated: forward.length,
    categories: [...new Set(forward.map((r) => r.category))].sort(),
  };
}

// One employee's derived cell, with everything needed to explain it.
// `why` is not decoration: a grid that places somebody bottom-left
// without saying what put them there is a grid nobody will act on.
function derivePlacement({ finalRating, scale, competencyRows }) {
  const perf = performanceBand(finalRating, scale);
  const pot = potentialFromCompetencies(competencyRows);
  const cell = perf && pot.band ? `${perf}-${pot.band}` : null;
  const missing = [];
  if (!perf) missing.push('no published annual rating');
  if (!pot.band) missing.push('no manager competency ratings in Leadership or Digital & Future Skills');
  return {
    cell,
    performance: perf,
    potential: pot.band,
    final_rating: finalRating == null ? null : Number(finalRating),
    competency_gap: pot.avg_gap,
    competencies_rated: pot.rated,
    categories_used: pot.categories,
    why: cell
      ? `Performance from a final rating of ${finalRating}; potential from ${pot.rated} forward-looking ${pot.rated === 1 ? 'competency' : 'competencies'} averaging ${pot.avg_gap > 0 ? '+' : ''}${pot.avg_gap} against what the role requires.`
      : `Not placed — ${missing.join(' and ')}.`,
  };
}

module.exports = {
  derivePlacement, performanceBand, potentialFromCompetencies, scalePosition,
  isForward, PERFORMANCE_BANDS, POTENTIAL_BANDS,
};
