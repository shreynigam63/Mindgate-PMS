// Agentic module — the five §5A features. Pattern for every endpoint:
//   deterministic SQL builds the input → narrate() → draft stored + returned.
// Judgement stays human: nothing here writes to any pms table; drafts are
// text the manager/HR edits in the relevant screen.

const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { authenticate } = require('../../core/auth');
const { apiPermissionParity, hasPermission } = require('../../core/permissions');
const ai = require('../../core/ai');
// Cross-module read via the other module's EXPORTED interface, per the
// house rule that modules never import each other's internals. This is
// also what guarantees career suggestions stay inside the set the
// career-path form accepts — both resolve eligibility through it.
const { eligibleTransitionsFor, careerPathDiagnostics } = require('../people');

const router = express.Router();
router.use(authenticate, apiPermissionParity);
const T = (req) => req.user.tenant_id;
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

// ---------------------------------------------------------------------------
// House style for every AI draft in this module: SHORT BULLETS, GROUPED BY
// KRA. Requested after a mid-year draft came back as three dense
// paragraphs — accurate, but nobody reads a wall of text about their own
// half-year, and a manager copying it into an evaluation field has to
// unpick which sentence belongs to which KRA before they can edit it.
//
// The rules are stated as constraints the model can check itself against
// (a word count, a bullet count, an exact-title requirement) rather than
// adjectives like "concise", which every model already believes it is.
//
// EXACT TITLES matter beyond tidiness: grouping is only useful if the
// group names match the KRAs the employee actually has, and a paraphrased
// title silently detaches a bullet from the KRA it is about.
const KRA_BULLET_RULES = `FORMAT — a hard requirement, not a preference:
- Write BULLETS, never paragraphs. One idea per bullet.
- Each bullet is a single sentence of at most 18 words. Do not start it
  with a dash, a number or a bullet character — the UI adds those.
- Group every bullet under the KRA it concerns, naming that KRA by its
  EXACT title as given in the input. Never paraphrase a title, never
  invent a KRA, never merge two.
- At most 3 bullets per list. If you have nothing the input supports for
  a list, return it empty rather than padding it.
- Anything that genuinely spans KRAs goes in the cross-cutting section,
  not repeated under each KRA.
- Plain professional English: no "leveraged", "spearheaded" or "synergy",
  no praise the input does not support, no filler adjectives.`;

// The bullets, rendered as the plain text that goes into a form field.
//
// WHY THE SERVER RENDERS IT: these drafts feed a "copy into the field"
// button, and the field is a plain textarea. Composing that text here
// keeps one source of truth — the same grouping the panel shows is the
// grouping that lands in the box — instead of the screen and the server
// each having their own idea of what the draft said.
function renderKraBullets(byKra, key, crossCutting) {
  const blocks = [];
  for (const group of Array.isArray(byKra) ? byKra : []) {
    const points = Array.isArray(group && group[key]) ? group[key].filter((p) => String(p || '').trim()) : [];
    if (!points.length) continue;
    blocks.push(`${group.kra}\n${points.map((p) => `- ${String(p).trim()}`).join('\n')}`);
  }
  const cross = Array.isArray(crossCutting) ? crossCutting.filter((p) => String(p || '').trim()) : [];
  if (cross.length) blocks.push(`Across KRAs\n${cross.map((p) => `- ${String(p).trim()}`).join('\n')}`);
  return blocks.join('\n\n');
}

async function activeCycle(tenantId) {
  const r = await db.query(
    `SELECT * FROM pms.cycles WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled') ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  return r.rows[0] || null;
}

// Same reasoning as modules/performance/index.js's activeCycleForMidyear:
// prefer a cycle actually at/past mid_year_review over blind "most
// recently created," so the AI draft's KRA/connect lookups don't
// silently scope against the wrong cycle when several non-closed test
// cycles exist for one tenant.
async function activeCycleForMidyear(tenantId) {
  const passed = (await db.query(
    `SELECT * FROM pms.cycles WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled')
       AND phase = ANY($2::text[])
     ORDER BY (phase='mid_year_review') DESC, created_at DESC LIMIT 1`,
    [tenantId, ['mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval', 'calibration', 'publish']])).rows[0];
  if (passed) return passed;
  return activeCycle(tenantId);
}

// 1) Appraisal summary draft — for the MANAGER writing an evaluation.
// Input: the employee's KRAs + their self-appraisal narratives. Output:
// strengths / improvement-areas prose. Ratings are NEVER suggested — the
// system prompt forbids it AND stripRatingSuggestions enforces it.
router.post('/appraisal-draft', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const { employee_id } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const emp = (await db.query(`SELECT id, name, manager_id, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employee_id, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });

    const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, employee_id])).rows[0];
    const kras = sheet ? (await db.query(`SELECT id, title, weight, measures FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    const sa = (await db.query(`SELECT entries, went_well, could_improve, status FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, employee_id])).rows[0];

    const input = {
      employee: { name: emp.name, department: emp.department },
      cycle: c.name,
      kras: kras.map(k => ({ title: k.title, weight: +k.weight, measures: k.measures })),
      self_appraisal: sa ? { status: sa.status, per_kra: sa.entries, went_well: sa.went_well, could_improve: sa.could_improve } : null,
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'appraisal_draft', ref: { cycle_id: c.id, employee_id },
      // Bullets under every KRA need more room than the two paragraphs
      // this used to return.
      requestedBy: req.user.email, input, maxTokens: 1600,
      system: `You draft the WRITTEN portions of a manager's performance evaluation from the
employee's KRAs and self-appraisal. You never suggest, imply, or hint at a
numeric rating — judgement is the manager's alone; if the self-appraisal
contains self-ratings, ignore the numbers and use only the narratives.
Ground every bullet in the input; invent nothing. If the self-appraisal is
missing or unsubmitted, say so in gaps and draft only from the KRAs.

${KRA_BULLET_RULES}

Respond ONLY with JSON:
{"by_kra":[{"kra":"exact KRA title","strengths":["..."],"improvement_areas":["..."]}],
 "cross_cutting":{"strengths":["..."],"improvement_areas":["..."]},
 "evidence_notes":["short pointers the manager may verify"],
 "gaps":["anything the input lacked"]}`,
    });
    // The two textareas this feeds want text, not JSON — rendered here so
    // the box gets exactly the grouping the panel shows.
    const d = out.draft || {};
    const cross = d.cross_cutting || {};
    res.json({
      ok: true,
      ...out,
      draft: {
        ...d,
        strengths: renderKraBullets(d.by_kra, 'strengths', cross.strengths),
        improvement_areas: renderKraBullets(d.by_kra, 'improvement_areas', cross.improvement_areas),
      },
      note: 'Draft only — edit before use; ratings are yours to decide.',
    });
  } catch (e) { fail(res, e); }
});

// 1b) Mid-Year Review draft — per a reference screenshot: "Reads the KRAs
// and every 1-on-1 connect logged this cycle, then writes a balanced
// progress summary you can edit before submitting." Works for EITHER
// perspective: the employee drafting their own reflection (self-service,
// no special permission — matches how connect-extract works), or the
// manager drafting their narrative about a report (pms_team_eval +
// ownership, same as appraisal-draft above). Never suggests a rating,
// same rule as every other draft feature here.
router.post('/midyear-draft', async (req, res) => {
  try {
    const { employee_id, perspective } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    if (!['self', 'manager'].includes(perspective)) return res.status(400).json({ error: "perspective must be 'self' or 'manager'" });
    const isSelf = perspective === 'self' && employee_id === req.user.id;
    if (!isSelf) {
      if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    }
    const emp = (await db.query(`SELECT id, name, manager_id, department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employee_id, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (!isSelf && emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });

    const c = await activeCycleForMidyear(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, employee_id])).rows[0];
    const kras = sheet ? (await db.query(`SELECT title, weight, measures FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    const connects = (await db.query(
      `SELECT held_at, COALESCE(discussion_notes, notes) AS discussion, achievements, blockers, feedback FROM pms.connects
        WHERE tenant_id=$1 AND employee_id=$2 AND held_at >= COALESCE($3, held_at) ORDER BY held_at DESC LIMIT 8`,
      [T(req), employee_id, c.opens_at || null])).rows;
    const checkin = (await db.query(`SELECT self_narrative, self_status FROM pms.midyear_checkins WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [T(req), c.id, employee_id])).rows[0];

    const input = {
      employee: emp.name, perspective,
      kras: kras.map((k) => ({ title: k.title, weight: +k.weight, measures: k.measures })),
      connects_this_cycle: connects,
      employee_self_reflection: perspective === 'manager' && checkin && checkin.self_status === 'submitted' ? checkin.self_narrative : null,
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'midyear_draft', ref: { cycle_id: c.id, employee_id },
      // Per-KRA bullets across three sections need far more room than the
      // 2-4 sentence narrative this used to produce: eight KRAs is
      // realistic, and a truncated draft is a draft nobody can use.
      requestedBy: req.user.email, input, maxTokens: 1600,
      system: `${perspective === 'self'
        ? `You draft an EMPLOYEE's own mid-year reflection, in first person ("I"), from their KRAs
and their own logged 1-on-1 connects this cycle. Ground everything in the input; invent
nothing. Never suggest or imply a rating.`
        : `You draft a MANAGER's mid-year narrative about ONE employee, from their KRAs, the
manager's own logged 1-on-1 connects this cycle, and (if available) the employee's own
submitted self-reflection. Ground everything in the input; invent nothing. Never suggest or
imply a numeric rating — judgement is the manager's alone.`}

${KRA_BULLET_RULES}

Respond ONLY with JSON:
{"by_kra":[{"kra":"exact KRA title","progress":["..."],"blockers":["..."],"focus_next":["..."]}],
 "cross_cutting":{"progress":["..."],"blockers":["..."],"focus_next":["..."]},
 "gaps":["anything the input lacked"]}`,
    });
    // Same bug as connect-insights/connect-autotag, fixed the same way:
    // ai.narrate() returns { id, created_at, draft } — the actual output
    // is under .draft. MidYearReviewPage.jsx reads the fields at the top
    // level, so spreading out.draft is what actually matches it.
    //
    // narrative is composed from the same bullets the panel renders,
    // because the "use this draft" button writes it into a plain textarea.
    const d = out.draft || {};
    const cross = d.cross_cutting || {};
    const sections = [
      ['Progress', renderKraBullets(d.by_kra, 'progress', cross.progress)],
      ['Blockers', renderKraBullets(d.by_kra, 'blockers', cross.blockers)],
      ['Focus for the next half', renderKraBullets(d.by_kra, 'focus_next', cross.focus_next)],
    ].filter(([, body]) => body);
    res.json({
      ok: true,
      ...d,
      narrative: sections.map(([h, body]) => `${h}\n${body}`).join('\n\n'),
    });
  } catch (e) { fail(res, e); }
});

// 2) Calibration brief — before the session. Input: distribution vs bell
// curve, unrated count, largest department deviations, adjustment history.
router.post('/calibration-brief', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const rows = (await db.query(
      `SELECT e.department,
              COALESCE(adj.to_rating, he.overall_rating, me.overall_rating) AS proposed
         FROM core.employees e
         JOIN pms.manager_evaluations me ON me.cycle_id=$1 AND me.employee_id=e.id AND me.status='submitted'
         LEFT JOIN pms.hod_evaluations he ON he.cycle_id=$1 AND he.employee_id=e.id AND he.status='submitted'
         LEFT JOIN LATERAL (SELECT to_rating FROM pms.rating_adjustments ra
                             WHERE ra.cycle_id=$1 AND ra.employee_id=e.id ORDER BY at DESC LIMIT 1) adj ON true
        WHERE e.tenant_id=$2`, [c.id, T(req)])).rows;
    const dist = {}; const byDept = {};
    for (const r of rows) {
      const k = r.proposed == null ? 'unrated' : String(Math.round(r.proposed));
      dist[k] = (dist[k] || 0) + 1;
      const d = r.department || 'Unassigned';
      byDept[d] = byDept[d] || { total: 0, dist: {} };
      byDept[d].total++; byDept[d].dist[k] = (byDept[d].dist[k] || 0) + 1;
    }
    const adjustments = (await db.query(
      `SELECT COUNT(*)::int AS n FROM pms.rating_adjustments WHERE cycle_id=$1`, [c.id])).rows[0];
    const input = { cycle: c.name, evaluated: rows.length, bell_curve_targets_pct: c.bell_curve,
      distribution_counts: dist, by_department: byDept, adjustments_so_far: adjustments.n };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'calibration_brief', ref: { cycle_id: c.id },
      requestedBy: req.user.email, input, maxTokens: 1200,
      system: `You write the pre-read for a rating calibration session. All numbers are in the
input; never compute new ones or propose target ratings for individuals.
Compare the distribution to the bell-curve targets, name departments that
deviate most, flag the unrated count as work outstanding, and list 3-5
concrete discussion points. Honest tone, no filler.
Respond ONLY with JSON:
{"headline":"one sentence","deviations":["..."],"discussion_points":["..."],"outstanding":"unrated/missing work in one sentence","caveats":["data limitations if any"]}`,
    });
    res.json({ ok: true, ...out, deterministic: input });
  } catch (e) { fail(res, e); }
});

// 3) Engagement themes — verbatims only, NO identity in reach (the query
// touches answers alone; anonymity is preserved by construction).
router.post('/engagement-themes', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const { survey_id } = req.body || {};
    if (!survey_id) return res.status(400).json({ error: 'survey_id required' });
    const s = (await db.query(`SELECT id, title, survey_type FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [survey_id, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'survey not found' });
    const verbatims = (await db.query(
      `SELECT q.prompt, a.value_text
         FROM engagement.answers a JOIN engagement.questions q ON q.id=a.question_id
        WHERE q.survey_id=$1 AND a.value_text IS NOT NULL AND length(trim(a.value_text)) > 0
        LIMIT 500`, [s.id])).rows;
    if (!verbatims.length) return res.status(422).json({ error: 'No text answers to theme' });
    const input = { survey: s.title, type: s.survey_type, verbatim_count: verbatims.length,
      verbatims: verbatims.map(v => ({ question: v.prompt, text: v.value_text.slice(0, 500) })) };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'engagement_themes', ref: { survey_id: s.id },
      requestedBy: req.user.email, input, maxTokens: 1600,
      system: `You cluster anonymous survey verbatims into themes for HR. The input contains
no identities and you must not speculate about who wrote anything or single
out text that could identify a person (a role+event combination, a unique
complaint). Quote at most one short representative fragment per theme.
Respond ONLY with JSON:
{"themes":[{"name":"...","prevalence":"rough share of verbatims","summary":"one sentence, at most 20 words","representative_quote":"short fragment or null"}],"tensions":["where feedback disagrees with itself"],"suggested_followups":["..."]}`,
    });
    res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

// 4) Closure letter draft — final rating + cycle facts into letter prose.
router.post('/letter-draft', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'letters_admin'))) return res.status(403).json({ error: "Requires 'letters_admin'" });
    const { employee_id, cycle_id } = req.body || {};
    if (!employee_id || !cycle_id) return res.status(400).json({ error: 'employee_id and cycle_id required' });
    const h = (await db.query(
      `SELECT h.final_rating, h.rating_label, c.name AS cycle_name, c.fiscal_year, e.name AS employee_name, e.designation
         FROM pms.employee_performance_history h
         JOIN pms.cycles c ON c.id=h.cycle_id JOIN core.employees e ON e.id=h.employee_id
        WHERE h.tenant_id=$1 AND h.employee_id=$2 AND h.cycle_id=$3`, [T(req), employee_id, cycle_id])).rows[0];
    if (!h) return res.status(404).json({ error: 'No published rating for this employee/cycle — publish first' });
    const input = { employee: h.employee_name, designation: h.designation, cycle: h.cycle_name,
      fiscal_year: h.fiscal_year, final_rating: +h.final_rating, rating_label: h.rating_label };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'letter_draft', ref: { cycle_id, employee_id },
      requestedBy: req.user.email, input, maxTokens: 900,
      system: `You draft the body of a performance-cycle closure letter. Use EXACTLY the
rating and label in the input — never soften, restate, or reinterpret them.
Professional, warm where the rating supports it, plain where it does not.
No company name or signatory — the template adds those.
Respond ONLY with JSON: {"salutation":"...","body_paragraphs":["...","..."],"closing_line":"..."}`,
    });
    res.json({ ok: true, ...out, note: 'Draft for the branded template — HR reviews before generation.' });
  } catch (e) { fail(res, e); }
});

// 5) Cycle health — completion coverage per stage, narrated into a chase plan.
router.post('/cycle-health', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const cov = (await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM core.employees WHERE tenant_id=$2 AND status='active') AS headcount,
         (SELECT COUNT(*)::int FROM pms.kra_sheets WHERE cycle_id=$1 AND status='approved') AS kra_approved,
         (SELECT COUNT(*)::int FROM pms.kra_sheets WHERE cycle_id=$1 AND status='submitted') AS kra_awaiting_manager,
         (SELECT COUNT(*)::int FROM pms.self_appraisals WHERE cycle_id=$1 AND status='submitted') AS self_submitted,
         (SELECT COUNT(*)::int FROM pms.manager_evaluations WHERE cycle_id=$1 AND status='submitted') AS manager_done,
         (SELECT COUNT(*)::int FROM pms.hod_evaluations WHERE cycle_id=$1 AND status='submitted') AS hod_done`,
      [c.id, T(req)])).rows[0];
    const lag = (await db.query(
      `SELECT e.department, COUNT(*)::int AS missing
         FROM core.employees e
        WHERE e.tenant_id=$2 AND e.status='active'
          AND NOT EXISTS (SELECT 1 FROM pms.self_appraisals sa WHERE sa.cycle_id=$1 AND sa.employee_id=e.id AND sa.status='submitted')
        GROUP BY e.department ORDER BY missing DESC LIMIT 5`, [c.id, T(req)])).rows;
    const input = { cycle: c.name, phase: c.phase, coverage: cov, self_appraisal_missing_by_department: lag };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'cycle_health', ref: { cycle_id: c.id },
      requestedBy: req.user.email, input, maxTokens: 1000,
      system: `You narrate an appraisal cycle's completion state for HR. All counts are in
the input; never recompute or estimate. Say where the cycle stands for its
phase, which stage is the bottleneck, which departments to chase this week,
and what unblocks the next phase transition.
Respond ONLY with JSON:
{"headline":"...","bottleneck":"...","chase_this_week":["dept or group: action"],"next_phase_blockers":["..."],"caveats":["..."]}`,
    });
    res.json({ ok: true, ...out, deterministic: input });
  } catch (e) { fail(res, e); }
});

// Stored drafts (provenance): list by kind/ref.
router.get('/drafts', async (req, res) => {
  try {
    await ai.ensureTable();
    const { kind } = req.query;
    const r = await db.query(
      `SELECT id, kind, ref, output, model, requested_by, created_at
         FROM agentic.drafts WHERE tenant_id=$1 ${kind ? 'AND kind=$2' : ''}
        ORDER BY created_at DESC LIMIT 25`, kind ? [T(req), kind] : [T(req)]);
    res.json({ drafts: r.rows, ai_enabled: ai.aiEnabled() });
  } catch (e) { fail(res, e); }
});

// 6) Connect insights — BR-4.2: "The system summarises recurring themes,
// sentiment and follow-up actions from logged conversations and links
// them to the employee's KRAs." FOUND MISSING during a full BRD
// re-audit, 28-Aug-2026 — a similarly-named engagement_themes feature
// existed for anonymous SURVEY verbatims (#3 above), but nothing summarised
// an individual employee's own 1-on-1 CONNECT notes, which is a distinct
// requirement (attributed to a specific employee, not anonymous, and
// explicitly links back to KRA ids already stored per connect).
//
// UPDATED per a reference screenshot: now also derives a one-line
// "headline" verdict on the employee's overall progress/performance and a
// short status label (e.g. "Concerned", "On Track", "Excelling") — not
// just recurring themes. Achievements/Blockers/Feedback (migration 014)
// are now included in the input alongside the discussion narrative, since
// those are exactly the signal a progress/performance read should draw
// on, not just the free-text discussion.
// UPDATED again: reworked after a live report — with only ONE connect
// logged, the panel came back with themes/follow-ups both empty AND no
// headline or status at all. Root cause was in the wording, not the
// code: the prompt asked for "recurring" themes specifically, which
// reasonably led the model to treat a single connect as "nothing
// recurring yet" — including for headline/status, which were never
// meant to depend on having multiple connects in the first place. A
// reference screenshot confirmed the expected behaviour: a full panel
// (headline, status, real themes, real follow-ups) from ONE connect's
// own content. Fixed by rewording the prompt only — same input shape,
// same output JSON schema, no route or schema change, so there was
// nothing to risk in the surrounding code.
router.post('/connect-insights', async (req, res) => {
  try {
    const { employee_id } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const isSelf = employee_id === req.user.id;
    if (!isSelf && !(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const emp = (await db.query(`SELECT id, name, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employee_id, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (!isSelf && emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const connects = (await db.query(
      `SELECT cn.held_at, COALESCE(cn.discussion_notes, cn.notes) AS notes, cn.achievements, cn.blockers, cn.feedback, cn.kra_ids
         FROM pms.connects cn
        WHERE cn.tenant_id=$1 AND cn.employee_id=$2
          AND (COALESCE(cn.discussion_notes, cn.notes, '') <> '' OR cn.achievements IS NOT NULL OR cn.blockers IS NOT NULL OR cn.feedback IS NOT NULL)
        ORDER BY cn.held_at DESC LIMIT 8`, [T(req), employee_id])).rows;
    if (!connects.length) return res.status(422).json({ error: 'No logged connects with notes to summarise yet' });
    const kraIds = [...new Set(connects.flatMap((c) => c.kra_ids || []))];
    const kras = kraIds.length ? (await db.query(`SELECT id, title FROM pms.kras WHERE id = ANY($1::uuid[])`, [kraIds])).rows : [];
    const kraTitle = Object.fromEntries(kras.map((k) => [k.id, k.title]));
    const input = {
      employee: emp.name, connects_summarised: connects.length,
      connects: connects.map((c) => ({
        held_at: c.held_at, discussion: c.notes, achievements: c.achievements, blockers: c.blockers, feedback: c.feedback,
        linked_kras: (c.kra_ids || []).map((id) => kraTitle[id]).filter(Boolean),
      })),
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'connect_insights', ref: { employee_id },
      requestedBy: req.user.email, input, maxTokens: 700,
      system: `You read a manager's own logged 1-on-1 notes about ONE employee across recent
Quarterly Connects (discussion narrative, plus any logged achievements/blockers/feedback) and
produce a read on their overall progress and performance this cycle, not just a list of topics.

You ALWAYS produce a headline, a status, at least one theme, and at least one follow-up —
this works from a SINGLE connect just as well as several. With only one connect
(connects_summarised = 1), derive every theme directly from THAT connect's own achievements/
blockers/feedback/discussion — do not wait for a pattern to repeat, and do not describe
anything as "recurring" or say there's nothing to report. Only use "recurring" language for a
theme once it genuinely appears across more than one connect in the input.

Keep everything SHORT — this is a glance-able panel, not a report. Headline: one short
sentence, under 20 words. Each theme's summary: one short sentence, under 20 words, not a
paragraph. Each follow-up: a short actionable phrase, under 15 words, not a full sentence with
justification. 2-4 themes and 2-4 follow-ups is enough; do not pad to fill space.

Ground everything in the input; invent nothing not implied by it. Never suggest or imply a
numeric rating — "status" is a qualitative read (e.g. "On Track", "Concerned", "Excelling",
"At Risk"), not a score.
Respond ONLY with JSON:
{"headline":"one sentence verdict on their progress/performance this cycle","status":"On Track|Concerned|Excelling|At Risk",
"themes":[{"name":"...","summary":"one short sentence, under 20 words","related_kra":"KRA title or null"}],
"suggested_followups":["..."]}`,
    });
    // Bug found live: ai.narrate() returns {id, created_at, draft} — the
    // model's actual JSON output is nested under `draft`, not spread at
    // the top level. `{ ok: true, ...out }` was putting id/created_at
    // into the response and leaving headline/status/themes/
    // suggested_followups all undefined — exactly the reported symptom
    // (blank panel), regardless of how good the prompt was. Fixed by
    // spreading out.draft instead of out itself.
    res.json({ ok: true, ...out.draft });
  } catch (e) { fail(res, e); }
});

// 7) Connect extract — was called from the "Log a connect" form to
// auto-derive Achievements/Blockers/Feedback from the discussion text.
// Per a direct follow-up request, Achievements/Blockers/Feedback are back
// to plain open boxes on that form (no button/gating needed to use them),
// and progress/performance derivation now happens via /connect-insights
// above instead, on already-logged connects. Left in place, working and
// tested, rather than deleted — it may still be useful wired up elsewhere,
// and there's no cost to keeping a correct, unused endpoint.
// Input is the raw "What was discussed?" text for ONE connect (not yet
// saved) plus optional Topic for context; output is a draft split into
// the three fields — same "draft, human decides" pattern as every other
// AI feature here. Does not read or write pms.connects at all.
router.post('/connect-extract', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const { discussion_notes, topic } = req.body || {};
    if (!discussion_notes || !String(discussion_notes).trim()) return res.status(400).json({ error: 'discussion_notes required' });
    const input = { topic: topic || null, discussion_notes: String(discussion_notes).trim() };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'connect_extract', ref: {},
      requestedBy: req.user.email, input, maxTokens: 600,
      system: `You split a manager's raw notes from a 1-on-1 conversation with an employee into
three categories: what the employee achieved or did well (Achievements), anything
stuck or needing help (Blockers), and coaching or direction the manager gave
(Feedback). Ground every sentence in the input; invent nothing not implied by the
notes. If the notes don't clearly cover one of the three categories, return an
empty string for it rather than guessing or padding.
Respond ONLY with JSON:
{"achievements":"...","blockers":"...","feedback":"..."}`,
    });
    res.json({ ok: true, draft: out });
  } catch (e) { fail(res, e); }
});

// "AI auto-tag KRAs" — requested with a reference screenshot: read a
// SAVED connect's discussion/achievements/blockers/feedback and suggest
// which of the employee's KRAs it relates to, rather than requiring the
// manager to pick manually every time. Never saves anything itself —
// returns suggested_kra_ids for the person to review and apply via the
// existing PUT /pms/connects/:id, same "draft, human decides" pattern as
// every other AI feature here. Manager (the connect's own) or admin only.
router.post('/connect-autotag', async (req, res) => {
  try {
    const { connect_id } = req.body || {};
    if (!connect_id) return res.status(400).json({ error: 'connect_id required' });
    const cn = (await db.query(`SELECT * FROM pms.connects WHERE id=$1 AND tenant_id=$2`, [connect_id, T(req)])).rows[0];
    if (!cn) return res.status(404).json({ error: 'connect not found' });
    // Widened per a direct follow-up: an employee should be able to
    // auto-tag KRAs on a connect that's about THEM, regardless of who
    // logged it — not manager-only, matching how self-view already works
    // for connect-insights above.
    if (cn.manager_id !== req.user.id && cn.employee_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: 'Not your connect' });
    }

    const c = await activeCycle(T(req));
    const sheet = c ? (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, cn.employee_id])).rows[0] : null;
    const kras = sheet ? (await db.query(`SELECT id, title FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    if (!kras.length) return res.status(422).json({ error: 'This employee has no KRAs to tag against this cycle.' });

    const input = {
      kras: kras.map((k) => ({ id: k.id, title: k.title })),
      topic: cn.topic || null,
      discussion: cn.discussion_notes || cn.notes || null,
      achievements: cn.achievements || null,
      blockers: cn.blockers || null,
      feedback: cn.feedback || null,
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'connect_autotag', ref: { connect_id },
      requestedBy: req.user.email, input, maxTokens: 400,
      system: `You are given a list of an employee's KRAs (each with an id and title) and the content of one
logged 1-on-1 connect (topic, discussion, achievements, blockers, feedback). Decide which of the
listed KRAs (by id) this connect is actually about — usually 0-3 of them. Only include a KRA
whose title is genuinely reflected in the connect's content; do not include one just because it
exists. If none of the KRAs are clearly relevant, return an empty list rather than guessing.
Respond ONLY with JSON: {"suggested_kra_ids":["..."],"reasoning":"one sentence"}`,
    });
    // Same bug as connect-insights above: the AI's actual output is at
    // out.draft.suggested_kra_ids, not out.suggested_kra_ids — reading it
    // at the wrong level meant Array.isArray(undefined) was always
    // false, so `suggested` was always [], regardless of what the model
    // actually returned. This is exactly why the auto-tag suggestion
    // never had anything pre-selected to save.
    const validIds = new Set(kras.map((k) => k.id));
    const suggested = Array.isArray(out.draft.suggested_kra_ids) ? out.draft.suggested_kra_ids.filter((id) => validIds.has(id)) : [];
    res.json({ ok: true, suggested_kra_ids: suggested, reasoning: out.draft.reasoning || null, kras });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// 10) Development-plan suggestions — for the EMPLOYEE, from their own KRAs.
//
// Self-service, no special permission, same posture as connect-extract: an
// employee asking for help shaping their own development plan is not a
// privileged action. Scoped to req.user.id throughout, so it can only ever
// read the caller's own KRAs.
//
// Sequencing works out for free: the development plan only becomes
// editable in growth_planning, which is AFTER kra_open closes, so the
// KRAs read here are already manager-approved and locked. The suggestions
// are therefore grounded in commitments that will not shift underneath
// the plan they inform.
router.post('/devplan-suggest', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const emp = (await db.query(
      `SELECT id, name, department, designation, role_band FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.user.id, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee record not found' });

    const sheet = (await db.query(
      `SELECT id, status FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, req.user.id])).rows[0];
    const kras = sheet ? (await db.query(
      `SELECT title, weight, measures, description FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`,
      [sheet.id])).rows : [];
    if (!kras.length) return res.status(409).json({ error: 'No KRAs are mapped to you for this cycle yet — a development plan drawn from nothing would be guesswork.' });

    const plan = (await db.query(
      `SELECT id, status FROM pms.development_plans WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, req.user.id])).rows[0];
    const existing = plan ? (await db.query(
      `SELECT title, description, target_date FROM pms.development_goals WHERE plan_id=$1 ORDER BY sort_order`,
      [plan.id])).rows : [];

    const input = {
      employee: { name: emp.name, department: emp.department, designation: emp.designation, role_band: emp.role_band },
      cycle: c.name,
      kra_sheet_status: sheet ? sheet.status : null,
      kras: kras.map((k) => ({ title: k.title, weight: +k.weight, measures: k.measures, description: k.description })),
      existing_goals: existing.map((g) => ({ title: g.title, description: g.description, target_date: g.target_date })),
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'devplan_suggest', ref: { cycle_id: c.id, employee_id: req.user.id },
      requestedBy: req.user.email, input, maxTokens: 1400,
      system: `You help an employee shape their own Individual Development Plan from the
KRAs they are accountable for this cycle. A development goal is about
building the CAPABILITY needed to deliver a KRA — a skill, a habit, an
exposure — never a restatement of the KRA itself.
Tie each suggestion to the KRA it serves by that KRA's exact title, and
weight your attention by KRA weight: the heaviest KRAs deserve the most
development thought. Where a goal already exists that covers a KRA, say so
instead of duplicating it, and note any KRA left with no development
coverage at all.
You never suggest, imply or hint at a rating or score of any kind — this
is planning, not assessment. Ground every sentence in the input; invent no
KRAs, courses, certifications or internal programme names. Prefer goals
the employee can act on without budget approval.
Respond ONLY with JSON:
{"suggested_goals":[{"title":"short, action-shaped","serves_kra":"exact KRA title","why":"1-2 sentences","how_to_measure":"observable evidence of progress","suggested_timeline":"e.g. by end of Q3"}],
 "already_covered":["existing goals that adequately cover a KRA"],
 "uncovered_kras":["KRA titles with no development goal against them"],
 "gaps":["anything the input lacked that you would have wanted"]}`,
    });
    res.json({ ok: true, ...out, note: 'Suggestions only — edit before adding to your plan.' });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// 11) Aspiring-career suggestions — for the EMPLOYEE, from their current
// designation, department and the transitions HR has actually configured.
//
// GROUNDED, NOT INVENTED: the target-role field only accepts roles present
// in people.career_transitions for the employee's current role, and it
// says so in the UI. An AI free-associating job titles would produce
// aspirations the form then rejects — advice the employee cannot act on.
// So the eligible set is resolved through the people module's exported
// eligibleTransitionsFor() (the same function the form's own validation
// uses) and handed to the model as a closed list it must choose from.
// The competencies and typical timelines come from that matrix too, so
// every number in the output is HR's, not the model's.
router.post('/career-suggest', async (req, res) => {
  try {
    const emp = (await db.query(
      `SELECT id, name, department, designation, role_band, date_of_joining FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.user.id, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee record not found' });
    if (!emp.designation) return res.status(409).json({ error: 'Your designation is not set — ask HR to complete your record before asking for career suggestions.' });

    const transitions = await eligibleTransitionsFor(T(req), req.user.id);
    // Why the list is empty, when it is. Previously the model was handed a
    // bare empty array and — correctly, given that input — told the
    // employee no path was configured. That was FALSE whenever a
    // transition existed and had merely been excluded on level, and it
    // sent HR hunting for a row that was already there. The model can only
    // be as accurate as its input, so the input now carries the reason.
    const diagnostics = transitions.length ? null : await careerPathDiagnostics(T(req), req.user.id);
    const current = (await db.query(
      `SELECT target_role, target_timeline, plan FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`,
      [T(req), req.user.id])).rows[0];

    const input = {
      employee: { name: emp.name, designation: emp.designation, department: emp.department, role_band: emp.role_band, joined: emp.date_of_joining },
      current_aspiration: current || null,
      // The closed list. Empty means HR has configured no ladder from this
      // role — reported as such rather than filled in by the model.
      configured_transitions: transitions.map((t) => ({
        to_role: t.to_role, to_level: t.to_level,
        typical_time_months: t.typical_time_months,
        required_competencies: t.required_competencies || [],
      })),
      // Present only when configured_transitions is empty. reason is one
      // of: none_configured | level_mismatch | all_inactive | no_designation
      why_no_transitions: diagnostics,
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'career_suggest', ref: { employee_id: req.user.id },
      requestedBy: req.user.email, input, maxTokens: 1400,
      system: `You help an employee think about the role they might aspire to over the
next one to two years, given their current designation and department.
HARD CONSTRAINT: you may only propose roles that appear in
configured_transitions. That list is the organisation's own career
pathing matrix and the form will reject anything outside it. Never invent
a role, a level or a timeline.

When configured_transitions is empty, why_no_transitions says why, and
you must report THAT reason rather than assuming nothing exists:
- none_configured: no path has been defined from this role yet; HR needs
  to add one to the Career Pathing Matrix.
- level_mismatch: a path IS configured from this role, but it is
  restricted to a level that does not match this employee's role band.
  Say so explicitly, quote the required level and the employee's actual
  role_band from the input, and say HR should either clear the level on
  that transition (blank means any level) or correct the employee's role
  band. Do NOT say nothing is configured — it is, and saying otherwise
  sends people looking for the wrong thing.
- all_inactive: the path exists but every transition from this role is
  deactivated; HR can reactivate it.
- no_designation: the employee has no designation on their record, so
  nothing can be matched until HR sets it.
Use the matrix's own typical_time_months and required_competencies rather
than estimating your own. You never suggest, imply or hint at a
performance rating or score, and you never promise a promotion — you are
describing what an aspiration would require, not what will happen.
Respond ONLY with JSON:
{"aspirations":[{"target_role":"exactly as given in configured_transitions","fit":"1-2 sentences on why this follows from their current role and department","typical_time":"from the matrix, or null","competencies_to_build":["from the matrix, phrased as something to work on"],"first_steps":["what to start this cycle"]}],
 "no_path_configured":true or false,
 "notes":["anything the employee should discuss with their manager or HR"]}`,
    });
    res.json({ ok: true, ...out, note: 'Suggestions only — limited to the transitions HR has configured from your current role.' });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// 12) Justification review — reads what was written against a per-KRA
// mid-year rating and says whether it stands up.
//
// This is a WRITING critique, not a second opinion on the rating. The
// house rule is deterministic numbers, AI narrates: the model is told the
// rating only so it can judge whether the words support it, and it is
// forbidden from endorsing, disputing or proposing one. Output keys are
// named assessment / evidence_strength deliberately — core/ai.js's
// stripRatingSuggestions() silently DELETES any key called rating, score
// or overall_rating, so a field named `score` here would vanish from the
// response with no error at all.
//
// PRIVACY: for perspective 'self' the manager's narrative is NOT included
// in the input. At mid-year the manager may not have signed off yet, and
// feeding their in-progress assessment into the employee's own review
// tool would leak it. The manager's own request does receive the
// employee's self entry, which is the normal asymmetry of a checkpoint
// review and what makes the critique useful to them.
router.post('/justification-review', async (req, res) => {
  try {
    const { kra_id, perspective, employee_id } = req.body || {};
    if (!kra_id) return res.status(400).json({ error: 'kra_id required' });
    if (!['self', 'manager'].includes(perspective)) return res.status(400).json({ error: "perspective must be 'self' or 'manager'" });

    const c = await activeCycleForMidyear(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });

    let targetId = req.user.id;
    if (perspective === 'manager') {
      if (!employee_id) return res.status(400).json({ error: 'employee_id required for the manager perspective' });
      const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employee_id, T(req)])).rows[0];
      if (!emp) return res.status(404).json({ error: 'employee not found' });
      if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
      if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
      targetId = emp.id;
    }

    const row = (await db.query(
      `SELECT self_entries, manager_entries FROM pms.midyear_checkins WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, targetId])).rows[0];
    if (!row) return res.status(404).json({ error: 'no mid-year check-in yet — open the review first' });

    const sheet = (await db.query(
      `SELECT id FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, targetId])).rows[0];
    const kra = sheet ? (await db.query(
      `SELECT id, title, weight, measures, description FROM pms.kras WHERE id=$1 AND sheet_id=$2`,
      [kra_id, sheet.id])).rows[0] : null;
    if (!kra) return res.status(404).json({ error: 'KRA not found on this employee\'s sheet for this cycle' });

    const mine = (perspective === 'self' ? row.self_entries : row.manager_entries) || {};
    const entry = mine[kra_id] || {};
    if (!entry.narrative || !String(entry.narrative).trim()) {
      return res.status(422).json({ error: 'Write your justification for this KRA first — there is nothing to review yet.' });
    }

    const input = {
      kra: { title: kra.title, weight: +kra.weight, measures: kra.measures, description: kra.description },
      perspective,
      // The rating is context for judging the words, never the subject of
      // the review. See the privacy note above for why the counterpart's
      // narrative is only included one way.
      rating_given: entry.rating ?? null,
      justification: entry.narrative,
      employee_self_justification: perspective === 'manager'
        ? ((row.self_entries || {})[kra_id] || {}).narrative || null
        : undefined,
    };
    const out = await ai.narrate({
      tenantId: T(req), kind: 'justification_review', ref: { cycle_id: c.id, employee_id: targetId, kra_id },
      requestedBy: req.user.email, input, maxTokens: 900,
      system: `You review the QUALITY OF WRITING in a justification given against one
KRA at a mid-year checkpoint. You are a writing coach, not a second
assessor.
Judge only whether the words substantiate the rating that was given:
does it cite specific, checkable facts — deliverables, dates, numbers,
named outcomes — or does it rest on adjectives and generalities? Measure
it against the KRA's own stated measures.
You must NOT endorse, dispute, or propose any rating, and must not say the
rating is too high or too low. If the justification is thin, say what
EVIDENCE is missing, not what the rating should be. Judgement of the
rating belongs to the people in the review.
Be direct and useful. A vague justification helps nobody, so say so
plainly, then show what a stronger version would contain.
Respond ONLY with JSON:
{"assessment":"one of: evidence-based | partially substantiated | vague",
 "evidence_strength":"1-2 sentences on what the justification does and does not establish",
 "missing_evidence":["specific things that would substantiate it, tied to the KRA's measures"],
 "stronger_example":"a short rewrite showing the shape of a well-evidenced justification, using ONLY facts already present in the input; where a fact is needed but absent, mark it like [add the actual figure]"}`,
    });
    res.json({ ok: true, ...out, note: 'Feedback on the write-up only — the rating is yours to decide.' });
  } catch (e) { fail(res, e); }
});

module.exports = { router, renderKraBullets, KRA_BULLET_RULES };
