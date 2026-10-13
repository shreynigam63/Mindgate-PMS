// The 9-box grid, rebuilt to the client's build specification (13 Oct).
// The rules are in modules/performance/nine-box-rules.js; this is where
// they keep what they need between calibration and publish, and after.
//
//   nine_box_settings   per cycle: the band limits (3.0 / 4.0), the
//                       competency weight of potential (50%), the nine
//                       box names and actions, the potential questions.
//                       No row means the defaults, or the previous
//                       cycle's settings — see settingsFor().
//   potential_answers   the manager's four potential questions, per
//                       person per cycle.
//   nine_box_overrides  HR's band overrides in calibration. APPEND-ONLY
//                       with a mandatory reason, like rating_adjustments:
//                       "why is this person in that box" always has an
//                       answer. A null to_band takes the axis back to
//                       its computed band.
//   nine_box_placements the box each person was placed in at publish,
//                       with the scores, the bands and the settings that
//                       produced it. One row per person per cycle, so
//                       the movement view reads history rather than the
//                       single current value core.employees holds.
//   nine_box_actions    what publish creates for each box: the PIP link
//                       for (0,0), the development-plan tasks, the
//                       escalation after two cycles in (0,0), the
//                       retention follow-up when a (2,2) drops.
//   succession_pool     everyone placed in (2,2), by department.
//
// pms.top_talent, the cell HR typed by hand, is no longer written or
// read: a placement now comes from the scores, and HR moves it only by
// overriding a band with a reason. The table and its rows stay, as the
// record of the cycles calibrated that way.
//
// PAGES. Managers see their own team's grid (/team/nine-box) and
// Delivery Heads their own departments' (/hod/nine-box). HR's company
// grid moves from pms_hod to pms_admin, because a Delivery Head reached
// the whole company through it.

const PAGES = [
  ['team_nine_box', '/team/nine-box', 'pms_team_eval'],
  ['hod_nine_box', '/hod/nine-box', 'pms_hod'],
];

// Also called at boot — a migration cannot seed a tenant created after it
// runs (see 069 and fresh-tenant-bootstrap.test.js).
async function ensureNineBoxPages(db, tenantId) {
  for (const [page, route, perm] of PAGES) {
    await db.query(
      `INSERT INTO core.page_permission (tenant_id, page, route, required_permission)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, page) DO NOTHING`,
      [tenantId, page, route, perm]);
  }
}

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.nine_box_settings (
    tenant_id         uuid NOT NULL,
    cycle_id          uuid PRIMARY KEY REFERENCES pms.cycles(id) ON DELETE CASCADE,
    mid_from          numeric(3,1) NOT NULL DEFAULT 3.0,
    high_from         numeric(3,1) NOT NULL DEFAULT 4.0,
    competency_weight int NOT NULL DEFAULT 50 CHECK (competency_weight BETWEEN 0 AND 100),
    boxes             jsonb NOT NULL,
    questions         jsonb NOT NULL,
    updated_by        text,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT nine_box_limits CHECK (mid_from >= 1 AND mid_from < high_from AND high_from <= 5)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.potential_answers (
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    answers     jsonb NOT NULL DEFAULT '{}'::jsonb,
    rated_by    uuid REFERENCES core.employees(id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, employee_id)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.nine_box_overrides (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    cycle_id      uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id   uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    axis          text NOT NULL CHECK (axis IN ('performance','potential')),
    from_band     smallint CHECK (from_band BETWEEN 0 AND 2),
    to_band       smallint CHECK (to_band BETWEEN 0 AND 2),
    reason        text NOT NULL CHECK (btrim(reason) <> ''),
    overridden_by text NOT NULL,
    at            timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS nine_box_overrides_person
    ON pms.nine_box_overrides (tenant_id, cycle_id, employee_id, at)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.nine_box_placements (
    tenant_id          uuid NOT NULL,
    cycle_id           uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id        uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    status             text NOT NULL CHECK (status IN ('placed','not_placed')),
    not_placed_reason  text,
    performance_score  numeric(4,2),
    performance_source text,
    competency_score   numeric(4,2),
    questions_score    numeric(4,2),
    potential_score    numeric(4,2),
    potential_partial  boolean NOT NULL DEFAULT false,
    computed_perf_band smallint CHECK (computed_perf_band BETWEEN 0 AND 2),
    computed_pot_band  smallint CHECK (computed_pot_band BETWEEN 0 AND 2),
    perf_band          smallint CHECK (perf_band BETWEEN 0 AND 2),
    pot_band           smallint CHECK (pot_band BETWEEN 0 AND 2),
    overrides          jsonb,
    box_key            text,
    box_name           text,
    legacy_cell        text,
    department         text,
    location           text,
    manager_id         uuid,
    grade              text,
    prev_cycle_id      uuid,
    prev_box_key       text,
    movement           text,
    super50            boolean NOT NULL DEFAULT false,
    settings           jsonb NOT NULL,
    placed_by          text NOT NULL,
    placed_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, employee_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS nine_box_placements_person
    ON pms.nine_box_placements (tenant_id, employee_id, placed_at DESC)`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.nine_box_actions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    box_key     text,
    action_key  text NOT NULL,
    kind        text NOT NULL,
    title       text NOT NULL,
    assignee_id uuid REFERENCES core.employees(id) ON DELETE SET NULL,
    due_date    date,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','superseded')),
    pip_id      uuid,
    created_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    closed_by   text,
    closed_at   timestamptz,
    close_note  text,
    CONSTRAINT nine_box_actions_once UNIQUE (tenant_id, cycle_id, employee_id, action_key)
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS pms.succession_pool (
    tenant_id   uuid NOT NULL,
    cycle_id    uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    department  text,
    readiness   text NOT NULL DEFAULT 'ready_now',
    super50     boolean NOT NULL DEFAULT false,
    added_by    text NOT NULL,
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, employee_id)
  )`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await ensureNineBoxPages(db, id);
    // Only where it still says what 042 seeded: a tenant that chose its
    // own permission for the page keeps it.
    await db.query(
      `UPDATE core.page_permission SET required_permission='pms_admin'
        WHERE tenant_id=$1 AND page='nine_box' AND required_permission='pms_hod'`, [id]);
  }
}

module.exports = { up, ensureNineBoxPages, PAGES };
