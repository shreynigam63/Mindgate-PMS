// 065 — which logged work item belongs to which KRA.
//
// Phase 2 of the Zoho timesheet rating engine. Phase 1 (064) gave a KRA
// keywords; running the spec's formula over REAL client rows then showed
// keywords alone cannot carry the scoring, and this table is the answer.
//
// WHAT THE REAL EXPORT ACTUALLY LOOKS LIKE. Measured, not assumed, on
// the client's own Zoho Sprints export:
//
//   project_name   1 distinct value   ("UPI 5.0 Product")  ← useless as a key
//   item_id        7 distinct values  (U5P-I58, U5P-I13, …)
//   item_name      7 distinct values  ("GFF Activities", "Tap N Pay", …)
//
// So the unit a human can usefully map is the WORK ITEM, not the
// project: every hour in that export sits under one project, and
// mapping the project would put a person's whole month against a single
// KRA. I had proposed project→KRA; the data says item→KRA, and the data
// wins.
//
// WHY A HUMAN MAPPING AT ALL, when 064 already stores keywords. Because
// the two vocabularies do not overlap. KRAs are outcome statements
// ("Incident analysis", "CSAT Score"); Zoho items are product features
// ("Tap N Pay", "Mandate Table Segregation"). Knowing that Tap N Pay
// serves the delivery KRA is project knowledge in a manager's head and
// no keyword list derives it. Matching keywords against that text
// produced 0% coverage on a month of genuine work, and when I forced a
// match it put 88 hours of delivery under "Training and team Upskill" —
// confidently wrong, which is worse than silent.
//
// A mapping is a fact somebody asserted once and it stays true; the
// keyword pass then only has to catch what nobody has mapped yet.
//
// THREE DECISIONS, NOT TWO. An item maps to a KRA, or is deliberately
// NOT KRA work (internal training, leave cover, admin), or nobody has
// said yet. The middle one has to be storable and distinguishable from
// the last, because excluded hours leave the denominator — otherwise a
// person is marked down for time the company asked them to spend. It
// carries a mandatory note for exactly that reason, and every write is
// audited.
//
// CYCLE-SCOPED, because pms.kras rows are. A KRA belongs to a sheet
// which belongs to a cycle, so next year's sheet has different KRA ids
// and the same item must be mappable again without destroying what last
// year was scored against. Carrying a mapping forward onto a new sheet
// is phase 4's job; this table just makes it possible.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.timesheet_kra_map (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    employee_id   uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    cycle_id      uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    -- The export's item id when it has one, else the lowercased item
    -- name. Lowercased either way, because the same item comes back
    -- spelled differently between months and a case change must not
    -- silently create a second, unmapped item.
    item_key      text NOT NULL,
    -- The last spelling seen, for display. Not part of the key: a
    -- renamed story is the same story.
    item_label    text,
    decision      text NOT NULL DEFAULT 'kra',   -- kra | excluded
    kra_id        uuid REFERENCES pms.kras(id) ON DELETE CASCADE,
    note          text,
    mapped_by_email text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- Enforced here rather than in the handler: a row that says "maps to
    -- a KRA" with no KRA would read as mapped and score as nothing, and
    -- an excluded row carrying a KRA id would double-count.
    CONSTRAINT timesheet_kra_map_decision CHECK (
      (decision = 'kra' AND kra_id IS NOT NULL) OR
      (decision = 'excluded' AND kra_id IS NULL)),
    UNIQUE (tenant_id, employee_id, cycle_id, item_key))`);

  // The only read shape: one person, one cycle, every mapping they have.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_kra_map_emp
    ON pms.timesheet_kra_map (tenant_id, employee_id, cycle_id)`);
  // And the one write shape that is not by key: dropping a KRA from a
  // sheet has to take its mappings with it, which the FK does.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_kra_map_kra
    ON pms.timesheet_kra_map (kra_id)`);

  // Item text is what the keyword pass reads, and every read filters by
  // employee and date first, so no index is added for it: the rows for
  // one person for one month are tens, not thousands.

  // ---- IS THIS KRA EXPECTED TO SHOW UP IN A TIMESHEET AT ALL --------
  //
  // Added after the first run of the engine over real rows exposed a
  // metric that was quietly vacuous. "Weighted coverage" was computed
  // over the KRAs that COULD be scored, and a KRA counted as scorable
  // once something had been mapped to it — so it became scorable by
  // receiving hours, and coverage came out at 100% whenever anything at
  // all was mapped. One hour against one of three equally weighted KRAs
  // reported full coverage. A metric that cannot fall is not a metric.
  //
  // So it is a DECLARATION, not an inference, and it defaults to TRUE:
  // every KRA is expected to be visible in a timesheet until a human
  // says otherwise. Opting out is the rare case and the deliberate one
  // — "CSAT Score" is measured from quarterly client feedback and
  // nobody will ever log an hour named after it, so counting it as an
  // uncovered zero every month would mark good people down forever.
  //
  // BOTH TABLES, for the same reason 064 put keywords in both: the
  // shelf carries the default HR publishes per designation, and the
  // employee's own KRA carries what actually applies to them.
  for (const t of ['pms.kra_library', 'pms.kras']) {
    await db.query(`ALTER TABLE ${t}
      ADD COLUMN IF NOT EXISTS timesheet_tracked boolean NOT NULL DEFAULT true`);
    // Why it was opted out. Blank is fine while the default holds; the
    // route demands one when somebody turns it off, because "this KRA
    // is invisible to the engine" is exactly the kind of decision that
    // needs to survive the person who made it.
    await db.query(`ALTER TABLE ${t}
      ADD COLUMN IF NOT EXISTS timesheet_untracked_reason text`);
  }

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) {
    await ensureScoringSettings(db, id);
  }
};

// THE SCORING SETTINGS, seeded beside the compliance thresholds that
// already live in this blob (cycle start day, green/amber, holidays,
// and 064's value-add words) because it is the same kind of thing and
// the same screen edits it. Thresholds and labels in a table, never in
// code — the house rule, and the reason a client can retune this without
// a release.
//
// auto_score IS OFF, and that is the whole point. Phase 2 ships as
// COVERAGE REPORTING: it says how many of a person's logged hours are
// mapped to a KRA and how that effort compares with the KRA weights. It
// issues no letter grade, because on today's data 87% of hours are
// unmapped and a grade computed on that would only produce arguments.
// Turning it on is one settings change once the mapping has settled —
// deliberately a decision somebody makes, not a default they inherit.
const DEFAULT_SCORING = {
  auto_score: false,
  // The spec's 50/30/20. Kept as data so the weights argued over with
  // the client are visible and changeable rather than buried in a
  // function.
  weight_coverage: 50,
  weight_compliance: 30,
  weight_value_add: 20,
  // Below this, the mapping is too thin for any score to mean anything,
  // and the engine says so instead of producing a number. 87% unmapped
  // is what the client's real month looks like today.
  min_mapped_pct: 80,
  // The per-KRA rating (timesheet-kra-score.js kraRatings), asked for on
  // 6 Oct: required hours are working days × this, and the client's
  // final ladder — "A+ more than 100%, A more than 80%, B+ more than
  // 70%, B below 69%" (each band starting at its figure). Read through
  // scoringFor's merge with these defaults, so a tenant whose scoring
  // blob predates them still gets them.
  hours_per_day: 8,
  kra_bands: [
    { label: 'A+', min: 100 },
    { label: 'A',  min: 80 },
    { label: 'B+', min: 70 },
    { label: 'B',  min: 0  },
  ],
  // Labels and cut-offs for the monthly indicator. The same ladder as
  // the annual grades by name only — a monthly timesheet indicator and
  // an annual performance rating are different measurements, and the
  // engine never writes one into the other.
  bands: [
    { label: 'A+', min: 90 },
    { label: 'A',  min: 75 },
    { label: 'B+', min: 60 },
    { label: 'B',  min: 45 },
    { label: 'C',  min: 0  },
  ],
};

// Exported and called at request time as well as here, because
// core.tenants is EMPTY during migrations on a fresh database — index.js
// creates the tenant after runMigrations. That trap cost migration 056 a
// boot loop and 063 a silent no-op; 064 and this one call an ensure at
// request time instead.
async function ensureScoringSettings(db, tenantId) {
  const row = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`,
    [tenantId])).rows[0];
  const v = (row && row.value) || {};
  if (v.scoring && typeof v.scoring === 'object') return false;   // tuned already
  const next = { ...v, scoring: DEFAULT_SCORING };
  await db.query(
    `INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'timesheet',$2::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`,
    [tenantId, JSON.stringify(next)]);
  return true;
}

module.exports.ensureScoringSettings = ensureScoringSettings;
module.exports.DEFAULT_SCORING = DEFAULT_SCORING;
