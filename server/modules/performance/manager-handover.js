// What moves when somebody's reporting manager changes.
//
// Asked for on 24 Sep: "Reporting manager change will also lead to open
// KRA changes."
//
// Two of these already moved. KRA sheets and growth plans were
// reassigned in 2026 under BR-1.5, in duplicated SQL in two places
// (the bulk importer and HR's quick edit). Three did not, and each of
// the three is a queue somebody works from:
//
//   * the mid-year check-in — the OLD manager kept the sign-off;
//   * the manager evaluation — the old manager kept it, and the new
//     one could not write theirs because a row already existed
//     against somebody else;
//   * the competency assessment, added the same week.
//
// The effect was that changing a reporting line moved half a person's
// records and left the other half with a manager who no longer manages
// them — visible on the old manager's dashboard, invisible on the new
// one's, and blocking.
//
// TWO RULES DECIDE WHAT MOVES.
//
//   1. Only OPEN cycles. A closed cycle's records keep the manager who
//      actually did the work — that is history, and a later
//      reassignment must not rewrite who signed something off.
//
//   2. Only UNSUBMITTED work. A submitted evaluation or a signed-off
//      mid-year is a statement somebody made and put their name to.
//      Reassigning it would attribute one manager's judgement to
//      another. Those stay; only what is still to be done moves.
//
// Returns what it moved, per kind, so the caller can tell the user
// rather than doing it silently.

// Every table that carries a manager_id for work in flight, with the
// column that says whether it is finished. `done` null means the record
// has no submitted state of its own and always moves while the cycle
// is open.
// LIVE comes from the shared resolver rather than being written out
// again here. Six copies of that predicate once existed across four
// modules, all with the same bug, and a test now fails the moment
// anybody writes a seventh — which is how this line got caught.
const { LIVE } = require('./active-cycle');

const TABLES = [
  { table: 'pms.kra_sheets', label: 'KRA sheets', done: null },
  { table: 'pms.development_plans', label: 'target achievement plans', done: null },
  { table: 'pms.midyear_checkins', label: 'mid-year check-ins', done: 'manager_status' },
  { table: 'pms.manager_evaluations', label: 'evaluations', done: 'status' },
  { table: 'pms.competency_assessments', label: 'competency assessments', done: 'manager_status' },
];

// `q` is anything with .query — a pool or a transaction client — so the
// importer can run this inside its own transaction and the quick-edit
// route can call it directly.
async function handoverOpenRecords(q, tenantId, employeeId, newManagerId) {
  const moved = [];
  for (const t of TABLES) {
    const r = await q.query(
      `UPDATE ${t.table} x SET manager_id=$3, updated_at=now()
         FROM pms.cycles c
        WHERE x.tenant_id=$1 AND x.employee_id=$2 AND x.cycle_id=c.id
          AND c.${LIVE}
          ${t.done ? `AND x.${t.done} IS DISTINCT FROM 'submitted'` : ''}
          AND x.manager_id IS DISTINCT FROM $3
        RETURNING x.id`,
      [tenantId, employeeId, newManagerId || null]);
    if (r.rowCount) moved.push({ kind: t.label, count: r.rowCount });
  }
  return moved;
}

// One sentence for the person who made the change, so a reassignment
// that quietly moved nine records says so.
function handoverSummary(moved) {
  if (!moved.length) return null;
  const total = moved.reduce((a, m) => a + m.count, 0);
  return `${total} open ${total === 1 ? 'record' : 'records'} moved to the new manager — ${moved.map((m) => `${m.count} ${m.kind}`).join(', ')}. Anything already submitted stays with the manager who did it.`;
}

module.exports = { handoverOpenRecords, handoverSummary, TABLES };
