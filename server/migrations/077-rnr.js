// Rewards & Recognition.
//
// A schema of its own rather than an extension of people.award_* — that
// is a one-step spot-award feature (nominate, decide) and bending it into
// a four-stage workflow with an eligibility engine and a quota would
// break what is already there for a saving of two tables.
//
// THE SHAPE OF THIS IS DECIDED BY TWO THINGS THE CLIENT SETTLED:
//
//   1. The 3% is ONE CONSOLIDATED CYCLE POOL, which HR then allocates
//      across Junior / Mid / Annual. A per-category 3% would multiply the
//      cap by the number of categories, which is how an organisation
//      accidentally awards 9% of its people.
//
//   2. The eligibility criteria are DATA. Nothing below hard-codes "two
//      years" or "Band 5": the rule engine reads these rows. The client
//      named the overlap themselves — Rising Star is 1–3 years and Buddy
//      Star is 3+ — so experience windows are stored as a half-open
//      interval [min, max), which removes the overlap by construction
//      rather than by whoever edits the rows remembering to.
//
// Two columns on the employee master come with it. Band drives the whole
// Junior/Mid/Senior split and is empty on 4,583 of 4,622 rows today, and
// total professional experience does not exist at all — the master
// carries tenure only. Neither is invented here: they are columns the
// HRMS import has to fill, and until it does, every band-based rule
// correctly resolves to "not eligible, because the band is not on record".

const AWARDS = [
  // key, name, level, frequency, min_exp, max_exp (exclusive), basis, bands, needs_team
  ['wow_machine', 'WOW Machine', 'junior', 'quarterly', 2, null, 'total', null, false],
  ['rising_star', 'Rising Star', 'junior', 'quarterly', 1, 3, 'total', null, false],
  ['buddy_star', 'Buddy Star', 'junior', 'quarterly', 3, null, 'total', null, false],
  ['mountain_mover', 'Mountain Mover', 'mid', 'quarterly', null, null, 'total', null, false],
  ['torchbearer', 'Torchbearer', 'mid', 'quarterly', null, null, 'total', null, false],
  ['future_leader', 'Future Leader', 'mid', 'quarterly', null, null, 'total', null, false],
  ['loyalty_5', 'Loyalty Award — 5 Years', 'all', 'annual', 5, 10, 'tenure', null, false],
  ['loyalty_10', 'Loyalty Award — 10 Years', 'all', 'annual', 10, 15, 'tenure', null, false],
  ['loyalty_15', 'Loyalty Award — 15 Years', 'all', 'annual', 15, null, 'tenure', null, false],
  ['founders_choice', "Founder's Choice Award", 'all', 'annual', null, null, 'total', null, false],
  ['founders_impact', "Founder's Impact Award — Team", 'all', 'annual', null, null, 'total', null, true],
];

const CRITERIA = {
  mountain_mover: 'Exceptional contribution, ownership and measurable business impact.',
  torchbearer: 'Leadership, initiative, and the ability to guide others.',
  future_leader: 'Leadership potential and sustained high performance.',
  founders_choice: "Discretionary. The Founder selects the recipient; no experience rule applies unless HR adds one.",
  founders_impact: 'A team that delivered exceptional or measurable organisational impact.',
};

// Band → level. Editable, because every client bands differently and the
// mapping is the first thing they change.
const BANDS = [
  ['Band 1', 'senior'], ['Band 2', 'senior'],
  ['Band 3', 'mid'], ['Band 4', 'mid'],
  ['Band 5', 'junior'], ['Band 6', 'junior'], ['Band 7', 'junior'],
  ['Band 8', 'junior'], ['Band 9', 'junior'], ['Band 10', 'junior'],
];

// Which employment statuses count as active — the denominator of the 3%,
// and a precondition of every nomination.
const STATUSES = [
  ['active', true], ['probation', true], ['confirmed', true],
  ['resigned', false], ['terminated', false], ['absconded', false],
  ['inactive', false], ['separated', false],
];

const SETTINGS = {
  quota_pct: 3,
  // Round DOWN by default: the cap is a ceiling, and rounding a ceiling
  // up is how a 3% policy quietly becomes 3.4%.
  rounding: 'down',
  min_tenure_months: 6,
  // Whether somebody may hold more than one RnR award in a fiscal year.
  max_awards_per_year: 1,
  senior_in_quarterly: false,
};

async function up(db) {
  await db.query(`CREATE SCHEMA IF NOT EXISTS rnr`);

  // ---- the employee master gains what the rules need ------------------
  await db.query(`ALTER TABLE core.employees
    ADD COLUMN IF NOT EXISTS total_experience_years numeric`);
  await db.query(`COMMENT ON COLUMN core.employees.total_experience_years IS
    'Total professional experience, from the HRMS. Mindgate tenure is computed from date_of_joining and is never stored.'`);

  // ---- masters --------------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS rnr.band_levels (
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id),
    band       text NOT NULL,
    level      text NOT NULL CHECK (level IN ('junior','mid','senior')),
    PRIMARY KEY (tenant_id, band)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS rnr.employment_statuses (
    tenant_id  uuid NOT NULL REFERENCES core.tenants(id),
    status     text NOT NULL,
    is_active  boolean NOT NULL,
    PRIMARY KEY (tenant_id, status)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS rnr.settings (
    tenant_id  uuid PRIMARY KEY REFERENCES core.tenants(id),
    value      jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  // The award master IS the rule engine's input. min/max experience is a
  // HALF-OPEN interval [min, max): 3.0 years is Buddy Star and not Rising
  // Star, by construction rather than by convention.
  await db.query(`CREATE TABLE IF NOT EXISTS rnr.awards (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    key           text NOT NULL,
    name          text NOT NULL,
    level         text NOT NULL CHECK (level IN ('junior','mid','senior','all')),
    frequency     text NOT NULL CHECK (frequency IN ('quarterly','half_yearly','annual')),
    min_experience_years numeric,
    max_experience_years numeric,
    experience_basis text NOT NULL DEFAULT 'total' CHECK (experience_basis IN ('total','tenure')),
    min_tenure_months integer,
    bands         text[],
    criteria      text,
    award_value_paise bigint,
    needs_justification boolean NOT NULL DEFAULT true,
    -- A loyalty milestone is a fact about a date, not an award won
    -- against competition, so it does not consume a slot. See 079.
    counts_towards_quota boolean NOT NULL DEFAULT true,
    is_team       boolean NOT NULL DEFAULT false,
    discretionary boolean NOT NULL DEFAULT false,
    active        boolean NOT NULL DEFAULT true,
    sort_order    integer NOT NULL DEFAULT 100,
    CONSTRAINT rnr_award_window CHECK (
      min_experience_years IS NULL OR max_experience_years IS NULL
      OR max_experience_years > min_experience_years)
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rnr_awards_key ON rnr.awards (tenant_id, key)`);

  await db.query(`CREATE TABLE IF NOT EXISTS rnr.cycles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES core.tenants(id),
    name            text NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('quarterly','half_yearly','annual')),
    period_label    text,
    nominations_open  date NOT NULL,
    nominations_close date NOT NULL,
    approval_deadline date,
    award_date        date,
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','open','closed','finalised')),
    -- The denominator is FROZEN when the cycle opens. Headcount moves
    -- daily; a quota recomputed on every read would let the cap drift
    -- under the people approving against it.
    active_headcount integer,
    quota_pct        numeric,
    quota_total      integer,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rnr_cycle_window CHECK (nominations_close >= nominations_open)
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_rnr_cycles_name ON rnr.cycles (tenant_id, name)`);

  // HR's split of the one pool. Nothing forces the parts to sum to the
  // whole — an under-allocated cycle is a decision, not an error — but
  // over-allocation is refused by the quota engine.
  await db.query(`CREATE TABLE IF NOT EXISTS rnr.cycle_allocations (
    tenant_id uuid NOT NULL REFERENCES core.tenants(id),
    cycle_id  uuid NOT NULL REFERENCES rnr.cycles(id) ON DELETE CASCADE,
    level     text NOT NULL CHECK (level IN ('junior','mid','senior','all')),
    slots     integer NOT NULL CHECK (slots >= 0),
    PRIMARY KEY (cycle_id, level)
  )`);

  // ---- nominations ----------------------------------------------------
  await db.query(`CREATE TABLE IF NOT EXISTS rnr.nominations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    cycle_id      uuid NOT NULL REFERENCES rnr.cycles(id) ON DELETE CASCADE,
    award_id      uuid NOT NULL REFERENCES rnr.awards(id),
    employee_id   uuid REFERENCES core.employees(id),
    nominated_by  uuid NOT NULL REFERENCES core.employees(id),
    achievement   text,
    business_impact text,
    justification text,
    comments      text,
    -- Team awards name a team instead of one person.
    team_name     text,
    team_members  text,
    project       text,
    quantified_impact text,
    status        text NOT NULL DEFAULT 'draft',
    -- The snapshot the approvers see and the auditor reads back: what was
    -- true WHEN IT WAS SUBMITTED. Recomputing it later would rewrite the
    -- grounds a decision was taken on.
    eligibility_snapshot jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rnr_nomination_subject CHECK (employee_id IS NOT NULL OR team_name IS NOT NULL)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_rnr_nominations_cycle
    ON rnr.nominations (tenant_id, cycle_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_rnr_nominations_employee
    ON rnr.nominations (tenant_id, employee_id)`);

  // Every action, in order. "Why did this person get an award" has to
  // have a queryable answer — the house rule, applied here.
  await db.query(`CREATE TABLE IF NOT EXISTS rnr.events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    nomination_id uuid NOT NULL REFERENCES rnr.nominations(id) ON DELETE CASCADE,
    actor_email   text NOT NULL,
    actor_role    text,
    action        text NOT NULL,
    from_status   text,
    to_status     text,
    comment       text,
    at            timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_rnr_events_nomination
    ON rnr.events (nomination_id, at)`);

  // An approval past the cap is possible, and never silent.
  await db.query(`CREATE TABLE IF NOT EXISTS rnr.quota_overrides (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES core.tenants(id),
    cycle_id      uuid NOT NULL REFERENCES rnr.cycles(id) ON DELETE CASCADE,
    nomination_id uuid REFERENCES rnr.nominations(id) ON DELETE CASCADE,
    reason        text NOT NULL,
    approver_email text NOT NULL,
    at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT rnr_override_reason CHECK (btrim(reason) <> '')
  )`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await seedFor(db, id);
  }
}

/**
 * Seeded at request time as well as here: index.js creates the tenant
 * AFTER migrations run, so a fresh install would otherwise have an RnR
 * module with no awards and no band mapping in it.
 */
async function seedFor(db, tenantId) {
  for (const [band, level] of BANDS) {
    await db.query(`INSERT INTO rnr.band_levels (tenant_id, band, level) VALUES ($1,$2,$3)
                    ON CONFLICT DO NOTHING`, [tenantId, band, level]);
  }
  for (const [status, isActive] of STATUSES) {
    await db.query(`INSERT INTO rnr.employment_statuses (tenant_id, status, is_active) VALUES ($1,$2,$3)
                    ON CONFLICT DO NOTHING`, [tenantId, status, isActive]);
  }
  await db.query(`INSERT INTO rnr.settings (tenant_id, value) VALUES ($1,$2::jsonb)
                  ON CONFLICT DO NOTHING`, [tenantId, JSON.stringify(SETTINGS)]);
  let i = 0;
  for (const [key, name, level, frequency, minE, maxE, basis, bands, team] of AWARDS) {
    i += 10;
    await db.query(
      `INSERT INTO rnr.awards (tenant_id, key, name, level, frequency, min_experience_years,
         max_experience_years, experience_basis, bands, criteria, is_team, discretionary,
         sort_order, counts_towards_quota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
      [tenantId, key, name, level, frequency, minE, maxE, basis, bands,
       CRITERIA[key] || null, team, key === 'founders_choice', i, !key.startsWith('loyalty_')]);
  }
}

module.exports = { up, seedFor, AWARDS, BANDS, STATUSES, SETTINGS, CRITERIA };
