// The First-Week Journey — a new joiner's first seven working days, one
// task per activity in the client's Activity Matrix. See
// migrations/081-onboarding.js for how the workbook became these tables,
// and onboarding-calendar.js for the date arithmetic.
//
// Mounted on the people router at /onboarding, so it sits behind the same
// authenticate -> scope hooks (the HRBP gateway) -> parity chain as
// everything else there. The page it serves is New Hire Insights, which
// is behind engagement_admin, so the API is too: one permission decides
// both whether the tab shows and whether its calls succeed.
//
// HRBP: the gateway lends engagement_admin and narrows responses by
// employee_id. Every summary here is ALSO computed over the remit before
// it is returned — a count of overdue tasks is not a row the gateway can
// filter, and "51 overdue" on a partner's screen when three of their
// joiners have nine between them would be the org-wide figure leaking
// through an aggregate.

const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { hasPermission } = require('../../core/permissions');
const hrbpScope = require('./hrbp-scope');
const cal = require('./onboarding-calendar');
const spoc = require('./onboarding-spoc');
const { sendMail, sendMode } = require('../../core/mail');
const { ROLES, PER_JOINER } = require('../../migrations/082-onboarding-spocs');

const { guardUuidParams } = require('../../core/http');

const router = express.Router();
// router.param is per router, so the people router's guard does not
// reach in here; a malformed :id would otherwise be a 500 from Postgres.
guardUuidParams(router);
const T = (req) => req.user.tenant_id;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// "Today" is the client's calendar day, not the server's. A box in UTC
// would otherwise flip every Due Today to Overdue at 05:30 IST.
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

const guard = async (req, res) => {
  // HR and HRBP reach it through New Hire Insights (engagement_admin);
  // the HR Ops team through its own page (onboarding_ops, 7 Oct).
  if (await hasPermission(req.user, 'engagement_admin')) return true;
  if (await hasPermission(req.user, 'onboarding_ops')) return true;
  res.status(403).json({ error: 'The onboarding tracker is for HR, HRBPs and HR Ops.', needs: 'onboarding_ops' });
  return false;
};

// "Checkbox … should be managed by HR Ops team and accessible to HRBP and
// HRs" (7 Oct). Marking a task done — the tick, a completion date, an
// acknowledgement — and sending the joiner's email need onboarding_ops,
// which the hr_ops, hr and hrbp bundles hold (002, 083).
const canOperate = (req) => hasPermission(req.user, 'onboarding_ops');
const opsGuard = async (req, res) => {
  if (await canOperate(req)) return true;
  res.status(403).json({ error: 'Marking onboarding tasks done and sending joiner emails is for HR Ops, HR and HRBPs.', needs: 'onboarding_ops' });
  return false;
};

// null = everybody (HR). A Set = the HRBP's remit. Lent permissions are
// the gateway's mark that this request is a partner's, not HR's.
async function remitIds(req) {
  if (!req.user.grantedForRequest) return null;
  return new Set(await hrbpScope.employeeIdsFor(T(req), req.user.email, { includeInactive: true }));
}

const audit = (req, action, details) => db.query(
  `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
   VALUES ($1,$2,$3,'onboarding',$4)`,
  [T(req), req.user.email, action, JSON.stringify(details || {})])
  .catch((e) => logger.warn('onboarding audit failed', { action, error: e.message }));

async function holidaySet(tenantId) {
  const r = await db.query(
    `SELECT to_char(holiday_date,'YYYY-MM-DD') d FROM people.onboarding_holidays WHERE tenant_id=$1`, [tenantId]);
  return new Set(r.rows.map((x) => x.d));
}

// Every joiner with every task, statuses computed for `asOf`. One query
// for joiners and one for tasks: the dashboard needs all of it anyway,
// and a joiner count stays in the tens.
async function load(tenantId, asOf, ids, joinerId = null) {
  const holidays = await holidaySet(tenantId);
  const js = (await db.query(
    `SELECT j.id, j.employee_id, to_char(j.doj,'YYYY-MM-DD') doj,
            e.name, e.email, j.personal_email, e.emp_code, e.designation, e.department, e.location, e.status AS employee_status,
            m.name AS manager_name, m.email AS manager_email, b.id AS buddy_id, b.name AS buddy_name, b.email AS buddy_email,
            h.id AS hr_poc_id, h.name AS hr_poc_name, h.email AS hr_poc_email, j.started_by, j.started_at
       FROM people.onboarding_joiners j
       JOIN core.employees e ON e.id = j.employee_id
       LEFT JOIN core.employees m ON m.id = e.manager_id
       LEFT JOIN core.employees b ON b.id = j.buddy_id
       LEFT JOIN core.employees h ON h.id = j.hr_poc_id
      WHERE j.tenant_id=$1 AND ($2::uuid IS NULL OR j.id=$2)
      ORDER BY j.doj DESC, e.name`, [tenantId, joinerId])).rows
    .filter((j) => !ids || ids.has(j.employee_id));
  if (!js.length) return { joiners: [], holidays };

  const ts = (await db.query(
    `SELECT t.id, t.joiner_id, a.id AS activity_id, a.code, a.theme, a.activity, a.owner, a.owner_groups,
            a.process, a.outcome, a.day_offset, a.mandatory, a.ack_required,
            to_char(t.completed_on,'YYYY-MM-DD') completed_on, t.ack_received, t.remarks, t.issue,
            t.action_owner, to_char(t.closure_date,'YYYY-MM-DD') closure_date, t.updated_by, t.updated_at,
            COALESCE(a.spoc_roles, '{}') AS spoc_roles, a.sender_role,
            le.sent_at AS last_emailed_at, le.to_emails AS last_emailed_to, le.outcome AS last_email_outcome,
            le.from_email AS last_emailed_from
       FROM people.onboarding_tasks t
       LEFT JOIN LATERAL (SELECT sent_at, to_emails, outcome, from_email FROM people.onboarding_task_emails x
                           WHERE x.task_id = t.id ORDER BY sent_at DESC LIMIT 1) le ON true
       JOIN people.onboarding_activities a ON a.id = t.activity_id
      WHERE t.tenant_id=$1 AND t.joiner_id = ANY($2::uuid[])
      ORDER BY a.day_offset, a.sort`, [tenantId, js.map((j) => j.id)])).rows;
  const fb = (await db.query(
    `SELECT joiner_id, to_char(feedback_date,'YYYY-MM-DD') feedback_date, ratings, worked_best, improve, open_issue,
            recorded_by, recorded_at
       FROM people.onboarding_feedback WHERE tenant_id=$1 AND joiner_id = ANY($2::uuid[])`,
    [tenantId, js.map((j) => j.id)])).rows;

  const byJoiner = new Map(js.map((j) => [j.id, j]));
  for (const j of js) { j.tasks = []; j.feedback = null; }
  for (const t of ts) {
    const j = byJoiner.get(t.joiner_id);
    t.day = cal.dayLabel(t.day_offset);
    t.planned_date = cal.workday(j.doj, t.day_offset, holidays);
    t.status = cal.taskStatus(t.planned_date, t.completed_on, asOf);
    t.days_overdue = t.status === 'Overdue' ? cal.daysOverdue(t.planned_date, asOf, holidays) : null;
    j.tasks.push(t);
  }
  for (const f of fb) {
    const vals = Object.values(f.ratings || {}).map(Number).filter((n) => n >= 1 && n <= 5);
    f.average = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
    byJoiner.get(f.joiner_id).feedback = f;
  }
  for (const j of js) summarise(j, asOf, holidays);
  return { joiners: js, holidays };
}

// The Joiners sheet's computed columns, for one joiner.
function summarise(j, asOf, holidays) {
  const n = (s) => j.tasks.filter((t) => t.status === s).length;
  j.day7_date = cal.workday(j.doj, 6, holidays);
  const pre = j.tasks.length ? j.tasks.reduce((m, t) => (t.planned_date < m ? t.planned_date : m), j.tasks[0].planned_date) : null;
  j.current_day = cal.currentDay(j.doj, asOf, holidays, pre);
  j.total = j.tasks.length;
  j.completed = n('Completed');
  j.overdue = n('Overdue');
  j.due_today = n('Due Today');
  j.pct = j.total ? Math.round((j.completed / j.total) * 1000) / 10 : 0;
  j.open_issues = j.tasks.filter((t) => t.issue && !t.closure_date).length;
  j.status = !j.total ? 'No tracker rows'
    : j.completed === j.total ? 'Completed'
      : j.overdue ? `${j.overdue} overdue` : 'On track';
  j.feedback_avg = j.feedback ? j.feedback.average : null;
}

// The Dashboard sheet, over whichever joiners the caller may see.
function dashboard(joiners) {
  const all = joiners.flatMap((j) => j.tasks);
  const owners = new Map();
  for (const t of all) {
    for (const g of (t.owner_groups.length ? t.owner_groups : [t.owner])) {
      const o = owners.get(g) || { owner: g, overdue: 0, due_today: 0, completed: 0, total: 0 };
      o.total += 1;
      if (t.status === 'Overdue') o.overdue += 1;
      if (t.status === 'Due Today') o.due_today += 1;
      if (t.status === 'Completed') o.completed += 1;
      owners.set(g, o);
    }
  }
  const byDay = cal.DAY_ORDER.map((day) => {
    const ts = all.filter((t) => t.day === day);
    const completed = ts.filter((t) => t.status === 'Completed').length;
    return {
      day, total: ts.length, completed,
      overdue: ts.filter((t) => t.status === 'Overdue').length,
      pct: ts.length ? Math.round((completed / ts.length) * 1000) / 10 : null,
    };
  });
  const rated = joiners.filter((j) => j.feedback_avg != null);
  const done = all.filter((t) => t.status === 'Completed').length;
  return {
    kpis: {
      in_onboarding: joiners.filter((j) => j.status !== 'Completed').length,
      completed_joiners: joiners.filter((j) => j.status === 'Completed').length,
      due_today: all.filter((t) => t.status === 'Due Today').length,
      overdue: all.filter((t) => t.status === 'Overdue').length,
      open_issues: all.filter((t) => t.issue && !t.closure_date).length,
      feedback_avg: rated.length
        ? Math.round((rated.reduce((a, j) => a + j.feedback_avg, 0) / rated.length) * 100) / 100 : null,
      feedback_count: rated.length,
      completion_pct: all.length ? Math.round((done / all.length) * 1000) / 10 : null,
    },
    by_owner: [...owners.values()].sort((a, b) => b.overdue - a.overdue || b.total - a.total),
    by_day: byDay,
  };
}

const asOfFrom = (req) => (ISO.test(String(req.query.asOf || '')) ? req.query.asOf : today());

// ---- reads -----------------------------------------------------------------

router.get('/', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const asOf = asOfFrom(req);
    const { joiners } = await load(T(req), asOf, await remitIds(req));
    const days = (await db.query(
      `SELECT day_label AS day, theme, question, answer FROM people.onboarding_days WHERE tenant_id=$1 ORDER BY sort`,
      [T(req)])).rows;
    // The list leaves the tasks behind — the screen opens one joiner at a
    // time, and 48 rows x every joiner is most of the payload for nothing.
    const list = joiners.map(({ tasks, ...j }) => j);
    res.json({ as_of: asOf, timezone: TZ, days, joiners: list, ...dashboard(joiners) });
  } catch (e) { logger.error('onboarding dashboard', { error: e.message }); res.status(500).json({ error: 'Could not load the onboarding tracker.' }); }
});

router.get('/joiners/:id', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const asOf = asOfFrom(req);
    const { joiners } = await load(T(req), asOf, await remitIds(req), req.params.id);
    if (!joiners.length) return res.status(404).json({ error: 'No such joiner on your tracker.' });
    const questions = (await db.query(
      `SELECT code, statement FROM people.onboarding_feedback_questions WHERE tenant_id=$1 ORDER BY sort`, [T(req)])).rows;
    // Tasks ride INSIDE the joiner, so if the gateway ever removes the
    // joiner as outside a remit, their tasks go with them.
    res.json({ as_of: asOf, joiner: joiners[0], questions, can_operate: await canOperate(req) });
  } catch (e) { logger.error('onboarding joiner', { error: e.message }); res.status(500).json({ error: 'Could not load this joiner.' }); }
});

// People in the master who have joined recently or are about to, and are
// not on the tracker yet. The one-click way on: the employee import has
// already done the typing.
router.get('/candidates', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const ids = await remitIds(req);
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, e.emp_code, e.designation, e.department, e.location,
              to_char(e.date_of_joining,'YYYY-MM-DD') date_of_joining, m.name AS manager_name
         FROM core.employees e
         LEFT JOIN core.employees m ON m.id = e.manager_id
        WHERE e.tenant_id=$1 AND e.status='active' AND e.archived_at IS NULL
          AND e.date_of_joining BETWEEN ($2::date - 21) AND ($2::date + 45)
          AND NOT EXISTS (SELECT 1 FROM people.onboarding_joiners j WHERE j.tenant_id=e.tenant_id AND j.employee_id=e.id)
        ORDER BY e.date_of_joining DESC, e.name`, [T(req), today()]);
    res.json({ candidates: r.rows.filter((c) => !ids || ids.has(c.employee_id)) });
  } catch (e) { logger.error('onboarding candidates', { error: e.message }); res.status(500).json({ error: 'Could not list new joiners.' }); }
});

// The picker for a buddy, an HR POC, or a joiner outside the candidate
// window. Names and departments only — no address, so it is a colleague
// list rather than a directory, and a buddy may come from another
// partner's remit (the gateway leaves rows without an address alone).
router.get('/people', async (req, res) => {
  if (!(await guard(req, res))) return;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ people: [] });
  try {
    const r = await db.query(
      `SELECT e.id, e.name, e.emp_code, e.designation, e.department,
              to_char(e.date_of_joining,'YYYY-MM-DD') date_of_joining,
              EXISTS (SELECT 1 FROM people.onboarding_joiners j WHERE j.tenant_id=e.tenant_id AND j.employee_id=e.id) AS tracked
         FROM core.employees e
        WHERE e.tenant_id=$1 AND e.status='active' AND e.archived_at IS NULL
          AND (e.name ILIKE $2 OR e.emp_code ILIKE $2)
        ORDER BY e.name LIMIT 20`, [T(req), `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`]);
    res.json({ people: r.rows });
  } catch (e) { logger.error('onboarding people', { error: e.message }); res.status(500).json({ error: 'Could not search.' }); }
});

router.get('/activities', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const r = await db.query(
      `SELECT id, code, theme, activity, owner, owner_groups, sender_role, process, outcome, day_offset, mandatory, ack_required, active
         FROM people.onboarding_activities WHERE tenant_id=$1 ORDER BY day_offset, sort`, [T(req)]);
    res.json({ activities: r.rows.map((a) => ({ ...a, day: cal.dayLabel(a.day_offset) })) });
  } catch (e) { logger.error('onboarding activities', { error: e.message }); res.status(500).json({ error: 'Could not load the activity matrix.' }); }
});

router.get('/holidays', async (req, res) => {
  if (!(await guard(req, res))) return;
  const r = await db.query(
    `SELECT to_char(holiday_date,'YYYY-MM-DD') date, name FROM people.onboarding_holidays
      WHERE tenant_id=$1 ORDER BY holiday_date`, [T(req)]);
  res.json({ holidays: r.rows });
});

// ---- writes ----------------------------------------------------------------

const employeeExists = async (tenantId, id) => !!id && (await db.query(
  `SELECT 1 FROM core.employees WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows.length;

router.post('/joiners', async (req, res) => {
  if (!(await guard(req, res))) return;
  const { employee_id: employeeId, doj, buddy_id: buddyId, hr_poc_id: hrPocId } = req.body || {};
  const client = await db.getClient();
  try {
    const emp = (await client.query(
      `SELECT id, name, to_char(date_of_joining,'YYYY-MM-DD') doj FROM core.employees WHERE tenant_id=$1 AND id=$2`,
      [T(req), employeeId])).rows[0];
    if (!emp) return res.status(400).json({ error: 'Choose the joiner from the employee master.' });
    const date = doj || emp.doj;
    if (!ISO.test(String(date || ''))) {
      return res.status(400).json({ error: `${emp.name} has no date of joining in the employee master — enter one.` });
    }
    for (const [label, id] of [['Buddy', buddyId], ['HR POC', hrPocId]]) {
      if (id && !(await employeeExists(T(req), id))) return res.status(400).json({ error: `${label} is not in the employee master.` });
    }
    if (buddyId && buddyId === employeeId) return res.status(400).json({ error: 'A joiner cannot be their own buddy.' });

    await client.query('BEGIN');
    const j = (await client.query(
      `INSERT INTO people.onboarding_joiners (tenant_id, employee_id, doj, buddy_id, hr_poc_id, started_by)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, employee_id) DO NOTHING RETURNING id`,
      [T(req), employeeId, date, buddyId || null, hrPocId || null, req.user.email])).rows[0];
    if (!j) { await client.query('ROLLBACK'); return res.status(409).json({ error: `${emp.name} is already on the tracker.` }); }
    const n = (await client.query(
      `INSERT INTO people.onboarding_tasks (tenant_id, joiner_id, activity_id)
       SELECT $1, $2, id FROM people.onboarding_activities WHERE tenant_id=$1 AND active`,
      [T(req), j.id])).rowCount;
    await client.query('COMMIT');
    audit(req, 'onboarding_start', { joiner_id: j.id, employee_id: employeeId, doj: date, tasks: n });
    res.status(201).json({ id: j.id, tasks: n });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('onboarding start', { error: e.message });
    res.status(500).json({ error: 'Could not start the tracker.' });
  } finally { client.release(); }
});

router.patch('/joiners/:id', async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  const sets = []; const vals = [T(req), req.params.id];
  if (b.doj !== undefined) {
    if (!ISO.test(String(b.doj))) return res.status(400).json({ error: 'Date of joining must be a date.' });
    vals.push(b.doj); sets.push(`doj=$${vals.length}`);
  }
  if (b.personal_email !== undefined) {
    const pe = String(b.personal_email || '').trim();
    if (pe && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(pe)) return res.status(400).json({ error: `"${pe}" is not an email address.` });
    vals.push(pe || null); sets.push(`personal_email=$${vals.length}`);
  }
  for (const [k, label] of [['buddy_id', 'Buddy'], ['hr_poc_id', 'HR POC']]) {
    if (b[k] === undefined) continue;
    if (b[k] && !(await employeeExists(T(req), b[k]))) return res.status(400).json({ error: `${label} is not in the employee master.` });
    vals.push(b[k] || null); sets.push(`${k}=$${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  try {
    const r = await db.query(`UPDATE people.onboarding_joiners SET ${sets.join(', ')} WHERE tenant_id=$1 AND id=$2`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'No such joiner.' });
    audit(req, 'onboarding_joiner_update', { joiner_id: req.params.id, ...b });
    res.json({ ok: true });
  } catch (e) { logger.error('onboarding joiner update', { error: e.message }); res.status(500).json({ error: 'Could not save.' }); }
});

router.delete('/joiners/:id', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const r = await db.query(`DELETE FROM people.onboarding_joiners WHERE tenant_id=$1 AND id=$2 RETURNING employee_id`,
      [T(req), req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'No such joiner.' });
    audit(req, 'onboarding_remove', { joiner_id: req.params.id, employee_id: r.rows[0].employee_id });
    res.json({ ok: true });
  } catch (e) { logger.error('onboarding remove', { error: e.message }); res.status(500).json({ error: 'Could not remove.' }); }
});

const TASK_FIELDS = {
  completed_on: 'date', ack_received: 'bool', remarks: 'text', issue: 'text', action_owner: 'text', closure_date: 'date',
};

router.patch('/tasks/:id', async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  if ((b.completed_on !== undefined || b.ack_received !== undefined) && !(await opsGuard(req, res))) return;
  const sets = []; const vals = [T(req), req.params.id];
  for (const [k, kind] of Object.entries(TASK_FIELDS)) {
    if (b[k] === undefined) continue;
    let v = b[k] === '' ? null : b[k];
    if (v !== null && kind === 'date' && !ISO.test(String(v))) return res.status(400).json({ error: `${k.replace('_', ' ')} must be a date.` });
    if (v !== null && kind === 'date' && v > today()) return res.status(400).json({ error: 'A completion or closure date cannot be in the future.' });
    if (v !== null && kind === 'bool') v = !!v;
    if (v !== null && kind === 'text') v = String(v).slice(0, 2000);
    vals.push(v); sets.push(`${k}=$${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });
  vals.push(req.user.email);
  try {
    const r = await db.query(
      `UPDATE people.onboarding_tasks SET ${sets.join(', ')}, updated_by=$${vals.length}, updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING joiner_id`, vals);
    if (!r.rowCount) return res.status(404).json({ error: 'No such task.' });
    audit(req, 'onboarding_task', { task_id: req.params.id, ...b });
    res.json({ ok: true });
  } catch (e) { logger.error('onboarding task', { error: e.message }); res.status(500).json({ error: 'Could not save.' }); }
});

// Mark several of one joiner's tasks done at once — a day's worth, usually.
router.post('/joiners/:id/complete', async (req, res) => {
  if (!(await guard(req, res)) || !(await opsGuard(req, res))) return;
  const { task_ids: taskIds, completed_on: on } = req.body || {};
  const date = on || today();
  if (!Array.isArray(taskIds) || !taskIds.length) return res.status(400).json({ error: 'No tasks chosen.' });
  if (!ISO.test(String(date)) || date > today()) return res.status(400).json({ error: 'Completion date must be today or earlier.' });
  try {
    const r = await db.query(
      `UPDATE people.onboarding_tasks SET completed_on=$4, updated_by=$5, updated_at=now()
        WHERE tenant_id=$1 AND joiner_id=$2 AND id = ANY($3::uuid[]) AND completed_on IS NULL`,
      [T(req), req.params.id, taskIds, date, req.user.email]);
    audit(req, 'onboarding_complete', { joiner_id: req.params.id, tasks: r.rowCount, completed_on: date });
    res.json({ updated: r.rowCount });
  } catch (e) { logger.error('onboarding bulk complete', { error: e.message }); res.status(500).json({ error: 'Could not save.' }); }
});

router.put('/joiners/:id/feedback', async (req, res) => {
  if (!(await guard(req, res))) return;
  const b = req.body || {};
  const date = b.feedback_date || today();
  if (!ISO.test(String(date))) return res.status(400).json({ error: 'Feedback date must be a date.' });
  try {
    const codes = (await db.query(
      `SELECT code FROM people.onboarding_feedback_questions WHERE tenant_id=$1`, [T(req)])).rows.map((r) => r.code);
    const ratings = {};
    for (const c of codes) {
      const v = b.ratings ? b.ratings[c] : undefined;
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return res.status(400).json({ error: `${c} must be a whole number from 1 to 5.` });
      ratings[c] = n;
    }
    if (!Object.keys(ratings).length) return res.status(400).json({ error: 'Rate at least one statement.' });
    const ok = (await db.query(`SELECT 1 FROM people.onboarding_joiners WHERE tenant_id=$1 AND id=$2`, [T(req), req.params.id])).rows.length;
    if (!ok) return res.status(404).json({ error: 'No such joiner.' });
    await db.query(
      `INSERT INTO people.onboarding_feedback (tenant_id, joiner_id, feedback_date, ratings, worked_best, improve, open_issue, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (joiner_id) DO UPDATE SET feedback_date=EXCLUDED.feedback_date, ratings=EXCLUDED.ratings,
         worked_best=EXCLUDED.worked_best, improve=EXCLUDED.improve, open_issue=EXCLUDED.open_issue,
         recorded_by=EXCLUDED.recorded_by, recorded_at=now()`,
      [T(req), req.params.id, date, JSON.stringify(ratings), b.worked_best || null, b.improve || null, b.open_issue || null, req.user.email]);
    audit(req, 'onboarding_feedback', { joiner_id: req.params.id, ratings });
    res.json({ ok: true });
  } catch (e) { logger.error('onboarding feedback', { error: e.message }); res.status(500).json({ error: 'Could not save feedback.' }); }
});

// Holidays apply to everybody's plan, so they are HR's alone — the
// gateway refuses an HRBP write here (TENANT_WIDE).
// ---- emailing the SPOC of a task --------------------------------------------

async function directoryFor(tenantId) {
  const r = await db.query(`SELECT role, name, email FROM people.onboarding_spocs WHERE tenant_id=$1`, [tenantId]);
  return Object.fromEntries(r.rows.map((x) => [x.role, { name: x.name, email: x.email }]));
}

// One task, with its joiner, for the email routes — through load(), so
// the remit, the planned date and the status are exactly the screen's.
async function taskWithJoiner(req, taskId) {
  const t = (await db.query(`SELECT joiner_id FROM people.onboarding_tasks WHERE tenant_id=$1 AND id=$2`, [T(req), taskId])).rows[0];
  if (!t) return null;
  const { joiners } = await load(T(req), today(), await remitIds(req), t.joiner_id);
  if (!joiners.length) return null;
  const task = joiners[0].tasks.find((x) => x.id === taskId);
  return task ? { task, joiner: joiners[0] } : null;
}

// The SPOC directory: every role, with the address HR set for it. The
// joiner-specific roles are listed so the screen can say where they come
// from, and are not editable here.
router.get('/spocs', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const dir = await directoryFor(T(req));
    res.json({ spocs: ROLES.map((role) => ({
      role, per_joiner: PER_JOINER.includes(role),
      name: dir[role] ? dir[role].name : null, email: dir[role] ? dir[role].email : null,
      note: role === 'Manager' ? "The joiner's reporting manager, from the employee master"
        : role === 'Buddy' ? 'The buddy chosen for each joiner'
          : role === 'HR' ? "The joiner's HR POC when one is chosen; this address otherwise" : null,
    })) });
  } catch (e) { logger.error('onboarding spocs', { error: e.message }); res.status(500).json({ error: 'Could not load the SPOCs.' }); }
});

router.put('/spocs/:role', async (req, res) => {
  if (!(await guard(req, res))) return;
  const role = String(req.params.role);
  if (!ROLES.includes(role) || PER_JOINER.includes(role)) return res.status(400).json({ error: `${role} is not a SPOC role set here.` });
  const email = String((req.body || {}).email || '').trim();
  const name = String((req.body || {}).name || '').trim() || null;
  try {
    if (!email) {
      await db.query(`DELETE FROM people.onboarding_spocs WHERE tenant_id=$1 AND role=$2`, [T(req), role]);
    } else {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: `"${email}" is not an email address.` });
      await db.query(
        `INSERT INTO people.onboarding_spocs (tenant_id, role, name, email, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, role) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email,
           updated_by=EXCLUDED.updated_by, updated_at=now()`, [T(req), role, name, email, req.user.email]);
    }
    audit(req, 'onboarding_spoc', { role, email: email || null, name });
    res.json({ ok: true });
  } catch (e) { logger.error('onboarding spoc save', { error: e.message }); res.status(500).json({ error: 'Could not save.' }); }
});

// THE JOINER'S EMAIL for one task: FROM the SPOC who owns the activity,
// TO the joiner (see migration 083 and onboarding-spoc.js).
//
// How it leaves: FROM THE SPOC'S OWN ADDRESS, always (decided 7 Oct —
// there used to be a choice of "the PMS mailbox on behalf of the SPOC").
// The PMS mailbox set under HR → Settings → Email signs in to the mail
// server and sends AS the SPOC, which needs IT to grant that mailbox
// Send-As rights for each SPOC address once. Without them the server
// refuses, and the tracker shows the refusal in words (core/mail.js
// explain) — nothing is quietly sent under another name instead.

async function emailPlan(req, taskId) {
  const tj = await taskWithJoiner(req, taskId);
  if (!tj) return null;
  const from = spoc.sender(tj.task.sender_role, tj.joiner, await directoryFor(T(req)));
  const to = spoc.joinerAddress(tj.task, tj.joiner);
  return { ...tj, from, to };
}

router.get('/tasks/:id/email', async (req, res) => {
  if (!(await guard(req, res))) return;
  try {
    const p = await emailPlan(req, req.params.id);
    if (!p) return res.status(404).json({ error: 'No such task on your tracker.' });
    const history = (await db.query(
      `SELECT to_emails, from_email, subject, mode, outcome, sent_by, sent_at FROM people.onboarding_task_emails
        WHERE tenant_id=$1 AND task_id=$2 ORDER BY sent_at DESC LIMIT 10`, [T(req), req.params.id])).rows;
    // 'simulated' is the product's safe default until HR turns live mail
    // on, and the screen must say so: an email that was only logged must
    // not look sent.
    res.json({
      from: p.from, to: p.to ? { name: p.joiner.name, ...p.to } : null,
      to_missing: p.to ? null : `${p.joiner.name} has no email address — add a personal email on this joiner.`,
      ...spoc.draft(p.task, p.joiner, p.from.missing ? null : p.from),
      history, mail_mode: await sendMode(T(req)),
      can_send: await canOperate(req),
    });
  } catch (e) { logger.error('onboarding email draft', { error: e.message }); res.status(500).json({ error: 'Could not prepare the email.' }); }
});

// Send it. Sender and recipient are worked out here, never taken from the
// body: an address typed into a request is not one this task produced.
router.post('/tasks/:id/email', async (req, res) => {
  if (!(await guard(req, res)) || !(await opsGuard(req, res))) return;
  const b = req.body || {};
  const subject = String(b.subject || '').trim().slice(0, 300);
  const body = String(b.body || '').trim().slice(0, 8000);
  if (!subject || !body) return res.status(400).json({ error: 'The email needs a subject and a message.' });
  try {
    const p = await emailPlan(req, req.params.id);
    if (!p) return res.status(404).json({ error: 'No such task on your tracker.' });
    if (p.from.missing) return res.status(400).json({ error: p.from.missing });
    if (!p.to) return res.status(400).json({ error: `${p.joiner.name} has no email address — add a personal email on this joiner.` });
    const { explain } = require('../../core/mail');
    const quoted = (n) => `"${String(n || '').replace(/["\\]/g, '')}"`;
    const r = await sendMail(T(req), {
      to: p.to.email, subject, html: spoc.toHtml(body), kind: 'onboarding_task',
      from: `${quoted(p.from.name)} <${p.from.email}>`, replyTo: p.from.email,
    });
    await db.query(
      `INSERT INTO people.onboarding_task_emails (tenant_id, task_id, to_emails, from_email, sender_role, subject, mode, outcome, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [T(req), req.params.id, [p.to.email], p.from.email, p.from.role, subject, r.mode, r.outcome, req.user.email]);
    audit(req, 'onboarding_task_email', { task_id: req.params.id, to: p.to.email, from: p.from.email, outcome: r.outcome });
    res.json({ to: p.to.email, from: p.from.email, mode: r.mode, outcome: r.outcome, detail: r.detail || null,
      hint: r.outcome === 'failed' ? explain(r.detail) : null });
  } catch (e) { logger.error('onboarding email send', { error: e.message }); res.status(500).json({ error: 'Could not send the email.' }); }
});

router.post('/holidays', async (req, res) => {
  if (!(await guard(req, res))) return;
  const { date, name } = req.body || {};
  if (!ISO.test(String(date || '')) || !String(name || '').trim()) return res.status(400).json({ error: 'A holiday needs a date and a name.' });
  try {
    await db.query(
      `INSERT INTO people.onboarding_holidays (tenant_id, holiday_date, name) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, holiday_date) DO UPDATE SET name=EXCLUDED.name`, [T(req), date, String(name).trim()]);
    audit(req, 'onboarding_holiday_add', { date, name });
    res.json({ ok: true });
  } catch (e) { logger.error('onboarding holiday', { error: e.message }); res.status(500).json({ error: 'Could not save the holiday.' }); }
});

router.delete('/holidays/:date', async (req, res) => {
  if (!(await guard(req, res))) return;
  if (!ISO.test(req.params.date)) return res.status(400).json({ error: 'Not a date.' });
  const r = await db.query(`DELETE FROM people.onboarding_holidays WHERE tenant_id=$1 AND holiday_date=$2`, [T(req), req.params.date]);
  audit(req, 'onboarding_holiday_remove', { date: req.params.date });
  res.json({ removed: r.rowCount });
});

module.exports = { router, summarise, dashboard, load };
