// Aspiring Career, split into Short-Term and Long-Term.
//
// Asked for: 'Structure the "Aspiring Career" section into distinct
// Short-Term and Long-Term view tabs.'
//
// The table held ONE aspiration per person — unique on (tenant,
// employee) — so "two tabs" is not a UI change on its own: there was
// nowhere to put the second answer. This adds a horizon to the row and
// moves the uniqueness to (tenant, employee, horizon), which is the
// smallest change that makes two real aspirations storable while leaving
// every existing reader working.
//
// EVERY EXISTING ROW BECOMES SHORT-TERM. That is a guess, but it is the
// safe one: what people have filled in so far is "where I want to go
// next", which the form asked for in one-to-two year terms, and calling
// it long-term would quietly relabel an answer somebody gave to a
// different question. Nothing is lost either way — the employee can move
// it, and both tabs are editable.
//
// Readers that do not know about horizons (the annual review, the team
// overview, the HR pathing matrix) keep seeing the short-term row,
// because that is what they were showing before.

async function up(db) {
  await db.query(`ALTER TABLE people.career_paths
    ADD COLUMN IF NOT EXISTS horizon text NOT NULL DEFAULT 'short_term'`);
  await db.query(`ALTER TABLE people.career_paths
    DROP CONSTRAINT IF EXISTS career_paths_horizon_check`);
  await db.query(`ALTER TABLE people.career_paths
    ADD CONSTRAINT career_paths_horizon_check CHECK (horizon IN ('short_term','long_term'))`);

  // The old uniqueness is what stopped a second aspiration existing.
  // Dropped as a CONSTRAINT first: where it was declared with ADD
  // CONSTRAINT ... UNIQUE, the index is owned by the constraint and
  // Postgres refuses DROP INDEX on it. The DROP INDEX after is for
  // tenants where it was only ever a bare index.
  await db.query(`ALTER TABLE people.career_paths
    DROP CONSTRAINT IF EXISTS uq_career_paths_tenant_employee`);
  await db.query(`DROP INDEX IF EXISTS people.uq_career_paths_tenant_employee`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_career_paths_tenant_employee_horizon
    ON people.career_paths (tenant_id, employee_id, horizon)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_career_paths_horizon
    ON people.career_paths (tenant_id, employee_id, horizon)`);
}

module.exports = { up };
