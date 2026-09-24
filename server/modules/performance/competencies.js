// Competency mapping — the routes.
//
// Asked for on 24 Sep with the client's own workbook attached:
// "Consider 3rd excel sheet for creating employee competency mapping
// system for evaluation self and manager to have complete competency of
// the organization."
//
// Four surfaces, one per sheet in that workbook:
//
//   GET/PUT/POST  /competencies/me            the Employee Form
//   GET/PUT/POST  /competencies/team/:id      the Manager Assessment
//   GET/POST/DEL  /competencies/framework     the Competency Master
//   GET           /competencies/dashboard     the HR Dashboard
//
// Mounted by the performance router, which has already authenticated
// and run the parity gate. Every handler below still guards its own
// rows — the carried lesson is that route rules cover coarse routes and
// row scope lives here.
//
// WHAT IS DELIBERATELY NOT HERE. The workbook's fifth sheet is an IDP.
// This product already has Target Achievements and Improvement Plans; a
// third place to write development actions would be the place nobody
// looks. Gaps are surfaced and exported, and the action goes where
// actions already go.
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { activeCycle } = require('./active-cycle');
const { validRating, requiredLevelFor, competenciesFor, summarise, divergences } = require('./competency-rules');

const router = express.Router();
const T = (req) => req.user.tenant_id;

// The same audit helper the rest of the module uses, including the
// self_action flag — a competency rating feeds development decisions
// and, through the gap list, who gets training money, so "who awarded
// this" has to stay a query and not an archaeology exercise. Copied
// rather than imported because index.js requires THIS file, and a
// require back the other way is a cycle.
const audit = (req, action, cycleId, employeeId, details) => {
  const selfAction = !!(employeeId && req.user && employeeId === req.user.id);
  const body = selfAction ? { ...(details || {}), self_action: true } : details;
  return db.query(
    `INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [T(req), req.user.email, action, cycleId || null, employeeId || null, body ? JSON.stringify(body) : null])
    .catch((e) => logger.warn('competency audit failed', { error: e.message }));
};

// ---------------------------------------------------------------------------
// Shared reads

const scaleFor = async (t) => (await db.query(
  `SELECT level, label, description FROM pms.competency_scale WHERE tenant_id=$1 ORDER BY level`, [t])).rows;

const frameworkFor = async (t) => (await db.query(
  `SELECT id, category, name, description, default_required_level, managers_only, sort_order, active
     FROM pms.competencies WHERE tenant_id=$1 ORDER BY sort_order, name`, [t])).rows;

const roleLevelsFor = async (t) => (await db.query(
  `SELECT competency_id, designation, department, required_level
     FROM pms.competency_role_levels WHERE tenant_id=$1`, [t])).rows;

const hasReports = async (t, employeeId) => !!(await db.query(
  `SELECT 1 FROM core.employees WHERE tenant_id=$1 AND manager_id=$2 AND status='active' LIMIT 1`,
  [t, employeeId])).rows[0];

// Create the assessment and its rating rows on first read, the same way
// the KRA sheet and the mid-year check-in are created on first save.
// The required level is SNAPSHOTTED here: re-levelling a job mid-cycle
// must not rewrite the gap somebody has already been measured against.
async function ensureAssessment(t, cycleId, employee) {
  let a = (await db.query(
    `SELECT * FROM pms.competency_assessments WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
    [t, cycleId, employee.id])).rows[0];
  if (!a) {
    a = (await db.query(
      `INSERT INTO pms.competency_assessments (tenant_id, cycle_id, employee_id, manager_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, cycle_id, employee_id) DO UPDATE SET updated_at=now()
       RETURNING *`, [t, cycleId, employee.id, employee.manager_id || null])).rows[0];
  }
  const [all, levels] = await Promise.all([frameworkFor(t), roleLevelsFor(t)]);
  const mine = competenciesFor(all, { hasReports: await hasReports(t, employee.id) });
  // Missing rows only — an existing row keeps its snapshotted level.
  const have = new Set((await db.query(
    `SELECT competency_id FROM pms.competency_ratings WHERE assessment_id=$1`, [a.id]))
    .rows.map((r) => r.competency_id));
  for (const c of mine) {
    if (have.has(c.id)) continue;
    const required = requiredLevelFor(c.id, employee, levels) ?? c.default_required_level;
    await db.query(
      `INSERT INTO pms.competency_ratings (tenant_id, assessment_id, competency_id, required_level)
       VALUES ($1,$2,$3,$4) ON CONFLICT (assessment_id, competency_id) DO NOTHING`,
      [t, a.id, c.id, required]);
  }
  return a;
}

const ratingRows = async (t, assessmentId) => (await db.query(
  `SELECT r.id, r.competency_id, c.category, c.name, c.description, c.managers_only,
          r.required_level, r.self_rating, r.self_evidence, r.manager_rating, r.manager_comment
     FROM pms.competency_ratings r
     JOIN pms.competencies c ON c.id = r.competency_id
    WHERE r.tenant_id=$1 AND r.assessment_id=$2
    ORDER BY c.sort_order, c.name`, [t, assessmentId])).rows;

// The Employee Form's free-text blocks, in the workbook's own order.
const NARRATIVE = ['top_responsibilities', 'critical_outcomes', 'strongest_areas', 'challenging_areas',
  'develop_next', 'preferred_methods', 'aspiration_2_3_years', 'next_role_competencies',
  'internal_mobility', 'support_needed'];

// ---------------------------------------------------------------------------
// The Employee Form

router.get('/me', async (req, res) => {
  try {
    const t = T(req);
    const c = await activeCycle(t);
    if (!c) return res.json({ cycle: null, assessment: null, rows: [], scale: await scaleFor(t) });
    const emp = (await db.query(
      `SELECT id, name, designation, department, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.user.id, t])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    const a = await ensureAssessment(t, c.id, emp);
    const rows = await ratingRows(t, a.id);
    const scale = await scaleFor(t);
    const mgr = a.manager_id ? (await db.query(`SELECT name FROM core.employees WHERE id=$1`, [a.manager_id])).rows[0] : null;
    res.json({
      cycle: { id: c.id, name: c.name, phase: c.phase },
      employee: { name: emp.name, designation: emp.designation, department: emp.department,
                  manager_name: mgr ? mgr.name : null },
      assessment: a,
      // Locked once submitted, like every other self-entered artefact
      // here. Reopening is HR's decision, not a stray click's.
      editable: a.self_status !== 'submitted',
      rows, scale,
      summary: summarise(rows, { scale }),
    });
  } catch (e) { logger.error('competency me', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.put('/me', async (req, res) => {
  try {
    const t = T(req);
    const c = await activeCycle(t);
    if (!c) return res.status(409).json({ error: 'No cycle is open' });
    const emp = (await db.query(
      `SELECT id, designation, department, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.user.id, t])).rows[0];
    const a = await ensureAssessment(t, c.id, emp);
    if (a.self_status === 'submitted') return res.status(409).json({ error: 'Already submitted — locked' });

    const b = req.body || {};
    // Validate EVERY rating before writing ANY of them, so a bad value
    // half way down does not leave the form half saved.
    const entries = b.entries && typeof b.entries === 'object' ? b.entries : {};
    const clean = [];
    for (const [competencyId, v] of Object.entries(entries)) {
      const chk = validRating(v && v.rating);
      if (!chk.ok) return res.status(422).json({ error: `${chk.reason}`, competency_id: competencyId });
      clean.push([competencyId, chk.value, v && v.evidence != null ? String(v.evidence) : null]);
    }
    for (const [competencyId, rating, evidence] of clean) {
      await db.query(
        `UPDATE pms.competency_ratings
            SET self_rating=$3, self_evidence=COALESCE($4, self_evidence), updated_at=now()
          WHERE assessment_id=$1 AND competency_id=$2`, [a.id, competencyId, rating, evidence]);
    }
    const sets = [];
    const vals = [a.id];
    for (const f of NARRATIVE) {
      if (b[f] === undefined) continue;
      vals.push(b[f] === null ? null : String(b[f]));
      sets.push(`${f}=$${vals.length}`);
    }
    await db.query(
      `UPDATE pms.competency_assessments
          SET self_status = CASE WHEN self_status='not_started' THEN 'in_progress' ELSE self_status END,
              updated_at=now()${sets.length ? ', ' + sets.join(', ') : ''}
        WHERE id=$1`, vals);
    const rows = await ratingRows(t, a.id);
    res.json({ ok: true, summary: summarise(rows, { scale: await scaleFor(t) }) });
  } catch (e) { logger.error('competency me save', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.post('/me/submit', async (req, res) => {
  try {
    const t = T(req);
    const c = await activeCycle(t);
    if (!c) return res.status(409).json({ error: 'No cycle is open' });
    const emp = (await db.query(
      `SELECT id, name, designation, department, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.user.id, t])).rows[0];
    const a = await ensureAssessment(t, c.id, emp);
    if (a.self_status === 'submitted') return res.status(409).json({ error: 'Already submitted' });
    const rows = await ratingRows(t, a.id);
    // A part-finished assessment is refused rather than accepted with
    // holes: an average over the competencies somebody happened to fill
    // in is not the same number as an average over their role.
    const missing = rows.filter((r) => r.self_rating == null);
    if (missing.length) {
      return res.status(422).json({
        error: `Rate all ${rows.length} competencies before submitting — ${missing.length} still blank.`,
        missing: missing.map((m) => m.name),
      });
    }
    await db.query(
      `UPDATE pms.competency_assessments SET self_status='submitted', self_submitted_at=now(), updated_at=now()
        WHERE id=$1`, [a.id]);
    res.json({ ok: true, rows: rows.length });
  } catch (e) { logger.error('competency submit', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// The Manager Assessment

// Who this caller may assess. Their own reports, and the whole company
// for pms_admin — the same row rule every other team route here uses.
async function assessable(req, employeeId) {
  const t = T(req);
  const emp = (await db.query(
    `SELECT id, name, designation, department, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`,
    [employeeId, t])).rows[0];
  if (!emp) return { error: 'employee not found', status: 404 };
  if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) {
    return { error: 'Not your report', status: 403 };
  }
  return { emp };
}

router.get('/team', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const t = T(req);
    const c = await activeCycle(t);
    if (!c) return res.json({ cycle: null, team: [] });
    // My reports only — the Manager tab is one manager's team, per the
    // 24 Sep instruction that removed the whole-company switch from it.
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, e.designation, e.department,
              a.id AS assessment_id, a.self_status, a.manager_status,
              (SELECT count(*)::int FROM pms.competency_ratings cr WHERE cr.assessment_id=a.id) AS competencies,
              (SELECT count(*)::int FROM pms.competency_ratings cr
                WHERE cr.assessment_id=a.id AND cr.manager_rating IS NOT NULL) AS manager_rated,
              (SELECT count(*)::int FROM pms.competency_ratings cr
                WHERE cr.assessment_id=a.id AND cr.manager_rating IS NOT NULL
                  AND cr.manager_rating < cr.required_level) AS below_required
         FROM core.employees e
         LEFT JOIN pms.competency_assessments a ON a.cycle_id=$2 AND a.tenant_id=$1 AND a.employee_id=e.id
        WHERE e.tenant_id=$1 AND e.status='active' AND e.manager_id=$3
        ORDER BY e.name`, [t, c.id, req.user.id]);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, team: r.rows });
  } catch (e) { logger.error('competency team', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.get('/team/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const t = T(req);
    const g = await assessable(req, req.params.employeeId);
    if (g.error) return res.status(g.status).json({ error: g.error });
    const c = await activeCycle(t);
    if (!c) return res.json({ cycle: null, rows: [] });
    const a = await ensureAssessment(t, c.id, g.emp);
    const rows = await ratingRows(t, a.id);
    const scale = await scaleFor(t);
    res.json({
      cycle: { id: c.id, name: c.name, phase: c.phase },
      employee: { id: g.emp.id, name: g.emp.name, designation: g.emp.designation, department: g.emp.department },
      assessment: a,
      editable: a.manager_status !== 'submitted',
      rows, scale,
      summary: summarise(rows, { scale }),
      // The conversation this whole exercise exists to start.
      divergences: divergences(rows),
    });
  } catch (e) { logger.error('competency team detail', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.put('/team/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const t = T(req);
    const g = await assessable(req, req.params.employeeId);
    if (g.error) return res.status(g.status).json({ error: g.error });
    const c = await activeCycle(t);
    if (!c) return res.status(409).json({ error: 'No cycle is open' });
    const a = await ensureAssessment(t, c.id, g.emp);
    if (a.manager_status === 'submitted') return res.status(409).json({ error: 'Already submitted — locked' });

    const b = req.body || {};
    const entries = b.entries && typeof b.entries === 'object' ? b.entries : {};
    const clean = [];
    for (const [competencyId, v] of Object.entries(entries)) {
      const chk = validRating(v && v.rating);
      if (!chk.ok) return res.status(422).json({ error: chk.reason, competency_id: competencyId });
      clean.push([competencyId, chk.value, v && v.comment != null ? String(v.comment) : null]);
    }
    for (const [competencyId, rating, comment] of clean) {
      await db.query(
        `UPDATE pms.competency_ratings
            SET manager_rating=$3, manager_comment=COALESCE($4, manager_comment), updated_at=now()
          WHERE assessment_id=$1 AND competency_id=$2`, [a.id, competencyId, rating, comment]);
    }
    await db.query(
      `UPDATE pms.competency_assessments
          SET manager_status = CASE WHEN manager_status='not_started' THEN 'in_progress' ELSE manager_status END,
              manager_summary = COALESCE($2, manager_summary), updated_at=now()
        WHERE id=$1`, [a.id, b.manager_summary != null ? String(b.manager_summary) : null]);
    const rows = await ratingRows(t, a.id);
    res.json({ ok: true, summary: summarise(rows, { scale: await scaleFor(t) }), divergences: divergences(rows) });
  } catch (e) { logger.error('competency team save', { error: e.message }); res.status(500).json({ error: e.message }); }
});


router.post('/team/:employeeId/submit', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const t = T(req);
    const g = await assessable(req, req.params.employeeId);
    if (g.error) return res.status(g.status).json({ error: g.error });
    const c = await activeCycle(t);
    if (!c) return res.status(409).json({ error: 'No cycle is open' });
    const a = await ensureAssessment(t, c.id, g.emp);
    if (a.manager_status === 'submitted') return res.status(409).json({ error: 'Already submitted' });
    const rows = await ratingRows(t, a.id);
    const missing = rows.filter((r) => r.manager_rating == null);
    if (missing.length) {
      return res.status(422).json({
        error: `Rate all ${rows.length} competencies before submitting — ${missing.length} still blank.`,
        missing: missing.map((m) => m.name),
      });
    }
    await db.query(
      `UPDATE pms.competency_assessments SET manager_status='submitted', manager_submitted_at=now(), updated_at=now()
        WHERE id=$1`, [a.id]);
    // A competency rating feeds development decisions and, through the
    // gap list, who gets training money. Every one of those is audited,
    // with the self-action flag the rest of this module sets.
    await audit(req, 'COMPETENCY_MANAGER_SUBMITTED', c.id, g.emp.id,
      { competencies: rows.length, below_required: rows.filter((r) => r.manager_rating < r.required_level).length });
    if (g.emp.id !== req.user.id) {
      await notify(t, g.emp.id, 'competency_assessed',
        'Your competency assessment is complete',
        `${req.user.name} has completed your competency assessment.`, '/my/competencies', { email: true })
        .catch((e) => logger.warn('competency notify failed', { error: e.message }));
    }
    res.json({ ok: true, rows: rows.length });
  } catch (e) { logger.error('competency team submit', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Reopening a submitted assessment. HR only, audited, and it says why —
// the alternative HR reaches for otherwise is editing the database.
router.post('/reopen/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const t = T(req);
    const side = String((req.body || {}).side || '');
    if (!['self', 'manager'].includes(side)) return res.status(422).json({ error: "side must be 'self' or 'manager'" });
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) return res.status(422).json({ error: 'A reason is required — it is shown in the audit trail.' });
    const c = await activeCycle(t);
    if (!c) return res.status(409).json({ error: 'No cycle is open' });
    const r = await db.query(
      `UPDATE pms.competency_assessments
          SET ${side}_status='in_progress', ${side}_submitted_at=NULL, updated_at=now()
        WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND ${side}_status='submitted'
        RETURNING id`, [t, c.id, req.params.employeeId]);
    if (!r.rows[0]) return res.status(409).json({ error: 'Nothing submitted to reopen' });
    await audit(req, 'COMPETENCY_REOPENED', c.id, req.params.employeeId, { side, reason });
    res.json({ ok: true });
  } catch (e) { logger.error('competency reopen', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// The Competency Master — HR's framework

router.get('/framework', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const t = T(req);
    const [competencies, scale, levels] = await Promise.all([frameworkFor(t), scaleFor(t), roleLevelsFor(t)]);
    // How many people each job-specific level actually covers, so HR can
    // see whether a level they set applies to one person or two hundred.
    const heads = (await db.query(
      `SELECT designation, coalesce(department,'') AS department, count(*)::int AS n
         FROM core.employees WHERE tenant_id=$1 AND status='active' AND designation IS NOT NULL
        GROUP BY 1,2`, [t])).rows;
    res.json({ competencies, scale, role_levels: levels, headcount: heads });
  } catch (e) { logger.error('competency framework', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.post('/framework', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const b = req.body || {};
    const category = String(b.category || '').trim();
    const name = String(b.name || '').trim();
    if (!category || !name) return res.status(422).json({ error: 'category and name are required' });
    const lvl = validRating(b.default_required_level == null ? 4 : b.default_required_level);
    if (!lvl.ok || lvl.value == null) return res.status(422).json({ error: lvl.reason || 'default_required_level is required' });
    const next = (await db.query(
      `SELECT coalesce(max(sort_order),0)+1 AS n FROM pms.competencies WHERE tenant_id=$1 AND category=$2`,
      [T(req), category])).rows[0].n;
    const r = await db.query(
      `INSERT INTO pms.competencies (tenant_id, category, name, description, default_required_level, managers_only, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, category, name) DO NOTHING RETURNING *`,
      [T(req), category, name, b.description ? String(b.description) : null, lvl.value, !!b.managers_only, next]);
    if (!r.rows[0]) return res.status(409).json({ error: `"${name}" already exists under ${category}` });
    await audit(req, 'COMPETENCY_ADDED', null, null, { category, name });
    res.status(201).json({ competency: r.rows[0] });
  } catch (e) { logger.error('competency add', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.put('/framework/:id', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const b = req.body || {};
    if (b.default_required_level !== undefined) {
      const lvl = validRating(b.default_required_level);
      if (!lvl.ok || lvl.value == null) return res.status(422).json({ error: lvl.reason || 'level must be 1-5' });
    }
    const r = await db.query(
      `UPDATE pms.competencies SET
         description = COALESCE($3, description),
         default_required_level = COALESCE($4, default_required_level),
         managers_only = COALESCE($5, managers_only),
         active = COALESCE($6, active),
         updated_at = now()
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [req.params.id, T(req), b.description ?? null,
       b.default_required_level ?? null, b.managers_only ?? null, b.active ?? null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'competency not found' });
    await audit(req, 'COMPETENCY_UPDATED', null, null, { id: req.params.id, changed: Object.keys(b) });
    res.json({ competency: r.rows[0] });
  } catch (e) { logger.error('competency update', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// DEACTIVATE, never delete, once anybody has been rated against it —
// deleting would cascade away ratings that a decision was made on.
router.delete('/framework/:id', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const used = (await db.query(
      `SELECT count(*)::int AS n FROM pms.competency_ratings
        WHERE tenant_id=$1 AND competency_id=$2 AND (self_rating IS NOT NULL OR manager_rating IS NOT NULL)`,
      [T(req), req.params.id])).rows[0].n;
    if (used > 0) {
      const r = await db.query(
        `UPDATE pms.competencies SET active=false, updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING name`,
        [req.params.id, T(req)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'competency not found' });
      await audit(req, 'COMPETENCY_DEACTIVATED', null, null, { id: req.params.id, ratings: used });
      return res.json({ ok: true, deactivated: true, ratings: used,
        message: `${used} ${used === 1 ? 'person has' : 'people have'} been rated on this, so it was retired rather than deleted — existing assessments keep it and new ones will not include it.` });
    }
    const r = await db.query(`DELETE FROM pms.competencies WHERE id=$1 AND tenant_id=$2 RETURNING name`,
      [req.params.id, T(req)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'competency not found' });
    await audit(req, 'COMPETENCY_DELETED', null, null, { name: r.rows[0].name });
    res.json({ ok: true, deleted: true });
  } catch (e) { logger.error('competency delete', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// A job-specific required level. Designation-first with an optional
// department, the same scoping rule the KRA library uses.
router.post('/framework/:id/level', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const b = req.body || {};
    const designation = String(b.designation || '').trim();
    if (!designation) return res.status(422).json({ error: 'designation is required' });
    const lvl = validRating(b.required_level);
    if (!lvl.ok || lvl.value == null) return res.status(422).json({ error: lvl.reason || 'required_level is required' });
    const department = String(b.department || '').trim() || null;
    const r = await db.query(
      `INSERT INTO pms.competency_role_levels (tenant_id, competency_id, designation, department, required_level)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, competency_id, designation, department)
         DO UPDATE SET required_level=EXCLUDED.required_level
       RETURNING *`, [T(req), req.params.id, designation, department, lvl.value]);
    // The partial index covers the NULL-department case, which the
    // ON CONFLICT above cannot see — so that one is upserted by hand.
    if (!r.rows[0] && !department) {
      await db.query(
        `UPDATE pms.competency_role_levels SET required_level=$4
          WHERE tenant_id=$1 AND competency_id=$2 AND designation=$3 AND department IS NULL`,
        [T(req), req.params.id, designation, lvl.value]);
    }
    await audit(req, 'COMPETENCY_LEVEL_SET', null, null,
      { competency_id: req.params.id, designation, department, required_level: lvl.value });
    res.status(201).json({ ok: true, level: r.rows[0] || null });
  } catch (e) { logger.error('competency level', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.delete('/framework/:id/level/:levelId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const r = await db.query(
      `DELETE FROM pms.competency_role_levels WHERE id=$1 AND competency_id=$2 AND tenant_id=$3 RETURNING designation`,
      [req.params.levelId, req.params.id, T(req)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'COMPETENCY_LEVEL_CLEARED', null, null, { competency_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { logger.error('competency level delete', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// The HR Dashboard — "complete competency of the organization"
//
// Every figure is a straight aggregate over manager ratings against the
// levels those ratings were taken under. Self-ratings are reported but
// never averaged into a company number: an optimistic self-assessment
// must not be able to move an organisation-level figure.

// All the rating rows the dashboard aggregates, for one cycle,
// optionally narrowed to a department. One query, so the strip, the
// category table and the department table can never disagree.
async function dashboardRows(t, cycleId, department) {
  const params = [t, cycleId];
  let where = '';
  if (department) { params.push(department); where = `AND e.department = $${params.length}`; }
  return (await db.query(
    `SELECT r.competency_id, c.category, c.name, r.required_level, r.self_rating, r.manager_rating,
            e.id AS employee_id, e.name AS employee_name, e.department, e.designation,
            a.self_status, a.manager_status
       FROM pms.competency_ratings r
       JOIN pms.competency_assessments a ON a.id = r.assessment_id
       JOIN pms.competencies c ON c.id = r.competency_id
       JOIN core.employees e ON e.id = a.employee_id
      WHERE r.tenant_id=$1 AND a.cycle_id=$2 AND e.status='active' ${where}`, params)).rows;
}

router.get('/dashboard', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const t = T(req);
    const c = await activeCycle(t);
    if (!c) return res.json({ cycle: null, categories: [], departments: [], coverage: null });
    const department = String(req.query.department || '').trim() || null;
    const [rows, scale] = await Promise.all([dashboardRows(t, c.id, department), scaleFor(t)]);
    const roll = summarise(rows, { scale });

    // Coverage first, because every average below is meaningless
    // without it. "Average 3.8" over four of 1,398 people is not a
    // company figure, and a dashboard that does not say so is lying
    // by omission.
    const people = new Map();
    for (const r of rows) {
      if (!people.has(r.employee_id)) {
        people.set(r.employee_id, { self: r.self_status, manager: r.manager_status, department: r.department });
      }
    }
    const headcount = (await db.query(
      `SELECT count(*)::int AS n FROM core.employees
        WHERE tenant_id=$1 AND status='active' ${department ? 'AND department=$2' : ''}`,
      department ? [t, department] : [t])).rows[0].n;
    const started = [...people.values()];
    const coverage = {
      employees: headcount,
      started: started.length,
      self_submitted: started.filter((p) => p.self === 'submitted').length,
      manager_submitted: started.filter((p) => p.manager === 'submitted').length,
    };

    // Per department, so HR can see WHERE the gap is rather than only
    // that there is one. Computed from the same rows as everything
    // else, filtered rather than re-queried.
    const depts = [...new Set(rows.map((r) => r.department || '—'))].sort();
    const departments = depts.map((d) => {
      const sub = rows.filter((r) => (r.department || '—') === d);
      const sr = summarise(sub, { scale });
      return {
        department: d,
        people: new Set(sub.map((r) => r.employee_id)).size,
        rated: sr.overall.manager_rated,
        avg_manager: sr.overall.avg_manager,
        avg_required: sr.overall.avg_required,
        avg_gap: sr.overall.avg_gap,
        below_required: sr.overall.below_required,
      };
    }).sort((a, b) => (a.avg_gap ?? 99) - (b.avg_gap ?? 99));

    // The competencies the organisation is weakest on, as counts of
    // PEOPLE below the required level — the figure that sizes a
    // training programme.
    const byComp = new Map();
    for (const r of rows) {
      if (r.manager_rating == null) continue;
      const k = r.competency_id;
      if (!byComp.has(k)) byComp.set(k, { competency_id: k, category: r.category, name: r.name, rated: 0, below: 0, sum: 0, req: 0 });
      const b = byComp.get(k);
      b.rated += 1; b.sum += r.manager_rating; b.req += r.required_level;
      if (r.manager_rating < r.required_level) b.below += 1;
    }
    const weakest = [...byComp.values()]
      .map((b) => ({ ...b, avg_manager: Math.round((b.sum / b.rated) * 100) / 100,
        avg_required: Math.round((b.req / b.rated) * 100) / 100,
        avg_gap: Math.round(((b.sum - b.req) / b.rated) * 100) / 100,
        pct_below: Math.round((b.below / b.rated) * 1000) / 10 }))
      .sort((a, b) => a.avg_gap - b.avg_gap || b.below - a.below)
      .slice(0, 12);

    res.json({
      cycle: { id: c.id, name: c.name, phase: c.phase },
      department, coverage, scale,
      categories: roll.categories, overall: roll.overall,
      departments, weakest,
      department_list: (await db.query(
        `SELECT DISTINCT department FROM core.employees
          WHERE tenant_id=$1 AND status='active' AND department IS NOT NULL AND department <> ''
          ORDER BY department`, [t])).rows.map((r) => r.department),
    });
  } catch (e) { logger.error('competency dashboard', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// The gap list as a workbook — the thing HR takes into a training
// budget conversation. One row per person per unmet competency, which
// is the grain a development plan is written at.
const GAP_COLUMNS = ['Employee', 'Department', 'Designation', 'Category', 'Competency',
  'Current Level', 'Required Level', 'Gap', 'Self Rating'];

router.get('/dashboard/gaps.xlsx', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const t = T(req);
    const c = await activeCycle(t);
    if (!c) return res.status(409).json({ error: 'No cycle is open' });
    const department = String(req.query.department || '').trim() || null;
    const rows = (await dashboardRows(t, c.id, department))
      .filter((r) => r.manager_rating != null && r.manager_rating < r.required_level)
      .sort((a, b) => (a.manager_rating - a.required_level) - (b.manager_rating - b.required_level)
        || String(a.employee_name).localeCompare(String(b.employee_name)));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Competency Gaps');
    ws.addRow(GAP_COLUMNS).font = { bold: true };
    for (const r of rows) {
      ws.addRow([r.employee_name, r.department || '', r.designation || '', r.category, r.name,
        r.manager_rating, r.required_level, r.manager_rating - r.required_level, r.self_rating ?? '']);
    }
    ws.columns.forEach((col, i) => { col.width = [26, 20, 24, 34, 32, 14, 14, 8, 12][i] || 16; });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="competency-gaps-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { logger.error('competency gaps xlsx', { error: e.message }); res.status(500).json({ error: 'Could not build the export' }); }
});

module.exports = { router, ensureAssessment, ratingRows, scaleFor, frameworkFor, dashboardRows, NARRATIVE, GAP_COLUMNS };
