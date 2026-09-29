// 063 — the calibration kitty: budget, pools, and per-employee allocation.
//
// Asked for on 29 Sep, as a spec for the Calibration page: a salary
// bracket filter, a real-time kitty panel, per-grade increment ranges,
// three special pools (retention / market correction / promotion), and
// an interactive grid that computes a revised CTC per person.
//
// WHAT ALREADY EXISTED, AND IS REUSED RATHER THAN REBUILT. Migration 030
// brought pms.compensation (effective-dated CTC) and pms.increment_matrix
// (rating range -> standard hike %), plus the increment simulation over
// them. The bell-curve targets are already on pms.cycles.bell_curve at
// 5/15/35/30/15, which is exactly the split the spec asks for, and the
// A+/A/B+/B/C <-> 5/4/3/2/1 ladder is already in grade.js. Building a
// second increment engine beside those would give the client two answers
// to "what is this person getting", so this migration adds only what is
// genuinely missing and hangs it off the existing policy tables.
//
// THREE DECISIONS, CONFIRMED WITH THE CLIENT ON 29 SEP, because each one
// changes the arithmetic and guessing would mean rebuilding:
//
//   1. The retention / market / promotion pools sit ON TOP of the main
//      kitty, not carved out of it. Each has its own remaining-budget
//      counter, so overspending promotions cannot silently eat the
//      standard-hike pot.
//   2. Total proposed hike INCLUDES retention. The employee's actual new
//      salary is the only figure that matters to them, so the column must
//      not understate it — retention still draws on its own pool for
//      budget tracking.
//   3. A resigned employee whose retention is NOT approved gets zero and
//      is excluded from the kitty spend. They stay in the rating
//      distribution, because they were still rated.
//
// MONEY COLUMNS ARE numeric, NEVER float. Paise are the unit in the
// calculation module; the database keeps exact decimals.
module.exports.up = async (db) => {
  // ---- the fact of a resignation -----------------------------------------
  //
  // The retention bucket needs to know who is leaving, and the employee
  // master is where that belongs — not a per-cycle flag somebody ticks by
  // hand for 1,427 people. The CSV importer has ALWAYS parsed
  // resignation_date and last_working_date (core/employees.js) and then
  // thrown them away with a warning; these columns are where they now
  // land, so one upload answers "who is on notice" for the whole company.
  //
  // Nullable and un-defaulted: no date means not resigned, which is the
  // honest reading of a master that has never carried the column.
  await db.query(`ALTER TABLE core.employees
    ADD COLUMN IF NOT EXISTS resignation_date date,
    ADD COLUMN IF NOT EXISTS last_working_date date`);

  // ---- the target increment RANGE per band -------------------------------
  //
  // The matrix already holds one increment_pct per rating band, which is
  // the standard hike actually applied. The spec also wants a range shown
  // beside it ("A+ : 15% - 20%") so a calibration session can see how far
  // a band may legitimately stretch before it is an exception.
  //
  // Added to the EXISTING matrix rather than a new table: a second table
  // of per-grade percentages would drift from this one, and then two
  // screens would disagree about what an A is worth. Nullable, so a
  // tenant that has only ever set a single pct keeps working and the page
  // simply shows no range.
  await db.query(`ALTER TABLE pms.increment_matrix
    ADD COLUMN IF NOT EXISTS increment_pct_min numeric(5,2),
    ADD COLUMN IF NOT EXISTS increment_pct_max numeric(5,2)`);

  // ---- the kitty, per cycle ----------------------------------------------
  //
  // Per cycle, not standing: a kitty is approved for one appraisal round.
  // Last year's 8% must not silently become this year's.
  //
  // bracket_threshold is a COLUMN and not a constant, because "> 50 lakhs"
  // is this client's number this year. The house rule is that thresholds
  // live in tables so a client reconfigures instead of forking.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.calibration_budget (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL,
    cycle_id          uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    -- The approved incremental kitty, as a % of the total CTC pool. The
    -- rupee value is DERIVED from it and the population, never stored:
    -- storing both means they disagree the moment anyone's salary changes.
    kitty_pct         numeric(5,2) NOT NULL DEFAULT 0 CHECK (kitty_pct >= 0 AND kitty_pct <= 100),
    -- The salary bracket splitter. 50 lakhs = 5000000.
    bracket_threshold numeric(14,2) NOT NULL DEFAULT 5000000 CHECK (bracket_threshold > 0),
    -- The three dedicated pools, as absolute amounts. Absolute rather
    -- than a % because they are negotiated as a rupee figure ("we have
    -- 40 lakhs for retention"), and a % of a moving CTC pool would drift.
    retention_pool    numeric(16,2) NOT NULL DEFAULT 0 CHECK (retention_pool >= 0),
    market_pool       numeric(16,2) NOT NULL DEFAULT 0 CHECK (market_pool >= 0),
    promotion_pool    numeric(16,2) NOT NULL DEFAULT 0 CHECK (promotion_pool >= 0),
    currency          text NOT NULL DEFAULT 'INR',
    updated_by        text,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cycle_id)
  )`);

  // ---- what each person is being given -----------------------------------
  //
  // One row per employee per cycle, created lazily on first edit. Absent
  // means "nothing decided yet", which reads as the matrix standard and
  // zero everywhere else — not as a decision to give somebody nothing.
  //
  // standard_pct IS NULLABLE ON PURPOSE. NULL means "whatever the matrix
  // says for their rating", so a later change to the matrix flows through
  // to everyone who has not been touched. A number means HR overrode it
  // for this person, and standard_reason is then required by the route —
  // same discipline as pms.increment_overrides, and the same reason: "why
  // did this person get 14% when the band says 8%" is the first question
  // asked of any compensation round.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.calibration_allocations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL,
    cycle_id            uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id         uuid NOT NULL,

    standard_pct        numeric(5,2) CHECK (standard_pct IS NULL OR standard_pct >= 0),
    standard_reason     text,

    market_pct          numeric(5,2) NOT NULL DEFAULT 0 CHECK (market_pct >= 0),
    market_reason       text,

    promoted            boolean NOT NULL DEFAULT false,
    proposed_designation text,
    proposed_band       text,
    promotion_pct       numeric(5,2) NOT NULL DEFAULT 0 CHECK (promotion_pct >= 0),
    promotion_reason    text,

    -- Retention applies only to somebody who is leaving. The route
    -- refuses it for anyone with no resignation date, rather than
    -- letting a retention payment be quietly booked against a person who
    -- never resigned.
    retention_approved  boolean NOT NULL DEFAULT false,
    retention_pct       numeric(5,2) NOT NULL DEFAULT 0 CHECK (retention_pct >= 0),
    retention_lumpsum   numeric(14,2) NOT NULL DEFAULT 0 CHECK (retention_lumpsum >= 0),
    retention_reason    text,

    updated_by          text,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cycle_id, employee_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_calibration_alloc_cycle
    ON pms.calibration_allocations (tenant_id, cycle_id)`);

  // ---- a starting matrix, only where there is none ------------------------
  //
  // The client instance has 1,427 employees and ZERO matrix bands, so the
  // page would open with every standard hike blank and no way to tell a
  // missing policy from a zero one. These are the spec's own example
  // ranges, seeded as DATA that HR edits on the Increment Simulation
  // screen — not constants in code.
  //
  // Seeded per tenant and ONLY when that tenant has no standing bands at
  // all, so a client who has configured their own is never overwritten,
  // and one they deliberately emptied is not refilled on the next deploy…
  // which is the same rule the survey library follows.
  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await ensureBands(db, id);
  }
};

// ONE DECIMAL PLACE, because rating_min/rating_max are numeric(3,1).
//
// Written as 4.49 first, which the column silently rounded to 4.5 — and
// since band ranges are INCLUSIVE at both ends, A (3.5-4.5) then
// overlapped A+ (4.5-5.0) and a rating of exactly 4.5 matched two
// bands. validateMatrix exists to reject precisely that, so the seeded
// matrix would have been refused the first time HR opened the
// Increment Simulation page and pressed save. Caught by reading the
// rows back out of the database rather than trusting the literals.
const GRADES = [
  { label: 'A+', min: 4.5, max: 5.0, lo: 15, hi: 20 },
  { label: 'A', min: 3.5, max: 4.4, lo: 10, hi: 14 },
  { label: 'B+', min: 2.5, max: 3.4, lo: 7, hi: 9 },
  { label: 'B', min: 1.5, max: 2.4, lo: 4, hi: 6 },
  { label: 'C', min: 0, max: 1.4, lo: 0, hi: 0 },
];

// EXPORTED AND CALLED AT RUNTIME, not only from up() above.
//
// The loop in up() iterates core.tenants — which is EMPTY during
// migrations on a fresh database, because index.js creates the tenant
// AFTER runMigrations(). So on a brand-new install this seeds nothing
// at all, and the calibration page opens with no grades and no way to
// tell a missing policy from a deliberate one.
//
// That is the same shape as the bug found in migration 056 on 28 Sep,
// which cost a customer a boot loop; it is silent here rather than
// fatal, which is arguably worse. The fix is the one the engagement
// library already uses: the route ensures the rows exist, so a tenant
// created at any point after this migration ran still gets them.
//
// Inserts only what is MISSING, and only when the tenant has no
// standing bands at all — a client who configured their own is never
// overwritten, and one they deliberately emptied is not refilled on
// the next deploy.
async function ensureBands(db, tenantId) {
  const has = +(await db.query(
    `SELECT count(*)::int AS n FROM pms.increment_matrix WHERE tenant_id=$1 AND cycle_id IS NULL`,
    [tenantId])).rows[0].n;
  if (has) return 0;
  let order = 0;
  for (const g of GRADES) {
    await db.query(
      `INSERT INTO pms.increment_matrix
         (tenant_id, cycle_id, label, rating_min, rating_max, increment_pct,
          increment_pct_min, increment_pct_max, sort_order, updated_by)
       VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,'migration 063')`,
      // The applied standard is the MIDPOINT of the range: defensible,
      // inside the band by construction, and obviously a starting point
      // rather than a number anyone will mistake for a decision.
      [tenantId, g.label, g.min, g.max, (g.lo + g.hi) / 2, g.lo, g.hi, (order += 10)]);
  }
  return GRADES.length;
}

module.exports.ensureBands = ensureBands;
module.exports.GRADES = GRADES;
