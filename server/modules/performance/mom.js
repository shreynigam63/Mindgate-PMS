// The MoM tab, part 1 — see migrations/091-mom.js for the records and the
// client's specification ("MoM Tab – PMS Build Specification", 14 Oct).
//
// A team is a manager and their direct reports. HR switches a team on;
// a team with a valid Google Meet link then gets a Daily Connect every
// working day (weekends and the HR calendar's holidays skipped). The
// manager writes the minutes after the call and publishes them; the
// action items become tasks that follow their owners until done, and
// open ones appear in the team's next MoM under Carried forward.
//
// No Google API: the PMS never creates a Meet link, it reuses the one the
// manager saved. Recording and the AI draft (parts 2 and 3) fill the
// statuses and columns this file leaves alone.
//
// WHO SEES WHAT (the spec's table): an attendee sees the MoMs of the
// meetings they were in, once published; the organiser (the team's
// manager) writes and publishes; HR sees and edits every MoM and sets
// every team's link. A draft is the organiser's until it is published.

const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { guardUuidParams } = require('../../core/http');
const { hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');

const T = (req) => req.user.tenant_id;
const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const LINK = '/team/connects?tab=mom';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PRIORITIES = ['low', 'medium', 'high'];

// ------------------------------------------------------------------ pure helpers

// A Google Meet link: https://meet.google.com/abc-defg-hij, nothing else.
// Anything after the code (a query string from a calendar invite) is
// dropped, so every connect stores the same plain link.
function meetLink(v) {
  const m = String(v || '').trim().match(/^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i);
  return m ? `https://meet.google.com/${m[1].toLowerCase()}` : null;
}

// The date and time in the company's time zone. The server's own clock
// zone is not the office's.
function localNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const time = `${p.hour}:${p.minute}`;
  return { date: `${p.year}-${p.month}-${p.day}`, time, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const minutesOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const addMinutes = (hhmm, n) => {
  const t = Math.min(23 * 60 + 59, minutesOf(hhmm) + n);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const isWorkingDay = (date, holidays = []) => {
  const w = new Date(`${date}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6 && !(holidays || []).includes(date);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// What publishing needs: at least one discussion point, and every action
// item with a task, an owner and a due date. Every problem at once.
function publishProblems(m) {
  const errors = [];
  if (!(m.discussion || []).some((d) => String(d).trim())) errors.push('Add at least one discussion point.');
  (m.action_items || []).forEach((a, i) => {
    const n = `Action item ${i + 1}${a.task ? ` ("${String(a.task).slice(0, 40)}")` : ''}`;
    if (!String(a.task || '').trim()) errors.push(`${n} has no task.`);
    if (!a.owner_id) errors.push(`${n} has no owner.`);
    if (!a.due_date) errors.push(`${n} has no due date.`);
  });
  return errors;
}

const SECTIONS = ['summary', 'discussion', 'decisions', 'blockers', 'attendance', 'times', 'action_items'];
// Which sections a revision changed, for "who changed what".
function changedSections(before, after) {
  const pick = {
    summary: (x) => x.summary || '', discussion: (x) => x.discussion, decisions: (x) => x.decisions,
    blockers: (x) => x.blockers, attendance: (x) => x.attendance, times: (x) => [x.start_time, x.end_time],
    action_items: (x) => (x.action_items || []).map((a) => [a.task, a.owner_id, a.due_date, a.priority, a.status]),
  };
  return SECTIONS.filter((s) => JSON.stringify(pick[s](before)) !== JSON.stringify(pick[s](after)));
}

// ------------------------------------------------------------------ data helpers

async function audit(client, req, action, employeeId, details) {
  await (client || db).query(
    `INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details) VALUES ($1,$2,$3,NULL,$4,$5)`,
    [T(req), req.user.email, action, employeeId || null, details ? JSON.stringify(details) : null]);
}

async function inTransaction(fn) {
  const client = await db.getClient();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); throw e;
  } finally { client.release(); }
}

const quietly = (p) => p.catch((e) => logger.warn('mom notify failed', { error: e.message }));

async function holidaysFor(t) {
  const row = (await db.query(`SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [t])).rows[0];
  const v = (row && row.value) || {};
  return Array.isArray(v.holidays) ? v.holidays : [];
}

async function directReports(t, managerId) {
  return (await db.query(
    `SELECT id, name, designation FROM core.employees WHERE tenant_id=$1 AND manager_id=$2 AND status='active' ORDER BY name`,
    [t, managerId])).rows;
}

async function namesOf(t, ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return {};
  const rows = (await db.query(`SELECT id, name FROM core.employees WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [t, list])).rows;
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

// The day's Daily Connects, created for every switched-on team with a
// valid link. Idempotent: one per team per day (the table's unique key).
async function ensureMeetings(t, now = new Date()) {
  const { date } = localNow(now);
  if (!isWorkingDay(date, await holidaysFor(t))) return 0;
  const teams = (await db.query(
    `SELECT mt.*, m.name AS manager_name FROM pms.mom_teams mt JOIN core.employees m ON m.id = mt.manager_id
      WHERE mt.tenant_id=$1 AND mt.enabled AND mt.meet_link IS NOT NULL AND m.status='active'`, [t])).rows;
  let made = 0;
  for (const team of teams) {
    const attendees = team.attendee_ids && team.attendee_ids.length
      ? team.attendee_ids : (await directReports(t, team.manager_id)).map((r) => r.id);
    const r = await db.query(
      `INSERT INTO pms.mom_meetings (tenant_id, team_id, type, title, organiser_id, attendee_ids, meeting_date, start_time, end_time, meet_link, created_by)
       VALUES ($1,$2,'daily_connect',$3,$4,$5,$6,$7,$8,$9,'system')
       ON CONFLICT (team_id, meeting_date, type) DO NOTHING RETURNING id`,
      [t, team.id, `Daily connect — ${team.manager_name}'s team`, team.manager_id, attendees, date,
        team.daily_time, addMinutes(team.daily_time, team.duration_min), team.meet_link]);
    made += r.rowCount;
  }
  return made;
}

// Everything time-driven, run every few minutes and at boot. Each step is
// guarded by its own column, so running it twice sends nothing twice.
async function tick(t, now = new Date()) {
  const out = { created: 0, reminded: 0, missing: 0, due: 0, overdue: 0, escalated: 0 };
  const L = localNow(now);
  out.created = await ensureMeetings(t, now);

  // 15 minutes before: the Meet link, to the organiser and the attendees.
  const soon = (await db.query(
    `SELECT * FROM pms.mom_meetings WHERE tenant_id=$1 AND meeting_date=$2 AND status='scheduled' AND reminded_at IS NULL`,
    [t, L.date])).rows.filter((m) => m.start_time && minutesOf(m.start_time) - L.minutes <= 15 && minutesOf(m.start_time) - L.minutes >= 0);
  for (const m of soon) {
    const claimed = await db.query(`UPDATE pms.mom_meetings SET reminded_at=now() WHERE id=$1 AND reminded_at IS NULL`, [m.id]);
    if (!claimed.rowCount) continue;
    for (const id of new Set([m.organiser_id, ...(m.attendee_ids || [])].filter(Boolean))) {
      await quietly(notify(t, id, 'mom_reminder', `${m.title} at ${m.start_time}`, `Join on Google Meet: ${m.meet_link}`, LINK));
    }
    out.reminded += 1;
  }

  // 6 pm: a connect with no published MoM is Missing, and its organiser is
  // told once. Earlier days still scheduled are caught up the same way.
  const late = (await db.query(
    `SELECT *, to_char(meeting_date,'YYYY-MM-DD') AS date FROM pms.mom_meetings WHERE tenant_id=$1 AND status='scheduled'
        AND (meeting_date < $2 OR (meeting_date = $2 AND $3::int >= 18*60))`, [t, L.date, L.minutes])).rows;
  for (const m of late) {
    await db.query(`UPDATE pms.mom_meetings SET status='missing', missing_notified_at=now() WHERE id=$1 AND status='scheduled'`, [m.id]);
    if (m.organiser_id) {
      await quietly(notify(t, m.organiser_id, 'mom_missing', `MoM missing: ${m.title} (${m.date})`,
        'No MoM was published for this connect. Write it by hand, or mark the connect as not held.', LINK));
    }
    out.missing += 1;
  }

  // Action items, from 9 am: due today, overdue, and three days overdue to
  // the owner's manager. One notice each.
  if (L.minutes >= 9 * 60) {
    const items = (await db.query(
      `SELECT a.*, to_char(a.due_date,'YYYY-MM-DD') AS due, e.manager_id AS owner_manager, e.name AS owner_name
         FROM pms.mom_action_items a JOIN pms.mom_minutes mi ON mi.id=a.minutes_id AND mi.status='published'
         LEFT JOIN core.employees e ON e.id=a.owner_id
        WHERE a.tenant_id=$1 AND a.status='open' AND a.owner_id IS NOT NULL AND a.due_date <= $2`, [t, L.date])).rows;
    for (const a of items) {
      if (a.due === L.date && !a.due_reminded_on) {
        await db.query(`UPDATE pms.mom_action_items SET due_reminded_on=$2 WHERE id=$1`, [a.id, L.date]);
        await quietly(notify(t, a.owner_id, 'mom_action_due', 'Action item due today', a.task, `${LINK}&sub=actions`));
        out.due += 1;
      } else if (a.due < L.date && !a.overdue_reminded_on) {
        await db.query(`UPDATE pms.mom_action_items SET overdue_reminded_on=$2 WHERE id=$1`, [a.id, L.date]);
        await quietly(notify(t, a.owner_id, 'mom_action_overdue', 'Action item overdue', `${a.task} (due ${a.due})`, `${LINK}&sub=actions`));
        out.overdue += 1;
      }
      if (daysBetween(a.due, L.date) >= 3 && !a.manager_alerted_on && a.owner_manager) {
        await db.query(`UPDATE pms.mom_action_items SET manager_alerted_on=$2 WHERE id=$1`, [a.id, L.date]);
        await quietly(notify(t, a.owner_manager, 'mom_action_overdue_manager', `${a.owner_name}: action item 3 days overdue`,
          `${a.task} (due ${a.due})`, `${LINK}&sub=actions`));
        out.escalated += 1;
      }
    }
  }
  return out;
}

// Who the caller is to a meeting.
async function roleIn(req, m, team) {
  const me = req.user.id;
  const hr = await hasPermission(req.user, 'pms_admin');
  const organiser = m.organiser_id === me;
  const attendee = (m.attendee_ids || []).includes(me);
  const manager = team && team.manager_id === me;
  return { hr, organiser, attendee, manager, view: hr || organiser || attendee || manager, edit: hr || organiser };
}

async function meetingWithTeam(t, id) {
  const m = (await db.query(
    `SELECT mm.*, to_char(mm.meeting_date,'YYYY-MM-DD') AS date, mt.manager_id
       FROM pms.mom_meetings mm JOIN pms.mom_teams mt ON mt.id=mm.team_id
      WHERE mm.tenant_id=$1 AND mm.id=$2`, [t, id])).rows[0];
  return m || null;
}

// Open action items of the team from MoMs published before this one —
// what this meeting carries forward.
async function carriedForward(t, teamId, minutesId) {
  return (await db.query(
    `SELECT a.id, a.task, a.owner_id, e.name AS owner_name, to_char(a.due_date,'YYYY-MM-DD') AS due_date, a.priority,
            a.status, a.carried_forward_count, to_char(mm.meeting_date,'YYYY-MM-DD') AS from_date
       FROM pms.mom_action_items a
       JOIN pms.mom_minutes mi ON mi.id=a.minutes_id AND mi.status='published'
       JOIN pms.mom_meetings mm ON mm.id=mi.meeting_id
       LEFT JOIN core.employees e ON e.id=a.owner_id
      WHERE a.tenant_id=$1 AND a.team_id=$2 AND a.status='open' AND ($3::uuid IS NULL OR a.minutes_id <> $3)
      ORDER BY a.due_date NULLS LAST, a.created_at`, [t, teamId, minutesId || null])).rows;
}

async function itemsOf(t, minutesId) {
  if (!minutesId) return [];
  return (await db.query(
    `SELECT a.id, a.task, a.owner_id, e.name AS owner_name, to_char(a.due_date,'YYYY-MM-DD') AS due_date, a.priority, a.status,
            to_char(a.closed_on,'YYYY-MM-DD') AS closed_on, a.carried_forward_count
       FROM pms.mom_action_items a LEFT JOIN core.employees e ON e.id=a.owner_id
      WHERE a.tenant_id=$1 AND a.minutes_id=$2 ORDER BY a.created_at`, [t, minutesId])).rows;
}

// The minutes a request sends, cleaned. Refuses what cannot be stored.
function cleanMinutes(b, people) {
  const list = (v, max = 300) => (Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean).map((x) => x.slice(0, max));
  const errors = [];
  const items = (Array.isArray(b.action_items) ? b.action_items : []).map((a, i) => {
    const task = String((a && a.task) || '').trim().slice(0, 500);
    const owner = a && a.owner_id ? String(a.owner_id) : null;
    const due = a && a.due_date ? String(a.due_date) : null;
    const priority = PRIORITIES.includes(a && a.priority) ? a.priority : 'medium';
    if (owner && !people.has(owner)) errors.push(`Action item ${i + 1}: the owner is not an employee.`);
    if (due && !(DATE.test(due) && !Number.isNaN(Date.parse(`${due}T00:00:00Z`)))) errors.push(`Action item ${i + 1}: the due date is not a date.`);
    return { id: a && a.id && UUID.test(a.id) ? a.id : null, task, owner_id: owner, due_date: due, priority };
  }).filter((a) => a.task || a.owner_id || a.due_date);
  const blockers = (Array.isArray(b.blockers) ? b.blockers : []).map((x) => ({
    issue: String((x && x.issue) || '').trim().slice(0, 300), help_from: String((x && x.help_from) || '').trim().slice(0, 120),
  })).filter((x) => x.issue);
  const attendance = {};
  for (const [k, v] of Object.entries(b.attendance && typeof b.attendance === 'object' ? b.attendance : {})) {
    if (UUID.test(k) && ['present', 'absent'].includes(v)) attendance[k] = v;
  }
  for (const k of ['start_time', 'end_time']) {
    if (b[k] != null && b[k] !== '' && !TIME.test(String(b[k]))) errors.push(`The ${k === 'start_time' ? 'start' : 'end'} time is not a time.`);
  }
  return {
    errors,
    value: {
      summary: String(b.summary || '').trim().slice(0, 3000) || null,
      discussion: list(b.discussion), decisions: list(b.decisions), blockers, attendance, action_items: items,
      start_time: b.start_time || null, end_time: b.end_time || null,
    },
  };
}

async function employeeIds(t) {
  return new Set((await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1`, [t])).rows.map((r) => r.id));
}

// Write the minutes and their action items. Before publish the items are
// replaced as the editor sends them; after it a removed item is cancelled,
// not deleted — it was somebody's task.
async function writeMinutes(client, req, m, v, { published }) {
  const t = T(req);
  const mi = (await client.query(
    `INSERT INTO pms.mom_minutes (tenant_id, meeting_id, summary, discussion, decisions, blockers, attendance, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (meeting_id) DO UPDATE SET summary=EXCLUDED.summary, discussion=EXCLUDED.discussion, decisions=EXCLUDED.decisions,
       blockers=EXCLUDED.blockers, attendance=EXCLUDED.attendance, updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING *`,
    [t, m.id, v.summary, JSON.stringify(v.discussion), JSON.stringify(v.decisions), JSON.stringify(v.blockers),
      JSON.stringify(v.attendance), req.user.email])).rows[0];
  await client.query(`UPDATE pms.mom_meetings SET start_time=COALESCE($2,start_time), end_time=COALESCE($3,end_time) WHERE id=$1`,
    [m.id, v.start_time, v.end_time]);
  const existing = (await client.query(`SELECT id FROM pms.mom_action_items WHERE minutes_id=$1`, [mi.id])).rows.map((r) => r.id);
  const kept = new Set();
  for (const a of v.action_items) {
    if (a.id && existing.includes(a.id)) {
      kept.add(a.id);
      await client.query(
        `UPDATE pms.mom_action_items SET task=$2, owner_id=$3, due_date=$4, priority=$5, updated_at=now() WHERE id=$1`,
        [a.id, a.task || '(no task)', a.owner_id, a.due_date, a.priority]);
    } else {
      await client.query(
        `INSERT INTO pms.mom_action_items (tenant_id, minutes_id, team_id, task, owner_id, due_date, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t, mi.id, m.team_id, a.task || '(no task)', a.owner_id, a.due_date, a.priority]);
    }
  }
  const gone = existing.filter((id) => !kept.has(id));
  if (gone.length) {
    if (published) {
      await client.query(`UPDATE pms.mom_action_items SET status='cancelled', closed_on=CURRENT_DATE, closed_by=$2, updated_at=now()
                           WHERE id = ANY($1::uuid[]) AND status='open'`, [gone, req.user.email]);
    } else {
      await client.query(`DELETE FROM pms.mom_action_items WHERE id = ANY($1::uuid[])`, [gone]);
    }
  }
  return mi;
}

async function snapshotOf(client, t, miId) {
  const mi = (await client.query(`SELECT * FROM pms.mom_minutes WHERE id=$1`, [miId])).rows[0];
  const mm = (await client.query(`SELECT start_time, end_time FROM pms.mom_meetings WHERE id=$1`, [mi.meeting_id])).rows[0];
  const items = (await client.query(
    `SELECT a.task, a.owner_id, e.name AS owner_name, to_char(a.due_date,'YYYY-MM-DD') AS due_date, a.priority, a.status
       FROM pms.mom_action_items a LEFT JOIN core.employees e ON e.id=a.owner_id WHERE a.minutes_id=$1 ORDER BY a.created_at`, [miId])).rows;
  return { summary: mi.summary, discussion: mi.discussion, decisions: mi.decisions, blockers: mi.blockers, attendance: mi.attendance,
    start_time: mm.start_time, end_time: mm.end_time, action_items: items, carried_forward: mi.carried_forward };
}

// ------------------------------------------------------------------ router

const router = express.Router();
guardUuidParams(router);

// -------- team settings

router.get('/teams', async (req, res) => {
  try {
    const t = T(req);
    const hr = await hasPermission(req.user, 'pms_admin');
    const rows = (await db.query(
      `SELECT m.id AS manager_id, m.name AS manager_name, m.department,
              (SELECT count(*)::int FROM core.employees r WHERE r.tenant_id=m.tenant_id AND r.manager_id=m.id AND r.status='active') AS reports,
              mt.id AS team_id, mt.meet_link, mt.daily_time, mt.duration_min, mt.attendee_ids, COALESCE(mt.enabled,false) AS enabled,
              mt.updated_by, mt.updated_at
         FROM core.employees m
         LEFT JOIN pms.mom_teams mt ON mt.tenant_id=m.tenant_id AND mt.manager_id=m.id
        WHERE m.tenant_id=$1 AND m.status='active'
          AND EXISTS (SELECT 1 FROM core.employees r WHERE r.tenant_id=m.tenant_id AND r.manager_id=m.id AND r.status='active')
          ${hr ? '' : 'AND m.id=$2'}
        ORDER BY m.name`, hr ? [t] : [t, req.user.id])).rows;
    res.json({ teams: rows.map((r) => ({ ...r, daily_time: r.daily_time || '10:00', duration_min: r.duration_min || 30 })),
      can_manage: hr || rows.length > 0, hr, me: req.user.id,
      without_link: hr ? rows.filter((r) => !r.meet_link).length : undefined });
  } catch (e) { logger.error('mom teams', { error: e.message }); res.status(500).json({ error: 'Could not load the teams.' }); }
});

router.get('/teams/:managerId/reports', async (req, res) => {
  try {
    const id = String(req.params.managerId);
    if (!UUID.test(id)) return res.status(400).json({ error: 'Not a valid id.' });
    if (id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your team.' });
    res.json({ reports: await directReports(T(req), id) });
  } catch (e) { res.status(500).json({ error: 'Could not load the team.' }); }
});

router.put('/teams/:managerId', async (req, res) => {
  try {
    const t = T(req);
    const id = String(req.params.managerId);
    if (!UUID.test(id)) return res.status(400).json({ error: 'Not a valid id.' });
    const hr = await hasPermission(req.user, 'pms_admin');
    if (id !== req.user.id && !hr) return res.status(403).json({ error: 'Only the team\'s manager or HR can change its settings.' });
    const reports = await directReports(t, id);
    if (!reports.length) return res.status(409).json({ error: 'This person has no direct reports, so there is no team.' });
    const b = req.body || {};
    const cur = (await db.query(`SELECT * FROM pms.mom_teams WHERE tenant_id=$1 AND manager_id=$2`, [t, id])).rows[0] || {};
    const errors = [];
    let link = cur.meet_link || null;
    if (b.meet_link !== undefined) {
      if (b.meet_link === null || String(b.meet_link).trim() === '') link = null;
      else { link = meetLink(b.meet_link); if (!link) errors.push('Enter a valid Google Meet link'); }
    }
    const time = b.daily_time !== undefined ? String(b.daily_time) : (cur.daily_time || '10:00');
    if (!TIME.test(time)) errors.push('The daily time is not a time (HH:MM).');
    const duration = b.duration_min !== undefined ? Number(b.duration_min) : (cur.duration_min || 30);
    if (!Number.isInteger(duration) || duration < 5 || duration > 240) errors.push('The duration is 5 to 240 minutes.');
    let attendees = cur.attendee_ids || null;
    if (b.attendee_ids !== undefined) {
      if (b.attendee_ids === null) attendees = null;
      else if (!Array.isArray(b.attendee_ids)) errors.push('attendee_ids is a list.');
      else {
        const ok = new Set(reports.map((r) => r.id));
        const bad = b.attendee_ids.filter((x) => !ok.has(x));
        if (bad.length) errors.push('Attendees are chosen from the manager\'s direct reports.');
        attendees = b.attendee_ids.length ? [...new Set(b.attendee_ids)] : null;
      }
    }
    let enabled = !!cur.enabled;
    if (b.enabled !== undefined) {
      if (!hr) errors.push('Only HR switches daily connects on or off.');
      else enabled = !!b.enabled;
    }
    // "A team cannot start daily connects until a valid link is saved."
    if (enabled && !link) errors.push('Save a valid Google Meet link before switching daily connects on.');
    if (errors.length) return res.status(422).json({ error: errors[0], errors });
    const row = await inTransaction(async (client) => {
      const r = (await client.query(
        `INSERT INTO pms.mom_teams (tenant_id, manager_id, meet_link, daily_time, duration_min, attendee_ids, enabled, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (tenant_id, manager_id) DO UPDATE SET meet_link=EXCLUDED.meet_link, daily_time=EXCLUDED.daily_time,
           duration_min=EXCLUDED.duration_min, attendee_ids=EXCLUDED.attendee_ids, enabled=EXCLUDED.enabled,
           updated_by=EXCLUDED.updated_by, updated_at=now()
         RETURNING *`, [t, id, link, time, duration, attendees, enabled, req.user.email])).rows[0];
      // A changed link reaches today's connect if it has not happened yet;
      // past connects keep the link they used.
      if (link && link !== cur.meet_link) {
        await client.query(`UPDATE pms.mom_meetings SET meet_link=$2 WHERE team_id=$1 AND status='scheduled' AND meeting_date >= $3`,
          [r.id, link, localNow().date]);
      }
      await audit(client, req, 'MOM_TEAM_UPDATED', id, {
        before: { meet_link: cur.meet_link || null, daily_time: cur.daily_time || null, enabled: !!cur.enabled, attendee_ids: cur.attendee_ids || null },
        after: { meet_link: link, daily_time: time, enabled, attendee_ids: attendees },
      });
      return r;
    });
    if (row.enabled) await ensureMeetings(t).catch((e) => logger.warn('mom ensure after save', { error: e.message }));
    res.json({ ok: true, team: row });
  } catch (e) { logger.error('mom team save', { error: e.message }); res.status(500).json({ error: 'Could not save the team settings.' }); }
});

// -------- meetings

router.get('/today', async (req, res) => {
  try {
    const t = T(req);
    await ensureMeetings(t).catch((e) => logger.warn('mom ensure', { error: e.message }));
    const { date } = localNow();
    const rows = (await db.query(
      `SELECT mm.id, mm.title, mm.type, to_char(mm.meeting_date,'YYYY-MM-DD') AS date, mm.start_time, mm.end_time, mm.meet_link,
              mm.status, mm.organiser_id, o.name AS organiser_name, mi.status AS mom_status, mi.version
         FROM pms.mom_meetings mm LEFT JOIN core.employees o ON o.id=mm.organiser_id
         LEFT JOIN pms.mom_minutes mi ON mi.meeting_id=mm.id
        WHERE mm.tenant_id=$1 AND mm.meeting_date=$2 AND ($3 = mm.organiser_id OR $3 = ANY(mm.attendee_ids))
        ORDER BY mm.start_time`, [t, date, req.user.id])).rows;
    res.json({ date, meetings: rows.map((m) => ({ ...m, can_edit: m.organiser_id === req.user.id })) });
  } catch (e) { logger.error('mom today', { error: e.message }); res.status(500).json({ error: 'Could not load today\'s connects.' }); }
});

router.get('/meetings', async (req, res) => {
  try {
    const t = T(req);
    const hr = await hasPermission(req.user, 'pms_admin');
    const q = req.query || {};
    const params = [t, req.user.id];
    const where = ['mm.tenant_id=$1'];
    if (!hr) where.push('($2 = mm.organiser_id OR $2 = ANY(mm.attendee_ids) OR mt.manager_id = $2)');
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.from && DATE.test(q.from)) add('mm.meeting_date >= ?', q.from);
    if (q.to && DATE.test(q.to)) add('mm.meeting_date <= ?', q.to);
    if (q.manager_id && UUID.test(q.manager_id)) add('mt.manager_id = ?', q.manager_id);
    if (q.status && /^[a-z_]+$/.test(q.status)) add('mm.status = ?', q.status);
    const rows = (await db.query(
      `SELECT mm.id, mm.title, mm.type, to_char(mm.meeting_date,'YYYY-MM-DD') AS date, mm.start_time, mm.status,
              mm.organiser_id, o.name AS organiser_name, mt.manager_id, mi.status AS mom_status, mi.version,
              (SELECT count(*)::int FROM pms.mom_action_items a WHERE a.minutes_id=mi.id AND a.status='open') AS open_items,
              EXISTS (SELECT 1 FROM pms.mom_acks k WHERE k.minutes_id=mi.id AND k.employee_id=$2 AND k.version=mi.version) AS acknowledged,
              ($2 = ANY(mm.attendee_ids)) AS attended
         FROM pms.mom_meetings mm JOIN pms.mom_teams mt ON mt.id=mm.team_id
         LEFT JOIN core.employees o ON o.id=mm.organiser_id
         LEFT JOIN pms.mom_minutes mi ON mi.meeting_id=mm.id
        WHERE ${where.join(' AND ')}
        ORDER BY mm.meeting_date DESC, mm.start_time LIMIT 500`, params)).rows;
    const managers = hr ? (await db.query(
      `SELECT DISTINCT m.id AS manager_id, m.name FROM pms.mom_teams mt JOIN core.employees m ON m.id=mt.manager_id
        WHERE mt.tenant_id=$1 ORDER BY m.name`, [t])).rows : [];
    res.json({ meetings: rows, managers, hr });
  } catch (e) { logger.error('mom list', { error: e.message }); res.status(500).json({ error: 'Could not load the MoMs.' }); }
});

router.get('/meetings/:id', async (req, res) => {
  try {
    const t = T(req);
    const m = await meetingWithTeam(t, req.params.id);
    if (!m) return res.status(404).json({ error: 'Meeting not found.' });
    const role = await roleIn(req, m, { manager_id: m.manager_id });
    if (!role.view) return res.status(403).json({ error: 'You were not in this meeting.' });
    const mi = (await db.query(`SELECT * FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0] || null;
    const published = !!(mi && mi.status === 'published');
    // A draft is the organiser's (and HR's) until it is published.
    const showContent = published || role.edit;
    const ids = [m.organiser_id, ...(m.attendee_ids || [])];
    const names = await namesOf(t, ids);
    const acks = mi && published ? (await db.query(
      `SELECT k.employee_id, e.name, k.version, k.comment, k.acknowledged_at FROM pms.mom_acks k JOIN core.employees e ON e.id=k.employee_id
        WHERE k.minutes_id=$1 ORDER BY k.acknowledged_at`, [mi.id])).rows : [];
    const versions = mi ? (await db.query(
      `SELECT version, changed, changed_by, changed_at FROM pms.mom_versions WHERE minutes_id=$1 ORDER BY version`, [mi.id])).rows : [];
    const myAck = acks.find((a) => a.employee_id === req.user.id && mi && a.version === mi.version) || null;
    const people = await (async () => {
      if (!role.edit) return [];
      const extra = (await db.query(
        `SELECT id, name FROM core.employees WHERE tenant_id=$1 AND status='active' AND (id = ANY($2::uuid[]) OR manager_id=$3) ORDER BY name`,
        [t, ids.filter(Boolean), m.manager_id])).rows;
      return extra;
    })();
    res.json({
      meeting: { id: m.id, title: m.title, type: m.type, date: m.date, start_time: m.start_time, end_time: m.end_time,
        meet_link: m.meet_link, status: m.status, cancel_reason: m.cancel_reason, organiser_id: m.organiser_id,
        organiser_name: names[m.organiser_id] || null,
        attendees: (m.attendee_ids || []).map((id) => ({ id, name: names[id] || 'Former employee' })) },
      minutes: showContent && mi ? { id: mi.id, version: mi.version, status: mi.status, summary: mi.summary, discussion: mi.discussion,
        decisions: mi.decisions, blockers: mi.blockers, attendance: mi.attendance,
        carried_forward_snapshot: published ? mi.carried_forward : null,
        published_by: mi.published_by, published_at: mi.published_at, updated_by: mi.updated_by, updated_at: mi.updated_at } : null,
      draft_exists: !!mi && !published,
      action_items: showContent && mi ? await itemsOf(t, mi.id) : [],
      // Live for the editor: what this MoM will carry forward if published now.
      carried_forward: role.edit && !published ? await carriedForward(t, m.team_id, mi && mi.id) : [],
      versions, people,
      acks: role.edit || role.manager ? acks : (myAck ? [myAck] : []),
      pending_acks: role.edit && published ? (m.attendee_ids || []).filter((id) => !acks.some((a) => a.employee_id === id && a.version === mi.version))
        .map((id) => ({ id, name: names[id] || 'Former employee' })) : [],
      can_edit: role.edit && m.status !== 'cancelled',
      can_ack: published && role.attendee && !myAck,
      my_ack: myAck,
    });
  } catch (e) { logger.error('mom read', { error: e.message }); res.status(500).json({ error: 'Could not load the MoM.' }); }
});

router.get('/meetings/:id/versions/:version', async (req, res) => {
  try {
    const t = T(req);
    const m = await meetingWithTeam(t, req.params.id);
    if (!m) return res.status(404).json({ error: 'Meeting not found.' });
    const role = await roleIn(req, m, { manager_id: m.manager_id });
    if (!role.view) return res.status(403).json({ error: 'You were not in this meeting.' });
    const v = (await db.query(
      `SELECT v.version, v.snapshot, v.changed, v.changed_by, v.changed_at FROM pms.mom_versions v JOIN pms.mom_minutes mi ON mi.id=v.minutes_id
        WHERE mi.meeting_id=$1 AND v.version=$2`, [m.id, Number(req.params.version) || 0])).rows[0];
    if (!v) return res.status(404).json({ error: 'No such version.' });
    res.json({ version: v });
  } catch (e) { res.status(500).json({ error: 'Could not load the version.' }); }
});

async function editable(req, res) {
  const t = T(req);
  const m = await meetingWithTeam(t, req.params.id);
  if (!m) { res.status(404).json({ error: 'Meeting not found.' }); return null; }
  const role = await roleIn(req, m, { manager_id: m.manager_id });
  if (!role.edit) { res.status(403).json({ error: 'Only the organiser or HR can write this MoM.' }); return null; }
  if (m.status === 'cancelled') { res.status(409).json({ error: 'This connect was marked as not held.' }); return null; }
  return m;
}

// Save the draft (before publish).
router.put('/meetings/:id/minutes', async (req, res) => {
  try {
    const m = await editable(req, res); if (!m) return;
    const cur = (await db.query(`SELECT status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
    if (cur && cur.status === 'published') return res.status(409).json({ error: 'This MoM is published. Use Revise to make a new version.' });
    const c = cleanMinutes(req.body || {}, await employeeIds(T(req)));
    if (c.errors.length) return res.status(422).json({ error: c.errors[0], errors: c.errors });
    await inTransaction((client) => writeMinutes(client, req, m, c.value, { published: false }));
    res.json({ ok: true });
  } catch (e) { logger.error('mom save', { error: e.message }); res.status(500).json({ error: 'Could not save the MoM.' }); }
});

async function publishVersion(req, m, value, { revise }) {
  const t = T(req);
  return inTransaction(async (client) => {
    const before = revise ? await snapshotOf(client, t, (await client.query(`SELECT id FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0].id) : null;
    const mi = await writeMinutes(client, req, m, value, { published: revise });
    const after = await snapshotOf(client, t, mi.id);
    const changed = revise ? changedSections(before, after) : SECTIONS;
    if (revise && !changed.length) return { nothing: true };
    let carried = mi.carried_forward;
    if (!revise) {
      // What this MoM carries forward, frozen as it stood when published.
      const open = await carriedForward(t, m.team_id, mi.id);
      carried = open.map((a) => ({ id: a.id, task: a.task, owner_name: a.owner_name, due_date: a.due_date, status: a.status, from_date: a.from_date }));
      if (open.length) {
        await client.query(`UPDATE pms.mom_action_items SET carried_forward_count = carried_forward_count + 1 WHERE id = ANY($1::uuid[])`,
          [open.map((a) => a.id)]);
      }
    }
    const version = (mi.version || 0) + 1;
    await client.query(
      `UPDATE pms.mom_minutes SET status='published', version=$2, carried_forward=$3, published_by=$4, published_at=now() WHERE id=$1`,
      [mi.id, version, JSON.stringify(carried), req.user.email]);
    await client.query(`UPDATE pms.mom_meetings SET status='published' WHERE id=$1`, [m.id]);
    const snap = await snapshotOf(client, t, mi.id);
    await client.query(
      `INSERT INTO pms.mom_versions (tenant_id, minutes_id, version, snapshot, changed, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t, mi.id, version, JSON.stringify(snap), changed, req.user.email]);
    await audit(client, req, revise ? 'MOM_REVISED' : 'MOM_PUBLISHED', null,
      { meeting_id: m.id, date: m.date, version, changed, action_items: snap.action_items.length });
    return { version, changed, minutesId: mi.id, items: snap.action_items };
  });
}

async function notifyPublished(req, m, out, { revise }) {
  const t = T(req);
  const link = `${LINK}&mom=${m.id}`;
  for (const id of new Set((m.attendee_ids || []).filter((x) => x && x !== req.user.id))) {
    await quietly(notify(t, id, revise ? 'mom_revised' : 'mom_published',
      revise ? `MoM updated (v${out.version}): ${m.title}, ${m.date}` : `MoM published: ${m.title}, ${m.date}`,
      revise ? `Changed: ${out.changed.join(', ')}. Please read and acknowledge.` : 'Please read and acknowledge.', link));
  }
  if (!revise) {
    const owners = (await db.query(
      `SELECT owner_id, count(*)::int AS n FROM pms.mom_action_items WHERE minutes_id=$1 AND status='open' AND owner_id IS NOT NULL GROUP BY owner_id`,
      [out.minutesId])).rows;
    for (const o of owners) {
      await quietly(notify(t, o.owner_id, 'mom_action_assigned', `${o.n} action item${o.n === 1 ? '' : 's'} for you from ${m.title}`,
        `From the ${m.date} MoM.`, `${LINK}&sub=actions`));
    }
  }
}

router.post('/meetings/:id/publish', async (req, res) => {
  try {
    const m = await editable(req, res); if (!m) return;
    const cur = (await db.query(`SELECT status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
    if (cur && cur.status === 'published') return res.status(409).json({ error: 'Already published. Use Revise to make a new version.' });
    const c = cleanMinutes(req.body || {}, await employeeIds(T(req)));
    const errors = [...c.errors, ...publishProblems(c.value)];
    if (errors.length) return res.status(422).json({ error: errors[0], errors });
    const out = await publishVersion(req, m, c.value, { revise: false });
    await notifyPublished(req, m, out, { revise: false });
    res.json({ ok: true, version: out.version });
  } catch (e) { logger.error('mom publish', { error: e.message }); res.status(500).json({ error: 'Could not publish the MoM.' }); }
});

// After publish, a change is a new version (v2, v3…) with what changed.
router.post('/meetings/:id/revise', async (req, res) => {
  try {
    const m = await editable(req, res); if (!m) return;
    const cur = (await db.query(`SELECT status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
    if (!cur || cur.status !== 'published') return res.status(409).json({ error: 'Only a published MoM is revised. Save or publish the draft.' });
    const c = cleanMinutes(req.body || {}, await employeeIds(T(req)));
    const errors = [...c.errors, ...publishProblems(c.value)];
    if (errors.length) return res.status(422).json({ error: errors[0], errors });
    const out = await publishVersion(req, m, c.value, { revise: true });
    if (out.nothing) return res.status(409).json({ error: 'Nothing has changed since the published version.' });
    await notifyPublished(req, m, out, { revise: true });
    res.json({ ok: true, version: out.version, changed: out.changed });
  } catch (e) { logger.error('mom revise', { error: e.message }); res.status(500).json({ error: 'Could not save the new version.' }); }
});

router.post('/meetings/:id/cancel', async (req, res) => {
  try {
    const m = await editable(req, res); if (!m) return;
    if (m.status === 'published') return res.status(409).json({ error: 'A published MoM cannot be marked as not held.' });
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) return res.status(422).json({ error: 'Say why the connect did not happen.' });
    await inTransaction(async (client) => {
      await client.query(`UPDATE pms.mom_meetings SET status='cancelled', cancel_reason=$2 WHERE id=$1`, [m.id, reason.slice(0, 300)]);
      await audit(client, req, 'MOM_CANCELLED', null, { meeting_id: m.id, date: m.date, reason });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not mark the connect as not held.' }); }
});

router.post('/meetings/:id/acknowledge', async (req, res) => {
  try {
    const t = T(req);
    const m = await meetingWithTeam(t, req.params.id);
    if (!m) return res.status(404).json({ error: 'Meeting not found.' });
    if (!(m.attendee_ids || []).includes(req.user.id)) return res.status(403).json({ error: 'Only an attendee acknowledges a MoM.' });
    const mi = (await db.query(`SELECT id, version, status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
    if (!mi || mi.status !== 'published') return res.status(409).json({ error: 'This MoM is not published yet.' });
    const comment = String((req.body || {}).comment || '').trim().slice(0, 1000) || null;
    await db.query(
      `INSERT INTO pms.mom_acks (tenant_id, minutes_id, employee_id, version, comment) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (minutes_id, employee_id, version) DO UPDATE SET comment=EXCLUDED.comment, acknowledged_at=now()`,
      [t, mi.id, req.user.id, mi.version, comment]);
    if (comment && m.organiser_id && m.organiser_id !== req.user.id) {
      await quietly(notify(t, m.organiser_id, 'mom_ack_comment', `${req.user.name} commented on the ${m.date} MoM`, comment, `${LINK}&mom=${m.id}`));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not save the acknowledgement.' }); }
});

// -------- action items

router.get('/action-items', async (req, res) => {
  try {
    const t = T(req);
    const hr = await hasPermission(req.user, 'pms_admin');
    const scope = ['mine', 'team', 'all'].includes(req.query.scope) ? req.query.scope : 'mine';
    if (scope === 'all' && !hr) return res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
    const status = ['open', 'done', 'cancelled', 'any'].includes(req.query.status) ? req.query.status : 'open';
    const params = [t];
    const where = ["a.tenant_id=$1", "mi.status='published'"];
    if (scope !== 'all') { params.push(req.user.id); where.push(`${scope === 'mine' ? 'a.owner_id' : 'mt.manager_id'}=$2`); }
    if (status !== 'any') { params.push(status); where.push(`a.status=$${params.length}`); }
    const { date } = localNow();
    const rows = (await db.query(
      `SELECT a.id, a.task, a.owner_id, e.name AS owner_name, to_char(a.due_date,'YYYY-MM-DD') AS due_date, a.priority, a.status,
              to_char(a.closed_on,'YYYY-MM-DD') AS closed_on, a.carried_forward_count,
              mm.id AS meeting_id, mm.title, to_char(mm.meeting_date,'YYYY-MM-DD') AS meeting_date, mt.manager_id, mg.name AS manager_name
         FROM pms.mom_action_items a
         JOIN pms.mom_minutes mi ON mi.id=a.minutes_id
         JOIN pms.mom_meetings mm ON mm.id=mi.meeting_id
         JOIN pms.mom_teams mt ON mt.id=a.team_id
         LEFT JOIN core.employees e ON e.id=a.owner_id
         LEFT JOIN core.employees mg ON mg.id=mt.manager_id
        WHERE ${where.join(' AND ')}
        ORDER BY (a.status='open') DESC, a.due_date NULLS LAST, a.created_at LIMIT 1000`, params)).rows;
    res.json({ scope, today: date, hr, items: rows.map((a) => ({ ...a,
      overdue: a.status === 'open' && a.due_date && a.due_date < date,
      can_update: hr || a.owner_id === req.user.id || a.manager_id === req.user.id })) });
  } catch (e) { logger.error('mom actions', { error: e.message }); res.status(500).json({ error: 'Could not load the action items.' }); }
});

router.put('/action-items/:id', async (req, res) => {
  try {
    const t = T(req);
    const a = (await db.query(
      `SELECT a.*, mt.manager_id, mi.status AS mom_status FROM pms.mom_action_items a
         JOIN pms.mom_teams mt ON mt.id=a.team_id JOIN pms.mom_minutes mi ON mi.id=a.minutes_id
        WHERE a.tenant_id=$1 AND a.id=$2`, [t, req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'Action item not found.' });
    if (a.mom_status !== 'published') return res.status(409).json({ error: 'This item is still in a draft MoM; change it there.' });
    const hr = await hasPermission(req.user, 'pms_admin');
    if (!(hr || a.owner_id === req.user.id || a.manager_id === req.user.id)) return res.status(403).json({ error: 'Only the owner, the team\'s manager or HR updates this item.' });
    const status = String((req.body || {}).status || '');
    if (!['open', 'done', 'cancelled'].includes(status)) return res.status(422).json({ error: "status must be 'open', 'done' or 'cancelled'" });
    await inTransaction(async (client) => {
      await client.query(
        `UPDATE pms.mom_action_items SET status=$2, closed_on = CASE WHEN $2='open' THEN NULL ELSE CURRENT_DATE END,
                closed_by = CASE WHEN $2='open' THEN NULL ELSE $3 END, updated_at=now() WHERE id=$1`, [a.id, status, req.user.email]);
      await audit(client, req, 'MOM_ACTION_UPDATED', a.owner_id, { action_id: a.id, task: a.task, from: a.status, to: status });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not update the action item.' }); }
});

// -------- HR: daily MoM compliance

router.get('/compliance', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
    const t = T(req);
    const date = DATE.test(String(req.query.date || '')) ? req.query.date : localNow().date;
    const holidays = await holidaysFor(t);
    const rows = (await db.query(
      `SELECT mt.id AS team_id, m.name AS manager_name, m.department, mt.enabled, mt.meet_link,
              mm.id AS meeting_id, mm.status, mi.published_at,
              (SELECT count(*)::int FROM pms.mom_action_items a WHERE a.team_id=mt.id AND a.status='open') AS open_items
         FROM pms.mom_teams mt JOIN core.employees m ON m.id=mt.manager_id
         LEFT JOIN pms.mom_meetings mm ON mm.team_id=mt.id AND mm.meeting_date=$2 AND mm.type='daily_connect'
         LEFT JOIN pms.mom_minutes mi ON mi.meeting_id=mm.id
        WHERE mt.tenant_id=$1 AND mt.enabled ORDER BY m.name`, [t, date])).rows;
    const count = (s) => rows.filter((r) => r.status === s).length;
    res.json({ date, working_day: isWorkingDay(date, holidays), teams: rows,
      totals: { teams: rows.length, published: count('published'), missing: count('missing'), scheduled: count('scheduled'), cancelled: count('cancelled') } });
  } catch (e) { logger.error('mom compliance', { error: e.message }); res.status(500).json({ error: 'Could not load the report.' }); }
});

// Started by server/index.js: every five minutes, and once at boot so a
// sleeping instance catches up.
function startScheduler(tenantId) {
  const run = () => tick(tenantId).then((r) => {
    if (r.created || r.reminded || r.missing || r.due || r.overdue || r.escalated) logger.info('mom sweep', r);
  }).catch((e) => logger.warn('mom sweep failed', { error: e.message }));
  run();
  const h = setInterval(run, 5 * 60 * 1000);
  if (h.unref) h.unref();
  return h;
}

module.exports = { router, tick, ensureMeetings, startScheduler, meetLink, localNow, isWorkingDay, publishProblems, changedSections };
