// Pure increment maths — no db, so every number this produces is unit
// tested directly. Same split as phase-machine.js, rating-rules.js and
// reminder-schedule.js; the DB-touching orchestration lives in index.js.
//
// THIS MODELS PAY, IT DOES NOT SET IT. Nothing here or in the routes above
// writes to pms.compensation. A simulation that could quietly become
// somebody's actual salary is a different, much more dangerous feature
// than the one that was asked for, and keeping the write path absent is
// what makes "run a few scenarios" a safe thing to do.
//
// MONEY IS HANDLED IN PAISE (integer minor units) throughout, and only
// converted back at the edges. Floating-point rupees do not add up: a
// thousand employees at 7.5% each, summed as floats, drifts from the
// figure anyone gets adding the same column in a spreadsheet — and a
// budget comparison that is off by rounding is worse than no comparison.
const MINOR = 100;

const toMinor = (amount) => Math.round(Number(amount) * MINOR);
const toMajor = (minor) => Math.round(minor) / MINOR;

// The band a rating falls in. Ranges are INCLUSIVE at both ends, which is
// how people write them ("4 to 5 gets 10%"), and overlaps are rejected at
// write time rather than silently resolved here — see validateMatrix.
function matchBand(matrix, rating) {
  if (rating == null || !Number.isFinite(Number(rating))) return null;
  const r = Number(rating);
  return matrix.find((b) => r >= Number(b.rating_min) && r <= Number(b.rating_max)) || null;
}

// A matrix has to be unambiguous before it can be used: an overlap means
// one rating maps to two increments, and whichever the code picked first
// would be an accident. Reported as a list so HR fixes every clash at
// once rather than one per save.
function validateMatrix(bands) {
  const errors = [];
  bands.forEach((b, i) => {
    const lo = Number(b.rating_min), hi = Number(b.rating_max), pct = Number(b.increment_pct);
    const row = i + 1;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) errors.push({ row, error: 'rating range must be numeric' });
    else if (lo > hi) errors.push({ row, error: `rating range is backwards (${lo} to ${hi})` });
    if (!Number.isFinite(pct) || pct < 0) errors.push({ row, error: 'increment % must be zero or more' });
    else if (pct > 100) errors.push({ row, error: `increment of ${pct}% looks like a typo — more than doubling a salary` });
  });
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i], b = bands[j];
      if (Number(a.rating_min) <= Number(b.rating_max) && Number(b.rating_min) <= Number(a.rating_max)) {
        errors.push({ row: j + 1, error: `rating range ${b.rating_min}-${b.rating_max} overlaps row ${i + 1} (${a.rating_min}-${a.rating_max}) — one rating cannot map to two increments` });
      }
    }
  }
  return errors;
}

// One scenario.
//
// employees: [{ employee_id, name, department, final_rating, current_ctc }]
//   current_ctc may be null — someone with no salary on record cannot be
//   modelled, and is REPORTED rather than assumed to earn nothing.
// matrix:    the bands
// overrides: { employee_id: { increment_pct, reason } } — a deliberate,
//   named exception, which is why scale-to-fit leaves them alone.
// budgetAmount: the pot, in major units, or null for "no budget set".
// scaleToFit: when the modelled cost exceeds the budget, scale the
//   non-overridden increments down proportionally so the total lands on
//   the budget exactly.
function simulate({ employees, matrix, overrides = {}, budgetAmount = null, scaleToFit = false }) {
  const bands = Array.isArray(matrix) ? matrix : [];
  const lines = [];
  const excluded = [];

  for (const e of employees) {
    const override = overrides[e.employee_id];
    const band = matchBand(bands, e.final_rating);
    const ctcMinor = e.current_ctc == null ? null : toMinor(e.current_ctc);

    // Excluded, and each for a REASON that is reported. A silently
    // dropped employee in a budget exercise is somebody who does not get
    // a raise because a spreadsheet lost them.
    if (ctcMinor == null) { excluded.push({ ...e, reason: 'no salary on record' }); continue; }
    if (e.final_rating == null) { excluded.push({ ...e, reason: 'no published rating for this cycle' }); continue; }
    if (!override && !band) { excluded.push({ ...e, reason: `rating ${e.final_rating} falls outside every band in the matrix` }); continue; }

    const pct = override ? Number(override.increment_pct) : Number(band.increment_pct);
    lines.push({
      employee_id: e.employee_id, name: e.name, department: e.department,
      final_rating: e.final_rating,
      current_ctc: toMajor(ctcMinor),
      band_label: override ? null : (band.label || `${band.rating_min}-${band.rating_max}`),
      base_pct: band ? Number(band.increment_pct) : null,
      increment_pct: pct,
      overridden: !!override,
      override_reason: override ? (override.reason || null) : null,
      _ctcMinor: ctcMinor,
    });
  }

  const cost = (l) => Math.round(l._ctcMinor * (l.increment_pct / 100));
  let scaleFactor = 1;
  let modelledMinor = lines.reduce((sum, l) => sum + cost(l), 0);
  const budgetMinor = budgetAmount == null ? null : toMinor(budgetAmount);

  if (scaleToFit && budgetMinor != null && modelledMinor > budgetMinor) {
    // Overrides are deliberate decisions someone signed their name to, so
    // the squeeze falls on the matrix-driven lines only. If the overrides
    // alone already exceed the budget there is nothing left to scale, and
    // saying so is more use than scaling them to nonsense.
    const fixedMinor = lines.filter((l) => l.overridden).reduce((s, l) => s + cost(l), 0);
    const flexMinor = modelledMinor - fixedMinor;
    const roomMinor = budgetMinor - fixedMinor;
    if (flexMinor > 0 && roomMinor > 0) {
      scaleFactor = roomMinor / flexMinor;
      for (const l of lines) {
        if (l.overridden) continue;
        // Two decimals, rounded DOWN, not to nearest.
        //
        // A percentage nobody can read off a payslip is not a usable
        // output, so it has to be rounded — but rounding to nearest can
        // push the total back OVER the budget, which is the one thing
        // scale-to-fit exists to prevent. Found in testing: an override
        // plus one scaled line landed on 160,020 against a 160,000 pot,
        // and the report cheerfully called it within budget.
        //
        // Flooring guarantees at-or-under, always. The cost is a small
        // unspent remainder, which is reported honestly as variance —
        // being a few hundred under a budget is a fact someone can act
        // on; being twenty over while claiming to be inside it is not.
        l.increment_pct = Math.floor(l.increment_pct * scaleFactor * 100) / 100;
        l.scaled = true;
      }
      modelledMinor = lines.reduce((sum, l) => sum + cost(l), 0);
    }
  }

  for (const l of lines) {
    const c = cost(l);
    l.increment_amount = toMajor(c);
    l.new_ctc = toMajor(l._ctcMinor + c);
    delete l._ctcMinor;
  }

  const currentMinor = lines.reduce((s, l) => s + toMinor(l.current_ctc), 0);
  return {
    lines,
    excluded,
    totals: {
      employees: lines.length,
      excluded: excluded.length,
      current_total: toMajor(currentMinor),
      increment_total: toMajor(modelledMinor),
      new_total: toMajor(currentMinor + modelledMinor),
      // The blended percentage — the single number a finance conversation
      // actually turns on.
      average_increment_pct: currentMinor ? Math.round((modelledMinor / currentMinor) * 10000) / 100 : 0,
      budget: budgetAmount == null ? null : Number(budgetAmount),
      variance: budgetMinor == null ? null : toMajor(budgetMinor - modelledMinor),
      within_budget: budgetMinor == null ? null : modelledMinor <= budgetMinor,
      scaled: scaleFactor !== 1,
      scale_factor: scaleFactor === 1 ? null : Math.round(scaleFactor * 10000) / 10000,
    },
  };
}

// Cost by department, for the "who is this going to" question a budget
// conversation always reaches.
function byDepartment(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = l.department || '(no department)';
    const d = map.get(key) || { department: key, employees: 0, current_total: 0, increment_total: 0 };
    d.employees += 1;
    d.current_total = Math.round((d.current_total + l.current_ctc) * 100) / 100;
    d.increment_total = Math.round((d.increment_total + l.increment_amount) * 100) / 100;
    map.set(key, d);
  }
  return [...map.values()]
    .map((d) => ({ ...d, average_increment_pct: d.current_total ? Math.round((d.increment_total / d.current_total) * 10000) / 100 : 0 }))
    .sort((a, b) => b.increment_total - a.increment_total);
}

module.exports = { matchBand, validateMatrix, simulate, byDepartment, toMinor, toMajor };
