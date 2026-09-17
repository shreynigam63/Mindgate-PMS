// A KRA sheet, a growth plan and a mid-year review are all written FOR a
// job. Change the job, reopen them.
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
// EXTENDED 17 Sep to My Growth, asked for against the change doc: the
// growth plan is the same trap. Submitting it hands it to the manager and
// closes it to the employee (growthEditable() locks 'submitted' and
// 'approved'), and the plan describes how somebody will grow INTO a job —
// so a move between roles aims their development goals and their career
// aspiration at a role they no longer hold.
//
// ONE column covers both halves of My Growth. The career aspiration in
// people.career_paths has no status of its own; its lock IS the development
// plan's status, so reopening the plan reopens the aspiration with it.
//
// WHY THIS LIVES IN THE PERFORMANCE MODULE, AND IS CALLED FROM CORE.
// The rule is entirely about pms.kra_sheets and pms.development_plans —
// which statuses are locked, what a reopened row becomes, who hears about
// it. That belongs beside the rest of the performance logic, not in the
// employee master. core/employees
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

// The growth plan, on the same rule and for the same reason.
//
// Deliberately a SEPARATE function and a separate UPDATE rather than a
// clever one-query-two-tables job: the two are independent. An employee can
// easily have a submitted KRA sheet and a draft growth plan, or the other
// way round, and each must be judged on its own status. Reopening one
// because the other was locked would hand back a plan nobody had finished.
//
// Same LOCKED statuses, same DEAD_PHASES, same 'returned' landing state,
// for all the reasons the sheet version gives.
async function reopenLockedGrowthPlans(tenantId, employeeId, changes, { actorEmail = null } = {}) {
  if (!changes || !changes.length) return [];

  const reason = `Your ${describe(changes)}. `
    + 'Please review your development goals and career aspiration for the new role and submit again.';

  const reopened = (await db.query(
    `UPDATE pms.development_plans dp
        SET status='returned', manager_comment=$1, reopened_reason='profile_change',
            decided_at=now(), updated_at=now()
       FROM pms.cycles c
      WHERE dp.cycle_id = c.id
        AND dp.tenant_id = $2 AND dp.employee_id = $3
        AND dp.status = ANY($4::text[])
        AND c.phase <> ALL($5::text[])
      RETURNING dp.id, dp.cycle_id, dp.manager_id`,
    [reason, tenantId, employeeId, LOCKED, DEAD_PHASES])).rows;

  if (!reopened.length) return [];

  for (const r of reopened) {
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'DEVPLAN_REOPENED_PROFILE_CHANGE','development_plans',$3,$4)`,
      [tenantId, actorEmail, r.id,
       JSON.stringify({ employee_id: employeeId, cycle_id: r.cycle_id, changes })]);
  }

  await notify(tenantId, employeeId, 'devplan_reopened',
    'Your growth plan was reopened after a change to your role', reason, '/my/growth');
  for (const managerId of [...new Set(reopened.map((r) => r.manager_id).filter(Boolean))]) {
    await notify(tenantId, managerId, 'devplan_reopened',
      'A report\'s growth plan was reopened after a role change',
      `${describe(changes)}. Their growth plan has gone back to them to refill.`, '/pms/team');
  }

  return reopened;
}

// The Mid-Year Review, on the same rule — and the one that needed a
// different landing state, because mid-year is shaped differently.
//
// It has no 'returned' status (not_started | in_progress | submitted) and no
// comment column: self_narrative and manager_narrative are the two parties'
// own writing and are not ours to overwrite. So a reopened mid-year goes
// back to 'in_progress', which the save routes already accept, and the
// sentence lands in its own reopened_note column (migration 040).
//
// BOTH HALVES reopen. The alternative — reopen the employee's half and
// leave the manager's submitted — leaves a mid-year that reads as complete
// while one half describes the old job and the other the new one. It is
// also consistent with the sheet, where an 'approved' sheet reopens rather
// than being protected because a manager had already decided.
//
// NOTHING IS DELETED. Ratings, narratives and both per-KRA entry maps are
// untouched; only the status and the submitted timestamp move. If the job
// change does not actually affect what someone wrote, they resubmit exactly
// what they had.
async function reopenLockedMidyear(tenantId, employeeId, changes, { actorEmail = null } = {}) {
  if (!changes || !changes.length) return [];

  const note = `Your ${describe(changes)}. `
    + 'Please review your mid-year review against the new role and submit again.';

  // Only rows where at least one half is actually submitted. A check-in
  // sitting at not_started/in_progress is already open, so there is nothing
  // to reopen and no notification worth spending.
  const reopened = (await db.query(
    `UPDATE pms.midyear_checkins mc
        SET self_status    = CASE WHEN mc.self_status='submitted'    THEN 'in_progress' ELSE mc.self_status END,
            manager_status = CASE WHEN mc.manager_status='submitted' THEN 'in_progress' ELSE mc.manager_status END,
            self_submitted_at    = CASE WHEN mc.self_status='submitted'    THEN NULL ELSE mc.self_submitted_at END,
            manager_submitted_at = CASE WHEN mc.manager_status='submitted' THEN NULL ELSE mc.manager_submitted_at END,
            reopened_reason='profile_change', reopened_note=$1, updated_at=now()
       FROM pms.cycles c
      WHERE mc.cycle_id = c.id
        AND mc.tenant_id = $2 AND mc.employee_id = $3
        AND (mc.self_status='submitted' OR mc.manager_status='submitted')
        AND c.phase <> ALL($4::text[])
      RETURNING mc.id, mc.cycle_id, mc.manager_id, mc.self_status, mc.manager_status`,
    [note, tenantId, employeeId, DEAD_PHASES])).rows;

  if (!reopened.length) return [];

  for (const r of reopened) {
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'MIDYEAR_REOPENED_PROFILE_CHANGE','midyear_checkins',$3,$4)`,
      [tenantId, actorEmail, r.id,
       JSON.stringify({ employee_id: employeeId, cycle_id: r.cycle_id, changes })]);
  }

  await notify(tenantId, employeeId, 'midyear_reopened',
    'Your mid-year review was reopened after a change to your role', note, '/my/midyear');
  for (const managerId of [...new Set(reopened.map((r) => r.manager_id).filter(Boolean))]) {
    await notify(tenantId, managerId, 'midyear_reopened',
      'A report\'s mid-year review was reopened after a role change',
      `${describe(changes)}. Their mid-year review is open again for both of you.`, '/pms/team');
  }

  return reopened;
}

// The convenience wrapper the callers actually use: work out what changed,
// then reopen if it matters. Kept separate so the comparison is testable
// on its own — most of the bugs in a feature like this are in deciding
// what counts as a change, not in the UPDATE.
//
// `reopened` stays the KRA sheets alone, and the growth plans come back
// under their own key. Three callers already read `reopened` and report it
// as reopened_kra_sheets / kra_sheets_reopened; folding a second kind of
// row into that array would quietly change what those numbers mean on an
// HR screen and in an import report.
async function applyProfileChange(tenantId, employeeId, before, after, opts = {}) {
  const changes = watchedChanges(before, after);
  const reopened = await reopenLockedSheets(tenantId, employeeId, changes, opts);
  const reopenedGrowthPlans = await reopenLockedGrowthPlans(tenantId, employeeId, changes, opts);
  const reopenedMidyear = await reopenLockedMidyear(tenantId, employeeId, changes, opts);
  return {
    changes,
    reopened,
    reopened_growth_plans: reopenedGrowthPlans,
    reopened_midyear: reopenedMidyear,
  };
}

module.exports = {
  reopenLockedSheets, reopenLockedGrowthPlans, reopenLockedMidyear, applyProfileChange,
  watchedChanges, WATCHED, LOCKED,
};
