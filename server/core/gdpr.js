// GDPR data export — core/gdpr.js
//
// BRD §6 NFR: "Compliance with applicable data protection regulations
// (e.g. GDPR)." That's a broad legal claim no single feature can fully
// satisfy, but Article 15 (the right of access — "give me everything
// you hold about me") is a concrete, buildable piece: this aggregates
// every table that stores personal data about one employee into a
// single JSON export, either self-service or HR-triggered on someone's
// behalf (for fulfilling a formal request an employee raised outside
// the system).
//
// DELIBERATELY NOT ATTEMPTED: automated erasure (Article 17, "right to
// be forgotten"). Cascading deletes across a live system with audit-
// trail and legal-retention obligations is a policy decision requiring
// input from HR/legal, not something safe to wire up as a self-service
// button — a wrong deletion here is not reversible the way most bugs
// are.

const express = require('express');
const db = require('./db');
const { authenticate } = require('./auth');
const { guardUuidParams } = require('./http');
const { apiPermissionParity, hasPermission } = require('./permissions');

async function buildExport(tenantId, employeeId) {
  const profile = (await db.query(
    `SELECT id, emp_code, name, email, department, designation, role_band, manager_id, date_of_joining, status,
            last_appraisal_rating, last_appraisal_at, potential_rating, nine_box_cell, super50_flag, super50_since
       FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!profile) return null;

  const [kraSheets, selfAppraisals, managerEvals, devPlans, careerPath, connects, pips, ratingHistory, consents, parameterScores, pulseChecks] = await Promise.all([
    db.query(`SELECT s.cycle_id, s.status, s.manager_comment, k.title, k.weight, k.measures FROM pms.kra_sheets s LEFT JOIN pms.kras k ON k.sheet_id=s.id WHERE s.tenant_id=$1 AND s.employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT cycle_id, status, entries, overall_self_rating, went_well, could_improve, submitted_at FROM pms.self_appraisals WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT cycle_id, status, overall_rating, strengths, improvement_areas, submitted_at FROM pms.manager_evaluations WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT p.cycle_id, p.status, p.manager_comment, g.title, g.progress_pct, g.target_date FROM pms.development_plans p LEFT JOIN pms.development_goals g ON g.plan_id=p.id WHERE p.tenant_id=$1 AND p.employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT target_role, plan, updated_at FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT held_at, notes, signed_off, meeting_based FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2 ORDER BY held_at DESC`, [tenantId, employeeId]),
    db.query(`SELECT status, plan, opened_at, closed_at, closed_reason FROM pms.pip_records WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT h.cycle_id, c.name AS cycle_name, h.final_rating, h.rating_label, h.published_at FROM pms.employee_performance_history h JOIN pms.cycles c ON c.id=h.cycle_id WHERE h.tenant_id=$1 AND h.employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT consent_type, granted, granted_at, revoked_at FROM core.employee_consents WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT cycle_id, parameter_id, score, updated_at FROM pms.parameter_scores WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT cycle_id, parameter_id, score, updated_at FROM pms.pulse_checks WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
  ]);

  return {
    exported_at: new Date().toISOString(),
    profile,
    kra_sheets: kraSheets.rows,
    self_appraisals: selfAppraisals.rows,
    manager_evaluations: managerEvals.rows,
    development_plans: devPlans.rows,
    career_path: careerPath.rows[0] || null,
    quarterly_connects: connects.rows,
    pip_records: pips.rows,
    rating_history: ratingHistory.rows,
    consents: consents.rows,
    annual_review_parameter_scores: parameterScores.rows,
    midyear_pulse_checks: pulseChecks.rows,
  };
}

const router = express.Router();
router.use(authenticate, apiPermissionParity);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);

router.get('/export', async (req, res) => {
  try {
    const data = await buildExport(req.user.tenant_id, req.user.id);
    res.setHeader('Content-Disposition', 'attachment; filename="my-data-export.json"');
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/export/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const data = await buildExport(req.user.tenant_id, req.params.employeeId);
    if (!data) return res.status(404).json({ error: 'employee not found' });
    res.setHeader('Content-Disposition', `attachment; filename="data-export-${req.params.employeeId}.json"`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, buildExport };
