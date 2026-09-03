// 031 — the HR-only AI analysis of an annual review meeting, against the
// 7 organisational parameters.
//
// WHAT THIS IS. The employee, their manager and HR hold the annual review
// conversation on a call. The transcript (migration 027) is read against
// pms.review_parameters, and the result is a narrative per parameter —
// what the conversation actually showed about each one — alongside that
// parameter's configured weightage. Requested as visible to the HR admin
// and strictly not to the employee or their manager.
//
// RESTRICTED IS A PROPERTY OF THE ROW, NOT JUST THE ROUTE. The column is
// here so the intent survives someone later writing a new endpoint over
// this table: anything reading it can see, without going and finding the
// original request, that this is not employee-facing. The enforcement is
// still in code (pms_admin on every route) — this is the reminder, not the
// lock.
//
// entries is a jsonb map keyed by parameter_id, matching how
// pms.self_appraisals.entries and pms.midyear_checkins.self_entries
// already store per-item detail. A child table would be queryable, but the
// only query anyone wants is "the whole analysis for this person and
// cycle", which is one row.
//
// NO SCORE COLUMN, DELIBERATELY. The official 7-parameter rating is scored
// by humans in pms.parameter_scores and computed by
// computeWeightedRating(); this table holds narrative and a qualitative
// signal. A numeric AI score here would be a second, hidden rating for the
// same parameters that the person it describes cannot see or contest —
// see the route comment for why that line is drawn where it is.
//
// One analysis per employee per cycle. Re-running replaces it, so there is
// never a set of contradictory hidden assessments of the same person.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.parameter_ai_analyses (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL,
    cycle_id      uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id   uuid NOT NULL,
    meeting_id    uuid REFERENCES pms.review_meetings(id) ON DELETE SET NULL,
    draft_id      uuid,
    -- parameter_id -> { signal, summary[], evidence[], alignment }
    entries       jsonb NOT NULL DEFAULT '{}'::jsonb,
    overall       jsonb NOT NULL DEFAULT '{}'::jsonb,
    restricted_to text NOT NULL DEFAULT 'pms_admin',
    analysed_by   text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, cycle_id, employee_id)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_param_ai_cycle
    ON pms.parameter_ai_analyses (tenant_id, cycle_id)`);
};
