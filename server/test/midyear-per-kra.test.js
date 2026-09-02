// Per-KRA mid-year scoring (migration 023). Pure — no database.
//
// The rule these pin down is the one the request turned on: the overall
// mid-year rating is DERIVED from the per-KRA ratings and is only assigned
// once every KRA is rated. A half-scored review must report no overall at
// all, rather than an average of the part that happens to be filled in.

const { test } = require('node:test');
const assert = require('node:assert');
const { mergeMidyearEntries, midyearOverall } = require('../modules/performance');

const SCALE = [{ value: 5, label: 'A+' }, { value: 4, label: 'A' }, { value: 3, label: 'B+' }, { value: 2, label: 'B' }, { value: 1, label: 'C' }];
const KRAS = [
  { id: 'k1', title: 'Platform migration', weight: 50 },
  { id: 'k2', title: 'Mentor engineers', weight: 30 },
  { id: 'k3', title: 'Cut p95 latency', weight: 20 },
];

test('overall is withheld until every KRA is rated', () => {
  assert.deepEqual(midyearOverall(KRAS, {}), { overall: null, partial_overall: 0, complete: false, missing: ['k1', 'k2', 'k3'] });

  const two = midyearOverall(KRAS, { k1: { rating: 5 }, k2: { rating: 4 } });
  assert.equal(two.complete, false);
  assert.equal(two.overall, null, 'no overall while a KRA is unrated');
  assert.equal(two.partial_overall, 3.7, 'running average still reported for live display');
  assert.deepEqual(two.missing, ['k3']);
});

test('overall is the weight-weighted average once complete', () => {
  const all = midyearOverall(KRAS, { k1: { rating: 5 }, k2: { rating: 4 }, k3: { rating: 3 } });
  assert.equal(all.complete, true);
  // 5*0.50 + 4*0.30 + 3*0.20 = 2.5 + 1.2 + 0.6
  assert.equal(all.overall, 4.3);

  const flat = midyearOverall(KRAS, { k1: { rating: 4 }, k2: { rating: 4 }, k3: { rating: 4 } });
  assert.equal(flat.overall, 4, 'uniform ratings average to themselves regardless of weights');
});

test('weighting actually matters — the same grades in different slots differ', () => {
  // One 5 among 3s. Put it on the 50% KRA, then on the 20% KRA. A flat
  // average would give 3.67 both times; a weighted one must not.
  const onHeavy = midyearOverall(KRAS, { k1: { rating: 5 }, k2: { rating: 3 }, k3: { rating: 3 } });
  const onLight = midyearOverall(KRAS, { k1: { rating: 3 }, k2: { rating: 3 }, k3: { rating: 5 } });
  assert.equal(onHeavy.overall, 4);    // 5*.5 + 3*.3 + 3*.2 = 2.5 + 0.9 + 0.6
  assert.equal(onLight.overall, 3.4);  // 3*.5 + 3*.3 + 5*.2 = 1.5 + 0.9 + 1.0
  assert.ok(onHeavy.overall > onLight.overall,
    'the same grade is worth more on a heavier KRA — this is what fails if weights are ignored');
});

test('an average of discrete grades may be fractional, and that is correct', () => {
  const r = midyearOverall(KRAS, { k1: { rating: 4 }, k2: { rating: 3 }, k3: { rating: 5 } });
  assert.equal(r.overall, 3.9); // 2.0 + 0.9 + 1.0
  assert.ok(!SCALE.some((s) => s.value === r.overall), 'lands between scale values — must not be validated against the scale');
});

test('merge validates each rating against the cycle scale, naming the KRA', () => {
  const bad = mergeMidyearEntries({ kras: KRAS, stored: {}, incoming: { k1: { rating: 9 } }, scale: SCALE });
  assert.ok(bad.error, 'off-scale rating rejected');
  assert.match(bad.error, /Platform migration/, 'error names which KRA, not just "rating"');
});

test('merge preserves untouched fields and other KRAs', () => {
  const stored = { k1: { rating: 5, narrative: 'original' }, k2: { rating: 3 } };
  const out = mergeMidyearEntries({ kras: KRAS, stored, incoming: { k1: { narrative: 'edited' } }, scale: SCALE });
  assert.equal(out.entries.k1.rating, 5, 'rating survives a narrative-only edit');
  assert.equal(out.entries.k1.narrative, 'edited');
  assert.deepEqual(out.entries.k2, { rating: 3 }, 'other KRAs untouched');
});

test('merge drops unknown kra_ids rather than storing them', () => {
  const out = mergeMidyearEntries({ kras: KRAS, stored: {}, incoming: { 'not-a-kra': { rating: 5 }, k1: { rating: 4 } }, scale: SCALE });
  assert.deepEqual(Object.keys(out.entries), ['k1'], 'a stale tab cannot write entries for KRAs off the sheet');
});

test('clearing a rating clears the overall again', () => {
  const stored = { k1: { rating: 5 }, k2: { rating: 4 }, k3: { rating: 3 } };
  assert.equal(midyearOverall(KRAS, stored).overall, 4.3);
  const cleared = mergeMidyearEntries({ kras: KRAS, stored, incoming: { k3: { rating: null } }, scale: SCALE });
  assert.equal(cleared.complete, false);
  assert.equal(cleared.overall, null, 'un-rating a KRA must not leave a stale overall behind');
});

test('no KRAs mapped means no derived overall to speak of', () => {
  const r = midyearOverall([], {});
  assert.equal(r.overall, null);
  assert.equal(r.complete, false, 'an empty sheet is not "complete" — the route falls back to a single rating');
});
