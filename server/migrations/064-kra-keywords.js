// 064 — keywords on a KRA.
//
// Phase 1 of the Zoho timesheet rating engine specced on 29 Sep: "Each
// employee's KRA library items must have associated Keywords (e.g. KRA:
// Client Project Delivery -> Keywords: Development, Bug Fixing, Sprint
// Execution, Code Review)." Later phases match logged Zoho task text
// against these; this migration only gives them somewhere to live and a
// way to get there in bulk.
//
// NOTHING SCORES ANYTHING YET. No rating reads these columns. That is
// deliberate: the keywords have to be populated and argued over by HR
// before any number hangs off them, and shipping the store first means
// that work can start now against the 2,360 library rows already on the
// client instance.
//
// TWO PLACES, NOT ONE, and the reason matters:
//
//   pms.kra_library.keywords   the shelf. HR publishes them per
//                              designation, and they are the default
//                              every employee inherits.
//   pms.kras.keywords          the employee's own KRA. Copied from the
//                              shelf when one is picked, then editable
//                              — because a KRA can be written by hand
//                              with no library row behind it at all,
//                              and because one person's "Client
//                              Delivery" genuinely does involve
//                              different task names from another's.
//
// A single table keyed to the library would leave hand-written KRAs
// unmatched forever, and editing the shelf would silently rewrite what
// last month was scored against.
//
// text[] RATHER THAN A CHILD TABLE. The matching runs in JavaScript
// over a month of entries, not in SQL, so the join a child table buys
// is never used; and a keyword list is read and written whole every
// time. A GIN index is added anyway for the one query that does look
// across rows — "which KRAs mention this word" — which is what makes
// the bulk editor's preview possible.
module.exports.up = async (db) => {
  await db.query(`ALTER TABLE pms.kra_library
    ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}'`);
  await db.query(`ALTER TABLE pms.kras
    ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}'`);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_kra_library_keywords
    ON pms.kra_library USING GIN (keywords)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_kras_keywords
    ON pms.kras USING GIN (keywords)`);

  // THE VALUE-ADD LIST IS ORG-WIDE CONFIGURATION, not a property of any
  // one KRA: the spec's A+ trigger scans every task note for the same
  // words whatever the person's role. It lands in the timesheet
  // settings blob that already holds the cycle start day, the
  // thresholds and the holidays, because it is the same kind of thing
  // and the same screen will edit it.
  //
  // SEEDED ONLY WHERE THE KEY IS ABSENT. A tenant who has already
  // curated the list is never overwritten, and one who deliberately
  // emptied it is not refilled on the next deploy — the same rule the
  // survey library and the grade bands follow.
  const SEED = ['automation', 'optimization', 'optimisation', 'critical fix',
    'patent', 'cross-team support', 'process improvement', 'innovation',
    'value addition'];
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await ensureValueAddKeywords(db, id, SEED);
  }
};

// Exported and called at request time as well as here.
//
// The loop above reads core.tenants, which is EMPTY during migrations
// on a fresh database because index.js creates the tenant AFTER
// runMigrations — the trap that cost migration 056 a boot loop and
// migration 063 a silent no-op. The route ensures it instead, so a
// tenant created at any point later still gets the list.
async function ensureValueAddKeywords(db, tenantId, seed) {
  const row = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`,
    [tenantId])).rows[0];
  const v = (row && row.value) || {};
  if (Array.isArray(v.value_add_keywords)) return 0;   // curated already
  const next = { ...v, value_add_keywords: seed || DEFAULT_VALUE_ADD };
  await db.query(
    `INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'timesheet',$2::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`,
    [tenantId, JSON.stringify(next)]);
  return (next.value_add_keywords || []).length;
}

const DEFAULT_VALUE_ADD = ['automation', 'optimization', 'optimisation', 'critical fix',
  'patent', 'cross-team support', 'process improvement', 'innovation', 'value addition'];

module.exports.ensureValueAddKeywords = ensureValueAddKeywords;
module.exports.DEFAULT_VALUE_ADD = DEFAULT_VALUE_ADD;
