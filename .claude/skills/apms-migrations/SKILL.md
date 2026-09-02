---
name: apms-migrations
description: How schema changes work in Agentic PMS — in-process file migrations that fail the boot on error, idempotency rules, and the enum/backfill patterns. Use whenever adding or altering tables, columns, indexes or constraints, or when a deploy fails at the migration step.
---

# Agentic PMS Migrations

`server/migrations/NNN-name.js`, each exporting `async up(db)`. The runner (`core/migrate.js`) `require()`s them **in-process** — same module resolution as the server, no child processes. This is a deliberate fix of the AH platform's runner, whose spawned `node <file>` children all died MODULE_NOT_FOUND for months, silently.

Rules:
- **A failed migration fails the boot.** That is correct: schema the code expects but doesn't have is a broken deploy. Fix forward or revert; never "log and continue".
- **Idempotent regardless of tracking** — IF NOT EXISTS everywhere — because a crashed boot may re-run a half-applied file.
- A table that already exists is silently skipped by CREATE TABLE IF NOT EXISTS, so **ensure new columns individually** with ADD COLUMN IF NOT EXISTS even when your CREATE lists them.
- Enum values: ADD VALUE IF NOT EXISTS, outside transactions; compare as ::text.
- Backfills: only unambiguous rows (HAVING COUNT(DISTINCT)=1), only NULL targets, log rowCount.
- ON CONFLICT requires a real constraint — create the unique index in the same migration.
- Never renumber or edit an already-shipped migration; add a new one.
