// node --test — migration 056 must be able to run on a database that
// already has tenants.
//
// THE INCIDENT (customer server, 28 Sep). A deploy upgrading from a
// pre-056 build failed on boot:
//
//   MIGRATION FAILED — refusing to continue
//   column "audience_kind" of relation "survey_templates" does not exist
//
// 057 introduced audience_kind AND reached back to teach 056's shared
// seedTemplates() to write it. The helper is called from 057 and from
// the runtime too, so it tracks the newest schema while 056 runs
// against the oldest: 056 inserted into a column it never created.
//
// WHY 997 GREEN TESTS SAID NOTHING, AND WHY THIS FILE IS SHAPED THE WAY
// IT IS. No migration inserts a tenant — index.js creates it AFTER
// runMigrations() — so on a fresh database core.tenants is empty when
// 056 runs, its seed loop iterates zero times, and the broken INSERT
// never executes. Every other test file builds precisely that database.
// The bug is invisible to all of them, and would stay invisible to a
// test added to one of them.
//
// So this file builds its OWN database and runs the REAL migrations
// 001..056 in it, inserting a tenant first — the actual deployment
// scenario. That also keeps it hermetic: nothing here can disturb the
// shared test database the rest of the suite shares.
//
// Re-running the migration is not enough on its own to catch this: once
// 057 has run, the column exists and 056 passes whatever it says. The
// tests below therefore assert against a database that has never seen
// 057.
//
// WHAT POISONING THESE FOUR ESTABLISHED, recorded so the next reader
// does not have to redo it:
//
//   remove the ALTER from 056         -> test 2 fails
//   remove the column from its
//     CREATE TABLE                    -> ALL FOUR STILL PASS
//   remove both (the shipped bug)     -> tests 1, 2 and 4 fail
//
// The middle line is not a weak test. The ALTER runs before the seed in
// every shape, so it genuinely covers the CREATE TABLE on its own; the
// column is declared there for the reader's sake, not for behaviour,
// and 056 says as much at that line. Nothing was contorted to make that
// poison bite — a test invented to pin column ORDER would assert
// something no caller depends on.
const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { Pool } = require('pg');

const DIR = path.join(__dirname, '..', 'migrations');
const ADMIN_URL = process.env.DATABASE_URL;
const skip = !ADMIN_URL && 'DATABASE_URL not set — see file header';

// Every scratch database made here, so `after` can drop them even when
// an assertion throws part-way through.
const made = [];

// A scratch database plus a pool onto it. Migrations only ever touch
// the `db` handed to up(), and the one app module they import
// (modules/engagement/templates) is pure data — checked, and the reason
// a foreign pool is safe to pass them.
async function scratchDb(label) {
  const name = `apms_mig056_${label}_${process.pid}_${Date.now()}`;
  const admin = new Pool({ connectionString: ADMIN_URL, ssl: false, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally { await admin.end(); }
  made.push(name);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return new Pool({ connectionString: url.toString(), ssl: false, max: 2 });
}

// The real migrations, in order, up to and including `last`.
async function runUpTo(db, last, beforeLast) {
  await db.query('CREATE SCHEMA IF NOT EXISTS core');
  const files = fs.readdirSync(DIR).filter((f) => /^\d{3}-.*\.js$/.test(f)).sort();
  for (const f of files) {
    const n = Number(f.slice(0, 3));
    if (n > last) break;
    if (n === last && beforeLast) await beforeLast(db);
    await require(path.join(DIR, f)).up(db);
  }
}

after(async () => {
  if (!ADMIN_URL) return;
  const admin = new Pool({ connectionString: ADMIN_URL, ssl: false, max: 1 });
  try {
    for (const name of made) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    }
  } finally { await admin.end(); }
});

test('THE INCIDENT: 056 runs on a database that already has a tenant', { skip }, async () => {
  // This is an upgrade from a pre-056 build: the tenant was created by
  // an earlier boot, so 056's seed loop actually runs. Before the fix
  // this threw 42703 and took the boot down with it.
  const db = await scratchDb('withtenant');
  try {
    await runUpTo(db, 56, async (d) => {
      await d.query(`INSERT INTO core.tenants (name, slug) VALUES ('Acme','acme')`);
    });

    // It did not merely survive — it seeded, which is the half that
    // would silently do nothing if the loop were skipped.
    const n = +(await db.query(`SELECT count(*)::int AS n FROM engagement.survey_templates`)).rows[0].n;
    assert.ok(n > 0, '056 seeded the library for the tenant that already existed');

    // And the column it writes is real, with the same default 057 uses,
    // so a row seeded by either migration means the same thing.
    const col = (await db.query(
      `SELECT data_type, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema='engagement' AND table_name='survey_templates'
          AND column_name='audience_kind'`)).rows[0];
    assert.ok(col, 'audience_kind exists after 056 alone, without 057');
    assert.equal(col.is_nullable, 'NO');
    assert.match(col.column_default, /'self'/);
    const kinds = (await db.query(
      `SELECT DISTINCT audience_kind FROM engagement.survey_templates`)).rows.map((r) => r.audience_kind);
    assert.ok(kinds.every((k) => typeof k === 'string' && k.length),
      `every seeded row has a real audience_kind, got ${JSON.stringify(kinds)}`);
  } finally { await db.end(); }
});

test('056 also runs where the table already exists WITHOUT the column', { skip }, async () => {
  // The other real shape: a server that ran the OLD 056, so the table
  // is there and has no audience_kind. CREATE TABLE IF NOT EXISTS is
  // silent on that database, which is why declaring the column in the
  // CREATE TABLE cannot be the whole fix — the ALTER is what saves it.
  const db = await scratchDb('legacytable');
  try {
    await runUpTo(db, 56, async (d) => {
      await d.query(`INSERT INTO core.tenants (name, slug) VALUES ('Acme','acme')`);
      await d.query(`CREATE SCHEMA IF NOT EXISTS engagement`);
      // The pre-057 definition, copied as it stood.
      await d.query(`CREATE TABLE engagement.survey_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
        key text NOT NULL, category text NOT NULL, title text NOT NULL, description text,
        trigger_type text NOT NULL DEFAULT 'manual', trigger_day integer,
        trigger_window_days integer NOT NULL DEFAULT 7,
        anonymity_default boolean NOT NULL DEFAULT true,
        audience_rule jsonb NOT NULL DEFAULT '{}'::jsonb, questions jsonb NOT NULL,
        blocked_reason text, sort_order integer NOT NULL DEFAULT 100,
        active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, key))`);
      const has = +(await d.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema='engagement' AND table_name='survey_templates'
            AND column_name='audience_kind'`)).rows[0].n;
      assert.equal(has, 0, 'the fixture really is the old shape');
    });

    const has = +(await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='engagement' AND table_name='survey_templates'
          AND column_name='audience_kind'`)).rows[0].n;
    assert.equal(has, 1, '056 back-fills the column onto a table it did not create');
    assert.ok(+(await db.query(`SELECT count(*)::int AS n FROM engagement.survey_templates`)).rows[0].n > 0);
  } finally { await db.end(); }
});

test('a fresh database still works, and 057 is still a no-op over 056', { skip }, async () => {
  // The path that always passed — kept so the fix cannot break it — and
  // then 057 on top, because the two ALTERs must not fight: 057 keeps
  // its own copy to protect installs that already logged 056.
  const db = await scratchDb('fresh');
  try {
    await runUpTo(db, 56);
    assert.equal(+(await db.query(`SELECT count(*)::int AS n FROM core.tenants`)).rows[0].n, 0,
      'no migration creates a tenant — this is what hid the bug');

    await require(path.join(DIR, '057-manager-surveys.js')).up(db);
    const cols = (await db.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='engagement' AND table_name='survey_templates'
          AND column_name='audience_kind'`)).rows[0].n;
    assert.equal(+cols, 1, 'one column, not a conflict');
  } finally { await db.end(); }
});

test('the whole sequence 001..062 runs on a database that has tenants', { skip }, async () => {
  // The end-to-end version of the incident: not just 056, but every
  // migration after it, on the upgrade shape. A later migration with
  // the same defect would be caught here and nowhere else in the suite.
  const db = await scratchDb('fullupgrade');
  try {
    const files = fs.readdirSync(DIR).filter((f) => /^\d{3}-.*\.js$/.test(f)).sort();
    await db.query('CREATE SCHEMA IF NOT EXISTS core');
    for (const f of files) {
      // As soon as core.tenants exists, put a tenant in it — from then
      // on every remaining migration runs the way it does on a server
      // that has been live for months, rather than on an empty box.
      if ((await db.query(`SELECT to_regclass('core.tenants') AS t`)).rows[0].t
          && !+(await db.query(`SELECT count(*)::int AS n FROM core.tenants`)).rows[0].n) {
        await db.query(`INSERT INTO core.tenants (name, slug) VALUES ('Acme','acme')`);
      }
      await require(path.join(DIR, f)).up(db);
    }
    assert.ok(+(await db.query(`SELECT count(*)::int AS n FROM engagement.survey_templates`)).rows[0].n > 0);
  } finally { await db.end(); }
});
