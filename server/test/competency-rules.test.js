// node --test — the arithmetic behind competency mapping.
//
// competency-rules.js is pure so these can run without a database, and
// because every number it produces is one somebody will argue with. The
// house rule is that numbers are deterministic; this is where that is
// held to.
//
// No database: nothing here touches one.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  validRating, requiredLevelFor, competenciesFor, summarise, divergences, priorityOf,
} = require('../modules/performance/competency-rules');

const SCALE = [
  { level: 1, label: 'Awareness' }, { level: 2, label: 'Developing' },
  { level: 3, label: 'Proficient' }, { level: 4, label: 'Advanced' }, { level: 5, label: 'Expert' },
];

test('a rating is 1-5, and blank is not zero', () => {
  for (const v of [1, 2, 3, 4, 5]) assert.equal(validRating(v).value, v);
  for (const v of [null, undefined, '']) {
    const r = validRating(v);
    assert.ok(r.ok && r.value === null, `${JSON.stringify(v)} is "not rated"`);
  }
  // ZERO IS NOT UNRATED. It is a value somebody typed, and quietly
  // treating it as blank loses the fact that they typed it.
  assert.equal(validRating(0).ok, false);
  assert.equal(validRating(6).ok, false);
  assert.equal(validRating(2.5).ok, false, 'half levels are not a thing on this scale');
  assert.equal(validRating('four').ok, false);
  assert.match(validRating(9).reason, /between 1 and 5/);
});

test('a job-specific level beats the company default, and a department beats a blank one', () => {
  const levels = [
    { competency_id: 'c1', designation: 'Software Developer', department: null, required_level: 3 },
    { competency_id: 'c1', designation: 'Software Developer', department: 'Cyber Security', required_level: 5 },
    { competency_id: 'c2', designation: 'Lead', department: null, required_level: 4 },
  ];
  assert.equal(requiredLevelFor('c1', { designation: 'Software Developer', department: 'Development' }, levels), 3);
  assert.equal(requiredLevelFor('c1', { designation: 'Software Developer', department: 'Cyber Security' }, levels), 5,
    'the department-specific level wins — the same rule the KRA library uses');
  // No row for this job at all: the caller falls back to the default.
  assert.equal(requiredLevelFor('c1', { designation: 'Manager', department: 'HR' }, levels), null);
  // Master data is full of casing and whitespace drift.
  assert.equal(requiredLevelFor('c1', { designation: ' software developer ', department: 'CYBER SECURITY' }, levels), 5);
});

test('leadership is only asked of somebody who has reports', () => {
  const all = [
    { id: 'a', name: 'Communication', managers_only: false, active: true },
    { id: 'b', name: 'Delegation', managers_only: true, active: true },
    { id: 'c', name: 'Retired thing', managers_only: false, active: false },
  ];
  assert.deepEqual(competenciesFor(all, { hasReports: false }).map((c) => c.id), ['a']);
  assert.deepEqual(competenciesFor(all, { hasReports: true }).map((c) => c.id), ['a', 'b']);
});

test('the gap is against the MANAGER rating, and an unrated thing has no gap', () => {
  const rows = [
    { competency_id: '1', category: 'F', name: 'Alpha', required_level: 4, self_rating: 5, manager_rating: 2 },
    { competency_id: '2', category: 'F', name: 'Beta', required_level: 4, self_rating: 4, manager_rating: 4 },
    // Self-rated only: it must not create a gap, and must not move any
    // manager-side average.
    { competency_id: '3', category: 'F', name: 'Gamma', required_level: 4, self_rating: 5, manager_rating: null },
  ];
  const s = summarise(rows, { scale: SCALE });
  assert.equal(s.overall.manager_rated, 2);
  assert.equal(s.overall.self_rated, 3);
  assert.equal(s.overall.avg_manager, 3, '(2+4)/2 — the unrated row is not a zero');
  assert.equal(s.overall.avg_required, 4, 'and required is averaged over the SAME two rows');
  assert.equal(s.overall.avg_gap, -1);
  assert.equal(s.overall.below_required, 1);
  assert.deepEqual(s.gaps.map((g) => g.name), ['Alpha']);
  assert.equal(s.gaps[0].current_label, 'Developing');
  assert.equal(s.gaps[0].required_label, 'Advanced');
});

test('nothing rated averages to NULL, never to zero', () => {
  // "0.0 average" and "nobody has been rated" are different facts, and a
  // dashboard that renders the second as the first is lying.
  const s = summarise([
    { competency_id: '1', category: 'L', name: 'Delegation', required_level: 4, self_rating: null, manager_rating: null },
  ], { scale: SCALE });
  assert.equal(s.overall.avg_manager, null);
  assert.equal(s.overall.avg_self, null);
  assert.equal(s.overall.avg_gap, null);
  assert.equal(s.categories[0].avg_manager, null);
  assert.equal(s.categories[0].priority, null, 'and no priority is claimed either');
});

test('priority thresholds are the stated ones', () => {
  assert.equal(priorityOf(-1, 0), 'High');
  assert.equal(priorityOf(-1.5, 0), 'High');
  assert.equal(priorityOf(-0.5, 0), 'Medium');
  assert.equal(priorityOf(-0.2, 3), 'Medium', 'three people short is Medium whatever the average');
  assert.equal(priorityOf(-0.2, 1), 'Low');
  assert.equal(priorityOf(0, 0), 'Met');
  assert.equal(priorityOf(0.5, 0), 'Met');
  assert.equal(priorityOf(null, 0), null);
});

test('gaps come back worst first', () => {
  const rows = [
    { competency_id: '1', category: 'F', name: 'Small', required_level: 4, manager_rating: 3 },
    { competency_id: '2', category: 'F', name: 'Huge', required_level: 5, manager_rating: 1 },
    { competency_id: '3', category: 'F', name: 'Fine', required_level: 3, manager_rating: 4 },
  ];
  const s = summarise(rows, { scale: SCALE });
  assert.deepEqual(s.gaps.map((g) => g.name), ['Huge', 'Small'], 'and a met competency is not a gap');
});

test('divergence is two levels or more, and says which way', () => {
  const rows = [
    { competency_id: '1', category: 'F', name: 'Agree', required_level: 4, self_rating: 4, manager_rating: 4 },
    { competency_id: '2', category: 'F', name: 'Close', required_level: 4, self_rating: 4, manager_rating: 3 },
    { competency_id: '3', category: 'F', name: 'Apart', required_level: 4, self_rating: 5, manager_rating: 2 },
    { competency_id: '4', category: 'F', name: 'Other way', required_level: 4, self_rating: 1, manager_rating: 4 },
    // One side missing is not a disagreement.
    { competency_id: '5', category: 'F', name: 'Half', required_level: 4, self_rating: 5, manager_rating: null },
  ];
  const d = divergences(rows);
  assert.deepEqual(d.map((x) => x.name), ['Apart', 'Other way'],
    'one level apart is calibration noise and is not reported');
  assert.equal(d[0].direction, 'employee_rates_higher');
  assert.equal(d[1].direction, 'manager_rates_higher');
});

test('categories are summarised separately, not lumped together', () => {
  const rows = [
    { competency_id: '1', category: 'FUNCTIONAL', name: 'A', required_level: 4, manager_rating: 2 },
    { competency_id: '2', category: 'FUNCTIONAL', name: 'B', required_level: 4, manager_rating: 2 },
    { competency_id: '3', category: 'BEHAVIOURAL', name: 'C', required_level: 4, manager_rating: 4 },
  ];
  const s = summarise(rows, { scale: SCALE });
  const f = s.categories.find((c) => c.category === 'FUNCTIONAL');
  const b = s.categories.find((c) => c.category === 'BEHAVIOURAL');
  assert.equal(f.avg_gap, -2);
  assert.equal(f.priority, 'High');
  assert.equal(b.avg_gap, 0);
  assert.equal(b.priority, 'Met');
  assert.equal(s.overall.avg_gap, -1.33, 'and the overall is the average of the ROWS, not of the categories');
});
