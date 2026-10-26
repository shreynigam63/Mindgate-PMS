// node --test — the order KRA parameters are shown in (26 Oct).
//
// "order of parameters is wrong, it should be 1. Financial 2. Project
// Process 3. Internal / External Customer 4. People." Pure, no browser:
// every KRA screen groups through byParamOrder.
import { test } from 'node:test';
import assert from 'node:assert';
import { byParamOrder, paramRank } from '../src/paramOrder.js';

test('the four parameters come Financial, Project / Process, Customer, People', () => {
  assert.deepEqual(
    byParamOrder(['Project / Process', 'People', 'Financial', 'Internal / External Customer']),
    ['Financial', 'Project / Process', 'Internal / External Customer', 'People']);
});

test('spelling variants land in the same place', () => {
  assert.deepEqual(
    byParamOrder(['people', 'Customer', 'Project/Process', 'Finance']),
    ['Finance', 'Project/Process', 'Customer', 'people']);
});

test('any other parameter follows the four, in the order it first appears', () => {
  assert.deepEqual(
    byParamOrder(['Innovation', 'People', 'Compliance', 'Financial']),
    ['Financial', 'People', 'Innovation', 'Compliance']);
  assert.equal(paramRank('Innovation'), 4);
});
