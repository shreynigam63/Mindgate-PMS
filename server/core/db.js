const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});
pool.on('error', (e) => logger.error('pg pool error', { error: e.message }));

// Waits for the database to actually accept connections before letting
// boot proceed. Found necessary in practice, not speculatively: a Postgres
// instance freshly created in the SAME Render Blueprint sync as this web
// service is not immediately reachable — the web service can start trying
// to connect (ECONNREFUSED to the internal IP) before the database has
// finished its own initial provisioning, seconds to low minutes earlier.
// This tolerates exactly that narrow, transient "not up yet" window with
// bounded retries (default: up to 60s total) and nothing else — a
// connection that's still refused after that means something is actually
// wrong (bad DATABASE_URL, database genuinely down), and boot still fails
// loudly per this codebase's existing "a broken deploy is not a degraded
// state" philosophy (core/migrate.js), just after giving a normal startup
// race a fair chance first instead of crash-looping through several full
// Node restarts to get there by accident.
//
// retryUntilReachable() is the pure retry/backoff LOGIC, taking the
// actual connectivity check as a callback — this is what's unit-tested
// directly (test/wait-for-database.test.js) with a fake check, so the
// test exercises the real retry code rather than a hand-duplicated copy
// of it. waitForDatabase() is the thin real-pool wrapper index.js calls.
async function retryUntilReachable(checkFn, maxAttempts, delayMs, log) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await checkFn();
      if (attempt > 1) log.info('database reachable', { attempt });
      return;
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      log.warn('database not reachable yet, retrying', { attempt, maxAttempts, error: e.message });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function waitForDatabase(maxAttempts = 15, delayMs = 4000) {
  return retryUntilReachable(() => pool.query('SELECT 1'), maxAttempts, delayMs, logger);
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
  waitForDatabase,
  retryUntilReachable,
};
