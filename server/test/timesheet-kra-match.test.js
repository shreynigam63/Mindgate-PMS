// node --test — attributing logged hours to a KRA.
//
// Phase 2 of the Zoho timesheet rating engine. Pure: no database.
//
// These rules decide whose objective a day's work counts towards, so
// getting one wrong is not a display bug — it is somebody's month
// credited to the wrong KRA, which is the exact failure that made me
// stop short of shipping the spec's keyword-only formula. Running that
// formula over the client's real month put 88 hours of UPI delivery
// under "Training and team Upskill" because one keyword happened to
// appear in an unrelated story name.
//
// NOTHING HERE PRODUCES A RATING. Attribution only.
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../modules/performance/timesheet-kra-match');

const KRAS = [
  { id: 'k1', title: 'Incident analysis', weight: 30, keywords: ['rca', 'incident analysis'] },
  { id: 'k2', title: 'Client Delivery',   weight: 50, keywords: ['tap n pay'] },
  { id: 'k3', title: 'CSAT Score',        weight: 20, keywords: [] },
];
const e = (o) => ({ log_date: '2026-09-01', hours: 8, item_id: null, item_name: '', description: '', ...o });

// ---- the boundary rule --------------------------------------------------

test('a keyword matches on word boundaries, not anywhere in the text', () => {
  // "rca" inside "sarcastic" is the bug this prevents. On a real export
  // item names are full of product codes and run-together words, so
  // substring matching does not merely risk a false positive — it
  // guarantees a steady supply of them.
  assert.equal(m.containsPhrase('sarcastic remarks', 'rca'), false);
  assert.equal(m.containsPhrase('RCA prepared and shared', 'rca'), true);
  assert.equal(m.containsPhrase('prepared the RCA.', 'rca'), true);
  assert.equal(m.containsPhrase('RCA', 'rca'), true);
  // Multi-word phrases match naturally, hyphens included.
  assert.equal(m.containsPhrase('did some cross-team support today', 'cross-team support'), true);
  assert.equal(m.containsPhrase('bugfixing', 'bug fixing'), false);
});

test('the sprint name is NOT matched against', () => {
  // Every log in a sprint carries the same sprint name, so one keyword
  // appearing in it would tag a whole month at a stroke — the
  // confidently-wrong failure in its purest form.
  const entries = [e({ item_id: 'A', item_name: 'Something else', sprint: 'Q2 Incident Analysis Sprint' })];
  const r = m.attribute(entries, KRAS, []);
  assert.equal(r.items[0].how, 'unmapped');
});

// ---- the item is the unit -----------------------------------------------

test('the item id is the key, and the name is the fallback', () => {
  assert.equal(m.itemKeyOf({ item_id: 'U5P-I58', item_name: 'GFF Activities' }), 'u5p-i58');
  assert.equal(m.itemKeyOf({ item_name: '  Tap  N   Pay ' }), 'tap n pay');
  assert.equal(m.itemKeyOf({}), '');
});

test('many logs against one item collapse into one decision', () => {
  // A month is tens of items and hundreds of rows. Mapped, keyword or
  // ambiguous is a property of the ITEM — asking a manager the same
  // question once per log is a screen nobody finishes.
  const entries = [
    e({ item_id: 'U5P-I58', item_name: 'GFF Activities', hours: 8, log_date: '2026-09-01' }),
    e({ item_id: 'U5P-I58', item_name: 'GFF Activities', hours: 6, log_date: '2026-09-02' }),
    e({ item_id: 'U5P-I58', item_name: 'GFF Activities', hours: 4.5, log_date: '2026-09-03' }),
  ];
  const r = m.attribute(entries, KRAS, []);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].logs, 3);
  assert.equal(r.items[0].hours, 18.5);
  assert.equal(r.items[0].first_log, '2026-09-01');
  assert.equal(r.items[0].last_log, '2026-09-03');
});

// ---- precedence ---------------------------------------------------------

test('A MAPPING BEATS A KEYWORD', () => {
  // The whole argument for the mapping table. A keyword is a guess
  // about somebody else's free text; a mapping is a fact a manager
  // asserted. "Tap N Pay" matches k2's keyword, but the manager has
  // said it serves k1 on this person's sheet, and they are right.
  const entries = [e({ item_id: 'X', item_name: 'Tap N Pay rollout' })];
  const withoutMap = m.attribute(entries, KRAS, []);
  assert.equal(withoutMap.items[0].how, 'keyword');
  assert.equal(withoutMap.items[0].kra_id, 'k2');

  const withMap = m.attribute(entries, KRAS, [{ item_key: 'x', decision: 'kra', kra_id: 'k1' }]);
  assert.equal(withMap.items[0].how, 'mapped');
  assert.equal(withMap.items[0].kra_id, 'k1');
});

test('AMBIGUITY IS REPORTED, NEVER RESOLVED', () => {
  // Two KRAs' keywords both appear. Picking the first, the longest
  // match or the heaviest KRA would all be arbitrary, and arbitrary
  // here means hours quietly landing on the wrong objective.
  const entries = [e({ item_id: 'X', item_name: 'RCA for the Tap N Pay incident' })];
  const r = m.attribute(entries, KRAS, []);
  assert.equal(r.items[0].how, 'ambiguous');
  assert.equal(r.items[0].kra_id, null, 'attributed to neither');
  assert.deepEqual(r.items[0].candidates.map((c) => c.kra_id).sort(), ['k1', 'k2']);
  // And the hours are counted as ambiguous, not as attributed.
  assert.equal(r.totals.ambiguous, 8);
  assert.equal(r.totals.attributed, 0);
  assert.equal(r.totals.mapped_pct, 0);
});

test('a mapping pointing at a deleted KRA falls back rather than vanishing', () => {
  // The sheet was rewritten under the mapping. Treating the row as
  // gospel would attribute hours to nothing at all and report them as
  // mapped; dropping it silently would hide that it happened.
  const entries = [e({ item_id: 'X', item_name: 'RCA work' })];
  const r = m.attribute(entries, KRAS, [{ item_key: 'x', decision: 'kra', kra_id: 'deleted-kra' }]);
  assert.equal(r.items[0].how, 'keyword');
  assert.equal(r.items[0].kra_id, 'k1');
  assert.equal(r.items[0].stale_mapping, true, 'and it says the mapping was stale');
});

// ---- excluded hours -----------------------------------------------------

test('EXCLUDED HOURS LEAVE THE DENOMINATOR', () => {
  // Internal training the company asked for is not a failure to work on
  // your KRAs. Leaving those hours in the denominator marks a person
  // down for time they were told to spend, which is the fastest way to
  // turn a reporting tool into a grievance.
  const entries = [
    e({ item_id: 'A', item_name: 'RCA work', hours: 10 }),
    e({ item_id: 'B', item_name: 'Company offsite', hours: 10 }),
  ];
  const none = m.attribute(entries, KRAS, [{ item_key: 'a', decision: 'kra', kra_id: 'k1' }]);
  assert.equal(none.totals.mapped_pct, 50, 'with the offsite counted, half the month is unmapped');

  const r = m.attribute(entries, KRAS, [
    { item_key: 'a', decision: 'kra', kra_id: 'k1' },
    { item_key: 'b', decision: 'excluded', note: 'company offsite' },
  ]);
  assert.equal(r.totals.logged, 20);
  assert.equal(r.totals.excluded, 10);
  assert.equal(r.totals.considered, 10);
  assert.equal(r.totals.mapped_pct, 100);
});

// ---- arithmetic ---------------------------------------------------------

test('hours sum exactly, without float drift', () => {
  // The column is numeric(6,2) and these totals feed a percentage that
  // feeds, eventually, a rating. Summed as floats, 0.1 + 0.2 is famously
  // not 0.3; summed in integer hundredths it is.
  const entries = Array.from({ length: 30 }, () => e({ item_id: 'A', item_name: 'RCA work', hours: 0.1 }));
  const r = m.attribute(entries, KRAS, []);
  assert.equal(r.items[0].hours, 3);
  assert.equal(r.totals.logged, 3);
  // Proof the naive version would not have been exact.
  const naive = entries.reduce((t, x) => t + x.hours, 0);
  assert.notEqual(naive, 3, 'float summation of the same numbers is NOT exact');
});

test('shares are of what was attributed, not of everything logged', () => {
  // While most hours are unplaced, "35% of your month went here" would
  // be a lie. "Of the work we could place, 35% went here" is not.
  const entries = [
    e({ item_id: 'A', item_name: 'RCA work', hours: 30 }),
    e({ item_id: 'B', item_name: 'Tap N Pay', hours: 10 }),
    e({ item_id: 'C', item_name: 'Unrelated admin', hours: 60 }),
  ];
  const r = m.attribute(entries, KRAS, []);
  assert.equal(r.totals.attributed, 40);
  assert.equal(r.totals.unmapped, 60);
  const k1 = r.by_kra.find((k) => k.kra_id === 'k1');
  assert.equal(k1.share_pct, 75, '30 of the 40 placed hours, not 30 of 100');
});

// ---- tracked is a declaration -------------------------------------------

test('THE COVERAGE DENOMINATOR CANNOT BE EARNED BY RECEIVING HOURS', () => {
  // A REGRESSION TEST FOR MY OWN BUG. The first version inferred
  // "scorable" from whether anything had been mapped to the KRA — so a
  // KRA became scorable BY RECEIVING HOURS, and weighted coverage came
  // out at 100% whenever anything at all was mapped. One hour against
  // one of three equal KRAs reported full coverage. A metric that
  // cannot fall is not a metric.
  const kras = [
    { id: 'a', title: 'A', weight: 40, keywords: [] },
    { id: 'b', title: 'B', weight: 40, keywords: [] },
    { id: 'c', title: 'C', weight: 20, keywords: [] },
  ];
  const r = m.attribute([e({ item_id: 'X', item_name: 'x', hours: 1 })], kras,
    [{ item_key: 'x', decision: 'kra', kra_id: 'a' }]);
  assert.deepEqual(r.by_kra.map((k) => k.scorable), [true, true, true],
    'every KRA is tracked by default, whether or not hours landed on it');
  assert.deepEqual(r.uncovered.map((u) => u.kra_id).sort(), ['b', 'c'],
    'and the two that saw no work are named as the finding they are');
});

test('a KRA marked not measurable is separated out, with its reason', () => {
  const kras = [
    { id: 'a', title: 'Delivery', weight: 80, keywords: ['tap n pay'] },
    { id: 'c', title: 'CSAT Score', weight: 20, keywords: [],
      timesheet_tracked: false, timesheet_untracked_reason: 'quarterly client feedback' },
  ];
  const r = m.attribute([e({ item_id: 'X', item_name: 'Tap N Pay' })], kras, []);
  assert.deepEqual(r.unscorable, [{ kra_id: 'c', title: 'CSAT Score', weight: 20, reason: 'quarterly client feedback' }]);
  assert.deepEqual(r.uncovered, [], 'and it is not also reported as an uncovered gap');
});

// ---- the value-add scan -------------------------------------------------

test('value-add hits carry the evidence that produced them', () => {
  // It is self-declared and gameable. The defence is not to hide it but
  // to hand the manager the text the person actually wrote, so the
  // claim is read rather than counted.
  const entries = [
    e({ item_id: 'A', item_name: 'Automation of the nightly run', hours: 5 }),
    e({ item_id: 'B', item_name: 'Routine ticket', hours: 5 }),
  ];
  const v = m.valueAdd(entries, ['automation', 'patent']);
  assert.equal(v.hours, 5);
  assert.equal(v.entries, 1);
  assert.equal(v.hits.length, 1);
  assert.equal(v.hits[0].keyword, 'automation');
  assert.deepEqual(v.hits[0].examples, ['Automation of the nightly run']);
  // No words configured is not "everything matches".
  assert.deepEqual(m.valueAdd(entries, []).hits, []);
});

test('nothing logged produces zeroes and no crash', () => {
  const r = m.attribute([], KRAS, []);
  assert.equal(r.items.length, 0);
  assert.equal(r.totals.logged, 0);
  assert.equal(r.totals.mapped_pct, 0, 'not NaN');
  assert.equal(r.by_kra.length, 3, 'the KRAs are still listed, at zero');
});
