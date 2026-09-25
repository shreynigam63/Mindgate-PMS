// Engagement phase 5: from answers to action.
//
// Asked for on 25 Sep, sections 20 to 25:
//
//   "Survey → Score → AI interpretation → Risk → Action → Owner →
//    Follow-up → Closure"
//   "CREATE A RED-FLAG ENGINE"
//   "BUILD A 30/60/90 TREND"
//   "IDENTIFY ONBOARDING FAILURE POINTS"
//   "LINK SURVEY DATA WITH PMS DATA"
//
// Two things are needed before any of that can be computed, and
// neither can be guessed from the question text.
//
// DIMENSION. "Role Clarity 3.2 → 4.0 → 4.5" requires knowing which
// questions are role-clarity questions. Matching on wording would
// break the first time HR edits a template — which they are
// explicitly allowed to do — so the dimension is stored on the
// question and travels with it from the library.
//
// FLAG RULES AS DATA. "Low role clarity is amber, intent to leave is
// red" is a threshold, and thresholds live in tables here, never in
// code: a client who wants amber at 3 rather than 2, or who wants
// their own wording on the action, changes a row. Each rule also
// carries the owner and the follow-up interval, which is what turns
// section 20's chain into something with a name and a date on it
// rather than a colour.
//
// No Listening Agent. Explicitly excluded by Mindgate on 25 Sep, and
// nothing here drafts, asks or infers anything — every number below is
// arithmetic over stored answers.
const RULES = [
  // ---- RED: HR intervention -----------------------------------------
  { key: 'intent_to_leave', dimension: 'retention', applies_to: 'enps', comparator: 'lte',
    threshold_num: 3, severity: 'red', label: 'Intent to leave',
    action: 'HR conversation within a week', owner: 'HR', follow_up_days: 7 },
  { key: 'reconsidered_joining', dimension: 'retention', applies_to: 'choice', comparator: 'in',
    match_values: ['Yes'], severity: 'red', label: 'Has reconsidered joining',
    action: 'HR conversation, and read the free-text answer', owner: 'HR', follow_up_days: 7 },
  { key: 'wrong_decision', dimension: 'retention', applies_to: 'choice', comparator: 'in',
    match_values: ['Probably no', 'Definitely no'], severity: 'red',
    label: 'Doubts joining was the right decision',
    action: 'HR conversation before the next milestone', owner: 'HR', follow_up_days: 7 },
  { key: 'significant_concern', dimension: 'manager_assessment', applies_to: 'choice', comparator: 'in',
    match_values: ['Significant'], severity: 'red', label: 'Manager reports a significant concern',
    action: 'Agree a development plan or an exit decision', owner: 'HR + Manager', follow_up_days: 14 },

  // ---- AMBER: manager or HR follow-up --------------------------------
  { key: 'low_role_clarity', dimension: 'role_clarity', applies_to: 'scale', comparator: 'lte',
    threshold_num: 2, severity: 'amber', label: 'Role clarity is low',
    action: 'Manager to restate the role, the KRAs and how they are measured',
    owner: 'Manager', follow_up_days: 14 },
  { key: 'low_manager_support', dimension: 'manager_support', applies_to: 'scale', comparator: 'lte',
    threshold_num: 2, severity: 'amber', label: 'Manager support is low',
    action: 'Agree a regular check-in cadence', owner: 'HR + Manager', follow_up_days: 14 },
  { key: 'productivity_blocker', dimension: 'blocker', applies_to: 'choice', comparator: 'not_in',
    match_values: ['No significant blocker'], severity: 'amber', label: 'A productivity blocker was named',
    action: 'Remove the named blocker', owner: 'Manager', follow_up_days: 14 },
  { key: 'low_productivity', dimension: 'productivity', applies_to: 'scale', comparator: 'lte',
    threshold_num: 2, severity: 'amber', label: 'Not yet productive',
    action: 'Review ramp-up plan and dependencies', owner: 'Manager', follow_up_days: 14 },
  { key: 'training_gap', dimension: 'training', applies_to: 'scale', comparator: 'lte',
    threshold_num: 2, severity: 'amber', label: 'Training is inadequate',
    action: 'Add to the training plan', owner: 'HR', follow_up_days: 30 },
  { key: 'team_integration', dimension: 'team_integration', applies_to: 'scale', comparator: 'lte',
    threshold_num: 2, severity: 'amber', label: 'Not settled into the team',
    action: 'Manager to arrange introductions and a buddy', owner: 'Manager', follow_up_days: 14 },
  { key: 'passive_retention', dimension: 'retention', applies_to: 'enps', comparator: 'between',
    threshold_num: 4, threshold_max: 6, severity: 'amber', label: 'Lukewarm about staying',
    action: 'Manager to ask what would change it', owner: 'Manager', follow_up_days: 30 },
  { key: 'career_unclear', dimension: 'career', applies_to: 'scale', comparator: 'lte',
    threshold_num: 2, severity: 'amber', label: 'Cannot see a path here',
    action: 'Career conversation against the Career Pathing Matrix', owner: 'Manager', follow_up_days: 30 },
];

async function seedFlagRules(db, tenantId) {
  let n = 0;
  for (let i = 0; i < RULES.length; i++) {
    const r = RULES[i];
    const out = await db.query(
      `INSERT INTO engagement.flag_rules
         (tenant_id, key, dimension, applies_to, comparator, threshold_num, threshold_max,
          match_values, severity, label, action, owner, follow_up_days, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
      [tenantId, r.key, r.dimension, r.applies_to, r.comparator, r.threshold_num ?? null,
       r.threshold_max ?? null, r.match_values || null, r.severity, r.label, r.action,
       r.owner, r.follow_up_days, (i + 1) * 10]);
    if (out.rows.length) n++;
  }
  return n;
}

module.exports.up = async (db) => {
  // Which dimension a question measures. NULL is allowed and means
  // "not scored" — an open-text question, or one HR wrote themselves
  // without saying what it is about. Those are still shown; they are
  // simply not part of a dimension average, which is better than
  // guessing and reporting a number nobody can trace.
  await db.query(`ALTER TABLE engagement.questions
    ADD COLUMN IF NOT EXISTS dimension text`);

  await db.query(`CREATE TABLE IF NOT EXISTS engagement.flag_rules (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    key           text NOT NULL,
    dimension     text,                      -- NULL = any dimension
    applies_to    text NOT NULL,             -- scale | enps | choice | multi
    comparator    text NOT NULL,             -- lte | gte | between | in | not_in
    threshold_num numeric,
    threshold_max numeric,                   -- 'between' only
    match_values  text[],                    -- 'in' / 'not_in' only
    severity      text NOT NULL,             -- red | amber
    label         text NOT NULL,
    action        text NOT NULL,             -- what to do about it
    owner         text NOT NULL,             -- who does it
    follow_up_days integer NOT NULL DEFAULT 14,
    active        boolean NOT NULL DEFAULT true,
    sort_order    integer NOT NULL DEFAULT 100,
    UNIQUE (tenant_id, key)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_flag_rules_tenant
    ON engagement.flag_rules (tenant_id, active, sort_order)`);

  // Reading every scored answer for one employee across their
  // milestones is the trend query, and it runs per employee.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_responses_employee
    ON engagement.responses (tenant_id, employee_id) WHERE employee_id IS NOT NULL`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await seedFlagRules(db, id);
  }

  // core.page_permission drives BOTH the nav item and the direct-URL
  // guard from one row, so a page registered in the router and not
  // here is invisible in the menu and reachable by typing the address.
  // Per tenant, and ON CONFLICT DO NOTHING, because once a tenant has
  // a row it is theirs to edit — the same rule as migration 042.
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,'engagement_insights','/admin/engagement-insights','engagement_admin')
       ON CONFLICT (tenant_id, page) DO NOTHING`, [id]);
  }

  // A repair for anything seeded by an earlier run of this migration:
  // the blocker questions were first tagged 'productivity', which put
  // "Still learning" — a productivity LEVEL, not a blocker — at the
  // top of the blocker list. Moved to their own dimension, with the
  // rule that reads them moved with it.
  await db.query(`UPDATE engagement.flag_rules SET dimension='blocker'
                   WHERE key='productivity_blocker' AND dimension='productivity'`);

  // Dimensions onto the LIBRARY ROWS. They were seeded by migration
  // 056, before dimensions existed, so every template a tenant
  // already has carries questions with no dimension — and every
  // survey made from one would be unscoreable. Patched question by
  // question, matched on the prompt, so a tenant's own edits to
  // wording, options or extra questions are left exactly as they are.
  const { TEMPLATES: SHIPPED } = require('../modules/engagement/templates');
  for (const tpl of SHIPPED) {
    const byPrompt = new Map(tpl.questions.filter((q) => q.dimension).map((q) => [q.prompt, q.dimension]));
    if (!byPrompt.size) continue;
    const rows = (await db.query(
      `SELECT id, questions FROM engagement.survey_templates WHERE key=$1`, [tpl.key])).rows;
    for (const row of rows) {
      const qs = Array.isArray(row.questions) ? row.questions : [];
      let changed = false;
      const next = qs.map((q) => {
        if (!byPrompt.has(q.prompt)) return q;
        const want = byPrompt.get(q.prompt);
        if (q.dimension === want) return q;
        changed = true;
        return { ...q, dimension: want };
      });
      if (changed) {
        await db.query(`UPDATE engagement.survey_templates SET questions=$2, updated_at=now() WHERE id=$1`,
          [row.id, JSON.stringify(next)]);
      }
    }
  }

  // Dimensions onto the questions already created from the library.
  // Matched by template key and prompt, which is exact for anything
  // the library produced and simply misses anything hand-written —
  // the honest outcome, since a hand-written question has no declared
  // dimension to recover.
  for (const tpl of SHIPPED) {
    for (const q of tpl.questions) {
      if (!q.dimension) continue;
      await db.query(
        `UPDATE engagement.questions qq SET dimension=$1
           FROM engagement.surveys s
          WHERE qq.survey_id = s.id AND s.template_key = $2
            AND qq.prompt = $3 AND qq.dimension IS DISTINCT FROM $1`,
        [q.dimension, tpl.key, q.prompt]);
    }
  }
};

module.exports.seedFlagRules = seedFlagRules;
module.exports.RULES = RULES;
