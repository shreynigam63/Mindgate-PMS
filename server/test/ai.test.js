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
