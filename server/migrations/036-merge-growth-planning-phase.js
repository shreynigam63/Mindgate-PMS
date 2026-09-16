// 036 — fold growth_planning back into kra_open.
//
// The two are now one phase, shown as "KRA Setting and Growth Planning".
// growth_planning existed to let HR lock KRAs while leaving the growth
// plan open; that lock is now per-employee and automatic — submitting your
// KRA sheet locks it and opens your growth plan in the same moment — so
// the second phase only cost HR two extra transitions per cycle and a
// rollback whenever one person was out of step with the rest.
//
// WHY THE VALUE STAYS 'kra_open'. Renaming the phase itself would rewrite
// every cycle row, every pms.audit_log entry and every notification ever
// sent, to change a word that is only ever shown through the frontend's
// phaseLabel(). The stored value is the machine's, the label is the
// reader's, and only the label changes.
//
// WHAT THIS DOES TO A CYCLE MID-FLIGHT. 'growth_planning' is no longer in
// ORDER, so a cycle left sitting in it could not advance, roll back or be
// read by the phase machine at all — canAdvance() would answer "unknown
// phase" and the cycle would be stuck. Moving those cycles to 'kra_open'
// is the only safe landing: it is the phase they are now part of, and the
// people in them keep everything they had. KRA sheets already submitted or
// approved stay locked (that is status-driven, not phase-driven), and
// their owners keep the growth plan the submission opened.
//
// Cycles past growth_planning are untouched — this only ever matches the
// one value, and does nothing at all on an instance that never used it.
module.exports.up = async (db) => {
  const r = await db.query(
    `UPDATE pms.cycles SET phase='kra_open', updated_at=now() WHERE phase='growth_planning'`);
  if (r.rowCount) {
    // Recorded rather than silent: somebody watching a cycle move on its
    // own deserves a row saying why, and the audit log is where they look.
    await db.query(
      `INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, details)
       SELECT tenant_id, 'migration-036', 'PHASE_MERGED', id,
              '{"from":"growth_planning","to":"kra_open","reason":"growth planning folded into KRA setting"}'::jsonb
         FROM pms.cycles WHERE phase='kra_open' AND updated_at > now() - interval '1 minute'`);
  }
};
