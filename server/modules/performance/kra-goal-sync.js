// Keeping the growth plan honest about which KRAs its goals actually serve.
//
// Reported on 18 Sep against a screenshot: "Edit option is not available on
// My Growth even after KRAs are reopened on changing department, designation
// or role. Please check the exact issue as to why it is not fetched directly
// from My KRAs."
//
// Two defects sat behind that, and this file is the fix for both.
//
// DEFECT 1 — THE REOPEN FIRED ON THE CAUSE, NOT THE EFFECT.
// profile-change.js reopens the sheet, the growth plan and the mid-year
// review at the moment HR changes somebody's department or designation. But
// the KRAs do not change at that moment: the employee refills My KRAs and
// resubmits the sheet LATER, and that is when their objectives actually
// become different ones. Nothing reopened the plan at that second moment, so
// an employee who had already resubmitted their plan in between was locked
// out holding goals aimed at KRAs that no longer existed —
// growthEditable() checks the plan status FIRST, so the state of the sheet
// could not rescue them. That is exactly the state in the screenshot:
// plan 'submitted', goals headed "no longer on your KRA sheet".
//
// DEFECT 2 — THE REAL LINK WAS BEING DESTROYED.
// A goal carries two references to its KRA (migration 035):
//   kra_id      the real foreign key — ON DELETE SET NULL
//   serves_kra  the KRA's title as TEXT, frozen when the goal was written
// Until the id-preserving save landed, every write of a KRA sheet deleted
// and re-inserted every KRA row, so the FK nulled kra_id on every goal
// pointing at them. The link was destroyed on each save and only the frozen
// title survived — which is why My Growth compares titles, and why a KRA
// that was merely reworded reads as "no longer on your sheet".
//
// So this does two things, in this order, and the order matters: RELINK
// first, then judge what is orphaned. Relinking is a repair of a broken
// pointer and never changes what a goal says, so it is safe on a locked
// plan and safe to repeat. Judging first would reopen plans whose goals
// were about to be relinked perfectly well.
//
// WHY NOT IN profile-change.js: this is not a profile change. It fires on a
// KRA submission, by the employee or by HR on their behalf, and it must fire
// whether or not anybody's job ever changed — a plain edit to a KRA title
// orphans a goal just as thoroughly.
const db = require('../../core/db');
const { notify } = require('../../core/notifications');
const logger = require('../../core/logger');

// The two statuses that are shut to the employee, same as profile-change.js.
// 'draft' and 'returned' are already theirs, so there is nothing to reopen
// and no reason to spend a notification saying so.
const LOCKED = ['submitted', 'approved'];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Restore kra_id where it was nulled but the title still identifies a KRA
// on the employee's current sheet.
//
// ONLY UNAMBIGUOUS MATCHES. If a sheet somehow carries two KRAs with the
// same title, guessing which one a goal meant is worse than leaving the
// pointer null — the title snapshot still renders correctly either way, and
// a wrong kra_id would quietly mis-attribute the goal in the manager's view.
async function relinkGoalsByTitle(tenantId, planId, kras) {
  const byTitle = new Map();
  for (const k of kras) {
    const t = norm(k.title);
    if (!t) continue;
    byTitle.set(t, byTitle.has(t) ? null : k.id);   // null marks "ambiguous"
  }

  const orphans = (await db.query(
    `SELECT id, serves_kra FROM pms.development_goals
      WHERE tenant_id=$1 AND plan_id=$2 AND kra_id IS NULL
        AND serves_kra IS NOT NULL AND btrim(serves_kra) <> ''`,
    [tenantId, planId])).rows;

  let relinked = 0;
  for (const g of orphans) {
    const hit = byTitle.get(norm(g.serves_kra));
    if (!hit) continue;
    // No updated_at on this table (009 never added one, 035 did not either),
    // so do not invent one here — a stray column name in an UPDATE is a
    // runtime error on a path whose whole job is to be unobtrusive.
    await db.query(
      `UPDATE pms.development_goals SET kra_id=$1 WHERE id=$2 AND tenant_id=$3`,
      [hit, g.id, tenantId]);
    relinked += 1;
  }
  return relinked;
}

// The goals that name a KRA which is not on the sheet any more.
//
// Judged on the TITLE, not on kra_id being null: a null id is the normal
// state for every goal written before the id-preserving save, and treating
// those as orphaned would reopen essentially every plan on the instance the
// first time somebody submitted a sheet. The title is what the employee
// reads, so it is what decides whether the heading is a lie.
function orphanedGoals(goals, kras) {
  const onSheet = new Set(kras.map((k) => norm(k.title)).filter(Boolean));
  // An empty sheet means "nothing to compare against", not "everything is
  // orphaned". The employee is mid-refill; reopening their plan to tell
  // them their goals are stale while they are holding zero KRAs is noise.
  if (!onSheet.size) return [];
  return goals.filter((g) => {
    const name = norm(g.serves_kra);
    return name && !onSheet.has(name);
  });
}

// Called after a KRA sheet is submitted — by the employee, or by HR on their
// behalf. Returns what it did so the caller can put it on the response;
// the submit has already committed by then and must not be undone by
// anything here.
async function syncGoalsToKras(tenantId, cycleId, employeeId, { actorEmail = null } = {}) {
  const plan = (await db.query(
    `SELECT id, status, manager_id FROM pms.development_plans
      WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
    [tenantId, cycleId, employeeId])).rows[0];
  // No plan row yet is the common case for somebody who has never opened My
  // Growth. Nothing to sync, and creating one here would put a plan in front
  // of them that they never asked for.
  if (!plan) return { plan_id: null, relinked: 0, orphaned: [], reopened: false };

  const kras = (await db.query(
    `SELECT k.id, k.title FROM pms.kras k
       JOIN pms.kra_sheets sh ON sh.id = k.sheet_id
      WHERE sh.tenant_id=$1 AND sh.cycle_id=$2 AND sh.employee_id=$3`,
    [tenantId, cycleId, employeeId])).rows;

  const relinked = await relinkGoalsByTitle(tenantId, plan.id, kras);

  const goals = (await db.query(
    `SELECT id, title, serves_kra FROM pms.development_goals
      WHERE tenant_id=$1 AND plan_id=$2 ORDER BY sort_order`,
    [tenantId, plan.id])).rows;
  const orphaned = orphanedGoals(goals, kras);

  if (!orphaned.length || !LOCKED.includes(plan.status)) {
    return { plan_id: plan.id, relinked, orphaned: orphaned.map((g) => g.serves_kra), reopened: false };
  }

  const n = orphaned.length;
  const reason = `${n} of your development goal${n === 1 ? '' : 's'} `
    + `still name${n === 1 ? 's' : ''} a KRA that is no longer on your sheet. `
    + 'Your KRAs changed after these goals were written — please point them at your '
    + 'current KRAs and submit again.';

  // 'kra_changed' is the FOURTH value this column carries, and the reason it
  // is a stored column rather than a guess at the comment text (037/039):
  // "your KRAs changed" is not "your manager returned this", and an employee
  // reading the wrong one has been told something untrue about a colleague.
  const upd = await db.query(
    `UPDATE pms.development_plans
        SET status='returned', manager_comment=$1, reopened_reason='kra_changed',
            decided_at=now(), updated_at=now()
      WHERE id=$2 AND tenant_id=$3 AND status = ANY($4::text[])
      RETURNING id`,
    [reason, plan.id, tenantId, LOCKED]);
  // Lost a race with a manager deciding the plan in the same instant. Their
  // decision stands; nothing here is worth overwriting it for.
  if (!upd.rowCount) {
    return { plan_id: plan.id, relinked, orphaned: orphaned.map((g) => g.serves_kra), reopened: false };
  }

  // Audited because this moves a row that feeds an appraisal back into the
  // employee's hands without anybody pressing a button — "why is my plan
  // open again" must have a queryable answer.
  await db.query(
    `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
     VALUES ($1,$2,'DEVPLAN_REOPENED_KRA_CHANGED','development_plans',$3,$4)`,
    [tenantId, actorEmail, plan.id,
     JSON.stringify({
       employee_id: employeeId,
       cycle_id: cycleId,
       relinked,
       orphaned_goals: orphaned.map((g) => ({ goal: g.title, served_kra: g.serves_kra })),
     })]);

  await notify(tenantId, employeeId, 'devplan_reopened',
    'Your growth plan was reopened because your KRAs changed', reason, '/my/growth');
  if (plan.manager_id) {
    await notify(tenantId, plan.manager_id, 'devplan_reopened',
      "A report's growth plan was reopened because their KRAs changed",
      `${reason} It has gone back to them to refill.`, '/pms/team');
  }

  return { plan_id: plan.id, relinked, orphaned: orphaned.map((g) => g.serves_kra), reopened: true };
}

// The wrapper the routes use. A KRA submission that has already committed
// must not fail because of the growth plan, but it must not fail SILENTLY
// either — the caller puts the warning on the response, and the log carries
// the whole error.
async function syncGoalsToKrasSafely(tenantId, cycleId, employeeId, opts = {}) {
  try {
    return await syncGoalsToKras(tenantId, cycleId, employeeId, opts);
  } catch (e) {
    logger.error('growth plan sync after KRA submit', {
      error: e.message, tenant_id: tenantId, cycle_id: cycleId, employee_id: employeeId });
    return { plan_id: null, relinked: 0, orphaned: [], reopened: false, error: e.message };
  }
}

module.exports = {
  syncGoalsToKras, syncGoalsToKrasSafely, relinkGoalsByTitle, orphanedGoals, LOCKED,
};
