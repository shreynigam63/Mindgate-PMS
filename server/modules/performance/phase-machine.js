// Cycle phase machine — PURE logic, no db, so it is unit-tested directly.
// Faithful to the AH production machine (spec §3.1): forward transitions in
// order, rollback one step (HR-controlled, audited by the caller), cancel
// from any non-closed phase. Downstream gates use phaseAllows().

// growth_planning added per explicit request: "after KRAs are approved by
// managers, HR will move the cycle to lock KRA and it will open
// development plan and career path." Previously devplan_* shared the
// kra_open window (see the old comment below, now out of date) — there
// was no way to lock KRAs while still letting Development Plan/Career
// Path stay open. This phase is that missing middle step: KRA is locked
// the moment the cycle advances past kra_open, and Development Plan +
// Career Path only become editable once it reaches growth_planning.
// mid_year_review added per an explicit request, with a reference
// screenshot: a checkpoint phase between Growth Planning and
// Self-Appraisal, gating "should not open before growth plan is
// completed" and "editable only once the cycle moves into this phase."
// Its own action names (midyear_self_edit etc.), NOT shared with
// self_appraisal/manager_eval — those two tables (pms.self_appraisals /
// pms.manager_evaluations) permanently lock the moment either party signs
// off, with no phase awareness in that check. Reusing them here would
// mean signing off the mid-year checkpoint permanently locks the SAME
// cycle's real end-of-year self-appraisal too, months before it's even
// supposed to open — pms.midyear_checkins (migration 020) is a separate
// table specifically to avoid that collision.
// This is a distinct concept from the pre-existing, separate
// `cycle_type='midyear'` mechanism (a whole separate CYCLE going through
// this same phase machine end to end) — this is a PHASE inside any
// cycle's own timeline (annual or midyear), named similarly because the
// request used that name.
const ORDER = ['draft', 'kra_open', 'growth_planning', 'mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval', 'calibration', 'publish', 'closed'];

function canAdvance(from, to) {
  const i = ORDER.indexOf(from), j = ORDER.indexOf(to);
  if (i === -1 || j === -1) return { ok: false, reason: `unknown phase` };
  if (from === 'closed') return { ok: false, reason: 'cycle is closed' };
  if (j !== i + 1) return { ok: false, reason: `can only advance ${from} → ${ORDER[i + 1]}` };
  return { ok: true };
}

function canRollback(from, to) {
  const i = ORDER.indexOf(from), j = ORDER.indexOf(to);
  if (i === -1 || j === -1) return { ok: false, reason: 'unknown phase' };
  if (from === 'closed') return { ok: false, reason: 'closed cycles cannot roll back' };
  if (j !== i - 1) return { ok: false, reason: `can only roll back ${from} → ${ORDER[i - 1] || '(nothing)'}` };
  return { ok: true };
}

function canCancel(from) {
  return from === 'closed' ? { ok: false, reason: 'closed cycles cannot be cancelled' } : { ok: true };
}

// What each phase permits (gates for downstream endpoints). KRA locks the
// moment the cycle leaves kra_open — kra_edit/kra_submit/kra_decide are
// NOT carried into growth_planning, by design (that's the "lock" HR asked
// for). Development Plan and Career Path share the growth_planning window
// (career_edit is a new action, consumed by modules/people's career path
// route — the only one of these three that isn't in modules/performance).
const ALLOWS = {
  kra_open:        ['kra_edit', 'kra_submit', 'kra_decide'],
  growth_planning: ['devplan_edit', 'devplan_submit', 'devplan_decide', 'career_edit'],
  mid_year_review: ['midyear_self_edit', 'midyear_self_submit', 'midyear_manager_edit', 'midyear_manager_submit'],
  self_appraisal:  ['self_edit', 'self_submit'],
  manager_eval:    ['manager_edit', 'manager_submit'],
  hod_eval:        ['hod_edit', 'hod_submit'],
  calibration:     ['calibrate', 'adjust', 'top_talent'],
  publish:         ['publish'],
};
function phaseAllows(phase, action) {
  return (ALLOWS[phase] || []).includes(action);
}

// KRA weight rule: total must be exactly 100 to submit (tolerance for
// numeric drift: 0.01).
function weightsValid(kras) {
  const total = kras.reduce((s, k) => s + Number(k.weight || 0), 0);
  return { ok: Math.abs(total - 100) < 0.01, total: +total.toFixed(2) };
}

module.exports = { ORDER, canAdvance, canRollback, canCancel, phaseAllows, weightsValid };
