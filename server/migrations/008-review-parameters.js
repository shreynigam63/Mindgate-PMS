// 008 — 7 Organizational Parameters weighted rating engine (BR-6.2/BR-6.3;
// BRD Fig. 8b). Scoped to ANNUAL cycles only — Mid-Year's separate,
// lighter self+manager rating (BR-5.4) is untouched, and the Mid-Year
// "7-Parameter Pulse Check" (Fig. 7b) is explicitly informational and does
// not feed a score anywhere, so it does not read this table either.
//
// The 7 drivers and their weights match the BRD's own reference
// screenshots exactly (the "BR-6.2 confirmed" banner shown on the Annual
// Review mockup) — these are not a placeholder guess: "Weightage per
// driver = its share of the 45-element engagement framework." My
// Organisation Culture / My Manager / My Organisation each cover 8 of the
// 45 elements (8/45 = 17.78%); My Work / My Senior Leadership / My Career
// & Learning each cover 5 (5/45 = 11.11%); My Team covers 6 (6/45 =
// 13.33%). Sums to exactly 100.00. Still a configurable table, not a
// hardcoded list — HR can adjust it from the Cycles screen if the client
// ever wants to.

const DEFAULT_PARAMETERS = [
  ['My Organisation Culture', 17.78],
  ['My Work', 11.11],
  ['My Manager', 17.78],
  ['My Organisation', 17.78],
  ['My Senior Leadership', 11.11],
  ['My Career & Learning', 11.11],
  ['My Team', 13.33],
];

// New tenants created after this migration ran (i.e. every normal boot of
// a fresh deploy) get the defaults via this, called at boot right after
// tenant resolution — same pattern as migration 002's ensureTenantSeeds().
// Never overwrites a tenant's own configuration if one already exists.
async function ensureDefaultParameters(db, tenantId) {
  const existing = await db.query(`SELECT 1 FROM pms.review_parameters WHERE tenant_id=$1 LIMIT 1`, [tenantId]);
  if (existing.rows.length) return;
  for (let i = 0; i < DEFAULT_PARAMETERS.length; i++) {
    const [name, weight] = DEFAULT_PARAMETERS[i];
    await db.query(
      `INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order) VALUES ($1,$2,$3,$4)`,
      [tenantId, name, weight, (i + 1) * 10]);
  }
}

module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.review_parameters (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    name        text NOT NULL,
    weight_pct  numeric(5,2) NOT NULL,
    sort_order  integer NOT NULL DEFAULT 10,
    active      boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_review_params_tenant ON pms.review_parameters(tenant_id, active, sort_order)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.parameter_scores (
    tenant_id    uuid NOT NULL,
    cycle_id     uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL,
    parameter_id uuid NOT NULL REFERENCES pms.review_parameters(id),
    score        numeric(3,1) NOT NULL,
    scored_by    text NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, employee_id, parameter_id)
  )`);

  const tenants = (await db.query(`SELECT id FROM core.tenants`)).rows;
  for (const t of tenants) await ensureDefaultParameters(db, t.id);
};
module.exports.DEFAULT_PARAMETERS = DEFAULT_PARAMETERS;
module.exports.ensureDefaultParameters = ensureDefaultParameters;
