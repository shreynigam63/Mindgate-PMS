// Migration runner — Agentic PMS.
//
// DESIGN LESSON (from the AH platform, found 05-Aug-2026): its runner spawned
// each migration as a bare `node <file>` child process; the files required
// 'pg', which lived only in server/node_modules, so ALL 59 file migrations
// died MODULE_NOT_FOUND, were logged status='failed', and boot continued
// silently for months. This runner therefore:
//   1. require()s migrations IN-PROCESS — same module resolution as the
//      server itself, no child processes, no NODE_PATH games.
//   2. FAILS THE BOOT on a migration error. A schema the code expects but
//      does not have is not a degraded state; it is a broken deploy.
//   3. Tracks in core.migrations_log; re-runs are skipped by filename.
//   4. Each migration exports async up(db) and must be idempotent anyway
//      (IF NOT EXISTS throughout) because a crashed boot may re-run it.
//
// Files: server/migrations/NNN-name.js, ordered lexically.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const logger = require('./logger');

async function runMigrations() {
  await db.query(`CREATE SCHEMA IF NOT EXISTS core`);
  await db.query(`CREATE TABLE IF NOT EXISTS core.migrations_log (
    filename    text PRIMARY KEY,
    ran_at      timestamptz NOT NULL DEFAULT now(),
    duration_ms integer
  )`);

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => /^\d{3}-.*\.js$/.test(f)).sort();
  const done = new Set((await db.query(`SELECT filename FROM core.migrations_log`)).rows.map(r => r.filename));

  for (const f of files) {
    if (done.has(f)) continue;
    const t0 = Date.now();
    const mod = require(path.join(dir, f));
    if (typeof mod.up !== 'function') throw new Error(`${f} does not export up(db)`);
    logger.info(`migration ${f}: running`);
    await mod.up(db);
    await db.query(`INSERT INTO core.migrations_log (filename, duration_ms) VALUES ($1, $2)`, [f, Date.now() - t0]);
    logger.info(`migration ${f}: done`, { ms: Date.now() - t0 });
  }
  return { total: files.length, ran: files.filter(f => !done.has(f)).length };
}

if (require.main === module) {
  runMigrations()
    .then(r => { logger.info('migrations complete', r); process.exit(0); })
    .catch(e => { logger.error('MIGRATION FAILED — refusing to continue', { error: e.message }); process.exit(1); });
}

module.exports = { runMigrations };
