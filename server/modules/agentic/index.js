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
const { requireConsent } = require('../../core/consent');
// Cross-module read via the other module's EXPORTED interface, per the
// house rule that modules never import each other's internals. This is
// also what guarantees career suggestions stay inside the set the
// career-path form accepts — both resolve eligibility through it.
const { eligibleTransitionsFor, careerPathDiagnostics, careerPathFor } = require('../people');
// Same house rule, the other direction: the appraisal summary narrates the
// performance module's own consolidation rather than re-gathering it.
const { buildAnnualReviewSummary } = require('../performance');

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
// The grouping unit differs by feature — most drafts group by KRA, the
// annual-review parameter analysis groups by parameter — so it is an
// argument to the rules rather than string surgery on them. It was the
// latter briefly: a string replace that stops matching when someone
// reflows a prompt fails SILENTLY, leaving the model told to group by the
// wrong thing with nothing anywhere to show it went wrong.
// `grouped` is false for the drafts that are ALREADY about one thing — a
// single KRA's justification, one connect's notes split into three fixed
// categories. Telling those to "group every bullet under the KRA it
// concerns" invites the model to invent a grouping the schema has no room
// for, and the caller then has bullets nested where it expects a flat
// list. Same reasoning as `unit` being an argument: the shape of the
// output decides which rules apply, so each one is asked for explicitly.
function bulletRules({ unit = 'KRA', unitWord = 'title', crossCutting = true, grouped = true } = {}) {
  return `FORMAT — a hard requirement, not a preference:
- Write BULLETS, never paragraphs. One idea per bullet.
- Each bullet is a single sentence of at most 18 words. Do not start it
  with a dash, a number or a bullet character — the UI adds those.${grouped ? `
- Group every bullet under the ${unit} it concerns, naming that ${unit} by its
  EXACT ${unitWord} as given in the input. Never paraphrase a ${unitWord}, never
  invent a ${unit}, never merge two.` : ''}
- At most 3 bullets per list. If you have nothing the input supports for
  a list, return it empty rather than padding it.${crossCutting ? `
- Anything that genuinely spans ${unit}s goes in the cross-cutting section,
  not repeated under each ${unit}.` : ''}
- Plain professional English: no "leveraged", "spearheaded" or "synergy",
  no praise the input does not support, no filler adjectives.`;
}

// The default, used by every KRA-grouped draft. Kept as a constant because
// most callers want exactly this, and `${KRA_BULLET_RULES}` at a call site
// reads better than `${bulletRules()}`.
const KRA_BULLET_RULES = bulletRules();

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
empty list for it rather than guessing or padding.

${bulletRules({ grouped: false })}

The three categories ARE the grouping here, which is why no other one is
asked for. Each is a BULLET LIST of at most 3 short bullets.
Respond ONLY with JSON:
{"achievements":["short bullets"],"blockers":["short bullets"],"feedback":["short bullets"]}`,
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
${bulletRules({ crossCutting: false })}

"reasoning" is a BULLET LIST: one short bullet per KRA you suggested,
naming that KRA by its exact title, saying what in the connect ties it
there. No bullet for a KRA you did not suggest.
Respond ONLY with JSON: {"suggested_kra_ids":["..."],"reasoning":["one short bullet per suggested KRA, naming it by exact title"]}`,
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

${bulletRules({ crossCutting: false })}

The grouping above is "serves_kra": every goal names the one KRA it serves
by that KRA's exact title, and the employee reads the goals KRA by KRA.
"why" and "how_to_measure" are BULLET LISTS, not sentences of prose —
at most 3 short bullets each, and an empty list where the KRA gives you
nothing to say rather than a padded one.
Respond ONLY with JSON:
{"suggested_goals":[{"title":"short, action-shaped, at most 10 words","serves_kra":"exact KRA title","why":["short bullets — the capability this builds and why this KRA needs it"],"how_to_measure":["short bullets — observable evidence of progress"],"suggested_timeline":"e.g. by end of Q3"}],
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
Each suggested_milestone must be a step the employee could actually put a
date against and mark progress on — "Lead one delivery workstream
end to end", not "grow as a leader". Three to five per aspiration, in the
order they would be done.
Respond ONLY with JSON:
{"aspirations":[{"target_role":"exactly as given in configured_transitions","fit":"1-2 sentences on why this follows from their current role and department","typical_time":"from the matrix, or null","competencies_to_build":["from the matrix, phrased as something to work on"],"first_steps":["what to start this cycle"],"suggested_milestones":[{"title":"short, datable, checkable","description":"one sentence on what done looks like"}]}],
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

${bulletRules({ grouped: false })}

This review is about ONE KRA, which is why there is no grouping: the
bullets are already all about that KRA. "evidence_strength" is a BULLET
LIST, not prose.
"stronger_example" is the ONE exception to the bullet rule and stays
continuous prose — it is a model of the paragraph the employee should
write in their own justification box, so bulleting it would demonstrate
the wrong thing.
Respond ONLY with JSON:
{"assessment":"one of: evidence-based | partially substantiated | vague",
 "evidence_strength":["short bullets — what the justification does and does not establish"],
 "missing_evidence":["specific things that would substantiate it, tied to the KRA's measures"],
 "stronger_example":"PROSE, not bullets: a short rewrite showing the shape of a well-evidenced justification, using ONLY facts already present in the input; where a fact is needed but absent, mark it like [add the actual figure]"}`,
    });
    res.json({ ok: true, ...out, note: 'Feedback on the write-up only — the rating is yours to decide.' });
  } catch (e) { fail(res, e); }
});


// ---------------------------------------------------------------------------
// 14) Review assist — for the EMPLOYEE, on BOTH the mid-year review and the
// annual self-appraisal.
//
// Requested in these words: read the one-on-one connects, what was and was
// not achieved on the development plan, and any progress marked in
// Aspiring Career; then give achievements, blockers and gaps against every
// KRA, so the employee starts from their own evidence rather than a blank
// box.
//
// HOW THIS DIFFERS FROM midyear-draft, which already existed: that one
// writes the NARRATIVE, from KRAs and connects. This one assembles the
// EVIDENCE, from four sources, and lays it out per KRA. They answer
// different questions — "what do I say" versus "what actually happened" —
// and an employee who has just been handed the second writes a better
// version of the first.
//
// SELF-SERVICE, and only about yourself. There is no employee_id
// parameter: it reads req.user.id and nothing else. This pulls together
// someone's connects, their development plan and their career aspirations
// in one response, which is a fuller picture of a person than any single
// screen shows — so it is deliberately not addressable at anyone else,
// not even by an admin.
const REVIEW_ASSIST_STAGES = {
  midyear: {
    label: 'mid-year review',
    period: 'the first half of the cycle so far',
    kind: 'midyear_assist',
  },
  annual: {
    label: 'annual self-appraisal',
    period: 'the full cycle',
    kind: 'annual_assist',
  },
};

router.post('/review-assist', async (req, res) => {
  try {
    const stage = (req.body || {}).stage;
    const cfg = REVIEW_ASSIST_STAGES[stage];
    if (!cfg) return res.status(400).json({ error: "stage must be 'midyear' or 'annual'" });

    const c = stage === 'midyear' ? await activeCycleForMidyear(T(req)) : await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const emp = (await db.query(
      `SELECT id, name, department, designation FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.user.id, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee record not found' });

    const sheet = (await db.query(
      `SELECT id FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, req.user.id])).rows[0];
    const kras = sheet ? (await db.query(
      `SELECT title, weight, measures, category FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`,
      [sheet.id])).rows : [];
    // Without KRAs there is nothing to organise the evidence UNDER, and a
    // per-KRA answer with no KRAs would be the model inventing headings.
    if (!kras.length) {
      return res.status(409).json({ error: 'No KRAs are mapped to you for this cycle yet — there is nothing to assess your work against.' });
    }

    // SOURCE 1 — the one-on-one connects held this cycle. Both parties'
    // structured fields, because the whole point is evidence the employee
    // may have forgotten they already recorded.
    const connects = (await db.query(
      `SELECT held_at, topic, COALESCE(discussion_notes, notes) AS discussion,
              achievements, blockers, feedback
         FROM pms.connects
        WHERE tenant_id=$1 AND employee_id=$2 AND held_at >= COALESCE($3, held_at)
        ORDER BY held_at DESC LIMIT 12`,
      [T(req), req.user.id, c.opens_at || null])).rows;

    // SOURCE 2 — "Target achievements for the year" (the development
    // plan), WITH progress, so achieved and not-achieved are separable.
    const plan = (await db.query(
      `SELECT id, status FROM pms.development_plans WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, req.user.id])).rows[0];
    const goals = plan ? (await db.query(
      `SELECT title, description, target_date, progress_pct
         FROM pms.development_goals WHERE plan_id=$1 ORDER BY sort_order`,
      [plan.id])).rows : [];

    // SOURCE 3 — Aspiring Career, through the people module's exported
    // reader rather than a reach into its table (same house rule as the
    // career-suggest endpoint above). Role names and timelines come from
    // HR's configured matrix, not from the model. Since migration 028 this
    // carries real MILESTONE PROGRESS rather than only the plan text, so
    // "any progress marked in Aspiring Career" is now something the model
    // can actually be shown.
    const career = await careerPathFor(T(req), req.user.id);

    const today = new Date().toISOString().slice(0, 10);
    const input = {
      employee: { name: emp.name, department: emp.department, designation: emp.designation },
      cycle: { name: c.name, phase: c.phase, opened: c.opens_at },
      stage: cfg.label,
      period_covered: cfg.period,
      today,
      kras: kras.map((k) => ({ title: k.title, category: k.category, weight: +k.weight, measures: k.measures })),
      one_on_one_connects: connects,
      target_achievements_for_the_year: goals.map((g) => {
        // pg hands back a DATE column as a Date object, and comparing one
        // to an ISO string coerces it to "Sat May 31 2025 ..." — which
        // then compares lexically and calls every overdue goal on track.
        // Normalise to yyyy-mm-dd first and compare like with like.
        const targetDate = g.target_date ? new Date(g.target_date).toISOString().slice(0, 10) : null;
        return {
          title: g.title, description: g.description, target_date: targetDate,
          progress_pct: g.progress_pct,
          // Stated rather than left for the model to infer, so "not
          // achieved" is a fact about the data and not a judgement it made
          // up from a percentage and a date it could read either way.
          state: g.progress_pct >= 100 ? 'achieved'
            : (targetDate && targetDate < today ? 'overdue and incomplete' : 'in progress'),
        };
      }),
      development_plan_status: plan ? plan.status : 'not started',
      aspiring_career: career,
    };

    const out = await ai.narrate({
      tenantId: T(req), kind: cfg.kind, ref: { cycle_id: c.id, employee_id: req.user.id },
      requestedBy: req.user.email, input, maxTokens: 2000,
      system: `You assemble the EVIDENCE an employee already has, so they can write their
${cfg.label} from it instead of from memory. You are not writing the review — you
are laying out, KRA by KRA, what the record shows.

Your sources, all in the input, and nothing else:
- one_on_one_connects: what was discussed, achieved, blocked and fed back
- target_achievements_for_the_year: their development goals and each one's
  state, which is given to you — do not recompute or dispute it
- aspiring_career: the role they are working towards, if they have set one
- kras: what they are accountable for, with weights

For each KRA give:
- achievements: what the record actually shows they did against it
- blockers: obstacles named in the record, not obstacles you infer
- gaps: where the record says little or nothing about a KRA they carry.
  A KRA with no evidence is the most useful thing you can tell them, so
  never pad it with generic filler to avoid an empty-looking section.

Ground every bullet in a source. If a point comes from a connect, a goal
or the career plan, say so in a few words ("from the 12 Aug connect",
"goal 60% complete"). Invent no achievement, no date and no number.
Never suggest, imply or hint at a rating — this is preparation, not
assessment.

${KRA_BULLET_RULES}

Respond ONLY with JSON:
{"by_kra":[{"kra":"exact KRA title","achievements":["..."],"blockers":["..."],"gaps":["..."]}],
 "cross_cutting":{"achievements":["..."],"blockers":["..."],"gaps":["..."]},
 "career_progress":["what the record shows towards their aspired role, or empty"],
 "sources_missing":["a source that was empty and would have helped"]}`,
    });

    const d = out.draft || {};
    res.json({
      ok: true, ...out,
      // What the model was actually given, so the employee can see the
      // answer is thin because the record is thin — not because the
      // feature is broken.
      evidence_counts: {
        kras: kras.length,
        connects: connects.length,
        goals: goals.length,
        goals_achieved: goals.filter((g) => g.progress_pct >= 100).length,
        aspiring_career_set: !!career,
        career_milestones: career && career.milestones ? career.milestones.length : 0,
        career_progress_pct: career ? career.progress_pct : null,
      },
      draft: d,
      note: 'Evidence from your own records — edit and add to it before you submit.',
    });
  } catch (e) { fail(res, e); }
});


// ---------------------------------------------------------------------------
// 15) Meeting summary, KRA-wise — the half of the Google Meet request that
// can be built without connecting Google Meet.
//
// Requested: once PMS is integrated with Meet, AI should listen to the
// whole conversation and afterwards give the employee and manager a
// KRA-wise summary, so nobody writes it up from scratch. That is two
// pieces: CAPTURING the conversation (needs Meet, deliberately not built —
// see core/meetings.js) and SUMMARISING it (needs only the text). This is
// the second piece, finished and usable today against a pasted transcript,
// so connecting Meet later adds capture and changes nothing here.
//
// CONSENT IS RE-CHECKED HERE, not assumed from the fact that a transcript
// exists. Storing it required consent; an employee who has since revoked
// it has withdrawn permission for exactly this — "used for AI insights" is
// the wording of the consent they gave. The row stays (it is a record of a
// real meeting); what stops is feeding it to a model.
router.post('/meeting-summary', async (req, res) => {
  try {
    const { meeting_id } = req.body || {};
    if (!meeting_id) return res.status(400).json({ error: 'meeting_id required' });
    const m = (await db.query(
      `SELECT m.*, e.name AS employee_name
         FROM pms.review_meetings m
         JOIN core.employees e ON e.id = m.employee_id AND e.tenant_id = m.tenant_id
        WHERE m.id=$1 AND m.tenant_id=$2`, [meeting_id, T(req)])).rows[0];
    if (!m) return res.status(404).json({ error: 'meeting not found' });

    // Same two parties as the meeting routes: the employee it is about,
    // their manager, or an admin.
    const isSelf = m.employee_id === req.user.id;
    const isMgr = !!(await db.query(`SELECT 1 FROM core.employees WHERE id=$1 AND tenant_id=$2 AND manager_id=$3`,
      [m.employee_id, T(req), req.user.id])).rows[0];
    if (!isSelf && !isMgr && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: 'Not your meeting' });
    }

    const t = (await db.query(`SELECT content, captured_at FROM pms.meeting_transcripts WHERE meeting_id=$1`, [m.id])).rows[0];
    if (!t) {
      return res.status(409).json({
        error: 'No transcript is stored for this meeting yet — paste one in, or connect a provider that can capture it.',
      });
    }
    await requireConsent(T(req), m.employee_id);

    const c = await activeCycle(T(req));
    const sheet = c ? (await db.query(
      `SELECT id FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
      [T(req), c.id, m.employee_id])).rows[0] : null;
    const kras = sheet ? (await db.query(
      `SELECT title, weight, measures FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    if (!kras.length) {
      return res.status(409).json({ error: 'No KRAs are mapped to this employee for the current cycle — there is nothing to organise the summary under.' });
    }

    const out = await ai.narrate({
      tenantId: T(req), kind: 'meeting_summary', ref: { meeting_id: m.id, employee_id: m.employee_id },
      requestedBy: req.user.email, maxTokens: 2000,
      input: {
        employee: m.employee_name,
        meeting: { context: m.context, scheduled_at: m.scheduled_at, provider: m.provider },
        kras: kras.map((k) => ({ title: k.title, weight: +k.weight, measures: k.measures })),
        transcript: t.content,
      },
      system: `You summarise a recorded one-on-one between an employee and their manager,
organised by the employee's KRAs, so neither of them has to write the meeting up
from scratch.

Work ONLY from the transcript. It is a record of what two people said: report
what was said, not what you would conclude from it. Where the two disagreed,
say so rather than picking a side. Attribute a point to whoever made it when
that matters ("their manager raised", "they said").

Put each point under the KRA it concerns, by that KRA's exact title. Anything
discussed that belongs to no KRA — leave, tooling, personal circumstances —
goes under cross_cutting, and anything sensitive that is plainly not
performance content should be left out entirely rather than summarised.

Actions must be things somebody actually committed to in the conversation,
with the owner named. Do not invent an action because a topic seemed to
need one.

Never suggest, imply or hint at a rating. This is a record of a
conversation, not an assessment of it.

${KRA_BULLET_RULES}

Respond ONLY with JSON:
{"by_kra":[{"kra":"exact KRA title","discussed":["..."],"agreed_actions":["owner — what they committed to"],"concerns":["..."]}],
 "cross_cutting":{"discussed":["..."],"agreed_actions":["..."],"concerns":["..."]},
 "kras_not_discussed":["exact titles of KRAs the conversation never touched"],
 "follow_up_needed":["anything left unresolved"]}`,
    });

    res.json({
      ok: true, ...out,
      meeting: { id: m.id, context: m.context, employee_id: m.employee_id, transcript_captured_at: t.captured_at },
      note: 'Summary of what was said — check it against your own recollection before relying on it.',
    });
  } catch (e) { fail(res, e); }
});


// ---------------------------------------------------------------------------
// 16) AI Appraisal Summary — the year, KRA by KRA, at two stages.
//
// Requested with both audiences named: a manager/HR PRE-READ before
// publish, to support the rating decision, and an EMPLOYEE-FACING summary
// at publish, so the appraisal conversation starts from a shared document
// instead of a number.
//
// TWO PROMPTS, ON PURPOSE, over the same evidence. They are not the same
// document with a different header. The pre-read is written for someone
// deciding — it says where the evidence is thin and where self and manager
// disagree, because that is what a calibration room needs. The employee
// summary is written for someone receiving — it explains how the year is
// being read and what to build next, and it never speculates about a
// rating that has already been decided elsewhere. One prompt trying to do
// both would do neither, and the wrong one reaching the wrong reader is
// exactly the failure to avoid.
//
// THE EVIDENCE IS buildAnnualReviewSummary(), the same consolidation the
// Annual Review page renders — imported from the performance module's
// exported interface, not re-gathered here. A second gatherer would let
// the summary describe a year no screen agrees with.
const APPRAISAL_SUMMARY_STAGES = {
  pre_publish: {
    kind: 'appraisal_summary_pre',
    audience: 'the manager and HR, before the rating is published',
    system: `You write the PRE-READ a manager and HR use while deciding someone's
year-end rating. You are not deciding it — you never suggest, imply or hint at a
rating, a grade or a band, and you never say whether one already recorded looks
right or wrong.

What this reader needs, and nothing else:
- what the record actually shows against each KRA, weighted by the KRA's weight
- where the SELF and MANAGER readings differ, said plainly, with both positions
- where the evidence is THIN — a KRA with no narrative, no connect and no
  goal against it is the most important thing you can flag, because it is
  where a rating would be least defensible
- how the mid-year reading compares with the end-of-year one, where both exist

Ground every bullet in the input. Invent no achievement, date or number. If a
section of the record is empty, say so rather than filling it.`,
    schema: `{"by_kra":[{"kra":"exact KRA title","evidence":["..."],"divergence":["where self and manager read it differently"],"thin_evidence":["..."]}],
 "cross_cutting":{"evidence":["..."],"divergence":["..."],"thin_evidence":["..."]},
 "discussion_points":["what the calibration conversation should cover"],
 "evidence_gaps":["what is missing from the record that would have helped"]}`,
  },
  employee: {
    kind: 'appraisal_summary_employee',
    audience: 'the employee, with their published rating',
    system: `You write the summary an employee receives with their published appraisal.
They are reading about their own year, so write TO them, in the second person
("you"), plainly and without flattery.

The rating has already been decided by their manager and is shown to them
separately. You never state, restate, justify, question or hint at it — your job
is to show what the year contained, not to defend a grade.

Cover, per KRA:
- what they achieved, from the record
- what got in the way, where the record says so
- what to build next, tied to that KRA

Then, once: how their target achievements for the year went, and what their
Aspiring Career milestones show. Be specific about progress that was made —
someone who moved a milestone from 0 to 60% did something real and should see it
named.

Ground every bullet in the input and invent nothing. Where the record is thin,
say the record is thin — never imply the person did little when what is actually
missing is the write-up.`,
    schema: `{"by_kra":[{"kra":"exact KRA title","achievements":["..."],"challenges":["..."],"build_next":["..."]}],
 "cross_cutting":{"achievements":["..."],"challenges":["..."],"build_next":["..."]},
 "year_in_review":["2-4 bullets on target achievements and Aspiring Career progress"],
 "record_gaps":["where your own record was thin this year"]}`,
  },
};

router.post('/appraisal-summary', async (req, res) => {
  try {
    const { stage, employee_id } = req.body || {};
    const cfg = APPRAISAL_SUMMARY_STAGES[stage];
    if (!cfg) return res.status(400).json({ error: "stage must be 'pre_publish' or 'employee'" });

    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const targetId = employee_id || req.user.id;
    const emp = (await db.query(
      `SELECT id, name, department, designation, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [targetId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });

    // WHO MAY ASK FOR WHICH. The pre-read is decision support and is not
    // the employee's to pull about themselves — it names where their
    // evidence is weakest, written for someone weighing a rating. The
    // employee summary is theirs, and their manager's.
    const isSelf = targetId === req.user.id;
    const isMgr = emp.manager_id === req.user.id;
    const isAdmin = await hasPermission(req.user, 'pms_admin');
    if (stage === 'pre_publish') {
      if (!isMgr && !isAdmin && !(await hasPermission(req.user, 'pms_hod'))) {
        return res.status(403).json({ error: 'The pre-read is for the manager, Delivery Head or HR' });
      }
    } else if (!isSelf && !isMgr && !isAdmin) {
      return res.status(403).json({ error: 'Not your appraisal' });
    }

    const summary = await buildAnnualReviewSummary(T(req), emp.id, c.id);
    if (!summary.kra.outcomes.length) {
      return res.status(409).json({ error: 'No KRAs are mapped for this cycle — there is nothing to summarise the year against.' });
    }

    const out = await ai.narrate({
      tenantId: T(req), kind: cfg.kind, ref: { cycle_id: c.id, employee_id: emp.id },
      requestedBy: req.user.email, maxTokens: 2400,
      input: {
        employee: { name: emp.name, department: emp.department, designation: emp.designation },
        cycle: c.name,
        written_for: cfg.audience,
        kra_outcomes: summary.kra.outcomes.map((k) => ({
          kra: k.title, weight: +k.weight, measures: k.measures,
          self: k.self, manager: k.manager, midyear: k.midyear,
        })),
        midyear_overall: summary.midyear,
        target_achievements_for_the_year: summary.development_plan,
        aspiring_career: summary.career_path,
        rating_history: summary.rating_history,
      },
      system: `${cfg.system}\n\n${KRA_BULLET_RULES}\n\nRespond ONLY with JSON:\n${cfg.schema}`,
    });

    res.json({
      ok: true, ...out,
      stage,
      employee: { id: emp.id, name: emp.name },
      note: stage === 'pre_publish'
        ? 'Pre-read for the rating decision — the rating remains yours to set.'
        : 'A summary of what your year contained. Your rating is shown separately.',
    });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// 17) 7-parameter analysis of the annual review meeting — HR ADMIN ONLY.
//
// THE FEATURE, as described: the employee, their manager and HR hold the
// annual review conversation on a call. AI reads the transcript against
// the seven organisational parameters and reports, for each one, what the
// conversation actually showed — alongside that parameter's configured
// weightage. Visible to the HR admin, and strictly not to the employee or
// their manager.
//
// FOUR THINGS THIS DELIBERATELY DOES NOT DO, each because of what the
// feature is: a hidden assessment of a named person.
//
// 1. IT MINTS NO SCORE. The official 7-parameter rating is scored by
//    humans (pms.parameter_scores) and computed by
//    computeWeightedRating(). A numeric AI score for the same parameters
//    would be a second rating, derived from a recording, that the person
//    it describes cannot see or contest — and HR would inevitably weigh
//    "the AI said 3" against a manager's 5. The model gives a QUALITATIVE
//    SIGNAL (strong / mixed / concern / not_discussed) and prose. That is
//    the calibration value without the shadow rating. It is also the house
//    rule: deterministic numbers, AI narrates — and core/ai.js's
//    stripRatingSuggestions() would delete a key called `score` anyway.
//
// 2. IT DOES NOT RUN WITHOUT CONSENT. BRD §6 requires explicit employee
//    consent before any meeting recording or transcription feeds an AI
//    feature. Consent is re-checked here at USE, not assumed from the
//    transcript existing — someone who has revoked it has withdrawn
//    permission for exactly this.
//
// 3. EVERY READ IS AUDITED, not just every write. A confidential
//    assessment somebody can open without trace is the kind of thing that
//    is impossible to answer questions about afterwards. Reads are cheap;
//    the record is the point.
//
// 4. IT IS NOT IN THE EMPLOYEE'S OWN DATA EXPORT, but it IS in the one HR
//    pulls for them. "Not visible in the product" and "not disclosable"
//    are different things, and only the first was asked for. See
//    core/gdpr.js.
//
// The weightage shown against each parameter is the CONFIGURED number from
// pms.review_parameters, never something the model produced.
const PARAM_SIGNALS = ['strong', 'mixed', 'concern', 'not_discussed'];

async function requireHrAdmin(req, res) {
  if (await hasPermission(req.user, 'pms_admin')) return true;
  // The message says who this is for rather than only that they are
  // refused — a manager hitting this should understand it is not an
  // oversight they should ask to have fixed.
  res.status(403).json({ error: "Requires 'pms_admin' — the parameter analysis is visible to HR only, by design" });
  return false;
}

const auditAgentic = (req, action, details) =>
  db.query(`INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details)
            VALUES ($1,$2,$3,$4,$5,$6)`,
    [T(req), req.user.email, action, details.cycle_id || null, details.employee_id || null, JSON.stringify(details)])
    .catch((e) => logger.warn('agentic audit failed', { error: e.message }));

// POST /agentic/parameter-analysis { meeting_id }
router.post('/parameter-analysis', async (req, res) => {
  try {
    if (!(await requireHrAdmin(req, res))) return;
    const { meeting_id } = req.body || {};
    if (!meeting_id) return res.status(400).json({ error: 'meeting_id required' });

    const m = (await db.query(
      `SELECT m.*, e.name AS employee_name, e.department, e.designation
         FROM pms.review_meetings m
         JOIN core.employees e ON e.id = m.employee_id AND e.tenant_id = m.tenant_id
        WHERE m.id=$1 AND m.tenant_id=$2`, [meeting_id, T(req)])).rows[0];
    if (!m) return res.status(404).json({ error: 'meeting not found' });
    if (m.context !== 'annual') {
      return res.status(409).json({ error: `This analysis is for the annual review meeting — that meeting is recorded as "${m.context}"` });
    }

    const t = (await db.query(`SELECT content, captured_at FROM pms.meeting_transcripts WHERE meeting_id=$1`, [m.id])).rows[0];
    if (!t) return res.status(409).json({ error: 'No transcript is stored for this meeting yet — there is nothing to analyse.' });
    await requireConsent(T(req), m.employee_id);

    const c = (await db.query(`SELECT * FROM pms.cycles WHERE id=$1 AND tenant_id=$2`, [m.cycle_id, T(req)])).rows[0]
      || (await db.query(`SELECT * FROM pms.cycles WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled') ORDER BY created_at DESC LIMIT 1`, [T(req)])).rows[0];
    if (!c) return res.status(409).json({ error: 'No cycle to attach this analysis to' });

    const params = (await db.query(
      `SELECT id, name, weight_pct FROM pms.review_parameters WHERE tenant_id=$1 AND active=true ORDER BY sort_order`,
      [T(req)])).rows;
    if (!params.length) return res.status(409).json({ error: 'No organisational parameters are configured for this tenant' });

    const out = await ai.narrate({
      tenantId: T(req), kind: 'parameter_analysis', ref: { cycle_id: c.id, employee_id: m.employee_id, meeting_id: m.id },
      requestedBy: req.user.email, maxTokens: 2600,
      input: {
        employee: { name: m.employee_name, department: m.department, designation: m.designation },
        cycle: c.name,
        meeting: { held: m.scheduled_at, transcript_captured: t.captured_at },
        // Names and weightages both come from the tenant's configuration.
        // The model is told the weightage so it can judge how much a
        // parameter's evidence matters to report on — never so it can
        // compute anything with it.
        parameters: params.map((p) => ({ name: p.name, weight_pct: Number(p.weight_pct) })),
        transcript: t.content,
      },
      system: `You read the transcript of an annual performance review meeting between an
employee, their manager and HR, and report what the conversation showed against each
of the organisation's review parameters. The reader is HR.

WORK ONLY FROM THE TRANSCRIPT. It is a record of what people said. Report what was
said, not what you would conclude about the person. Where the employee and the
manager characterised something differently, say so and give both — that difference
is often the most useful thing in the meeting.

FOR EACH PARAMETER, exactly as named in the input:
- signal: one of "strong", "mixed", "concern", or "not_discussed". Use
  "not_discussed" whenever the conversation did not genuinely cover that
  parameter. A meeting that never touched a parameter is a fact worth
  reporting; inventing a reading of it is not.
- summary: what the conversation showed about it.
- evidence: short paraphrases or brief quoted fragments from the meeting that
  support what you said. Every point in summary must be traceable to one of
  these. No evidence means the signal is "not_discussed".
- alignment: only where the conversation actually discussed how the person
  works with company policy, process or values. Otherwise an empty list.

YOU NEVER PRODUCE A RATING, a score, a grade, a band or a number of any kind for a
parameter or for the person overall, and you never say what rating the evidence
would support. The organisation's rating is set by people, from their own scoring.
You are describing a conversation.

Do not speculate about anyone's motives, health, personal circumstances, or
anything protected. If the meeting strayed into those, leave it out entirely
rather than summarising it.

${bulletRules({ unit: 'parameter', unitWord: 'name', crossCutting: false })}

Respond ONLY with JSON:
{"by_parameter":[{"parameter":"exact parameter name","signal":"strong|mixed|concern|not_discussed","summary":["..."],"evidence":["..."],"alignment":["..."]}],
 "went_well":["what the meeting identified as going well"],
 "went_wrong":["what the meeting identified as not going well"],
 "improvement_areas":["what the meeting agreed needs to improve"],
 "achievements":["specific achievements named in the meeting"],
 "meeting_gaps":["parameters or topics the conversation never reached"]}`,
    });

    const draft = out.draft || {};
    // Stitched to the CONFIGURED parameters, not to whatever the model
    // named. A parameter the model skipped, or renamed, comes back as
    // not_discussed against the real row rather than silently vanishing
    // from a report someone is about to rely on.
    const byName = new Map((draft.by_parameter || []).map((p) => [String(p.parameter || '').trim().toLowerCase(), p]));
    const entries = {};
    for (const p of params) {
      const got = byName.get(p.name.trim().toLowerCase());
      const signal = got && PARAM_SIGNALS.includes(got.signal) ? got.signal : 'not_discussed';
      entries[p.id] = {
        parameter: p.name,
        weight_pct: Number(p.weight_pct),
        signal,
        summary: Array.isArray(got && got.summary) ? got.summary : [],
        evidence: Array.isArray(got && got.evidence) ? got.evidence : [],
        alignment: Array.isArray(got && got.alignment) ? got.alignment : [],
      };
    }
    const overall = {
      went_well: draft.went_well || [], went_wrong: draft.went_wrong || [],
      improvement_areas: draft.improvement_areas || [], achievements: draft.achievements || [],
      meeting_gaps: draft.meeting_gaps || [],
    };

    const saved = (await db.query(
      `INSERT INTO pms.parameter_ai_analyses (tenant_id, cycle_id, employee_id, meeting_id, draft_id, entries, overall, analysed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, cycle_id, employee_id) DO UPDATE SET
         meeting_id=EXCLUDED.meeting_id, draft_id=EXCLUDED.draft_id, entries=EXCLUDED.entries,
         overall=EXCLUDED.overall, analysed_by=EXCLUDED.analysed_by, updated_at=now()
       RETURNING *`,
      [T(req), c.id, m.employee_id, m.id, out.id, JSON.stringify(entries), JSON.stringify(overall), req.user.email])).rows[0];

    auditAgentic(req, 'PARAMETER_ANALYSIS_RUN', { cycle_id: c.id, employee_id: m.employee_id, meeting_id: m.id });
    res.json({ ok: true, ...(await shapeAnalysis(T(req), saved)) });
  } catch (e) { fail(res, e); }
});

// The stored analysis, joined to the manager's ACTUAL scores for the same
// parameters. That comparison is the whole reason HR wants this: the
// scores are what the rating is built from, the analysis is what the
// conversation contained, and seeing them side by side is calibration.
// Both halves are deterministic — the scores from the database, the
// weightage from configuration.
//
// The employee's own self-score against each parameter was shown here
// too. Employee self-scoring has been removed from the Self-Appraisal at
// the client's instruction, so no cycle from here on can have one; the
// field is gone rather than left to render as a permanent em-dash. Only
// the manager's scoring is joined now, which is also the only scoring the
// official annual rating is built from (BR-6.2/6.3).
async function shapeAnalysis(tenantId, row) {
  const params = (await db.query(
    `SELECT id, name, weight_pct, sort_order FROM pms.review_parameters WHERE tenant_id=$1 AND active=true ORDER BY sort_order`,
    [tenantId])).rows;
  const scored = (await db.query(
    `SELECT parameter_id, score FROM pms.parameter_scores
      WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='manager'`,
    [tenantId, row.cycle_id, row.employee_id])).rows;
  const scoreOf = (pid) => {
    const s = scored.find((x) => x.parameter_id === pid);
    return s ? Number(s.score) : null;
  };
  const entries = row.entries || {};
  return {
    analysis: {
      id: row.id, cycle_id: row.cycle_id, employee_id: row.employee_id, meeting_id: row.meeting_id,
      analysed_by: row.analysed_by, created_at: row.created_at, updated_at: row.updated_at,
      restricted_to: row.restricted_to,
    },
    by_parameter: params.map((p) => ({
      parameter_id: p.id,
      parameter: p.name,
      weight_pct: Number(p.weight_pct),
      ...(entries[p.id] || { signal: 'not_discussed', summary: [], evidence: [], alignment: [] }),
      manager_score: scoreOf(p.id),
    })),
    overall: row.overall || {},
  };
}

// GET /agentic/parameter-analysis?employee_id=&cycle_id=
router.get('/parameter-analysis', async (req, res) => {
  try {
    if (!(await requireHrAdmin(req, res))) return;
    const { employee_id, cycle_id } = req.query;
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    const params = [T(req), employee_id];
    let where = 'tenant_id=$1 AND employee_id=$2';
    if (cycle_id) { params.push(cycle_id); where += ` AND cycle_id=$${params.length}`; }
    const row = (await db.query(
      `SELECT * FROM pms.parameter_ai_analyses WHERE ${where} ORDER BY updated_at DESC LIMIT 1`, params)).rows[0];
    if (!row) return res.status(404).json({ error: 'no analysis on record for this employee' });
    // Audited on READ. See the block comment above: a confidential
    // assessment anyone can open without trace cannot be answered for
    // later.
    auditAgentic(req, 'PARAMETER_ANALYSIS_VIEWED', { cycle_id: row.cycle_id, employee_id: row.employee_id });
    res.json({ ok: true, ...(await shapeAnalysis(T(req), row)) });
  } catch (e) { fail(res, e); }
});

// Which employees have one, for the HR list. Names and dates only — no
// content, so the index itself discloses nothing about anybody.
router.get('/parameter-analysis/index', async (req, res) => {
  try {
    if (!(await requireHrAdmin(req, res))) return;
    const r = await db.query(
      `SELECT a.employee_id, e.name, e.department, a.cycle_id, c.name AS cycle_name,
              a.analysed_by, a.updated_at
         FROM pms.parameter_ai_analyses a
         JOIN core.employees e ON e.id=a.employee_id AND e.tenant_id=a.tenant_id
         JOIN pms.cycles c ON c.id=a.cycle_id
        WHERE a.tenant_id=$1 ORDER BY a.updated_at DESC LIMIT 200`, [T(req)]);
    res.json({ analyses: r.rows });
  } catch (e) { fail(res, e); }
});

// Retract one. HR can delete an analysis they judge wrong or unfair rather
// than being stuck with it — a hidden assessment that cannot be withdrawn
// is worse than one that can.
router.delete('/parameter-analysis/:id', async (req, res) => {
  try {
    if (!(await requireHrAdmin(req, res))) return;
    const r = await db.query(
      `DELETE FROM pms.parameter_ai_analyses WHERE id=$1 AND tenant_id=$2 RETURNING cycle_id, employee_id`,
      [req.params.id, T(req)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'analysis not found' });
    auditAgentic(req, 'PARAMETER_ANALYSIS_DELETED', { cycle_id: r.rows[0].cycle_id, employee_id: r.rows[0].employee_id });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------
// AI recommendations that stick (migration 029)
// ---------------------------------------------------------------------------
// Everything above produces text that appears in a panel and disappears.
// These three routes are what let a suggestion be kept, acted on, or
// turned down with a reason — so "the AI suggested X last cycle" is a
// question with an answer.
//
// WHO MAY DECIDE: the person the recommendation is about, or their
// manager, or an admin. The same rule as the meeting routes, and for the
// same reason — a suggestion about someone's development belongs to the
// two people who will act on it.
const REC_STATUSES = ['suggested', 'accepted', 'dismissed', 'done'];

async function recParty(req, aboutEmployeeId) {
  if (aboutEmployeeId === req.user.id) return true;
  if (await hasPermission(req.user, 'pms_admin')) return true;
  const r = await db.query(`SELECT 1 FROM core.employees WHERE id=$1 AND tenant_id=$2 AND manager_id=$3`,
    [aboutEmployeeId, T(req), req.user.id]);
  return !!r.rows[0];
}

// POST /agentic/recommendations — keep one or more suggestions from a draft.
router.post('/recommendations', async (req, res) => {
  try {
    const { about_employee_id, kind, draft_id, cycle_id, items } = req.body || {};
    const aboutId = about_employee_id || req.user.id;
    if (!kind) return res.status(400).json({ error: 'kind required' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
    if (!(await recParty(req, aboutId))) return res.status(403).json({ error: 'Not yours to keep' });

    const bad = items.findIndex((i) => !i || !String(i.title || '').trim());
    if (bad >= 0) return res.status(422).json({ error: `item ${bad + 1} has no title` });

    const saved = [];
    for (const i of items) {
      const row = (await db.query(
        `INSERT INTO agentic.recommendations (tenant_id, draft_id, kind, cycle_id, about_employee_id, ref, title, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [T(req), draft_id || null, kind, cycle_id || null, aboutId,
         JSON.stringify(i.ref || {}), String(i.title).trim(), (i.detail || '').trim() || null])).rows[0];
      saved.push(row);
    }
    res.status(201).json({ ok: true, recommendations: saved });
  } catch (e) { fail(res, e); }
});

// GET /agentic/recommendations?about_employee_id=&kind=&status=
router.get('/recommendations', async (req, res) => {
  try {
    const aboutId = req.query.about_employee_id || req.user.id;
    if (!(await recParty(req, aboutId))) return res.status(403).json({ error: 'Not yours to read' });
    const params = [T(req), aboutId];
    let where = 'tenant_id=$1 AND about_employee_id=$2';
    if (req.query.kind) { params.push(req.query.kind); where += ` AND kind=$${params.length}`; }
    if (req.query.status) { params.push(req.query.status); where += ` AND status=$${params.length}`; }
    const r = await db.query(
      `SELECT * FROM agentic.recommendations WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ recommendations: r.rows });
  } catch (e) { fail(res, e); }
});

// PUT /agentic/recommendations/:id — accept, dismiss, or mark done.
router.put('/recommendations/:id', async (req, res) => {
  try {
    const { status, note } = req.body || {};
    if (!REC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${REC_STATUSES.join(', ')}` });
    }
    const rec = (await db.query(`SELECT * FROM agentic.recommendations WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!rec) return res.status(404).json({ error: 'recommendation not found' });
    if (!(await recParty(req, rec.about_employee_id))) return res.status(403).json({ error: 'Not yours to decide' });
    // A dismissal without a reason teaches nobody anything. Requiring one
    // is what turns "the AI keeps suggesting rubbish" from a complaint
    // into a list you can read.
    if (status === 'dismissed' && !String(note || '').trim()) {
      return res.status(422).json({ error: 'Say why you are dismissing it — that is what makes a pattern of poor suggestions visible' });
    }
    const updated = (await db.query(
      `UPDATE agentic.recommendations SET status=$1, decided_by=$2, decided_at=now(), decision_note=$3
        WHERE id=$4 RETURNING *`,
      [status, req.user.email, (note || '').trim() || null, rec.id])).rows[0];
    res.json({ ok: true, recommendation: updated });
  } catch (e) { fail(res, e); }
});

module.exports = { router, renderKraBullets, KRA_BULLET_RULES, bulletRules };
