const { test } = require('node:test');
const assert = require('node:assert');
const { parseAiJson, stripRatingSuggestions } = require('../core/ai');

test('parseAiJson: clean, fenced, embedded, garbage', () => {
  assert.deepEqual(parseAiJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseAiJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseAiJson('Here you go:\n{"a":1}\nHope that helps'), { a: 1 });
  assert.equal(parseAiJson('no json at all'), null);
  assert.equal(parseAiJson(''), null);
});

// Regression: the exact malformation seen from POST /agentic/cycle-health
// on a live deploy — the object closes after the third key and the
// remaining keys trail after it at top level. The reply is COMPLETE, not
// truncated, so nothing is lost by recovering it; before this, the whole
// draft fell back to {_unparsed} and every agentic feature returned an
// unusable result.
test('parseAiJson recovers a premature closing brace with keys trailing after it', () => {
  const reply = '{"headline":"Cycle is in publish","bottleneck":"Self-appraisal",' +
    '"chase_this_week":["Engineering: 2 outstanding"]},\n' +
    '"next_phase_blockers":["hod_done is 0"],"caveats":["figures as supplied"]}';
  const out = parseAiJson(reply);
  assert.ok(out, 'should recover rather than return null');
  // every section survives — a partial parse that dropped the trailing
  // keys would be worse than failing, since consumers read named keys
  assert.deepEqual(Object.keys(out).sort(),
    ['bottleneck', 'caveats', 'chase_this_week', 'headline', 'next_phase_blockers']);
  assert.equal(out.headline, 'Cycle is in publish');
  assert.deepEqual(out.next_phase_blockers, ['hod_done is 0']);
  assert.deepEqual(out.caveats, ['figures as supplied']);
});

test('parseAiJson: braces inside strings do not confuse brace matching', () => {
  assert.deepEqual(parseAiJson('{"a":"a } brace","b":2}'), { a: 'a } brace', b: 2 });
  assert.deepEqual(parseAiJson('{"a":"escaped \\" quote }","b":2}'), { a: 'escaped " quote }', b: 2 });
  // trailing prose after a correctly closed object still works
  assert.deepEqual(parseAiJson('{"a":1}\nThat is my answer.'), { a: 1 });
});

test('stripRatingSuggestions removes rating-shaped keys at any depth', () => {
  const dirty = {
    strengths: 'good', suggested_rating: 4, nested: { overall_rating: 5, keep: 'yes' },
    list: [{ score: 3, text: 'ok' }], rating: '4/5',
  };
  const clean = stripRatingSuggestions(dirty);
  assert.equal(clean.suggested_rating, undefined);
  assert.equal(clean.rating, undefined);
  assert.equal(clean.nested.overall_rating, undefined);
  assert.equal(clean.nested.keep, 'yes');
  assert.equal(clean.list[0].score, undefined);
  assert.equal(clean.list[0].text, 'ok');
  assert.equal(clean.strengths, 'good');
});

test('stripRatingSuggestions leaves primitives and arrays intact', () => {
  assert.deepEqual(stripRatingSuggestions(['a', 1, null]), ['a', 1, null]);
  assert.equal(stripRatingSuggestions('text'), 'text');
});
