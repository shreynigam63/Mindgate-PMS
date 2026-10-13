// People — the culture layer (spec §5): awards, events + RSVPs, CSR,
// campus, appraisal queries, career matrix/paths. Straightforward CRUD with
// the standard gates: people_view to read, people_admin to administer;
// employees act on their own rows (RSVP, participate, nominate, query).

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { authenticate } = require('../../core/auth');
const { guardUuidParams } = require('../../core/http');
const { apiPermissionParity, hasPermission, holdsPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const pm = require('../performance/phase-machine');
const { activeCycle } = require('../performance/active-cycle');
// The spreadsheet readers live in core/employees because the employee
// importer needed them first; they are format helpers, not employee
// logic, and every importer since has reused them rather than carrying a
// second copy of xlsx parsing.
const { parseExcelSheets, parseCsv, detectFormat } = require('../../core/employees');
const {
  validateCareerTransitionRows, COLUMNS: CT_COLUMNS, rowKey: ctRowKey,
} = require('./career-transitions-import');
const { suggestTransitions, suggestFromGrades, roleAt, levelLabel, timeInRung, competenciesFor, trimPrefix, RANK_FOR_GRADE } = require('./career-ladder');

// One line per configuration change that a person would later ask
// about. The upload route has written to this table since 17 Sep; the
// bulk deletes added on 25 Sep write the same shape, so "who cleared
// the matrix" stays a query rather than an archaeology exercise.
const audit = (req, action, details) => db.query(
  `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
   VALUES ($1,$2,$3,'career_transitions',$4)`,
  [req.user.tenant_id, req.user.email, action, details ? JSON.stringify(details) : null])
  .catch((e) => logger.warn('people audit failed', { action, error: e.message }));

// 2 MB: a career matrix is tens of rows, not tens of thousands. A limit
// this low turns "somebody uploaded the wrong file" into a clear error
// rather than a slow request.
const transitionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = express.Router();
router.use(authenticate, require('../../core/scope-hooks').run(), apiPermissionParity);
// `.run()` is the extension point a module uses to narrow what this
// router returns — today, the HRBP gateway. See core/scope-hooks.js.
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);
const T = (req) => req.user.tenant_id;
// A matrix level is the grade alone (see career-level.js, 13 Oct).
const { gradeOnly } = require('./career-level');
const { experienceFrom, remainingTimeline } = require('./career-timeline');
const levelsAsGrades = (t) => (t ? { ...t, from_level: gradeOnly(t.from_level) || null, to_level: gradeOnly(t.to_level) || null } : t);
const adminOnly = async (req, res) => {
  if (await hasPermission(req.user, 'people_admin')) return true;
  res.status(403).json({ error: "Requires 'people_admin'" }); return false;
};
// Small local lookup rather than importing modules/performance's own
// activeCycle() — that function lives in a router file, not something
// meant to be shared across modules. Same query shape (most recent
// non-closed/cancelled cycle for the tenant, any cycle_type), used only
// to gate Career Path editing to the growth_planning phase per the
// explicit "lock KRA, then open Development Plan and Career Path" request.
async function activeCyclePhase(tenantId) {
  // The shared resolver rather than a local copy of the query: a DRAFT
  // cycle used to win here, which gated Aspiring Career on the phase of a
  // cycle nobody was working in. See performance/active-cycle.js.
  const c = await activeCycle(tenantId);
  return c ? c.phase : null;
}

// Aspiring Career opens on the SAME trigger as the development plan — the
// employee submitting their own KRA sheet — because the two are one tab to
// the person using them, and opening one without the other would be a
// distinction only the phase machine can see.
//
// The rule itself lives in performance/phase-machine (pure, no db) so the
// two modules cannot drift apart; this reads the one fact that file cannot.
// Per horizon since 8 Oct: Long-Term stays open through Manager
// Evaluation and locks at HOD Review (pm.aspirationEditable).
async function growthWindowFor(tenantId, employeeId, horizon = 'short_term') {
  const c = await activeCycle(tenantId);
  if (!c) return { phase: null, window: pm.aspirationEditable(null, { horizon }) };
  const sheet = (await db.query(
    `SELECT status FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
    [tenantId, c.id, employeeId])).rows[0];
  return { phase: c.phase, window: pm.aspirationEditable(c.phase, { sheetStatus: sheet ? sheet.status : null, horizon }) };
}

// One message, so the employee is told the same thing whichever of the two
// routes refused them, and it names the single action that opens it.
const careerShutMessage = (phase, w) => (w.reason === 'kra_not_submitted'
  ? 'Submit your KRAs to your manager first — Aspiring Career opens the moment you do'
  : w.reason === 'long_term_closed' ? w.error
    : `Aspiring Career editing is not open (phase: ${phase || 'no active cycle'}) — it opens in KRA Setting and Growth Planning, once you submit your KRAs`);

// ---- Awards -----------------------------------------------------------------
router.get('/awards', async (req, res) => {
  try {
    const progs = (await db.query(`SELECT * FROM people.award_programs WHERE tenant_id=$1 AND active ORDER BY name`, [T(req)])).rows;
    const cycles = (await db.query(
      `SELECT c.*, p.name AS program_name,
              (SELECT COUNT(*)::int FROM people.award_nominations n WHERE n.cycle_id=c.id) AS nominations
         FROM people.award_cycles c JOIN people.award_programs p ON p.id=c.program_id
        WHERE c.tenant_id=$1 ORDER BY c.opens_at DESC NULLS LAST`, [T(req)])).rows;
    res.json({ programs: progs, cycles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/awards/programs', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await db.query(`INSERT INTO people.award_programs (tenant_id, name, description) VALUES ($1,$2,$3) RETURNING *`,
      [T(req), name, description || null]);
    res.json({ ok: true, program: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/awards/cycles', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { program_id, name, opens_at, closes_at } = req.body || {};
    if (!program_id || !name) return res.status(400).json({ error: 'program_id and name required' });
    const r = await db.query(
      `INSERT INTO people.award_cycles (tenant_id, program_id, name, opens_at, closes_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [T(req), program_id, name, opens_at || null, closes_at || null]);
    res.json({ ok: true, cycle: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/awards/cycles/:cycleId/nominate', async (req, res) => {
  try {
    const { nominee_id, citation } = req.body || {};
    if (!nominee_id || !citation || !citation.trim()) return res.status(400).json({ error: 'nominee_id and citation required — a nomination without a why is noise' });
    const c = (await db.query(`SELECT status FROM people.award_cycles WHERE id=$1 AND tenant_id=$2`, [req.params.cycleId, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'cycle not found' });
    if (c.status !== 'open') return res.status(409).json({ error: `cycle is ${c.status}, not open` });
    if (nominee_id === req.user.id) return res.status(422).json({ error: 'Self-nomination is not accepted' });
    const r = await db.query(
      `INSERT INTO people.award_nominations (tenant_id, cycle_id, nominee_id, nominated_by, citation)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`, [T(req), req.params.cycleId, nominee_id, req.user.id, citation.trim()]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/awards/nominations/:id/decide', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { status } = req.body || {};
    if (!['shortlisted', 'won', 'not_selected'].includes(status)) return res.status(400).json({ error: 'status must be shortlisted|won|not_selected' });
    const r = await db.query(
      `UPDATE people.award_nominations SET status=$1, decided_by=$2, decided_at=now() WHERE id=$3 AND tenant_id=$4 RETURNING nominee_id`,
      [status, req.user.email, req.params.id, T(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'nomination not found' });
    if (status === 'won') await notify(T(req), r.rows[0].nominee_id, 'award_won', 'Congratulations — you have won an award!', null, '/people');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Events + RSVP ---------------------------------------------------------
// HR schedules events and CSR activities on HR → Events & CSR, and
// everyone sees and answers them on People Hub (13 Oct: "apart from
// awards, there is no option for HR to start Events"). The create routes
// were here from the start with no screen in front of them, and nothing
// could change or remove an event once made.
const isoAt = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
const isoDay = (v) => {
  if (v == null || v === '') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()) ? String(v) : undefined;
};
const text = (v, max) => { const t = String(v == null ? '' : v).trim(); return t ? t.slice(0, max) : null; };
// One line per change, so "who cancelled the offsite" has an answer.
const peopleAudit = (req, action, entity, details) => db.query(
  `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details) VALUES ($1,$2,$3,$4,$5)`,
  [req.user.tenant_id, req.user.email, action, entity, JSON.stringify(details || {})])
  .catch((e) => logger.warn('people audit failed', { action, error: e.message }));
// Everyone on the payroll hears about a new one, in the app only — one
// statement for the whole company rather than a notify() per person, and
// no email: mailing everybody per event is not a default anyone chose.
const tellEveryone = (req, kind, title, body) => db.query(
  `INSERT INTO core.notifications (tenant_id, employee_id, kind, title, body, link)
   SELECT $1, id, $2, $3, $4, '/people' FROM core.employees
    WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL`,
  [T(req), kind, title, body])
  .catch((e) => logger.warn('people notify-all failed', { kind, error: e.message }));
// Attendee lists are HR's: pms_admin's sibling people_admin HELD, never the
// copy the HRBP gateway lends.
const holdsPeopleAdmin = async (req, res) => {
  if (await holdsPermission(req.user, 'people_admin')) return true;
  res.status(403).json({ error: "Requires 'people_admin'", needs: 'people_admin' }); return false;
};

/** An event's fields from a request, merged over what is stored; errors in words. */
function eventFrom(b, was = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const ev = {
    title: has('title') ? text(b.title, 200) : was.title,
    description: has('description') ? text(b.description, 4000) : was.description ?? null,
    location: has('location') ? text(b.location, 300) : was.location ?? null,
    starts_at: has('starts_at') ? isoAt(b.starts_at) : (was.starts_at ? new Date(was.starts_at).toISOString() : null),
    ends_at: has('ends_at') ? isoAt(b.ends_at) : (was.ends_at ? new Date(was.ends_at).toISOString() : null),
  };
  if (!ev.title) return { error: 'Give the event a title.' };
  if (!ev.starts_at) return { error: 'Give the event a valid start date and time.' };
  if (ev.ends_at === undefined) return { error: 'The end date and time is not a valid date.' };
  if (ev.ends_at && ev.ends_at < ev.starts_at) return { error: 'The event ends before it starts.' };
  return { ev };
}

router.get('/events', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT e.*, (SELECT COUNT(*)::int FROM people.event_rsvps r WHERE r.event_id=e.id AND r.response='yes') AS yes_count,
              (SELECT response FROM people.event_rsvps r WHERE r.event_id=e.id AND r.employee_id=$2) AS my_rsvp
         FROM people.events e WHERE e.tenant_id=$1 ORDER BY e.starts_at DESC LIMIT 100`, [T(req), req.user.id]);
    res.json({ events: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/events', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { ev, error } = eventFrom(req.body || {});
    if (error) return res.status(400).json({ error });
    const r = await db.query(
      `INSERT INTO people.events (tenant_id, title, description, location, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [T(req), ev.title, ev.description, ev.location, ev.starts_at, ev.ends_at, req.user.email]);
    await peopleAudit(req, 'EVENT_CREATED', 'people_events', { id: r.rows[0].id, title: ev.title, starts_at: ev.starts_at });
    if (req.body.notify !== false) {
      const when = new Date(ev.starts_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
      await tellEveryone(req, 'event_scheduled', `New event: ${ev.title}`, [when, ev.location].filter(Boolean).join(' · '));
    }
    res.json({ ok: true, event: r.rows[0] });
  } catch (e) { logger.error('event create', { error: e.message }); res.status(500).json({ error: 'Could not save the event' }); }
});

router.put('/events/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const was = (await db.query(`SELECT * FROM people.events WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!was) return res.status(404).json({ error: 'That event no longer exists.' });
    const { ev, error } = eventFrom(req.body || {}, was);
    if (error) return res.status(400).json({ error });
    const r = await db.query(
      `UPDATE people.events SET title=$3, description=$4, location=$5, starts_at=$6, ends_at=$7
        WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, T(req), ev.title, ev.description, ev.location, ev.starts_at, ev.ends_at]);
    await peopleAudit(req, 'EVENT_UPDATED', 'people_events', { id: was.id, title: ev.title, from: { title: was.title, starts_at: was.starts_at } });
    res.json({ ok: true, event: r.rows[0] });
  } catch (e) { logger.error('event update', { error: e.message }); res.status(500).json({ error: 'Could not save the event' }); }
});

router.delete('/events/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const r = await db.query(
      `DELETE FROM people.events WHERE id=$1 AND tenant_id=$2
       RETURNING title, starts_at, (SELECT COUNT(*)::int FROM people.event_rsvps WHERE event_id=$1) AS rsvps`,
      [req.params.id, T(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'That event no longer exists.' });
    await peopleAudit(req, 'EVENT_DELETED', 'people_events', { id: req.params.id, ...r.rows[0] });
    res.json({ ok: true });
  } catch (e) { logger.error('event delete', { error: e.message }); res.status(500).json({ error: 'Could not delete the event' }); }
});

// Who answered, and how. HR's view of an event's turnout.
router.get('/events/:id/rsvps', async (req, res) => {
  try {
    if (!(await holdsPeopleAdmin(req, res))) return;
    const ev = (await db.query(`SELECT id FROM people.events WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!ev) return res.status(404).json({ error: 'That event no longer exists.' });
    const r = await db.query(
      `SELECT r.employee_id, e.name, e.department, r.response, r.at
         FROM people.event_rsvps r JOIN core.employees e ON e.id=r.employee_id AND e.tenant_id=r.tenant_id
        WHERE r.event_id=$1 AND r.tenant_id=$2 ORDER BY r.response, e.name`, [ev.id, T(req)]);
    res.json({ rsvps: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/events/:id/rsvp', async (req, res) => {
  try {
    const response = (req.body && req.body.response) || 'yes';
    if (!['yes', 'no', 'maybe'].includes(response)) return res.status(400).json({ error: 'response must be yes|no|maybe' });
    // An event HR has since removed is a clear answer, not a database error.
    const ev = (await db.query(`SELECT id FROM people.events WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!ev) return res.status(404).json({ error: 'That event no longer exists.' });
    await db.query(
      `INSERT INTO people.event_rsvps (tenant_id, event_id, employee_id, response) VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id, employee_id) DO UPDATE SET response=EXCLUDED.response, at=now()`,
      [T(req), ev.id, req.user.id, response]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- CSR --------------------------------------------------------------------
/** A CSR activity's fields from a request, merged over what is stored. */
function csrFrom(b, was = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const hours = has('hours_credit') ? (b.hours_credit === '' || b.hours_credit == null ? 0 : Number(b.hours_credit)) : Number(was.hours_credit || 0);
  const c = {
    title: has('title') ? text(b.title, 200) : was.title,
    description: has('description') ? text(b.description, 4000) : was.description ?? null,
    event_date: has('event_date') ? isoDay(b.event_date) : (was.event_date ? new Date(was.event_date).toISOString().slice(0, 10) : null),
    hours_credit: hours,
  };
  if (!c.title) return { error: 'Give the activity a title.' };
  if (c.event_date === undefined) return { error: 'The date is not a valid date.' };
  if (!Number.isFinite(c.hours_credit) || c.hours_credit < 0 || c.hours_credit > 999) return { error: 'Hours credit must be a number from 0 to 999.' };
  return { c };
}

router.get('/csr', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM people.csr_participations p WHERE p.csr_event_id=c.id) AS participants,
              (SELECT hours FROM people.csr_participations p WHERE p.csr_event_id=c.id AND p.employee_id=$2) AS my_hours
         FROM people.csr_events c WHERE c.tenant_id=$1 ORDER BY c.event_date DESC NULLS LAST LIMIT 100`, [T(req), req.user.id]);
    res.json({ csr: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/csr', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { c, error } = csrFrom(req.body || {});
    if (error) return res.status(400).json({ error });
    const r = await db.query(
      `INSERT INTO people.csr_events (tenant_id, title, description, event_date, hours_credit) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [T(req), c.title, c.description, c.event_date, c.hours_credit]);
    await peopleAudit(req, 'CSR_CREATED', 'people_csr', { id: r.rows[0].id, title: c.title, event_date: c.event_date });
    if (req.body.notify !== false) {
      await tellEveryone(req, 'csr_scheduled', `New CSR activity: ${c.title}`,
        [c.event_date, c.hours_credit ? `${c.hours_credit} hours credit` : null].filter(Boolean).join(' · ') || null);
    }
    res.json({ ok: true, csr: r.rows[0] });
  } catch (e) { logger.error('csr create', { error: e.message }); res.status(500).json({ error: 'Could not save the activity' }); }
});

router.put('/csr/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const was = (await db.query(`SELECT * FROM people.csr_events WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!was) return res.status(404).json({ error: 'That activity no longer exists.' });
    const { c, error } = csrFrom(req.body || {}, was);
    if (error) return res.status(400).json({ error });
    const r = await db.query(
      `UPDATE people.csr_events SET title=$3, description=$4, event_date=$5, hours_credit=$6
        WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, T(req), c.title, c.description, c.event_date, c.hours_credit]);
    await peopleAudit(req, 'CSR_UPDATED', 'people_csr', { id: was.id, title: c.title, from: { title: was.title } });
    res.json({ ok: true, csr: r.rows[0] });
  } catch (e) { logger.error('csr update', { error: e.message }); res.status(500).json({ error: 'Could not save the activity' }); }
});

router.delete('/csr/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const r = await db.query(
      `DELETE FROM people.csr_events WHERE id=$1 AND tenant_id=$2
       RETURNING title, event_date, (SELECT COUNT(*)::int FROM people.csr_participations WHERE csr_event_id=$1) AS participants`,
      [req.params.id, T(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'That activity no longer exists.' });
    await peopleAudit(req, 'CSR_DELETED', 'people_csr', { id: req.params.id, ...r.rows[0] });
    res.json({ ok: true });
  } catch (e) { logger.error('csr delete', { error: e.message }); res.status(500).json({ error: 'Could not delete the activity' }); }
});

router.get('/csr/:id/participants', async (req, res) => {
  try {
    if (!(await holdsPeopleAdmin(req, res))) return;
    const c = (await db.query(`SELECT id FROM people.csr_events WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'That activity no longer exists.' });
    const r = await db.query(
      `SELECT p.employee_id, e.name, e.department, p.hours, p.at
         FROM people.csr_participations p JOIN core.employees e ON e.id=p.employee_id AND e.tenant_id=p.tenant_id
        WHERE p.csr_event_id=$1 AND p.tenant_id=$2 ORDER BY e.name`, [c.id, T(req)]);
    res.json({ participants: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/csr/:id/participate', async (req, res) => {
  try {
    const raw = req.body && req.body.hours;
    const hours = raw == null || raw === '' ? null : Number(raw);
    if (hours != null && (!Number.isFinite(hours) || hours < 0 || hours > 999)) {
      return res.status(400).json({ error: 'Hours must be a number from 0 to 999.' });
    }
    const c = (await db.query(`SELECT id FROM people.csr_events WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'That activity no longer exists.' });
    await db.query(
      `INSERT INTO people.csr_participations (tenant_id, csr_event_id, employee_id, hours) VALUES ($1,$2,$3,$4)
       ON CONFLICT (csr_event_id, employee_id) DO UPDATE SET hours=EXCLUDED.hours, at=now()`,
      [T(req), c.id, req.user.id, hours]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Campus -----------------------------------------------------------------
router.get('/campus', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const drives = (await db.query(
      `SELECT d.*, (SELECT COUNT(*)::int FROM people.campus_candidates c WHERE c.drive_id=d.id) AS candidates
         FROM people.campus_drives d WHERE d.tenant_id=$1 ORDER BY d.drive_date DESC NULLS LAST`, [T(req)])).rows;
    res.json({ drives });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/campus/drives', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { college, drive_date, roles } = req.body || {};
    if (!college) return res.status(400).json({ error: 'college required' });
    const r = await db.query(
      `INSERT INTO people.campus_drives (tenant_id, college, drive_date, roles) VALUES ($1,$2,$3,$4) RETURNING *`,
      [T(req), college, drive_date || null, roles || null]);
    res.json({ ok: true, drive: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/campus/drives/:driveId/candidates', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const { name, email, phone, stage, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await db.query(
      `INSERT INTO people.campus_candidates (tenant_id, drive_id, name, email, phone, stage, notes)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'applied'),$7) RETURNING *`,
      [T(req), req.params.driveId, name, email || null, phone || null, stage || null, notes || null]);
    res.json({ ok: true, candidate: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Appraisal queries ------------------------------------------------------
router.get('/queries', async (req, res) => {
  try {
    const admin = await hasPermission(req.user, 'people_admin');
    const r = await db.query(
      `SELECT q.*, e.name AS employee_name,
              (SELECT COUNT(*)::int FROM people.appraisal_query_messages m WHERE m.query_id=q.id) AS messages
         FROM people.appraisal_queries q JOIN core.employees e ON e.id=q.employee_id
        WHERE q.tenant_id=$1 ${admin ? '' : 'AND q.employee_id=$2'} ORDER BY q.created_at DESC`,
      admin ? [T(req)] : [T(req), req.user.id]);
    res.json({ queries: r.rows, admin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queries', async (req, res) => {
  try {
    const { subject, cycle_id, body } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
    const q = (await db.query(
      `INSERT INTO people.appraisal_queries (tenant_id, employee_id, cycle_id, subject) VALUES ($1,$2,$3,$4) RETURNING *`,
      [T(req), req.user.id, cycle_id || null, subject])).rows[0];
    await db.query(`INSERT INTO people.appraisal_query_messages (tenant_id, query_id, author_id, body) VALUES ($1,$2,$3,$4)`,
      [T(req), q.id, req.user.id, body]);
    res.json({ ok: true, query: q });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/queries/:id/reply', async (req, res) => {
  try {
    const { body, close } = req.body || {};
    const q = (await db.query(`SELECT * FROM people.appraisal_queries WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!q) return res.status(404).json({ error: 'query not found' });
    const admin = await hasPermission(req.user, 'people_admin');
    if (!admin && q.employee_id !== req.user.id) return res.status(403).json({ error: 'Not your query' });
    if (body && body.trim()) {
      await db.query(`INSERT INTO people.appraisal_query_messages (tenant_id, query_id, author_id, body) VALUES ($1,$2,$3,$4)`,
        [T(req), q.id, req.user.id, body.trim()]);
      if (admin && q.status === 'open') await db.query(`UPDATE people.appraisal_queries SET status='answered' WHERE id=$1`, [q.id]);
      if (admin) await notify(T(req), q.employee_id, 'query_reply', `Reply on: ${q.subject}`, null, '/people/queries');
    }
    if (close) await db.query(`UPDATE people.appraisal_queries SET status='closed' WHERE id=$1`, [q.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/queries/:id/messages', async (req, res) => {
  try {
    const q = (await db.query(`SELECT * FROM people.appraisal_queries WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!q) return res.status(404).json({ error: 'query not found' });
    const admin = await hasPermission(req.user, 'people_admin');
    if (!admin && q.employee_id !== req.user.id) return res.status(403).json({ error: 'Not your query' });
    const r = await db.query(
      `SELECT m.*, e.name AS author_name FROM people.appraisal_query_messages m
         JOIN core.employees e ON e.id=m.author_id WHERE m.query_id=$1 ORDER BY m.at`, [q.id]);
    res.json({ query: q, messages: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Career -----------------------------------------------------------------
// Career Framework (a flat role_band/level allow-list, people.career_matrix)
// was removed here in favour of the Career Pathing Matrix
// (people.career_transitions) — the guardrail check below now validates
// against specific from-role -> to-role transitions instead of a flat
// list. The career_matrix TABLE itself was deliberately left in place
// (not dropped) rather than adding a destructive migration; it's simply
// unused now, with nothing reading or writing to it.

// Distinct designations already on file for real employees — feeds the
// From Role / To Role dropdowns ("sourced from hr.employees — exact match
// guaranteed") rather than letting HR type a role name that doesn't
// actually match anyone.
router.get('/designations', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT DISTINCT designation FROM core.employees WHERE tenant_id=$1 AND designation IS NOT NULL AND designation <> '' ORDER BY designation`,
      [T(req)]);
    res.json({ designations: r.rows.map((row) => row.designation) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Career Pathing Matrix (CR-11, phase 1 of 2 — richer transition rules on
// top of the simpler career_matrix band/level list above). Requested with
// reference screenshots of a "New transition" form; built to the exact
// fields shown, with min/typical time-in-role stored and displayed but
// NOT enforced (see migration 022's comment for why).
// The departments that actually exist, so the matrix's Department field
// is a dropdown for the same reason From Role is one — a department
// typed by hand that matches no employee is a rung nobody can ever see.
router.get('/departments', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT DISTINCT btrim(department) AS department FROM core.employees
        WHERE tenant_id=$1 AND coalesce(btrim(department),'') <> '' ORDER BY 1`,
      [T(req)]);
    res.json({ departments: r.rows.map((row) => row.department) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The grades on the Grade and Level sheet, for the matrix's From Level /
// To Level dropdowns. Grade only: the band stays on that sheet (13 Oct).
// Until then these dropdowns listed the employee master's role bands.
router.get('/grades', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT grade FROM pms.grade_ladder WHERE tenant_id=$1 ORDER BY sort_order`, [T(req)]);
    res.json({ grades: r.rows.map((row) => row.grade) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// How many active employees a from_role (in a department, if one is
// named) actually matches. Shown while HR fills the form, so a transition
// that matches NOBODY is visible at the moment it is created rather than
// discovered weeks later by an employee being told no path exists. Level
// plays no part: moves are matched on role and department (13 Oct).
router.get('/career/match-count', async (req, res) => {
  try {
    const fromRole = (req.query.from_role || '').trim();
    if (!fromRole) return res.json({ count: 0, from_role: null });
    const department = (req.query.department || '').trim() || null;
    const r = await db.query(
      `SELECT count(*)::int AS n FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND LOWER(TRIM(designation)) = LOWER(TRIM($2))
          AND ($3::text IS NULL OR LOWER(TRIM(department)) = LOWER(TRIM($3)))`,
      [T(req), fromRole, department]);
    res.json({ count: r.rows[0].n, from_role: fromRole, department });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/career/transitions', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const includeInactive = req.query.active === 'false' || req.query.show_inactive === 'true';
    const q = (req.query.q || '').trim();
    const params = [T(req)];
    let where = `tenant_id=$1 ${includeInactive ? '' : 'AND active=true'}`;
    if (q) {
      params.push(`%${q}%`);
      where += ` AND (from_role ILIKE $${params.length} OR to_role ILIKE $${params.length} OR from_level ILIKE $${params.length} OR to_level ILIKE $${params.length} OR department ILIKE $${params.length})`;
    }
    // Company-wide rungs first within a department grouping, so the list
    // reads the way the matching rule works.
    const r = await db.query(
      `SELECT * FROM people.career_transitions WHERE ${where}
        ORDER BY coalesce(btrim(department),'') , from_role, from_level NULLS FIRST, to_role`, params);
    // What a suggested draft WOULD be built from, right now. Asked for
    // on 25 Sep: "if we update employee list in PMS, then suggested
    // matrix should also be updated as per new designations." It always
    // was — the draft is generated per download and nothing is stored —
    // but the page said so nowhere, so there was no way to tell. These
    // three numbers are that guarantee, on screen.
    const master = (await db.query(
      `SELECT count(*)::int AS employees,
              count(DISTINCT btrim(department)) FILTER (WHERE coalesce(btrim(department),'') <> '')::int AS departments,
              count(DISTINCT btrim(designation)) FILTER (WHERE coalesce(btrim(designation),'') <> '')::int AS designations
         FROM core.employees WHERE tenant_id=$1 AND status='active'`, [T(req)])).rows[0];
    // Grade only on the way out: rows written before 13 Oct may say
    // "E3 · Band 6", and the band stays on the Grade and Level sheet.
    res.json({ transitions: r.rows.map(levelsAsGrades), master });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/career/transitions', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    if (!b.from_role || !b.to_role) return res.status(400).json({ error: 'from_role and to_role are required' });
    const competencies = Array.isArray(b.required_competencies) ? b.required_competencies
      : (typeof b.required_competencies === 'string' ? b.required_competencies.split('\n').map((s) => s.trim()).filter(Boolean) : []);
    const r = await db.query(
      `INSERT INTO people.career_transitions
         (tenant_id, department, from_role, from_level, to_role, to_level, expected_level_change, min_time_months, typical_time_months, required_competencies, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [T(req), (b.department || '').trim() || null, b.from_role, gradeOnly(b.from_level) || null, b.to_role, gradeOnly(b.to_level) || null,
       b.expected_level_change ?? null, b.min_time_months ?? null, b.typical_time_months ?? null, competencies, b.notes || null]);
    res.json({ ok: true, transition: levelsAsGrades(r.rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Only the fields the request sends are changed. Until 13 Oct every field
// left out was written as NULL, so Deactivate / Reactivate (which sends
// only `active`) turned a department's rung company-wide and wiped its
// levels, times and notes.
router.put('/career/transitions/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const sets = [];
    const params = [req.params.id, T(req)];
    const set = (col, v) => { params.push(v); sets.push(`${col}=$${params.length}`); };
    if (b.from_role) set('from_role', b.from_role);
    if (b.to_role) set('to_role', b.to_role);
    if (has('from_level')) set('from_level', gradeOnly(b.from_level) || null);
    if (has('to_level')) set('to_level', gradeOnly(b.to_level) || null);
    for (const k of ['expected_level_change', 'min_time_months', 'typical_time_months']) {
      if (has(k)) set(k, b[k] === '' ? null : b[k]);
    }
    if (has('required_competencies')) {
      set('required_competencies', Array.isArray(b.required_competencies) ? b.required_competencies
        : String(b.required_competencies || '').split('\n').map((s) => s.trim()).filter(Boolean));
    }
    if (has('notes')) set('notes', b.notes || null);
    if (has('active') && b.active != null) set('active', !!b.active);
    if (has('department')) set('department', (b.department || '').trim() || null);
    const r = await db.query(
      `UPDATE people.career_transitions SET ${[...sets, 'updated_at=now()'].join(', ')}
        WHERE id=$1 AND tenant_id=$2 RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'transition not found' });
    res.json({ ok: true, transition: levelsAsGrades(r.rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/career/transitions/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const r = await db.query(`DELETE FROM people.career_transitions WHERE id=$1 AND tenant_id=$2 RETURNING id`, [req.params.id, T(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'transition not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk delete. Asked for on 25 Sep: "there is not delete option for
// deleting multiple files" — the page had a bin on every row and no way
// to clear a draft you did not want, which after publishing a
// 200-row suggested matrix is 200 clicks.
//
// TWO MODES, one route, and the difference is which gate you pass:
//
//   { ids: [...] }         delete exactly these. The page sends what is
//                          ticked, so it cannot delete more than the
//                          user can see.
//   { confirm_count: N }   delete EVERYTHING, and N must equal what is
//                          there. The page fills it from what it just
//                          displayed, so if somebody else published a
//                          transition in the meantime the numbers
//                          disagree and this refuses — the same gate
//                          the KRA library's Clear uses, for the same
//                          reason.
//
// Nothing else reads people.career_transitions by id, so there is no
// cascade to worry about: a transition is reference data, and deleting
// one cannot orphan an employee's record.
router.delete('/career/transitions', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const body = req.body || {};
    const have = (await db.query(
      `SELECT count(*)::int AS n FROM people.career_transitions WHERE tenant_id=$1`, [T(req)])).rows[0].n;

    if (Array.isArray(body.ids)) {
      if (!body.ids.length) return res.status(422).json({ error: 'No transitions were selected.' });
      const r = await db.query(
        `DELETE FROM people.career_transitions WHERE tenant_id=$1 AND id = ANY($2::uuid[]) RETURNING id`,
        [T(req), body.ids]);
      await audit(req, 'CAREER_TRANSITIONS_DELETED', { removed: r.rowCount, asked: body.ids.length });
      logger.warn('career transitions deleted', { tenant: T(req), removed: r.rowCount, by: req.user.email });
      return res.json({ ok: true, removed: r.rowCount, asked: body.ids.length });
    }

    if (body.confirm_count == null) {
      return res.status(422).json({
        error: 'Send ids to delete a selection, or confirm_count to clear the whole matrix', have,
      });
    }
    if (!have) return res.status(409).json({ error: 'The matrix is already empty' });
    if (Number(body.confirm_count) !== have) {
      return res.status(409).json({
        error: `The matrix holds ${have} transitions, not ${body.confirm_count} — it changed since the page loaded. Reload and try again.`,
        have,
      });
    }
    const r = await db.query(`DELETE FROM people.career_transitions WHERE tenant_id=$1`, [T(req)]);
    await audit(req, 'CAREER_MATRIX_EMPTIED', { removed: r.rowCount });
    logger.warn('career matrix emptied', { tenant: T(req), removed: r.rowCount, by: req.user.email });
    res.json({ ok: true, removed: r.rowCount, cleared: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Career Pathing Matrix: bulk upload ------------------------------
//
// Asked for on 17 Sep: "can we have template upload option so HR can
// upload template for next defined roles." One transition at a time
// through the modal is an afternoon of clicking for a company with 90
// job titles, and gives nobody a way to review the whole ladder before
// committing it.
//
// Deliberately the same three controls, in the same order, as the KRA
// Library screen: Download template, Validate, Publish. HR has learnt
// that shape once; a second importer that behaves differently is a
// second thing to learn and a new set of mistakes.

const TRANSITION_BANNER = 'One row per transition. From Role and To Role are required and should match designations on the employee master exactly — a role nobody holds yet is allowed (that is what a career path is for) and only warned about. Leave Department blank for a rung that applies to EVERY department; fill it in and the rung applies only to that department, and a department-specific rung wins over a blank one for the same move. From Level and To Level are the GRADE on your Grade and Level sheet (e.g. E3), for reference — the band stays on that sheet, and a move applies to everyone in its From Role (and Department), whatever their grade or band. Required Competencies: one per line, or separated by ; — Months fields are advisory and not enforced. Re-uploading a transition that already exists UPDATES it rather than adding a second copy — Department is part of what makes a transition "the same one". Delete the sample rows before uploading.';
const TRANSITION_HEADERS = CT_COLUMNS.map(([, label]) => label);
// Three samples now, not two: the third shows the SAME move as the first
// with a department filled in, which is the one rule about this sheet
// that cannot be explained by a column heading alone.
const TRANSITION_SAMPLE = [
  ['', 'Executive', '', 'Senior Executive', '', 1, 12, 18, 'Owns a workstream end to end\nCoaches one junior', 'Blank Department = every department. Delete this sample row'],
  ['', 'Senior Executive', '', 'Team Lead', '', 1, 18, 24, 'Runs a small team\nAccountable for a delivery plan', 'Delete this sample row'],
  ['Sales', 'Executive', '', 'Senior Executive', '', 1, 9, 12, 'Carries a quota\nRuns a pipeline review', 'Same move, Sales only — this one wins for Sales. Delete this sample row'],
];

// No :id route competes for these paths — /career/transitions/:id exists
// only for PUT and DELETE — so the literal filenames are safe here. Worth
// stating, because the KRA Library's equivalents DO have to be declared
// before a GET :designation route and the reason is easy to mis-copy.
// One writer for both downloads. The suggested matrix has to come out
// of the SAME sheet as the blank template — same banner, same headers,
// same column widths — because it goes straight back through the same
// importer, and a second layout would be a second thing to get wrong.
async function transitionsWorkbook(banner, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Career Transitions');
  ws.addRow([banner]);
  ws.mergeCells(1, 1, 1, TRANSITION_HEADERS.length);
  ws.getRow(1).font = { italic: true };
  const header = ws.addRow(TRANSITION_HEADERS);
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: 'middle' };
  for (const row of rows) ws.addRow(row);
  ws.columns.forEach((col, i) => { col.width = [22, 26, 16, 26, 16, 16, 18, 20, 44, 44][i] || 20; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

router.get('/career/transitions/template.xlsx', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const buf = await transitionsWorkbook(TRANSITION_BANNER, TRANSITION_SAMPLE);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="career_transitions_template.xlsx"');
    res.send(buf);
  } catch (e) { logger.error('career transitions template xlsx', { error: e.message }); res.status(500).json({ error: 'Could not build the template file' }); }
});

// ---- The suggested matrix ------------------------------------------------
//
// Asked for on 24 Sep: "please find template of career pathing matrix
// and fill the same as per department and designation, also create
// downloadable excel sheet for upload."
//
// Not a fixture: it reads the designations on the employee master right
// now and proposes the ladder those imply, so it stays true as the
// master changes. It writes NOTHING — the output is the importer's own
// sheet, which HR edits and uploads through Validate/Publish like any
// other. See career-ladder.js for the three rules it uses.
const SUGGESTED_BANNER = 'SUGGESTED career pathing matrix. Every rung is read from your own GRADE AND LEVEL sheet — the Level columns carry the grade (E3) — the band stays on that sheet — and the To Role is the role that sheet names at the next grade, in the job family the department belongs to. EVERY ROW IS ONE GRADE UP, never a jump, so Expected Level Change is always 1, and the times come from the sheet\'s own experience bands. It is built from the employee master RIGHT NOW — re-download it after you change the employee list and it changes with it. It is a DRAFT: read it, edit it, delete what does not apply, then upload it through Validate and Publish on this same page. Rows marked PLEASE CHECK are designations that are NOT ON THE GRADE SHEET AT ALL — they have no grade and no next rung, and the file will not upload until you either give them one here or add them to the grade sheet. The importer treats a BLANK Department as "every department", so you can blank a cell by hand to make one rung company-wide. Nothing is saved until you publish.';

// The grade ladder (migration 060), read as one object the pure
// generator can work from. Four small tables; the whole thing is about
// 120 rows, so it is fetched whole rather than joined per designation.
async function gradeLadder(tenantId) {
  const q = (sql) => db.query(sql, [tenantId]).then((r) => r.rows);
  const [rungs, roles, desigs, depts] = await Promise.all([
    q(`SELECT grade, grade_label, band, sort_order, exp_range, generic_role
         FROM pms.grade_ladder WHERE tenant_id=$1 ORDER BY sort_order`),
    q(`SELECT grade, family, role_name FROM pms.grade_roles WHERE tenant_id=$1`),
    q(`SELECT lower_designation, grade, family FROM pms.designation_grade WHERE tenant_id=$1`),
    q(`SELECT lower_department, family FROM pms.department_family WHERE tenant_id=$1`),
  ]);
  return {
    rungs,
    roles: new Map(roles.map((r) => [`${r.grade}|${r.family}`, r.role_name])),
    gradeOf: new Map(desigs.map((d) => [d.lower_designation, { grade: d.grade, family: d.family }])),
    familyOf: new Map(depts.map((d) => [d.lower_department, d.family])),
  };
}

async function suggestedTransitionRows(tenantId) {
  const grid = (await db.query(
    `SELECT coalesce(department,'') AS department, designation, count(*)::int AS headcount
       FROM core.employees
      WHERE tenant_id=$1 AND status='active' AND designation IS NOT NULL AND btrim(designation) <> ''
      GROUP BY 1,2`, [tenantId])).rows;
  // The published ladder if this tenant has one, the inferred one if
  // not. A tenant whose grade tables were never seeded must still get a
  // usable draft rather than a sheet of PLEASE CHECK.
  const ladder = await gradeLadder(tenantId);
  const suggest = ladder.rungs.length ? (g) => suggestFromGrades(g, ladder) : suggestTransitions;
  return suggest(grid).map((t) => [
    t.department, t.from_role, t.from_level, t.to_role, t.to_level,
    t.expected_level_change, t.min_time_months, t.typical_time_months,
    (t.required_competencies || []).join('\n'), t.notes,
  ]);
}

router.get('/career/transitions/suggested.xlsx', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const rows = await suggestedTransitionRows(T(req));
    const buf = await transitionsWorkbook(SUGGESTED_BANNER, rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="career_matrix_suggested_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (e) { logger.error('career transitions suggested xlsx', { error: e.message }); res.status(500).json({ error: 'Could not build the suggested matrix' }); }
});

router.get('/career/transitions/suggested.csv', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const rows = await suggestedTransitionRows(T(req));
    const cell = (v) => {
      const t = String(v == null ? '' : v).replace(/\s*\n\s*/g, '; ');
      return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    // BOM, so Excel reads the en-dashes in titles like "Sr Manager –
    // Implementation" as UTF-8 rather than mojibake.
    const csv = '\ufeff' + [TRANSITION_HEADERS, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="career_matrix_suggested_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { logger.error('career transitions suggested csv', { error: e.message }); res.status(500).json({ error: 'Could not build the suggested matrix' }); }
});

router.get('/career/transitions/template.csv', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    // Newlines inside a cell are flattened to "; " for CSV — a literal
    // newline would break the row, and ; is one of the separators the
    // parser accepts back.
    const cell = (v) => {
      const t = String(v).replace(/\s*\n\s*/g, '; ');
      return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = [TRANSITION_HEADERS, ...TRANSITION_SAMPLE].map((r) => r.map(cell).join(',')).join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="career_transitions_template.csv"');
    res.send(csv);
  } catch (e) { logger.error('career transitions template csv', { error: e.message }); res.status(500).json({ error: 'Could not build the template file' }); }
});

// Dry run by default, ?commit=1 to publish — the same two-step contract
// as every other importer here, so Validate can never write.
router.post('/career/transitions/upload', (req, res, next) => transitionUpload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
}), async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });

    const format = detectFormat(req.file);
    if (format === 'xls-legacy') {
      return res.status(400).json({ error: 'Legacy .xls files are not supported — please re-save the file as .xlsx (File > Save As > Excel Workbook) and upload again.' });
    }
    // Every worksheet is read and concatenated, so a workbook split by
    // department or job family publishes in one go — the same courtesy
    // the KRA Library importer extends.
    const rows = format === 'xlsx'
      ? (await parseExcelSheets(req.file.buffer)).flatMap((sh) => sh.rows || [])
      : parseCsv(req.file.buffer.toString('utf8'));

    const known = new Set((await db.query(
      `SELECT DISTINCT lower(btrim(designation)) AS d FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND coalesce(btrim(designation),'') <> ''`,
      [T(req)])).rows.map((r) => r.d));

    // Departments actually on the employee master, so a typo in the new
    // column is reported rather than silently producing a rung that can
    // never match anyone.
    const knownDepts = new Set((await db.query(
      `SELECT DISTINCT lower(btrim(department)) AS d FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND coalesce(btrim(department),'') <> ''`,
      [T(req)])).rows.map((r) => r.d));

    const report = validateCareerTransitionRows(rows, known, knownDepts);
    if (report.fatal) return res.status(422).json({ error: report.fatal });

    // Which of these already exist, so the dry run can say "12 new, 4
    // updated" rather than leaving HR to guess whether Publish will
    // duplicate the matrix they already built.
    const existing = new Map((await db.query(
      `SELECT id, department, from_role, from_level, to_role, to_level FROM people.career_transitions WHERE tenant_id=$1`,
      [T(req)])).rows.map((r) => [ctRowKey(r), r.id]));
    for (const r of report.rows) r.existing_id = existing.get(ctRowKey(r)) || null;
    const willUpdate = report.rows.filter((r) => r.existing_id).length;
    report.summary.create = report.rows.length - willUpdate;
    report.summary.update = willUpdate;

    const commit = req.query.commit === '1' || req.query.commit === 'true';
    if (!commit || !report.ok) {
      // A dry run, or a file with errors. Nothing is written either way —
      // a partial publish of a file HR has not seen the verdict on is the
      // thing this two-step exists to prevent.
      return res.json({ ok: report.ok, committed: false, ...report });
    }

    let created = 0; let updated = 0;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const r of report.rows) {
        if (r.existing_id) {
          await client.query(
            `UPDATE people.career_transitions SET
               expected_level_change=$3, min_time_months=$4, typical_time_months=$5,
               required_competencies=$6, notes=$7, active=true, updated_at=now(),
               from_level=$8, to_level=$9
             WHERE id=$1 AND tenant_id=$2`,
            [r.existing_id, T(req), r.expected_level_change, r.min_time_months,
             r.typical_time_months, r.required_competencies, r.notes,
             // Rewritten as the grade alone, so a re-upload clears old
             // band text from the row it updates (13 Oct).
             r.from_level, r.to_level]);
          // department is NOT in the SET list on purpose: it is part of
          // the key that found this row, so it already matches.
          updated += 1;
        } else {
          await client.query(
            `INSERT INTO people.career_transitions
               (tenant_id, department, from_role, from_level, to_role, to_level, expected_level_change,
                min_time_months, typical_time_months, required_competencies, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [T(req), r.department, r.from_role, r.from_level, r.to_role, r.to_level, r.expected_level_change,
             r.min_time_months, r.typical_time_months, r.required_competencies, r.notes]);
          created += 1;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    // A career matrix decides which moves the product will accept, so
    // changing it in bulk is a configuration change worth a queryable
    // record of who did it and how much moved.
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
       VALUES ($1,$2,'CAREER_TRANSITIONS_UPLOADED','career_transitions',$3)`,
      [T(req), req.user.email, JSON.stringify({ created, updated, warnings: report.warnings.length })]);

    res.json({ ok: true, committed: true, created, updated,
      warnings: report.warnings, summary: { ...report.summary, create: created, update: updated } });
  } catch (e) { logger.error('career transitions upload', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Employee-facing career path (BR-3.1/3.2) — FOUND MISSING alongside
// Development Plan, 28-Aug-2026: only the HR-configured matrix above and
// the raw people.career_paths table (migration 004) existed; no route let
// an employee actually set or view their own path. "Guardrails" (BR-3.2)
// are enforced softly: if HR has configured any career_matrix role_bands,
// a target_role must match one of them; if the matrix is still empty,
// nothing is blocked (an unconfigured guardrail can't guard anything yet).
// Looks up valid transitions FROM the employee's own current role — used
// by both GET (to list eligible target roles) and PUT (to validate one).
// "Current role" is core.employees.designation, the same field the
// transition matrix's From/To Role dropdowns are sourced from. If the
// employee's designation has no active transitions defined FROM it at
// all, the guardrail is treated as unconfigured for them and nothing is
// blocked — same permissive-when-unconfigured philosophy the old
// Career Framework check used, just evaluated per employee now instead
// of against one flat org-wide list.
// Matching is case- and whitespace-insensitive, and an EMPTY from_level
// counts as "any level" exactly like NULL does.
//
// It used to compare both fields raw and exact. from_role survived that
// because the matrix form picks it from a dropdown of real designations,
// but from_level is a free-text box — so "L3 " or "l3" against a role_band
// of "L3" silently matched nothing, with no way to see why. NULLIF on the
// trimmed value is what folds '' into the any-level case; a row saved with
// an empty string rather than NULL was previously a transition that could
// never match anyone.
//
// A level-specific transition still does NOT match an employee with no
// role_band — that is a real mismatch, not a formatting one. It is now
// REPORTED rather than silently dropped: see careerPathDiagnostics.
// $4 is the employee's DEPARTMENT (migration 044). A rung with no
// department is company-wide and applies to everyone — which is what
// every row written before 044 is, so an existing matrix keeps working
// untouched. A rung WITH a department applies only there.
//
// LEVEL PLAYS NO PART (13 Oct). A move applies to everyone in its From
// Role (and Department); the level on a row is the grade, for reference.
// Band is off the matrix entirely and stays on the Grade and Level sheet.
// See career-level.js.
const TRANSITION_MATCH = `
  LOWER(TRIM(from_role)) = LOWER(TRIM($2))
  AND (NULLIF(TRIM(COALESCE(department, '')), '') IS NULL
       OR LOWER(TRIM(department)) = LOWER(TRIM(COALESCE($3, ''))))`;

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();

async function eligibleTransitionsFor(tenantId, employeeId) {
  const emp = (await db.query(`SELECT designation, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp || !emp.designation) return [];
  return transitionsFrom(tenantId, emp.designation, emp.department);
}

// The moves open from one role in one department — the employee's own
// rung, or (for the long-term ladder below) a rung they would reach first.
async function transitionsFrom(tenantId, role, department) {
  const rows = (await db.query(
    `SELECT * FROM people.career_transitions WHERE tenant_id=$1 AND active=true AND ${TRANSITION_MATCH}`,
    [tenantId, role, department || null])).rows
    // A row that only changed band ("Executive, Band 6 → Executive, Band 7")
    // is, with band gone, a move to the role they already hold.
    .filter((t) => lc(t.to_role) !== lc(role))
    .map(levelsAsGrades);
  // ONE ROW PER TARGET ROLE. The same move written several times — once
  // per department in the suggested matrix, or once per band before 13
  // Oct — is one step for this employee. MOST SPECIFIC WINS: their own
  // department's row over a company-wide one (its competencies and
  // time-in-role are why the column exists), then the latest edited.
  const rank = (t) => [lc(t.department) ? 0 : 1, -new Date(t.updated_at || t.created_at || 0).getTime()];
  const better = (a, b) => { const x = rank(a); const y = rank(b); return x[0] - y[0] || x[1] - y[1]; };
  const best = new Map();
  for (const t of rows) {
    const k = lc(t.to_role);
    const cur = best.get(k);
    if (!cur || better(t, cur) < 0) best.set(k, t);
  }
  return [...best.values()].sort((a, b) => lc(a.to_role).localeCompare(lc(b.to_role)));
}

// ONE GRADE UP, FROM THE GRADE AND LEVEL SHEET (8 Oct: long term "should
// take data saved from short term goal and update 1 level upper
// designation and role"). Used by the Long-Term walk only, and only where
// the Career Pathing Matrix has no step from a role: the sheet names the
// role at the next grade in the job family — the same rule the suggested
// matrix download is built on — so the next level is offered even before
// HR has written that row. Returns null at the top of the ladder, or when
// the role is not on the sheet.
async function gradeRungAbove(tenantId, role, department, cache) {
  const ladder = cache.ladder || (cache.ladder = await gradeLadder(tenantId));
  if (!ladder.rungs.length) return null;
  const key = lc(role);
  let mapped = ladder.gradeOf.get(key) || null;
  if (!mapped) {
    // A role nobody holds yet (a To Role) is on the sheet as a role name.
    for (const [k, name] of ladder.roles) {
      if (lc(trimPrefix(name)) === key) { const [grade, family] = k.split('|'); mapped = { grade, family }; break; }
    }
  }
  if (!mapped) {
    const g = ladder.rungs.find((r) => lc(r.generic_role) === key);
    if (g) mapped = { grade: g.grade, family: null };
  }
  if (!mapped) return null;
  const order = [...ladder.rungs].sort((a, b) => a.sort_order - b.sort_order);
  const i = order.findIndex((g) => g.grade === mapped.grade);
  const from = order[i];
  const to = i >= 0 ? order[i + 1] : null;
  if (!from || !to) return null;
  const family = mapped.family || ladder.familyOf.get(lc(department)) || null;
  const toRole = roleAt(ladder, to, family);
  if (!toRole || lc(toRole) === key) return null;
  const [min, typical] = timeInRung(from, to);
  return { to_role: toRole, to_level: levelLabel(to), min_time_months: min, typical_time_months: typical,
    required_competencies: competenciesFor(RANK_FOR_GRADE[to.grade] || 8), source: 'grade_sheet' };
}

// IS A TARGET ROLE IN ANOTHER DEPARTMENT? (8 Oct: "check if it is a cross
// departmental transition"). Answered from the organisation's own data,
// never guessed: where that role is held today on the employee master,
// and where the Career Pathing Matrix files it. If it lives only in other
// departments, the move crosses departments; if nowhere, it is unknown.
async function targetDepartments(tenantId, employeeId, role) {
  const emp = (await db.query(`SELECT department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0] || {};
  const r = String(role || '').trim();
  if (!r) return null;
  const held = (await db.query(
    `SELECT DISTINCT department FROM core.employees
      WHERE tenant_id=$1 AND status='active' AND LOWER(BTRIM(designation))=LOWER($2) AND COALESCE(BTRIM(department),'')<>''`,
    [tenantId, r])).rows.map((x) => x.department);
  const filed = (await db.query(
    `SELECT DISTINCT department FROM people.career_transitions
      WHERE tenant_id=$1 AND active=true AND LOWER(BTRIM(to_role))=LOWER($2) AND COALESCE(BTRIM(department),'')<>''`,
    [tenantId, r])).rows.map((x) => x.department);
  const where = [...new Set([...held, ...filed])].sort();
  const mine = lc(emp.department);
  const known = where.length > 0;
  const inMine = where.some((d) => lc(d) === mine);
  return {
    current_department: emp.department || null,
    target_departments: where,
    cross_department: known && !inMine ? true : known ? false : null,
  };
}

// THE LONG-TERM LADDER (8 Oct). The matrix holds one rung per row, which
// is right for Short-Term — one to two years — and wrong for Long-Term,
// "three years and beyond", which is usually two or three rungs up. So
// Long-Term walks the matrix: from the employee's role and level, each
// move's To Role and To Level become the next rung's From. Every step is
// still a row HR wrote; nothing is invented. Times add up; competencies
// are the union, in order.
// `start` (optional) begins the walk from a rung other than the employee's
// own — the saved short-term goal, for Long-Term — carrying that first
// move's time and competencies; it is never itself offered.
async function careerLadderFor(tenantId, employeeId, maxSteps = 3, start = null) {
  const emp = (await db.query(`SELECT designation, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp || !emp.designation) return [];
  const out = new Map();
  let frontier = [start || { role: emp.designation, via: [], months: 0, comps: [] }];
  const seen = new Set([lc(emp.designation), ...(start ? [lc(start.role)] : [])]);
  const first = start ? start.via.length + 1 : 1;
  const cache = {};
  for (let step = first; step <= maxSteps && frontier.length; step += 1) {
    const next = [];
    for (const f of frontier) {
      let moves = await transitionsFrom(tenantId, f.role, emp.department);
      // No row in the matrix from here: one grade up on the Grade and
      // Level sheet instead (gradeRungAbove).
      if (!moves.length) {
        const g = await gradeRungAbove(tenantId, f.role, emp.department, cache);
        if (g) moves = [g];
      }
      for (const t of moves) {
        const k = lc(t.to_role);
        if (seen.has(k)) continue;
        seen.add(k);
        const months = t.typical_time_months == null || f.months == null ? null : f.months + Number(t.typical_time_months);
        const comps = [...new Set([...f.comps, ...(t.required_competencies || [])])];
        const rung = { to_role: t.to_role, to_level: t.to_level, steps: step, via: f.via,
          typical_time_months: months, required_competencies: comps, source: t.source || 'matrix' };
        out.set(k, rung);
        next.push({ role: t.to_role, via: [...f.via, t.to_role], months, comps });
      }
    }
    frontier = next;
  }
  return [...out.values()];
}

// The roles a horizon may aim at. The form's dropdown, its validation and
// the AI all read this.
//
// Short-Term: one rung from the employee's role and level.
// Long-Term: the steps AFTER the saved short-term goal (8 Oct: "long term
// should derive next goal pathing of saved short term details and not
// same as short term details"). When the employee has saved a short-term
// role the matrix offers, the walk starts from that role and its level —
// its own time counted in, so a long-term timeline runs from now — and
// that role is never offered again. With no short-term goal (or one the
// matrix no longer offers) it walks from the employee's own role.
async function shortTermAnchor(tenantId, employeeId) {
  const st = (await db.query(
    `SELECT target_role FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2 AND horizon='short_term'`,
    [tenantId, employeeId])).rows[0];
  if (!st || !st.target_role) return null;
  const move = (await eligibleTransitionsFor(tenantId, employeeId)).find((t) => lc(t.to_role) === lc(st.target_role));
  return move || null;
}

async function targetsFor(tenantId, employeeId, horizon) {
  if (horizon !== 'long_term') return eligibleTransitionsFor(tenantId, employeeId);
  const anchor = await shortTermAnchor(tenantId, employeeId);
  if (!anchor) return careerLadderFor(tenantId, employeeId, 3);
  return (await careerLadderFor(tenantId, employeeId, 3, {
    role: anchor.to_role, via: [anchor.to_role],
    months: anchor.typical_time_months == null ? null : Number(anchor.typical_time_months),
    comps: anchor.required_competencies || [],
  })).map((r) => ({ ...r, after_short_term: anchor.to_role }));
}

// Why an employee has no eligible transitions.
//
// "No career path is configured from your current role" was being shown
// whenever the match returned nothing — including when a path WAS
// configured and had merely been excluded on level. That sent HR looking
// for a missing row that already existed. An empty result has several
// distinct causes and they need distinct answers.
async function careerPathDiagnostics(tenantId, employeeId) {
  const emp = (await db.query(
    `SELECT designation, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp) return { reason: 'no_employee' };
  if (!emp.designation) {
    return { reason: 'no_designation', designation: null, matched: 0 };
  }
  const base = { designation: emp.designation, department: emp.department || null };

  // Everything configured FROM this role, ignoring level and active, so we
  // can tell "nothing exists" from "something exists but was filtered".
  const all = (await db.query(
    `SELECT to_role, from_level, department, active FROM people.career_transitions
      WHERE tenant_id=$1 AND LOWER(TRIM(from_role)) = LOWER(TRIM($2))`,
    [tenantId, emp.designation])).rows;

  const matched = await eligibleTransitionsFor(tenantId, employeeId);
  if (matched.length) return { ...base, reason: 'ok', matched: matched.length };

  if (!all.length) return { ...base, reason: 'none_configured', matched: 0 };

  const active = all.filter((t) => t.active);
  if (!active.length) return { ...base, reason: 'all_inactive', matched: 0, inactive: all.length };

  // Configured, active, and excluded because every rung belongs to a
  // DIFFERENT department. Before 044 this could not happen; now it can,
  // and "no career path is configured from your role" would send HR
  // hunting for a row that exists and is simply filed elsewhere.
  const mine = (d) => !String(d || '').trim()
    || String(d).trim().toLowerCase() === String(emp.department || '').trim().toLowerCase();
  if (!active.some((t) => mine(t.department))) {
    return { ...base, reason: 'department_mismatch', matched: 0,
      excluded_by_department: [...new Set(active.map((t) => t.department).filter(Boolean))] };
  }

  // Configured, active and in their department, yet nothing offered: every
  // such row leads back to the role they hold — a move that only changed
  // band before 13 Oct. As far as a career path goes, there is none.
  return { ...base, reason: 'none_configured', matched: 0 };
}

// Two horizons, not one. Asked for: Aspiring Career "structured into
// distinct Short-Term and Long-Term view tabs". `?horizon=` picks which
// one is being read or written; leaving it off means short-term, which is
// what every reader written before this meant.
const HORIZONS = ['short_term', 'long_term'];
const horizonOf = (v) => (HORIZONS.includes(String(v || '')) ? String(v) : 'short_term');

router.get('/career/my-path', async (req, res) => {
  try {
    const horizon = horizonOf(req.query.horizon);
    const rows = (await db.query(
      // BOTH horizons, deliberately — this is the one reader that is
      // about the split. A blanket pass qualifying every pre-split reader
      // to short_term caught this query too and pinned the tab strip to
      // one answer; the test is what noticed.
      `SELECT id, horizon, target_role, target_timeline, plan, years_experience, skills_interests, updated_at
         FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id])).rows;
    const p = rows.find((r) => r.horizon === horizon) || null;
    // Both are returned alongside, so the tab strip can say which horizon
    // already has an answer without a second round trip — the difference
    // between a tab that looks empty and one that IS empty.
    const filled = rows.filter((r) => r.target_role).map((r) => r.horizon);
    // The employee's CURRENT role, straight off the master. Asked for on
    // 23 Sep: the form asked where you want to go without ever saying
    // where you are, so "is this a step up?" was unanswerable on screen.
    // Read here rather than typed, because a designation somebody types
    // is a designation that stops matching the matrix.
    const me = (await db.query(
      `SELECT designation, department, date_of_joining, total_experience_years
         FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.user.id, T(req)])).rows[0] || {};
    const milestones = await milestonesFor(p ? p.id : null);
    const transitions = await targetsFor(T(req), req.user.id, horizon);
    const eligibleTargetRoles = [...new Set(transitions.map((t) => t.to_role))].sort();
    const phase = await activeCyclePhase(T(req));
    // path_diagnostics explains an EMPTY eligible list. Without it the UI
    // could only say "nothing configured", which is wrong whenever a
    // transition exists but was excluded on level.
    let diagnostics = eligibleTargetRoles.length ? null : await careerPathDiagnostics(T(req), req.user.id);
    // Long-Term with a saved short-term goal and nothing configured after
    // it: say exactly that, not "no path from your role" — there is one,
    // and it is the short-term goal.
    if (!eligibleTargetRoles.length && horizon === 'long_term') {
      const anchor = await shortTermAnchor(T(req), req.user.id);
      if (anchor) diagnostics = { reason: 'none_beyond_short_term', designation: me.designation || null, short_term_role: anchor.to_role };
    }
    // The employee's total experience, for what is LEFT of each move's
    // time (career-timeline.js, 13 Oct): the HRMS figure, else what they
    // entered on their Long-Term tab.
    const selfYears = (rows.find((r) => r.horizon === 'long_term' && r.years_experience != null)
      || rows.find((r) => r.years_experience != null) || {}).years_experience;
    const experience = experienceFrom(me.total_experience_years, selfYears);
    const left = (t) => remainingTimeline(t && t.typical_time_months, t && t.min_time_months, experience);
    // Short-Term's timeline IS what is left of the matrix's figure for the
    // chosen move — shown as such even where an older version stored the
    // whole figure, or something typed.
    if (p && horizon === 'short_term' && p.target_role) {
      const t = transitions.find((x) => x.to_role === p.target_role);
      if (t && t.typical_time_months != null) p.target_timeline = left(t).timeline_text;
    }
    const gw = await growthWindowFor(T(req), req.user.id, horizon);
    // The Long-Term tab shows the short-term goal it builds on, and fills
    // its blank experience and skills from it (8 Oct).
    const st = rows.find((r) => r.horizon === 'short_term');
    const anchorMove = horizon === 'long_term' && st && st.target_role ? await shortTermAnchor(T(req), req.user.id) : null;
    const shortTermGoal = horizon === 'long_term' && st && st.target_role
      ? { target_role: st.target_role,
          // What is left of the matrix's figure for that move, as the
          // Short-Term tab shows it.
          target_timeline: anchorMove && anchorMove.typical_time_months != null ? left(anchorMove).timeline_text : st.target_timeline,
          years_experience: st.years_experience, skills_interests: st.skills_interests }
      : null;
    // Each role's time from the matrix, so the form's Expected timeline
    // comes from HR's figure rather than from whatever was typed for a
    // different role (8 Oct). And a saved target that is not on this tab's
    // list — typically a long-term role saved as short-term before the
    // matrix matched — is flagged, so the screen can offer to move it.
    const targetOptions = [];
    for (const t of transitions) {
      if (!targetOptions.some((o) => o.role === t.to_role)) {
        targetOptions.push({ role: t.to_role, typical_time_months: t.typical_time_months ?? null,
          min_time_months: t.min_time_months ?? null, steps: t.steps || 1, source: t.source || 'matrix',
          ...left(t) });
      }
    }
    const staleTarget = !!(p && p.target_role && eligibleTargetRoles.length && !eligibleTargetRoles.includes(p.target_role));
    const crossDept = horizon === 'long_term' && p && p.target_role ? await targetDepartments(T(req), req.user.id, p.target_role) : null;
    res.json({ path: p || null, horizon, short_term_goal: shortTermGoal, target_departments: crossDept,
      target_options: targetOptions, stale_target: staleTarget, horizons_filled: filled, milestones, progress_pct: careerProgress(milestones),
      current: { designation: me.designation || null, department: me.department || null,
                 date_of_joining: me.date_of_joining || null },
      experience,
      eligible_target_roles: eligibleTargetRoles, cycle_phase: phase,
      editable: gw.window.ok, editable_via: gw.window.via || null,
      shut_because: gw.window.ok ? null : gw.window.reason,
      path_diagnostics: diagnostics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Where a role sits, for the Long-Term tab's cross-department badge while
// the employee is still typing it. Read-only, about the caller only.
router.get('/career/target-departments', async (req, res) => {
  try {
    const role = String(req.query.role || '').trim().slice(0, 200);
    res.json(role ? await targetDepartments(T(req), req.user.id, role) : null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/career/my-path', async (req, res) => {
  try {
    // The horizon first: the two tabs lock at different phases.
    const horizon = horizonOf(req.body && req.body.horizon);
    const gw = await growthWindowFor(T(req), req.user.id, horizon);
    if (!gw.window.ok) return res.status(409).json({ error: careerShutMessage(gw.phase, gw.window) });
    const { target_role, target_timeline, plan, years_experience, skills_interests } = req.body || {};
    if (!target_role || !String(target_role).trim()) return res.status(400).json({ error: 'target_role required' });
    // Blank is a real answer — "I have not said yet" — and must not
    // become 0.0 years, which would read as a fact nobody stated.
    let years = null;
    if (years_experience != null && String(years_experience).trim() !== '') {
      years = Number(years_experience);
      if (!Number.isFinite(years) || years < 0 || years > 60) {
        return res.status(422).json({ error: 'Total years of experience must be a number between 0 and 60.' });
      }
    }
    const transitions = await targetsFor(T(req), req.user.id, horizon);
    const eligibleTargetRoles = [...new Set(transitions.map((t) => t.to_role))];
    // A long-term goal already saved may stay while HR has not yet written
    // the steps to it (it is where the person wants to END UP, and the
    // matrix may not reach that far) — otherwise moving it to Long-Term
    // would leave a tab that can never be saved again. A NEW target must
    // still come from the matrix.
    const keptLongTerm = horizon === 'long_term' && (await db.query(
      `SELECT 1 FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2 AND horizon='long_term' AND target_role=$3`,
      [T(req), req.user.id, String(target_role).trim()])).rows.length > 0;
    // SHORT-TERM IS DERIVED FROM THE MATRIX (8 Oct: "make sure short term
    // goals is derived from career pathing"). The next move must be a
    // transition HR configured from this role and level — there is no
    // free-text short-term goal any more, including when nothing is
    // configured yet (that used to accept any role, which is how
    // "Lead - Technical, 72 months" ended up as somebody's next move).
    // Long-Term may still name a role the matrix does not reach yet when
    // nothing is configured, or keep one already saved.
    if (horizon === 'short_term' && !eligibleTargetRoles.length) {
      const why = await careerPathDiagnostics(T(req), req.user.id);
      return res.status(422).json({ error: why && why.reason === 'department_mismatch'
        ? 'Your short-term goal comes from the Career Pathing Matrix, and its paths from your role are filed under a different department — ask HR to check them.'
        : 'Your short-term goal comes from the Career Pathing Matrix, and no path is configured from your current role yet — ask HR to add one.' });
    }
    // LONG-TERM TARGET IS OPEN (8 Oct: "please keep target role open for
    // long term"). Where someone wants to end up is theirs to name; the
    // matrix and the Grade and Level sheet only SUGGEST it. Short-Term
    // stays a move from the matrix.
    void keptLongTerm;
    if (horizon === 'short_term' && eligibleTargetRoles.length && !eligibleTargetRoles.includes(target_role)) {
      return res.status(422).json({ error: `target_role must be one of the transitions configured from your current role in the Career Pathing Matrix: ${eligibleTargetRoles.join(', ')}` });
    }
    // The short-term timeline is what is left of the matrix's own figure
    // for that move, whatever was typed; typed only when HR left the
    // figure blank. Stored as the figure on the day of saving; the tab
    // shows it worked out afresh each time (13 Oct).
    let timeline = (target_timeline || '').trim() || null;
    if (horizon === 'short_term') {
      const t = transitions.find((x) => x.to_role === target_role);
      if (t && t.typical_time_months != null) {
        const me = (await db.query(`SELECT total_experience_years FROM core.employees WHERE id=$1 AND tenant_id=$2`,
          [req.user.id, T(req)])).rows[0] || {};
        const self = (await db.query(
          `SELECT years_experience FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2 AND years_experience IS NOT NULL
            ORDER BY (horizon='long_term') DESC LIMIT 1`, [T(req), req.user.id])).rows[0] || {};
        timeline = remainingTimeline(t.typical_time_months, t.min_time_months,
          experienceFrom(me.total_experience_years, req.body.years_experience ?? self.years_experience)).timeline_text;
      }
    }
    // A field the request does not send is KEPT, not cleared (8 Oct): the
    // Short-Term tab now asks only for the role and its timeline — the
    // experience, skills, growth plan and milestones live on Long-Term —
    // and saving it must not wipe what an older version stored there.
    const body = req.body || {};
    const sent = (k) => Object.prototype.hasOwnProperty.call(body, k);
    await db.query(
      `INSERT INTO people.career_paths
         (tenant_id, employee_id, horizon, target_role, target_timeline, plan, years_experience, skills_interests)
       VALUES ($1,$2,$8,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, employee_id, horizon) DO UPDATE SET
         target_role=EXCLUDED.target_role, target_timeline=EXCLUDED.target_timeline,
         plan=CASE WHEN $9 THEN EXCLUDED.plan ELSE people.career_paths.plan END,
         years_experience=CASE WHEN $10 THEN EXCLUDED.years_experience ELSE people.career_paths.years_experience END,
         skills_interests=CASE WHEN $11 THEN EXCLUDED.skills_interests ELSE people.career_paths.skills_interests END,
         updated_at=now()`,
      [T(req), req.user.id, target_role.trim(), timeline, plan || null,
       years, (skills_interests || '').trim() || null, horizon, sent('plan'), sent('years_experience'), sent('skills_interests')]);
    res.json({ ok: true, horizon });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// MOVE THE SHORT-TERM GOAL TO LONG-TERM (8 Oct). Before the matrix
// matched, Short-Term accepted any role, and employees saved where they
// want to END UP ("Lead - Technical, 72 months") as their next move. Now
// that Short-Term offers only real next moves, that answer — role,
// timeline, plan and milestones — belongs on Long-Term. One click moves
// it there and leaves Short-Term to be filled with the next move;
// experience and skills stay on both. Refused when Long-Term already has
// a goal, so nothing is overwritten.
router.post('/career/my-path/move-to-long-term', async (req, res) => {
  try {
    for (const h of HORIZONS) {
      const gw = await growthWindowFor(T(req), req.user.id, h);
      if (!gw.window.ok) return res.status(409).json({ error: careerShutMessage(gw.phase, gw.window) });
    }
    const rows = (await db.query(
      `SELECT * FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id])).rows;
    const st = rows.find((r) => r.horizon === 'short_term');
    const lt = rows.find((r) => r.horizon === 'long_term');
    if (!st || !st.target_role) return res.status(400).json({ error: 'There is no short-term goal to move.' });
    if (lt && lt.target_role) {
      return res.status(409).json({ error: `Long-Term already has a goal (${lt.target_role}) — change it there first.` });
    }
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      let ltId = lt && lt.id;
      if (ltId) {
        await client.query(
          `UPDATE people.career_paths SET target_role=$2, target_timeline=$3, plan=COALESCE(NULLIF(BTRIM(plan),''), $4),
                  years_experience=COALESCE(years_experience,$5), skills_interests=COALESCE(NULLIF(BTRIM(skills_interests),''),$6), updated_at=now()
            WHERE id=$1`, [ltId, st.target_role, st.target_timeline, st.plan, st.years_experience, st.skills_interests]);
      } else {
        ltId = (await client.query(
          `INSERT INTO people.career_paths (tenant_id, employee_id, horizon, target_role, target_timeline, plan, years_experience, skills_interests)
           VALUES ($1,$2,'long_term',$3,$4,$5,$6,$7) RETURNING id`,
          [T(req), req.user.id, st.target_role, st.target_timeline, st.plan, st.years_experience, st.skills_interests])).rows[0].id;
      }
      await client.query(`UPDATE people.career_milestones SET career_path_id=$1 WHERE career_path_id=$2`, [ltId, st.id]);
      await client.query(
        `UPDATE people.career_paths SET target_role=NULL, target_timeline=NULL, plan=NULL, updated_at=now() WHERE id=$1`, [st.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true, moved: st.target_role });
  } catch (e) { logger.error('career move to long-term', { error: e.message }); res.status(500).json({ error: 'Could not move the goal' }); }
});

// ---- Aspiring Career milestones ------------------------------------------
// What turns an aspiration into a plan: the steps towards the target role,
// each with a date and a progress figure. Same shape as a development goal
// (see migration 028 for why), and the same split of what is gated:
//
//   CONTENT is phase-gated to career_edit, like the rest of the path —
//   you set out your steps during Growth Planning.
//   PROGRESS is not, mirroring BR-2.3 for development goals. Progress
//   happens all year; a gate would mean marking a milestone done months
//   after you actually did it, which makes the number worthless.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function myCareerPathId(tenantId, employeeId, horizon = 'short_term') {
  const r = await db.query(
    `SELECT id FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2 AND horizon=$3`, [tenantId, employeeId, horizon]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function milestonesFor(pathId) {
  if (!pathId) return [];
  return (await db.query(
    `SELECT id, title, description, target_date, progress_pct, sort_order
       FROM people.career_milestones WHERE career_path_id=$1 ORDER BY sort_order, created_at`, [pathId])).rows;
}

// The single number the rest of the app asks for: how far along is this
// aspiration. Averaged across milestones, unweighted — the milestones
// carry no weights and inventing some would be making up precision.
// null, not 0, when there are no milestones: "no steps written down" and
// "steps written down, none started" are different states and 0% would
// report the first as the second.
function careerProgress(milestones) {
  if (!milestones.length) return null;
  return Math.round(milestones.reduce((sum, m) => sum + m.progress_pct, 0) / milestones.length);
}

// PUT /people/career/my-milestones — replace the list, same all-at-once
// shape as the development plan's goals editor.
router.put('/career/my-milestones', async (req, res) => {
  try {
    // Each tab's milestones belong to that tab's path — they used to be
    // written to Short-Term whichever tab they were typed on.
    const horizon = horizonOf((req.body && req.body.horizon) || req.query.horizon);
    const gw = await growthWindowFor(T(req), req.user.id, horizon);
    if (!gw.window.ok) return res.status(409).json({ error: careerShutMessage(gw.phase, gw.window) });
    const pathId = await myCareerPathId(T(req), req.user.id, horizon);
    if (!pathId) return res.status(409).json({ error: 'Set your target role first — milestones are the steps towards it' });

    const list = Array.isArray((req.body || {}).milestones) ? req.body.milestones : null;
    if (!list) return res.status(400).json({ error: 'milestones array required' });
    // Per-row errors with the row named, the same way every other importer
    // and bulk editor in this codebase reports them — one message saying
    // "something is wrong" makes the author hunt for it.
    const errors = [];
    list.forEach((m, i) => {
      const row = i + 1;
      if (!m || !String(m.title || '').trim()) errors.push({ row, error: 'title is required' });
      // A milestone with no date is a wish. The development plan learned
      // this the same way: goals without target dates never got looked at
      // again, so a date became mandatory there too.
      if (!m || !m.target_date) errors.push({ row, error: 'target date is required' });
      else if (!ISO_DATE_RE.test(String(m.target_date))) errors.push({ row, error: 'target date must be yyyy-mm-dd' });
      const p = m && m.progress_pct;
      if (p != null && (!Number.isFinite(Number(p)) || Number(p) < 0 || Number(p) > 100)) {
        errors.push({ row, error: 'progress must be a number between 0 and 100' });
      }
    });
    if (errors.length) return res.status(422).json({ error: 'Some milestones need fixing', errors });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Replaced wholesale, but progress is CARRIED OVER by title where a
      // milestone survives the edit — otherwise reordering the list or
      // fixing a typo would silently reset months of tracked progress.
      const existing = (await client.query(
        `SELECT title, progress_pct FROM people.career_milestones WHERE career_path_id=$1`, [pathId])).rows;
      const priorByTitle = new Map(existing.map((m) => [m.title.trim().toLowerCase(), m.progress_pct]));
      await client.query(`DELETE FROM people.career_milestones WHERE career_path_id=$1`, [pathId]);
      let order = 0;
      for (const m of list) {
        const title = String(m.title).trim();
        const carried = priorByTitle.get(title.toLowerCase());
        const progress = m.progress_pct != null ? Number(m.progress_pct) : (carried ?? 0);
        await client.query(
          `INSERT INTO people.career_milestones (tenant_id, career_path_id, title, description, target_date, progress_pct, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [T(req), pathId, title, (m.description || '').trim() || null, m.target_date, progress, (order += 10)]);
      }
      await client.query(`UPDATE people.career_paths SET updated_at=now() WHERE id=$1`, [pathId]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    const milestones = await milestonesFor(pathId);
    res.json({ ok: true, milestones, progress_pct: careerProgress(milestones) });
  } catch (e) { logger.error('career milestones save', { error: e.message }); res.status(500).json({ error: 'Could not save your milestones' }); }
});

// PUT /people/career/my-milestones/:id/progress — NOT phase-gated, see above.
router.put('/career/my-milestones/:id/progress', async (req, res) => {
  try {
    const progress = Number((req.body || {}).progress_pct);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      return res.status(400).json({ error: 'progress_pct must be a number between 0 and 100' });
    }
    // Scoped through the owning path, so one employee cannot move another's
    // milestone by guessing an id.
    const r = await db.query(
      `UPDATE people.career_milestones m SET progress_pct=$1, updated_at=now()
         FROM people.career_paths p
        WHERE m.id=$2 AND m.career_path_id=p.id AND p.tenant_id=$3 AND p.employee_id=$4
        RETURNING m.id, m.career_path_id`,
      [Math.round(progress), req.params.id, T(req), req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'milestone not found' });
    const milestones = await milestonesFor(r.rows[0].career_path_id);
    res.json({ ok: true, progress_pct: careerProgress(milestones), milestones });
  } catch (e) { logger.error('career milestone progress', { error: e.message }); res.status(500).json({ error: 'Could not update progress' }); }
});

// Manager view of their reports' career paths — general awareness, no
// approval step (BR-3.1 says employees define their own aspiration; there
// is no "manager approves career path" requirement in the BRD, unlike KRAs
// and Development Plans).
router.get('/career/team', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, cp.target_role, cp.target_timeline, cp.plan, cp.updated_at,
              COUNT(m.id)::int                                        AS milestone_count,
              COUNT(m.id) FILTER (WHERE m.progress_pct >= 100)::int   AS milestones_done,
              -- ROUND to match careerProgress() exactly; AVG over no rows
              -- is NULL, which is the "no milestones written down" state
              -- rather than 0%.
              ROUND(AVG(m.progress_pct))::int                         AS progress_pct
         FROM core.employees e
         LEFT JOIN people.career_paths cp ON cp.tenant_id=e.tenant_id AND cp.employee_id=e.id AND cp.horizon='short_term'
         LEFT JOIN people.career_milestones m ON m.career_path_id=cp.id
        WHERE e.tenant_id=$1 AND e.manager_id=$2 AND e.status='active'
        GROUP BY e.id, e.name, cp.target_role, cp.target_timeline, cp.plan, cp.updated_at
        ORDER BY e.name`, [T(req), req.user.id]);
    res.json({ team: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// eligibleTransitionsFor is part of this module's EXPORTED INTERFACE, not
// an internal: the agentic module needs the same set of HR-configured
// transitions to ground its career suggestions in, and the house rule is
// that modules never reach into each other's internals. Exporting it here
// is what keeps that read explicit — and it guarantees the AI can only
// suggest roles the career-path form will actually accept, since both
// sides now resolve eligibility through this one function.
// One employee's own Aspiring Career row, for other modules to read.
//
// Exported rather than left to a cross-schema SELECT elsewhere: the house
// rule is that a module reaches another module through its interface, not
// into its tables. The agentic module needs this to fold career progress
// into a review assist, and going through here means a change to how a
// career path is stored is one edit, not a hunt across the repo.
async function careerPathFor(tenantId, employeeId, horizon = 'short_term') {
  // One horizon — without it, an employee with both tabs filled got
  // whichever row the database happened to return first.
  const r = await db.query(
    `SELECT id, horizon, target_role, target_timeline, plan, updated_at
       FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2 AND horizon=$3`,
    [tenantId, employeeId, horizon]);
  const path = r.rows[0];
  if (!path) return null;
  // Milestones come with it. The review assist was written to read "any
  // progress marked in Aspiring Career" and, until migration 028, there
  // was nothing to read — it could only quote the plan text back. This is
  // what makes that promise true.
  const milestones = await milestonesFor(path.id);
  return { ...path, milestones, progress_pct: careerProgress(milestones) };
}

// transitionsWorkbook and the two banners are exported so the SAME
// writer that serves the download can be driven offline against a
// customer's employee master — otherwise the file we hand over and the
// file the button produces are two pieces of code that can drift.
// The HRBP remit is a PEOPLE concept — it is resolved from the employee
// master — but the pages it scopes are performance ones. Exported here so
// the performance module reaches it through this module's public
// interface rather than requiring its internals, which is the rule.
const hrbpScope = require('./hrbp-scope');

// Rewards & Recognition. Its own file, and its decisions in three pure
// modules beside it — the eligibility engine, the quota engine and the
// approval workflow — so each can be tested without a database and
// replaced when Zoho becomes the source of employee data.
// The First-Week Journey (onboarding tracker) — see onboarding.js.
router.use('/onboarding', require('./onboarding').router);
router.use('/', require('./rnr').router);

module.exports = { router, hrbpScope, eligibleTransitionsFor, careerPathDiagnostics, careerPathFor, targetsFor, targetDepartments,
                   experienceFrom, remainingTimeline, transitionsWorkbook, suggestedTransitionRows,
                   TRANSITION_HEADERS, TRANSITION_BANNER, SUGGESTED_BANNER };
