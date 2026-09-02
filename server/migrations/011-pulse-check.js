// 011 — Mid-Year 7-Parameter Pulse Check (BRD Fig. 7b): "Employees
// complete a 7-parameter pulse check on their own experience, for their
// own reference... informational only, does not feed the Annual Review
// score."
//
// Deliberately a SEPARATE table from pms.parameter_scores (the Annual
// Review's manager-scored, weighted-rating-computing table from
// migration 008) rather than a shared one with a "type" column. The
// whole point of this feature is that it must never influence the real
// rating — putting it in its own table with its own routes (self-only,
// no manager access, no weighted-rating computation, nothing writes to
// pms.manager_evaluations) makes that a structural guarantee rather than
// a runtime check someone could get wrong later.
module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.pulse_checks (
    tenant_id    uuid NOT NULL,
    cycle_id     uuid NOT NULL REFERENCES pms.cycles(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL,
    parameter_id uuid NOT NULL REFERENCES pms.review_parameters(id),
    score        numeric(3,1) NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (cycle_id, employee_id, parameter_id)
  )`);
};
