// node --test — the monthly numbers.
//
// Phase 2 of the Zoho timesheet rating engine. Pure: no database.
//
// The thing most worth pinning here is what the engine REFUSES to say.
// On the client's live data 87% of logged hours are unmapped and 1,338
// of 1,427 people have no KRA sheet at all; an engine that produced a
// letter grade anyway would be manufacturing an argument, not a
// measurement. Every test below that checks a null is checking that.
const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../modules/performance/timesheet-kra-score');
const m = require('../modules/performance/timesheet-kra-match');

const BANDS = [{ label: 'A+', min: 90 }, { label: 'A', min: 75 },
               { label: 'B+', min: 60 }, { label: 'B', min: 45 }, { label: 'C', min: 0 }];
const CFG = { auto_score: true, weight_coverage: 50, weight_compliance: 30,
              weight_value_add: 20, min_mapped_pct: 80, bands: BANDS };
const OFF = { ...CFG, auto_score: false };
const NO_VA = { hits: [], hours: 0, entries: 0, words: [] };

// Builds an attribution the honest way — through the real matcher —
// rather than hand-rolling its output, so these tests cannot drift from
// what the engine actually produces.
function att(kras, entries, map = []) { return m.attribute(entries, kras, map); }
const e = (id, hours, name = 'x') => ({ log_date: '2026-09-01', hours, item_id: id, item_name: name, description: '' });

const THREE = [
  { id: 'a', title: 'A', weight: 40, keywords: [] },
  { id: 'b', title: 'B', weight: 40, keywords: [] },
  { id: 'c', title: 'C', weight: 20, keywords: [] },
];
const allTo = (kra, ids) => ids.map((i) => ({ item_key: i, decision: 'kra', kra_id: kra }));

// ---- coverage -----------------------------------------------------------

test('WEIGHTED COVERAGE CAN FALL', () => {
  // The regression that matters most. The first version computed
  // coverage over the KRAs that "could be scored", and a KRA counted as
  // scorable once something was mapped to it — so it became scorable by
  // receiving hours and coverage was 100% whenever anything was mapped.
  const r = s.summarise(att(THREE, [e('x', 1)], allTo('a', ['x'])), NO_VA, 90, CFG);
  assert.equal(r.weighted_coverage_pct, 40, 'one of three KRAs, weight 40 of 100');
});

test('coverage is by weight, not by count', () => {
  // Touching the 20-weight KRA is not the same as touching the 40 one,
  // and counting buckets says it is. That is the spec metric this
  // replaces: it rewards breadth over value.
  const light = s.summarise(att(THREE, [e('x', 1)], allTo('c', ['x'])), NO_VA, 90, CFG);
  const heavy = s.summarise(att(THREE, [e('x', 1)], allTo('a', ['x'])), NO_VA, 90, CFG);
  assert.equal(light.weighted_coverage_pct, 20);
  assert.equal(heavy.weighted_coverage_pct, 40);
});

test('a KRA that cannot be measured from timesheets leaves the denominator', () => {
  // "CSAT Score" is measured from quarterly client feedback. Counted as
  // an uncovered zero every month it would mark everyone down forever.
  const kras = [
    { id: 'a', title: 'A', weight: 80, keywords: [] },
    { id: 'c', title: 'CSAT', weight: 20, keywords: [], timesheet_tracked: false, timesheet_untracked_reason: 'client survey' },
  ];
  const r = s.summarise(att(kras, [e('x', 1)], allTo('a', ['x'])), NO_VA, 90, CFG);
  assert.equal(r.weighted_coverage_pct, 100, '80 of the 80 that can be measured');
  assert.equal(r.unscorable_kras, 1);
  assert.equal(r.scorable_weight, 80);
});

// ---- alignment ----------------------------------------------------------

test('alignment is 100 only when effort matches the weights', () => {
  const entries = [e('x', 40), e('y', 40), e('z', 20)];
  const map = [{ item_key: 'x', decision: 'kra', kra_id: 'a' },
               { item_key: 'y', decision: 'kra', kra_id: 'b' },
               { item_key: 'z', decision: 'kra', kra_id: 'c' }];
  assert.equal(s.summarise(att(THREE, entries, map), NO_VA, 90, CFG).alignment_pct, 100);
});

test('alignment falls when the hours go to the wrong objective', () => {
  // Full coverage, badly proportioned: every KRA touched, but almost
  // everything went to the 20-weight one. Coverage alone calls this
  // perfect, which is why alignment exists.
  const entries = [e('x', 1), e('y', 1), e('z', 98)];
  const map = [{ item_key: 'x', decision: 'kra', kra_id: 'a' },
               { item_key: 'y', decision: 'kra', kra_id: 'b' },
               { item_key: 'z', decision: 'kra', kra_id: 'c' }];
  const r = s.summarise(att(THREE, entries, map), NO_VA, 90, CFG);
  assert.equal(r.weighted_coverage_pct, 100, 'coverage says this is perfect');
  assert.ok(r.alignment_pct < 25, `alignment says it is not (${r.alignment_pct})`);
});

test('alignment is null, not zero, when nothing could be placed', () => {
  // No hours placed is "we cannot tell", not "perfectly misaligned".
  const r = s.summarise(att(THREE, [e('x', 8)], []), NO_VA, 90, CFG);
  assert.equal(r.alignment_pct, null);
});

// ---- what is refused, and why -------------------------------------------

test('AUTOMATIC SCORING IS OFF, and the screen is told so in words', () => {
  const r = s.summarise(att(THREE, [e('x', 10)], allTo('a', ['x'])), NO_VA, 90, OFF);
  assert.equal(r.score, null);
  assert.equal(r.grade, null);
  assert.equal(r.auto_score, false);
  assert.match(r.withheld.join(' '), /reported as coverage only/);
});

test('a thin mapping withholds the score and says how thin', () => {
  // 87% unmapped is what the client's real month looks like today. A
  // score computed on the other 13% is not a measurement.
  const entries = [e('x', 13), e('y', 87)];
  const r = s.summarise(att(THREE, entries, allTo('a', ['x'])), NO_VA, 90, CFG);
  assert.equal(r.mapped_pct, 13);
  assert.equal(r.score, null);
  assert.match(r.withheld.join(' '), /Only 13% of the hours considered are mapped/);
  assert.match(r.withheld.join(' '), /below the 80%/);
});

test('NO KRA SHEET IS SAID DIFFERENTLY FROM NO MAPPING', () => {
  // 1,338 of 1,427 people on the live instance have no KRA sheet. For
  // them nothing is wrong with the mapping — there is nothing to map
  // TO, and the fix is a sheet, not a mapping session. Conflating the
  // two would hide the biggest constraint on this whole feature.
  const r = s.summarise(att([], [e('x', 10)], []), NO_VA, 90, CFG);
  assert.match(r.withheld.join(' '), /has no KRAs for this cycle/);
  assert.ok(!/not measurable from timesheets/.test(r.withheld.join(' ')));

  const allUntracked = [{ id: 'a', title: 'A', weight: 100, keywords: [], timesheet_tracked: false, timesheet_untracked_reason: 'x' }];
  const r2 = s.summarise(att(allUntracked, [e('x', 10)], []), NO_VA, 90, CFG);
  assert.match(r2.withheld.join(' '), /marked as not measurable from timesheets/);
});

test('no compliance figure withholds the score rather than assuming zero', () => {
  const r = s.summarise(att(THREE, [e('x', 10)], allTo('a', ['x'])), NO_VA, null, CFG);
  assert.equal(r.compliance_pct, null);
  assert.equal(r.score, null);
  assert.match(r.withheld.join(' '), /compliance component cannot be computed/);
});

// ---- the score, when it is allowed --------------------------------------

test('with both gates passed the score is the weighted sum, and shows its working', () => {
  const entries = [e('x', 40), e('y', 40), e('z', 20)];
  const map = [{ item_key: 'x', decision: 'kra', kra_id: 'a' },
               { item_key: 'y', decision: 'kra', kra_id: 'b' },
               { item_key: 'z', decision: 'kra', kra_id: 'c' }];
  const r = s.summarise(att(THREE, entries, map), NO_VA, 80, CFG);
  assert.deepEqual(r.withheld, []);
  // coverage 100 x 50% + compliance 80 x 30% + value-add 0 x 20% = 74
  assert.equal(r.score, 74);
  assert.equal(r.grade, 'B+');
  assert.deepEqual(r.components.map((c) => [c.key, c.pct, c.points]),
    [['coverage', 100, 50], ['compliance', 80, 24], ['value_add', 0, 0]]);
});

test('the grade comes from the bands it is given, never from a literal', () => {
  assert.equal(s.gradeFor(95, BANDS), 'A+');
  assert.equal(s.gradeFor(75, BANDS), 'A');
  assert.equal(s.gradeFor(0, BANDS), 'C');
  assert.equal(s.gradeFor(null, BANDS), null);
  // A client's own ladder, not ours.
  assert.equal(s.gradeFor(60, [{ label: 'Pass', min: 50 }, { label: 'Fail', min: 0 }]), 'Pass');
});

// ---- what HR may set ----------------------------------------------------

test('the three weights must add up to 100, and are not silently normalised', () => {
  // Three weights totalling 90 mean somebody mistyped one. Scaling them
  // up would produce a score that looks entirely correct.
  assert.match(s.validateScoring({ ...CFG, weight_value_add: 10 }), /add up to 100 — they add up to 90/);
  assert.equal(s.validateScoring(CFG), null);
});

test('a ladder with no floor is refused', () => {
  // Without a band at 0 a low score gets no grade at all, which reads
  // on screen as the engine failing rather than as a C.
  assert.match(s.validateScoring({ ...CFG, bands: [{ label: 'A', min: 50 }] }), /must start at 0/);
  assert.match(s.validateScoring({ ...CFG, bands: [] }), /at least one band/);
  assert.match(s.validateScoring({ ...CFG, bands: [{ label: 'A', min: 0 }, { label: 'a', min: 50 }] }), /Two bands are both called/);
  assert.match(s.validateScoring({ ...CFG, min_mapped_pct: 120 }), /between 0 and 100/);
});

// ---- kraRatings: hours against required hours, per KRA (6 Oct) ------------

const KR = (byKra, days, extra = {}, mapped = 100) => s.kraRatings({ by_kra: byKra, totals: { mapped_pct: mapped } },
  { min_mapped_pct: 80, hours_per_day: 8, ...extra }, { working_days: days });
const K = (id, weight, hours, scorable = true) => ({ kra_id: id, title: id, weight, hours, scorable });

test('THE CLIENT\'S EXAMPLE: 140 required hours, a 25% KRA expects 35 h', () => {
  // 17.5 working days x 8 h = 140 h. Four KRAs at 25% each.
  const r = KR([K('a', 25, 35), K('b', 25, 17.5), K('c', 25, 10), K('d', 25, 0)], 17.5);
  assert.equal(r.required_hours, 140);
  const by = Object.fromEntries(r.ratings.map((x) => [x.kra_id, x]));
  assert.equal(by.a.expected_hours, 35);
  assert.equal(by.a.effort_pct, 100); assert.equal(by.a.rating, 'A+', 'all the expected hours is A+');
  assert.equal(by.b.effort_pct, 50, '70 of 140 is 50% — the same rule on one KRA');
  assert.equal(by.b.rating, 'B', 'below 70% is B');
  assert.equal(by.c.effort_pct, 28.6); assert.equal(by.c.rating, 'B', 'below 40% is B');
  assert.equal(by.d.rating, 'B');
});

test('the client\'s ladder: A+ from 100, A from 80, B+ from 70, B below — and overtime shows', () => {
  const at = (h) => KR([K('a', 100, h)], 10).ratings[0];   // 80 h required
  assert.equal(at(55.9).rating, 'B', '69.9% is B');
  assert.equal(at(56).rating, 'B+', 'exactly 70% is B+');
  assert.equal(at(63.9).rating, 'B+');
  assert.equal(at(64).rating, 'A', 'exactly 80% is A');
  assert.equal(at(79.9).rating, 'A', 'just short of the expected hours is A');
  assert.equal(at(80).rating, 'A+', 'all the expected hours is A+');
  assert.equal(at(100).effort_pct, 125, 'not capped — "more than 100%" has to be visible');
  assert.equal(at(100).rating, 'A+');
});

test('a KRA not measured from timesheets expects no hours, and its weight is shared out', () => {
  // 20 days x 8 = 160 h; CSAT 20% unmeasured, so the 40% KRAs expect 80 h each.
  const r = KR([K('a', 40, 80), K('b', 40, 40), K('csat', 20, 0, false)], 20);
  const by = Object.fromEntries(r.ratings.map((x) => [x.kra_id, x]));
  assert.equal(by.csat.rating, null); assert.equal(by.csat.measured, false);
  assert.equal(by.a.expected_hours, 80); assert.equal(by.a.rating, 'A+');
  assert.equal(by.b.effort_pct, 50); assert.equal(by.b.rating, 'B');
});

test('hours per day is the tenant\'s', () => {
  assert.equal(KR([K('a', 100, 10)], 10, { hours_per_day: 9 }).required_hours, 90);
});

test('no mapped hours: no ratings invented, and a sentence saying why', () => {
  const r = KR([K('a', 50, 0), K('b', 50, 0)], 20, {}, 0);
  assert.ok(r.ratings.every((x) => x.rating === null));
  assert.match(r.note, /None of the logged hours are placed/);
});

test('a thin mapping still rates, and says unmapped hours count for no KRA', () => {
  const r = KR([K('a', 50, 40), K('b', 50, 40)], 20, {}, 13);
  assert.equal(r.thin, true);
  assert.match(r.note, /13% of the hours logged/);
});

test('HR\'s own KRA bands replace the default ladder', () => {
  const r = KR([K('a', 50, 80), K('b', 50, 0)], 20, { kra_bands: [{ label: 'Met', min: 90 }, { label: 'Not met', min: 0 }] });
  assert.deepEqual(r.ratings.map((x) => x.rating), ['Met', 'Not met']);
});

test('KRA bands and hours per day are validated like the rest of scoring', () => {
  const base = { weight_coverage: 50, weight_compliance: 30, weight_value_add: 20, min_mapped_pct: 80 };
  assert.match(s.validateScoring({ ...base, hours_per_day: 0 }), /Hours per day/);
  assert.match(s.validateScoring({ ...base, kra_bands: [{ label: 'A', min: 40 }] }), /must start at 0/);
  assert.equal(s.validateScoring({ ...base, hours_per_day: 8, kra_bands: s.DEFAULT_KRA_BANDS }), null);
});
