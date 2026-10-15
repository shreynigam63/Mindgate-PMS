// Super 50 benefits (15 Oct, from the client's policy sheet).
//
// Who is Super 50 was already worked out (super50.js). This is what being
// one brings, and for how long:
//
//   super50_policies   one benefits year: the appraisal it is based on, its
//                      dates, the tiers (Super 50 / Super 50 Twice / Elite)
//                      with their amounts and benefits, and the hubs a claim
//                      can be made under. Tiers and hubs are DATA, so HR can
//                      change an amount or a benefit without a release.
//   super50_awards     one person's tier in a policy year, the amount they
//                      may claim, and the IIT/IIM programme they chose.
//   super50_claims     a claim against that amount, with its bill, decided
//                      by HR alone.
//   super50_programmes the IIT/IIM catalogue a Twice or Elite picks from.
//
// The bill is kept in the database, as evidence files are (013): one
// backup holds everything, and a claim's proof cannot outlive the claim.
const PAGES = [
  ['my_super50', '/my/super50', null],
  ['hr_super50_benefits', '/admin/super50-benefits', 'pms_admin'],
];

async function ensureSuper50Pages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`, [tenantId, page, route, perm]);
  }
}

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.super50_policies (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    name          text NOT NULL,
    basis_fiscal_year text NOT NULL,
    basis_year    int NOT NULL,
    starts_on     date NOT NULL,
    ends_on       date NOT NULL,
    tiers         jsonb NOT NULL,
    hubs          jsonb NOT NULL,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    lapse_reminder_days int NOT NULL DEFAULT 30,
    assigned_at   timestamptz,
    created_by    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_on >= starts_on)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS super50_policies_tenant ON pms.super50_policies (tenant_id, status)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.super50_programmes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    policy_id   uuid NOT NULL REFERENCES pms.super50_policies(id) ON DELETE CASCADE,
    name        text NOT NULL,
    provider    text,
    kind        text NOT NULL CHECK (kind IN ('course','refresher')),
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.super50_awards (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    policy_id     uuid NOT NULL REFERENCES pms.super50_policies(id) ON DELETE CASCADE,
    employee_id   uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    tier          text NOT NULL CHECK (tier IN ('super50','twice','elite')),
    streak        int NOT NULL,
    amount        numeric(12,2) NOT NULL CHECK (amount >= 0),
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
    assigned_at   timestamptz NOT NULL DEFAULT now(),
    assigned_by   text NOT NULL,
    notified_at   timestamptz,
    lapse_reminded_at timestamptz,
    programme_id  uuid REFERENCES pms.super50_programmes(id) ON DELETE SET NULL,
    programme_status text CHECK (programme_status IN ('chosen','completed')),
    programme_chosen_at timestamptz,
    programme_completed_at timestamptz,
    UNIQUE (policy_id, employee_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS super50_awards_emp ON pms.super50_awards (tenant_id, employee_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.super50_claims (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    award_id      uuid NOT NULL REFERENCES pms.super50_awards(id) ON DELETE CASCADE,
    employee_id   uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    hub           text NOT NULL,
    item          text,
    description   text,
    amount        numeric(12,2) NOT NULL CHECK (amount > 0),
    bill_name     text NOT NULL,
    bill_mime     text NOT NULL,
    bill_size     int NOT NULL,
    bill_data     bytea NOT NULL,
    status        text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','approved','returned','withdrawn')),
    decided_by    text,
    decided_at    timestamptz,
    decision_note text,
    created_at    timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS super50_claims_award ON pms.super50_claims (tenant_id, award_id, status)`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await ensureSuper50Pages(db, id);
}

module.exports = { up, ensureSuper50Pages, PAGES };
