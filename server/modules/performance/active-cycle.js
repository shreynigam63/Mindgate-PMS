// Which cycle is "the" cycle — the one resolver, for every module.
//
// THE BUG THIS FIXES. "The active cycle" was, in six places, the most
// recently CREATED cycle whose phase is not closed or cancelled. A cycle
// starts life in 'draft', and 'draft' is one of the two phases that shut
// KRAs (phase-machine.js, KRA_SHUT). So the day HR created next year's
// cycle, that brand-new draft became "the" active cycle for the whole
// company — and every employee still working in the live cycle was told
// "KRA submission is not open", with no error that could explain why, and
// nothing HR could do except delete the draft they had just made.
//
// It reached further than My KRAs. The same resolver picks the cycle that
// the AI drafts scope against, that Aspiring Career reads its phase from,
// and that the reminder engine schedules against — so one draft cycle
// would also have pointed the nightly reminder sweep at a cycle nobody was
// working in.
//
// THE FIX. Prefer a cycle that has actually STARTED over one that is still
// a draft; only fall back to a draft when there is nothing else, so a fresh
// instance whose first cycle is unstarted still resolves to it rather than
// reporting "no cycle". Among started cycles the tie-break is unchanged —
// most recently created — so nothing about today's behaviour moves until a
// draft exists alongside a live cycle, which is exactly the broken case.
//
// This generalises a workaround that already existed twice. activeCycleForMidyear
// was written to stop "blind most-recently-created" resolving Mid-Year
// against the wrong cycle; the same instinct, applied to one screen. Two
// copies of it had already been written, in performance and in agentic.
// Both now live here, once.
//
// WHY A LEAF FILE. It needs core/db and nothing else, so every module can
// require it without importing another module's internals and without a
// cycle back through performance/index.js (which requires this). people/
// already reaches into performance/phase-machine on the same basis.
const db = require('../../core/db');

// A closed cycle is history and a cancelled one never happened.
const LIVE = "phase NOT IN ('closed','cancelled')";

// Started cycles first, then most recently created — the ordering that IS
// the fix. IS DISTINCT FROM rather than <> so a null phase could never
// sort as "started" by accident.
const STARTED_FIRST = "(phase IS DISTINCT FROM 'draft') DESC, created_at DESC";

// The phases a mid-year review can legitimately be read from: at it, or
// past it. Kept beside the resolver that uses it.
const MIDYEAR_OR_LATER = [
  'mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval', 'calibration', 'publish',
];

// The cycle everyone is working in. `type` narrows to a cycle_type when a
// caller needs one (the annual/half-yearly split).
async function activeCycle(tenantId, type = null) {
  const r = await db.query(
    `SELECT * FROM pms.cycles WHERE tenant_id=$1 AND ${LIVE}
      ${type ? 'AND cycle_type=$2' : ''} ORDER BY ${STARTED_FIRST} LIMIT 1`,
    type ? [tenantId, type] : [tenantId]);
  return r.rows[0] || null;
}

// Mid-Year needs more than "started": with several live cycles under one
// tenant, the most recently created one can be at kra_open while the cycle
// HR actually advanced to mid_year_review is older. Reading the newer one
// tells the employee "not editable" while their screen plainly shows the
// phase is open. So prefer a cycle at or past mid_year_review, and only
// fall back to the general rule when none has reached it — which is what
// correctly reports "not open yet".
async function activeCycleForMidyear(tenantId) {
  const passed = (await db.query(
    `SELECT * FROM pms.cycles WHERE tenant_id=$1 AND ${LIVE} AND phase = ANY($2::text[])
      ORDER BY (phase='mid_year_review') DESC, created_at DESC LIMIT 1`,
    [tenantId, MIDYEAR_OR_LATER])).rows[0];
  return passed || activeCycle(tenantId);
}

module.exports = { activeCycle, activeCycleForMidyear, LIVE, STARTED_FIRST, MIDYEAR_OR_LATER };
