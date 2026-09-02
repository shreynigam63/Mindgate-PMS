// node --test — retryUntilReachable() (core/db.js), found necessary after
// a real Render deploy failure: a Postgres database freshly created in
// the same Blueprint sync as the api service is not immediately reachable
// when the service tries to connect at boot. Tests the REAL exported
// retry/backoff logic directly (via dependency injection of the
// connectivity check), not a hand-duplicated copy of it — a regression in
// the actual implementation would be caught here. Runs with no database
// and no env vars needed: core/db.js's Pool is constructed lazily (pg
// doesn't connect at Pool() construction time, only on first query), so
// requiring the module with DATABASE_URL unset is safe as long as nothing
// here actually calls the real pool.query.
const { test } = require('node:test');
const assert = require('node:assert');
const { retryUntilReachable } = require('../core/db');

test('retryUntilReachable: succeeds immediately when the check passes first try', async () => {
  let calls = 0;
  const check = async () => { calls++; };
  const logger = { info: () => {}, warn: () => {} };
  await retryUntilReachable(check, 5, 1, logger);
  assert.equal(calls, 1, 'only one attempt needed');
});

test('retryUntilReachable: retries through transient failures and succeeds once reachable', async () => {
  let calls = 0;
  const check = async () => {
    calls++;
    if (calls < 3) throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
  };
  const warnings = [];
  const logger = { info: () => {}, warn: (msg, meta) => warnings.push(meta) };
  await retryUntilReachable(check, 5, 1, logger);
  assert.equal(calls, 3, 'failed twice, succeeded on the third attempt');
  assert.equal(warnings.length, 2, 'logged a warning for each failed attempt');
  assert.equal(warnings[0].attempt, 1);
  assert.equal(warnings[1].attempt, 2);
});

test('retryUntilReachable: still fails loudly if the database never becomes reachable', async () => {
  const check = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432'); };
  const logger = { info: () => {}, warn: () => {} };
  await assert.rejects(
    () => retryUntilReachable(check, 4, 1, logger),
    (e) => e.message.includes('ECONNREFUSED'),
    'a genuinely broken connection still throws after exhausting retries, not silently swallowed'
  );
});

test('retryUntilReachable: respects maxAttempts exactly (does not retry forever)', async () => {
  let calls = 0;
  const check = async () => { calls++; throw new Error('nope'); };
  const logger = { info: () => {}, warn: () => {} };
  await assert.rejects(() => retryUntilReachable(check, 3, 1, logger));
  assert.equal(calls, 3, 'exactly maxAttempts calls, not one more');
});

test('retryUntilReachable: logs "database reachable" only when a retry was actually needed', async () => {
  let calls = 0;
  const check = async () => { calls++; if (calls < 2) throw new Error('x'); };
  const infoLogs = [];
  const logger = { info: (msg, meta) => infoLogs.push(meta), warn: () => {} };
  await retryUntilReachable(check, 5, 1, logger);
  assert.equal(infoLogs.length, 1);
  assert.equal(infoLogs[0].attempt, 2);
});
