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
  // devplan_* and career_edit are deliberately NOT listed here, even though
  // the two windows were merged on 16 Sep. In kra_open they depend on the
  // EMPLOYEE's own KRA sheet being submitted, which phaseAllows() cannot
  // express — it only knows the cycle. Listing them would make
  // phaseAllows(phase,'devplan_submit') true for somebody who has not
  // submitted anything, which is precisely the case the merge must refuse.
  // growthEditable() below carries the real rule; every devplan/career route
  // goes through it rather than through phaseAllows() alone.
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


// GROWTH PLANNING OPENS PER EMPLOYEE, ON THEIR OWN KRA SUBMISSION.
//
// Asked for by the client on 16 Sep, to stop the cycle rollback being the
// routine tool: "KRA editing and growth plan can be merged in cycles to
// avoid roll back phase, so once the KRA is submitted to manager, employee
// can use growth plan tab including target achievement for the year and
// aspiring career."
//
// So the two windows overlap at the CYCLE level and are sequenced at the
// PERSON level. An employee who has sent their KRAs to their manager moves
// straight on to Target achievements for the year and Aspiring Career,
// without waiting for the manager's approval and without waiting for HR to
// advance the whole tenant. HR advancing to growth_planning still opens it
// for everyone, including anyone whose sheet never arrived.
//
// This replaces the old rule, which the previous test pinned as "devplan
// must not be editable before KRA is locked". The intent behind that rule —
// don't write a growth plan against KRAs you are still inventing — is
// preserved by the submission condition: the sheet is out of the employee's
// hands at that point, weights totalling 100 and all.
//
// Pure, and phase-machine has no db by design, so the caller fetches the
// two statuses and passes them in.
//
//   sheetStatus  pms.kra_sheets.status   draft | submitted | approved | returned
//   planStatus   pms.development_plans.status   same four
const GROWTH_EDIT_LAST_PHASE = 'calibration';
const SHEET_SENT = ['submitted', 'approved'];

function growthEditable(phase, { sheetStatus = null, planStatus = null } = {}) {
  const i = ORDER.indexOf(phase);
  const beforeCutoff = i !== -1 && i < ORDER.indexOf(GROWTH_EDIT_LAST_PHASE);

  // A plan the manager RETURNED is editable whatever phase it is in, up to
  // Calibration. The return is the authorisation — asking the phase to
  // authorise it a second time is what made a whole-tenant rollback the
  // only remedy for one person's goal.
  if (planStatus === 'returned' && beforeCutoff) return { ok: true, via: 'returned' };

  if (phase === 'kra_open') {
    if (SHEET_SENT.includes(sheetStatus)) return { ok: true, via: 'kra_submitted' };
    return {
      ok: false,
      reason: 'kra_not_submitted',
      error: 'Submit your KRAs to your manager first — Target achievements for the year and Aspiring Career open as soon as you do.',
    };
  }

  if (phaseAllows(phase, 'devplan_edit')) return { ok: true, via: 'phase' };

  if (planStatus === 'approved') {
    return { ok: false, reason: 'approved',
      error: `Your plan is approved — ask your manager to return it for edits (phase: ${phase || 'none'})` };
  }
  return { ok: false, reason: 'phase',
    error: `Growth planning is not open (phase: ${phase || 'none'})` };
}

// KRA weight rule: total must be exactly 100 to submit (tolerance for
// numeric drift: 0.01).
function weightsValid(kras) {
  const total = kras.reduce((s, k) => s + Number(k.weight || 0), 0);
  return { ok: Math.abs(total - 100) < 0.01, total: +total.toFixed(2) };
}

module.exports = { ORDER, canAdvance, canRollback, canCancel, phaseAllows, weightsValid, growthEditable };
