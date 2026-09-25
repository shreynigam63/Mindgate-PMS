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
          trigger_window_days, anonymity_default, audience_rule, questions, blocked_reason, sort_order)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'manual'),$7,COALESCE($8,7),COALESCE($9,true),
               COALESCE($10,'{}'::jsonb),$11,$12,$13)
       ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
      [tenantId, t.key, t.category, t.title, t.description || null, t.trigger_type || null,
       t.trigger_type === 'tenure' ? t.trigger_day : null,
       t.trigger_window_days == null ? null : t.trigger_window_days,
       t.anonymity_default, JSON.stringify(t.audience_rule || {}),
       JSON.stringify(t.questions), t.blocked_reason || null, (i + 1) * 10]);
    if (r.rows.length) inserted++;
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
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
  )`);
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
