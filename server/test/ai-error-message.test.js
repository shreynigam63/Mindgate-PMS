// node --test — what a person is told when the AI call fails, as
// against what the operator is told.
//
// Reported on 28 Sep with a screenshot of an employee's Quarterly
// Connects page. Under their own 1-on-1 notes, in red:
//
//   AI call failed (400): {"type":"error","error":{"type":
//   "invalid_request_error","message":"Your credit balance is too low
//   to access the Anthropic API. Please go to Plans & Billing to
//   upgrade or purchase credits."}
//
// Two faults in one line, and these tests pin both:
//
//   1. the upstream body went straight to a screen, so an employee
//      read the company's billing status
//   2. nothing went to the server log — `journalctl | grep -c "credit
//      balance"` returned 0 while every AI feature on the instance was
//      failing, so the only way anyone found out was a user complaining
//
// Pure: upstreamFailure() takes a status and a body and returns what to
// say and what to record. No network, no database, runs anywhere.
const { test } = require('node:test');
const assert = require('node:assert');
const { upstreamFailure } = require('../core/ai');

// The exact body from the screenshot.
const CREDIT = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' },
});

test('THE REPORTED LEAK: billing never reaches the screen', () => {
  const f = upstreamFailure(400, CREDIT);
  for (const word of ['credit', 'balance', 'billing', 'Billing', 'Plans', 'purchase', 'upgrade', 'Anthropic', 'API']) {
    assert.ok(!f.message.includes(word),
      `the user-facing message still contains "${word}": ${f.message}`);
  }
  // And it does not simply say nothing — it says who can fix it, because
  // retrying will not.
  assert.match(f.message, /administrator/i);
  assert.equal(f.retryable, false, 'nobody should be invited to retry an account problem');
  assert.equal(f.reason, 'account');
});

test('…while the operator still gets the whole truth', () => {
  // The detail is what goes in the log line. Losing it would trade one
  // silent failure for another — which is how this was missed.
  const f = upstreamFailure(400, CREDIT);
  assert.match(f.detail, /credit balance is too low/);
});

test('a raw body that is not JSON is still carried to the log, not dropped', () => {
  const f = upstreamFailure(500, '<html>502 Bad Gateway</html>');
  assert.match(f.detail, /Bad Gateway/);
  assert.equal(f.reason, 'upstream');
  assert.equal(f.retryable, true, 'an upstream blip is worth retrying');
});

test('the message tells you whether waiting will help', () => {
  // A user retrying a misconfiguration forever is its own silent
  // failure, so the two cases must not read the same.
  const busy = upstreamFailure(429, '{"error":{"message":"rate_limit_error"}}');
  assert.equal(busy.retryable, true);
  assert.match(busy.message, /try again/i);

  const broken = upstreamFailure(401, '{"error":{"message":"invalid x-api-key"}}');
  assert.equal(broken.retryable, false);
  assert.match(broken.message, /administrator/i);
  assert.ok(!/try again/i.test(broken.message),
    'a bad key is not fixed by trying again, and must not suggest it');
});

test('an invalid key is never quoted back', () => {
  const f = upstreamFailure(401, '{"error":{"message":"invalid x-api-key: sk-ant-EXAMPLE-not-a-real-key"}}');
  assert.ok(!f.message.includes('sk-ant'), 'the key must not reach a screen');
  assert.equal(f.reason, 'auth');
  // It is in the detail, for the log, which is where an operator needs
  // it to tell a wrong key from a revoked one.
  assert.match(f.detail, /invalid x-api-key/);
});

test('402 is treated as an account problem even without the word "credit"', () => {
  const f = upstreamFailure(402, '{"error":{"message":"payment required"}}');
  assert.equal(f.reason, 'account');
  assert.ok(!/payment/i.test(f.message));
});

test('an unmapped 4xx still says something a person can act on', () => {
  const f = upstreamFailure(404, '{"error":{"message":"model: claude-does-not-exist"}}');
  assert.equal(f.reason, 'bad_request');
  assert.ok(!f.message.includes('claude-does-not-exist'), 'the model name is operator detail');
  assert.match(f.message, /administrator/i);
  assert.match(f.detail, /claude-does-not-exist/);
});

test('every mapped status produces a sentence, never an empty string', () => {
  // A blank message renders as an empty red box — worse than the leak,
  // because it says nothing at all.
  for (const status of [400, 401, 402, 403, 404, 422, 429, 500, 502, 503, 529]) {
    const f = upstreamFailure(status, '');
    assert.ok(f.message && f.message.length > 20, `status ${status} produced: ${JSON.stringify(f.message)}`);
    assert.ok(f.message.trim().endsWith('.'), `status ${status} should read as a sentence`);
    assert.ok(['auth', 'rate_limited', 'account', 'upstream', 'bad_request'].includes(f.reason),
      `status ${status} produced an unknown reason: ${f.reason}`);
  }
});

test('a body with no error.message does not throw', () => {
  // Upstreams change their shapes. Falling over while REPORTING a
  // failure turns a handled error into a 500.
  for (const body of ['', '{}', 'null', '{"error":{}}', '{"not":"what we expected"}']) {
    const f = upstreamFailure(500, body);
    assert.ok(f.message);
    assert.equal(typeof f.detail, 'string');
  }
});
