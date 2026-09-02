// People — the culture layer (spec §5): awards, events + RSVPs, CSR,
// campus, appraisal queries, career matrix/paths. Straightforward CRUD with
// the standard gates: people_view to read, people_admin to administer;
// employees act on their own rows (RSVP, participate, nominate, query).

const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { authenticate } = require('../../core/auth');
const { guardUuidParams } = require('../../core/http');
const { apiPermissionParity, hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const pm = require('../performance/phase-machine');

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
  const r = await db.query(
    `SELECT phase FROM pms.cycles WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled') ORDER BY created_at DESC LIMIT 1`,
    [tenantId]);
  return r.rows[0] ? r.rows[0].phase : null;
}

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
      where += ` AND (from_role ILIKE $${params.length} OR to_role ILIKE $${params.length} OR from_level ILIKE $${params.length} OR to_level ILIKE $${params.length})`;
    }
    const r = await db.query(`SELECT * FROM people.career_transitions WHERE ${where} ORDER BY from_role, from_level NULLS FIRST, to_role`, params);
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
         (tenant_id, from_role, from_level, to_role, to_level, expected_level_change, min_time_months, typical_time_months, required_competencies, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [T(req), b.from_role, b.from_level || null, b.to_role, b.to_level || null,
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
         active=COALESCE($12,active), updated_at=now()
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, T(req), b.from_role || null, b.from_level ?? null, b.to_role || null, b.to_level ?? null,
       b.expected_level_change ?? null, b.min_time_months ?? null, b.typical_time_months ?? null,
       competencies || null, b.notes ?? null, b.active ?? null]);
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
const TRANSITION_MATCH = `
  LOWER(TRIM(from_role)) = LOWER(TRIM($2))
  AND (NULLIF(TRIM(COALESCE(from_level, '')), '') IS NULL
       OR LOWER(TRIM(from_level)) = LOWER(TRIM(COALESCE($3, ''))))`;

async function eligibleTransitionsFor(tenantId, employeeId) {
  const emp = (await db.query(`SELECT designation, role_band FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp || !emp.designation) return [];
  const r = await db.query(
    `SELECT * FROM people.career_transitions
      WHERE tenant_id=$1 AND active=true AND ${TRANSITION_MATCH}`,
    [tenantId, emp.designation, emp.role_band || null]);
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
    `SELECT designation, role_band FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp) return { reason: 'no_employee' };
  if (!emp.designation) {
    return { reason: 'no_designation', designation: null, role_band: emp.role_band || null, matched: 0 };
  }
  const base = { designation: emp.designation, role_band: emp.role_band || null };

  // Everything configured FROM this role, ignoring level and active, so we
  // can tell "nothing exists" from "something exists but was filtered".
  const all = (await db.query(
    `SELECT to_role, from_level, active FROM people.career_transitions
      WHERE tenant_id=$1 AND LOWER(TRIM(from_role)) = LOWER(TRIM($2))`,
    [tenantId, emp.designation])).rows;

  const matched = await eligibleTransitionsFor(tenantId, employeeId);
  if (matched.length) return { ...base, reason: 'ok', matched: matched.length };

  if (!all.length) return { ...base, reason: 'none_configured', matched: 0 };

  const active = all.filter((t) => t.active);
  if (!active.length) return { ...base, reason: 'all_inactive', matched: 0, inactive: all.length };

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
    const p = (await db.query(`SELECT id, target_role, target_timeline, plan, updated_at FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id])).rows[0];
    const milestones = await milestonesFor(p ? p.id : null);
    const transitions = await eligibleTransitionsFor(T(req), req.user.id);
    const eligibleTargetRoles = [...new Set(transitions.map((t) => t.to_role))].sort();
    const phase = await activeCyclePhase(T(req));
    // path_diagnostics explains an EMPTY eligible list. Without it the UI
    // could only say "nothing configured", which is wrong whenever a
    // transition exists but was excluded on level.
    const diagnostics = eligibleTargetRoles.length ? null : await careerPathDiagnostics(T(req), req.user.id);
    res.json({ path: p || null, milestones, progress_pct: careerProgress(milestones),
      eligible_target_roles: eligibleTargetRoles, cycle_phase: phase,
      editable: pm.phaseAllows(phase, 'career_edit'), path_diagnostics: diagnostics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/career/my-path', async (req, res) => {
  try {
    const phase = await activeCyclePhase(T(req));
    if (!pm.phaseAllows(phase, 'career_edit')) {
      return res.status(409).json({ error: `Aspiring Career editing is not open (phase: ${phase || 'no active cycle'}) — opens once HR locks KRAs and moves the cycle to Growth Planning` });
    }
    const { target_role, target_timeline, plan } = req.body || {};
    if (!target_role || !String(target_role).trim()) return res.status(400).json({ error: 'target_role required' });
    const transitions = await eligibleTransitionsFor(T(req), req.user.id);
    const eligibleTargetRoles = [...new Set(transitions.map((t) => t.to_role))];
    if (eligibleTargetRoles.length && !eligibleTargetRoles.includes(target_role)) {
      return res.status(422).json({ error: `target_role must be one of the transitions configured from your current role in the Career Pathing Matrix: ${eligibleTargetRoles.join(', ')}` });
    }
    await db.query(
      `INSERT INTO people.career_paths (tenant_id, employee_id, target_role, target_timeline, plan) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, employee_id) DO UPDATE SET target_role=EXCLUDED.target_role, target_timeline=EXCLUDED.target_timeline, plan=EXCLUDED.plan, updated_at=now()`,
      [T(req), req.user.id, target_role.trim(), (target_timeline || '').trim() || null, plan || null]);
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
    const phase = await activeCyclePhase(T(req));
    if (!pm.phaseAllows(phase, 'career_edit')) {
      return res.status(409).json({ error: `Aspiring Career editing is not open (phase: ${phase || 'no active cycle'}) — opens once HR locks KRAs and moves the cycle to Growth Planning` });
    }
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
