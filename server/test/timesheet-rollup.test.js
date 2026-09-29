// node --test — closed months rolled up to a cycle.
//
// Phase 4 of the Zoho timesheet rating engine. Pure: no database.
//
// The rule that matters most here is the WEIGHTING. A flat average
// across months treats a month with 8 hours logged the same as one with
// 160, and on real data that is not a corner case — a notice period, a
// month mostly on leave, or an export that only covered one sprint all
// land as small-hour months, and each would pull the year around as
// hard as a full one.
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../modules/performance/timesheet-rollup');

const m = (o) => ({
  period_start: '2026-04-21', period_end: '2026-05-20',
  hours_logged: 0, hours_considered: 0, hours_attributed: 0, hours_excluded: 0,
  mapped_pct: null, weighted_coverage_pct: null, alignment_pct: null,
  value_add_pct: null, compliance_pct: null, score: null, grade: null,
  override_score: null, override_grade: null, override_reason: null, ...o,
});

test('PERCENTAGES ARE WEIGHTED BY THE HOURS THEY DESCRIBE', () => {
  // A full month at 90% and a near-empty one at 10%. A flat mean says
  // 50, which describes neither month and would be the number that
  // reached a calibration conversation.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 160, hours_considered: 160, hours_attributed: 160, weighted_coverage_pct: 90 }),
    m({ period_start: '2026-05-21', hours_logged: 8, hours_considered: 8, hours_attributed: 8, weighted_coverage_pct: 10 }),
  ]);
  assert.equal(out.weighted_coverage_pct, 86.2);
  assert.notEqual(out.weighted_coverage_pct, 50, 'a flat mean would have said 50');
});

test('compliance is a flat mean, because it is a property of the month', () => {
  // Somebody who filled every working day in a quiet month WAS fully
  // compliant. Weighting that down by their hours would punish a light
  // month twice.
  const out = r.rollup([
    m({ hours_logged: 160, hours_considered: 160, compliance_pct: 100, period_start: '2026-04-21' }),
    m({ hours_logged: 8, hours_considered: 8, compliance_pct: 50, period_start: '2026-05-21' }),
  ]);
  assert.equal(out.compliance_pct, 75, 'the flat mean of 100 and 50');
});

test('mapped % over the cycle is computed from the hours, not averaged', () => {
  // 90 of 100 in one month and 10 of 100 in another is 100 of 200, not
  // the mean of 90% and 10% — which happens to agree here, so the test
  // uses unequal months where it does not.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 90 }),
    m({ period_start: '2026-05-21', hours_logged: 10, hours_considered: 10, hours_attributed: 1 }),
  ]);
  assert.equal(out.mapped_pct, 82.7, '91 of 110');
  assert.notEqual(out.mapped_pct, 50);
});

test('a month with nothing to place contributes nothing, not a zero', () => {
  // "We could not tell" and "it was zero" are different answers, and
  // only one of them is a judgement about a person.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100, weighted_coverage_pct: 80, alignment_pct: 70 }),
    m({ period_start: '2026-05-21', hours_logged: 0, hours_considered: 0, hours_attributed: 0 }),
  ]);
  assert.equal(out.weighted_coverage_pct, 80, 'the empty month did not drag it to 40');
  assert.equal(out.alignment_pct, 70);
});

test('A NULL PERCENTAGE IN A MONTH THAT HAS HOURS IS SKIPPED, NOT ZEROED', () => {
  // WRITTEN AFTER A POISON DID NOT BITE. The first version of this
  // guarantee was only tested with a month of ZERO hours, so a poison
  // that counted nulls as zero changed nothing — the weight was zero
  // either way. The case that matters is a month WITH hours whose
  // percentage is null, which is what a month where every KRA is
  // marked unmeasurable actually looks like.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100, weighted_coverage_pct: 80 }),
    m({ period_start: '2026-05-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100, weighted_coverage_pct: null }),
  ]);
  assert.equal(out.weighted_coverage_pct, 80,
    'the month we could not measure did not drag it to 40');
});

test('no closed month at all says so rather than returning zeroes', () => {
  const out = r.rollup([], { periods_in_cycle: 12 });
  assert.equal(out.months, 0);
  assert.equal(out.mapped_pct, null);
  assert.equal(out.weighted_coverage_pct, null);
  assert.equal(out.score, null);
  assert.equal(out.label, 'No month closed yet');
});

test('THE ROLLUP SAYS HOW MUCH OF THE YEAR IT SPEAKS FOR', () => {
  // Two months of twelve is the number a calibration conversation needs
  // before it can weigh anything else in the row.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100 }),
    m({ period_start: '2026-05-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100 }),
  ], { periods_in_cycle: 12 });
  assert.equal(out.months, 2);
  assert.equal(out.cycle_coverage_pct, 16.7);
  assert.equal(out.first_period, '2026-04-21');
  assert.equal(out.last_period, '2026-05-21');
});

// ---- the override -------------------------------------------------------

test('an override replaces the month it is on, and is counted', () => {
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100, score: 40 }),
    m({ period_start: '2026-05-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100, score: 40,
        override_score: 80, override_reason: 'two sprints ran outside Zoho' }),
  ]);
  assert.equal(out.overrides, 1);
  assert.equal(out.score, 60, 'the overridden month counts as 80, not 40');
  assert.equal(out.months_scored, 2);
});

test('WHAT THE OVERRIDE REPLACED IS KEPT, NOT OVERWRITTEN', () => {
  // A REGRESSION TEST FOR MY OWN BUG. effectiveOf overwrites score with
  // the override, and the reasons list read its "from" off the same
  // object — so a month overridden from nothing to 78 reported
  // "78 -> 78", destroying the only record of what had changed.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100,
        score: null, grade: null, override_score: 78, override_grade: 'A', override_reason: 'ran in Jira' }),
  ]);
  assert.deepEqual(out.override_reasons, [{
    period_start: '2026-04-21', reason: 'ran in Jira',
    from: null, from_grade: null, to: 78, to_grade: 'A',
  }]);
});

test('a score is produced only when a closed month carried one', () => {
  // auto_score ships off, so today every closed month has score null
  // and the rollup must not invent one.
  const out = r.rollup([
    m({ period_start: '2026-04-21', hours_logged: 100, hours_considered: 100, hours_attributed: 100 }),
  ]);
  assert.equal(out.score, null);
  assert.equal(out.months_scored, 0);
});

// ---- the label ----------------------------------------------------------

test('the label is a statement about evidence, never a grade', () => {
  // While most logged hours are unplaced, a letter would be an
  // assertion the data cannot support.
  assert.match(r.labelFor({ months: 2, mapped_pct: 20, scored: 0 }), /too thin to read/);
  assert.match(r.labelFor({ months: 2, mapped_pct: 95, scored: 0 }), /95% of logged hours placed/);
  assert.equal(r.labelFor({ months: 0 }), 'No month closed yet');
  assert.match(r.labelFor({ months: 1, mapped_pct: null, scored: 0 }), /no hours to place/);
  for (const l of [r.labelFor({ months: 2, mapped_pct: 95, scored: 2 }), r.labelFor({ months: 2, mapped_pct: 20, scored: 2 })]) {
    assert.ok(!/^[ABC]\+?$/.test(l.trim()), `not a grade: ${l}`);
  }
});

// ---- what an override may be ---------------------------------------------

test('an override needs a reason and something to override with', () => {
  assert.match(r.validateOverride({ score: 80 }), /Say why this month is being overridden/);
  assert.match(r.validateOverride({ reason: 'because' }), /Give a score or a grade/);
  assert.match(r.validateOverride({ score: 140, reason: 'x' }), /between 0 and 100/);
  assert.equal(r.validateOverride({ score: 80, reason: 'two sprints ran outside Zoho' }), null);
  assert.equal(r.validateOverride({ grade: 'A', reason: 'ditto' }), null);
});
