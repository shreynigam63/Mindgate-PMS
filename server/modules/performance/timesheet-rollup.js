// Closed months, rolled up to a cycle.
//
// Phase 4 of the Zoho timesheet rating engine. Pure: no db, no express.
//
// WHAT THIS PRODUCES IS CONTEXT FOR A CALIBRATION CONVERSATION, not an
// input to one. The spec asked for the year-end number to be a
// pre-populated suggestion, and that is what this is: it never writes a
// rating, never enters the kitty maths, and carries its own coverage so
// a reader can see how much of the year it actually speaks for.
//
// -------------------------------------------------------------------
// WEIGHTED BY HOURS, NOT A MEAN OF PERCENTAGES
//
// A flat average across months treats a month with 8 hours logged the
// same as one with 160. On the client's real data that is not a corner
// case: a person part-way through a notice period, a month mostly on
// leave, or a month where the export only covered one sprint all land
// as small-hour months, and each would pull the year's figure around as
// hard as a full one.
//
// So every percentage is weighted by the hours it was computed over,
// and a month with no hours contributes nothing rather than a zero.
// Compliance is the exception and is weighted by WORKING DAYS' worth of
// months — it is a property of the month, not of the hours in it — so
// it uses a flat mean over the months that have a figure.
//
// WHAT IT REFUSES TO SAY. If no closed month carries a score, the
// rollup carries none either; it does not average nulls into zero. If
// only part of the cycle is closed, it says how much.

const round1 = (n) => Math.round(n * 10) / 10;

// The score a month actually counts with: the override when a manager
// set one, otherwise the computed score. Same for the grade.
function effectiveOf(m) {
  const overridden = m.override_score != null || m.override_grade != null;
  return {
    score: m.override_score != null ? Number(m.override_score)
      : (m.score == null ? null : Number(m.score)),
    grade: m.override_grade != null ? m.override_grade : (m.grade || null),
    overridden,
    reason: overridden ? (m.override_reason || null) : null,
  };
}

// Sum of (value x weight) over rows where value is not null, divided by
// the weight that actually contributed. Null when nothing did — never
// zero, because "we could not tell" and "it was zero" are different
// answers and only one of them is a judgement.
function weightedMean(rows, value, weight) {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const v = value(r);
    const w = Number(weight(r)) || 0;
    if (v == null || !(w > 0)) continue;
    num += Number(v) * w;
    den += w;
  }
  return den > 0 ? round1(num / den) : null;
}

function flatMean(rows, value) {
  const vs = rows.map(value).filter((v) => v != null).map(Number);
  return vs.length ? round1(vs.reduce((t, v) => t + v, 0) / vs.length) : null;
}

/**
 * @param {object[]} months  rows from pms.timesheet_month for one person
 *        and one cycle, in any order.
 * @param {object} opts      { periods_in_cycle } — how many periods the
 *        cycle contains, so the rollup can say what fraction it covers.
 */
function rollup(months, opts = {}) {
  const list = (months || []).slice()
    .sort((a, b) => (String(a.period_start) < String(b.period_start) ? -1 : 1));
  // computed_* is kept alongside because effectiveOf OVERWRITES score
  // and grade with the override when there is one. Without it the
  // "what it was before" in override_reasons reads back as the override
  // itself — 78 -> 78 — which is precisely the record this exists to
  // keep.
  const eff = list.map((m) => ({
    ...m,
    computed_score: m.score == null ? null : Number(m.score),
    computed_grade: m.grade || null,
    ...effectiveOf(m),
  }));

  const hours = eff.reduce((t, m) => t + (Number(m.hours_logged) || 0), 0);
  const considered = eff.reduce((t, m) => t + (Number(m.hours_considered) || 0), 0);
  const attributed = eff.reduce((t, m) => t + (Number(m.hours_attributed) || 0), 0);
  const excluded = eff.reduce((t, m) => t + (Number(m.hours_excluded) || 0), 0);

  // Mapped % over the whole cycle is computed from the HOURS, not
  // averaged from the monthly percentages — the two differ whenever the
  // months are unequal, and the hours are the thing being described.
  const mapped_pct = considered > 0 ? round1((attributed / considered) * 100) : null;

  // Coverage and alignment are weighted by the hours they were computed
  // over. A month where nothing was placed has no alignment figure at
  // all and is skipped rather than counted as zero.
  const weighted_coverage_pct = weightedMean(eff, (m) => m.weighted_coverage_pct, (m) => m.hours_considered);
  const alignment_pct = weightedMean(eff, (m) => m.alignment_pct, (m) => m.hours_attributed);
  const value_add_pct = weightedMean(eff, (m) => m.value_add_pct, (m) => m.hours_considered);
  // Compliance is a property of the month, not of the hours in it: a
  // person who filled every working day in a quiet month was fully
  // compliant, and weighting that down by their hours would be wrong.
  const compliance_pct = flatMean(eff, (m) => m.compliance_pct);

  const scored = eff.filter((m) => m.score != null);
  const score = scored.length
    ? weightedMean(scored, (m) => m.score, (m) => Math.max(Number(m.hours_logged) || 0, 1))
    : null;

  const overridden = eff.filter((m) => m.overridden);
  const periods = Number(opts.periods_in_cycle) || 0;

  return {
    months: eff.length,
    periods_in_cycle: periods || null,
    // How much of the year this actually speaks for. The number a
    // calibration conversation needs before it can weigh the rest.
    // Clamped: a month can be closed for a period that only partly
    // overlaps the cycle, and "112% of the year" is not a number
    // anybody should read on a calibration screen.
    cycle_coverage_pct: periods > 0 ? Math.min(100, round1((eff.length / periods) * 100)) : null,
    first_period: eff.length ? eff[0].period_start : null,
    last_period: eff.length ? eff[eff.length - 1].period_start : null,

    hours: round1(hours),
    hours_considered: round1(considered),
    hours_attributed: round1(attributed),
    hours_excluded: round1(excluded),

    mapped_pct,
    weighted_coverage_pct,
    alignment_pct,
    value_add_pct,
    compliance_pct,

    // Present only when at least one closed month carried one, which
    // today means never: auto_score ships off.
    score,
    months_scored: scored.length,
    overrides: overridden.length,
    override_reasons: overridden.map((m) => ({
      period_start: m.period_start, reason: m.reason,
      from: m.computed_score, from_grade: m.computed_grade,
      to: m.override_score == null ? null : Number(m.override_score),
      to_grade: m.override_grade || null,
    })),

    // One line for the calibration screen. Deliberately not a grade.
    label: labelFor({ months: eff.length, mapped_pct, scored: scored.length }),
  };
}

// The sentence the calibration screen shows instead of a letter. It is
// a statement about EVIDENCE, not about the person, because that is all
// this rollup can honestly support while most hours are unplaced.
function labelFor({ months, mapped_pct, scored }) {
  if (!months) return 'No month closed yet';
  if (mapped_pct == null) return `${months} month${months === 1 ? '' : 's'} closed, no hours to place`;
  if (mapped_pct < 50) return `${mapped_pct}% of logged hours placed — too thin to read`;
  if (!scored) return `${mapped_pct}% of logged hours placed`;
  return `${mapped_pct}% placed across ${months} month${months === 1 ? '' : 's'}`;
}

// A sentence, or null. The override goes on a month, and the reason is
// mandatory for the same reason it is on a rating adjustment.
function validateOverride(b) {
  const hasScore = b.score != null && b.score !== '';
  const hasGrade = !!String(b.grade || '').trim();
  if (!hasScore && !hasGrade) return 'Give a score or a grade to override with.';
  if (hasScore) {
    const n = Number(b.score);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `The score must be between 0 and 100 — got "${b.score}"`;
  }
  if (!String(b.reason || '').trim()) {
    return 'Say why this month is being overridden — it is the permanent answer to "why did my rating change".';
  }
  return null;
}

module.exports = { rollup, effectiveOf, weightedMean, flatMean, labelFor, validateOverride };
