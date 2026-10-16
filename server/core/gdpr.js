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
  // The 9-box box is never shown to the employee (the client's 9-box
  // specification: "employees do not see their box"), so their own
  // export leaves it out and HR's export carries it, under hr_only.
  const nineBox = { potential_rating: profile.potential_rating, nine_box_cell: profile.nine_box_cell };
  delete profile.potential_rating;
  delete profile.nine_box_cell;

  const [kraSheets, selfAppraisals, managerEvals, devPlans, careerPath, connects, pips, ratingHistory, consents, parameterScores, pulseChecks, meetings, aiRecs] = await Promise.all([
    db.query(`SELECT s.cycle_id, s.status, s.manager_comment, k.title, k.weight, k.measures FROM pms.kra_sheets s LEFT JOIN pms.kras k ON k.sheet_id=s.id WHERE s.tenant_id=$1 AND s.employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT cycle_id, status, entries, overall_self_rating, went_well, could_improve, submitted_at FROM pms.self_appraisals WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT cycle_id, status, overall_rating, strengths, improvement_areas, submitted_at FROM pms.manager_evaluations WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT p.cycle_id, p.status, p.manager_comment, g.title, g.progress_pct, g.target_date FROM pms.development_plans p LEFT JOIN pms.development_goals g ON g.plan_id=p.id WHERE p.tenant_id=$1 AND p.employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT horizon, target_role, plan, updated_at FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]),
    db.query(`SELECT held_at, topic, discussion_notes, notes, achievements, blockers, feedback, signed_off, meeting_based FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2 ORDER BY held_at DESC`, [tenantId, employeeId]),
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
    ...(includeRestricted ? { hr_only: { ...(await restrictedSections(tenantId, employeeId)), nine_box_current: nineBox } } : {}),
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
  const placements = await db.query(
    `SELECT p.cycle_id, c.name AS cycle_name, p.status, p.not_placed_reason, p.box_key, p.box_name,
            p.performance_score, p.competency_score, p.questions_score, p.potential_score, p.potential_partial,
            p.perf_band, p.pot_band, p.overrides, p.prev_box_key, p.movement, p.placed_at
       FROM pms.nine_box_placements p JOIN pms.cycles c ON c.id = p.cycle_id
      WHERE p.tenant_id=$1 AND p.employee_id=$2 ORDER BY p.placed_at DESC`, [tenantId, employeeId]);
  const potential = await db.query(
    `SELECT a.cycle_id, c.name AS cycle_name, a.answers, a.updated_at
       FROM pms.potential_answers a JOIN pms.cycles c ON c.id = a.cycle_id
      WHERE a.tenant_id=$1 AND a.employee_id=$2 ORDER BY a.updated_at DESC`, [tenantId, employeeId]);
  return { annual_review_parameter_ai_analysis: analyses.rows,
    nine_box_placements: placements.rows, potential_answers: potential.rows };
}

// The same export as a workbook a person can open (16 Oct, Def-013: the
// JSON file read as "a random file"; then, from the client: "not backend
// data or code"). Written for the person, not the database: names instead
// of ids (the cycle, the KRA, the manager), dates as dates, Yes / No,
// statuses in words, the per-KRA review as rows, and no internal keys,
// ids or JSON anywhere. Asked for with ?format=xlsx (the "Download all my
// data" button); without it the API keeps answering JSON.
const ID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const words = (v) => (v == null || v === '' ? '' : String(v).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));
const yesNo = (v) => (v == null ? '' : v ? 'Yes' : 'No');
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : Math.round(Number(v) * 100) / 100);
const day = (v) => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d;
};
// Free-form stored values (a plan, an AI analysis) as plain lines of text.
function text(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return ID_LIKE.test(String(v)) ? '' : String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join('\n');
  return Object.entries(v)
    .filter(([k, x]) => !/(^|_)id$/i.test(k) && !(typeof x === 'string' && ID_LIKE.test(x)) && x != null && x !== '')
    .map(([k, x]) => `${words(k)}: ${typeof x === 'object' ? text(x).replace(/\n/g, '; ') : x}`).join('\n');
}

async function lookupsFor(tenantId, data) {
  const cycles = new Map((await db.query(`SELECT id, name FROM pms.cycles WHERE tenant_id=$1`, [tenantId])).rows.map((r) => [r.id, r.name]));
  const kraIds = [...new Set((data.self_appraisals || []).flatMap((a) => Object.keys(a.entries || {})))].filter((k) => ID_LIKE.test(k));
  const kras = new Map(kraIds.length ? (await db.query(`SELECT id, title FROM pms.kras WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [tenantId, kraIds])).rows.map((r) => [r.id, r.title]) : []);
  const params = new Map((await db.query(`SELECT id, name FROM pms.review_parameters WHERE tenant_id=$1`, [tenantId])).rows.map((r) => [r.id, r.name]));
  const mgr = data.profile && data.profile.manager_id
    ? (await db.query(`SELECT name FROM core.employees WHERE id=$1 AND tenant_id=$2`, [data.profile.manager_id, tenantId])).rows[0] : null;
  return { cycle: (id) => cycles.get(id) || '', kra: (id) => kras.get(id) || 'A KRA no longer on the sheet',
    param: (id) => params.get(id) || '', manager: mgr ? mgr.name : '' };
}

async function exportWorkbook(data, tenantId) {
  const ExcelJS = require('exceljs');
  const L = await lookupsFor(tenantId, data);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Agentic PMS';
  const font = { name: 'Arial', size: 10 };
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name.slice(0, 31));
    ws.columns = columns.map(([header, key, width]) => ({ header, key, width: width || 18 }));
    if (rows.length) rows.forEach((r) => ws.addRow(r));
    else ws.addRow({ [columns[0][1]]: 'Nothing on record.' });
    ws.eachRow((row, i) => row.eachCell((c) => {
      c.font = i === 1 ? { ...font, bold: true } : font;
      c.alignment = { vertical: 'top', wrapText: true };
      if (c.value instanceof Date) c.numFmt = 'dd-mmm-yyyy';
    }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    return ws;
  };
  const p = data.profile || {};

  const about = wb.addWorksheet('About this file');
  about.columns = [{ key: 'a', width: 28 }, { key: 'b', width: 70 }];
  [['Personal data held about', p.name || ''], ['Exported on', day(data.exported_at)],
    ['What this is', 'Everything the Performance Management System keeps about you, one sheet per kind of record.'],
    ['Questions', 'Ask HR. They can also explain anything in this file.']].forEach((r) => about.addRow({ a: r[0], b: r[1] }));
  about.eachRow((row) => row.eachCell((c, col) => { c.font = col === 1 ? { ...font, bold: true } : font; c.alignment = { vertical: 'top', wrapText: true }; if (c.value instanceof Date) c.numFmt = 'dd-mmm-yyyy'; }));

  const profile = wb.addWorksheet('Profile');
  profile.columns = [{ header: 'Field', key: 'k', width: 28 }, { header: 'Value', key: 'v', width: 50 }];
  [['Employee code', p.emp_code], ['Name', p.name], ['Email', p.email], ['Department', p.department],
    ['Designation', p.designation], ['Band', p.role_band], ['Reports to', L.manager], ['Date of joining', day(p.date_of_joining)],
    ['Status', words(p.status)], ['Last appraisal rating', num(p.last_appraisal_rating)], ['Last appraisal on', day(p.last_appraisal_at)],
    ['Super 50', yesNo(p.super50_flag)], ['Super 50 since', day(p.super50_since)]]
    .forEach(([k, v]) => profile.addRow({ k, v: v == null ? '' : v }));
  profile.eachRow((row, i) => row.eachCell((c) => { c.font = i === 1 ? { ...font, bold: true } : font; c.alignment = { horizontal: 'left', vertical: 'top' }; if (c.value instanceof Date) c.numFmt = 'dd-mmm-yyyy'; }));
  about.pageSetup = profile.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  sheet('KRAs', [['Cycle', 'cycle', 22], ['Sheet status', 'status', 14], ['KRA', 'title', 40], ['Weight %', 'weight', 10],
    ['How it is measured', 'measures', 40], ["Manager's comment", 'comment', 40]],
  (data.kra_sheets || []).filter((r) => r.title).map((r) => ({ cycle: L.cycle(r.cycle_id), status: words(r.status), title: r.title,
    weight: num(r.weight), measures: r.measures || '', comment: r.manager_comment || '' })));

  sheet('Annual Review', [['Cycle', 'cycle', 22], ['Status', 'status', 14], ['Overall self-rating', 'overall', 16],
    ['What went well', 'well', 40], ['What could improve', 'improve', 40], ['Submitted on', 'at', 14]],
  (data.self_appraisals || []).map((a) => ({ cycle: L.cycle(a.cycle_id), status: words(a.status), overall: num(a.overall_self_rating),
    well: a.went_well || '', improve: a.could_improve || '', at: day(a.submitted_at) })));

  sheet('Annual Review by KRA', [['Cycle', 'cycle', 22], ['KRA', 'kra', 40], ['Your rating', 'rating', 12], ['What you wrote', 'note', 60]],
    (data.self_appraisals || []).flatMap((a) => Object.entries(a.entries || {}).map(([k, e]) => ({
      cycle: L.cycle(a.cycle_id), kra: L.kra(k), rating: num(e && e.self_rating),
      note: e ? text(Object.fromEntries(Object.entries(e).filter(([x]) => x !== 'self_rating'))).replace(/^Narrative: /, '') : '' }))));

  sheet('Manager evaluation', [['Cycle', 'cycle', 22], ['Status', 'status', 14], ['Overall rating', 'overall', 14],
    ['Strengths', 'strengths', 40], ['Areas to improve', 'areas', 40], ['Submitted on', 'at', 14]],
  (data.manager_evaluations || []).map((m) => ({ cycle: L.cycle(m.cycle_id), status: words(m.status), overall: num(m.overall_rating),
    strengths: m.strengths || '', areas: m.improvement_areas || '', at: day(m.submitted_at) })));

  sheet('Growth plan', [['Cycle', 'cycle', 22], ['Plan status', 'status', 14], ['Goal', 'goal', 40], ['Progress %', 'pct', 12],
    ['Target date', 'date', 14], ["Manager's comment", 'comment', 40]],
  (data.development_plans || []).filter((g) => g.title).map((g) => ({ cycle: L.cycle(g.cycle_id), status: words(g.status), goal: g.title,
    pct: num(g.progress_pct), date: day(g.target_date), comment: g.manager_comment || '' })));

  const cp = data.career_path;
  sheet('Career path', [['Horizon', 'horizon', 14], ['Target role', 'role', 30], ['Plan', 'plan', 60], ['Updated on', 'at', 14]],
    cp ? [{ horizon: words(cp.horizon), role: cp.target_role || '', plan: text(cp.plan), at: day(cp.updated_at) }] : []);

  sheet('Connects', [['Held on', 'at', 14], ['Topic', 'topic', 22], ['What was discussed', 'notes', 50], ['Achievements', 'ach', 30],
    ['Blockers', 'blk', 30], ['Feedback', 'fb', 30], ['Signed off', 'signed', 12], ['From a meeting', 'meeting', 14]],
  (data.quarterly_connects || []).map((c) => ({ at: day(c.held_at), topic: c.topic || '', notes: c.discussion_notes || c.notes || '',
    ach: c.achievements || '', blk: c.blockers || '', fb: c.feedback || '', signed: yesNo(c.signed_off), meeting: yesNo(c.meeting_based) })));

  sheet('Improvement plan', [['Status', 'status', 18], ['Plan', 'plan', 60], ['Opened on', 'opened', 14], ['Closed on', 'closed', 14], ['Why it closed', 'reason', 40]],
    (data.pip_records || []).map((r) => ({ status: words(r.status), plan: text(r.plan), opened: day(r.opened_at), closed: day(r.closed_at), reason: r.closed_reason || '' })));

  sheet('Ratings', [['Cycle', 'cycle', 24], ['Final rating', 'rating', 12], ['Grade', 'label', 16], ['Published on', 'at', 14]],
    (data.rating_history || []).map((h) => ({ cycle: h.cycle_name || L.cycle(h.cycle_id), rating: num(h.final_rating), label: h.rating_label || '', at: day(h.published_at) })));

  sheet('Consents', [['Consent', 'type', 30], ['Given', 'given', 10], ['Given on', 'at', 14], ['Withdrawn on', 'revoked', 14]],
    (data.consents || []).map((c) => ({ type: words(c.consent_type), given: yesNo(c.granted), at: day(c.granted_at), revoked: day(c.revoked_at) })));

  const scored = (rows) => rows.map((r) => ({ cycle: L.cycle(r.cycle_id), param: L.param(r.parameter_id), score: num(r.score), at: day(r.updated_at) }));
  const scoreCols = [['Cycle', 'cycle', 22], ['Parameter', 'param', 30], ['Score', 'score', 10], ['Updated on', 'at', 14]];
  if ((data.annual_review_parameter_scores || []).length) sheet('Parameter scores', scoreCols, scored(data.annual_review_parameter_scores));
  if ((data.midyear_pulse_checks || []).length) sheet('Pulse checks', scoreCols, scored(data.midyear_pulse_checks));

  sheet('Review meetings', [['When', 'at', 14], ['About', 'context', 16], ['Held on', 'provider', 16], ['Meeting link', 'url', 30], ['Transcript', 'transcript', 80]],
    (data.review_meetings || []).map((m) => ({ at: day(m.scheduled_at || m.created_at), context: words(m.context), provider: words(m.provider),
      url: m.meeting_url || '', transcript: m.transcript || '' })));

  sheet('AI suggestions', [['Kind', 'kind', 22], ['Title', 'title', 30], ['Detail', 'detail', 60], ['Status', 'status', 12],
    ['Decision note', 'note', 30], ['Decided on', 'decided', 14], ['Made on', 'at', 14]],
  (data.ai_recommendations || []).map((r) => ({ kind: words(r.kind), title: r.title || '', detail: text(r.detail), status: words(r.status),
    note: r.decision_note || '', decided: day(r.decided_at), at: day(r.created_at) })));

  // HR's export of someone carries what the employee is not shown in the
  // product, on sheets marked as such.
  const hr = data.hr_only;
  if (hr) {
    sheet('HR only - AI review analysis', [['Cycle', 'cycle', 22], ['Analysis', 'entries', 70], ['Overall', 'overall', 40], ['Updated on', 'at', 14]],
      (hr.annual_review_parameter_ai_analysis || []).map((a) => ({ cycle: a.cycle_name || L.cycle(a.cycle_id), entries: text(a.entries), overall: text(a.overall), at: day(a.updated_at || a.created_at) })));
    sheet('HR only - 9-box', [['Cycle', 'cycle', 22], ['Box', 'box', 24], ['Status', 'status', 14], ['Not placed because', 'why', 22],
      ['Performance', 'perf', 12], ['Competency', 'comp', 12], ['Potential questions', 'q', 12], ['Potential', 'pot', 12],
      ['Movement', 'move', 12], ['Placed on', 'at', 14]],
    (hr.nine_box_placements || []).map((b) => ({ cycle: b.cycle_name || L.cycle(b.cycle_id), box: b.box_name || '', status: words(b.status), why: words(b.not_placed_reason),
      perf: num(b.performance_score), comp: num(b.competency_score), q: num(b.questions_score), pot: num(b.potential_score),
      move: words(b.movement), at: day(b.placed_at) })));
    sheet('HR only - Potential answers', [['Cycle', 'cycle', 22], ['Question', 'q', 30], ['Answer (1-5)', 'a', 14], ['Updated on', 'at', 14]],
      (hr.potential_answers || []).flatMap((a) => Object.entries(a.answers || {}).map(([k, v]) => ({ cycle: a.cycle_name || L.cycle(a.cycle_id), q: words(k), a: num(v), at: day(a.updated_at) }))));
  }
  return wb;
}
async function sendExport(res, data, base, format, tenantId) {
  if (format !== 'xlsx') {
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    return res.json(data);
  }
  const wb = await exportWorkbook(data, tenantId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

const router = express.Router();
router.use(authenticate, apiPermissionParity);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);

router.get('/export', async (req, res) => {
  try {
    const data = await buildExport(req.user.tenant_id, req.user.id);
    await sendExport(res, data, 'my-data-export', req.query.format, req.user.tenant_id);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/export/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const data = await buildExport(req.user.tenant_id, req.params.employeeId, { includeRestricted: true });
    if (!data) return res.status(404).json({ error: 'employee not found' });
    // HR exporting their OWN record gets what any employee gets of their
    // box, which is nothing: nobody sees their own 9-box.
    if (String(req.params.employeeId).toLowerCase() === String(req.user.id).toLowerCase() && data.hr_only) {
      delete data.hr_only.nine_box_current;
      delete data.hr_only.nine_box_placements;
      delete data.hr_only.potential_answers;
    }
    await sendExport(res, data, `data-export-${String(data.profile.emp_code || data.profile.name || 'employee').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'employee'}`, req.query.format, req.user.tenant_id);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, buildExport, exportWorkbook };
