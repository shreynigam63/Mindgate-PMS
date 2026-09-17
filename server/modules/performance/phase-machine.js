// Cycle phase machine — PURE logic, no db, so it is unit-tested directly.
// Faithful to the AH production machine (spec §3.1): forward transitions in
// order, rollback one step (HR-controlled, audited by the caller), cancel
// from any non-closed phase. Downstream gates use phaseAllows().

// growth_planning was FOLDED BACK INTO kra_open on 16 Sep, at the client's
// request, and the two are now one phase shown as "KRA Setting and Growth
// Planning". It had been added earlier to give HR a way to lock KRAs while
// leaving the growth plan open — but that lock is now per-employee and
// automatic (growthEditable below: your sheet locks when you submit it,
// and that same act opens your growth plan), so a second cycle-wide phase
// bought nothing and cost HR two extra transitions per cycle, plus a
// rollback whenever anybody was out of step.
//
// The stored value stays 'kra_open'. Renaming it would rewrite every
// cycle row, every audit entry and every notification ever sent, to change
// a word only shown through phaseLabel() anyway. Migration 036 moves any
// cycle sitting in 'growth_planning' back to 'kra_open'; the label for the
// old value is kept in the frontend so historical rows still read.
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
const ORDER = ['draft', 'kra_open', 'mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval', 'calibration', 'publish', 'closed'];

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

// What each phase permits (gates for downstream endpoints).
//
// kra_open now covers KRA setting AND growth planning, but devplan_* and
// career_edit are still deliberately absent from it: phaseAllows() only
// knows the cycle, and inside this phase the growth plan depends on the
// EMPLOYEE having submitted their own KRA sheet. Listing them here would
// make phaseAllows(phase,'devplan_submit') true for somebody who has
// submitted nothing — exactly the case the merged window must refuse.
// growthEditable() below carries that rule, and every devplan/career route
// goes through it rather than through phaseAllows() alone.
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
  mid_year_review: ['midyear_self_edit', 'midyear_self_submit', 'midyear_manager_edit', 'midyear_manager_submit'],
  self_appraisal:  ['self_edit', 'self_submit'],
  manager_eval:    ['manager_edit', 'manager_submit'],
  hod_eval:        ['hod_edit', 'hod_submit'],
  calibration:     ['calibrate', 'adjust', 'top_talent'],
  publish:         ['publish'],
};
// THE KRA SHEET IS OPEN FOR THE WHOLE CYCLE.
//
// Asked for by the client on 17 Sep: "KRA should be open for all in entire
// cycle, but once KRA is submitted by employee it should be locked for him
// unless manager returns the KRA with any feedback."
//
// So the lock moved off the CYCLE and onto the SHEET. It used to be that
// kra_open was the only phase in which anybody could touch a KRA sheet,
// which made HR roll the whole tenant back to kra_open to let one late
// joiner write their KRAs — and that rollback reopened everybody's sheet
// as a side effect, which is the opposite of locking.
//
// Now the phase says only WHETHER THE CYCLE IS RUNNING, and
// pms.kra_sheets.status decides who may edit:
//
//   draft / returned  → the employee edits and submits
//   submitted         → locked to the employee; the manager decides
//   approved          → locked to everyone until HR reopens it
//
// draft and closed stay shut because there is no cycle to write into: a
// draft cycle has not been opened to employees at all, and a closed one is
// history. Every other phase is open, and the sheet's own status is what
// stops an approved KRA being quietly rewritten in, say, calibration.
const KRA_ACTIONS = ['kra_edit', 'kra_submit', 'kra_decide'];
const KRA_SHUT = ['draft', 'closed'];

function phaseAllows(phase, action) {
  if (KRA_ACTIONS.includes(action)) {
    return ORDER.includes(phase) && !KRA_SHUT.includes(phase);
  }
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

  // An agreed plan is locked, and that outranks the window it sits in.
  // This check used to sit below the kra_open branch, which made an
  // APPROVED plan editable inside the merged phase — the routes caught it
  // with a second check of their own, but the career routes have no such
  // backstop, and a shared rule that is only right because of what the
  // caller does afterwards is not a shared rule.
  if (planStatus === 'approved' || planStatus === 'submitted') {
    return { ok: false, reason: planStatus,
      error: planStatus === 'approved'
        ? `Your plan is approved — ask your manager to return it for edits (phase: ${phase || 'none'})`
        : 'Your plan is with your manager — it reopens if they return it' };
  }

  if (phase === 'kra_open') {
    if (SHEET_SENT.includes(sheetStatus)) return { ok: true, via: 'kra_submitted' };
    return {
      ok: false,
      reason: 'kra_not_submitted',
      error: 'Submit your KRAs to your manager first — Target achievements for the year and Aspiring Career open as soon as you do.',
    };
  }

  if (phaseAllows(phase, 'devplan_edit')) return { ok: true, via: 'phase' };

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
