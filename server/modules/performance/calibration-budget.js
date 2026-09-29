// Pure kitty maths for the Calibration page — no db, no express, so
// every figure it produces is unit tested directly. Same split as
// increment-rules.js, which it deliberately mirrors.
//
// Asked for on 29 Sep: a salary-bracket filter, a real-time kitty and
// budget panel, per-grade increment ranges, three dedicated pools, and
// a grid that computes a revised CTC per person.
//
// MONEY IS HANDLED IN PAISE (integer minor units) and converted back
// only at the edges — the same rule, for the same reason, as
// increment-rules.js: a thousand employees at 7.5% each, summed as
// floats, drifts from the figure anyone gets adding the column in a
// spreadsheet, and a budget comparison that is off by rounding is worse
// than no comparison at all.
//
// THIS MODELS PAY, IT DOES NOT SET IT. Nothing here or in the routes
// that call it writes to pms.compensation. A calibration figure that
// could quietly become somebody's actual salary is a far more dangerous
// feature than the one asked for.
//
// THE THREE RULES THE CLIENT CONFIRMED ON 29 SEP:
//   1. retention / market / promotion pools sit ON TOP of the kitty,
//      each with its own remaining counter.
//   2. total hike INCLUDES retention, so revised CTC is what the person
//      will actually be paid.
//   3. resigned AND retention not approved => zero, and excluded from
//      the kitty spend, but still counted in the rating distribution.

const MINOR = 100;
const toMinor = (amount) => Math.round(Number(amount) * MINOR);
const toMajor = (minor) => Math.round(minor) / MINOR;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ---- the salary bracket -------------------------------------------------
//
// Strictly ABOVE the threshold is the upper bracket, so a salary of
// exactly 50 lakhs falls in "≤ 50L" — which is what "≤" says, and the
// boundary case is the one somebody always argues about.
//
// Nobody with no CTC on record is placed in either bracket. Guessing
// would put every unpriced employee in the lower one and quietly
// inflate its headcount.
function bracketOf(ctc, threshold) {
  if (ctc == null || ctc === '') return 'unknown';
  const c = Number(ctc);
  if (!Number.isFinite(c)) return 'unknown';
  return c > Number(threshold) ? 'above' : 'at_or_below';
}

const BRACKETS = ['all', 'above', 'at_or_below'];
const inBracket = (row, filter, threshold) =>
  filter === 'all' || !filter ? true : bracketOf(row.current_ctc, threshold) === filter;

// ---- the band a rating falls in ----------------------------------------
// Inclusive at both ends, exactly as increment-rules.matchBand, because
// they read the same table and must not disagree about who is an A.
function bandFor(matrix, rating) {
  if (rating == null || !Number.isFinite(Number(rating))) return null;
  const r = Number(rating);
  return (matrix || []).find((b) => r >= Number(b.rating_min) && r <= Number(b.rating_max)) || null;
}

// ---- one employee's line ------------------------------------------------
//
// alloc may be absent, which means "nothing decided yet": the standard
// hike falls back to the matrix and everything else is zero. That is NOT
// the same as a decision to give somebody nothing, and the caller can
// tell the two apart by `alloc_exists`.
function lineFor({ employee, alloc, matrix }) {
  const a = alloc || {};
  const band = bandFor(matrix, employee.final_rating);

  // NULL standard_pct means "track the matrix". A number means HR
  // overrode it for this person.
  const overridden = a.standard_pct != null && a.standard_pct !== '';
  const matrixPct = band ? num(band.increment_pct) : null;
  let standard = overridden ? num(a.standard_pct) : (matrixPct == null ? 0 : matrixPct);

  const market = num(a.market_pct);
  const promotion = num(a.promotion_pct);
  const retention = num(a.retention_pct);
  const lumpsum = num(a.retention_lumpsum);

  const resigned = !!employee.resignation_date;
  const retained = resigned && !!a.retention_approved;

  // RULE 3. Leaving and not being retained means no increment at all —
  // not a small one. Zeroed here rather than filtered out, so the person
  // is still visible on the grid with the reason showing, and still
  // counted in the rating distribution they earned.
  const frozen = resigned && !retained;
  if (frozen) { standard = 0; }

  const standardPct = frozen ? 0 : standard;
  const marketPct = frozen ? 0 : market;
  const promotionPct = frozen ? 0 : promotion;
  // Retention only ever applies to somebody actually being retained.
  const retentionPct = retained ? retention : 0;
  const retentionLumpsum = retained ? lumpsum : 0;

  // RULE 2: retention is part of the total, so revised CTC is the real
  // number. Rounded to 2dp because a percentage sum in binary floating
  // point produces 21.000000000000004, which renders as-is on screen.
  const totalPct = Math.round((standardPct + marketPct + promotionPct + retentionPct) * 100) / 100;

  const ctc = employee.current_ctc == null ? null : Number(employee.current_ctc);
  const hasCtc = ctc != null && Number.isFinite(ctc);

  // Each component's rupee cost, in paise, so the pool totals below are
  // exact. A component is costed against the CURRENT ctc, not
  // compounding on each other — which is how a hike sheet is read.
  const cost = (pct) => (hasCtc ? Math.round(toMinor(ctc) * (pct / 100)) : 0);
  const standardCostMinor = cost(standardPct);
  const marketCostMinor = cost(marketPct);
  const promotionCostMinor = cost(promotionPct);
  const retentionCostMinor = cost(retentionPct) + (retained ? toMinor(retentionLumpsum) : 0);
  const totalCostMinor = standardCostMinor + marketCostMinor + promotionCostMinor + retentionCostMinor;

  return {
    employee_id: employee.employee_id,
    name: employee.name,
    emp_code: employee.emp_code || null,
    department: employee.department || null,
    designation: employee.designation || null,
    delivery_head: employee.delivery_head || null,
    final_rating: employee.final_rating == null ? null : Number(employee.final_rating),
    band_label: band ? band.label : null,
    band_min_pct: band && band.increment_pct_min != null ? Number(band.increment_pct_min) : null,
    band_max_pct: band && band.increment_pct_max != null ? Number(band.increment_pct_max) : null,
    matrix_pct: matrixPct,
    standard_overridden: overridden,

    current_ctc: hasCtc ? ctc : null,
    // Said out loud rather than shown as a zero: somebody with no salary
    // on record cannot be modelled, and an unpriced employee rendered as
    // ₹0 looks exactly like one who earns nothing.
    ctc_missing: !hasCtc,

    resigned,
    resignation_date: employee.resignation_date || null,
    last_working_date: employee.last_working_date || null,
    retention_approved: retained,
    frozen,

    promoted: !!a.promoted,
    proposed_designation: a.proposed_designation || null,
    proposed_band: a.proposed_band || null,

    standard_pct: standardPct,
    market_pct: marketPct,
    promotion_pct: promotionPct,
    retention_pct: retentionPct,
    retention_lumpsum: retentionLumpsum,
    total_pct: totalPct,
    revised_ctc: hasCtc ? toMajor(toMinor(ctc) + totalCostMinor) : null,

    standard_cost: toMajor(standardCostMinor),
    market_cost: toMajor(marketCostMinor),
    promotion_cost: toMajor(promotionCostMinor),
    retention_cost: toMajor(retentionCostMinor),
    total_cost: toMajor(totalCostMinor),

    reasons: {
      standard: a.standard_reason || null,
      market: a.market_reason || null,
      promotion: a.promotion_reason || null,
      retention: a.retention_reason || null,
    },
    // `out of band` is not an error — a range is guidance and an
    // exception is allowed. It is FLAGGED so a calibration session can
    // see it and ask, which is the whole point of showing a range.
    out_of_band: band && band.increment_pct_min != null && band.increment_pct_max != null
      && !frozen
      && (standardPct < Number(band.increment_pct_min) || standardPct > Number(band.increment_pct_max)),
  };
}

// ---- the whole page -----------------------------------------------------
//
// employees: [{ employee_id, name, department, designation, final_rating,
//               current_ctc, resignation_date, ... }]
// allocs:    { employee_id: <allocation row> }
// matrix:    the increment bands, carrying label and optional min/max
// budget:    { kitty_pct, bracket_threshold, retention_pool, market_pool,
//              promotion_pool }
// bellCurve: { '5': 5, '4': 15, ... } from the cycle
// bracket:   'all' | 'above' | 'at_or_below'
function summarise({ employees, allocs = {}, matrix = [], budget = {}, bellCurve = {}, bracket = 'all' }) {
  const threshold = num(budget.bracket_threshold, 5000000);
  const all = (employees || []).map((e) => lineFor({ employee: e, alloc: allocs[e.employee_id], matrix }));
  const lines = all.filter((l) => inBracket({ current_ctc: l.current_ctc }, bracket, threshold));

  // The total salary pool is the CTC of the people actually on screen,
  // so every figure in the panel describes the same population as the
  // table under it.
  let poolMinor = 0;
  let ctcMissing = 0;
  for (const l of lines) {
    if (l.current_ctc == null) { ctcMissing++; continue; }
    poolMinor += toMinor(l.current_ctc);
  }

  // RULE 3: a frozen line spends nothing and is not counted in the pool
  // the kitty percentage is measured against.
  let kittyBaseMinor = 0;
  for (const l of lines) {
    if (l.frozen || l.current_ctc == null) continue;
    kittyBaseMinor += toMinor(l.current_ctc);
  }

  const spend = { standard: 0, market: 0, promotion: 0, retention: 0 };
  for (const l of lines) {
    spend.standard += toMinor(l.standard_cost);
    spend.market += toMinor(l.market_cost);
    spend.promotion += toMinor(l.promotion_cost);
    spend.retention += toMinor(l.retention_cost);
  }

  // RULE 1: the kitty funds the STANDARD hikes. The other three are
  // their own pools, on top, each answerable on its own.
  const kittyPct = num(budget.kitty_pct);
  const kittyMinor = Math.round(kittyBaseMinor * (kittyPct / 100));

  const pool = (approvedMajor, spentMinor) => {
    const approved = Math.round(toMinor(num(approvedMajor)));
    return {
      approved: toMajor(approved),
      spent: toMajor(spentMinor),
      remaining: toMajor(approved - spentMinor),
      over: spentMinor > approved,
      // Guard the divide: an unset pool is 0, and 0/0 is not 100% spent.
      used_pct: approved > 0 ? Math.round((spentMinor / approved) * 1000) / 10 : null,
    };
  };

  const pools = {
    kitty: pool(toMajor(kittyMinor), spend.standard),
    retention: pool(budget.retention_pool, spend.retention),
    market: pool(budget.market_pool, spend.market),
    promotion: pool(budget.promotion_pool, spend.promotion),
  };

  // ---- the grade table ---------------------------------------------------
  // Counted over the lines ON SCREEN, so switching bracket re-splits the
  // distribution rather than leaving a company-wide one above a filtered
  // table — which would read as a contradiction.
  const byRating = new Map();
  for (const l of lines) {
    const k = l.final_rating == null ? 'unrated' : String(Math.round(l.final_rating));
    if (!byRating.has(k)) byRating.set(k, { count: 0, spend: 0 });
    const g = byRating.get(k);
    g.count++;
    g.spend += toMinor(l.total_cost);
  }
  const rated = lines.length;
  const gradeRows = [];
  for (const b of (matrix || [])) {
    // The whole rating a band stands for, used to look up its
    // bell-curve target.
    //
    // FLOOR, NOT ROUND. The bands are one whole rating each, written
    // as 3.5-4.4 for "an A", so the rating they represent is the
    // highest whole number inside them. Math.round got this wrong the
    // moment the numeric(3,1) column stored 4.49 as 4.5: round(4.5) is
    // 5, so every grade below A+ read its neighbour's target and the
    // whole distribution was off by one — silently, because the
    // numbers all looked plausible.
    const key = String(Math.floor(Number(b.rating_max)));
    const g = byRating.get(key) || { count: 0, spend: 0 };
    gradeRows.push({
      label: b.label || key,
      rating: Number(key),
      target_pct: bellCurve[key] == null ? null : Number(bellCurve[key]),
      count: g.count,
      actual_pct: rated ? Math.round((g.count / rated) * 1000) / 10 : 0,
      increment_min_pct: b.increment_pct_min == null ? null : Number(b.increment_pct_min),
      increment_max_pct: b.increment_pct_max == null ? null : Number(b.increment_pct_max),
      standard_pct: b.increment_pct == null ? null : Number(b.increment_pct),
      spend: toMajor(g.spend),
    });
  }
  const unrated = byRating.get('unrated') || { count: 0, spend: 0 };

  return {
    bracket,
    bracket_threshold: threshold,
    counts: {
      employees: lines.length,
      of_total: all.length,
      ctc_missing: ctcMissing,
      resigned: lines.filter((l) => l.resigned).length,
      frozen: lines.filter((l) => l.frozen).length,
      promoted: lines.filter((l) => l.promoted).length,
    },
    total_ctc: toMajor(poolMinor),
    kitty_base_ctc: toMajor(kittyBaseMinor),
    kitty_pct: kittyPct,
    pools,
    total_spend: toMajor(spend.standard + spend.market + spend.promotion + spend.retention),
    grades: gradeRows,
    unrated: { count: unrated.count, spend: toMajor(unrated.spend) },
    warnings: warningsFor(pools, ctcMissing, lines),
    lines,
  };
}

// Said before anyone presses anything, and each one names the pool and
// the amount rather than saying "over budget" — an alert a person cannot
// act on is noise, and noise gets clicked through.
function warningsFor(pools, ctcMissing, lines) {
  const out = [];
  const money = (n) => `₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
  for (const [key, label] of [['kitty', 'incremental kitty'], ['retention', 'retention pool'],
    ['market', 'market correction pool'], ['promotion', 'promotion pool']]) {
    const p = pools[key];
    if (p.over) out.push(`The ${label} is over by ${money(p.remaining)} — ${money(p.spent)} allocated against ${money(p.approved)}.`);
  }
  if (ctcMissing > 0) {
    out.push(`${ctcMissing} ${ctcMissing === 1 ? 'person has' : 'people have'} no CTC on record, so ${ctcMissing === 1 ? 'they are' : 'they are'} not costed into any figure above. Upload compensation to include ${ctcMissing === 1 ? 'them' : 'them'}.`);
  }
  const oob = lines.filter((l) => l.out_of_band).length;
  if (oob > 0) out.push(`${oob} ${oob === 1 ? 'person is' : 'people are'} outside the target increment range for their grade.`);
  return out;
}

// ---- what the routes will accept ---------------------------------------
//
// Validation is here, beside the maths it protects, and returns a
// SENTENCE rather than a code — the message goes straight to HR mid-
// edit, and "invalid input" is not something anyone can act on.

const PCT_CEILING = 100;      // a hike that doubles a salary is a typo
const LUMPSUM_CEILING = 1e9;  // ₹100 crore to one person is a typo too

const badPct = (v, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return `${what} must be a number.`;
  if (n < 0) return `${what} cannot be negative.`;
  if (n > PCT_CEILING) return `${what} of ${n}% looks like a typo — that more than doubles the salary.`;
  return null;
};

function validateBudget(b) {
  const k = b.kitty_pct;
  if (k !== undefined && k !== null && k !== '') {
    const n = Number(k);
    if (!Number.isFinite(n) || n < 0) return 'The kitty % must be zero or more.';
    if (n > PCT_CEILING) return `A kitty of ${n}% of payroll looks like a typo.`;
  }
  if (b.bracket_threshold !== undefined && b.bracket_threshold !== null && b.bracket_threshold !== '') {
    const n = Number(b.bracket_threshold);
    if (!Number.isFinite(n) || n <= 0) return 'The salary bracket threshold must be more than zero.';
  }
  for (const [key, label] of [['retention_pool', 'retention pool'], ['market_pool', 'market correction pool'],
    ['promotion_pool', 'promotion pool']]) {
    const v = b[key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `The ${label} must be zero or more.`;
  }
  return null;
}

// A PATCH, not a replace: the grid saves one field at a time, and a
// body carrying only market_pct must not wipe the promotion reason
// somebody typed a minute ago.
function mergeAllocation(cur, patch) {
  const take = (key, fallback) => (patch[key] === undefined ? fallback : patch[key]);
  // undefined counts as absent, exactly like null and ''.
  //
  // It did not, and the result was that EVERY first allocation was
  // refused: merging {market_pct: 5} onto a row that does not exist
  // yet left promotion_pct as Number(undefined) — NaN — which
  // validateAllocation correctly rejected as "must be a number". The
  // unit test missed it by merging onto a fully populated row, which
  // is the one case where no key is ever absent.
  const pct = (key, fallback) => {
    const v = take(key, fallback);
    return v === null || v === '' || v === undefined ? 0 : Number(v);
  };
  const text = (key, fallback) => {
    const v = take(key, fallback);
    return v == null || String(v).trim() === '' ? null : String(v).trim();
  };
  // standard_pct alone keeps NULL as a meaningful value: "track the
  // matrix". An empty string from a cleared input means exactly that.
  const rawStd = take('standard_pct', cur.standard_pct);
  const standard_pct = rawStd === null || rawStd === '' || rawStd === undefined ? null : Number(rawStd);

  return {
    standard_pct,
    standard_reason: text('standard_reason', cur.standard_reason),
    market_pct: pct('market_pct', cur.market_pct),
    market_reason: text('market_reason', cur.market_reason),
    promoted: take('promoted', cur.promoted) === undefined ? false : !!take('promoted', cur.promoted),
    proposed_designation: text('proposed_designation', cur.proposed_designation),
    proposed_band: text('proposed_band', cur.proposed_band),
    promotion_pct: pct('promotion_pct', cur.promotion_pct),
    promotion_reason: text('promotion_reason', cur.promotion_reason),
    retention_approved: take('retention_approved', cur.retention_approved) === undefined
      ? false : !!take('retention_approved', cur.retention_approved),
    retention_pct: pct('retention_pct', cur.retention_pct),
    retention_lumpsum: pct('retention_lumpsum', cur.retention_lumpsum),
    retention_reason: text('retention_reason', cur.retention_reason),
  };
}

// EVERY SPECIAL HIKE NEEDS ITS REASON. Same discipline as a rating
// adjustment, for the same reason: "why did this person get 14% when
// the band says 8%" is the first question asked of any compensation
// round, and the answer has to be queryable rather than remembered.
function validateAllocation(a, { resigned = false } = {}) {
  for (const [key, label] of [['standard_pct', 'Standard hike'], ['market_pct', 'Market correction'],
    ['promotion_pct', 'Promotion hike'], ['retention_pct', 'Retention increase']]) {
    const bad = badPct(a[key], label);
    if (bad) return bad;
  }
  const lump = Number(a.retention_lumpsum || 0);
  if (!Number.isFinite(lump) || lump < 0) return 'The retention lump sum must be zero or more.';
  if (lump > LUMPSUM_CEILING) return 'That retention lump sum looks like a typo.';

  if (a.standard_pct != null && !a.standard_reason) {
    return 'Overriding the standard hike needs a reason — it is the permanent answer to "why did this person get a different increment from their band".';
  }
  if (Number(a.market_pct) > 0 && !a.market_reason) {
    return 'A market correction needs a reason.';
  }
  if (Number(a.promotion_pct) > 0 && !a.promotion_reason) {
    return 'A promotion hike needs a reason.';
  }
  if (a.promoted && !a.proposed_designation && !a.proposed_band) {
    return 'A promotion needs the new designation or band it is to.';
  }
  if (Number(a.promotion_pct) > 0 && !a.promoted) {
    return 'A promotion hike needs the employee marked as promoted.';
  }
  // Retention is for people who are LEAVING. Booking one against
  // somebody who never resigned would spend the retention pool on a
  // hike that is really something else, and hide it from the pool it
  // should have come out of.
  if (!resigned && (a.retention_approved || Number(a.retention_pct) > 0 || lump > 0)) {
    return 'Retention applies only to somebody who has resigned — there is no resignation date on this employee.';
  }
  if (a.retention_approved && !a.retention_reason) {
    return 'Approving retention needs a reason.';
  }
  if (!a.retention_approved && (Number(a.retention_pct) > 0 || lump > 0)) {
    return 'A retention increase needs retention to be approved first.';
  }
  return null;
}

module.exports = { bracketOf, inBracket, bandFor, lineFor, summarise, warningsFor,
                   validateBudget, mergeAllocation, validateAllocation,
                   BRACKETS, toMinor, toMajor };
