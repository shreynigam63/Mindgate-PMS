// Super 50 — the whole rule in one place.
//
// Restated by the client on 24 Sep: "ratings will be derived from last
// three annual reviews and ratings should be A or A+ with current year
// ratings as A+."
//
// Three things live here and they were previously scattered or absent:
//
//   the WINDOW — which three ratings count, which is published annual
//   history plus any prior years imported from whatever the client
//   appraised on before this product;
//
//   the RULE ITSELF, which is rating-rules.js and is configurable;
//
//   the DIAGNOSIS, which is new. An empty watchlist that says "no one
//   currently qualifies" is indistinguishable from a broken one, and on
//   this instance the truth was "no annual cycle has ever published, so
//   the window is empty for all 1,398 people". HR could not have known
//   that from the screen.
const db = require('../../core/db');
const { super50Check, DEFAULT_RULE, DEFAULT_SCALE } = require('./rating-rules');

// The rule, from admin_settings, falling back to the client's own words.
// Stored per key so each half can be changed independently, and read
// through one function so no caller can half-apply it.
async function super50Rule(tenantId) {
  const rows = (await db.query(
    `SELECT key, value FROM core.admin_settings
      WHERE tenant_id=$1 AND key IN ('super50_window','super50_min_grade','super50_latest_grade')`,
    [tenantId])).rows;
  const get = (k) => {
    const row = rows.find((r) => r.key === k);
    if (!row) return null;
    const v = row.value;
    return (v && typeof v === 'object' ? v.mode : v) || null;
  };
  const win = Number(get('super50_window'));
  return {
    window: Number.isInteger(win) && win > 0 ? win : DEFAULT_RULE.window,
    minGrade: get('super50_min_grade') || DEFAULT_RULE.minGrade,
    latestGrade: get('super50_latest_grade') || DEFAULT_RULE.latestGrade,
  };
}

// The rating scale the grades are read against.
//
// AN ANNUAL CYCLE'S SCALE, always — never simply "the active cycle's".
// Super 50 reads annual reviews and nothing else, and the two cycle
// types do not have to share a scale: the demo tenant runs a mid-year
// cycle graded "Needs Improvement..Outstanding" while its annual
// grades are A+..C. Taking the active cycle's scale there made the
// rule look for an "A+" that the active scale has never heard of, and
// the prior-ratings import rejected a perfectly good file of A/A+
// grades. Found by importing one.
//
// So: the passed cycle only if it is itself annual, then the most
// recent annual cycle, then the product default.
async function super50Scale(tenantId, cycle) {
  if (cycle && cycle.cycle_type === 'annual'
      && Array.isArray(cycle.rating_scale) && cycle.rating_scale.length) return cycle.rating_scale;
  const row = (await db.query(
    `SELECT rating_scale FROM pms.cycles
      WHERE tenant_id=$1 AND cycle_type='annual' AND rating_scale IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0];
  return (row && Array.isArray(row.rating_scale) && row.rating_scale.length) ? row.rating_scale : DEFAULT_SCALE;
}

// One employee's annual ratings, most recent first.
//
// Published cycles and imported prior years in ONE list, ordered by
// fiscal year. A published cycle always wins over an imported row for
// the same year: the import is what the client had before this product,
// and the moment this product publishes that year it owns it.
//
// Ordering is by fiscal year and NOT by published_at, which the old
// query used. Publishing three cycles out of order — which happens when
// a client back-fills — would otherwise make "the most recent review"
// whichever one HR happened to publish last.
async function super50History(tenantId, employeeIds) {
  const rows = (await db.query(
    `SELECT employee_id, fiscal_year, sort_year, rating, source, at FROM (
        SELECT h.employee_id,
               hc.fiscal_year,
               -- The FIRST run of digits, read the same way the
               -- importer reads it (see prior-ratings-import.js):
               -- four digits as-is, two digits as 20xx. "FY24-25" must
               -- sort as 2024 here and 2024 there, or a published year
               -- and an imported one for the same year stop matching.
               coalesce(
                 CASE WHEN length(substring(hc.fiscal_year from '\\d+')) >= 4
                        THEN left(substring(hc.fiscal_year from '\\d+'), 4)::int
                      WHEN length(substring(hc.fiscal_year from '\\d+')) = 2
                        THEN 2000 + substring(hc.fiscal_year from '\\d+')::int
                 END,
                 extract(year from h.published_at)::int) AS sort_year,
               h.final_rating::numeric AS rating,
               'published' AS source,
               1 AS precedence,
               h.published_at AS at
          FROM pms.employee_performance_history h
          JOIN pms.cycles hc ON hc.id = h.cycle_id
         WHERE h.tenant_id=$1 AND hc.cycle_type='annual' AND h.employee_id = ANY($2::uuid[])
        UNION ALL
        SELECT p.employee_id, p.fiscal_year, p.sort_year, p.rating, 'imported', 2, p.created_at
          FROM pms.prior_ratings p
         WHERE p.tenant_id=$1 AND p.employee_id = ANY($2::uuid[])
     ) q
     ORDER BY employee_id, sort_year DESC, precedence, at DESC`, [tenantId, employeeIds])).rows;

  const byEmp = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, { published: new Set(), list: [] });
    const e = byEmp.get(r.employee_id);
    // DE-DUPLICATE IN ONE DIRECTION ONLY: an IMPORTED row is dropped
    // when this product has published that year itself. Two PUBLISHED
    // rows are never merged, however their fiscal_year labels happen
    // to parse — a tenant whose cycles are called "S50-FY1", "S50-FY2"
    // and "S50-FY3" gets 2050 out of all three, and collapsing them
    // turned three real annual reviews into one and made the rule
    // unsatisfiable. Found by an existing test, not by inspection.
    if (r.source === 'published') {
      e.published.add(r.sort_year);
    } else if (e.published.has(r.sort_year)) {
      continue;
    }
    e.list.push({ fiscal_year: r.fiscal_year, sort_year: r.sort_year,
                  rating: Number(r.rating), source: r.source });
  }
  return byEmp;
}

// Everybody, judged. Returns one row per active employee with the
// verdict and the history behind it, so the page can show the list AND
// the near misses AND why it is empty from a single call.
async function super50Roster(tenantId, { cycle } = {}) {
  const [rule, scale] = await Promise.all([super50Rule(tenantId), super50Scale(tenantId, cycle)]);
  const people = (await db.query(
    `SELECT id, name, email, department, designation, super50_flag, super50_since
       FROM core.employees WHERE tenant_id=$1 AND status='active' ORDER BY name`, [tenantId])).rows;
  const hist = await super50History(tenantId, people.map((p) => p.id));

  const rows = people.map((p) => {
    const h = (hist.get(p.id) || { list: [] }).list;
    const check = super50Check(h.map((x) => x.rating), scale, rule);
    return { ...p, history: h.slice(0, Math.max(rule.window, 3)), ...check };
  });
  // How much history exists at all. This is the number that explains an
  // empty page, and it is why it is returned even when nobody qualifies.
  const withAny = rows.filter((r) => r.history.length > 0).length;
  const withEnough = rows.filter((r) => r.history.length >= rule.window).length;
  return {
    rule, scale, rows,
    coverage: { employees: rows.length, with_any_history: withAny, with_full_window: withEnough },
  };
}

// Grade label for a numeric rating, for display. Nearest exact match
// only — inventing a label for 3.7 would put a grade on screen that
// nobody awarded.
const gradeOf = (scale, value) => {
  const row = (scale || []).find((s) => Math.round(Number(s.value)) === Math.round(Number(value)));
  return row ? row.label : null;
};

module.exports = { super50Rule, super50Scale, super50History, super50Roster, gradeOf };
