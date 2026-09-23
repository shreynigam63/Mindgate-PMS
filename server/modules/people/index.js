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
const { apiPermissionParity, hasPermission } = require('../../core/permissions');
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

// 2 MB: a career matrix is tens of rows, not tens of thousands. A limit
// this low turns "somebody uploaded the wrong file" into a clear error
// rather than a slow request.
const transitionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const router = express.Router();
router.use(authenticate, apiPermissionParity);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);
const T = (req) => req.user.tenant_id;
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
async function growthWindowFor(tenantId, employeeId) {
  const c = await activeCycle(tenantId);
  if (!c) return { phase: null, window: pm.growthEditable(null, {}) };
  const sheet = (await db.query(
    `SELECT status FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
    [tenantId, c.id, employeeId])).rows[0];
  return { phase: c.phase, window: pm.growthEditable(c.phase, { sheetStatus: sheet ? sheet.status : null }) };
}

// One message, so the employee is told the same thing whichever of the two
// routes refused them, and it names the single action that opens it.
const careerShutMessage = (phase, w) => (w.reason === 'kra_not_submitted'
  ? 'Submit your KRAs to your manager first — Aspiring Career opens the moment you do'
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
    const { title, description, location, starts_at, ends_at } = req.body || {};
    if (!title || !starts_at) return res.status(400).json({ error: 'title and starts_at required' });
    const r = await db.query(
      `INSERT INTO people.events (tenant_id, title, description, location, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [T(req), title, description || null, location || null, starts_at, ends_at || null, req.user.email]);
    res.json({ ok: true, event: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/events/:id/rsvp', async (req, res) => {
  try {
    const response = (req.body && req.body.response) || 'yes';
    if (!['yes', 'no', 'maybe'].includes(response)) return res.status(400).json({ error: 'response must be yes|no|maybe' });
    await db.query(
      `INSERT INTO people.event_rsvps (tenant_id, event_id, employee_id, response) VALUES ($1,$2,$3,$4)
       ON CONFLICT (event_id, employee_id) DO UPDATE SET response=EXCLUDED.response, at=now()`,
      [T(req), req.params.id, req.user.id, response]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- CSR --------------------------------------------------------------------
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
    const { title, description, event_date, hours_credit } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await db.query(
      `INSERT INTO people.csr_events (tenant_id, title, description, event_date, hours_credit) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [T(req), title, description || null, event_date || null, hours_credit || 0]);
    res.json({ ok: true, csr: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/csr/:id/participate', async (req, res) => {
  try {
    const hours = req.body && req.body.hours;
    await db.query(
      `INSERT INTO people.csr_participations (tenant_id, csr_event_id, employee_id, hours) VALUES ($1,$2,$3,$4)
       ON CONFLICT (csr_event_id, employee_id) DO UPDATE SET hours=EXCLUDED.hours, at=now()`,
      [T(req), req.params.id, req.user.id, hours != null ? Number(hours) : null]);
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

// The role_band values that actually exist, so From Level can be a
// dropdown like From Role already is instead of a free-text box nobody
// can spell consistently.
router.get('/role-bands', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT DISTINCT role_band FROM core.employees
        WHERE tenant_id=$1 AND role_band IS NOT NULL AND TRIM(role_band) <> '' ORDER BY role_band`,
      [T(req)]);
    res.json({ role_bands: r.rows.map((row) => row.role_band) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// How many active employees a from_role/from_level pair actually matches.
// Shown while HR fills the form, so a transition that matches NOBODY is
// visible at the moment it is created rather than discovered weeks later
// by an employee being told no path exists.
router.get('/career/match-count', async (req, res) => {
  try {
    const fromRole = (req.query.from_role || '').trim();
    if (!fromRole) return res.json({ count: 0, from_role: null });
    const fromLevel = (req.query.from_level || '').trim() || null;
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM core.employees
        WHERE tenant_id=$1 AND status='active'
          AND LOWER(TRIM(designation)) = LOWER(TRIM($2))
          AND ($3::text IS NULL
               OR LOWER(TRIM(COALESCE(role_band, ''))) = LOWER(TRIM($3)))`,
      [T(req), fromRole, fromLevel]);
    res.json({ count: r.rows[0].n, from_role: fromRole, from_level: fromLevel });
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
    res.json({ transitions: r.rows });
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
      [T(req), (b.department || '').trim() || null, b.from_role, b.from_level || null, b.to_role, b.to_level || null,
       b.expected_level_change ?? null, b.min_time_months ?? null, b.typical_time_months ?? null, competencies, b.notes || null]);
    res.json({ ok: true, transition: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/career/transitions/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    const competencies = Array.isArray(b.required_competencies) ? b.required_competencies
      : (typeof b.required_competencies === 'string' ? b.required_competencies.split('\n').map((s) => s.trim()).filter(Boolean) : undefined);
    const r = await db.query(
      `UPDATE people.career_transitions SET
         from_role=COALESCE($3,from_role), from_level=$4, to_role=COALESCE($5,to_role), to_level=$6,
         expected_level_change=$7, min_time_months=$8, typical_time_months=$9,
         required_competencies=COALESCE($10,required_competencies), notes=$11,
         active=COALESCE($12,active), department=$13, updated_at=now()
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, T(req), b.from_role || null, b.from_level ?? null, b.to_role || null, b.to_level ?? null,
       b.expected_level_change ?? null, b.min_time_months ?? null, b.typical_time_months ?? null,
       competencies || null, b.notes ?? null, b.active ?? null,
       b.department === undefined ? null : ((b.department || '').trim() || null)]);
    if (!r.rows.length) return res.status(404).json({ error: 'transition not found' });
    res.json({ ok: true, transition: r.rows[0] });
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

const TRANSITION_BANNER = 'One row per transition. From Role and To Role are required and should match designations on the employee master exactly — a role nobody holds yet is allowed (that is what a career path is for) and only warned about. Leave Department blank for a rung that applies to EVERY department; fill it in and the rung applies only to that department, and a department-specific rung wins over a blank one for the same move. Leave From Level blank for "any level". Required Competencies: one per line, or separated by ; — Months fields are advisory and not enforced. Re-uploading a transition that already exists UPDATES it rather than adding a second copy — Department is part of what makes a transition "the same one". Delete the sample rows before uploading.';
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
router.get('/career/transitions/template.xlsx', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Career Transitions');
    ws.addRow([TRANSITION_BANNER]);
    ws.mergeCells(1, 1, 1, TRANSITION_HEADERS.length);
    ws.getRow(1).font = { italic: true };
    const header = ws.addRow(TRANSITION_HEADERS);
    header.font = { bold: true };
    header.alignment = { wrapText: true, vertical: 'middle' };
    for (const row of TRANSITION_SAMPLE) ws.addRow(row);
    ws.columns.forEach((col, i) => { col.width = [22, 26, 16, 26, 16, 16, 18, 20, 44, 34][i] || 20; });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="career_transitions_template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) { logger.error('career transitions template xlsx', { error: e.message }); res.status(500).json({ error: 'Could not build the template file' }); }
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
               required_competencies=$6, notes=$7, active=true, updated_at=now()
             WHERE id=$1 AND tenant_id=$2`,
            [r.existing_id, T(req), r.expected_level_change, r.min_time_months,
             r.typical_time_months, r.required_competencies, r.notes]);
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
const TRANSITION_MATCH = `
  LOWER(TRIM(from_role)) = LOWER(TRIM($2))
  AND (NULLIF(TRIM(COALESCE(from_level, '')), '') IS NULL
       OR LOWER(TRIM(from_level)) = LOWER(TRIM(COALESCE($3, ''))))
  AND (NULLIF(TRIM(COALESCE(department, '')), '') IS NULL
       OR LOWER(TRIM(department)) = LOWER(TRIM(COALESCE($4, ''))))`;

// The move a rung describes, ignoring which department wrote it. Two
// rows with the same move are the same step offered twice, and the
// employee must be shown ONE of them.
const MOVE_KEY = `LOWER(BTRIM(from_role)), LOWER(BTRIM(COALESCE(from_level,''))),
                  LOWER(BTRIM(to_role)),   LOWER(BTRIM(COALESCE(to_level,'')))`;

async function eligibleTransitionsFor(tenantId, employeeId) {
  const emp = (await db.query(`SELECT designation, role_band, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp || !emp.designation) return [];
  // MOST SPECIFIC WINS. Where a department has written its own version of
  // a move AND a company-wide version exists, the employee sees their
  // department's — with its competencies and its time-in-role figures,
  // which is the whole reason the column was asked for. Showing both
  // would offer the same step twice with contradictory requirements.
  const r = await db.query(
    `SELECT DISTINCT ON (${MOVE_KEY}) *
       FROM people.career_transitions
      WHERE tenant_id=$1 AND active=true AND ${TRANSITION_MATCH}
      ORDER BY ${MOVE_KEY}, (COALESCE(BTRIM(department),'') <> '') DESC`,
    [tenantId, emp.designation, emp.role_band || null, emp.department || null]);
  return r.rows;
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
    `SELECT designation, role_band, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp) return { reason: 'no_employee' };
  if (!emp.designation) {
    return { reason: 'no_designation', designation: null, role_band: emp.role_band || null, matched: 0 };
  }
  const base = { designation: emp.designation, role_band: emp.role_band || null,
                 department: emp.department || null };

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

  // Configured and active, so the only thing left that can exclude them is
  // the level. Report both sides of the comparison — the whole failure was
  // that neither was visible.
  return {
    ...base,
    reason: 'level_mismatch',
    matched: 0,
    excluded_by_level: active.map((t) => ({ to_role: t.to_role, requires_level: t.from_level })),
  };
}

router.get('/career/my-path', async (req, res) => {
  try {
    const p = (await db.query(
      `SELECT id, target_role, target_timeline, plan, years_experience, skills_interests, updated_at
         FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id])).rows[0];
    // The employee's CURRENT role, straight off the master. Asked for on
    // 23 Sep: the form asked where you want to go without ever saying
    // where you are, so "is this a step up?" was unanswerable on screen.
    // Read here rather than typed, because a designation somebody types
    // is a designation that stops matching the matrix.
    const me = (await db.query(
      `SELECT designation, department, role_band, date_of_joining
         FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.user.id, T(req)])).rows[0] || {};
    const milestones = await milestonesFor(p ? p.id : null);
    const transitions = await eligibleTransitionsFor(T(req), req.user.id);
    const eligibleTargetRoles = [...new Set(transitions.map((t) => t.to_role))].sort();
    const phase = await activeCyclePhase(T(req));
    // path_diagnostics explains an EMPTY eligible list. Without it the UI
    // could only say "nothing configured", which is wrong whenever a
    // transition exists but was excluded on level.
    const diagnostics = eligibleTargetRoles.length ? null : await careerPathDiagnostics(T(req), req.user.id);
    const gw = await growthWindowFor(T(req), req.user.id);
    res.json({ path: p || null, milestones, progress_pct: careerProgress(milestones),
      current: { designation: me.designation || null, department: me.department || null,
                 role_band: me.role_band || null, date_of_joining: me.date_of_joining || null },
      eligible_target_roles: eligibleTargetRoles, cycle_phase: phase,
      editable: gw.window.ok, editable_via: gw.window.via || null,
      shut_because: gw.window.ok ? null : gw.window.reason,
      path_diagnostics: diagnostics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/career/my-path', async (req, res) => {
  try {
    const gw = await growthWindowFor(T(req), req.user.id);
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
    const transitions = await eligibleTransitionsFor(T(req), req.user.id);
    const eligibleTargetRoles = [...new Set(transitions.map((t) => t.to_role))];
    if (eligibleTargetRoles.length && !eligibleTargetRoles.includes(target_role)) {
      return res.status(422).json({ error: `target_role must be one of the transitions configured from your current role in the Career Pathing Matrix: ${eligibleTargetRoles.join(', ')}` });
    }
    await db.query(
      `INSERT INTO people.career_paths
         (tenant_id, employee_id, target_role, target_timeline, plan, years_experience, skills_interests)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, employee_id) DO UPDATE SET
         target_role=EXCLUDED.target_role, target_timeline=EXCLUDED.target_timeline,
         plan=EXCLUDED.plan, years_experience=EXCLUDED.years_experience,
         skills_interests=EXCLUDED.skills_interests, updated_at=now()`,
      [T(req), req.user.id, target_role.trim(), (target_timeline || '').trim() || null, plan || null,
       years, (skills_interests || '').trim() || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

async function myCareerPathId(tenantId, employeeId) {
  const r = await db.query(
    `SELECT id FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]);
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
    const gw = await growthWindowFor(T(req), req.user.id);
    if (!gw.window.ok) return res.status(409).json({ error: careerShutMessage(gw.phase, gw.window) });
    const pathId = await myCareerPathId(T(req), req.user.id);
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
        RETURNING m.id`,
      [Math.round(progress), req.params.id, T(req), req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'milestone not found' });
    const milestones = await milestonesFor(await myCareerPathId(T(req), req.user.id));
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
         LEFT JOIN people.career_paths cp ON cp.tenant_id=e.tenant_id AND cp.employee_id=e.id
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
async function careerPathFor(tenantId, employeeId) {
  const r = await db.query(
    `SELECT id, target_role, target_timeline, plan, updated_at
       FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`,
    [tenantId, employeeId]);
  const path = r.rows[0];
  if (!path) return null;
  // Milestones come with it. The review assist was written to read "any
  // progress marked in Aspiring Career" and, until migration 028, there
  // was nothing to read — it could only quote the plan text back. This is
  // what makes that promise true.
  const milestones = await milestonesFor(path.id);
  return { ...path, milestones, progress_pct: careerProgress(milestones) };
}

module.exports = { router, eligibleTransitionsFor, careerPathDiagnostics, careerPathFor };
