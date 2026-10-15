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
// manager saved.
//
// Part 2: the manager records the call's audio from the PMS in their
// browser, once everyone on the call has accepted the recording notice;
// the pieces arrive while the call runs and are kept encrypted
// (mom-store.js) until the retention rule deletes them.
// Part 3: Google Meet transcribes the call; the manager uploads that
// transcript, and the PMS's AI service drafts the MoM from it
// (mom-transcript.js). Nothing is transcribed on the server.
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
const { narrate } = require('../../core/ai');
const { setConsent } = require('../../core/consent');
const multer = require('multer');
const store = require('./mom-store');
const tx = require('./mom-transcript');

const T = (req) => req.user.tenant_id;
const APP_TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const LINK = '/team/connects?tab=mom';
// What a notice to the organiser or a manager opens: their Team Connects.
const TEAM_LINK = '/team/team-connects?tab=mom';
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

// What publishing needs: the notes, and every action item with a task, an
// owner and a due date. Every problem at once. (Since 15 Oct the form is
// Notes, Action items and Attendance; an older MoM's discussion points
// count as its notes.)
function publishProblems(m) {
  const errors = [];
  if (!String(m.summary || '').trim() && !(m.discussion || []).some((d) => String(d).trim())) errors.push('Write the notes.');
  (m.action_items || []).forEach((a, i) => {
    const n = `Action item ${i + 1}${a.task ? ` ("${String(a.task).slice(0, 40)}")` : ''}`;
    if (!String(a.task || '').trim()) errors.push(`${n} has no task.`);
    if (!a.owner_id) errors.push(`${n} has no owner.`);
    if (!a.due_date) errors.push(`${n} has no due date.`);
  });
  return errors;
}

// The simple form (15 Oct) has one Notes box. The AI, and MoMs written
// before then, also have discussion points, decisions and blockers; they
// are folded into the notes as plain lines, so nothing in them is lost.
function foldNotes(v) {
  const x = v || {};
  const parts = [];
  if (String(x.summary || '').trim()) parts.push(String(x.summary).trim());
  const block = (label, list) => { if (list.length) parts.push(`${label}\n${list.map((l) => `- ${l}`).join('\n')}`); };
  block('Discussed:', (x.discussion || []).map((d) => String(d).trim()).filter(Boolean));
  block('Decided:', (x.decisions || []).map((d) => String(d).trim()).filter(Boolean));
  block('Blockers:', (x.blockers || []).map((b) => (typeof b === 'string' ? b : `${b.issue || ''}${b.help_from ? ` (help from ${b.help_from})` : ''}`).trim()).filter(Boolean));
  return { ...x, summary: parts.join('\n\n') || null, discussion: [], decisions: [], blockers: [] };
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

async function auditAs(client, t, email, action, employeeId, details) {
  await (client || db).query(
    `INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details) VALUES ($1,$2,$3,NULL,$4,$5)`,
    [t, email, action, employeeId || null, details ? JSON.stringify(details) : null]);
}
const audit = (client, req, action, employeeId, details) => auditAs(client, T(req), req.user.email, action, employeeId, details);

async function inTransaction(fn) {
  const client = await db.getClient();
  try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); throw e;
  } finally { client.release(); }
}

const quietly = (p) => p.catch((e) => logger.warn('mom notify failed', { error: e.message }));

// HR's MoM settings (core.admin_settings 'mom'): how long recordings and
// transcripts are kept, and which notices are emailed as well as shown in
// the bell. Everything is emailed unless HR turns a group off.
const EMAIL_GROUPS = {
  reminder: ['mom_reminder'],
  published: ['mom_published', 'mom_revised', 'mom_ack_comment'],
  action_items: ['mom_action_assigned', 'mom_action_due', 'mom_action_overdue', 'mom_action_overdue_manager'],
  missing: ['mom_missing'],
  draft: ['mom_draft_ready', 'mom_draft_failed', 'mom_recording_saved'],
};
function normaliseSettings(v) {
  const x = v && typeof v === 'object' ? v : {};
  const days = (n, d) => (Number.isInteger(Number(n)) && Number(n) >= 1 && Number(n) <= 3650 ? Number(n) : d);
  return { recording_days: days(x.recording_days, 60), transcript_days: days(x.transcript_days, 365),
    email: Object.fromEntries(Object.keys(EMAIL_GROUPS).map((k) => [k, !(x.email && x.email[k] === false)])) };
}
async function settingsFor(t) {
  const row = (await db.query(`SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='mom'`, [t])).rows[0];
  return normaliseSettings(row && row.value);
}
const emailOn = (s, kind) => Object.entries(EMAIL_GROUPS).some(([k, kinds]) => kinds.includes(kind) && s.email[k]);
// A MoM notice: the bell always, an email too unless HR turned its group off.
const tell = (t, s, id, kind, title, body, link) => quietly(notify(t, id, kind, title, body, link, { email: emailOn(s, kind) }));

// ------------------------------------------------------------------ consent
// "Before the first recording, each attendee accepts a recording notice in
// the PMS once; the acceptance is stored with date and time." A new wording
// is a new version, accepted again.
const NOTICE_VERSION = 'v1';
const noticeText = (s) => 'Daily connects may be recorded by the PMS (audio only) and transcribed by Google Meet. '
  + 'The recording and the transcript are used to draft the minutes with AI; the organiser checks and edits the draft before anyone else sees it. '
  + `Recordings are stored encrypted and deleted after ${s.recording_days} days, and transcripts after ${s.transcript_days} days. `
  + 'Only the attendees of the meeting, their manager and HR can play a recording, and every play is logged. '
  + 'You can withdraw at any time: your connects are then not recorded, and their minutes are written by hand.';

async function consentOf(t, ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return {};
  const rows = (await db.query(
    `SELECT employee_id, granted, notice_version FROM core.employee_consents
      WHERE tenant_id=$1 AND consent_type='mom_recording' AND employee_id = ANY($2::uuid[])`, [t, list])).rows;
  const by = Object.fromEntries(rows.map((r) => [r.employee_id, r]));
  return Object.fromEntries(list.map((id) => [id, !!(by[id] && by[id].granted && by[id].notice_version === NOTICE_VERSION)]));
}
// Everyone on the call: the organiser and the attendees.
const onCall = (m) => [...new Set([m.organiser_id, ...(m.attendee_ids || [])].filter(Boolean))];
async function missingConsent(t, m) {
  const c = await consentOf(t, onCall(m));
  const ids = Object.keys(c).filter((id) => !c[id]);
  const names = await namesOf(t, ids);
  return ids.map((id) => ({ id, name: names[id] || 'Former employee' }));
}

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
  const out = { created: 0, reminded: 0, missing: 0, due: 0, overdue: 0, escalated: 0, autosaved: 0, abandoned: 0, expired: 0, redrafted: 0 };
  const L = localNow(now);
  const s = await settingsFor(t);
  out.created = await ensureMeetings(t, now);

  // 15 minutes before: the Meet link, to the organiser and the attendees.
  const soon = (await db.query(
    `SELECT * FROM pms.mom_meetings WHERE tenant_id=$1 AND meeting_date=$2 AND status='scheduled' AND reminded_at IS NULL`,
    [t, L.date])).rows.filter((m) => m.start_time && minutesOf(m.start_time) - L.minutes <= 15 && minutesOf(m.start_time) - L.minutes >= 0);
  for (const m of soon) {
    const claimed = await db.query(`UPDATE pms.mom_meetings SET reminded_at=now() WHERE id=$1 AND reminded_at IS NULL`, [m.id]);
    if (!claimed.rowCount) continue;
    for (const id of new Set([m.organiser_id, ...(m.attendee_ids || [])].filter(Boolean))) {
      await tell(t, s, id, 'mom_reminder', `${m.title} at ${m.start_time}`, `Join on Google Meet: ${m.meet_link}`, LINK);
    }
    out.reminded += 1;
  }

  // 6 pm: a connect with no recording, no transcript and no published MoM
  // is Missing, and its organiser is told once. Earlier days still
  // scheduled are caught up the same way.
  const late = (await db.query(
    `SELECT mm.*, to_char(mm.meeting_date,'YYYY-MM-DD') AS date FROM pms.mom_meetings mm
      WHERE mm.tenant_id=$1 AND mm.status='scheduled'
        AND (mm.meeting_date < $2 OR (mm.meeting_date = $2 AND $3::int >= 18*60))
        AND NOT EXISTS (SELECT 1 FROM pms.mom_recordings r WHERE r.meeting_id=mm.id)
        AND NOT EXISTS (SELECT 1 FROM pms.mom_transcripts x WHERE x.meeting_id=mm.id)`, [t, L.date, L.minutes])).rows;
  for (const m of late) {
    await db.query(`UPDATE pms.mom_meetings SET status='missing', missing_notified_at=now() WHERE id=$1 AND status='scheduled'`, [m.id]);
    if (m.organiser_id) {
      await tell(t, s, m.organiser_id, 'mom_missing', `MoM missing: ${m.title} (${m.date})`,
        'No MoM was published for this connect. Write it by hand, or mark the connect as not held.', `${TEAM_LINK}&mom=${m.id}`);
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
        await tell(t, s, a.owner_id, 'mom_action_due', 'Action item due today', a.task, `${LINK}&sub=actions`);
        out.due += 1;
      } else if (a.due < L.date && !a.overdue_reminded_on) {
        await db.query(`UPDATE pms.mom_action_items SET overdue_reminded_on=$2 WHERE id=$1`, [a.id, L.date]);
        await tell(t, s, a.owner_id, 'mom_action_overdue', 'Action item overdue', `${a.task} (due ${a.due})`, `${LINK}&sub=actions`);
        out.overdue += 1;
      }
      if (daysBetween(a.due, L.date) >= 3 && !a.manager_alerted_on && a.owner_manager) {
        await db.query(`UPDATE pms.mom_action_items SET manager_alerted_on=$2 WHERE id=$1`, [a.id, L.date]);
        await tell(t, s, a.owner_manager, 'mom_action_overdue_manager', `${a.owner_name}: action item 3 days overdue`,
          `${a.task} (due ${a.due})`, `${TEAM_LINK}&sub=actions`);
        out.escalated += 1;
      }
    }
  }

  // A recording whose pieces stopped arriving (the tab was closed, the
  // laptop slept) is kept as far as it got, if it is the connect's only
  // one; an abandoned file upload or a broken one is cleared away.
  const orphans = (await db.query(
    `SELECT u.*, mm.organiser_id, mm.title, mm.status AS meeting_status, to_char(mm.meeting_date,'YYYY-MM-DD') AS date
       FROM pms.mom_uploads u JOIN pms.mom_meetings mm ON mm.id=u.meeting_id
      WHERE u.tenant_id=$1 AND u.status='open' AND COALESCE(u.last_chunk_at, u.started_at) < now() - interval '15 minutes'`, [t])).rows;
  for (const u of orphans) {
    const segs = await store.segments(u.id);
    const has = (await db.query(`SELECT 1 FROM pms.mom_recordings WHERE meeting_id=$1 AND deleted_at IS NULL`, [u.meeting_id])).rowCount;
    if (u.source === 'browser' && segs.length && segs.every((x, i) => x === i) && !has && !['published', 'cancelled'].includes(u.meeting_status)) {
      await saveRecording(t, { id: u.meeting_id, date: u.date }, u, null, u.started_by);
      if (u.organiser_id) {
        await tell(t, s, u.organiser_id, 'mom_recording_saved', `Recording saved: ${u.title}, ${u.date}`,
          'The recording stopped before Stop was pressed. What reached the PMS has been kept.', `${TEAM_LINK}&mom=${u.meeting_id}`);
      }
      out.autosaved += 1;
    } else {
      await db.query(`UPDATE pms.mom_uploads SET status='abandoned' WHERE id=$1 AND status='open'`, [u.id]);
      await store.remove(u.id).catch((e) => logger.warn('mom upload cleanup', { error: e.message }));
      out.abandoned += 1;
    }
  }

  // An AI draft that never came back (the server restarted mid-way) is
  // tried again, three times in all.
  const stuck = (await db.query(
    `SELECT id, draft_attempts FROM pms.mom_meetings WHERE tenant_id=$1 AND status='processing'
        AND (processing_since IS NULL OR processing_since < now() - interval '20 minutes')`, [t])).rows;
  for (const m of stuck) {
    if (m.draft_attempts >= 3) {
      await db.query(`UPDATE pms.mom_meetings SET status='scheduled', processing_since=NULL,
                        draft_error='The AI draft did not finish. Try again, or write the MoM by hand.' WHERE id=$1 AND status='processing'`, [m.id]);
    } else {
      await runDraft(t, m.id, 'system');
      out.redrafted += 1;
    }
  }

  // Retention: recordings after HR's number of days (60 unless changed),
  // transcripts after theirs (a year). The MoM and its items stay. By the
  // database's date, not the sweep's clock: files age in real days.
  const expired = (await db.query(
    `SELECT id, upload_id, meeting_id FROM pms.mom_recordings WHERE tenant_id=$1 AND deleted_at IS NULL AND delete_after <= CURRENT_DATE`,
    [t])).rows;
  for (const r of expired) {
    await store.remove(r.upload_id);
    await db.query(`UPDATE pms.mom_recordings SET deleted_at=now() WHERE id=$1`, [r.id]);
    await auditAs(null, t, 'system', 'MOM_RECORDING_DELETED', null, { meeting_id: r.meeting_id, reason: 'retention' });
    out.expired += 1;
  }
  const oldTranscripts = (await db.query(
    `UPDATE pms.mom_transcripts SET text=NULL, speakers='{}', deleted_at=now()
      WHERE tenant_id=$1 AND deleted_at IS NULL AND delete_after <= CURRENT_DATE RETURNING meeting_id`, [t])).rows;
  if (oldTranscripts.length) {
    // The AI's stored input held the transcript too.
    if ((await db.query(`SELECT to_regclass('agentic.drafts') AS t`)).rows[0].t) {
      await db.query(
        `UPDATE agentic.drafts SET input = jsonb_set(input, '{transcript}', '"(deleted under the retention rule)"')
          WHERE tenant_id=$1 AND kind='mom_draft' AND input ? 'transcript' AND ref->>'meeting_id' = ANY($2::text[])`,
        [t, oldTranscripts.map((x) => x.meeting_id)]);
    }
    for (const x of oldTranscripts) await auditAs(null, t, 'system', 'MOM_TRANSCRIPT_DELETED', null, { meeting_id: x.meeting_id, reason: 'retention' });
    out.expired += oldTranscripts.length;
  }
  return out;
}

// ------------------------------------------------------------------ recordings

const MAX_RECORDING_BYTES = 300 * 1024 * 1024;
const CHUNK_BYTES = 5 * 1024 * 1024;
const MIME_OK = /^(audio|video)\/(webm|ogg|mp4|mpeg|x-m4a|m4a|wav|x-wav|aac)$/;
const EXT = { webm: 'webm', ogg: 'ogg', mp4: 'mp4', mpeg: 'mp3', 'x-m4a': 'm4a', m4a: 'm4a', wav: 'wav', 'x-wav': 'wav', aac: 'aac' };

// The connect's recording, once its pieces are all in. Replaces an earlier
// one (the organiser confirmed that when they started).
async function saveRecording(t, m, u, duration, by) {
  const s = await settingsFor(t);
  const segs = await store.segments(u.id);
  const size = await store.plainSize(u.id);
  const old = (await db.query(`SELECT upload_id FROM pms.mom_recordings WHERE meeting_id=$1`, [m.id])).rows[0];
  await inTransaction(async (client) => {
    await client.query(`UPDATE pms.mom_uploads SET status='done' WHERE id=$1`, [u.id]);
    await client.query(
      `INSERT INTO pms.mom_recordings (tenant_id, meeting_id, upload_id, mime, size_bytes, duration_sec, key_id, source, uploaded_by, delete_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CURRENT_DATE + $10::int)
       ON CONFLICT (meeting_id) DO UPDATE SET upload_id=EXCLUDED.upload_id, mime=EXCLUDED.mime, size_bytes=EXCLUDED.size_bytes,
         duration_sec=EXCLUDED.duration_sec, key_id=EXCLUDED.key_id, source=EXCLUDED.source, uploaded_by=EXCLUDED.uploaded_by,
         uploaded_at=now(), delete_after=EXCLUDED.delete_after, deleted_at=NULL`,
      [t, m.id, u.id, u.mime, size, duration, u.key_id, u.source, by, s.recording_days]);
    await auditAs(client, t, by, 'MOM_RECORDING_SAVED', null, { meeting_id: m.id, date: m.date, bytes: size, pieces: segs.length, source: u.source, replaced: !!old });
  });
  if (old && old.upload_id !== u.id) await store.remove(old.upload_id).catch((e) => logger.warn('mom old recording cleanup', { error: e.message }));
}

// ------------------------------------------------------------------ the AI draft

// Draft the MoM from the connect's transcript, in the background: the
// upload answers at once and the editor shows Processing until this is
// done. Failure is reported to the organiser and on the MoM, never silent.
const drafting = new Set();
async function runDraft(t, meetingId, requestedBy) {
  if (drafting.has(meetingId)) return;
  drafting.add(meetingId);
  let m = null;
  try {
    const claim = (await db.query(
      `UPDATE pms.mom_meetings SET draft_attempts=draft_attempts+1, processing_since=now()
        WHERE id=$1 AND tenant_id=$2 AND status='processing' RETURNING draft_attempts`, [meetingId, t])).rows[0];
    if (!claim) return;
    m = await meetingWithTeam(t, meetingId);
    const s = await settingsFor(t);
    try {
      const tr = (await db.query(`SELECT id, text FROM pms.mom_transcripts WHERE meeting_id=$1 AND deleted_at IS NULL`, [m.id])).rows[0];
      if (!tr || !tr.text) throw new Error('The transcript is no longer stored. Upload it again.');
      const names = await namesOf(t, onCall(m));
      const attendees = (m.attendee_ids || []).filter((id) => names[id]).map((id) => ({ id, name: names[id] }));
      const people = (await db.query(
        `SELECT id, name FROM core.employees WHERE tenant_id=$1 AND status='active' AND (id = ANY($2::uuid[]) OR manager_id=$3)`,
        [t, onCall(m), m.manager_id])).rows;
      const mi = (await db.query(`SELECT id, status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
      const carried = (await carriedForward(t, m.team_id, mi && mi.id)).map((a, i) => ({ ref: `C${i + 1}`, id: a.id, task: a.task, owner: a.owner_name, due_date: a.due_date }));
      const out = await narrate({
        tenantId: t, kind: 'mom_draft', ref: { meeting_id: m.id, transcript_id: tr.id }, requestedBy, maxTokens: 4000, system: tx.SYSTEM,
        input: {
          meeting: { title: m.title, date: m.date, start_time: m.start_time, end_time: m.end_time, organiser: names[m.organiser_id] || null },
          attendees: attendees.map((a) => a.name),
          open_items_from_previous: carried.map(({ id, ...c }) => c),
          transcript: tr.text,
        },
      });
      if (!out.draft || out.draft._unparsed) throw new Error('The AI reply could not be read. Try again.');
      const d = tx.draftToMinutes(out.draft, { people, attendees, carried, words: tr.text.split(/\s+/).filter(Boolean).length });
      d.value = foldNotes(d.value);
      const done = await inTransaction(async (client) => {
        const still = (await client.query(`SELECT status FROM pms.mom_meetings WHERE id=$1 FOR UPDATE`, [m.id])).rows[0];
        if (!still || still.status !== 'processing') return false; // published by hand or cancelled meanwhile
        const row = await writeMinutes(client, { user: { tenant_id: t, email: requestedBy } }, m, d.value, { published: false });
        await client.query(`UPDATE pms.mom_minutes SET source='ai', ai_confidence=$2, ai_notes=$3, transcript_id=$4, ai_draft_id=$5 WHERE id=$1`,
          [row.id, d.confidence, JSON.stringify(d.notes), tr.id, out.id]);
        await client.query(`UPDATE pms.mom_meetings SET status='draft_ready', draft_error=NULL, processing_since=NULL WHERE id=$1`, [m.id]);
        await auditAs(client, t, requestedBy, 'MOM_AI_DRAFTED', null,
          { meeting_id: m.id, date: m.date, confidence: d.confidence, draft_id: out.id, action_items: d.value.action_items.length });
        return true;
      });
      if (done && m.organiser_id) {
        await tell(t, s, m.organiser_id, 'mom_draft_ready', `AI draft ready: ${m.title}, ${m.date}`,
          d.confidence === 'low' ? `Low confidence: ${d.notes.confidence_reason} Review it closely before publishing.` : 'Review it, correct anything that is wrong, and publish.',
          `${TEAM_LINK}&mom=${m.id}`);
      }
    } catch (e) {
      const msg = e.status === 503 ? 'AI is not set up on this server, so the MoM cannot be drafted. Write it by hand.' : String(e.message || 'The AI draft failed.');
      logger.warn('mom draft failed', { meeting_id: meetingId, error: e.message, reason: e.reason });
      const r = await db.query(`UPDATE pms.mom_meetings SET status='scheduled', draft_error=$2, processing_since=NULL WHERE id=$1 AND status='processing'`,
        [meetingId, msg.slice(0, 300)]);
      if (r.rowCount && m && m.organiser_id) {
        await tell(t, s, m.organiser_id, 'mom_draft_failed', `AI draft failed: ${m.title}, ${m.date}`, `${msg} Try again from the MoM, or write it by hand.`, `${TEAM_LINK}&mom=${m.id}`);
      }
    }
  } catch (e) {
    logger.error('mom draft run', { meeting_id: meetingId, error: e.message });
  } finally { drafting.delete(meetingId); }
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
      summary: String(b.summary || '').trim().slice(0, 8000) || null,
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
    const reports = await directReports(T(req), id);
    const consent = await consentOf(T(req), reports.map((r) => r.id));
    res.json({ reports: reports.map((r) => ({ ...r, notice_accepted: consent[r.id] })) });
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
    // Since 15 Oct the manager switches their own team on: saving a Meet
    // link for the first time does it, and the manager or HR can switch it
    // off and on again. Taking the link away switches it off.
    let enabled = !!cur.enabled;
    if (b.enabled !== undefined) enabled = !!b.enabled;
    else if (link && !cur.meet_link) enabled = true;
    if (!link && b.enabled === undefined) enabled = false;
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
              mm.status, mm.organiser_id, o.name AS organiser_name, mi.status AS mom_status, mi.version, mm.attendee_ids, mm.draft_error,
              EXISTS (SELECT 1 FROM pms.mom_recordings r WHERE r.meeting_id=mm.id AND r.deleted_at IS NULL) AS recorded,
              EXISTS (SELECT 1 FROM pms.mom_transcripts x WHERE x.meeting_id=mm.id AND x.deleted_at IS NULL) AS has_transcript
         FROM pms.mom_meetings mm LEFT JOIN core.employees o ON o.id=mm.organiser_id
         LEFT JOIN pms.mom_minutes mi ON mi.meeting_id=mm.id
        WHERE mm.tenant_id=$1 AND mm.meeting_date=$2 AND ($3 = mm.organiser_id OR $3 = ANY(mm.attendee_ids))
        ORDER BY mm.start_time`, [t, date, req.user.id])).rows;
    const meetings = [];
    for (const { attendee_ids: attendees, ...m } of rows) {
      const mine = m.organiser_id === req.user.id;
      // The organiser sees who has not accepted the recording notice yet:
      // until everyone has, Record stays off for this connect.
      meetings.push({ ...m, can_edit: mine,
        consent_missing: mine ? await missingConsent(t, { organiser_id: m.organiser_id, attendee_ids: attendees }) : undefined });
    }
    res.json({ date, meetings });
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
              ($2 = ANY(mm.attendee_ids)) AS attended,
              EXISTS (SELECT 1 FROM pms.mom_recordings r WHERE r.meeting_id=mm.id AND r.deleted_at IS NULL) AS recorded
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
    const recording = (await db.query(
      `SELECT mime, size_bytes, duration_sec, source, uploaded_by, uploaded_at, to_char(delete_after,'YYYY-MM-DD') AS delete_after, deleted_at
         FROM pms.mom_recordings WHERE meeting_id=$1`, [m.id])).rows[0] || null;
    // The transcript is for whoever writes the MoM — the editor's side panel.
    const transcript = role.edit ? (await db.query(
      `SELECT text, language, speakers, source, file_name, uploaded_by, created_at, to_char(delete_after,'YYYY-MM-DD') AS delete_after, deleted_at
         FROM pms.mom_transcripts WHERE meeting_id=$1`, [m.id])).rows[0] || null : null;
    const consent = role.edit ? await consentOf(t, onCall(m)) : null;
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
      minutes: showContent && mi ? { id: mi.id, version: mi.version, status: mi.status, notes: foldNotes(mi).summary || '',
        summary: mi.summary, discussion: mi.discussion,
        decisions: mi.decisions, blockers: mi.blockers, attendance: mi.attendance,
        carried_forward_snapshot: published ? mi.carried_forward : null,
        published_by: mi.published_by, published_at: mi.published_at, updated_by: mi.updated_by, updated_at: mi.updated_at,
        source: mi.source, ai_confidence: mi.ai_confidence, ai_notes: role.edit ? mi.ai_notes : null } : null,
      draft_exists: !!mi && !published,
      action_items: showContent && mi ? await itemsOf(t, mi.id) : [],
      // Live for the editor: what this MoM will carry forward if published now.
      carried_forward: role.edit && !published ? await carriedForward(t, m.team_id, mi && mi.id) : [],
      versions, people,
      acks: role.edit || role.manager ? acks : (myAck ? [myAck] : []),
      pending_acks: role.edit && published ? (m.attendee_ids || []).filter((id) => !acks.some((a) => a.employee_id === id && a.version === mi.version))
        .map((id) => ({ id, name: names[id] || 'Former employee' })) : [],
      can_edit: role.edit && m.status !== 'cancelled',
      recording, transcript,
      consent: consent ? onCall(m).map((id) => ({ id, name: names[id] || 'Former employee', accepted: consent[id] })) : null,
      can_record: role.edit && !published && m.status !== 'cancelled',
      draft_error: role.edit ? m.draft_error : null,
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
    if (cur && cur.status === 'published') return res.status(409).json({ error: 'This MoM is published. Use Edit to change it.' });
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

// Published: attendees are told (nothing to acknowledge since 15 Oct) and
// owners get their items. An edit afterwards tells only the owners of items
// it added; the change itself is kept in the version history and audit log.
async function notifyPublished(req, m, out, { revise, before = [] }) {
  const t = T(req);
  const s = await settingsFor(t);
  const link = `${LINK}&mom=${m.id}`;
  if (!revise) {
    for (const id of new Set((m.attendee_ids || []).filter((x) => x && x !== req.user.id))) {
      await tell(t, s, id, 'mom_published', `MoM published: ${m.title}, ${m.date}`, 'Open the MoM tab to read it.', link);
    }
  }
  const owners = (await db.query(
    `SELECT owner_id, count(*)::int AS n FROM pms.mom_action_items
      WHERE minutes_id=$1 AND status='open' AND owner_id IS NOT NULL AND NOT (id = ANY($2::uuid[])) GROUP BY owner_id`,
    [out.minutesId, before])).rows;
  for (const o of owners) {
    await tell(t, s, o.owner_id, 'mom_action_assigned', `${o.n} action item${o.n === 1 ? '' : 's'} for you from ${m.title}`,
      `From the ${m.date} MoM.`, `${LINK}&sub=actions`);
  }
}

router.post('/meetings/:id/publish', async (req, res) => {
  try {
    const m = await editable(req, res); if (!m) return;
    const cur = (await db.query(`SELECT status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
    if (cur && cur.status === 'published') return res.status(409).json({ error: 'Already published. Use Edit to change it.' });
    const c = cleanMinutes(req.body || {}, await employeeIds(T(req)));
    const errors = [...c.errors, ...publishProblems(c.value)];
    if (errors.length) return res.status(422).json({ error: errors[0], errors });
    const out = await publishVersion(req, m, c.value, { revise: false });
    await notifyPublished(req, m, out, { revise: false });
    res.json({ ok: true, version: out.version });
  } catch (e) { logger.error('mom publish', { error: e.message }); res.status(500).json({ error: 'Could not publish the MoM.' }); }
});

// Edit after publish. Kept as a version under the hood (who changed which
// sections, in the audit log); nobody is asked to acknowledge it.
router.post('/meetings/:id/revise', async (req, res) => {
  try {
    const m = await editable(req, res); if (!m) return;
    const cur = (await db.query(`SELECT id, status FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
    if (!cur || cur.status !== 'published') return res.status(409).json({ error: 'Only a published MoM is edited this way. Save or publish the draft.' });
    const before = (await db.query(`SELECT id FROM pms.mom_action_items WHERE minutes_id=$1`, [cur.id])).rows.map((r) => r.id);
    const c = cleanMinutes(req.body || {}, await employeeIds(T(req)));
    const errors = [...c.errors, ...publishProblems(c.value)];
    if (errors.length) return res.status(422).json({ error: errors[0], errors });
    const out = await publishVersion(req, m, c.value, { revise: true });
    if (out.nothing) return res.status(409).json({ error: 'Nothing has changed.' });
    await notifyPublished(req, m, out, { revise: true, before });
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
      const s = await settingsFor(t);
      await tell(t, s, m.organiser_id, 'mom_ack_comment', `${req.user.name} commented on the ${m.date} MoM`, comment, `${TEAM_LINK}&mom=${m.id}`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not save the acknowledgement.' }); }
});

// -------- recording notice (consent)

router.get('/consent', async (req, res) => {
  try {
    const t = T(req);
    const s = await settingsFor(t);
    const row = (await db.query(
      `SELECT granted, granted_at, revoked_at, notice_version FROM core.employee_consents
        WHERE tenant_id=$1 AND employee_id=$2 AND consent_type='mom_recording'`, [t, req.user.id])).rows[0];
    res.json({ notice: { version: NOTICE_VERSION, text: noticeText(s) },
      accepted: !!(row && row.granted && row.notice_version === NOTICE_VERSION),
      accepted_at: row && row.granted ? row.granted_at : null, withdrawn_at: row ? row.revoked_at : null });
  } catch (e) { logger.error('mom consent read', { error: e.message }); res.status(500).json({ error: 'Could not load the recording notice.' }); }
});

// Only for oneself: nobody accepts the notice on someone else's behalf.
router.post('/consent', async (req, res) => {
  try {
    const accept = (req.body || {}).accept;
    if (typeof accept !== 'boolean') return res.status(422).json({ error: 'accept must be true or false.' });
    await setConsent(T(req), req.user, 'mom_recording', accept, NOTICE_VERSION);
    res.json({ ok: true, accepted: accept });
  } catch (e) { logger.error('mom consent save', { error: e.message }); res.status(500).json({ error: 'Could not save your answer.' }); }
});

// -------- HR: retention and email

router.get('/settings', async (req, res) => {
  try {
    const hr = await hasPermission(req.user, 'pms_admin');
    res.json({ settings: await settingsFor(T(req)), storage: hr ? await store.ready() : undefined });
  } catch (e) { res.status(500).json({ error: 'Could not load the MoM settings.' }); }
});

router.put('/settings', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
    const t = T(req);
    const b = req.body || {};
    const errors = [];
    const days = (k, lo, hi, label) => {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${label} is ${lo} to ${hi} days.`);
      return n;
    };
    const before = await settingsFor(t);
    const next = {
      recording_days: b.recording_days === undefined ? before.recording_days : days('recording_days', 1, 3650, 'Recordings are kept'),
      transcript_days: b.transcript_days === undefined ? before.transcript_days : days('transcript_days', 1, 3650, 'Transcripts are kept'),
      email: { ...before.email },
    };
    for (const [k, v] of Object.entries(b.email && typeof b.email === 'object' ? b.email : {})) {
      if (!(k in EMAIL_GROUPS) || typeof v !== 'boolean') errors.push(`email.${k} is not a setting.`);
      else next.email[k] = v;
    }
    if (errors.length) return res.status(422).json({ error: errors[0], errors });
    await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO core.admin_settings (tenant_id, key, value, updated_at) VALUES ($1,'mom',$2,now())
         ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [t, JSON.stringify(next)]);
      // A new period applies to what is already stored, counted from when
      // each file arrived.
      if (next.recording_days !== before.recording_days) {
        await client.query(`UPDATE pms.mom_recordings SET delete_after = uploaded_at::date + $2::int WHERE tenant_id=$1 AND deleted_at IS NULL`, [t, next.recording_days]);
      }
      if (next.transcript_days !== before.transcript_days) {
        await client.query(`UPDATE pms.mom_transcripts SET delete_after = created_at::date + $2::int WHERE tenant_id=$1 AND deleted_at IS NULL`, [t, next.transcript_days]);
      }
      await audit(client, req, 'MOM_SETTINGS_UPDATED', null, { before, after: next });
    });
    res.json({ ok: true, settings: next });
  } catch (e) { logger.error('mom settings save', { error: e.message }); res.status(500).json({ error: 'Could not save the MoM settings.' }); }
});

// -------- recording (part 2)

// The organiser (or HR) of a connect that is not yet published.
async function openConnect(req, res) {
  const m = await editable(req, res);
  if (!m) return null;
  if (m.status === 'published') { res.status(409).json({ error: 'This MoM is published.' }); return null; }
  return m;
}

async function consentBlock(res, t, m, what) {
  const missing = await missingConsent(t, m);
  if (!missing.length) return false;
  res.status(409).json({
    error: `${missing.map((x) => x.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} not accepted the recording notice, so ${what}. Write the MoM by hand.`,
    missing_consent: missing,
  });
  return true;
}

router.post('/meetings/:id/recording/start', async (req, res) => {
  try {
    const t = T(req);
    const m = await openConnect(req, res); if (!m) return;
    const b = req.body || {};
    const source = b.source === 'file' ? 'file' : 'browser';
    const mime = String(b.mime || '').toLowerCase().split(';')[0].trim();
    if (!MIME_OK.test(mime)) return res.status(422).json({ error: 'That is not an audio or video recording.' });
    if (b.size != null && !(Number(b.size) > 0 && Number(b.size) <= MAX_RECORDING_BYTES)) return res.status(422).json({ error: 'A recording can be at most 300 MB.' });
    if (await consentBlock(res, t, m, 'this connect cannot be recorded')) return;
    const ready = await store.ready();
    if (!ready.ok) {
      logger.error('mom recording storage not ready', { error: ready.error });
      return res.status(503).json({ error: 'Recording storage is not set up on this server. Ask your administrator.' });
    }
    const cur = (await db.query(`SELECT 1 FROM pms.mom_recordings WHERE meeting_id=$1 AND deleted_at IS NULL`, [m.id])).rowCount;
    if (cur && b.replace !== true) return res.status(409).json({ error: 'This connect already has a recording. Recording again replaces it.', needs_replace: true });
    // One recording on its way in per connect: an earlier one still open
    // (another tab, an earlier try) is dropped.
    const open = (await db.query(`UPDATE pms.mom_uploads SET status='abandoned' WHERE meeting_id=$1 AND status='open' RETURNING id`, [m.id])).rows;
    for (const o of open) await store.remove(o.id).catch(() => {});
    const u = (await db.query(
      `INSERT INTO pms.mom_uploads (tenant_id, meeting_id, source, mime, file_name, key_id, started_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [t, m.id, source, mime, b.file_name ? String(b.file_name).slice(0, 200) : null, store.currentKeyId(), req.user.email])).rows[0];
    await audit(null, req, 'MOM_RECORDING_STARTED', null, { meeting_id: m.id, date: m.date, source, replace: !!cur });
    res.json({ ok: true, upload_id: u.id, chunk_bytes: CHUNK_BYTES });
  } catch (e) { logger.error('mom recording start', { error: e.message }); res.status(500).json({ error: 'Could not start the recording.' }); }
});

async function openUpload(req, res) {
  const t = T(req);
  const uploadId = String(req.params.uploadId);
  if (!UUID.test(uploadId)) { res.status(400).json({ error: 'Not a valid id.' }); return null; }
  const u = (await db.query(`SELECT * FROM pms.mom_uploads WHERE tenant_id=$1 AND id=$2 AND meeting_id=$3`, [t, uploadId, req.params.id])).rows[0];
  if (!u) { res.status(404).json({ error: 'Recording upload not found.' }); return null; }
  if (u.started_by !== req.user.email) { res.status(403).json({ error: 'Only the person recording sends the recording.' }); return null; }
  if (u.status !== 'open') { res.status(409).json({ error: 'This recording upload is closed. Send the recording again.', upload_status: u.status }); return null; }
  return u;
}

// One piece of the recording, as raw bytes, in order from 0. Sending a
// piece again replaces it.
router.put('/meetings/:id/recording/:uploadId/chunks/:seq', express.raw({ type: () => true, limit: 8 * 1024 * 1024 }), async (req, res) => {
  try {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq > 99999) return res.status(400).json({ error: 'Not a valid piece number.' });
    const u = await openUpload(req, res); if (!u) return;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buf.length) return res.status(422).json({ error: 'That piece is empty.' });
    if (Number(u.bytes) + buf.length > MAX_RECORDING_BYTES) return res.status(413).json({ error: 'A recording can be at most 300 MB.' });
    await store.writeSegment(u.id, seq, buf, u.key_id);
    await db.query(`UPDATE pms.mom_uploads SET chunks=GREATEST(chunks,$2), bytes=bytes+$3, last_chunk_at=now() WHERE id=$1`, [u.id, seq + 1, buf.length]);
    res.json({ ok: true, seq });
  } catch (e) { logger.error('mom recording piece', { error: e.message }); res.status(500).json({ error: 'Could not store that piece of the recording.' }); }
});

router.post('/meetings/:id/recording/:uploadId/finish', async (req, res) => {
  try {
    const t = T(req);
    const u = await openUpload(req, res); if (!u) return;
    const m = await meetingWithTeam(t, req.params.id);
    const segs = await store.segments(u.id);
    const b = req.body || {};
    if (!segs.length) return res.status(422).json({ error: 'Nothing was recorded.' });
    const want = Number(b.chunks);
    if (segs.some((x, i) => x !== i) || (Number.isInteger(want) && want !== segs.length)) {
      return res.status(422).json({ error: 'Some pieces of the recording have not arrived. Send them again.', received: segs.length });
    }
    const duration = Number.isFinite(Number(b.duration_sec)) ? Math.max(0, Math.min(4 * 3600, Math.round(Number(b.duration_sec)))) : null;
    await saveRecording(t, m, u, duration, req.user.email);
    res.json({ ok: true });
  } catch (e) { logger.error('mom recording finish', { error: e.message }); res.status(500).json({ error: 'Could not save the recording.' }); }
});

router.delete('/meetings/:id/recording/:uploadId', async (req, res) => {
  try {
    const u = await openUpload(req, res); if (!u) return;
    await db.query(`UPDATE pms.mom_uploads SET status='abandoned' WHERE id=$1`, [u.id]);
    await store.remove(u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Could not discard the recording.' }); }
});

// Play (or ?download=1) the connect's recording. Every play and download
// is logged — the specification asks for it.
router.get('/meetings/:id/recording', async (req, res) => {
  try {
    const t = T(req);
    const m = await meetingWithTeam(t, req.params.id);
    if (!m) return res.status(404).json({ error: 'Meeting not found.' });
    const role = await roleIn(req, m, { manager_id: m.manager_id });
    if (!role.view) return res.status(403).json({ error: 'You were not in this meeting.' });
    const r = (await db.query(`SELECT * FROM pms.mom_recordings WHERE meeting_id=$1`, [m.id])).rows[0];
    if (!r) return res.status(404).json({ error: 'This connect has no recording.' });
    if (r.deleted_at) return res.status(410).json({ error: 'This recording was deleted under the retention rule.' });
    const parts = store.readAll(r.upload_id, r.key_id);
    let first;
    try { first = await parts.next(); } catch (e) {
      logger.error('mom recording unreadable', { meeting_id: m.id, error: e.message });
      return res.status(500).json({ error: 'This recording cannot be read on this server (its key has changed).' });
    }
    const download = req.query.download === '1';
    await audit(null, req, download ? 'MOM_RECORDING_DOWNLOADED' : 'MOM_RECORDING_PLAYED', null, { meeting_id: m.id, date: m.date });
    const ext = EXT[r.mime.split('/')[1]] || 'webm';
    res.setHeader('Content-Type', r.mime);
    res.setHeader('Content-Length', String(r.size_bytes));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="connect-${m.date}.${ext}"`);
    const write = (buf) => new Promise((ok) => { if (res.write(buf)) ok(); else res.once('drain', ok); });
    try {
      if (!first.done) await write(first.value);
      for await (const part of parts) await write(part);
      res.end();
    } catch (e) { logger.error('mom recording stream', { meeting_id: m.id, error: e.message }); res.destroy(e); }
  } catch (e) { logger.error('mom recording play', { error: e.message }); if (!res.headersSent) res.status(500).json({ error: 'Could not play the recording.' }); }
});

// -------- Google Meet transcript and the AI draft (part 3)

const transcriptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const oneFile = (req, res, next) => transcriptUpload.single('file')(req, res, (err) => {
  if (!err) return next();
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 5 MB.' : 'The upload could not be read.' });
});

// Before the AI writes over a draft the organiser typed, they confirm.
async function guardDraft(res, m, b) {
  if (m.status === 'processing') { res.status(409).json({ error: 'The AI is already drafting this MoM.' }); return true; }
  const mi = (await db.query(`SELECT summary, discussion, source FROM pms.mom_minutes WHERE meeting_id=$1`, [m.id])).rows[0];
  const typed = mi && (mi.summary || (mi.discussion || []).length);
  if (typed && !(b.replace === true || b.replace === 'true')) {
    res.status(409).json({ error: 'This connect already has a draft MoM. The AI draft will replace it.', needs_replace: true });
    return true;
  }
  return false;
}

async function startDraft(req, m) {
  await db.query(`UPDATE pms.mom_meetings SET status='processing', processing_since=now(), draft_attempts=0, draft_error=NULL WHERE id=$1`, [m.id]);
  runDraft(T(req), m.id, req.user.email);
}

router.post('/meetings/:id/transcript', oneFile, async (req, res) => {
  try {
    const t = T(req);
    const m = await openConnect(req, res); if (!m) return;
    const b = req.body || {};
    // No PMS recording notice since 15 Oct: Google Meet itself tells
    // everyone on the call that it is being transcribed.
    if (await guardDraft(res, m, b)) return;
    let parsed;
    try {
      if (req.file) parsed = await tx.parseTranscript(req.file.buffer, req.file.originalname || 'transcript.txt');
      else if (typeof b.text === 'string' && b.text.trim()) parsed = await tx.parseTranscript(Buffer.from(b.text, 'utf8'), null);
      else return res.status(422).json({ error: 'Choose the transcript file from Google Meet, or paste its text.' });
    } catch (e) { if (e.status === 422) return res.status(422).json({ error: e.message }); throw e; }
    const s = await settingsFor(t);
    await db.query(
      `INSERT INTO pms.mom_transcripts (tenant_id, meeting_id, text, language, speakers, source, file_name, uploaded_by, delete_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_DATE + $9::int)
       ON CONFLICT (meeting_id) DO UPDATE SET text=EXCLUDED.text, language=EXCLUDED.language, speakers=EXCLUDED.speakers,
         source=EXCLUDED.source, file_name=EXCLUDED.file_name, uploaded_by=EXCLUDED.uploaded_by, created_at=now(),
         delete_after=EXCLUDED.delete_after, deleted_at=NULL`,
      [t, m.id, parsed.text, parsed.language, parsed.speakers, req.file ? 'google_meet' : 'paste',
        req.file ? String(req.file.originalname || '').slice(0, 200) : null, req.user.email, s.transcript_days]);
    await audit(null, req, 'MOM_TRANSCRIPT_UPLOADED', null, { meeting_id: m.id, date: m.date, chars: parsed.text.length, source: req.file ? 'google_meet' : 'paste' });
    await startDraft(req, m);
    res.status(202).json({ ok: true, status: 'processing', speakers: parsed.speakers });
  } catch (e) { logger.error('mom transcript', { error: e.message }); res.status(500).json({ error: 'Could not take the transcript.' }); }
});

// Draft again from the stored transcript (after a failure, or to start over).
router.post('/meetings/:id/redraft', async (req, res) => {
  try {
    const t = T(req);
    const m = await openConnect(req, res); if (!m) return;
    const tr = (await db.query(`SELECT 1 FROM pms.mom_transcripts WHERE meeting_id=$1 AND deleted_at IS NULL AND text IS NOT NULL`, [m.id])).rowCount;
    if (!tr) return res.status(409).json({ error: 'Upload the Google Meet transcript first.' });
    if (await guardDraft(res, m, req.body || {})) return;
    await startDraft(req, m);
    res.status(202).json({ ok: true, status: 'processing' });
  } catch (e) { logger.error('mom redraft', { error: e.message }); res.status(500).json({ error: 'Could not start the AI draft.' }); }
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
              mm.id AS meeting_id, mm.status, mi.published_at, mi.source,
              EXISTS (SELECT 1 FROM pms.mom_recordings r WHERE r.meeting_id=mm.id AND r.deleted_at IS NULL) AS recorded,
              (SELECT count(*)::int FROM pms.mom_action_items a WHERE a.team_id=mt.id AND a.status='open') AS open_items
         FROM pms.mom_teams mt JOIN core.employees m ON m.id=mt.manager_id
         LEFT JOIN pms.mom_meetings mm ON mm.team_id=mt.id AND mm.meeting_date=$2 AND mm.type='daily_connect'
         LEFT JOIN pms.mom_minutes mi ON mi.meeting_id=mm.id
        WHERE mt.tenant_id=$1 AND mt.enabled ORDER BY m.name`, [t, date])).rows;
    const count = (s) => rows.filter((r) => r.status === s).length;
    res.json({ date, working_day: isWorkingDay(date, holidays), teams: rows,
      totals: { teams: rows.length, published: count('published'), missing: count('missing'), scheduled: count('scheduled'), cancelled: count('cancelled'),
        draft_ready: count('draft_ready'), processing: count('processing') } });
  } catch (e) { logger.error('mom compliance', { error: e.message }); res.status(500).json({ error: 'Could not load the report.' }); }
});

// Started by server/index.js: every five minutes, and once at boot so a
// sleeping instance catches up.
function startScheduler(tenantId) {
  store.ready().then((r) => { if (!r.ok) logger.warn('mom recording storage is not ready — recordings will be refused', { dir: store.root(), error: r.error }); });
  const run = () => tick(tenantId).then((r) => {
    if (Object.values(r).some(Boolean)) logger.info('mom sweep', r);
  }).catch((e) => logger.warn('mom sweep failed', { error: e.message }));
  run();
  const h = setInterval(run, 5 * 60 * 1000);
  if (h.unref) h.unref();
  return h;
}

module.exports = { router, tick, ensureMeetings, startScheduler, runDraft, meetLink, localNow, isWorkingDay, publishProblems, changedSections, foldNotes, normaliseSettings, NOTICE_VERSION };
