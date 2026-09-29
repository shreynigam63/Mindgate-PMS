// 066 — a settled month.
//
// Phase 4 of the Zoho timesheet rating engine: the year-end rollup into
// calibration.
//
// WHY A SNAPSHOT AND NOT A RECOMPUTE. Everything up to now is computed
// on the fly from the entries, the mappings and the current
// configuration, which is right for a screen somebody is working on.
// It is wrong for a number that reaches calibration. Recomputing
// September in March gives a different answer whenever anything has
// moved in between — a KRA reweighted, an item remapped, the value-add
// list edited, a KRA marked not measurable. The house rule is that
// "why did my rating change" must always have a queryable answer, so a
// month that has been closed keeps the numbers it was closed with, and
// keeps the configuration that produced them beside it.
//
// SO A MONTH IS CLOSED DELIBERATELY, BY A PERSON. Not by a scheduler:
// the client's real state today is 87% of hours unmapped, and a nightly
// job would have frozen a year of meaningless numbers before anybody
// looked at them. Closing is an HR action over a period that is over,
// previewed first, and every row records who closed it.
//
// THE OVERRIDE LIVES HERE, not on the rollup. A manager disputes one
// month — a sprint that ran outside Zoho, a secondment, a month on
// leave — and the correction belongs against that month with its
// reason, where the rollup will read it. Overriding the year-end number
// directly would leave no record of WHICH month was wrong.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.timesheet_month (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    employee_id   uuid NOT NULL REFERENCES core.employees(id) ON DELETE CASCADE,
    cycle_id      uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    period_start  date NOT NULL,
    period_end    date NOT NULL,

    -- The hours, exactly as timesheet-kra-match reported them.
    hours_logged      numeric(8,2) NOT NULL DEFAULT 0,
    hours_considered  numeric(8,2) NOT NULL DEFAULT 0,
    hours_attributed  numeric(8,2) NOT NULL DEFAULT 0,
    hours_excluded    numeric(8,2) NOT NULL DEFAULT 0,
    items             int NOT NULL DEFAULT 0,

    -- The percentages. Nullable on purpose: alignment is undefined when
    -- nothing could be placed, and compliance is absent for a window
    -- with no logs. Storing 0 for "we cannot tell" is the single
    -- easiest way to make this feature mark good people down.
    mapped_pct              numeric(5,1),
    weighted_coverage_pct   numeric(5,1),
    alignment_pct           numeric(5,1),
    value_add_pct           numeric(5,1),
    compliance_pct          numeric(5,1),

    -- Null whenever the engine withheld a score, which today is always:
    -- auto_score ships off. withheld carries the sentences, so a reader
    -- of a closed month a year later sees the same explanation the
    -- screen gave at the time.
    score      numeric(5,1),
    grade      text,
    withheld   jsonb NOT NULL DEFAULT '[]',

    -- WHAT THE NUMBERS WERE COMPUTED FROM. The scoring weights, the
    -- thresholds and the per-KRA breakdown, frozen. Without these the
    -- snapshot is a number nobody can argue with, which is worse than
    -- no snapshot.
    scoring    jsonb NOT NULL DEFAULT '{}',
    by_kra     jsonb NOT NULL DEFAULT '[]',

    closed_by  text,
    closed_at  timestamptz NOT NULL DEFAULT now(),

    -- The override. A manager disputing one month, with the reason the
    -- rollup and the audit will both show.
    override_score   numeric(5,1),
    override_grade   text,
    override_reason  text,
    overridden_by    text,
    overridden_at    timestamptz,
    -- Enforced by the database rather than the handler: an override
    -- with no reason is exactly the record this table exists to
    -- prevent.
    CONSTRAINT timesheet_month_override_reason CHECK (
      (override_score IS NULL AND override_grade IS NULL AND override_reason IS NULL)
      OR (override_reason IS NOT NULL AND btrim(override_reason) <> '')),

    UNIQUE (tenant_id, employee_id, cycle_id, period_start))`);

  // The two read shapes: one person's months, and everybody's for one
  // period (the close, and the rollup).
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_month_emp
    ON pms.timesheet_month (tenant_id, employee_id, cycle_id, period_start DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ts_month_period
    ON pms.timesheet_month (tenant_id, cycle_id, period_start)`);
};
