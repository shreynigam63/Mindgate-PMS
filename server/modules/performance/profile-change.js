// A KRA sheet is written FOR a job. Change the job, reopen the sheet.
//
// Asked for on 17 Sep: "if employee has submitted his KRA to manager and
// his department, designation or role is changed, his KRAs should be
// opened again for refilling as it gets locked after submission to
// manager."
//
// This is the corollary of the lock added the same day (phase-machine.js).
// Submitting hands the sheet to the manager and closes it to the employee,
// which is right — but the sheet describes what somebody was hired to do,
// and a move from Executive to Senior Executive, or Admin to Finance,
// invalidates it. Without this the employee is holding objectives for a
// job they no longer have, and the only way out is HR reopening the sheet
// by hand, which needs somebody to notice first.
//
// WHY THIS LIVES IN THE PERFORMANCE MODULE, AND IS CALLED FROM CORE.
// The rule is entirely about pms.kra_sheets — which statuses are locked,
// what a reopened sheet becomes, who hears about it. That belongs beside
// the rest of the KRA logic, not in the employee master. core/employees
// requires this leaf file lazily, at call time, so core's own module graph
// still loads without the product modules; the alternative was a third and
// fourth copy of this SQL inline in core, which is what the manager
// propagation above it already does and is the reason this exists.
const db = require('../../core/db');
const { notify } = require('../../core/notifications');

// Only these two are locked to the employee. 'draft' and 'returned' are
// already theirs to edit, so there is nothing to reopen and no reason to
// spend a notification telling them so.
const LOCKED = ['submitted', 'approved'];
// A closed or cancelled cycle is history, and a draft one was never shown
// to anybody. Same boundary the manager propagation uses.
const DEAD_PHASES = ['draft', 'closed', 'cancelled'];

// Which profile fields invalidate a KRA sheet. Deliberately not "any
// change": a corrected spelling of somebody's name, a date of joining
// backfilled from the HRMS, or a manager reassignment must NOT throw away
// an approved sheet. A manager change already propagates onto the sheet
// without reopening it, which is the right treatment — the objectives are
// still the objectives, they are just reviewed by someone else.
const WATCHED = [
  ['department', 'Department'],
  ['designation', 'Designation'],
  ['role_band', 'Role band'],
];

const norm = (v) => String(v == null ? '' : v).trim();

// What actually changed, of the fields we care about. Compared on trimmed
// text because '' and null both mean "not set" here, and an import that
// rewrites null as '' is not a change anybody should be told about.
function watchedChanges(before, after) {
  const out = [];
  for (const [key, label] of WATCHED) {
    if (!(key in after)) continue;
    if (norm(before[key]) === norm(after[key])) continue;
    out.push({ field: label, from: norm(before[key]) || '(none)', to: norm(after[key]) || '(none)' });
  }
  return out;
}

function describe(changes) {
  return changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join('; ');
}

// Reopens every locked sheet this employee holds on a live cycle, and
// returns what it reopened so the caller can say so rather than doing it
// silently. Returns [] when nothing was locked — the common case, and not
// an error.
//
// The reopened sheet becomes 'returned', the same state a manager's return
// produces. That is deliberate: 'returned' is already the one state the
// whole product understands as "yours again, with a reason attached", so
// the employee's page, the manager's queue and the reminder sweep all
// behave correctly with no new state to teach them.
async function reopenLockedSheets(tenantId, employeeId, changes, { actorEmail = null } = {}) {
  if (!changes || !changes.length) return [];

  // No "Reopened automatically:" prefix — the page and the notification
  // both already say that above this line, and reading it twice in one
  // sentence makes it look like a machine wrote to itself.
  const reason = `Your ${describe(changes)}. `
    + 'Please review your KRAs for the new role and submit again.';

  const reopened = (await db.query(
    `UPDATE pms.kra_sheets ks
        SET status='returned', manager_comment=$1, reopened_reason='profile_change',
            decided_at=now(), updated_at=now()
       FROM pms.cycles c
      WHERE ks.cycle_id = c.id
        AND ks.tenant_id = $2 AND ks.employee_id = $3
        AND ks.status = ANY($4::text[])
        AND c.phase <> ALL($5::text[])
      RETURNING ks.id, ks.cycle_id, ks.manager_id, ks.status AS new_status,
                (SELECT name FROM pms.cycles x WHERE x.id = ks.cycle_id) AS cycle_name`,
    [reason, tenantId, employeeId, LOCKED, DEAD_PHASES])).rows;

  if (!reopened.length) return [];

  // "Why did my rating change" must always have a queryable answer, and
  // this is upstream of a rating: it puts objectives back in play. Audited
  // per sheet, with the before/after that caused it.
  for (const r of reopened) {
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'KRA_REOPENED_PROFILE_CHANGE','kra_sheets',$3,$4)`,
      [tenantId, actorEmail, r.id,
       JSON.stringify({ employee_id: employeeId, cycle_id: r.cycle_id, changes })]);
  }

  // Both sides are told. The employee because their sheet just came back
  // to them and nobody pressed a button they can see; the manager because
  // a sheet they had approved, or were about to, has left their queue.
  await notify(tenantId, employeeId, 'kra_reopened',
    'Your KRA sheet was reopened after a change to your role', reason, '/pms');
  for (const managerId of [...new Set(reopened.map((r) => r.manager_id).filter(Boolean))]) {
    await notify(tenantId, managerId, 'kra_reopened',
      'A report\'s KRA sheet was reopened after a role change',
      `${describe(changes)}. Their sheet has gone back to them to refill.`, '/pms/team');
  }

  return reopened;
}

// The convenience wrapper the callers actually use: work out what changed,
// then reopen if it matters. Kept separate so the comparison is testable
// on its own — most of the bugs in a feature like this are in deciding
// what counts as a change, not in the UPDATE.
async function applyProfileChange(tenantId, employeeId, before, after, opts = {}) {
  const changes = watchedChanges(before, after);
  return { changes, reopened: await reopenLockedSheets(tenantId, employeeId, changes, opts) };
}

module.exports = { reopenLockedSheets, applyProfileChange, watchedChanges, WATCHED, LOCKED };
