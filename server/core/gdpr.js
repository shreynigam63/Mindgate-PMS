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

// includeRestricted: HR-only material that is deliberately not shown to
// the employee in the product — today, the AI analysis of their annual
// review meeting (migration 031).
//
// "NOT VISIBLE IN THE APP" AND "NOT DISCLOSABLE" ARE DIFFERENT THINGS, and
// only the first was asked for. So the employee's own self-serve export
// leaves it out, matching the product decision, while HR's export of that
// employee includes it — which is what lets a formal subject access
// request be answered completely, by a person who knows what they are
// releasing, rather than either leaking automatically or being quietly
// impossible to fulfil.
async function buildExport(tenantId, employeeId, { includeRestricted = false } = {}) {
  const profile = (await db.query(
    `SELECT id, emp_code, name, email, department, designation, role_band, manager_id, date_of_joining, status,
            last_appraisal_rating, last_appraisal_at, potential_rating, nine_box_cell, super50_flag, super50_since
       FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!profile) return null;

  const [kraSheets, selfAppraisals, managerEvals, devPlans, careerPath, connects, pips, ratingHistory, consents, parameterScores, pulseChecks, meetings, aiRecs] = await Promise.all([
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
    // Review meetings and, where one was captured with their consent, the
    // TRANSCRIPT IN FULL. A recording of someone discussing their own
    // performance is about as personal as anything this system holds — a
    // subject access request that returned every rating but omitted the
    // conversation would not be a complete answer. Added with the table
    // (migration 027) rather than left for someone to notice later.
    db.query(`SELECT m.context, m.provider, m.meeting_url, m.scheduled_at, m.created_at,
                     t.content AS transcript, t.captured_at AS transcript_captured_at, t.consent_checked_at
                FROM pms.review_meetings m
                LEFT JOIN pms.meeting_transcripts t ON t.meeting_id = m.id
               WHERE m.tenant_id=$1 AND m.employee_id=$2
               ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC`, [tenantId, employeeId]),
    // AI recommendations kept ABOUT this person, with what was decided.
    // These are statements about someone's development that a manager can
    // read months later, so they belong in a subject access response.
    db.query(`SELECT kind, title, detail, status, decision_note, decided_at, created_at
                FROM agentic.recommendations
               WHERE tenant_id=$1 AND about_employee_id=$2 ORDER BY created_at DESC`, [tenantId, employeeId]),
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
    review_meetings: meetings.rows,
    ai_recommendations: aiRecs.rows,
    ...(includeRestricted ? { hr_only: await restrictedSections(tenantId, employeeId) } : {}),
  };
}

// Nested under hr_only rather than mixed in at the top level, so anyone
// looking at an export file can see at a glance which part of it is
// material the employee has never been shown in the product.
async function restrictedSections(tenantId, employeeId) {
  const analyses = await db.query(
    `SELECT a.cycle_id, c.name AS cycle_name, a.entries, a.overall, a.analysed_by, a.created_at, a.updated_at
       FROM pms.parameter_ai_analyses a JOIN pms.cycles c ON c.id = a.cycle_id
      WHERE a.tenant_id=$1 AND a.employee_id=$2 ORDER BY a.updated_at DESC`,
    [tenantId, employeeId]);
  return { annual_review_parameter_ai_analysis: analyses.rows };
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
    const data = await buildExport(req.user.tenant_id, req.params.employeeId, { includeRestricted: true });
    if (!data) return res.status(404).json({ error: 'employee not found' });
    res.setHeader('Content-Disposition', `attachment; filename="data-export-${req.params.employeeId}.json"`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, buildExport };
