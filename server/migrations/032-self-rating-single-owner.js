// 032 — give pms.self_appraisals.overall_self_rating a single owner again,
// and repair the rows the previous arrangement left behind.
//
// WHAT CHANGED. For a while, on an ANNUAL cycle, overall_self_rating was
// written by the employee's own 7-parameter self-scoring
// (PUT /pms/my/parameter-scores) instead of by the per-KRA weighted
// average, so that two computations would not fight over one column. The
// side effect was that the Self-Appraisal page presented that figure under
// the heading "Overall Annual Rating (weighted average of the 7 parameters
// below)" — which reads as though an employee sets their own official
// rating. They never did: BR-6.2/6.3 gives the official annual rating
// exclusively to the MANAGER's scoring of the same 7 parameters. The
// employee's self-scores are a self-assessment layer.
//
// So the column now has one writer on every cycle type — the per-KRA
// weighted average. (Employee self-scoring against the 7 parameters was
// removed outright immediately afterwards, at the client's instruction,
// along with GET/PUT /pms/my/parameter-scores and the annual submit gate
// that depended on them. Existing scored_by_role='self' rows are left in
// place; nothing reads them. The MANAGER's scoring of the same 7
// parameters is untouched and is still the official annual rating.)
//
// WHY DATA HAS TO MOVE. Any annual self-appraisal already carrying a
// parameter-derived number would keep it while now being labelled a
// KRA-derived one — a stale value under a heading that describes a
// different computation. This recomputes those rows from their per-KRA
// entries, exactly as PUT /pms/my/self-appraisal would (weight/100 * grade
// summed, rounded to 1dp, unrated KRAs contributing zero — see
// computeWeightedRating in modules/performance/rating-rules.js), and
// clears the value where there is nothing to compute it from. The employee
// sees the right number as soon as they grade a KRA either way.
//
// SUBMITTED APPRAISALS ARE LEFT ALONE, DELIBERATELY. A submitted row is a
// record the employee signed off on; silently rewriting the figure in it
// would be worse than the mislabelling. Only in-flight rows are touched.
//
// Idempotent: re-running recomputes the same values from the same entries.
module.exports.up = async (db) => {
  // Rows in scope: annual cycles, not yet submitted, currently carrying a
  // rating. Scoped by cycle_type so mid-year rows — which the per-KRA
  // average has always owned — are never rewritten.
  const rows = (await db.query(`
    SELECT sa.id, sa.entries, s.id AS sheet_id
      FROM pms.self_appraisals sa
      JOIN pms.cycles c ON c.id = sa.cycle_id AND c.cycle_type = 'annual'
      LEFT JOIN pms.kra_sheets s ON s.cycle_id = sa.cycle_id AND s.employee_id = sa.employee_id
     WHERE sa.status <> 'submitted' AND sa.overall_self_rating IS NOT NULL`)).rows;

  for (const r of rows) {
    const kras = r.sheet_id
      ? (await db.query(`SELECT id, weight FROM pms.kras WHERE sheet_id=$1`, [r.sheet_id])).rows
      : [];
    const entries = r.entries || {};
    let weightedSum = 0; let rated = 0;
    for (const k of kras) {
      const raw = entries[k.id] ? entries[k.id].self_rating : null;
      if (raw == null || Number.isNaN(Number(raw))) continue;
      weightedSum += Number(raw) * (Number(k.weight) / 100);
      rated += 1;
    }
    // No KRAs, or none graded, means there is genuinely no self-rating to
    // show. NULL says that; a zero would render as "Needs Improvement",
    // which is a rating nobody gave.
    const rating = rated > 0 ? Math.round(weightedSum * 10) / 10 : null;
    await db.query(`UPDATE pms.self_appraisals SET overall_self_rating=$2 WHERE id=$1`, [r.id, rating]);
  }
};
