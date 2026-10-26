// Timesheet approvals (26 Oct).
//
// "Once uploaded by HR, manager should have approval option for editing
// ratings generated per system and approve timesheet uploaded on system.
// In case manager is not approving the timesheet after cutoff time, these
// data should be received on upper level manager as per reporting matrix
// ... For manager there will be one system generated KRA title as
// 'Timesheet Approval', in case if timesheet for reportees are not
// approved by managers before cutoff time, their ratings will considered
// by default as 'B'." With the client's answers the same day:
//
//   CUTOFF        N working days after HR's upload (HR sets N, default 5).
//                 Past it the month is ESCALATED to the manager's manager
//                 (copied in at upload), who has N more. Past that it is
//                 NOT APPROVED. HR / Super Admin and the person's HRBP may
//                 approve at any time; the manager may still approve late.
//   WHO APPROVES  the direct manager; the upper manager once escalated;
//                 an HRBP for people in their remit; HR and Super Admin.
//                 Nobody approves their own timesheet.
//   EDITING       before approving, the approver may change the system's
//                 rating of any KRA for the month, and the month's average,
//                 each with a reason. The system figures stay beside them.
//   A MISSED      the employee keeps the system's rating. It is the
//   CUTOFF        manager's "Timesheet Approval" KRA that shows it:
//                 every reportee approved by the manager in time A, none B,
//                 some B+ (the client named the two ends; B+ is the middle,
//                 and is named on screen).
//   THE KRA       "Timesheet Approval", a fixed 10% of the manager's sheet,
//                 added by HR from the approvals panel (the other KRAs are
//                 scaled to 90%). Rated from this table, never from hours.
//
// The status is computed at read time from the dates, so a cutoff passing
// needs no job to take effect; the daily sweep only sends the escalation
// notice (once, guarded by escalation_notified_at).
const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { holdsPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { cycleOf, key } = require('./timesheet-rules');
const { activeCycle } = require('./active-cycle');

const router = express.Router();
const T = (req) => req.user.tenant_id;
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const KRA_TITLE = 'Timesheet Approval';
const KRA_KIND = 'timesheet_approval';
const KRA_WEIGHT = 10;
const RATINGS = ['A+', 'A', 'B+', 'B'];
const DEFAULT_CUTOFF_DAYS = 5;

// Today in the company's time zone — a cutoff is a date people read on
// their own calendar, not UTC's.
const todayIso = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// ---------------------------------------------------------------------------
// Pure rules

// The date n working days after `fromIso` (Mon–Fri, less holidays). The
// upload day itself does not count: uploaded Monday, 5 days is next Monday.
function addWorkingDays(fromIso, n, holidays = []) {
  const hol = new Set(holidays || []);
  let t = Date.parse(`${fromIso}T00:00:00Z`);
  let left = Math.max(0, Number(n) || 0);
  while (left > 0) {
    t += 86400000;
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !hol.has(iso)) left -= 1;
  }
  return new Date(t).toISOString().slice(0, 10);
}

// approved | pending (with the manager) | escalated (with the upper
// manager) | lapsed (nobody approved in time).
function statusOf(row, today = todayIso()) {
  if (row.status === 'approved') return 'approved';
  if (today <= row.due_on) return 'pending';
  if (row.upper_manager_id && today <= row.escalation_due_on) return 'escalated';
  return 'lapsed';
}

// The manager's "Timesheet Approval" KRA for one month: the reportee
// months whose clock ran for this manager. Null while any of them can
// still be approved in time — the month is not decided yet.
function approvalRating(rows, today = todayIso()) {
  if (!rows.length) return null;
  const onTime = rows.filter((r) => r.on_time_by_manager).length;
  const awaiting = rows.filter((r) => r.status !== 'approved' && today <= r.due_on).length;
  const base = { on_time: onTime, total: rows.length, awaiting };
  if (awaiting) return { ...base, rating: null };
  return { ...base, rating: onTime === rows.length ? 'A' : onTime === 0 ? 'B' : 'B+' };
}

// ---------------------------------------------------------------------------
// Settings: the cutoff in working days lives in the timesheet settings blob.
async function cutoffDays(tenantId) {
  const row = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [tenantId])).rows[0];
  const v = (row && row.value) || {};
  const n = Number(v.approval_cutoff_days);
  return { days: Number.isInteger(n) && n >= 1 && n <= 30 ? n : DEFAULT_CUTOFF_DAYS,
    holidays: Array.isArray(v.holidays) ? v.holidays : [], startDay: Number(v.cycle_start_day) || 21 };
}

// ---------------------------------------------------------------------------
// On upload: open (or re-open) a month for each person the file touched.
//
// A month already approved and uploaded again goes back to pending with a
// new clock — the manager approved other data. A month still pending keeps
// its clock: uploading again does not buy the manager more time.
async function recordUpload(tenantId, logsByEmployee, actorEmail) {
  const cfg = await cutoffDays(tenantId);
  const today = todayIso();
  const due = addWorkingDays(today, cfg.days, cfg.holidays);
  const escDue = addWorkingDays(due, cfg.days, cfg.holidays);
  const opened = [];
  for (const [employeeId, dates] of logsByEmployee) {
    const emp = (await db.query(
      `SELECT e.id, e.name, e.manager_id, m.manager_id AS upper_id
         FROM core.employees e LEFT JOIN core.employees m ON m.id = e.manager_id
        WHERE e.tenant_id=$1 AND e.id=$2`, [tenantId, employeeId])).rows[0];
    if (!emp) continue;
    const periods = new Map();
    for (const iso of dates) {
      const [y, mo, d] = iso.split('-').map(Number);
      const c = cycleOf(new Date(y, mo - 1, d), cfg.startDay);
      periods.set(key(c.start), key(c.end));
    }
    for (const [start, end] of periods) {
      const prev = (await db.query(
        `SELECT id, status FROM pms.timesheet_approvals WHERE tenant_id=$1 AND employee_id=$2 AND period_start=$3::date`,
        [tenantId, employeeId, start])).rows[0];
      if (prev && prev.status === 'pending') continue;
      const row = (await db.query(
        `INSERT INTO pms.timesheet_approvals
           (tenant_id, employee_id, period_start, period_end, status, uploaded_at,
            manager_id, due_on, upper_manager_id, escalation_due_on)
         VALUES ($1,$2,$3::date,$4::date,'pending',now(),$5,$6::date,$7,$8::date)
         ON CONFLICT (tenant_id, employee_id, period_start) DO UPDATE SET
           status='pending', uploaded_at=now(), manager_id=EXCLUDED.manager_id, due_on=EXCLUDED.due_on,
           upper_manager_id=EXCLUDED.upper_manager_id, escalation_due_on=EXCLUDED.escalation_due_on,
           approved_at=NULL, approved_by_id=NULL, approved_by_email=NULL, approved_as=NULL,
           on_time_by_manager=false, kra_overrides='{}'::jsonb, month_override=NULL, note=NULL,
           escalation_notified_at=NULL, updated_at=now()
         RETURNING id`,
        [tenantId, employeeId, start, end, emp.manager_id, due, emp.upper_id, escDue])).rows[0];
      opened.push({ id: row.id, employee: emp, period_start: start, period_end: end, reopened: !!prev });
    }
  }
  // One notice per manager, naming everybody waiting on them.
  const byManager = new Map();
  for (const o of opened) {
    if (!o.employee.manager_id) continue;
    if (!byManager.has(o.employee.manager_id)) byManager.set(o.employee.manager_id, []);
    byManager.get(o.employee.manager_id).push(o);
  }
  for (const [managerId, list] of byManager) {
    const names = [...new Set(list.map((o) => o.employee.name))];
    await notify(tenantId, managerId, 'timesheet_approval',
      `Timesheets to approve: ${names.length} ${names.length === 1 ? 'person' : 'people'}`,
      `HR uploaded timesheets for ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}. `
        + `Review the ratings and approve by ${due}; after that they go to your manager.`,
      '/team/timesheet', { email: true }).catch((e) => logger.warn('approval notice failed', { error: e.message }));
  }
  if (opened.length) logger.info('timesheet approvals opened', { count: opened.length, by: actorEmail });
  return { opened: opened.length, due_on: due, escalation_due_on: escDue };
}

// ---------------------------------------------------------------------------
// Who may act on a row, and as what. Checked by the route itself: these
// routes are on the HRBP gateway's self-service list, so an HRBP who is
// also somebody's manager approves their own reportees here too.
async function roleFor(req, row, today = todayIso()) {
  if (row.employee_id === req.user.id) return null;
  if (await holdsPermission(req.user, 'pms_admin')) return 'hr';
  if (row.manager_id === req.user.id || row.current_manager_id === req.user.id) return 'manager';
  const st = statusOf(row, today);
  if (row.upper_manager_id === req.user.id && (st === 'escalated' || st === 'lapsed')) return 'upper_manager';
  if (await holdsPermission(req.user, 'pms_hrbp')) {
    const { hrbpScope } = require('../people');
    const ids = new Set(await hrbpScope.employeeIdsFor(T(req), req.user.email, { includeInactive: true }));
    if (ids.has(row.employee_id)) return 'hrbp';
  }
  return null;
}

const ROW = `a.id, a.employee_id, to_char(a.period_start,'YYYY-MM-DD') AS period_start,
  to_char(a.period_end,'YYYY-MM-DD') AS period_end, a.status, a.uploaded_at,
  a.manager_id, to_char(a.due_on,'YYYY-MM-DD') AS due_on, a.upper_manager_id,
  to_char(a.escalation_due_on,'YYYY-MM-DD') AS escalation_due_on, a.approved_at, a.approved_by_email,
  a.approved_as, a.on_time_by_manager, a.kra_overrides, a.month_override, a.note,
  e.name, e.email, e.emp_code, e.department, e.designation, e.manager_id AS current_manager_id,
  m.name AS manager_name, u.name AS upper_manager_name`;
const FROM = `FROM pms.timesheet_approvals a
  JOIN core.employees e ON e.id = a.employee_id
  LEFT JOIN core.employees m ON m.id = a.manager_id
  LEFT JOIN core.employees u ON u.id = a.upper_manager_id`;

const shape = (r, today, role) => ({
  id: r.id,
  employee: { id: r.employee_id, name: r.name, email: r.email, emp_code: r.emp_code, department: r.department, designation: r.designation },
  period_start: r.period_start, period_end: r.period_end,
  status: statusOf(r, today),
  uploaded_at: r.uploaded_at,
  manager: r.manager_id ? { id: r.manager_id, name: r.manager_name } : null,
  upper_manager: r.upper_manager_id ? { id: r.upper_manager_id, name: r.upper_manager_name } : null,
  due_on: r.due_on, escalation_due_on: r.escalation_due_on,
  approved_at: r.approved_at, approved_by_email: r.approved_by_email, approved_as: r.approved_as,
  on_time_by_manager: r.on_time_by_manager,
  kra_overrides: r.kra_overrides || {}, month_override: r.month_override || null, note: r.note,
  hours: r.hours == null ? null : Number(r.hours),
  can_act_as: role,
});

// GET /pms/timesheet/approvals — what the caller may see and act on.
//   ?scope=team  as a manager (and upper manager): the default on Team Timesheet
//   ?scope=all   as HR (everyone) or HRBP (their remit)
//   ?status=open (default: not approved) | all
router.get('/', async (req, res) => {
  try {
    const today = todayIso();
    const all = req.query.scope === 'all';
    const hr = await holdsPermission(req.user, 'pms_admin');
    const hrbp = !hr && await holdsPermission(req.user, 'pms_hrbp');
    let remit = [];
    if (all && hrbp) {
      const { hrbpScope } = require('../people');
      remit = await hrbpScope.employeeIdsFor(T(req), req.user.email, { includeInactive: true });
    }
    const params = [T(req), req.user.id];
    let who;
    if (all && hr) who = 'true';
    else if (all && hrbp) { params.push(remit); who = `a.employee_id = ANY($${params.length}::uuid[])`; }
    else who = '(a.manager_id = $2 OR e.manager_id = $2 OR a.upper_manager_id = $2)';
    const rows = (await db.query(
      `SELECT ${ROW},
              (SELECT round(sum(t.hours)::numeric,2) FROM pms.timesheet_entries t
                WHERE t.tenant_id=a.tenant_id AND t.employee_id=a.employee_id
                  AND t.log_date BETWEEN a.period_start AND a.period_end) AS hours
         ${FROM}
        WHERE a.tenant_id=$1 AND a.employee_id <> $2 AND ${who}
        ORDER BY a.period_start DESC, e.name`, params)).rows;
    const out = [];
    for (const r of rows) {
      // An upper manager sees a month only once it reaches them.
      const mine = r.manager_id === req.user.id || r.current_manager_id === req.user.id;
      const st = statusOf(r, today);
      if (!all && !mine && !(st === 'escalated' || st === 'lapsed' || (st === 'approved' && r.approved_as === 'upper_manager'))) continue;
      out.push(shape(r, today, await roleFor(req, r, today)));
    }
    const list = req.query.status === 'all' ? out : out.filter((x) => x.status !== 'approved');
    const counts = { pending: 0, escalated: 0, lapsed: 0, approved: 0 };
    for (const x of out) counts[x.status] += 1;
    const cfg = await cutoffDays(T(req));
    res.json({ approvals: list, counts, cutoff_days: cfg.days, today, as: all ? (hr ? 'hr' : hrbp ? 'hrbp' : 'none') : 'manager' });
  } catch (e) {
    logger.error('timesheet approvals list', { error: e.message });
    res.status(500).json({ error: 'Could not list the timesheet approvals' });
  }
});

// GET /pms/timesheet/approvals/:id — one month to review: the system's
// rating of each KRA for the month, and any edits already made.
router.get('/:id', async (req, res) => {
  try {
    const today = todayIso();
    const r = (await db.query(`SELECT ${ROW} ${FROM} WHERE a.tenant_id=$1 AND a.id=$2`, [T(req), req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'No such timesheet approval' });
    const role = await roleFor(req, r, today);
    if (!role && r.employee_id !== req.user.id) return res.status(403).json({ error: 'You cannot open this timesheet approval' });
    const { reportFor } = require('./timesheet-kra');
    const target = (await db.query(
      `SELECT e.id, e.emp_code, e.name, e.email, e.department, e.designation, e.manager_id,
              to_char(e.date_of_joining,'YYYY-MM-DD') AS date_of_joining
         FROM core.employees e WHERE e.tenant_id=$1 AND e.id=$2`, [T(req), r.employee_id])).rows[0];
    const rep = await reportFor(req, target, { from: r.period_start, to: r.period_end });
    res.json({
      approval: shape(r, today, role),
      kra_ratings: rep.kra_ratings, totals: rep.totals, compliance: rep.compliance,
      bands: (rep.kra_ratings && rep.kra_ratings.bands) || RATINGS.map((l) => ({ label: l })),
    });
  } catch (e) {
    logger.error('timesheet approval read', { error: e.message });
    res.status(500).json({ error: 'Could not open the timesheet approval' });
  }
});

// POST /pms/timesheet/approvals/:id/approve
//   { kra_overrides: { <kra_id>: { rating, reason } }, month_override: { rating, reason } | null, note }
router.post('/:id/approve', async (req, res) => {
  try {
    const today = todayIso();
    const r = (await db.query(`SELECT ${ROW} ${FROM} WHERE a.tenant_id=$1 AND a.id=$2`, [T(req), req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'No such timesheet approval' });
    if (r.employee_id === req.user.id) return res.status(403).json({ error: 'Nobody approves their own timesheet.' });
    const role = await roleFor(req, r, today);
    if (!role) {
      return res.status(403).json({ error: r.upper_manager_id === req.user.id
        ? `This timesheet is with ${r.manager_name || 'the manager'} until ${r.due_on}; it comes to you after that.`
        : 'Only the manager, their manager after the cutoff, the HRBP or HR can approve this timesheet.' });
    }
    if (r.status === 'approved') return res.status(409).json({ error: 'This timesheet is already approved.' });
    const b = req.body || {};
    const bandLabels = await bandsFor(T(req));
    const overrides = {};
    const kraIds = new Set((await db.query(
      `SELECT k.id FROM pms.kras k JOIN pms.kra_sheets s ON s.id = k.sheet_id
        WHERE s.tenant_id=$1 AND s.employee_id=$2`, [T(req), r.employee_id])).rows.map((x) => String(x.id)));
    for (const [kraId, o] of Object.entries(b.kra_overrides || {})) {
      if (!o || !o.rating) continue;
      if (!kraIds.has(String(kraId))) return res.status(422).json({ error: 'A rating was changed for a KRA that is not on this person\'s sheet.' });
      if (!bandLabels.includes(o.rating)) return res.status(422).json({ error: `"${o.rating}" is not a rating — use ${bandLabels.join(', ')}.` });
      const reason = String(o.reason || '').trim();
      if (!reason) return res.status(422).json({ error: 'Say why each changed rating was changed.' });
      if (reason.length > 300) return res.status(422).json({ error: 'Keep each reason to 300 characters.' });
      overrides[kraId] = { rating: o.rating, reason };
    }
    let month = null;
    if (b.month_override && b.month_override.rating) {
      if (!bandLabels.includes(b.month_override.rating)) return res.status(422).json({ error: `"${b.month_override.rating}" is not a rating.` });
      const reason = String(b.month_override.reason || '').trim();
      if (!reason) return res.status(422).json({ error: 'Say why the month\'s rating was changed.' });
      month = { rating: b.month_override.rating, reason: reason.slice(0, 300) };
    }
    const onTime = role === 'manager' && today <= r.due_on;
    await db.query(
      `UPDATE pms.timesheet_approvals SET status='approved', approved_at=now(), approved_by_id=$3,
              approved_by_email=$4, approved_as=$5, on_time_by_manager=$6, kra_overrides=$7::jsonb,
              month_override=$8::jsonb, note=$9, updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [T(req), r.id, req.user.id, req.user.email, role, onTime, JSON.stringify(overrides),
        month ? JSON.stringify(month) : null, String(b.note || '').trim().slice(0, 500) || null]);
    await db.query(
      `INSERT INTO pms.audit_log (tenant_id, actor_email, action, employee_id, details) VALUES ($1,$2,$3,$4,$5)`,
      [T(req), req.user.email, 'TIMESHEET_APPROVED', r.employee_id, JSON.stringify({
        approval_id: r.id, period_start: r.period_start, as: role, on_time_by_manager: onTime,
        kra_overrides: overrides, month_override: month })]).catch(() => {});
    const edits = Object.keys(overrides).length + (month ? 1 : 0);
    await notify(T(req), r.employee_id, 'timesheet_approved',
      `Your timesheet for ${r.period_start} – ${r.period_end} is approved`,
      edits ? `${edits} rating${edits === 1 ? ' was' : 's were'} changed, with the reason shown on your Timesheet.` : null,
      '/my/timesheet').catch(() => {});
    res.json({ ok: true, status: 'approved', approved_as: role, on_time_by_manager: onTime, edits });
  } catch (e) {
    logger.error('timesheet approve', { error: e.message });
    res.status(500).json({ error: 'Could not approve the timesheet' });
  }
});

async function bandsFor(tenantId) {
  const row = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [tenantId])).rows[0];
  const sc = row && row.value && row.value.scoring;
  const bands = sc && Array.isArray(sc.kra_bands) && sc.kra_bands.length ? sc.kra_bands.map((x) => x.label) : RATINGS;
  return bands;
}

// ---------------------------------------------------------------------------
// The manager's "Timesheet Approval" KRA.

// Its rating per month for one manager: { period_start: approvalRating }.
async function approvalKraByMonth(tenantId, managerId) {
  const today = todayIso();
  const rows = (await db.query(
    `SELECT to_char(period_start,'YYYY-MM-DD') AS period_start, status, on_time_by_manager,
            to_char(due_on,'YYYY-MM-DD') AS due_on
       FROM pms.timesheet_approvals WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, managerId])).rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.period_start)) by.set(r.period_start, []);
    by.get(r.period_start).push(r);
  }
  const out = {};
  for (const [p, list] of by) out[p] = approvalRating(list, today);
  return out;
}

// HR adds the KRA to every manager's sheet in the active cycle: a fixed
// 10%, the sheet's other KRAs scaled to 90% of what they were. Dry run
// unless ?commit=1, like every bulk change here. A sheet that already has
// it is left alone, so running it again picks up only new managers.
router.post('/kra', async (req, res) => {
  try {
    if (!(await holdsPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: 'Only HR and Super Admin add the Timesheet Approval KRA.', needs: 'pms_admin' });
    }
    const cycle = await activeCycle(T(req));
    if (!cycle) return res.status(422).json({ error: 'There is no active cycle to add the KRA to.' });
    const managers = (await db.query(
      `SELECT m.id, m.name, m.manager_id, count(e.id)::int AS reportees
         FROM core.employees m JOIN core.employees e ON e.manager_id = m.id AND e.tenant_id = m.tenant_id
        WHERE m.tenant_id=$1 AND m.status='active' AND m.archived_at IS NULL
          AND e.status='active' AND e.archived_at IS NULL
        GROUP BY m.id, m.name, m.manager_id ORDER BY m.name`, [T(req)])).rows;
    const commit = req.query.commit === '1';
    const rows = [];
    const client = commit ? await db.getClient() : null;
    try {
      if (client) await client.query('BEGIN');
      const q = client || db;
      for (const m of managers) {
        let sheet = (await q.query(
          `SELECT id, status FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
          [T(req), cycle.id, m.id])).rows[0];
        const kras = sheet ? (await q.query(
          `SELECT id, title, weight, system_kind FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
        if (kras.some((k) => k.system_kind === KRA_KIND || String(k.title).trim().toLowerCase() === KRA_TITLE.toLowerCase())) {
          rows.push({ employee: { id: m.id, name: m.name }, reportees: m.reportees, sheet_status: sheet.status, action: 'already has it' });
          continue;
        }
        const before = kras.reduce((t, k) => t + (Number(k.weight) || 0), 0);
        rows.push({ employee: { id: m.id, name: m.name }, reportees: m.reportees, sheet_status: sheet ? sheet.status : 'no sheet yet',
          kras: kras.length, total_before: Math.round(before * 100) / 100,
          total_after: Math.round((before * 0.9 + KRA_WEIGHT) * 100) / 100, action: commit ? 'added' : 'will add' });
        if (!commit) continue;
        if (!sheet) {
          sheet = (await q.query(
            `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING id, status`,
            [T(req), cycle.id, m.id, m.manager_id])).rows[0];
        }
        // Scale to 90%, rounded to 0.01, the rounding put on the largest
        // KRA so the sheet still totals what it should.
        const scaled = kras.map((k) => ({ id: k.id, w: Math.round((Number(k.weight) || 0) * 0.9 * 100) / 100 }));
        const want = Math.round(before * 0.9 * 100) / 100;
        const diff = Math.round((want - scaled.reduce((t, k) => t + k.w, 0)) * 100) / 100;
        if (diff && scaled.length) {
          const big = scaled.reduce((a, b2) => (b2.w > a.w ? b2 : a));
          big.w = Math.round((big.w + diff) * 100) / 100;
        }
        for (const k of scaled) await q.query(`UPDATE pms.kras SET weight=$2 WHERE id=$1`, [k.id, k.w]);
        const order = (await q.query(`SELECT coalesce(max(sort_order),0)+10 AS n FROM pms.kras WHERE sheet_id=$1`, [sheet.id])).rows[0].n;
        await q.query(
          `INSERT INTO pms.kras (tenant_id, sheet_id, title, description, weight, measures, category, sort_order,
                                 timesheet_tracked, timesheet_untracked_reason, system_kind)
           VALUES ($1,$2,$3,$4,$5,$6,'Project / Process',$7,false,$8,$9)`,
          [T(req), sheet.id, KRA_TITLE,
            'Approve your reportees’ monthly timesheets in the PMS before the cutoff.',
            KRA_WEIGHT,
            'Every reportee approved within the cutoff: A. Some: B+. None: B. Rated by the system each month.',
            order, 'Rated from timesheet approvals, not from logged hours', KRA_KIND]);
      }
      if (client) await client.query('COMMIT');
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { if (client) client.release(); }
    if (commit) {
      await db.query(`INSERT INTO pms.audit_log (tenant_id, actor_email, action, details) VALUES ($1,$2,$3,$4)`,
        [T(req), req.user.email, 'TIMESHEET_APPROVAL_KRA_ADDED',
          JSON.stringify({ cycle_id: cycle.id, added: rows.filter((x) => x.action === 'added').length })]).catch(() => {});
    }
    res.json({ dry_run: !commit, cycle: { id: cycle.id, name: cycle.name }, weight: KRA_WEIGHT, title: KRA_TITLE,
      managers: rows, to_add: rows.filter((x) => x.action !== 'already has it').length });
  } catch (e) {
    logger.error('timesheet approval kra', { error: e.message });
    res.status(500).json({ error: 'Could not add the Timesheet Approval KRA' });
  }
});

// ---------------------------------------------------------------------------
// Daily: tell the upper manager when months reach them. Once per row.
async function sweepEscalations(tenantId) {
  const today = todayIso();
  const rows = (await db.query(
    `SELECT a.id, a.upper_manager_id, a.manager_id, e.name, to_char(a.escalation_due_on,'YYYY-MM-DD') AS esc
       FROM pms.timesheet_approvals a JOIN core.employees e ON e.id = a.employee_id
      WHERE a.tenant_id=$1 AND a.status='pending' AND a.due_on < $2::date AND a.escalation_due_on >= $2::date
        AND a.upper_manager_id IS NOT NULL AND a.escalation_notified_at IS NULL`, [tenantId, today])).rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.upper_manager_id)) by.set(r.upper_manager_id, []);
    by.get(r.upper_manager_id).push(r);
  }
  for (const [upper, list] of by) {
    await notify(tenantId, upper, 'timesheet_approval',
      `Timesheets passed to you for approval: ${list.length}`,
      `Not approved by their manager in time: ${[...new Set(list.map((x) => x.name))].slice(0, 5).join(', ')}. Approve by ${list[0].esc}.`,
      '/team/timesheet', { email: true }).catch(() => {});
    await db.query(`UPDATE pms.timesheet_approvals SET escalation_notified_at=now() WHERE id = ANY($1::uuid[])`,
      [list.map((x) => x.id)]);
  }
  return rows.length;
}

function startScheduler(tenantId) {
  const run = async () => {
    try {
      const n = await sweepEscalations(tenantId);
      if (n) logger.info('timesheet approvals escalated', { count: n });
    } catch (e) { logger.warn('timesheet approval sweep failed', { error: e.message }); }
  };
  run();
  setInterval(run, 24 * 60 * 60 * 1000);
}

module.exports = {
  router, recordUpload, approvalKraByMonth, approvalRating, statusOf, addWorkingDays, todayIso,
  sweepEscalations, startScheduler, KRA_KIND, KRA_TITLE, DEFAULT_CUTOFF_DAYS,
};
