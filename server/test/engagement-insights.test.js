// node --test — turning answers into action (phase 5, 25 Sep).
//
// Sections 20 to 25: the red-flag engine, the 30/60/90 trend, the
// onboarding dashboard, and survey data read against PMS data.
//
// NO LISTENING AGENT. Excluded by Mindgate, and there is nothing here
// to exclude it from: every number below is arithmetic over stored
// answers, and a test can therefore say what the right answer IS
// rather than that something plausible came back.
//
// insights.js is pure, so most of this needs no database.
const { test } = require('node:test');
const assert = require('node:assert');
const { toPercent, ruleMatches, flagsFor, worst, scoreByDimension, overallScore,
        direction, trend, newHireIndex, outcomeByBand } = require('../modules/engagement/insights');

const a = (o) => ({ qtype: 'scale', dimension: 'role_clarity', value_num: null,
                    value_text: null, value_list: null, prompt: 'q', ...o });

test('a 1-5 answer and a 0-10 answer are put on one scale before averaging', () => {
  // Averaging a 2 (out of 5) with a 7 (out of 10) as raw numbers gives
  // 4.5, which is meaningless. On a common scale they are 25 and 70.
  assert.equal(toPercent('scale', 1), 0);
  assert.equal(toPercent('scale', 3), 50);
  assert.equal(toPercent('scale', 5), 100);
  assert.equal(toPercent('enps', 0), 0);
  assert.equal(toPercent('enps', 7), 70);
  assert.equal(toPercent('enps', 10), 100);
  // Unscorable types return null rather than 0 — a text answer is not
  // a bad score, and counting it as one drags every average down.
  assert.equal(toPercent('text', 'anything'), null);
  assert.equal(toPercent('choice', 'Lack of training'), null);
  assert.equal(toPercent('scale', null), null);
});

// ---- the red-flag engine (section 22) --------------------------------
const RULE = { key: 'low_role_clarity', dimension: 'role_clarity', applies_to: 'scale',
  comparator: 'lte', threshold_num: 2, severity: 'amber', label: 'Role clarity is low',
  action: 'Restate the role', owner: 'Manager', follow_up_days: 14 };

test('a rule fires on its own dimension and question type, and no other', () => {
  assert.equal(ruleMatches(RULE, a({ value_num: 2 })), true);
  assert.equal(ruleMatches(RULE, a({ value_num: 3 })), false, 'above the threshold');
  assert.equal(ruleMatches(RULE, a({ value_num: 2, dimension: 'training' })), false, 'wrong dimension');
  assert.equal(ruleMatches(RULE, a({ value_num: 2, qtype: 'enps' })), false, 'wrong question type');
  assert.equal(ruleMatches(RULE, a({ value_num: null })), false, 'unanswered is not a flag');
});

test('"between" is inclusive at both ends, so no score falls between two bands', () => {
  const r = { applies_to: 'enps', comparator: 'between', threshold_num: 4, threshold_max: 6,
    severity: 'amber', label: 'Lukewarm', action: 'x', owner: 'y' };
  const e = (n) => ruleMatches(r, a({ qtype: 'enps', dimension: null, value_num: n }));
  assert.deepEqual([3, 4, 5, 6, 7].map(e), [false, true, true, true, false]);
});

test('"not_in" needs an actual answer — an unanswered question is not a blocker', () => {
  // THE BUG THIS PREVENTS. "anything other than No significant
  // blocker" matches emptiness too, so every skipped question would
  // become an amber flag and the dashboard would read as a crisis.
  const r = { applies_to: 'choice', comparator: 'not_in', match_values: ['No significant blocker'],
    severity: 'amber', label: 'Blocker', action: 'x', owner: 'y' };
  const ans = (text) => a({ qtype: 'choice', dimension: null, value_text: text });
  assert.equal(ruleMatches(r, ans('Lack of training')), true);
  assert.equal(ruleMatches(r, ans('No significant blocker')), false);
  assert.equal(ruleMatches(r, ans(null)), false, 'unanswered must not fire');
  assert.equal(ruleMatches(r, { qtype: 'choice', value_list: [] }), false);
});

test('red beats amber — one red among four ambers is a red', () => {
  assert.equal(worst([]), 'green');
  assert.equal(worst(null), 'green');
  assert.equal(worst([{ severity: 'amber' }, { severity: 'amber' }]), 'amber');
  assert.equal(worst([{ severity: 'amber' }, { severity: 'red' }, { severity: 'amber' }]), 'red');
});

test('a flag carries the action, the owner and the follow-up, not just a colour', () => {
  // Section 20: "Survey → Score → Risk → Action → Owner → Follow-up".
  // A colour with nothing attached is where most HR dashboards stop.
  const flags = flagsFor([a({ value_num: 1, prompt: 'I understand my responsibilities.' })], [RULE]);
  assert.equal(flags.length, 1);
  assert.deepEqual(
    { severity: flags[0].severity, owner: flags[0].owner, days: flags[0].follow_up_days },
    { severity: 'amber', owner: 'Manager', days: 14 });
  assert.equal(flags[0].action, 'Restate the role');
  assert.equal(flags[0].value, 1, 'and the answer that caused it');
  assert.equal(flags[0].prompt, 'I understand my responsibilities.');
});

test('an inactive rule fires on nobody', () => {
  assert.deepEqual(flagsFor([a({ value_num: 1 })], [{ ...RULE, active: false }]), []);
});

// ---- dimension scores and the trend (section 23) ---------------------
test('a dimension score ignores text and undimensioned answers', () => {
  const byDim = scoreByDimension([
    a({ value_num: 5 }),                                        // 100
    a({ value_num: 3 }),                                        // 50
    a({ qtype: 'text', value_text: 'a paragraph' }),            // ignored
    a({ dimension: null, value_num: 1 }),                       // ignored
    a({ dimension: 'training', qtype: 'enps', value_num: 8 }),  // 80
  ]);
  assert.deepEqual(byDim, { role_clarity: 75, training: 80 });
  assert.equal(overallScore(byDim), 77.5);
  assert.equal(overallScore({}), null, 'no scores is null, not zero');
});

test('the arrow does not flicker on noise', () => {
  assert.equal(direction(62, 63.4), 'flat', 'under the threshold');
  assert.equal(direction(62, 70), 'up');
  assert.equal(direction(70, 62), 'down');
  assert.equal(direction(null, 70), null, 'one reading is not a trend');
});

test('the 30/60/90 trend reads first to latest, not the last two', () => {
  // "Did this improve over the ninety days" is the question. A dip
  // between two adjacent readings is not the answer to it, and
  // last-two would report Role Clarity as falling here when it rose
  // 40 points.
  const reading = (milestone, vals) => ({ milestone, label: `Day ${milestone}`, taken_at: `2026-0${milestone / 30 + 1}-01`,
    answers: vals.map((v) => a({ value_num: v })) });
  const { points, rows } = trend([reading(90, [4]), reading(30, [2]), reading(60, [5])]);
  assert.deepEqual(points.map((p) => p.milestone), [30, 60, 90], 'in milestone order, whatever order they arrive in');
  const rc = rows.find((r) => r.dimension === 'role_clarity');
  assert.deepEqual(rc.series, [25, 100, 75]);
  assert.equal(rc.first, 25);
  assert.equal(rc.latest, 75);
  assert.equal(rc.direction, 'up', 'first to latest is +50, despite the dip from 100');
});

test('a dimension asked at only one milestone has a series with a gap, not a zero', () => {
  const { rows } = trend([
    { milestone: 30, answers: [a({ value_num: 4 }), a({ dimension: 'career', value_num: 2 })] },
    { milestone: 60, answers: [a({ value_num: 5 })] },
  ]);
  const career = rows.find((r) => r.dimension === 'career');
  assert.deepEqual(career.series, [25, null], 'not asked at 60 is null, not 0');
  assert.equal(career.direction, null, 'and one reading is not a direction');
});

// ---- the onboarding dashboard (section 24) ---------------------------
test('the index lists dimensions weakest first, and counts the blockers named', () => {
  const person = (rc, prod, blocker) => ({ employee_id: rc + prod + blocker, answers: [
    a({ value_num: rc }),
    a({ dimension: 'productivity', value_num: prod }),
    a({ dimension: 'blocker', qtype: 'choice', value_text: blocker }),
    // A productivity LEVEL, not a blocker. It lives on the
    // productivity dimension and must never reach the blocker tally —
    // it put "Still learning, 100%" at the top of the list of things
    // to fix, which is why blockers have a dimension of their own.
    a({ dimension: 'productivity', qtype: 'choice', value_text: 'Still learning' }),
  ] });
  const idx = newHireIndex([
    person(5, 2, 'Lack of training'),
    person(4, 2, 'Lack of training'),
    person(5, 3, 'Dependency on others'),
    person(5, 4, 'No significant blocker'),
  ]);
  assert.equal(idx.people, 4);
  assert.equal(idx.dimensions[0].dimension, 'productivity', 'weakest first — that is what to fix');
  assert.ok(idx.dimensions[0].score < idx.dimensions[1].score);
  assert.deepEqual(idx.blockers.map((b) => [b.blocker, b.count]),
    [['Lack of training', 2], ['Dependency on others', 1]]);
  assert.equal(idx.blockers[0].pct, 50, '2 of 4 people');
  assert.ok(!idx.blockers.some((b) => /No significant blocker/i.test(b.blocker)),
    '"no blocker" is not a blocker — counting it would be the top result every time');
  assert.ok(!idx.blockers.some((b) => /Still learning/i.test(b.blocker)),
    'and a productivity LEVEL is not a blocker either');
});

test('the index is honest about an empty intake', () => {
  const idx = newHireIndex([]);
  assert.equal(idx.people, 0);
  assert.equal(idx.overall, null, 'null, not 0 — nobody answered, the score is not zero');
  assert.deepEqual(idx.dimensions, []);
  assert.deepEqual(idx.blockers, []);
});

// ---- survey data against PMS data (section 25) -----------------------
test('outcomes are banded by score, and attrition reported per band', () => {
  // "Do employees who report low manager support in the first 90 days
  // subsequently have higher attrition?" — answered as counts against
  // names, not as a coefficient nobody can check.
  const r = outcomeByBand([
    { score: 20, left: true, rating: 'C' },
    { score: 40, left: true, rating: null },
    { score: 45, left: false, rating: 'B' },
    { score: 60, left: false, rating: 'B' },
    { score: 90, left: false, rating: 'A' },
    { score: null, left: false, rating: 'A' },
  ]);
  const low = r.bands.find((b) => b.key === 'low');
  assert.equal(low.n, 3);
  assert.equal(low.left, 2);
  assert.equal(low.attrition_pct, 67);
  assert.equal(r.bands.find((b) => b.key === 'high').attrition_pct, 0);
  assert.equal(r.unscored, 1, 'somebody with no score is counted apart, not dropped into a band');
  assert.equal(r.has_ratings, true);
});

test('a band nobody is in reports null attrition, not 0%', () => {
  // 0% reads as "nobody in this band leaves", which is a claim. Null
  // reads as "no data", which is the truth.
  const r = outcomeByBand([{ score: 90, left: false }]);
  assert.equal(r.bands.find((b) => b.key === 'low').n, 0);
  assert.equal(r.bands.find((b) => b.key === 'low').attrition_pct, null);
});

test('the performance half is reported missing rather than implied', () => {
  // On this tenant no employee has an appraisal rating yet, so the
  // correlation has only one half. Saying so is the difference
  // between "no relationship" and "no data".
  const r = outcomeByBand([{ score: 20, left: true, rating: null }, { score: 90, left: false, rating: null }]);
  assert.equal(r.has_ratings, false);
  assert.equal(r.bands.find((b) => b.key === 'low').attrition_pct, 100, 'attrition still works');
});
