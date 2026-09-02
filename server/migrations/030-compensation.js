// 030 — compensation, and the increment simulation built on it.
//
// WHY THIS DID NOT EXIST. Asked for a Simulation Report modelling salary
// increments from final ratings and a budget, against a system holding no
// compensation data at all — core.employees has a designation and a role
// band and no money anywhere. So this migration introduces the inputs as
// well as the model.
//
// A NEW PERMISSION, pms_compensation, rather than folding this into
// pms_admin. Salary is more sensitive than anything else in this database:
// a manager with pms_team_eval can already see their reports' ratings and
// must never see their pay, and HR should be able to lose compensation
// access without losing the rest of their role. Seeded to hr and admin,
// because they are who runs a compensation exercise — but as its own
// grant, so revoking it is one row.
//
// THE SIMULATION NEVER WRITES BACK. There is no route, here or anywhere,
// that turns a modelled figure into a stored salary. pms.compensation is
// only ever set by an explicit HR upload. A scenario that could quietly
// become somebody's actual pay is a different and far more dangerous
// feature than the one requested.
module.exports.up = async (db) => {
  // ---- the input: what people are paid today ------------------------------
  // Effective-dated rather than a single mutable column: a raise is a new
  // row, so last year's simulation still reconciles against the salaries
  // that were true when it was run. A mutable column would silently
  // rewrite the history of every past scenario.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.compensation (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    employee_id    uuid NOT NULL,
    annual_ctc     numeric(14,2) NOT NULL CHECK (annual_ctc >= 0),
    currency       text NOT NULL DEFAULT 'INR',
    effective_from date NOT NULL,
    source         text,
    updated_by     text,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, employee_id, effective_from)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_compensation_current
    ON pms.compensation (tenant_id, employee_id, effective_from DESC)`);

  // ---- the policy: what a rating is worth ---------------------------------
  // Ranges, not exact values: a final rating is numeric(3,1) and can be a
  // weighted 4.2, which no exact-match table would ever hit. cycle_id
  // nullable means one standing matrix, with a per-cycle one overriding it
  // when a year needs different numbers.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.increment_matrix (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    cycle_id      uuid REFERENCES pms.cycles(id) ON DELETE CASCADE,
    label         text,
    rating_min    numeric(3,1) NOT NULL,
    rating_max    numeric(3,1) NOT NULL,
    increment_pct numeric(5,2) NOT NULL CHECK (increment_pct >= 0),
    sort_order    integer NOT NULL DEFAULT 10,
    updated_by    text,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (rating_min <= rating_max)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_increment_matrix_scope
    ON pms.increment_matrix (tenant_id, cycle_id)`);

  // ---- the scenarios ------------------------------------------------------
  // Only the INPUTS are stored. The lines are recomputed from them on every
  // read, because the alternative — freezing computed rows — means a
  // scenario silently disagrees with the matrix it claims to use the
  // moment either changes.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.increment_simulations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    cycle_id      uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    name          text NOT NULL,
    budget_amount numeric(16,2),
    scale_to_fit  boolean NOT NULL DEFAULT false,
    notes         text,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cycle_id, name)
  )`);

  // A named exception to the matrix, with the reason it was made. The
  // reason is the point: "why did this person get 14% when the band says
  // 8%" is the first question anyone asks of a compensation round.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.increment_overrides (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    simulation_id uuid NOT NULL REFERENCES pms.increment_simulations(id) ON DELETE CASCADE,
    employee_id   uuid NOT NULL,
    increment_pct numeric(5,2) NOT NULL CHECK (increment_pct >= 0),
    reason        text NOT NULL,
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (simulation_id, employee_id)
  )`);

  // ---- the permission -----------------------------------------------------
  for (const t of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    for (const role of ['hr', 'admin']) {
      await db.query(
        `INSERT INTO core.role_permissions (tenant_id, role, permission)
         VALUES ($1,$2,'pms_compensation') ON CONFLICT DO NOTHING`, [t.id, role]);
    }
  }
};
