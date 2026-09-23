// One queue for every pending decision in the company.
//
// Asked for on 18 Sep with the super-admin work, and drawn in the UI
// prototype: "every pending decision across the whole company, in one
// place". Until now each kind lived on its own page — a manager's KRA
// queue here, growth plans there, mid-year sign-offs somewhere else — so
// nobody could answer "what is this cycle waiting on?" without opening
// five screens and adding up.
//
// TWO KINDS OF ROW, AND THE DIFFERENCE MATTERS.
//
//   decisions  — a KRA sheet or a growth plan that someone SUBMITTED and
//                is waiting on an approve-or-return. These can be bulk
//                approved, because approving is the whole action.
//   waiting    — a mid-year sign-off, a manager evaluation, a delivery
//                head evaluation. Nobody has submitted anything to
//                approve: the named person still has to WRITE their
//                assessment. Bulk "approving" one would mean writing an
//                empty evaluation in someone else's name, so these rows
//                carry no approve button, only who they are waiting on.
//
// The prototype showed a fifth type, connect confirmations. The product
// has no manager confirmation on a connect yet — that is a new feature,
// not a query — so it is deliberately absent rather than faked.
const db = require('../../core/db');
const logger = require('../../core/logger');
const { notify } = require('../../core/notifications');

// The two decidable kinds, described once. Both decide endpoints and the
// bulk approve run through this table, so a rule can only be changed in
// one place — the second copy going stale is exactly how a bulk action
// ends up skipping an audit row or a notification.
const DECIDABLE = {
  kra_sheet: {
    table: 'pms.kra_sheets',
    label: 'KRA sheet',
    action: (decision) => `KRA_${decision.toUpperCase()}`,
    notifyKind: 'kra_decided',
    message: (decision) => `Your KRA sheet was ${decision}`,
    link: '/pms',
  },
  growth_plan: {
    table: 'pms.development_plans',
    label: 'Growth plan',
    action: (decision) => `DEVPLAN_${decision.toUpperCase()}`,
    notifyKind: 'devplan_decided',
    message: (decision) => `Your target achievements for the year were ${decision}`,
    link: '/pms/my-growth',
  },
};

// Decide one record. Returns {ok} or {error, status} — never throws into a
// bulk loop, because one bad row must not lose the other nineteen.
//
// `canDecide` is passed in rather than checked here: who may decide a row
// is a route-level question (your own report, or pms_admin), and the two
// callers already know the answer for their own context.
async function decide({ kind, id, tenantId, decision, comment, actor, canDecide, audit }) {
  const spec = DECIDABLE[kind];
  if (!spec) return { error: `unknown kind '${kind}'`, status: 400 };
  if (!['approved', 'returned'].includes(decision)) {
    return { error: "decision must be 'approved' or 'returned'", status: 400 };
  }
  if (decision === 'returned' && !(comment && comment.trim())) {
    return { error: 'A return needs a comment — the employee must know why', status: 422 };
  }
  const row = (await db.query(
    `SELECT * FROM ${spec.table} WHERE id=$1 AND tenant_id=$2`, [id, tenantId])).rows[0];
  if (!row) return { error: `${spec.label.toLowerCase()} not found`, status: 404 };

  const allowed = await canDecide(row);
  if (!allowed) return { error: 'Not your report', status: 403 };
  if (row.status !== 'submitted') {
    return { error: `${spec.label.toLowerCase()} is ${row.status}, not submitted`, status: 409 };
  }

  // reopened_reason is cleared: this IS the decision, so a record
  // previously reopened by a profile change must stop being labelled as one
  // the moment the decider touches it. Saying "reopened — role changed"
  // over a return the manager actually wrote credits a change nobody made.
  await db.query(
    `UPDATE ${spec.table} SET status=$1, manager_comment=$2, reopened_reason=NULL,
            decided_at=now(), updated_at=now() WHERE id=$3`,
    [decision, comment || null, row.id]);
  audit(spec.action(decision), row.cycle_id, row.employee_id, { comment: comment || null });
  await notify(tenantId, row.employee_id, spec.notifyKind, spec.message(decision), comment || null, spec.link)
    .catch((e) => logger.warn('approval notify failed', { error: e.message, id: row.id }));
  return { ok: true, employee_id: row.employee_id, cycle_id: row.cycle_id };
}

// Everything the cycle is waiting on. Company-wide: this is an HR and
// super-admin surface, so it is not scoped to the caller's reports.
//
// Every row names WHO it waits on, because "pending" without a name is
// what makes people forward the completion report to everybody.
async function pendingApprovals(tenantId, cycleId) {
  const q = async (sql) => (await db.query(sql, [tenantId, cycleId])).rows;

  const sheets = await q(`
    SELECT s.id, s.employee_id, s.submitted_at AS since,
           e.name AS employee_name, e.designation, e.department,
           m.name AS waiting_on
      FROM pms.kra_sheets s
      JOIN core.employees e ON e.id = s.employee_id
      LEFT JOIN core.employees m ON m.id = e.manager_id
     WHERE s.tenant_id=$1 AND s.cycle_id=$2 AND s.status='submitted'`);

  const plans = await q(`
    SELECT p.id, p.employee_id, p.submitted_at AS since,
           e.name AS employee_name, e.designation, e.department,
           m.name AS waiting_on
      FROM pms.development_plans p
      JOIN core.employees e ON e.id = p.employee_id
      LEFT JOIN core.employees m ON m.id = e.manager_id
     WHERE p.tenant_id=$1 AND p.cycle_id=$2 AND p.status='submitted'`);

  // The employee has written their half and the manager has not.
  const midyear = await q(`
    SELECT c.id, c.employee_id, c.self_submitted_at AS since,
           e.name AS employee_name, e.designation, e.department,
           m.name AS waiting_on
      FROM pms.midyear_checkins c
      JOIN core.employees e ON e.id = c.employee_id
      LEFT JOIN core.employees m ON m.id = e.manager_id
     WHERE c.tenant_id=$1 AND c.cycle_id=$2
       AND c.self_status='submitted' AND c.manager_status <> 'submitted'`);

  // Same shape at annual: a self-appraisal is in, the manager's evaluation
  // is not. Joined on the self-appraisal rather than listing every pending
  // evaluation, or the queue would show the whole company on day one.
  const evals = await q(`
    SELECT ev.id, sa.employee_id, sa.submitted_at AS since,
           e.name AS employee_name, e.designation, e.department,
           m.name AS waiting_on
      FROM pms.self_appraisals sa
      JOIN core.employees e ON e.id = sa.employee_id
      LEFT JOIN core.employees m ON m.id = e.manager_id
      LEFT JOIN pms.manager_evaluations ev
             ON ev.cycle_id = sa.cycle_id AND ev.employee_id = sa.employee_id
     WHERE sa.tenant_id=$1 AND sa.cycle_id=$2 AND sa.status='submitted'
       AND (ev.id IS NULL OR ev.status <> 'submitted')`);

  // And the delivery head's turn: the manager is done, the HOD is not.
  const hod = await q(`
    SELECT h.id, me.employee_id, me.submitted_at AS since,
           e.name AS employee_name, e.designation, e.department,
           dh.name AS waiting_on
      FROM pms.manager_evaluations me
      JOIN core.employees e ON e.id = me.employee_id
      LEFT JOIN pms.hod_evaluations h
             ON h.cycle_id = me.cycle_id AND h.employee_id = me.employee_id
      LEFT JOIN core.department_heads d
             ON d.tenant_id = me.tenant_id AND d.department = e.department
      LEFT JOIN core.employees dh ON dh.id = d.employee_id
     WHERE me.tenant_id=$1 AND me.cycle_id=$2 AND me.status='submitted'
       AND (h.id IS NULL OR h.status <> 'submitted')`);

  // NOTE on employee_id above: it is taken from the row that always
  // exists (sa, me), never from the LEFT JOINed one (ev, h). Taking it
  // from the join produced NULL for every person whose evaluation had not
  // been created yet — so the queue showed their name, from the employees
  // table, beside an employee_id of null.
  //
  // Every row needs an id that is actually unique, and for three of these
  // kinds the child record may not exist yet — the mid-year, evaluation and
  // delivery-head queries LEFT JOIN it precisely so a row appears BEFORE
  // anyone has written anything. `id` is then null, and null is not an
  // identity: several rows shared the key "hod_evaluation:null", React
  // reused the wrong nodes, and filtering the queue by type showed rows of
  // the wrong type. Found by filtering the live page, not by reading this.
  //
  // So the key falls back to the employee, who is unique per kind here.
  const tag = (rows, kind, decidable) => rows.map((r) => ({
    ...r, kind, decidable,
    row_key: `${kind}:${r.id || `emp-${r.employee_id}`}`,
  }));
  const items = [
    ...tag(sheets, 'kra_sheet', true),
    ...tag(plans, 'growth_plan', true),
    ...tag(midyear, 'midyear', false),
    ...tag(evals, 'evaluation', false),
    ...tag(hod, 'hod_evaluation', false),
  ].sort((a, b) => new Date(a.since || 0) - new Date(b.since || 0));   // oldest first: that is the queue

  const counts = items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});
  return { items, counts, total: items.length };
}

module.exports = { pendingApprovals, decide, DECIDABLE };
