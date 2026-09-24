// 049 — the competency mapping system.
//
// Asked for on 24 Sep, with the client's own workbook attached:
// "Consider 3rd excel sheet for creating employee competency mapping
// system for evaluation self and manager to have complete competency of
// the organization."
//
// The workbook (Employee_Competency_Mapping_Template) has six sheets:
// a Competency Master, an employee self-assessment form, a manager
// assessment, an HR dashboard, an IDP and instructions. This models the
// first four. The IDP is deliberately NOT a fifth planning surface —
// this product already has Target Achievements and Improvement Plans,
// and a third place to write development actions would be the place
// nobody looks. Gaps are surfaced and exported; the action goes where
// actions already go.
//
// FOUR TABLES, and the reason for each:
//
//   competency_scale   the 1-5 wording. In a table, not in code, because
//                      every client re-words it and the house rule is
//                      that labels are data.
//   competencies       the framework itself — category, name, and the
//                      level the organisation expects by default.
//   competency_role_levels
//                      what a SPECIFIC job needs, where that differs.
//                      The master's own Required Level column says
//                      "Role-specific requirement to be confirmed by
//                      manager/HR", so one number for all 1,398 people
//                      would be the wrong answer written confidently.
//                      Scoped designation-first with an optional
//                      department, exactly like the KRA library, so HR
//                      does not learn a second scoping rule.
//   competency_assessments / competency_ratings
//                      one assessment per employee per cycle, holding
//                      both sides. Self and manager are separate
//                      columns on one row rather than two rows: the
//                      whole point is comparing them, and two rows that
//                      can disagree about which competency they are
//                      about is a bug waiting to happen.
//
// The required level is SNAPSHOTTED onto the rating row when the
// assessment is created. Re-levelling a job mid-cycle must not silently
// rewrite the gap somebody was already measured against — the same rule
// the KRA weights follow.
const SCALE = [
  [1, 'Awareness', 'Basic understanding'],
  [2, 'Developing', 'Requires support'],
  [3, 'Proficient', 'Independent routine performance'],
  [4, 'Advanced', 'Handles complex situations'],
  [5, 'Expert', 'Mentors / trains others'],
];

// The client's Competency Master, in their order, with their wording
// and their categories. Two names appear in two categories on purpose —
// "Decision-making" and "Stakeholder management" mean different things
// for an individual contributor and for a leader — which is why the
// unique key is (category, name) and not name alone.
// The second number is the sort_order BASE for the category, and the
// gaps are 100 rather than 10 on purpose: with bases of 10/20/30/40 a
// 13-item BEHAVIOURAL block ran 21..33 straight through LEADERSHIP's
// 31..40, so ordering by sort_order interleaved two categories and the
// framework page rendered the same category heading twice.
const CATEGORIES = [
  ['FUNCTIONAL / TECHNICAL COMPETENCY', 100, [
    'Role-specific technical knowledge', 'Industry / domain knowledge', 'Process knowledge',
    'Tools / systems proficiency', 'Data analysis / interpretation', 'Quality & accuracy',
    'Problem solving', 'Project execution', 'Documentation', 'Compliance / policy knowledge']],
  ['BEHAVIOURAL COMPETENCY', 200, [
    'Communication', 'Collaboration', 'Ownership & accountability', 'Adaptability',
    'Learning agility', 'Decision-making', 'Problem-solving', 'Customer orientation',
    'Conflict management', 'Time management', 'Initiative', 'Resilience',
    'Stakeholder management']],
  ['LEADERSHIP COMPETENCY', 300, [
    'Delegation', 'Coaching & mentoring', 'Giving feedback', 'Conflict resolution',
    'Decision-making', 'Team motivation', 'Performance management', 'Strategic thinking',
    'Stakeholder management', 'Change management']],
  ['DIGITAL & FUTURE SKILLS', 400, [
    'Digital tools', 'Data literacy', 'Automation', 'AI literacy', 'Analytical thinking',
    'Digital collaboration', 'Process improvement']],
];

module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.competency_scale (
    tenant_id uuid NOT NULL,
    level int NOT NULL CHECK (level BETWEEN 1 AND 5),
    label text NOT NULL,
    description text,
    PRIMARY KEY (tenant_id, level))`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.competencies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    category text NOT NULL,
    name text NOT NULL,
    description text,
    -- The organisation-wide expectation. A job-specific number lives in
    -- competency_role_levels and wins over this one.
    default_required_level int NOT NULL DEFAULT 3 CHECK (default_required_level BETWEEN 1 AND 5),
    -- LEADERSHIP competencies are not asked of everyone. Rather than a
    -- hardcoded category check in the handler, each competency says for
    -- itself whether it only applies to people who have reports.
    managers_only boolean NOT NULL DEFAULT false,
    sort_order int NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, category, name))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_competencies_tenant
                    ON pms.competencies (tenant_id, active)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.competency_role_levels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    competency_id uuid NOT NULL REFERENCES pms.competencies(id) ON DELETE CASCADE,
    designation text NOT NULL,
    -- NULL department = every department with that job title; a named
    -- one beats it. Same rule as the KRA library's shelves.
    department text,
    required_level int NOT NULL CHECK (required_level BETWEEN 1 AND 5),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, competency_id, designation, department))`);
  // A partial index for the company-wide rows, because a NULL department
  // does not participate in the UNIQUE above — without this, the same
  // designation could be levelled twice company-wide.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_role_levels_anydept
                    ON pms.competency_role_levels (tenant_id, competency_id, designation)
                 WHERE department IS NULL`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.competency_assessments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    cycle_id uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    manager_id uuid REFERENCES core.employees(id),
    self_status text NOT NULL DEFAULT 'not_started',
    self_submitted_at timestamptz,
    manager_status text NOT NULL DEFAULT 'not_started',
    manager_submitted_at timestamptz,
    -- The Employee Form's ROLE UNDERSTANDING block.
    top_responsibilities text,
    critical_outcomes text,
    strongest_areas text,
    challenging_areas text,
    -- ...and its LEARNING, CAREER & DEVELOPMENT block.
    develop_next text,
    preferred_methods text,
    aspiration_2_3_years text,
    next_role_competencies text,
    internal_mobility text,
    support_needed text,
    manager_summary text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cycle_id, employee_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_comp_assess_manager
                    ON pms.competency_assessments (tenant_id, cycle_id, manager_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.competency_ratings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    assessment_id uuid NOT NULL REFERENCES pms.competency_assessments(id) ON DELETE CASCADE,
    competency_id uuid NOT NULL REFERENCES pms.competencies(id) ON DELETE CASCADE,
    -- Snapshotted, so re-levelling a job mid-cycle cannot rewrite the
    -- gap somebody has already been measured against.
    required_level int NOT NULL CHECK (required_level BETWEEN 1 AND 5),
    self_rating int CHECK (self_rating BETWEEN 1 AND 5),
    self_evidence text,
    manager_rating int CHECK (manager_rating BETWEEN 1 AND 5),
    manager_comment text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (assessment_id, competency_id))`);
  // The gap is manager_rating - required_level and is NEVER stored: a
  // derived number kept in a column is a number that can disagree with
  // its inputs.

  // ---- seeds, per tenant, idempotent -------------------------------------
  const tenants = (await db.query(`SELECT id FROM core.tenants`)).rows;
  for (const { id: t } of tenants) {
    for (const [level, label, description] of SCALE) {
      await db.query(
        `INSERT INTO pms.competency_scale (tenant_id, level, label, description)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, level) DO NOTHING`,
        [t, level, label, description]);
    }
    for (const [category, base, names] of CATEGORIES) {
      const leadership = category.startsWith('LEADERSHIP');
      let i = 0;
      for (const name of names) {
        i += 1;
        await db.query(
          `INSERT INTO pms.competencies
             (tenant_id, category, name, default_required_level, managers_only, sort_order, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, category, name) DO NOTHING`,
          [t, category, name, 4, leadership, base + i,
           'Role-specific requirement to be confirmed by manager/HR.']);
        // Repair, not just insert: a tenant seeded while the bases
        // overlapped keeps its rows and gets the right order.
        await db.query(
          `UPDATE pms.competencies SET sort_order=$4, updated_at=now()
            WHERE tenant_id=$1 AND category=$2 AND name=$3 AND sort_order <> $4`,
          [t, category, name, base + i]);
      }
    }
  }
};
