const { test } = require('node:test');
const assert = require('node:assert');
const { shouldAttribute, enps } = require('../modules/engagement/index');

test('anonymous by default: no attribution even if requested is undefined', () => {
  const s = { anonymity_default: true, allow_attribution_optin: true };
  assert.equal(shouldAttribute(s, undefined), false);
  assert.equal(shouldAttribute(s, false), false);
});

test('opt-in attribution only when survey allows AND respondent asks', () => {
  assert.equal(shouldAttribute({ anonymity_default: true, allow_attribution_optin: true }, true), true);
  assert.equal(shouldAttribute({ anonymity_default: true, allow_attribution_optin: false }, true), false);
});

test('attributed-by-design surveys attribute regardless', () => {
  assert.equal(shouldAttribute({ anonymity_default: false, allow_attribution_optin: false }, false), true);
});

test('eNPS: promoters minus detractors', () => {
  assert.equal(enps([10, 9, 8, 7, 6, 0]), Math.round(((2 - 2) / 6) * 100)); // 0
  assert.equal(enps([9, 9, 10]), 100);
  assert.equal(enps([0, 3, 6]), -100);
  assert.equal(enps([8, 7]), 0);       // all passives
  assert.equal(enps([]), null);
});
