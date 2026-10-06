// The monthly numbers, from an attribution.
//
// Phase 2 of the Zoho timesheet rating engine. Pure: no db, no express.
// Separate from timesheet-kra-match.js on purpose — attribution has to
// be arguable on its own, and a scoring change must not be able to
// quietly alter where somebody's hours were said to go.
//
// WHAT THIS SHIPS AS. Coverage reporting, not a rating. Three numbers a
// manager can act on, and a fourth that stays null until two separate
// conditions are met:
//
//   mapped %             of the hours we considered, how many are
//                        placed against a KRA at all
//   weighted coverage %  of the KRA sheet BY WEIGHT, how much saw work
//   alignment %          how closely effort matched the weights
//   score / grade        withheld unless HR turns it on AND the mapping
//                        is thick enough to mean anything
//
// WHY WEIGHTED COVERAGE RATHER THAN THE SPEC'S "% OF KRA BUCKETS
// COVERED". Counting buckets rewards breadth over value: on the real
// client month, putting every single hour into one KRA scored 14%,
// while touching all seven for an hour each would have scored 100%.
// Weighting by the KRA's own weight — the number the employee and
// manager already agreed — measures the sheet, not the spread.
//
// WHY ALIGNMENT EXISTS AT ALL. Coverage still says nothing about
// proportion: 1 hour on a 40% KRA and 100 hours on a 5% one is full
// coverage. Alignment is one minus half the total variation between
// where the hours went and where the weights said they should — 100%
// when effort matches the sheet exactly, and it cannot be gamed by
// touching everything briefly.
//
// WHY NO GRADE BY DEFAULT. On the client's real data 87% of hours are
// unmapped. A grade computed on 13% of the evidence is not a
// measurement, it is an argument. The gate is data, not opinion: below
// min_mapped_pct the engine says what is missing instead of producing a
// number, and it says the same thing to everybody.
//
// EVERY THRESHOLD AND LABEL IS PASSED IN, never literal here. They live
// in core.admin_settings and 065 seeds them — the house rule, and what
// lets a client retune this without a release.

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// One sentence per withheld number. These go straight to the screen, so
// "insufficient data" would be useless — each says what is missing and
// what would fix it.
function gradeFor(score, bands) {
  if (score == null) return null;
  const list = (bands || []).slice().sort((a, b) => Number(b.min) - Number(a.min));
  for (const b of list) if (score >= Number(b.min)) return b.label;
  return list.length ? list[list.length - 1].label : null;
}

/**
 * @param {object} att       the return of timesheet-kra-match.attribute()
 * @param {object} va        the return of timesheet-kra-match.valueAdd()
 * @param {number|null} compliancePct  from timesheet-rules.compliance()
 * @param {object} cfg       the `scoring` blob from the timesheet settings
 */
function summarise(att, va, compliancePct, cfg = {}) {
  const wCov = Number(cfg.weight_coverage);
  const wCmp = Number(cfg.weight_compliance);
  const wVa = Number(cfg.weight_value_add);
  const minMapped = Number(cfg.min_mapped_pct);
  const autoScore = cfg.auto_score === true;

  const scorable = (att.by_kra || []).filter((k) => k.scorable);
  const scorableWeight = scorable.reduce((t, k) => t + (Number(k.weight) || 0), 0);
  const attributed = Number(att.totals.attributed) || 0;

  // Weighted coverage. Over SCORABLE KRAs only: a KRA nobody can ever
  // log against ("CSAT Score" is measured from client feedback) would
  // otherwise sit in the denominator as a permanent zero and mark
  // everyone down for it forever. It is reported separately instead, so
  // it is visible rather than quietly excluded.
  const covered = scorable.filter((k) => Number(k.hours) > 0);
  const coveredWeight = covered.reduce((t, k) => t + (Number(k.weight) || 0), 0);
  const weighted_coverage_pct = scorableWeight > 0
    ? round1((coveredWeight / scorableWeight) * 100)
    : null;

  // Alignment. Null rather than zero when nothing was attributed: no
  // hours placed is "we cannot tell", not "perfectly misaligned".
  let alignment_pct = null;
  if (attributed > 0 && scorableWeight > 0) {
    let tv = 0;
    for (const k of scorable) {
      const share = (Number(k.hours) || 0) / attributed;
      const target = (Number(k.weight) || 0) / scorableWeight;
      tv += Math.abs(share - target);
    }
    // Hours attributed to a KRA outside the scorable set would make the
    // shares sum below 1; that shortfall is itself a divergence and is
    // already captured by the sum above.
    alignment_pct = round1(clamp((1 - tv / 2) * 100, 0, 100));
  }

  // The value-add component, as a share of the hours considered. Capped
  // because a month where every note says "optimization" is a tell, not
  // a triumph.
  const considered = Number(att.totals.considered) || 0;
  const value_add_pct = considered > 0
    ? round1(clamp((Number(va.hours) || 0) / considered * 100, 0, 100))
    : null;

  // ---- the score, and the two reasons it is usually absent -----------
  const withheld = [];
  if (!autoScore) {
    withheld.push('Automatic scoring is off. This month is reported as coverage only — '
      + 'turn it on in HR Admin once the item mapping has settled.');
  }
  if (!(att.totals.mapped_pct >= minMapped)) {
    withheld.push(`Only ${att.totals.mapped_pct}% of the hours considered are mapped to a KRA, `
      + `below the ${minMapped}% this tenant requires before a score means anything. `
      + `Map the unmapped items to raise it.`);
  }
  if (compliancePct == null) {
    withheld.push('No timesheet compliance figure for this window, so the compliance component cannot be computed.');
  }
  if (weighted_coverage_pct == null) {
    // Two different situations, and conflating them would hide the
    // biggest constraint on this whole feature. On the client's live
    // instance 1,338 of 1,427 people have no KRA sheet at all — for
    // them nothing is wrong with the mapping, there is simply nothing
    // to map TO, and the fix is a KRA sheet, not a mapping session.
    withheld.push((att.by_kra || []).length === 0
      ? 'This person has no KRAs for this cycle, so logged hours cannot be placed against anything. '
        + 'A KRA sheet has to exist before timesheets can say anything about performance.'
      : 'Every KRA on this sheet is marked as not measurable from timesheets, so there is nothing for logged hours to cover.');
  }

  let score = null;
  let grade = null;
  let components = null;
  if (!withheld.length) {
    const cov = weighted_coverage_pct;
    const cmp = Number(compliancePct);
    const val = value_add_pct == null ? 0 : value_add_pct;
    const total = wCov + wCmp + wVa;
    // Named rather than normalised silently: weights that do not total
    // 100 are a configuration mistake, and scaling them would hide it.
    if (!(total > 0)) {
      withheld.push('The scoring weights add up to zero — set them in HR Admin.');
    } else {
      components = [
        { key: 'coverage',   label: 'KRA coverage (weighted)', pct: cov, weight: wCov, points: round1(cov * wCov / 100) },
        { key: 'compliance', label: 'Timesheet compliance',    pct: round1(cmp), weight: wCmp, points: round1(cmp * wCmp / 100) },
        { key: 'value_add',  label: 'Value-add mentions',      pct: val, weight: wVa, points: round1(val * wVa / 100) },
      ];
      score = round1(components.reduce((t, c) => t + c.points, 0) * 100 / total);
      grade = gradeFor(score, cfg.bands);
    }
  }

  return {
    mapped_pct: att.totals.mapped_pct,
    weighted_coverage_pct,
    alignment_pct,
    value_add_pct,
    compliance_pct: compliancePct == null ? null : round1(Number(compliancePct)),
    scorable_kras: scorable.length,
    unscorable_kras: (att.unscorable || []).length,
    scorable_weight: round1(scorableWeight),
    score,
    grade,
    components,
    // Empty means a score was produced. Non-empty is the whole
    // explanation, in sentences, and the screen shows it verbatim.
    withheld,
    auto_score: autoScore,
  };
}

// What HR is allowed to set. A sentence, or null — it goes straight to
// the screen mid-edit.
function validateScoring(s) {
  const nums = [['weight_coverage', s.weight_coverage], ['weight_compliance', s.weight_compliance],
                ['weight_value_add', s.weight_value_add], ['min_mapped_pct', s.min_mapped_pct]];
  for (const [k, v] of nums) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `${k} must be a number between 0 and 100 — got "${v}"`;
  }
  const total = Number(s.weight_coverage) + Number(s.weight_compliance) + Number(s.weight_value_add);
  // Not normalised silently: three weights that total 90 mean somebody
  // mistyped one, and a score scaled up from them would look correct.
  if (Math.round(total) !== 100) return `The three weights must add up to 100 — they add up to ${round1(total)}.`;
  if (s.hours_per_day !== undefined) {
    const h = Number(s.hours_per_day);
    if (!Number.isFinite(h) || h <= 0 || h > 24) return `Hours per day must be between 0 and 24 — got "${s.hours_per_day}".`;
  }
  for (const [key, label] of [['bands', 'band'], ['kra_bands', 'KRA band']]) {
    const list = s[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.length) return `Give at least one ${label}.`;
    const seen = new Set();
    for (const b of list) {
      const l = String((b && b.label) || '').trim();
      if (!l) return `Every ${label} needs a label.`;
      if (seen.has(l.toLowerCase())) return `Two ${label}s are both called "${l}".`;
      seen.add(l.toLowerCase());
      const min = Number(b && b.min);
      if (!Number.isFinite(min) || min < 0 || min > 100) return `${label[0].toUpperCase()}${label.slice(1)} "${l}" needs a minimum between 0 and 100.`;
    }
    if (!list.some((b) => Number(b.min) === 0)) return `One ${label} must start at 0, or a low score gets no grade at all.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// A RATING FOR EACH KRA, from the hours worked against it.
//
// Asked for on 6 Oct ("there should be rating against KRA as per
// timesheet filled") and then specified the same day:
//
//   "in 6 KRAs, if 1 KRA … weighs 25%, it will be based on ratings like
//    A+, A, B+, B as per no of hours worked by the employee for that
//    month … e.g. I have to work 140 hours and I have worked 70 hours …
//    <40% will have B rating, <80% will be A and <100% will be A+."
//
// So, for one person and one window (a month, or the cycle so far):
//
//   required hours  = working days in the window × hours per day
//                     (weekends and the timesheet holiday list skipped)
//   KRA expected h  = required hours × the KRA's weight ÷ weight of the
//                     KRAs measured from timesheets
//   KRA effort %    = hours placed against the KRA ÷ KRA expected h,
//                     capped at 100
//   rating          = effort % on the tenant's KRA bands — by default
//                     A+ from 80, A from 70, B+ from 40, B below 40
//
// e.g. 140 required hours, a 25% KRA → 35 h expected; 17.5 h on it is
// 50% → B+. The weight is shared only over MEASURED KRAs: a KRA marked
// "not measured from timesheets" expects no hours, so its weight is not
// left as hours nobody can ever log.
//
// THE FIRST VERSION (same day) compared each KRA's share of the hours
// with its weight. The client replaced that with this: hours against
// required hours, which also counts how much was worked, not only how
// it was split.
//
// EVIDENCE, NOT THE RATING OF RECORD — the client's choice, "shown
// beside, manager decides". Nothing here writes into an evaluation.

// The client's ladder, as given on 6 Oct: "A+ < 100%, A < 80%, B+ < 70%",
// with B below 40% from their earlier message the same day.
const DEFAULT_KRA_BANDS = [{ label: 'A+', min: 80 }, { label: 'A', min: 70 }, { label: 'B+', min: 40 }, { label: 'B', min: 0 }];

/**
 * @param {object} att   the return of timesheet-kra-match.attribute()
 * @param {object} cfg   the `scoring` blob (kra_bands, hours_per_day, min_mapped_pct)
 * @param {{working_days:number}} win  working days in the window
 */
function kraRatings(att, cfg = {}, win = {}) {
  const bands = Array.isArray(cfg.kra_bands) && cfg.kra_bands.length ? cfg.kra_bands : DEFAULT_KRA_BANDS;
  const perDay = Number(cfg.hours_per_day) > 0 ? Number(cfg.hours_per_day) : 8;
  const days = Math.max(0, Number(win.working_days) || 0);
  const required = round1(days * perDay);
  const minMapped = Number(cfg.min_mapped_pct);
  const all = att.by_kra || [];
  const measured = all.filter((k) => k.scorable);
  const weightAll = measured.reduce((t, k) => t + (Number(k.weight) || 0), 0);
  const placed = measured.reduce((t, k) => t + (Number(k.hours) || 0), 0);
  const mappedPct = Number(att.totals && att.totals.mapped_pct) || 0;
  const thin = Number.isFinite(minMapped) && placed > 0 && mappedPct < minMapped;

  let note = null;
  if (!all.length) note = 'No KRA sheet for this cycle, so there is nothing to rate the hours against.';
  else if (!measured.length) note = 'Every KRA is marked as not measured from timesheets.';
  else if (!(required > 0)) note = 'No working days in this period, so no hours were required.';
  else if (!(placed > 0)) note = 'None of the logged hours are placed against a KRA yet. Map the work items to rate each KRA.';
  else if (thin) {
    note = `Only ${mappedPct}% of the hours logged are placed against a KRA (this tenant expects ${minMapped}%). `
      + 'Hours not yet mapped count for no KRA, so these ratings will rise as more items are mapped.';
  }

  const ratings = all.map((k) => {
    const row = { kra_id: k.kra_id, title: k.title, weight: Number(k.weight) || 0, hours: Number(k.hours) || 0 };
    if (!k.scorable) {
      return { ...row, measured: false, expected_hours: null, effort_pct: null, rating: null,
        reason: k.untracked_reason || 'Not measured from timesheets' };
    }
    const expected = weightAll > 0 ? round1((required * row.weight) / weightAll) : 0;
    if (!(expected > 0) || !(placed > 0)) {
      return { ...row, measured: true, expected_hours: expected || null, effort_pct: null, rating: null,
        reason: !(row.weight > 0) ? 'This KRA carries no weight' : !(required > 0) ? 'No working days' : 'No mapped hours yet' };
    }
    const effort = round1(clamp((row.hours / expected) * 100, 0, 100));
    return { ...row, measured: true, expected_hours: expected, effort_pct: effort,
      rating: gradeFor(effort, bands), reason: null };
  });
  return { ratings, required_hours: required, working_days: days, hours_per_day: perDay,
    placed_hours: round1(placed), mapped_pct: mappedPct, thin, note, bands };
}

module.exports = { summarise, gradeFor, validateScoring, kraRatings, DEFAULT_KRA_BANDS };
