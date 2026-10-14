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
// A CLIMB OF SEVERAL MOVES (Long-Term) takes experience off the WHOLE
// climb (15 Oct, the client's choice: 5 years behind them, 72 months to
// the short-term role and 48 more to the next — Short-Term 12 months,
// Long-Term 60). The matrix's months are read as a career clock that
// started on their first working day, not on the day they took the role.
// (Until 15 Oct experience came off the first move only.)
//
// NEVER FROM ZERO (15 Oct: "timeline should be based on total experience
// and not from 0 experience"). With no HRMS figure and none entered, the
// time since joining stands in — at least that much experience is
// certain — and the screen says so.
//
// THE LONG-TERM ROLE BY EXPERIENCE (15 Oct): of the rungs above, the one
// their total experience points to — the first not yet covered by it, so
// a long career can skip a level (rungByExperience).
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
 * opts: { hrmsAsOf, selfAsOf, now } — when each figure was recorded;
 * { joined } — the date of joining, the last resort.
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
  if (opts.joined && !Number.isNaN(new Date(opts.joined).getTime()) && new Date(opts.joined) <= (opts.now ? new Date(opts.now) : new Date())) {
    return at(0, opts.joined, 'joining_date');
  }
  return { months: null, years: null, source: null };
}

/**
 * What is left of a move's typical and minimum time, given experience.
 * typical/min: the matrix's months (null when HR left them blank); for a
 * climb of several moves, typical is the whole climb's.
 */
function remainingTimeline(typical, min, experience) {
  const t = typical == null || typical === '' ? null : Number(typical);
  const m = min == null || min === '' ? null : Number(min);
  const exp = experience && experience.months != null ? experience.months : null;
  if (t == null || !Number.isFinite(t)) {
    return { remaining_time_months: null, remaining_min_months: null, timeline_text: null, timeline_basis: 'no_figure' };
  }
  if (exp == null) {
    return { remaining_time_months: t, remaining_min_months: m, timeline_text: `${t} months`, timeline_basis: 'no_experience' };
  }
  const left = Math.max(0, t - exp);
  const leftMin = m == null || !Number.isFinite(m) ? null : Math.max(0, m - exp);
  return {
    remaining_time_months: left,
    remaining_min_months: leftMin,
    timeline_text: left > 0 ? `${left} months` : 'Due now',
    timeline_basis: experience.source,
  };
}

/**
 * The Long-Term rung total experience points to: the nearest rung (fewest
 * steps, then least time) that experience does not already cover; when it
 * covers every rung offered, the furthest of them. Rungs without a figure
 * are passed over; with no experience at all, the nearest rung.
 */
function rungByExperience(rungs, experience) {
  const timed = (rungs || []).filter((r) => r && r.typical_time_months != null && Number.isFinite(Number(r.typical_time_months)))
    .sort((a, b) => (a.steps || 1) - (b.steps || 1) || Number(a.typical_time_months) - Number(b.typical_time_months));
  if (!timed.length) return null;
  const exp = experience && experience.months != null ? experience.months : null;
  if (exp == null) return timed[0];
  return timed.find((r) => Number(r.typical_time_months) > exp) || timed[timed.length - 1];
}

module.exports = { experienceFrom, remainingTimeline, monthsSince, rungByExperience };
