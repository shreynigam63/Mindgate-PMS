const { test } = require('node:test');
const assert = require('node:assert');
const pm = require('../modules/performance/phase-machine');

test('forward transitions in order only', () => {
  assert.equal(pm.canAdvance('draft', 'kra_open').ok, true);
  // growth_planning was folded into kra_open (036) — it is no longer a
  // phase at all, so it is not a step anybody can advance into.
  assert.equal(pm.canAdvance('kra_open', 'growth_planning').ok, false, 'growth_planning no longer exists');
  assert.equal(pm.canAdvance('kra_open', 'mid_year_review').ok, true);
  assert.equal(pm.canAdvance('kra_open', 'self_appraisal').ok, false, 'cannot skip mid_year_review');
  assert.equal(pm.canAdvance('mid_year_review', 'self_appraisal').ok, true);
  assert.equal(pm.canAdvance('draft', 'calibration').ok, false);
  assert.equal(pm.canAdvance('publish', 'closed').ok, true);
  assert.equal(pm.canAdvance('closed', 'draft').ok, false);
});

test('rollback exactly one step, never from closed', () => {
  assert.equal(pm.canRollback('calibration', 'hod_eval').ok, true);
  assert.equal(pm.canRollback('calibration', 'manager_eval').ok, false);
  assert.equal(pm.canRollback('self_appraisal', 'mid_year_review').ok, true);
  assert.equal(pm.canRollback('self_appraisal', 'kra_open').ok, false, 'mid_year_review sits between them now');
  assert.equal(pm.canRollback('mid_year_review', 'kra_open').ok, true);
  assert.equal(pm.canRollback('closed', 'publish').ok, false);
});

test('cancel from any phase except closed', () => {
  assert.equal(pm.canCancel('draft').ok, true);
  assert.equal(pm.canCancel('calibration').ok, true);
  assert.equal(pm.canCancel('closed').ok, false);
});

test('phase gates', () => {
  assert.equal(pm.phaseAllows('kra_open', 'kra_edit'), true);
  // Was false. The KRA sheet is now open for the whole running cycle and
  // the SHEET'S STATUS is the lock — see the test below.
  assert.equal(pm.phaseAllows('self_appraisal', 'kra_edit'), true);
  assert.equal(pm.phaseAllows('calibration', 'adjust'), true);
  assert.equal(pm.phaseAllows('publish', 'publish'), true);
});

// "KRA should be open for all in entire cycle, but once KRA is submitted
// by employee it should be locked for him unless manager returns the KRA
// with any feedback." — 17 Sep.
//
// The lock moved off the cycle and onto the sheet, so these two halves are
// tested separately: the phase says only whether the cycle is running, and
// pms.kra_sheets.status decides who may write.
test('THE KRA SHEET IS OPEN IN EVERY RUNNING PHASE', () => {
  for (const phase of ['kra_open', 'mid_year_review', 'self_appraisal',
                       'manager_eval', 'hod_eval', 'calibration', 'publish']) {
    for (const action of ['kra_edit', 'kra_submit', 'kra_decide']) {
      assert.equal(pm.phaseAllows(phase, action), true, `${action} should be open in ${phase}`);
    }
  }
});

test('…but not before the cycle opens, or after it closes', () => {
  // A draft cycle has not been shown to employees at all, and a closed one
  // is history. Neither is "the entire cycle".
  for (const phase of ['draft', 'closed']) {
    for (const action of ['kra_edit', 'kra_submit', 'kra_decide']) {
      assert.equal(pm.phaseAllows(phase, action), false, `${action} must stay shut in ${phase}`);
    }
  }
  // An unknown phase is not a licence either — a typo must not open a gate.
  assert.equal(pm.phaseAllows('not_a_phase', 'kra_edit'), false);
  assert.equal(pm.phaseAllows(undefined, 'kra_edit'), false);
});

test('opening KRA editing everywhere does not open anything else', () => {
  // The blast radius of the change: only the three kra_* actions moved.
  // Every other gate still answers from the per-phase table.
  assert.equal(pm.phaseAllows('kra_open', 'self_edit'), false);
  assert.equal(pm.phaseAllows('kra_open', 'manager_submit'), false);
  assert.equal(pm.phaseAllows('kra_open', 'adjust'), false);
  assert.equal(pm.phaseAllows('calibration', 'self_submit'), false);
  assert.equal(pm.phaseAllows('publish', 'midyear_self_edit'), false);
  assert.equal(pm.phaseAllows('self_appraisal', 'publish'), false);
});

// "After KRAs are approved by managers, HR will move the cycle to lock
// KRA and it will open development plan and career path" — the exact
// request this feature implements. KRA and Development Plan/Career Path
// must never both be open (or both closed) at once.
test('KRA SETTING AND GROWTH PLANNING ARE ONE PHASE (036)', () => {
  // The merge: kra_open covers both halves. KRA editing is open for
  // everybody in it, and the growth half opens per employee when they
  // submit their own sheet — which phaseAllows() cannot express, so
  // devplan_*/career_edit are deliberately absent from the table and
  // growthEditable() carries that rule instead.
  assert.equal(pm.phaseAllows('kra_open', 'kra_edit'), true);
  assert.equal(pm.phaseAllows('kra_open', 'kra_submit'), true);
  assert.equal(pm.phaseAllows('kra_open', 'kra_decide'), true);
  assert.equal(pm.phaseAllows('kra_open', 'devplan_edit'), false, 'the growth half is per-employee, not per-cycle');
  assert.equal(pm.phaseAllows('kra_open', 'devplan_submit'), false);
  assert.equal(pm.phaseAllows('kra_open', 'career_edit'), false);

  // …and growthEditable is where the real answer lives.
  assert.equal(pm.growthEditable('kra_open', { sheetStatus: 'draft' }).ok, false);
  assert.equal(pm.growthEditable('kra_open', { sheetStatus: 'submitted' }).ok, true);

  // KRA editing no longer closes when the cycle moves on — the sheet's own
  // status locks it instead (17 Sep). On 28 Sep the growth plan joined it:
  // "keep phases open till annual review it will locked only once
  // submitted by employee or approved by manager."
  assert.equal(pm.phaseAllows('mid_year_review', 'kra_edit'), true);
  assert.equal(pm.growthEditable('mid_year_review', { sheetStatus: 'submitted' }).ok, true,
    'the window stays open when the cycle moves on — only the plan locks it');
  assert.equal(pm.growthEditable('manager_eval', { sheetStatus: 'submitted' }).ok, false,
    'and Annual Review is where it ends');
});

// The 28 Sep request, as one test: "cycle still locks after advancing to
// next phase, please keep phases open till annual review it will locked
// only once submitted by employee or approved by manager."
//
// Written as a walk through the cycle rather than as a table, because the
// complaint was about ADVANCING — the bug only shows when you move.
test('ADVANCING THE CYCLE NEVER SHUTS AN EMPLOYEE OUT BEFORE ANNUAL REVIEW', () => {
  const employeeWindows = ['kra_open', 'mid_year_review', 'self_appraisal'];
  const after = ['manager_eval', 'hod_eval', 'calibration', 'publish'];

  // The KRA sheet: open the whole way (17 Sep), and past Annual Review too.
  for (const phase of [...employeeWindows, ...after]) {
    assert.equal(pm.phaseAllows(phase, 'kra_edit'), true, `KRA sheet open in ${phase}`);
  }

  // Mid-year: opens when the cycle reaches it, and does NOT shut when the
  // cycle moves to Annual Review.
  assert.equal(pm.phaseAllows('kra_open', 'midyear_self_edit'), false, 'not before its phase');
  assert.equal(pm.phaseAllows('mid_year_review', 'midyear_self_edit'), true);
  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_self_edit'), true, 'and not shut by advancing');
  for (const phase of after) {
    assert.equal(pm.phaseAllows(phase, 'midyear_self_edit'), false, `closed by ${phase}`);
  }

  // The growth plan: opens on the employee's own KRA submission, then
  // stays open. This is the one that was shut in EVERY phase but
  // kra_open, because its branch tested an action no phase grants.
  const g = (phase, sheetStatus, planStatus) => pm.growthEditable(phase, { sheetStatus, planStatus });
  assert.equal(g('kra_open', 'draft', 'draft').ok, false, 'submit your own KRAs first');
  assert.equal(g('kra_open', 'submitted', 'draft').ok, true);
  assert.equal(g('mid_year_review', 'submitted', 'draft').ok, true, 'and advancing does not take it away');
  assert.equal(g('self_appraisal', 'submitted', 'draft').ok, true);
  assert.equal(g('manager_eval', 'submitted', 'draft').ok, false, 'Annual Review is the end of it');

  // "locked only once submitted by employee or approved by manager" —
  // the record's own status, in the middle of the open window.
  assert.equal(g('self_appraisal', 'submitted', 'submitted').ok, false, 'submitted by the employee');
  assert.equal(g('self_appraisal', 'submitted', 'approved').ok, false, 'approved by the manager');
  assert.equal(g('self_appraisal', 'submitted', 'returned').ok, true, 'and a return reopens it');
});

test('weights: exactly 100 with tolerance', () => {
  assert.equal(pm.weightsValid([{ weight: 40 }, { weight: 60 }]).ok, true);
  assert.equal(pm.weightsValid([{ weight: 33.33 }, { weight: 33.33 }, { weight: 33.34 }]).ok, true);
  assert.equal(pm.weightsValid([{ weight: 50 }, { weight: 40 }]).ok, false);
  assert.equal(pm.weightsValid([]).ok, false);
});

// The exact requests this phase implements: "Mid-year review should not
// open before completion of growth plan" / "editable only after cycle is
// moved from growth plan to mid year review phase."
test('Mid-Year Review only opens once the cycle leaves KRA Setting and Growth Planning, and closes again once it moves on', () => {
  assert.equal(pm.phaseAllows('kra_open', 'midyear_self_edit'), false, 'must not open before the growth plan is complete');
  assert.equal(pm.phaseAllows('kra_open', 'midyear_manager_edit'), false);

  assert.equal(pm.phaseAllows('mid_year_review', 'midyear_self_edit'), true);
  assert.equal(pm.phaseAllows('mid_year_review', 'midyear_self_submit'), true);
  assert.equal(pm.phaseAllows('mid_year_review', 'midyear_manager_edit'), true);
  assert.equal(pm.phaseAllows('mid_year_review', 'midyear_manager_submit'), true);

  // REVERSED on 28 Sep. September's rule was "editable only after the
  // cycle is moved into this phase", which also meant it stopped being
  // editable the moment HR moved on — and HR could not advance the cycle
  // without shutting a door on everybody still mid-way. It now runs to
  // the end of Annual Review, and the checkin's own sign-off locks it.
  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_self_edit'), true,
    'still open through Annual Review');
  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_manager_edit'), true);
  // It does end there. After Annual Review the cycle is the manager's.
  for (const phase of ['manager_eval', 'hod_eval', 'calibration', 'publish', 'closed']) {
    assert.equal(pm.phaseAllows(phase, 'midyear_self_edit'), false, `shut in ${phase}`);
  }
});

// Confirms the actual reason a separate table was used: signing off the
// mid-year checkpoint must not affect the SAME cycle's later, real
// self-appraisal/manager-evaluation gating at all — the two are
// independent action namespaces entirely.
test('Mid-Year Review actions are independent of self_appraisal/manager_eval actions', () => {
  // The half that still matters: reaching Mid-Year must not hand anybody
  // the ANNUAL self-appraisal early. That is the collision the separate
  // pms.midyear_checkins table exists to avoid, and it is unaffected by
  // the 28 Sep change.
  assert.equal(pm.phaseAllows('mid_year_review', 'self_edit'), false, 'mid_year_review does not grant the annual self-appraisal action');
  assert.equal(pm.phaseAllows('mid_year_review', 'manager_edit'), false);
  // The other half no longer holds, and deliberately: from 28 Sep the
  // mid-year window runs INTO Annual Review, so somebody who was still
  // finishing it does not lose it when HR advances. Being able to edit
  // the mid-year checkin there is not the same as the annual appraisal
  // being open early — they remain separate tables and separate actions,
  // which the two assertions above are what prove.
  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_self_edit'), true);
});
