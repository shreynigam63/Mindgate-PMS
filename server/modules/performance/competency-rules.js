// The arithmetic behind competency mapping.
//
// Pure — no db, no express — because every number this module puts in
// front of HR is a number somebody will argue with, and the house rule
// is that numbers are deterministic and testable. The AI narrates; this
// decides.
//
// THE GAP is manager rating minus required level, and it is never
// stored. A derived number in a column is a number that can disagree
// with its own inputs, which is how "why did my rating change" becomes
// unanswerable.

// A rating is 1-5 or nothing. Zero is not "unrated" — it is a value
// somebody typed, and silently treating it as unrated loses the fact
// that they typed it.
function validRating(v) {
  if (v === null || v === undefined || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n)) return { ok: false, reason: `rating must be a whole number 1-5 — got "${v}"` };
  if (n < 1 || n > 5) return { ok: false, reason: `rating must be between 1 and 5 — got ${n}` };
  return { ok: true, value: n };
}

// What a specific job needs. Designation-first with an optional
// department, and a named department beats a blank one — the same rule
// the KRA library uses for its shelves, so HR learns it once.
//
// levels: rows of { competency_id, designation, department, required_level }
function requiredLevelFor(competencyId, { designation, department }, levels) {
  const mine = (levels || []).filter((l) => l.competency_id === competencyId
    && eq(l.designation, designation));
  const exact = mine.find((l) => l.department && eq(l.department, department));
  if (exact) return exact.required_level;
  const anyDept = mine.find((l) => !l.department);
  return anyDept ? anyDept.required_level : null;
}
const eq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// The competencies one person is actually asked about. Leadership is
// not asked of somebody with nobody to lead — a form that makes an
// individual contributor rate their Delegation teaches them that the
// form is not about them.
function competenciesFor(all, { hasReports }) {
  return (all || []).filter((c) => c.active !== false && (!c.managers_only || hasReports));
}

// One person's assessment, rolled up. Returns per-category and overall
// figures, plus the gaps worth acting on.
//
// `rated` counts rows the MANAGER has rated, because the gap is against
// the manager's view: a self-rating with no manager rating yet has no
// gap, and averaging it in would let an optimistic self-assessment move
// a company-level number.
function summarise(rows, { scale } = {}) {
  const byCat = new Map();
  let selfSum = 0, selfN = 0, mgrSum = 0, mgrN = 0, reqSum = 0;
  for (const r of rows || []) {
    const cat = r.category || 'Uncategorised';
    if (!byCat.has(cat)) byCat.set(cat, { category: cat, n: 0, self_sum: 0, self_n: 0,
      manager_sum: 0, manager_n: 0, required_sum: 0, gap_sum: 0, below: 0 });
    const c = byCat.get(cat);
    c.n += 1;
    if (r.self_rating != null) { c.self_sum += r.self_rating; c.self_n += 1; selfSum += r.self_rating; selfN += 1; }
    if (r.manager_rating != null) {
      c.manager_sum += r.manager_rating; c.manager_n += 1; mgrSum += r.manager_rating; mgrN += 1;
      c.required_sum += r.required_level; reqSum += r.required_level;
      const gap = r.manager_rating - r.required_level;
      c.gap_sum += gap;
      if (gap < 0) c.below += 1;
    }
  }
  const categories = [...byCat.values()].map((c) => ({
    category: c.category,
    competencies: c.n,
    rated: c.manager_n,
    avg_self: avg(c.self_sum, c.self_n),
    avg_manager: avg(c.manager_sum, c.manager_n),
    avg_required: avg(c.required_sum, c.manager_n),
    avg_gap: avg(c.gap_sum, c.manager_n),
    below_required: c.below,
    priority: priorityOf(avg(c.gap_sum, c.manager_n), c.below),
  }));

  // The gaps, worst first. A list of four things to work on is a list
  // somebody acts on; a list of forty is a spreadsheet.
  const gaps = (rows || [])
    .filter((r) => r.manager_rating != null && r.manager_rating < r.required_level)
    .map((r) => ({
      competency_id: r.competency_id, category: r.category, name: r.name,
      current: r.manager_rating, required: r.required_level,
      gap: r.manager_rating - r.required_level,
      current_label: labelFor(scale, r.manager_rating),
      required_label: labelFor(scale, r.required_level),
    }))
    .sort((a, b) => a.gap - b.gap || a.name.localeCompare(b.name));

  return {
    categories,
    overall: {
      competencies: (rows || []).length,
      self_rated: selfN,
      manager_rated: mgrN,
      avg_self: avg(selfSum, selfN),
      avg_manager: avg(mgrSum, mgrN),
      avg_required: avg(reqSum, mgrN),
      avg_gap: avg(mgrSum - reqSum, mgrN),
      below_required: gaps.length,
    },
    gaps,
  };
}

// Two decimals, and NULL rather than 0 when there is nothing to average
// — "0.0 average rating" and "nobody has been rated" are different
// facts and a dashboard must not confuse them.
const avg = (sum, n) => (n ? Math.round((sum / n) * 100) / 100 : null);
const labelFor = (scale, level) => {
  const row = (scale || []).find((s) => s.level === level);
  return row ? row.label : null;
};

// Where HR should look first. Thresholds are deliberate and stated: a
// category is High when it averages a full level below what the roles
// require, Medium at half a level, Low otherwise.
function priorityOf(avgGap, below) {
  if (avgGap == null) return null;
  if (avgGap <= -1) return 'High';
  if (avgGap <= -0.5 || below >= 3) return 'Medium';
  if (avgGap < 0) return 'Low';
  return 'Met';
}

// Where employee and manager see the same person differently. This is
// the conversation the whole exercise exists to start, so it is a first
// class output rather than something to spot by reading two columns.
//
// A difference of one level is normal calibration noise; two or more is
// a disagreement about the job.
function divergences(rows, { threshold = 2 } = {}) {
  return (rows || [])
    .filter((r) => r.self_rating != null && r.manager_rating != null
      && Math.abs(r.self_rating - r.manager_rating) >= threshold)
    .map((r) => ({
      competency_id: r.competency_id, category: r.category, name: r.name,
      self: r.self_rating, manager: r.manager_rating,
      delta: r.self_rating - r.manager_rating,
      direction: r.self_rating > r.manager_rating ? 'employee_rates_higher' : 'manager_rates_higher',
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
}

module.exports = { validRating, requiredLevelFor, competenciesFor, summarise, divergences, priorityOf };
