// Engagement phase 3: the survey library.
//
// Asked for on 25 Sep: "I would create a Survey Library", so HR picks
// "Day 30 Connect" instead of typing twenty questions — and so the
// point Mindgate made themselves actually holds in practice:
//
//   "The most important point: don't ask the same questions at
//    30/60/90. The employee's questions should evolve with tenure."
//
// A library only makes that true if the different questions are
// already written. Typed by hand, five milestones become five copies
// of whatever HR wrote first.
//
// The rows are DATA, per tenant, editable in place — the house rule is
// that clients configure and never fork. templates.js holds the
// starting set; seedTemplates() inserts only what is missing, so a
// tenant that has edited "Day 30 Connect" keeps their version across
// every future deploy, and a template they deleted stays deleted.
const { TEMPLATES, validateTemplates } = require('../modules/engagement/templates');

async function seedTemplates(db, tenantId) {
  let inserted = 0;
  for (let i = 0; i < TEMPLATES.length; i++) {
    const t = TEMPLATES[i];
    const r = await db.query(
      `INSERT INTO engagement.survey_templates
         (tenant_id, key, category, title, description, trigger_type, trigger_day,
          trigger_window_days, anonymity_default, audience_rule, questions, blocked_reason,
          sort_order, audience_kind)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'manual'),$7,COALESCE($8,7),COALESCE($9,true),
               COALESCE($10,'{}'::jsonb),$11,$12,$13,COALESCE($14,'self'))
       ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
      [tenantId, t.key, t.category, t.title, t.description || null, t.trigger_type || null,
       t.trigger_type === 'tenure' ? t.trigger_day : null,
       t.trigger_window_days == null ? null : t.trigger_window_days,
       t.anonymity_default, JSON.stringify(t.audience_rule || {}),
       JSON.stringify(t.questions), t.blocked_reason || null, (i + 1) * 10,
       t.audience_kind || null]);
    if (r.rows.length) inserted++;
  }
  // import_only is set SEPARATELY, and only once the column exists.
  //
  // This migration is older than that column — 075 adds it — and the
  // migration runner replays the whole sequence from 001 on a fresh
  // database. Naming the column in the INSERT above made 056 fail on
  // every fresh install, which the replay tests caught: a migration may
  // only reference what the migrations before it have created.
  const hasColumn = (await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='engagement' AND table_name='survey_templates' AND column_name='import_only'`)).rows.length;
  if (hasColumn) {
    for (const t of TEMPLATES.filter((x) => x.import_only === true)) {
      await db.query(
        `UPDATE engagement.survey_templates SET import_only=true WHERE tenant_id=$1 AND key=$2`,
        [tenantId, t.key]);
    }
  }
  return inserted;
}

module.exports.up = async (db) => {
  // A typo in a question reaches everybody the survey is released to,
  // so the content is checked before the table exists. Boot fails here
  // rather than seeding something broken.
  const bad = validateTemplates();
  if (bad.length) throw new Error(`survey templates are invalid:\n  ${bad.join('\n  ')}`);

  await db.query(`CREATE TABLE IF NOT EXISTS engagement.survey_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    key         text NOT NULL,                       -- stable id: 'day_30'
    category    text NOT NULL,                       -- 'Onboarding', 'Engagement', ...
    title       text NOT NULL,
    description text,
    trigger_type text NOT NULL DEFAULT 'manual',     -- manual | tenure
    trigger_day  integer,
    trigger_window_days integer NOT NULL DEFAULT 7,
    anonymity_default boolean NOT NULL DEFAULT true,
    audience_rule jsonb NOT NULL DEFAULT '{}'::jsonb,
    questions   jsonb NOT NULL,
    -- Set when a template is real but cannot be released on this
    -- tenant's data yet. Shown on the picker instead of letting HR
    -- release something that would reach nobody.
    blocked_reason text,
    sort_order  integer NOT NULL DEFAULT 100,
    -- Written here even though the column was introduced by 057,
    -- because seedTemplates() below writes it. See the ALTER after this
    -- statement for the whole story.
    audience_kind text NOT NULL DEFAULT 'self',
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
  )`);
  // WHY THIS IS HERE, AND WHY THE CREATE TABLE ABOVE IS NOT ENOUGH.
  //
  // audience_kind was introduced by 057, which also reached back and
  // taught the shared seedTemplates() below to write it — the helper is
  // called by 057 and by the runtime as well, so it tracks the NEWEST
  // schema while this migration runs against the OLDEST. The result was
  // a migration that inserts into a column it never creates.
  //
  // A fresh database hid it completely: no migration inserts a tenant
  // (index.js creates it AFTER runMigrations), so core.tenants is empty
  // here, the seed loop at the bottom runs zero times and the INSERT
  // never executes. Every test builds exactly that database, which is
  // why a green suite said nothing.
  //
  // An installation UPGRADING from a pre-056 build already has tenants
  // from an earlier boot. There the loop runs, and 056 died with
  //   42703: column "audience_kind" of relation "survey_templates"
  //          does not exist
  // Worse, migrate.js records a migration only after up() returns, so
  // 056 stayed unlogged and every following boot re-ran it and failed
  // again — a permanent boot loop needing hands on the database. Hit on
  // a customer server, 28 Sep.
  //
  // THIS ALTER IS THE HALF THAT DOES THE WORK, and the comment says so
  // because it was measured rather than assumed. Deleting the column
  // from the CREATE TABLE above leaves all four tests in
  // test/migration-056-audience-kind.test.js green — the ALTER runs
  // before the seed in every case, including the one where the table
  // already exists from the older 056 and CREATE TABLE IF NOT EXISTS is
  // silent. Deleting this ALTER instead fails immediately.
  //
  // The column stays in the CREATE TABLE anyway, and not as decoration:
  // a CREATE TABLE that omitted a column this same file inserts into is
  // the entire bug. A reader should be able to see every column
  // seedTemplates() writes in the table definition, without knowing
  // that a later migration exists. The cost is that a fresh database
  // gets the column mid-table and an upgraded one gets it appended —
  // immaterial, since nothing here selects by position.
  //
  // The DEFAULT matches 057's, so a row seeded by either migration
  // means the same thing. 057 keeps its own copy of this ALTER: it is
  // idempotent, and it is what protects an installation that already
  // logged 056.
  await db.query(`ALTER TABLE engagement.survey_templates
    ADD COLUMN IF NOT EXISTS audience_kind text NOT NULL DEFAULT 'self'`);

  await db.query(`CREATE INDEX IF NOT EXISTS idx_survey_templates_tenant
    ON engagement.survey_templates (tenant_id, active, sort_order)`);

  // Which template a survey came from, so "how many Day 30 Connects
  // have we run" has an answer and an edited copy can still be traced
  // back to the library row it started as.
  await db.query(`ALTER TABLE engagement.surveys
    ADD COLUMN IF NOT EXISTS template_key text`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await seedTemplates(db, id);
  }
};

module.exports.seedTemplates = seedTemplates;
