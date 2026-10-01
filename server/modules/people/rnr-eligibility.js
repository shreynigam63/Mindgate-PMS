// The RnR eligibility engine. Pure: no database, no express.
//
// Asked for explicitly: "The system should use a rule engine rather than
// hard-coded eligibility criteria." So nothing here knows what a Rising
// Star is. It is given an employee, an award row and the tenant's
// settings, and it applies whatever those rows say.
//
// IT ALWAYS SAYS WHY. A nomination screen that reports "not eligible"
// and stops is the thing this system exists to replace — the manager
// then emails HR, which is the manual process with extra steps. Every
// refusal below carries the sentence a manager can act on: which rule,
// what the employee's value actually is, and when it would change.
//
// THE 3-YEAR BOUNDARY. The client named the overlap themselves: Rising
// Star is 1–3 years, Buddy Star is 3+. Read as two closed intervals,
// somebody with exactly 3.0 years qualifies for both, and which one they
// get depends on who nominates them first. The window is therefore
// HALF-OPEN — [min, max) — so 3.0 is Buddy Star and never Rising Star.
// That is a decision, stated here and visible in the award master, not a
// rounding artefact.

/** Whole months between two dates, by calendar rather than by 30-day blocks. */
function monthsBetween(from, to) {
  if (!from || !to) return null;
  const a = new Date(from); const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;   // the day of the month has not come round yet
  return m;
}

const yearsBetween = (from, to) => {
  const m = monthsBetween(from, to);
  return m == null ? null : +(m / 12).toFixed(4);
};

/** A number of months as the sentence a person would say. */
function sayMonths(m) {
  if (m == null) return 'an unknown length of time';
  if (m < 12) return `${m} month${m === 1 ? '' : 's'}`;
  const y = Math.floor(m / 12); const r = m % 12;
  return `${y} year${y === 1 ? '' : 's'}${r ? ` and ${r} month${r === 1 ? '' : 's'}` : ''}`;
}

/** The level a band maps to, from the editable master. */
function levelOf(band, bandLevels) {
  if (!band) return null;
  const key = String(band).trim().toLowerCase();
  const hit = (bandLevels || []).find((b) => String(b.band).trim().toLowerCase() === key);
  return hit ? hit.level : null;
}

const isActiveStatus = (status, statuses) => {
  const key = String(status || '').trim().toLowerCase();
  const hit = (statuses || []).find((s) => String(s.status).trim().toLowerCase() === key);
  return hit ? !!hit.is_active : false;
};

/**
 * Is this employee eligible for this award, on this date?
 *
 * @param {object} employee  { date_of_joining, status, role_band, total_experience_years }
 * @param {object} award     a row from rnr.awards
 * @param {object} ctx       { asOf, settings, bandLevels, statuses, priorAwards }
 * @returns {{eligible:boolean, reasons:string[], facts:object}}
 */
function check(employee, award, ctx = {}) {
  const asOf = ctx.asOf ? new Date(ctx.asOf) : new Date();
  const settings = ctx.settings || {};
  const reasons = [];

  const tenureMonths = monthsBetween(employee && employee.date_of_joining, asOf);
  const tenureYears = tenureMonths == null ? null : +(tenureMonths / 12).toFixed(4);
  const totalYears = employee && employee.total_experience_years != null
    ? Number(employee.total_experience_years) : null;
  const level = levelOf(employee && employee.role_band, ctx.bandLevels);

  const facts = {
    date_of_joining: employee ? employee.date_of_joining : null,
    tenure_months: tenureMonths,
    tenure_years: tenureYears,
    total_experience_years: totalYears,
    band: employee ? employee.role_band : null,
    level,
    status: employee ? employee.status : null,
  };

  // ---- active employment ------------------------------------------------
  if (!isActiveStatus(employee && employee.status, ctx.statuses)) {
    reasons.push(`${employee && employee.status ? `Employment status is "${employee.status}"` : 'No employment status on record'}`
      + ', which HR has not marked as active. Only active employees can be nominated.');
  }

  // ---- minimum service --------------------------------------------------
  const minTenure = award.min_tenure_months != null
    ? Number(award.min_tenure_months)
    : (settings.min_tenure_months != null ? Number(settings.min_tenure_months) : 6);
  if (!employee || !employee.date_of_joining) {
    reasons.push('No date of joining on record, so length of service cannot be worked out. '
      + 'It comes from the HRMS import.');
  } else if (tenureMonths < minTenure) {
    const short = minTenure - tenureMonths;
    reasons.push(`Employee has completed only ${sayMonths(tenureMonths)} with Mindgate. `
      + `Minimum required service is ${minTenure} months — ${short} more month${short === 1 ? '' : 's'} to go.`);
  }

  // ---- band and level ---------------------------------------------------
  if (award.level && award.level !== 'all') {
    if (!employee || !employee.role_band) {
      reasons.push('No band on record, so the Junior / Mid / Senior level cannot be worked out. '
        + 'Band comes from the HRMS import.');
    } else if (!level) {
      reasons.push(`Band "${employee.role_band}" is not in the band master, so it maps to no level. `
        + 'HR can add it on the RnR masters page.');
    } else if (level !== award.level) {
      reasons.push(`${award.name} is a ${award.level}-level award, and this employee is `
        + `${level}-level (band ${employee.role_band}).`);
    }
    if (level === 'senior' && award.frequency === 'quarterly' && settings.senior_in_quarterly === false) {
      reasons.push('Senior-level employees are recognised through the annual and special awards, '
        + 'not the quarterly cycle. HR can change this in the RnR settings.');
    }
  }
  // An explicit band list on the award overrides the level mapping.
  if (Array.isArray(award.bands) && award.bands.length) {
    const ok = employee && employee.role_band
      && award.bands.map((b) => String(b).toLowerCase()).includes(String(employee.role_band).toLowerCase());
    if (!ok) {
      reasons.push(`${award.name} is limited to bands ${award.bands.join(', ')}; `
        + `this employee is ${employee && employee.role_band ? `band ${employee.role_band}` : 'on no band'}.`);
    }
  }

  // ---- the experience window -------------------------------------------
  const basis = award.experience_basis === 'tenure' ? 'tenure' : 'total';
  const value = basis === 'tenure' ? tenureYears : totalYears;
  const label = basis === 'tenure' ? 'Mindgate tenure' : 'total professional experience';
  const hasWindow = award.min_experience_years != null || award.max_experience_years != null;
  if (hasWindow) {
    if (value == null) {
      reasons.push(basis === 'tenure'
        ? 'No date of joining on record, so tenure cannot be worked out.'
        : 'No total professional experience on record. It comes from the HRMS import, and the '
          + 'eligibility rule for this award is based on it.');
    } else {
      const min = award.min_experience_years == null ? null : Number(award.min_experience_years);
      const max = award.max_experience_years == null ? null : Number(award.max_experience_years);
      // Half-open [min, max): see the note at the top.
      if (min != null && value < min) {
        reasons.push(`${award.name} needs ${min}+ years of ${label}; this employee has `
          + `${value.toFixed(1)}.`);
      } else if (max != null && value >= max) {
        reasons.push(`${award.name} is for ${min != null ? `${min} to under ${max}` : `under ${max}`} `
          + `years of ${label}; this employee has ${value.toFixed(1)}, which is above the window.`);
      }
    }
  }

  // ---- already holds it -------------------------------------------------
  const prior = ctx.priorAwards || [];
  if (prior.some((p) => p.award_id === award.id && p.same_cycle)) {
    reasons.push('Employee has already been nominated for this award in the current cycle.');
  } else if (prior.some((p) => p.award_id === award.id && p.won)) {
    reasons.push(`Employee has already received ${award.name}.`);
  }
  const maxPerYear = settings.max_awards_per_year == null ? null : Number(settings.max_awards_per_year);
  if (maxPerYear) {
    const thisYear = prior.filter((p) => p.won && p.same_year).length;
    if (thisYear >= maxPerYear) {
      reasons.push(`Employee already holds ${thisYear} RnR award${thisYear === 1 ? '' : 's'} this year, `
        + `and HR has set the limit to ${maxPerYear}.`);
    }
  }

  return { eligible: reasons.length === 0, reasons, facts };
}

/** Everybody who passes, for one award. The nomination screen's list. */
function eligibleFrom(employees, award, ctx = {}) {
  const out = [];
  for (const e of employees || []) {
    const r = check(e, award, { ...ctx, priorAwards: (ctx.priorAwardsBy || {})[e.id] || [] });
    if (r.eligible) out.push({ employee: e, facts: r.facts });
  }
  return out;
}

/**
 * The loyalty awards nobody nominates: whoever crosses 5, 10 or 15 years
 * by the award date is identified automatically.
 */
function loyaltyDue(employees, awards, ctx = {}) {
  const loyalty = (awards || []).filter((a) => a.experience_basis === 'tenure' && a.active !== false);
  const out = [];
  for (const a of loyalty) {
    for (const e of employees || []) {
      const r = check(e, a, { ...ctx, priorAwards: (ctx.priorAwardsBy || {})[e.id] || [] });
      if (r.eligible) out.push({ award: a, employee: e, facts: r.facts });
    }
  }
  return out;
}

module.exports = { check, eligibleFrom, loyaltyDue, monthsBetween, yearsBetween, levelOf, isActiveStatus, sayMonths };
