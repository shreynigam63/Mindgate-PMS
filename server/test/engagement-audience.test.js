// node --test — the audience rules behind "push this form to all
// employees who fit that category" (25 Sep).
//
// audience.js is pure on purpose: no db, no express. Every assertion
// below is a mistake this code could quietly make against 1,427 real
// employees, where the symptom is a cohort that is silently the wrong
// people and nobody notices until the survey has gone out.
const { test } = require('node:test');
const assert = require('node:assert');
const { normaliseRule, audienceSql, describeRule, isEveryone,
        needsJoiningDate, triggerRule, MILESTONES } = require('../modules/engagement/audience');

test('an empty rule is everybody, which is what the old audience meant', () => {
  for (const r of [null, undefined, {}, { departments: [] }, { departments: null }, 'nonsense', []]) {
    assert.equal(isEveryone(r), true, `${JSON.stringify(r)} should mean everyone`);
  }
  assert.equal(audienceSql({}).where, 'true');
  assert.deepEqual(audienceSql({}).params, []);
  assert.match(describeRule({}), /everyone on the employee list/);
});

test('every value is a bound parameter — a department name never reaches the SQL', () => {
  // Department names are HR's free text off an HRMS export.
  const evil = "Development'; DROP TABLE core.employees; --";
  const { where, params } = audienceSql({ departments: [evil] });
  assert.ok(!where.includes('DROP'), `the value leaked into the SQL: ${where}`);
  assert.ok(!where.includes(evil));
  assert.match(where, /department = ANY\(\$1\)/);
  assert.deepEqual(params, [[evil]]);
});

test('parameters are numbered from where the caller left off', () => {
  // resolveAudience already holds $1 for tenant_id.
  const { where, params } = audienceSql({ departments: ['Cloud'], designations: ['Manager'] }, { start: 2 });
  assert.match(where, /department = ANY\(\$2\) AND designation = ANY\(\$3\)/);
  assert.deepEqual(params, [['Cloud'], ['Manager']]);
});

test('a minimum tenure is an EARLIER joining date, not a later one', () => {
  // Getting this backwards inverts the cohort silently: "Day 30" would
  // go to everyone who joined in the last 30 days instead of the people
  // who have been here 30 days. The direction is asserted on the
  // operator, because that is the thing that flips.
  const { where } = audienceSql({ tenure_min_days: 30, tenure_max_days: 36 });
  assert.match(where, /date_of_joining <= current_date - \$1::int/, 'min tenure => joined on or before');
  assert.match(where, /date_of_joining >= current_date - \$2::int/, 'max tenure => joined on or after');
});

test('a tenure rule excludes people with no joining date, and says it does', () => {
  assert.equal(needsJoiningDate({ tenure_min_days: 30 }), true);
  assert.equal(needsJoiningDate({ departments: ['Cloud'] }), false);
  assert.match(audienceSql({ tenure_min_days: 30 }).where, /date_of_joining IS NOT NULL/);
  assert.ok(!audienceSql({ departments: ['Cloud'] }).where.includes('date_of_joining'),
    'a rule with no tenure must not filter on the joining date at all');
});

test('a window typed backwards is swapped, not treated as an empty audience', () => {
  const r = normaliseRule({ tenure_min_days: 60, tenure_max_days: 30 });
  assert.equal(r.tenure_min_days, 30);
  assert.equal(r.tenure_max_days, 60);
});

test('rules are cleaned: blanks dropped, duplicates collapsed, numbers whole', () => {
  const r = normaliseRule({
    departments: ['Cloud', '  Cloud  ', '', null, 'IT'],
    designations: 'Manager',                       // a bare string, not a list
    tenure_min_days: '30.7', tenure_max_days: 60,
  });
  assert.deepEqual(r.departments, ['Cloud', 'IT'], 'trimmed and de-duplicated');
  assert.deepEqual(r.designations, ['Manager'], 'a single value is still a list');
  assert.equal(r.tenure_min_days, 30, 'truncated to a whole day');
  // A negative day is clamped to zero. Checked on its own, because
  // clamping happens BEFORE the backwards-window swap and combining
  // the two in one fixture asserts the pre-swap values by mistake.
  assert.equal(normaliseRule({ tenure_max_days: -5 }).tenure_max_days, 0);
  assert.equal(normaliseRule({ tenure_min_days: -5 }).tenure_min_days, 0);
  // ...and clamp-then-swap is the order, so this pair comes out sane
  // rather than as min 30 / max 0, which would match nobody.
  const clamped = normaliseRule({ tenure_min_days: 30, tenure_max_days: -5 });
  assert.deepEqual([clamped.tenure_min_days, clamped.tenure_max_days], [0, 30]);
});

test('keys are ANDed and values inside a key are ORed', () => {
  const { where } = audienceSql({ departments: ['Cloud', 'IT'], designations: ['Lead'] });
  assert.equal(where, 'department = ANY($1) AND designation = ANY($2)');
});

test('managers are cast to uuid[] so a text column comparison cannot happen', () => {
  const { where } = audienceSql({ manager_ids: ['11111111-1111-1111-1111-111111111111'] });
  assert.match(where, /manager_id = ANY\(\$1::uuid\[\]\)/,
    'the PARAMETER is cast, so a text[] never meets a uuid column');
});

test('the audience is describable in a sentence HR can check before releasing', () => {
  assert.equal(describeRule({ departments: ['Cloud'], tenure_min_days: 30, tenure_max_days: 36 }),
    'everyone in Cloud, who joined between 30 and 36 days ago');
  assert.match(describeRule({ departments: ['Cloud', 'IT'] }), /in any of Cloud, IT/);
  assert.match(describeRule({ tenure_max_days: 90 }), /within the last 90 days/);
  assert.match(describeRule({ tenure_min_days: 365 }), /at least 365 days ago/);
});

// ---- lifecycle triggers ---------------------------------------------
test('a tenure trigger becomes a WINDOW, never an exact day', () => {
  // THE BUG THIS PREVENTS. On the real master the recent joiners sit at
  // 15, 17, 18, 23, 24, 29, 32, 38 days — a "day = 30" test matches
  // nobody most days, and one missed sweep loses that day's intake for
  // good, because an employee crosses day 30 exactly once.
  const r = triggerRule({ trigger_type: 'tenure', trigger_day: 30, trigger_window_days: 7, audience_rule: {} });
  assert.equal(r.tenure_min_days, 30);
  assert.equal(r.tenure_max_days, 37);
  assert.notEqual(r.tenure_min_days, r.tenure_max_days, 'a window, not a point');
});

test('a tenure trigger keeps the rest of the rule — category AND milestone', () => {
  const r = triggerRule({ trigger_type: 'tenure', trigger_day: 90, trigger_window_days: 7,
    audience_rule: { departments: ['Development'], role_bands: ['E3'] } });
  assert.deepEqual(r.departments, ['Development']);
  assert.deepEqual(r.role_bands, ['E3']);
  assert.equal(r.tenure_min_days, 90);
  assert.equal(r.tenure_max_days, 97);
});

test('a manual survey is never given a tenure window by the trigger rule', () => {
  const r = triggerRule({ trigger_type: 'manual', trigger_day: 30, audience_rule: { departments: ['Cloud'] } });
  assert.equal(r.tenure_min_days, null, 'a leftover trigger_day on a manual survey must not filter anyone out');
  assert.deepEqual(r.departments, ['Cloud']);
  // ...and neither is a tenure survey with no day set.
  assert.equal(triggerRule({ trigger_type: 'tenure', audience_rule: {} }).tenure_min_days, null);
});

test('Day 1 opens at zero days, so somebody joining today is in it', () => {
  const d1 = MILESTONES.find((m) => m.key === 'day_1');
  assert.equal(d1.day, 0, 'joining day itself');
  const r = triggerRule({ trigger_type: 'tenure', trigger_day: d1.day, trigger_window_days: d1.window });
  assert.equal(r.tenure_min_days, 0);
  assert.ok(r.tenure_max_days >= 1, 'and still catches them tomorrow if the sweep missed today');
});

test('the five milestones the spec asks for are all present and ordered', () => {
  assert.deepEqual(MILESTONES.map((m) => m.key), ['day_1', 'week_1', 'day_30', 'day_60', 'day_90']);
  for (const m of MILESTONES) {
    assert.ok(m.window >= 1, `${m.key} needs a catch-up window`);
    assert.ok(m.label, `${m.key} needs a label for the picker`);
  }
  // No two windows may overlap, or one employee lands in two milestones
  // on the same day and gets two surveys at once.
  for (let i = 1; i < MILESTONES.length; i++) {
    const prev = MILESTONES[i - 1];
    assert.ok(prev.day + prev.window < MILESTONES[i].day,
      `${prev.key} (${prev.day}..${prev.day + prev.window}) overlaps ${MILESTONES[i].key} (${MILESTONES[i].day})`);
  }
});
