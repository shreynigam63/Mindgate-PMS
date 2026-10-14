// Everyone below a person on the reporting line: their direct reports, the
// reports of any manager among them, and so on down. A Delivery Head's
// "team" (15 Oct: "reportees and managers reporting to HOD") is this tree,
// not every employee of the departments they head.
//
// Bounded at 15 levels, so a manager loop in the employee master (A reports
// to B reports to A) ends instead of spinning; the root is never its own
// member.
const db = require('../../core/db');

async function reportingTree(tenantId, rootId) {
  const rows = (await db.query(
    `WITH RECURSIVE tree AS (
       SELECT id, 1 AS depth FROM core.employees
        WHERE tenant_id=$1 AND manager_id=$2 AND id<>$2 AND archived_at IS NULL
       UNION
       SELECT e.id, t.depth + 1 FROM core.employees e JOIN tree t ON e.manager_id = t.id
        WHERE e.tenant_id=$1 AND e.id<>$2 AND e.archived_at IS NULL AND t.depth < 15
     )
     SELECT DISTINCT tr.id FROM tree tr JOIN core.employees e ON e.id = tr.id WHERE e.status='active'`,
    [tenantId, rootId])).rows;
  return new Set(rows.map((r) => r.id));
}

module.exports = { reportingTree };
