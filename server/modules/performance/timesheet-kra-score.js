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
  if (s.bands !== undefined) {
    if (!Array.isArray(s.bands) || !s.bands.length) return 'Give at least one band.';
    const seen = new Set();
    for (const b of s.bands) {
      const label = String((b && b.label) || '').trim();
      if (!label) return 'Every band needs a label.';
      if (seen.has(label.toLowerCase())) return `Two bands are both called "${label}".`;
      seen.add(label.toLowerCase());
      const min = Number(b && b.min);
      if (!Number.isFinite(min) || min < 0 || min > 100) return `Band "${label}" needs a minimum between 0 and 100.`;
    }
    // A ladder with no floor silently returns no grade for a low score,
    // which reads on screen as the engine failing.
    if (!s.bands.some((b) => Number(b.min) === 0)) return 'One band must start at 0, or a low score gets no grade at all.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// A RATING FOR EACH KRA, from the timesheet. Added 6 Oct.
//
// Asked for directly: "there should be rating against KRA as per
// timesheet filled". The coverage numbers above describe the sheet as a
// whole; nothing turned one KRA's logged effort into a rating for that
// KRA, which is what was wanted. The client chose the basis:
//
//   "Hours on the KRA as a share of all mapped hours, compared with the
//    KRA's weight … rates as per efforts of employee working for
//    particular KRA. Works for part-timers and partial months."
//
// So, per timesheet-measured KRA:
//
//   effort share   = hours on this KRA / hours on all measured KRAs
//   expected share = this KRA's weight / weight of all measured KRAs
//   effort %       = effort share / expected share, capped at 100
//
// A 30% KRA that got 30% of the effort scores 100% and the top band; one
// that got 15% scores 50%; one that got none scores 0. Capped because
// more than its share on one KRA is less than theirs on another, and
// that shortfall is rated where it happened. Expected share is over the
// MEASURED KRAs only, for the same reason weighted coverage is: a KRA
// marked "not measured from timesheets" would otherwise sit in every
// denominator as a permanent zero.
//
// THIS IS EVIDENCE, NOT THE RATING OF RECORD — also the client's choice
// ("shown beside, manager decides"). It is never written into a manager
// or HOD evaluation. The bands are the tenant's (kra_bands if HR set
// them, else the same ladder as the monthly indicator) and no rating is
// invented when there is nothing to rate: no mapped hours means no
// rating and a sentence saying why. A thin mapping is flagged on every
// row rather than hidden, because a rating on 13% of the hours is still
// worth showing a manager, as long as it says it is on 13%.

/**
 * @param {object} att  the return of timesheet-kra-match.attribute()
 * @param {object} cfg  the `scoring` blob
 * @returns {{ratings:object[], basis_hours:number, mapped_pct:number, thin:boolean, note:string|null}}
 */
function kraRatings(att, cfg = {}) {
  const bands = Array.isArray(cfg.kra_bands) && cfg.kra_bands.length ? cfg.kra_bands : cfg.bands;
  const minMapped = Number(cfg.min_mapped_pct);
  const all = att.by_kra || [];
  const measured = all.filter((k) => k.scorable);
  const basis = measured.reduce((t, k) => t + (Number(k.hours) || 0), 0);
  const weightAll = measured.reduce((t, k) => t + (Number(k.weight) || 0), 0);
  const mappedPct = Number(att.totals && att.totals.mapped_pct) || 0;
  const thin = Number.isFinite(minMapped) && mappedPct < minMapped;

  let note = null;
  if (!all.length) note = 'No KRA sheet for this cycle, so there is nothing to rate the hours against.';
  else if (!measured.length) note = 'Every KRA is marked as not measured from timesheets.';
  else if (!(basis > 0)) note = 'None of the logged hours are placed against a KRA yet. Map the work items to rate each KRA.';
  else if (thin) {
    note = `Based on ${round1(basis)} h placed against KRAs — ${mappedPct}% of the hours logged, `
      + `below the ${minMapped}% this tenant expects. Treat these as indicative until more items are mapped.`;
  }

  const ratings = all.map((k) => {
    const row = { kra_id: k.kra_id, title: k.title, weight: Number(k.weight) || 0, hours: Number(k.hours) || 0 };
    if (!k.scorable) {
      return { ...row, measured: false, effort_pct: null, rating: null,
        reason: k.untracked_reason || 'Not measured from timesheets' };
    }
    if (!(basis > 0) || !(weightAll > 0) || !(row.weight > 0)) {
      return { ...row, measured: true, effort_pct: null, rating: null, share_pct: null,
        expected_pct: weightAll > 0 ? round1((row.weight / weightAll) * 100) : null,
        reason: !(row.weight > 0) ? 'This KRA carries no weight' : 'No mapped hours yet' };
    }
    const share = row.hours / basis;
    const expected = row.weight / weightAll;
    const effort = round1(clamp((share / expected) * 100, 0, 100));
    return { ...row, measured: true, share_pct: round1(share * 100), expected_pct: round1(expected * 100),
      effort_pct: effort, rating: gradeFor(effort, bands), reason: null };
  });
  return { ratings, basis_hours: round1(basis), mapped_pct: mappedPct, thin, note };
}

module.exports = { summarise, gradeFor, validateScoring, kraRatings };
