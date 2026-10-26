// node --test — the month's average is of the KRA ratings (26 Oct).
import { test } from 'node:test';
import assert from 'node:assert';
import { averageRating, nearestRating, valuesText } from '../src/ratingAverage.js';

const V = [{ label: 'A+', value: 5 }, { label: 'A', value: 4 }, { label: 'B+', value: 3 }, { label: 'B', value: 2 }];

test('five B+ and two A+, by weight, is B+ — the client\'s screen, which read A from the hours', () => {
  const rows = [['B+', 20], ['B+', 15], ['B+', 15], ['A+', 10], ['A+', 10], ['B+', 10], ['B+', 10]]
    .map(([rating, weight]) => ({ rating, weight }));
  assert.deepEqual(averageRating(rows, V), { value: 3.44, rating: 'B+', count: 7 });
});

test('the approver\'s edits move it: B+ B+ B+ A+ B+ B+ B+ with two B is B+, three B is B', () => {
  const two = [['B', 20], ['B', 15], ['B+', 15], ['A+', 10], ['B+', 10], ['B+', 10], ['B+', 10]].map(([rating, weight]) => ({ rating, weight }));
  assert.equal(averageRating(two, V).rating, 'B+');           // (40+30+45+50+30+30+30)/90 = 2.83
  const three = [['B', 20], ['B', 15], ['B', 15], ['B+', 10], ['B+', 10], ['B+', 10], ['B+', 10]].map(([rating, weight]) => ({ rating, weight }));
  assert.equal(averageRating(three, V).rating, 'B');          // (40+30+30+120)/90 = 2.44
});

test('a half goes up; unrated rows are left out; nothing rated is no average', () => {
  assert.equal(nearestRating(3.5, V), 'A');
  assert.equal(averageRating([{ rating: 'A', weight: 10 }, { rating: null, weight: 90 }], V).rating, 'A');
  assert.equal(averageRating([], V), null);
  assert.equal(valuesText(V), 'A+ 5, A 4, B+ 3, B 2');
});
