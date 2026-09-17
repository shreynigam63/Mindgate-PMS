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
  // status locks it instead (17 Sep). The growth-plan rule is untouched by
  // that: a submitted sheet is still a way to start EARLY, not a permanent
  // key, so the growth window still shuts when the phase passes.
  assert.equal(pm.phaseAllows('mid_year_review', 'kra_edit'), true);
  assert.equal(pm.growthEditable('mid_year_review', { sheetStatus: 'submitted' }).ok, false,
    'a submitted sheet is a way to start early, not a permanent key');
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

  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_self_edit'), false, 'closes again once the cycle moves past it');
  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_manager_edit'), false);
});

// Confirms the actual reason a separate table was used: signing off the
// mid-year checkpoint must not affect the SAME cycle's later, real
// self-appraisal/manager-evaluation gating at all — the two are
// independent action namespaces entirely.
test('Mid-Year Review actions are independent of self_appraisal/manager_eval actions', () => {
  assert.equal(pm.phaseAllows('mid_year_review', 'self_edit'), false, 'mid_year_review does not grant the annual self-appraisal action');
  assert.equal(pm.phaseAllows('mid_year_review', 'manager_edit'), false);
  assert.equal(pm.phaseAllows('self_appraisal', 'midyear_self_edit'), false, 'and self_appraisal does not grant the midyear action either');
});
