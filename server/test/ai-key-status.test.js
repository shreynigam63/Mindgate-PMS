// node --test — what the boot line says about the Anthropic key, and what
// it must never say.
//
// Asked for on 5 Oct, after a key rotation: a key that is missing,
// truncated, or still wrapped in the quotes somebody typed into the env
// file does not announce itself. The app boots, every screen works, and
// the first person to discover it is whoever presses an AI button — which
// in this product's life so far has meant somebody mid-demo.
//
// THE TEST THAT CARRIES THE WEIGHT is "never emits the key". Everything
// else here is a convenience; that one is the reason this code is allowed
// to touch a secret at all. A diagnostic that leaks what it diagnoses is
// worse than no diagnostic, because it puts the key in a log aggregator
// that a wider group can read than could ever read the env file.
//
// Pure: no database, no HTTP, no env.
const { test } = require('node:test');
const assert = require('node:assert');
const { apiKeyStatus, logApiKeyStatus } = require('../core/ai');

const REAL = `sk-ant-api03-${'A1b2C3d4'.repeat(12)}-abcdEF`;

// A logger that keeps everything it was handed, so the assertions can look
// at the whole emitted record rather than trust the message string.
function spy() {
  const calls = [];
  const rec = (level) => (msg, meta) => calls.push({ level, msg, meta });
  return { calls, info: rec('info'), warn: rec('warn'), error: rec('error') };
}

test('NEVER EMITS THE KEY — not the value, not a prefix, not a tail', () => {
  for (const raw of [REAL, `"${REAL}"`, `${REAL}\n`, 'sk-ant-short', 'not-a-key-at-all']) {
    const log = spy();
    const status = logApiKeyStatus(log, { ANTHROPIC_API_KEY: raw, AI_MODEL: 'claude-opus-5' });
    const emitted = JSON.stringify({ status, calls: log.calls });

    assert.ok(!emitted.includes(raw), 'the raw value appeared in the output');
    assert.ok(!emitted.includes(raw.trim()), 'the trimmed value appeared in the output');
    // No run of the key long enough to be worth anything, from either end.
    for (const piece of [raw.slice(0, 16), raw.slice(-16)]) {
      if (piece.length === 16) {
        assert.ok(!emitted.includes(piece), `a 16-character run of the key appeared: ${piece}`);
      }
    }
  }
});

test('an absent key is stated plainly, and is not an error', () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: '' }]) {
    const log = spy();
    const status = logApiKeyStatus(log, env);
    assert.equal(status.configured, false);
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].level, 'info', 'no key is a supported configuration, not a fault');
    assert.match(log.calls[0].msg, /503/, 'it says what will happen, not just what is missing');
  }
});

test('a good key logs info, with a fingerprint and no problems', () => {
  const log = spy();
  const status = logApiKeyStatus(log, { ANTHROPIC_API_KEY: REAL, AI_MODEL: 'claude-opus-5' });
  assert.equal(status.configured, true);
  assert.deepEqual(status.problems, []);
  assert.match(status.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(log.calls[0].level, 'info');
  assert.equal(log.calls[0].meta.model, 'claude-opus-5');
});

test('the mistakes people actually make each get named', () => {
  const cases = [
    [`"${REAL}"`,        /wrapped in quotes/],
    [`${REAL}\n`,        /whitespace around it/],
    ['sk-ant-api03-abc', /shorter than any real key/],
    [`${'x'.repeat(60)}`, /does not start with/],
    [`sk-ant-api03-${'a'.repeat(30)} ${'b'.repeat(30)}`, /space or newline inside/],
  ];
  for (const [raw, expected] of cases) {
    const status = apiKeyStatus(raw, 'm');
    assert.ok(status.problems.some((p) => expected.test(p)),
      `${expected} not reported for this input; got: ${JSON.stringify(status.problems)}`);
  }
});

test('a wrong-looking key WARNS and does not stop anything', () => {
  const log = spy();
  const status = logApiKeyStatus(log, { ANTHROPIC_API_KEY: `"${REAL}"` });
  assert.equal(log.calls[0].level, 'warn',
    'warn, not error: AI is optional here and a bad key must not take the PMS down');
  assert.ok(status.problems.length);
  assert.match(log.calls[0].msg, /agentic endpoints will fail/);
});

test('the fingerprint identifies the key without being the key', () => {
  const a = apiKeyStatus(REAL, 'm').fingerprint;
  const again = apiKeyStatus(REAL, 'm').fingerprint;
  const other = apiKeyStatus(REAL.replace(/.$/, 'Z'), 'm').fingerprint;
  assert.equal(a, again, 'same key, same fingerprint — this is what proves a rotation landed');
  assert.notEqual(a, other, 'one character different must change it');
  // And a trailing newline is a DIFFERENT key as far as the API is
  // concerned, so it must read as different here too.
  assert.notEqual(a, apiKeyStatus(`${REAL}\n`, 'm').fingerprint);
});
