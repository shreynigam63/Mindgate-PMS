// Repair the goal → KRA links that an earlier save path destroyed.
//
// pms.development_goals carries two references to the KRA a goal serves
// (migration 035): kra_id, the real foreign key, declared ON DELETE SET
// NULL; and serves_kra, the KRA's title frozen as text when the goal was
// written.
//
// Until the id-preserving save landed, writing a KRA sheet DELETEd every
// pms.kras row and re-INSERTed it. New rows meant new uuids, and the FK
// then nulled kra_id on every goal that pointed at the old ones. So the
// real link was destroyed on every single save of a KRA sheet, and only
// the frozen title survived.
//
// That is why My Growth compares TITLES to decide whether a goal still
// serves something on the sheet, and why a KRA that was merely reworded
// reads as "no longer on your KRA sheet". The save path is fixed going
// forward; this repairs the rows already damaged, because nothing else
// will — a goal's kra_id is only rewritten when the employee edits that
// goal, and an employee with a locked plan cannot.
//
// ONLY UNAMBIGUOUS MATCHES, hence the `n = 1` guard. If a sheet carries two
// KRAs with the same title, guessing which one a goal meant would quietly
// mis-attribute it in the manager's view; leaving the pointer null renders
// identically off the title snapshot and stays honest.
//
// Scoped by tenant_id on every join, and idempotent: it only writes rows
// where kra_id IS NULL, so a second run matches nothing.
module.exports.up = async (db) => {
  const r = await db.query(`
    UPDATE pms.development_goals g
       SET kra_id = m.kra_id
      FROM (
        SELECT g2.id AS goal_id, min(k.id::text)::uuid AS kra_id, count(*) AS n
          FROM pms.development_goals g2
          JOIN pms.development_plans p
            ON p.id = g2.plan_id AND p.tenant_id = g2.tenant_id
          JOIN pms.kra_sheets sh
            ON sh.cycle_id = p.cycle_id AND sh.employee_id = p.employee_id
           AND sh.tenant_id = p.tenant_id
          JOIN pms.kras k
            ON k.sheet_id = sh.id AND k.tenant_id = g2.tenant_id
         WHERE g2.kra_id IS NULL
           AND g2.serves_kra IS NOT NULL
           AND btrim(g2.serves_kra) <> ''
           AND btrim(lower(g2.serves_kra)) = btrim(lower(k.title))
         GROUP BY g2.id
      ) m
     WHERE g.id = m.goal_id
       AND m.n = 1`);
  if (r.rowCount) console.log(`  041: relinked ${r.rowCount} development goal(s) to their KRA`);
};
