// EXPECTED TIMELINE IS WHAT IS LEFT (13 Oct: "expected timeline should be
// remaining months from current experience/total experience and not total
// expected timeline").
//
// The Career Pathing Matrix gives a move's whole figure — typically 72
// months, at least 48 — and the employee has already done part of it.
// The client chose the plain reading: what is left is the matrix's figure
// less the employee's TOTAL professional experience, never below nothing
// ("Due now"). Total experience is the HRMS figure (core.employees
// .total_experience_years, the export's "Current Experience" column), else
// the years the employee entered on their Long-Term tab, else unknown —
// and then the matrix's full figure stands, and the screen says why.
//
// CURRENT experience: each figure is dated (migration 088) and the months
// since are added, so the time left counts down between imports.
//
// A CLIMB OF SEVERAL MOVES (Long-Term) takes experience off the FIRST move
// only — the one out of the role they hold. The later moves start when
// that one ends; experience already behind them does not shorten a step
// they have not begun (found by review, 13 Oct).
//
// Pure: no database, so every case is tested directly.

/** Whole months from `asOf` to `now` (0 when either is missing or asOf is later). */
function monthsSince(asOf, now) {
  if (!asOf) return 0;
  const a = new Date(asOf);
  const b = now ? new Date(now) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
  return Math.max(0, m);
}

/**
 * Months of experience now, and where the figure came from, or months null.
 * opts: { hrmsAsOf, selfAsOf, now } — when each figure was recorded.
 */
function experienceFrom(hrmsYears, selfYears, opts = {}) {
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
  const at = (years, asOf, source) => {
    const months = Math.round(years * 12) + monthsSince(asOf, opts.now);
    return { months, years: Math.round((months / 12) * 10) / 10, source };
  };
  const hrms = n(hrmsYears);
  if (hrms != null) return at(hrms, opts.hrmsAsOf, 'hrms');
  const self = n(selfYears);
  if (self != null) return at(self, opts.selfAsOf, 'self_reported');
  return { months: null, years: null, source: null };
}

/**
 * What is left of a move's typical and minimum time, given experience.
 * typical/min: the matrix's months (null when HR left them blank).
 * firstStep: for a climb of several moves, the typical months of the first
 * one (the only one experience is taken off); omit for a single move.
 */
function remainingTimeline(typical, min, experience, firstStep) {
  const t = typical == null || typical === '' ? null : Number(typical);
  const m = min == null || min === '' ? null : Number(min);
  const exp = experience && experience.months != null ? experience.months : null;
  if (t == null || !Number.isFinite(t)) {
    return { remaining_time_months: null, remaining_min_months: null, timeline_text: null, timeline_basis: 'no_figure' };
  }
  if (exp == null) {
    return { remaining_time_months: t, remaining_min_months: m, timeline_text: `${t} months`, timeline_basis: 'no_experience' };
  }
  const f = firstStep == null || firstStep === '' || !Number.isFinite(Number(firstStep)) ? t : Math.min(t, Number(firstStep));
  const left = Math.max(0, f - exp) + (t - f);
  const single = f === t;
  const leftMin = !single || m == null || !Number.isFinite(m) ? null : Math.max(0, m - exp);
  return {
    remaining_time_months: left,
    remaining_min_months: leftMin,
    timeline_text: left > 0 ? `${left} months` : 'Due now',
    timeline_basis: experience.source,
  };
}

module.exports = { experienceFrom, remainingTimeline, monthsSince };
