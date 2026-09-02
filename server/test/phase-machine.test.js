const { test } = require('node:test');
const assert = require('node:assert');
const pm = require('../modules/performance/phase-machine');

test('forward transitions in order only', () => {
  assert.equal(pm.canAdvance('draft', 'kra_open').ok, true);
  assert.equal(pm.canAdvance('kra_open', 'growth_planning').ok, true);
  assert.equal(pm.canAdvance('kra_open', 'self_appraisal').ok, false, 'cannot skip growth_planning');
  assert.equal(pm.canAdvance('growth_planning', 'mid_year_review').ok, true);
  assert.equal(pm.canAdvance('growth_planning', 'self_appraisal').ok, false, 'cannot skip mid_year_review');
  assert.equal(pm.canAdvance('mid_year_review', 'self_appraisal').ok, true);
  assert.equal(pm.canAdvance('draft', 'calibration').ok, false);
  assert.equal(pm.canAdvance('publish', 'closed').ok, true);
  assert.equal(pm.canAdvance('closed', 'draft').ok, false);
});

test('rollback exactly one step, never from closed', () => {
  assert.equal(pm.canRollback('calibration', 'hod_eval').ok, true);
  assert.equal(pm.canRollback('calibration', 'manager_eval').ok, false);
  assert.equal(pm.canRollback('self_appraisal', 'mid_year_review').ok, true);
  assert.equal(pm.canRollback('self_appraisal', 'growth_planning').ok, false, 'mid_year_review sits between them now');
  assert.equal(pm.canRollback('mid_year_review', 'growth_planning').ok, true);
  assert.equal(pm.canRollback('closed', 'publish').ok, false);
});

test('cancel from any phase except closed', () => {
  assert.equal(pm.canCancel('draft').ok, true);
  assert.equal(pm.canCancel('calibration').ok, true);
  assert.equal(pm.canCancel('closed').ok, false);
});

test('phase gates', () => {
  assert.equal(pm.phaseAllows('kra_open', 'kra_edit'), true);
  assert.equal(pm.phaseAllows('self_appraisal', 'kra_edit'), false);
  assert.equal(pm.phaseAllows('calibration', 'adjust'), true);
  assert.equal(pm.phaseAllows('publish', 'publish'), true);
});

// "After KRAs are approved by managers, HR will move the cycle to lock
// KRA and it will open development plan and career path" — the exact
// request this feature implements. KRA and Development Plan/Career Path
// must never both be open (or both closed) at once.
test('KRA locks the moment growth_planning opens; devplan/career open only then', () => {
  assert.equal(pm.phaseAllows('kra_open', 'kra_edit'), true);
  assert.equal(pm.phaseAllows('kra_open', 'devplan_edit'), false, 'devplan must not be editable before KRA is locked');
  assert.equal(pm.phaseAllows('kra_open', 'career_edit'), false);

  assert.equal(pm.phaseAllows('growth_planning', 'kra_edit'), false, 'KRA must be locked once growth_planning opens');
  assert.equal(pm.phaseAllows('growth_planning', 'kra_submit'), false);
  assert.equal(pm.phaseAllows('growth_planning', 'devplan_edit'), true);
  assert.equal(pm.phaseAllows('growth_planning', 'devplan_submit'), true);
  assert.equal(pm.phaseAllows('growth_planning', 'career_edit'), true);

  assert.equal(pm.phaseAllows('self_appraisal', 'devplan_edit'), false, 'devplan/career close once the cycle moves past growth_planning');
  assert.equal(pm.phaseAllows('self_appraisal', 'career_edit'), false);
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
test('Mid-Year Review only opens once the cycle leaves growth_planning, and closes again once it moves on', () => {
  assert.equal(pm.phaseAllows('growth_planning', 'midyear_self_edit'), false, 'must not open before growth plan is complete');
  assert.equal(pm.phaseAllows('growth_planning', 'midyear_manager_edit'), false);

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
