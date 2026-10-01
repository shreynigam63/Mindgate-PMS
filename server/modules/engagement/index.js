// Engagement — surveys with structural anonymity (spec §4).
//
// The take-flow is where anonymity lives or dies, so it is explicit here:
//   1. Completion is recorded on the INVITATION (who finished — HR needs
//      participation rates).
//   2. The RESPONSE row gets employee_id ONLY when (survey allows opt-in)
//      AND (respondent explicitly asked to be attributed). Otherwise NULL.
//   3. No other column, log line, or join path may connect the two.
// shouldAttribute() is pure and tested.

const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { authenticate } = require('../../core/auth');
const { guardUuidParams } = require('../../core/http');
const { apiPermissionParity, hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { normaliseRule, audienceSql, describeRule, needsJoiningDate,
        triggerRule, validateRule, MILESTONES } = require('./audience');
const { seedTemplates } = require('../../migrations/056-survey-templates');
const { TEMPLATES: SHIPPED_TEMPLATES } = require('./templates');
const { seedFlagRules } = require('../../migrations/058-engagement-insights');
const { flagsFor, groupFlags, worst, scoreByDimension, overallScore, trend,
        newHireIndex, outcomeByBand } = require('./insights');

// Every state change HR makes to a survey is written down. A release
// names how many people it wrote to and who they were, because "who
// was this sent to" is the first question asked after one goes out.
const audit = (req, action, details) => db.query(
  `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
   VALUES ($1,$2,$3,'engagement.survey',$4)`,
  [req.user.tenant_id, req.user.email, action, JSON.stringify(details || {})],
).catch((e) => logger.error('engagement audit', { action, error: e.message }));

// The audience, resolved against the employee master right now.
// `survey` may be a saved row or an unsaved {audience_rule, trigger_*}
// from the builder — the preview on screen and the invitations the
// release writes go through this one function, so they cannot disagree.
//
// TWO SHAPES, since phase 4 on 25 Sep:
//
//   'self'                    the rule picks who answers, about
//                             themselves. Everything before today.
//
//   'manager_about_reportee'  the rule picks who is ASSESSED, and the
//                             invitation goes to each subject's
//                             manager. One manager with four new
//                             joiners gets four, not one — which is
//                             why the invitation key had to change.
async function resolveAudience(tenantId, survey) {
  const rule = triggerRule(survey);
  const { where, params } = audienceSql(rule, { start: 2 });
  const subjects = (await db.query(
    `SELECT id, name, email, manager_id FROM core.employees
      WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL AND (${where})
      ORDER BY name`, [tenantId, ...params])).rows;

  // Anyone a tenure rule had to skip for want of a joining date is
  // COUNTED, not swallowed: a cohort that is quietly short looks
  // exactly like a cohort that is genuinely small.
  let noJoiningDate = 0;
  if (needsJoiningDate(rule)) {
    noJoiningDate = +(await db.query(
      `SELECT count(*)::int AS n FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL AND date_of_joining IS NULL`,
      [tenantId])).rows[0].n;
  }

  const base = { rule, no_joining_date: noJoiningDate };
  if ((survey && survey.audience_kind) !== 'manager_about_reportee') {
    return { ...base, kind: 'self', pairs: subjects.map((e) => ({ recipient: e, subject: null })),
      employees: subjects, count: subjects.length, no_manager: 0,
      description: describeRule(rule) };
  }

  // One invitation per SUBJECT, addressed to their manager. Somebody
  // with no manager on the master cannot be assessed by one, and is
  // reported rather than dropped — on the real master that is a
  // handful of people, and a silently shorter list reads as if they
  // were simply not in the cohort.
  const withManager = subjects.filter((e) => e.manager_id);
  const managers = new Map((await db.query(
    `SELECT id, name, email, status FROM core.employees
      WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
    [tenantId, [...new Set(withManager.map((e) => e.manager_id))]])).rows.map((m) => [m.id, m]));

  const pairs = [];
  let managerInactive = 0;
  for (const subj of withManager) {
    const mgr = managers.get(subj.manager_id);
    // A manager who has left cannot be asked. Counted, for the same
    // reason as above.
    if (!mgr || mgr.status !== 'active') { managerInactive++; continue; }
    pairs.push({ recipient: mgr, subject: subj });
  }
  return { ...base, kind: 'manager_about_reportee', pairs,
    employees: pairs.map((p) => p.subject),
    count: pairs.length,
    no_manager: subjects.length - withManager.length,
    manager_inactive: managerInactive,
    managers: new Set(pairs.map((p) => p.recipient.id)).size,
    description: `the reporting manager of ${describeRule(rule).replace(/^everyone/, 'everyone')}` };
}

function shouldAttribute(survey, wantsAttribution) {
  if (!survey.anonymity_default) return true;               // attributed-by-design survey
  if (survey.allow_attribution_optin && wantsAttribution === true) return true;
  return false;
}

// eNPS from 0-10 scores: %promoters(9-10) − %detractors(0-6). Pure.
function enps(scores) {
  const n = scores.length;
  if (!n) return null;
  const promoters = scores.filter(s => s >= 9).length;
  const detractors = scores.filter(s => s <= 6).length;
  return Math.round(((promoters - detractors) / n) * 100);
}

const router = express.Router();
router.use(authenticate, require('../../core/scope-hooks').run(), apiPermissionParity);
// `.run()` is the extension point a module uses to narrow what this
// router returns — today, the HRBP gateway. See core/scope-hooks.js.
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);
const T = (req) => req.user.tenant_id;

// ---- HR: survey lifecycle ---------------------------------------------------
router.get('/surveys', async (req, res) => {
  try {
    const admin = await hasPermission(req.user, 'engagement_admin');
    const r = await db.query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM engagement.invitations i WHERE i.survey_id=s.id) AS invited,
              (SELECT COUNT(*)::int FROM engagement.invitations i WHERE i.survey_id=s.id AND i.completed_at IS NOT NULL) AS completed
         FROM engagement.surveys s WHERE s.tenant_id=$1 ${admin ? '' : "AND s.status IN ('open','closed')"}
        ORDER BY s.created_at DESC`, [T(req)]);
    res.json({ surveys: r.rows, admin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/surveys', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title required' });
    const bad = validateTrigger(b) || validateKind(b) || validateRule(b.audience_rule);
    if (bad) return res.status(422).json({ error: bad });
    const kind = b.audience_kind === 'manager_about_reportee' ? 'manager_about_reportee' : 'self';
    // A manager assessment is never anonymous — see the constraint in
    // migration 057. Forced here as well so the refusal is a sentence
    // rather than a database error.
    const anon = kind === 'manager_about_reportee' ? false : b.anonymity_default;
    const rule = normaliseRule(b.audience_rule);
    const s = (await db.query(
      `INSERT INTO engagement.surveys (tenant_id, title, survey_type, description, target_audience,
         audience_rule, audience_kind, trigger_type, trigger_day, trigger_window_days,
         anonymity_default, allow_attribution_optin, closes_at, created_by)
       VALUES ($1,$2,COALESCE($3,'pulse'),$4,'rule',$5,$6,COALESCE($7,'manual'),$8,COALESCE($9,7),
               COALESCE($10,true),COALESCE($11,true),$12,$13) RETURNING *`,
      [T(req), b.title, b.survey_type || null, b.description || null,
       JSON.stringify(rule), kind, b.trigger_type || null,
       b.trigger_type === 'tenure' ? Number(b.trigger_day) : null,
       b.trigger_window_days == null ? null : Number(b.trigger_window_days),
       anon, b.allow_attribution_optin, b.closes_at || null, req.user.email])).rows[0];
    const qs = Array.isArray(b.questions) ? b.questions : [];
    let i = 0;
    for (const q of qs) {
      if (!q.prompt) continue;
      // An option list is what makes a choice question a choice
      // question. Saving one without options would render as an empty
      // box the employee cannot answer, so it is refused here rather
      // than discovered by the first person to open the survey.
      const opts = cleanOptions(q.options);
      if ((q.qtype === 'choice' || q.qtype === 'multi') && opts.length < 2) {
        return res.status(422).json({ error: `"${String(q.prompt).slice(0, 60)}" is a ${q.qtype} question, so it needs at least two options.` });
      }
      await db.query(
        `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order, dimension)
         VALUES ($1,$2,COALESCE($3,'scale'),$4,$5,COALESCE($6,true),$7,$8)`,
        [T(req), s.id, q.qtype || null, q.prompt, opts.length ? JSON.stringify(opts) : null,
         q.required, (i += 10), q.dimension || null]);
    }
    audit(req, 'SURVEY_CREATED', { survey: s.id, title: s.title, trigger: s.trigger_type,
      audience: describeRule(rule), questions: qs.length });
    res.json({ ok: true, survey: s });
  } catch (e) { logger.error('survey create', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// PUT the audience/trigger/settings of a DRAFT. Once a survey is open,
// people have been invited against a stated audience and changing it
// underneath them would make the participation rate meaningless.
router.put('/surveys/:id', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const cur = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!cur) return res.status(404).json({ error: 'survey not found' });
    if (cur.status !== 'draft') {
      // Names questions as well as audience since 28 Sep, when the
      // editor learned to change them: a refusal that mentions only
      // the audience reads as though the questions were editable.
      return res.status(409).json({ error: `This survey is already ${cur.status}, so its questions and audience are fixed. People have been invited against what it says now; create a new one to change it.` });
    }
    const b = req.body || {};
    const bad = validateTrigger({ ...cur, ...b })
      || (b.audience_rule === undefined ? null : validateRule(b.audience_rule));
    if (bad) return res.status(422).json({ error: bad });
    const rule = normaliseRule(b.audience_rule === undefined ? cur.audience_rule : b.audience_rule);
    const s = (await db.query(
      `UPDATE engagement.surveys SET title=COALESCE($3,title), survey_type=COALESCE($4,survey_type),
         description=COALESCE($5,description), audience_rule=$6,
         trigger_type=COALESCE($7,trigger_type), trigger_day=$8,
         trigger_window_days=COALESCE($9,trigger_window_days),
         anonymity_default=COALESCE($10,anonymity_default),
         allow_attribution_optin=COALESCE($11,allow_attribution_optin),
         closes_at=COALESCE($12,closes_at)
       WHERE id=$1 AND tenant_id=$2 RETURNING *`,
      [cur.id, T(req), b.title || null, b.survey_type || null, b.description || null,
       JSON.stringify(rule), b.trigger_type || null,
       (b.trigger_type || cur.trigger_type) === 'tenure'
         ? Number(b.trigger_day == null ? cur.trigger_day : b.trigger_day) : null,
       b.trigger_window_days == null ? null : Number(b.trigger_window_days),
       b.anonymity_default, b.allow_attribution_optin, b.closes_at || null])).rows[0];
    // ---- the questions, when the caller sent them ------------------
    //
    // Asked for on 28 Sep: "provide edit option during previewing
    // surveys." The preview shows two things — who it goes to and what
    // they will be asked — so an edit that could only reach the first
    // of them would be half the feature.
    //
    // ABSENT means "leave them alone"; an empty array would mean
    // "delete every question", which is not something a PUT that only
    // meant to rename a survey should ever do by omission.
    //
    // Replace-all rather than a per-question diff: the editor hands
    // over the whole list in its new order, and matching up ids to
    // work out what moved would be more code for the same result. Safe
    // here ONLY because this is a draft — the guard above has already
    // refused anything else, and nothing can have answered a draft, so
    // no response is orphaned.
    let questionsWritten = null;
    if (Array.isArray(b.questions)) {
      const rows = b.questions.filter((q) => q && String(q.prompt || '').trim());
      if (!rows.length) {
        return res.status(422).json({ error: 'A survey needs at least one question.' });
      }
      // Validated BEFORE the delete, so a bad option list cannot leave
      // the survey with no questions at all.
      for (const q of rows) {
        const opts = cleanOptions(q.options);
        if ((q.qtype === 'choice' || q.qtype === 'multi') && opts.length < 2) {
          return res.status(422).json({ error: `"${String(q.prompt).slice(0, 60)}" is a ${q.qtype} question, so it needs at least two options.` });
        }
      }
      await db.query(`DELETE FROM engagement.questions WHERE survey_id=$1 AND tenant_id=$2`, [cur.id, T(req)]);
      let i = 0;
      for (const q of rows) {
        const opts = cleanOptions(q.options);
        await db.query(
          `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order, dimension)
           VALUES ($1,$2,COALESCE($3,'scale'),$4,$5,COALESCE($6,true),$7,$8)`,
          [T(req), cur.id, q.qtype || null, String(q.prompt).trim(),
           opts.length ? JSON.stringify(opts) : null, q.required, (i += 10), q.dimension || null]);
      }
      questionsWritten = rows.length;
    }

    audit(req, 'SURVEY_UPDATED', { survey: s.id, audience: describeRule(rule), trigger: s.trigger_type,
      ...(questionsWritten == null ? {} : { questions: questionsWritten }) });
    res.json({ ok: true, survey: s, ...(questionsWritten == null ? {} : { questions: questionsWritten }) });
  } catch (e) { logger.error('survey update', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---- insights (phase 5) ----------------------------------------------
//
// Sections 20 to 25: the red-flag engine, the 30/60/90 trend, the
// onboarding dashboard, and survey data read against PMS data. No
// Listening Agent — excluded by Mindgate, and nothing here drafts or
// infers: every number is arithmetic over stored answers, and every
// flag names the rule and the threshold that produced it.
//
// Only ATTRIBUTED responses can appear. An anonymous survey's answers
// are not joined to anybody anywhere in this file, which is why the
// query below filters on employee_id IS NOT NULL rather than relying
// on the caller to remember.
async function scoredAnswers(tenantId, { employeeId, since, templateKeys } = {}) {
  const params = [tenantId];
  let where = `r.tenant_id=$1 AND r.employee_id IS NOT NULL`;
  if (employeeId) { params.push(employeeId); where += ` AND r.employee_id=$${params.length}`; }
  if (templateKeys && templateKeys.length) {
    params.push(templateKeys); where += ` AND s.template_key = ANY($${params.length})`;
  }
  if (since) { params.push(since); where += ` AND r.submitted_at >= $${params.length}`; }
  return (await db.query(
    `SELECT r.id AS response_id, r.employee_id, r.subject_employee_id, r.submitted_at,
            s.id AS survey_id, s.title, s.template_key, s.audience_kind, s.trigger_day,
            q.prompt, q.qtype, q.dimension, a.value_num, a.value_text, a.value_list
       FROM engagement.responses r
       JOIN engagement.surveys s ON s.id=r.survey_id
       JOIN engagement.answers a ON a.response_id=r.id
       JOIN engagement.questions q ON q.id=a.question_id
      WHERE ${where}
      ORDER BY r.submitted_at`, params)).rows;
}

const loadRules = async (tenantId) => {
  const have = (await db.query(
    `SELECT * FROM engagement.flag_rules WHERE tenant_id=$1 AND active ORDER BY sort_order`, [tenantId])).rows;
  if (have.length) return have;
  await seedFlagRules(db, tenantId);
  return (await db.query(
    `SELECT * FROM engagement.flag_rules WHERE tenant_id=$1 AND active ORDER BY sort_order`, [tenantId])).rows;
};

// On a manager assessment the answers are ABOUT the subject, so that
// is who the flag belongs to. On a self survey it is the respondent.
const subjectOf = (row) => row.subject_employee_id || row.employee_id;

// Where a reading sits on the 30/60/90 line. A lifecycle survey
// carries its day on the row; one run by hand from the same template
// does not, and would otherwise have no milestone and land out of
// order on the trend. The template key is the fallback, because "Day
// 30 Connect sent manually" is still the day-30 reading.
const MILESTONE_BY_TEMPLATE = { day_1: 0, week_1: 5, day_30: 30, day_60: 60, day_90: 90,
  manager_30: 30, manager_60: 60, manager_90: 90 };
const milestoneOf = (row) => (row.trigger_day != null ? row.trigger_day
  : (MILESTONE_BY_TEMPLATE[row.template_key] ?? null));

// The red/amber list. One row per person, worst severity first, each
// carrying the rule, the action and who owns it.
router.get('/insights/flags', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const rules = await loadRules(T(req));
    const rows = await scoredAnswers(T(req));
    const byPerson = new Map();
    for (const r of rows) {
      const id = subjectOf(r);
      if (!byPerson.has(id)) byPerson.set(id, []);
      byPerson.get(id).push(r);
    }
    const people = [];
    for (const [employee_id, answers] of byPerson) {
      const flags = flagsFor(answers, rules);
      if (!flags.length) continue;
      people.push({ employee_id, severity: worst(flags), flags: groupFlags(flags),
        raised: flags.length,
        last_answered: answers[answers.length - 1].submitted_at });
    }
    if (!people.length) return res.json({ people: [], counts: { red: 0, amber: 0 }, rules: rules.length });
    const names = new Map((await db.query(
      `SELECT id, name, department, designation, manager_id FROM core.employees WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
      [T(req), people.map((p) => p.employee_id)])).rows.map((e) => [e.id, e]));
    const mgrs = new Map((await db.query(
      `SELECT id, name FROM core.employees WHERE tenant_id=$1`, [T(req)])).rows.map((e) => [e.id, e.name]));
    const out = people.map((p) => {
      const e = names.get(p.employee_id) || {};
      return { ...p, name: e.name, department: e.department, designation: e.designation,
        manager: e.manager_id ? mgrs.get(e.manager_id) : null };
    }).sort((a, b) => (a.severity === b.severity ? b.flags.length - a.flags.length
      : a.severity === 'red' ? -1 : 1));
    res.json({ people: out, rules: rules.length,
      counts: { red: out.filter((p) => p.severity === 'red').length,
        amber: out.filter((p) => p.severity === 'amber').length } });
  } catch (e) { logger.error('insights flags', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// One person's 30/60/90 trend, plus everything flagged about them.
router.get('/insights/employee/:employeeId', async (req, res) => {
  try {
    const isAdmin = await hasPermission(req.user, 'engagement_admin');
    const target = req.params.employeeId;
    // A manager may read their own reportee; nobody else may read
    // anybody. This is an assessment record, not a directory entry.
    if (!isAdmin) {
      const mine = (await db.query(
        `SELECT 1 FROM core.employees WHERE tenant_id=$1 AND id=$2 AND manager_id=$3`,
        [T(req), target, req.user.id])).rows[0];
      if (!mine) return res.status(403).json({ error: 'You can only read your own reportees' });
    }
    const emp = (await db.query(
      `SELECT id, name, department, designation, date_of_joining, status, last_appraisal_rating
         FROM core.employees WHERE tenant_id=$1 AND id=$2`, [T(req), target])).rows[0];
    if (!emp) return res.status(404).json({ error: 'No such employee' });

    const rows = (await scoredAnswers(T(req))).filter((r) => subjectOf(r) === target);
    const byResponse = new Map();
    for (const r of rows) {
      if (!byResponse.has(r.response_id)) {
        byResponse.set(r.response_id, { milestone: milestoneOf(r), label: r.title,
          taken_at: r.submitted_at, template_key: r.template_key,
          audience_kind: r.audience_kind, answers: [] });
      }
      byResponse.get(r.response_id).answers.push(r);
    }
    const readings = [...byResponse.values()];
    const rules = await loadRules(T(req));
    const flags = flagsFor(rows, rules);
    res.json({ employee: emp, ...trend(readings), flags: groupFlags(flags),
      raised: flags.length, severity: worst(flags),
      readings: readings.map((r) => ({ label: r.label, milestone: r.milestone,
        taken_at: r.taken_at, audience_kind: r.audience_kind,
        overall: overallScore(scoreByDimension(r.answers)) })) });
  } catch (e) { logger.error('insights employee', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// The new-hire dashboard: the index per dimension and the blockers
// people actually named, across everyone who answered a lifecycle
// survey.
const LIFECYCLE = ['day_1', 'week_1', 'day_30', 'day_60', 'day_90'];
router.get('/insights/new-hire', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const rows = await scoredAnswers(T(req), { templateKeys: LIFECYCLE });
    const byPerson = new Map();
    for (const r of rows) {
      const id = subjectOf(r);
      if (!byPerson.has(id)) byPerson.set(id, { employee_id: id, answers: [] });
      byPerson.get(id).answers.push(r);
    }
    const index = newHireIndex([...byPerson.values()]);
    // Participation across the lifecycle surveys, so an index built on
    // four answers cannot be mistaken for the voice of the intake.
    const part = (await db.query(
      `SELECT s.template_key, count(*)::int AS invited, count(i.completed_at)::int AS completed
         FROM engagement.invitations i JOIN engagement.surveys s ON s.id=i.survey_id
        WHERE i.tenant_id=$1 AND s.template_key = ANY($2) GROUP BY 1`, [T(req), LIFECYCLE])).rows;
    res.json({ ...index, participation: part });
  } catch (e) { logger.error('insights new-hire', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Section 25: what later happened to the people who scored low.
router.get('/insights/outcomes', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const dimension = req.query.dimension || null;
    const rows = await scoredAnswers(T(req), { templateKeys: LIFECYCLE });
    const byPerson = new Map();
    for (const r of rows) {
      const id = subjectOf(r);
      if (!byPerson.has(id)) byPerson.set(id, []);
      byPerson.get(id).push(r);
    }
    if (!byPerson.size) return res.json({ dimension, bands: [], unscored: 0, has_ratings: false, people: 0 });
    const emps = new Map((await db.query(
      `SELECT id, name, status, archived_at, last_appraisal_rating FROM core.employees
        WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
      [T(req), [...byPerson.keys()]])).rows.map((e) => [e.id, e]));
    const scored = [...byPerson.entries()].map(([id, answers]) => {
      const byDim = scoreByDimension(answers);
      const e = emps.get(id) || {};
      return { employee_id: id, name: e.name,
        score: dimension ? (byDim[dimension] ?? null) : overallScore(byDim),
        rating: e.last_appraisal_rating || null,
        left: e.status === 'inactive' || !!e.archived_at };
    });
    res.json({ dimension: dimension || 'overall', people: scored.length, ...outcomeByBand(scored) });
  } catch (e) { logger.error('insights outcomes', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// The thresholds themselves, so HR can see what the colours mean.
router.get('/insights/rules', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    res.json({ rules: await loadRules(T(req)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- the survey library (phase 3) ------------------------------------
//
// Asked for on 25 Sep: HR picks "Day 30 Connect" rather than typing
// twenty questions. The rows are per-tenant and editable, so this
// reads them rather than the file they were seeded from.
// A tenant created after the migration ran has no library until
// something seeds it. Called by BOTH the picker and the use endpoint:
// it used to be only the picker, so using a template by key — which is
// what an API caller or a deep link does — failed on a fresh tenant
// with "No such template". Idempotent.
async function ensureTemplates(tenantId) {
  // PER KEY, not "does this tenant have any".
  //
  // Found on 28 Sep by driving the new Customer Feedback template
  // through the real flow instead of trusting the unit tests: it was
  // in the code, its tests passed, and it was invisible on every
  // tenant that already had templates — which is all of them. The old
  // guard was `if (have) return 0`, so the FIRST template a tenant
  // ever received was also the last. seedTemplates() has always been
  // per-key idempotent (ON CONFLICT DO NOTHING, and its header says
  // so); it simply was never called again.
  //
  // Migrations cannot cover this: 056 and 057 seed at migrate time and
  // never run twice, so a template added in code afterwards has no
  // other way in.
  //
  // A tenant's OWN edits are safe — ON CONFLICT DO NOTHING means an
  // existing key is left exactly as they have it.
  const have = new Set((await db.query(
    `SELECT key FROM engagement.survey_templates WHERE tenant_id=$1`, [tenantId])).rows.map((r) => r.key));
  const missing = SHIPPED_TEMPLATES.filter((t) => !have.has(t.key)).map((t) => t.key);
  if (!missing.length) return 0;
  const n = await seedTemplates(db, tenantId);
  logger.info('survey templates seeded on demand', { tenant: tenantId, inserted: n, missing });
  return n;
}

router.get('/templates', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    await ensureTemplates(T(req));
    const rows = (await db.query(
      `SELECT id, key, category, title, description, trigger_type, trigger_day, trigger_window_days,
              anonymity_default, audience_rule, audience_kind, questions, blocked_reason, sort_order,
              jsonb_array_length(questions) AS question_count
         FROM engagement.survey_templates
        WHERE tenant_id=$1 AND active ORDER BY sort_order, title`, [T(req)])).rows;
    // How many times each has been used, so HR can see which of these
    // are live practice and which have never been run.
    const used = (await db.query(
      `SELECT template_key, count(*)::int AS n FROM engagement.surveys
        WHERE tenant_id=$1 AND template_key IS NOT NULL GROUP BY 1`, [T(req)])).rows;
    const byKey = Object.fromEntries(used.map((u) => [u.template_key, u.n]));
    res.json({ templates: rows.map((r) => ({ ...r, used: byKey[r.key] || 0 })) });
  } catch (e) { logger.error('survey templates', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Creates a DRAFT from a template. Nothing is released — the draft
// lands on the list like any other and still has to be opened, so HR
// reads the twenty questions before 1,400 people do.
//
// Overrides let the audience and milestone be set at the same time,
// because "Day 30 Connect, Development only" is one decision and
// should not be two screens.
router.post('/templates/:key/use', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    await ensureTemplates(T(req));
    const tpl = (await db.query(
      `SELECT * FROM engagement.survey_templates WHERE tenant_id=$1 AND key=$2 AND active`,
      [T(req), req.params.key])).rows[0];
    if (!tpl) return res.status(404).json({ error: 'No such template' });

    const b = req.body || {};
    const merged = {
      trigger_type: b.trigger_type || tpl.trigger_type,
      trigger_day: b.trigger_day == null ? tpl.trigger_day : b.trigger_day,
      trigger_window_days: b.trigger_window_days == null ? tpl.trigger_window_days : b.trigger_window_days,
    };
    const bad = validateTrigger(merged);
    if (bad) return res.status(422).json({ error: bad });
    const rule = normaliseRule(b.audience_rule === undefined ? tpl.audience_rule : b.audience_rule);
    const kind = tpl.audience_kind === 'manager_about_reportee' ? 'manager_about_reportee' : 'self';
    // A manager assessment is never anonymous, whatever the caller asks
    // for — the record names both people by construction.
    const anon = kind === 'manager_about_reportee' ? false
      : (b.anonymity_default == null ? tpl.anonymity_default : !!b.anonymity_default);

    const s = (await db.query(
      `INSERT INTO engagement.surveys (tenant_id, title, survey_type, description, target_audience,
         audience_rule, audience_kind, trigger_type, trigger_day, trigger_window_days,
         anonymity_default, allow_attribution_optin, template_key, created_by)
       VALUES ($1,$2,'pulse',$3,'rule',$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING *`,
      [T(req), b.title || tpl.title, tpl.description || null, JSON.stringify(rule), kind,
       merged.trigger_type, merged.trigger_type === 'tenure' ? merged.trigger_day : null,
       merged.trigger_window_days, anon, tpl.key, req.user.email])).rows[0];

    const qs = Array.isArray(tpl.questions) ? tpl.questions : [];
    // A question may ask for its options to come from the TENANT rather
    // than from the template. The only one today is "which team would
    // you like to recognise?", and it matters: a kudos naming a team
    // that is not a department on the employee master can never be
    // shown to the people it was meant for, and showing it on their My
    // KRAs is the whole point of the feature. Naming the real
    // departments makes the match exact by construction instead of by
    // hoping HR typed the same words.
    //
    // Falls back to the template's own list when the master has no
    // departments yet, because a survey with an empty option list is
    // worse than one with generic options.
    let fromMaster = null;
    if (qs.some((q) => q.options_from === 'departments')) {
      fromMaster = (await db.query(
        `SELECT DISTINCT department AS v FROM core.employees
          WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL
            AND coalesce(trim(department),'') <> '' ORDER BY v`, [T(req)])).rows.map((r) => r.v);
      if (!fromMaster.length) fromMaster = null;
    }
    let i = 0;
    for (const q of qs) {
      const opts = cleanOptions(
        q.options_from === 'departments' && fromMaster ? fromMaster : q.options);
      await db.query(
        `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order, dimension)
         VALUES ($1,$2,COALESCE($3,'scale'),$4,$5,COALESCE($6,true),$7,$8)`,
        [T(req), s.id, q.qtype || null, q.prompt, opts.length ? JSON.stringify(opts) : null,
         q.required, (i += 10), q.dimension || null]);
    }
    audit(req, 'SURVEY_CREATED_FROM_TEMPLATE', { survey: s.id, template: tpl.key,
      title: s.title, questions: qs.length, audience: describeRule(rule), trigger: s.trigger_type });
    res.json({ ok: true, survey: s, questions: qs.length, template: tpl.key });
  } catch (e) { logger.error('use template', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// "How many people would this reach?" — answered before anything is
// written, from the same resolver the release uses. Takes an unsaved
// rule from the builder, so the count moves as HR edits it.
router.post('/audience/preview', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const b = req.body || {};
    const bad = validateTrigger(b) || validateKind(b) || validateRule(b.audience_rule);
    if (bad) return res.status(422).json({ error: bad });
    const a = await resolveAudience(T(req), b);
    res.json({ count: a.count, description: a.description, no_joining_date: a.no_joining_date,
      kind: a.kind, managers: a.managers, no_manager: a.no_manager || 0,
      manager_inactive: a.manager_inactive || 0,
      sample: a.employees.slice(0, 8).map((e) => e.name) });
  } catch (e) { logger.error('audience preview', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Named individuals, searched rather than listed. Asked for on 28 Sep:
// "HR should have option to select who it goes to, either employee or
// team or department."
//
// WHY THIS IS A SEARCH AND NOT A LIST. /audience/options returns every
// department and every manager because those are tens of values. The
// employee master on this instance holds 1,427 active people; shipping
// all of them into a dropdown is a slow page and an unusable control.
// So HR types, and this answers — capped, because a query that matches
// everybody should return a usable page and say there are more, not
// 1,427 rows.
router.get('/audience/employees', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const q = String(req.query.q == null ? '' : req.query.q).trim();
    const ids = String(req.query.ids == null ? '' : req.query.ids).split(',')
      .map((x) => x.trim()).filter(Boolean).slice(0, 200);

    // Re-opening a saved rule has to show NAMES, not the uuids it
    // stores, so the picker can resolve the ids it was handed even
    // when they match no search text.
    if (ids.length) {
      const bad = validateRule({ employee_ids: ids });
      if (bad) return res.status(422).json({ error: bad });
      const rows = (await db.query(
        `SELECT id, name, email, emp_code, department, designation FROM core.employees
          WHERE tenant_id=$1 AND id = ANY($2::uuid[]) ORDER BY name`, [T(req), ids])).rows;
      return res.json({ employees: rows, total: rows.length, capped: false });
    }

    const LIMIT = 25;
    const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const where = `tenant_id=$1 AND status='active' AND archived_at IS NULL`
      + (q ? ` AND (name ILIKE $2 OR email ILIKE $2 OR coalesce(emp_code,'') ILIKE $2)` : '');
    const params = q ? [T(req), like] : [T(req)];
    const total = +(await db.query(
      `SELECT count(*)::int AS n FROM core.employees WHERE ${where}`, params)).rows[0].n;
    const rows = (await db.query(
      `SELECT id, name, email, emp_code, department, designation FROM core.employees
        WHERE ${where} ORDER BY name LIMIT ${LIMIT}`, params)).rows;
    // `capped` rather than silence: a picker that shows 25 of 1,427
    // and says nothing reads as "these are the only matches".
    res.json({ employees: rows, total, capped: total > rows.length });
  } catch (e) { logger.error('audience employees', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// The values HR can pick from, straight off the employee master, so a
// rule can never name a department nobody is in.
router.get('/audience/options', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const col = async (c) => (await db.query(
      `SELECT DISTINCT ${c} AS v FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL
          AND coalesce(btrim(${c}),'') <> '' ORDER BY 1`, [T(req)])).rows.map((r) => r.v);
    const managers = (await db.query(
      `SELECT DISTINCT m.id, m.name FROM core.employees e JOIN core.employees m ON m.id=e.manager_id
        WHERE e.tenant_id=$1 AND e.status='active' AND e.archived_at IS NULL ORDER BY m.name`,
      [T(req)])).rows;
    res.json({ departments: await col('department'), designations: await col('designation'),
      role_bands: await col('role_band'), managers, milestones: MILESTONES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helpers shared by create, update and preview.
function cleanOptions(v) {
  if (!Array.isArray(v)) return [];
  const out = v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
  return [...new Set(out)].slice(0, 40);
}

// 'self' or 'manager_about_reportee'. Anything else is a typo in a
// client, and silently treating it as 'self' would send an assessment
// to the people it was meant to be about.
function validateKind(b) {
  const k = b.audience_kind;
  if (k == null || k === 'self' || k === 'manager_about_reportee') return null;
  return `Unknown audience "${k}" — use "self" or "manager_about_reportee".`;
}

// A trigger that cannot fire is worse than no trigger: the survey sits
// open looking released while reaching nobody, forever.
function validateTrigger(b) {
  const t = b.trigger_type || 'manual';
  if (t === 'manual') return null;
  if (t !== 'tenure') return `Unknown trigger "${t}" — use "manual" or "tenure".`;
  // Number(null) is 0, not NaN — so a missing day used to validate as
  // "Day 1", pass this check, and then be written as NULL, which the
  // table's own constraint rejected as a 500 instead of a sentence.
  // Absence is checked before the number is read.
  if (b.trigger_day == null || b.trigger_day === '') {
    return 'A lifecycle survey needs a milestone — the number of days after joining it should go out (0 to 3650).';
  }
  const day = Number(b.trigger_day);
  if (!Number.isFinite(day) || day < 0 || day > 3650) {
    return 'A lifecycle survey needs a milestone — the number of days after joining it should go out (0 to 3650).';
  }
  const win = b.trigger_window_days == null ? 7 : Number(b.trigger_window_days);
  if (!Number.isFinite(win) || win < 1 || win > 90) {
    return 'The catch-up window must be between 1 and 90 days. It is what stops the survey missing anyone whose exact day fell between two sweeps.';
  }
  return null;
}

// Writes invitations for everyone the rule matches who has not been
// invited already, and notifies only the new ones. Idempotent: the
// invitations primary key is (survey_id, employee_id), so running this
// twice invites nobody twice. Shared by the manual release and the
// daily sweep, because a lifecycle survey must invite the same way on
// day one as it does three months later.
async function inviteAudience(tenantId, survey) {
  const a = await resolveAudience(tenantId, survey);
  let invited = 0;
  for (const { recipient, subject } of a.pairs) {
    const r = await db.query(
      `INSERT INTO engagement.invitations (tenant_id, survey_id, employee_id, subject_employee_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [tenantId, survey.id, recipient.id, subject ? subject.id : null]);
    if (r.rows.length) {
      invited++;
      // A manager needs to know WHO the survey is about before they
      // open it — four notifications that all say "Day 30 Review" and
      // nothing else is four identical rows in their inbox.
      const label = subject ? `${survey.title}: ${subject.name}` : `Survey: ${survey.title}`;
      await notify(tenantId, recipient.id, 'survey_open', label, null, '/engagement');
    }
  }
  return { invited, matched: a.count, description: a.description,
    no_joining_date: a.no_joining_date, no_manager: a.no_manager || 0,
    manager_inactive: a.manager_inactive || 0, managers: a.managers };
}

// Release. For a manual survey this is the whole story: the audience is
// resolved once, everyone in it is invited, done.
//
// For a TENURE survey this activates the trigger. The survey stays open
// and the daily sweep keeps inviting people as they reach the window,
// so "Day 30 Connect" catches this week's joiners and next month's
// without HR pressing anything again. The people already inside the
// window on the day of release are invited immediately, which is why
// this and the sweep call the same function.
// Read a survey before releasing it.
//
// Asked for on 28 Sep, on a screenshot of the survey list: "provide
// option of viewing draft before opening the survey to employees."
//
// Open is irreversible in the way that matters — it writes an
// invitation row per person and, on this instance, 1,426 notifications.
// Until now the only way to read what those people would be asked was
// to open it and look, which is the one thing HR wanted to avoid.
//
// Deliberately returns BOTH halves of the decision:
//   questions  what the employee will be asked, in order, with the
//              options they will actually see
//   audience   who it goes to and how many, resolved through the SAME
//              resolveAudience() that open uses — a preview computed a
//              different way would be a second implementation to drift
//
// Audience resolution can fail on a malformed rule. That must not take
// the questions down with it: reading the survey is the point, the
// count is the bonus, so the failure is reported in the payload rather
// than thrown.
router.get('/surveys/:id/preview', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const s = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`,
      [req.params.id, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'survey not found' });

    const questions = (await db.query(
      `SELECT id, qtype, prompt, options, required, sort_order
         FROM engagement.questions WHERE survey_id=$1 ORDER BY sort_order`, [s.id])).rows;

    let audience = null;
    try {
      const a = await resolveAudience(T(req), s);
      audience = { count: a.count, description: a.description, kind: a.kind,
        no_joining_date: a.no_joining_date, no_manager: a.no_manager || 0,
        manager_inactive: a.manager_inactive || 0,
        sample: a.employees.slice(0, 8).map((e) => e.name) };
    } catch (e) {
      audience = { error: e.message };
    }

    // The same two refusals `open` makes, said BEFORE the button is
    // pressed rather than after. A survey with no questions, or one
    // whose rule currently matches nobody, is the thing a preview
    // exists to catch.
    const blockers = [];
    if (!questions.length) blockers.push('No questions yet — add at least one before opening.');
    if (audience && !audience.error && audience.count === 0) {
      blockers.push('Nobody matches the audience rule today — opening it would invite no one.');
    }

    res.json({
      survey: {
        id: s.id, title: s.title, description: s.description, status: s.status,
        anonymous: s.anonymity_default, audience_kind: s.audience_kind,
        trigger_type: s.trigger_type, trigger_day: s.trigger_day,
        trigger_window_days: s.trigger_window_days,
        // The rule itself, so the editor can open showing what is
        // actually set rather than an empty picker that would silently
        // widen the audience the moment it was saved. Normalised, so
        // the editor never has to cope with an old row's shape.
        audience_rule: normaliseRule(s.audience_rule),
      },
      questions, audience, blockers,
      already_invited: +(await db.query(
        `SELECT COUNT(*) c FROM engagement.invitations WHERE survey_id=$1`, [s.id])).rows[0].c,
    });
  } catch (e) { logger.error('survey preview', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.post('/surveys/:id/open', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const s = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'survey not found' });
    const qn = +(await db.query(`SELECT COUNT(*) c FROM engagement.questions WHERE survey_id=$1`, [s.id])).rows[0].c;
    if (!qn) return res.status(422).json({ error: 'Add at least one question before opening' });

    await db.query(`UPDATE engagement.surveys SET status='open', opens_at=COALESCE(opens_at, now()) WHERE id=$1`, [s.id]);
    const r = await inviteAudience(T(req), { ...s, status: 'open' });
    await db.query(`UPDATE engagement.surveys SET last_swept_at=now(), swept_count=swept_count+1 WHERE id=$1`, [s.id]);
    audit(req, 'SURVEY_OPENED', { survey: s.id, title: s.title, trigger: s.trigger_type,
      audience: r.description, invited: r.invited, matched: r.matched });
    logger.info('survey opened', { survey: s.id, invited: r.invited, trigger: s.trigger_type });
    res.json({ ok: true, invited: r.invited, audience_size: r.matched,
      audience: r.description, no_joining_date: r.no_joining_date,
      no_manager: r.no_manager, manager_inactive: r.manager_inactive, managers: r.managers,
      kind: s.audience_kind, standing: s.trigger_type === 'tenure' });
  } catch (e) { logger.error('survey open', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// The daily sweep. Every OPEN tenure survey re-resolves its window and
// invites whoever has walked into it since yesterday. Exported for
// server/index.js, which runs it at boot and once a day — the same
// boot-then-daily shape as the KRA reminders, and for the same reason:
// this deploy has no worker service, and a missed day must be caught up
// rather than lost. The window (default 7 days) is what makes catching
// up possible at all.
async function sweepTenureSurveys(tenantId) {
  const surveys = (await db.query(
    `SELECT * FROM engagement.surveys
      WHERE tenant_id=$1 AND status='open' AND trigger_type='tenure'
        AND (closes_at IS NULL OR closes_at > now())`, [tenantId])).rows;
  const out = { surveys: surveys.length, invited: 0, per_survey: [] };
  for (const s of surveys) {
    try {
      const r = await inviteAudience(tenantId, s);
      await db.query(`UPDATE engagement.surveys SET last_swept_at=now(), swept_count=swept_count+1 WHERE id=$1`, [s.id]);
      out.invited += r.invited;
      out.per_survey.push({ id: s.id, title: s.title, invited: r.invited, matched: r.matched });
      if (r.invited) {
        await db.query(
          `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
           VALUES ($1,'system','SURVEY_SWEEP_INVITED','engagement.survey',$2)`,
          [tenantId, JSON.stringify({ survey: s.id, title: s.title, invited: r.invited, audience: r.description })]);
        logger.info('survey sweep invited', { survey: s.id, title: s.title, invited: r.invited });
      }
    } catch (e) {
      // One broken survey must not stop the others going out.
      logger.error('survey sweep failed', { survey: s.id, error: e.message });
      out.per_survey.push({ id: s.id, title: s.title, error: e.message });
    }
  }
  return out;
}

// HR can run the sweep by hand rather than waiting for tomorrow —
// useful right after creating a lifecycle survey, and the only way to
// see what it does without waiting a day.
router.post('/surveys/sweep', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const r = await sweepTenureSurveys(T(req));
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/surveys/:id/close', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const r = await db.query(`UPDATE engagement.surveys SET status='closed', closes_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING id`, [req.params.id, T(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'survey not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Employee: my invitations + take ---------------------------------------
router.get('/my/invitations', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.id, s.title, s.survey_type, s.description, s.anonymity_default, s.allow_attribution_optin,
              s.audience_kind, i.completed_at,
              i.subject_employee_id, subj.name AS subject_name, subj.designation AS subject_designation
         FROM engagement.invitations i
         JOIN engagement.surveys s ON s.id=i.survey_id
         LEFT JOIN core.employees subj ON subj.id=i.subject_employee_id
        WHERE i.tenant_id=$1 AND i.employee_id=$2 AND s.status='open'
        ORDER BY i.invited_at DESC, subj.name`,
      [T(req), req.user.id]);
    res.json({ invitations: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/surveys/:id/questions', async (req, res) => {
  try {
    const inv = (await db.query(`SELECT 1 FROM engagement.invitations WHERE survey_id=$1 AND employee_id=$2 LIMIT 1`,
      [req.params.id, req.user.id])).rows[0];
    const admin = await hasPermission(req.user, 'engagement_admin');
    if (!inv && !admin) return res.status(403).json({ error: 'Not invited to this survey' });
    const r = await db.query(`SELECT id, qtype, prompt, options, required, sort_order
                                FROM engagement.questions WHERE survey_id=$1 ORDER BY sort_order`, [req.params.id]);
    res.json({ questions: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Submit: THE anonymity-critical path. Body: {answers: {question_id: {num|text}}, attribute: bool}
router.post('/surveys/:id/respond', async (req, res) => {
  const client = await db.getClient();
  try {
    const s = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!s) { return res.status(404).json({ error: 'survey not found' }); }
    if (s.status !== 'open') { return res.status(409).json({ error: 'Survey is not open' }); }
    // WHICH invitation. On a manager survey one person holds several
    // for the same survey, one per reportee, so the subject is part of
    // the identity of the thing being answered. Matching on
    // (survey, me, subject) is also the authorisation check: a manager
    // cannot assess somebody who is not theirs, because no invitation
    // exists for that pair.
    const subjectId = (req.body && req.body.subject_employee_id) || null;
    const inv = (await db.query(
      `SELECT * FROM engagement.invitations
        WHERE survey_id=$1 AND employee_id=$2 AND subject_employee_id IS NOT DISTINCT FROM $3`,
      [s.id, req.user.id, subjectId])).rows[0];
    if (!inv) {
      // Said differently when the person IS invited but named the
      // wrong subject, because "not invited" sends them looking in the
      // wrong place.
      const any = (await db.query(
        `SELECT count(*)::int AS n FROM engagement.invitations WHERE survey_id=$1 AND employee_id=$2`,
        [s.id, req.user.id])).rows[0].n;
      return res.status(403).json({ error: any
        ? 'This survey is not about that employee, or they are not one of your reportees.'
        : 'Not invited to this survey' });
    }
    if (inv.completed_at) { return res.status(409).json({ error: 'Already completed' }); }
    const answers = (req.body && req.body.answers) || {};
    const qs = (await db.query(`SELECT id, qtype, required, options FROM engagement.questions WHERE survey_id=$1`, [s.id])).rows;
    const given = (q) => {
      const a = answers[q.id];
      if (a == null) return false;
      if (q.qtype === 'multi') return Array.isArray(a.list) && a.list.length > 0;
      if (q.qtype === 'choice') return a.text != null && String(a.text).trim() !== '';
      return a.num != null || (a.text != null && String(a.text).trim() !== '');
    };
    const missing = qs.filter(q => q.required && !given(q)).length;
    if (missing) { return res.status(422).json({ error: `${missing} required question(s) unanswered` }); }
    // An answer that is not one of the offered options is a broken
    // client, not a preference. Refused rather than stored, or the
    // tally would grow categories nobody can act on.
    for (const q of qs) {
      if (q.qtype !== 'choice' && q.qtype !== 'multi') continue;
      const allowed = Array.isArray(q.options) ? q.options.map(String) : [];
      if (!allowed.length) continue;
      const picked = q.qtype === 'multi'
        ? ((answers[q.id] && answers[q.id].list) || []).map(String)
        : (answers[q.id] && answers[q.id].text != null ? [String(answers[q.id].text)] : []);
      const stray = picked.find((v) => !allowed.includes(v));
      if (stray) { return res.status(422).json({ error: `"${stray}" is not one of the options for this question.` }); }
    }

    const attributedId = shouldAttribute(s, req.body && req.body.attribute) ? req.user.id : null;
    await client.query('BEGIN');
    const resp = (await client.query(
      `INSERT INTO engagement.responses (tenant_id, survey_id, employee_id, subject_employee_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [T(req), s.id, attributedId, inv.subject_employee_id])).rows[0];
    for (const q of qs) {
      const a = answers[q.id];
      if (a == null) continue;
      const li = q.qtype === 'multi' && Array.isArray(a.list)
        ? a.list.map((x) => String(x).slice(0, 400)).slice(0, 40) : null;
      await client.query(
        `INSERT INTO engagement.answers (response_id, question_id, value_num, value_text, value_list)
         VALUES ($1,$2,$3,$4,$5)`,
        [resp.id, q.id, a.num != null ? Number(a.num) : null,
         a.text != null ? String(a.text).slice(0, 4000) : null, li]);
    }
    // Completion on the INVITATION — never on the response.
    // By invitation id, not by (survey, employee): a manager holds one
    // per reportee and completing one must not mark the rest done.
    await client.query(`UPDATE engagement.invitations SET completed_at=now() WHERE id=$1`, [inv.id]);
    await client.query('COMMIT');
    res.json({ ok: true, attributed: !!attributedId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('survey respond', { error: e.message });
    res.status(500).json({ error: e.message });
  } finally {
    // ONE release, here. Every early return above used to release as
    // well, and the finally then released a second time — pg throws
    // "Release called on client which has already been released to the
    // pool" on the way out. Harmless-looking, because the HTTP reply
    // had already been sent, so it surfaced only as an unhandled
    // rejection in the log while quietly corrupting pool accounting.
    client.release();
  }
});

// ---- Results ----------------------------------------------------------------
// What I SUBMITTED, read back to me.
//
// Asked for on 28 Sep: "remove from MY KRA page and save the submitted
// form in my survey page." This replaces the team-recognition panel
// that briefly sat on My KRAs — the answers a person gave, on the page
// where they gave them.
//
// ANONYMITY IS WHY THIS CANNOT ALWAYS ANSWER, and that is the feature
// working rather than a gap. An anonymous response is stored with
// employee_id NULL; there is no key from a person to their answers, by
// construction, so "show me what I said" has no truthful answer. The
// route says which case it is instead of returning an empty list and
// letting the page imply the answers were lost.
//
// The same applies to an attributed-optional survey where the person
// chose not to be named: same NULL, same honest reply.
router.get('/my/submissions', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT r.id AS response_id, r.survey_id, r.submitted_at, r.subject_employee_id,
              s.title, s.anonymity_default, s.status,
              subj.name AS subject_name
         FROM engagement.responses r
         JOIN engagement.surveys s ON s.id = r.survey_id
         LEFT JOIN core.employees subj ON subj.id = r.subject_employee_id
        WHERE r.tenant_id=$1 AND r.employee_id=$2
        ORDER BY r.submitted_at DESC`, [T(req), req.user.id])).rows;
    if (!rows.length) return res.json({ submissions: [] });

    // One query for every answer across every submission, then grouped
    // in memory — a query per submission is a page that slows down the
    // longer somebody has worked here.
    const ids = rows.map((r) => r.response_id);
    const answers = (await db.query(
      `SELECT a.response_id, q.id AS question_id, q.prompt, q.qtype, q.sort_order,
              a.value_num, a.value_text, a.value_list
         FROM engagement.answers a
         JOIN engagement.questions q ON q.id = a.question_id
        WHERE a.response_id = ANY($1)
        ORDER BY q.sort_order`, [ids])).rows;
    const byResponse = new Map(ids.map((id) => [id, []]));
    for (const a of answers) {
      byResponse.get(a.response_id).push({
        question_id: a.question_id, prompt: a.prompt, qtype: a.qtype,
        // One shaped value rather than three columns the page has to
        // pick between — the question type already decides which one.
        value: a.value_list && a.value_list.length ? a.value_list
          : (a.value_num != null ? Number(a.value_num) : a.value_text),
      });
    }
    res.json({
      submissions: rows.map((r) => ({
        survey_id: r.survey_id, title: r.title, submitted_at: r.submitted_at,
        subject_name: r.subject_name, anonymous: r.anonymity_default, status: r.status,
        answers: byResponse.get(r.response_id) || [],
      })),
    });
  } catch (e) { logger.error('my submissions', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---- Survey results, as a file ---------------------------------------------
//
// Asked for: "we should have export option for results of all surveys
// completed by employees for HR and HRBP role."
//
// ANONYMITY IS THE WHOLE DESIGN HERE, and a spreadsheet is where it is
// most easily lost. Three rules, all enforced below rather than left to
// whoever opens the file:
//
//   1. A per-person sheet exists ONLY for responses that carry an
//      employee_id — which, by the take-flow at the top of this file,
//      means the respondent explicitly asked to be attributed. An
//      unattributed response never appears beside a name, in any sheet.
//
//   2. An aggregate over too few people is not anonymous. Four responses
//      from a six-person team identify everybody in it by elimination, so
//      a cohort below the floor is reported as withheld, with the reason
//      printed in the file rather than silently showing a number.
//
//   3. An HRBP gets THEIR REMIT, and the file says so on the front sheet —
//      so a figure that differs from HR's reads as a different population
//      rather than as a disagreement.
const ANON_FLOOR = 5;

/**
 * The employee ids an HRBP may see, or null for HR (meaning everybody).
 *
 * WRITTEN TWICE. The first version asked whether engagement_admin had
 * been LENT for this request, which was true only while an HRBP reached
 * this page through the gateway alone. Granting the role that permission
 * in its own right — the same change that was meant to stop the feature
 * depending on the lending — made the test read false and handed every
 * partner the whole company. The test now asks the question that actually
 * decides it, and the same one the gateway asks: is this an HR Business
 * Partner rather than HR?
 */
async function exportScope(req) {
  const [isPartner, isAdmin] = await Promise.all([
    hasPermission(req.user, 'pms_hrbp'),
    hasPermission(req.user, 'pms_admin'),
  ]);
  if (!isPartner || isAdmin) return null;
  const people = require('../people');
  const ids = await people.hrbpScope.employeeIdsFor(req.user.tenant_id, req.user.email, { includeInactive: true });
  const remit = await people.hrbpScope.remitFor(req.user.tenant_id, req.user.email);
  return { ids: new Set(ids), remit };
}

router.get('/surveys/:id/results.xlsx', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) {
      return res.status(403).json({ error: "Requires 'engagement_admin'", needs: 'engagement_admin' });
    }
    const t = T(req);
    const s = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [req.params.id, t])).rows[0];
    if (!s) return res.status(404).json({ error: 'survey not found' });
    const scope = await exportScope(req);

    const qs = (await db.query(
      `SELECT id, qtype, prompt, options, sort_order FROM engagement.questions
        WHERE survey_id=$1 ORDER BY sort_order`, [s.id])).rows;
    // Every answer, with the respondent where there is one. The join to
    // responses is the only place identity can enter, and r.employee_id
    // is NULL for anybody who did not opt in.
    const rows = (await db.query(
      `SELECT a.question_id, a.value_num, a.value_text, a.value_list,
              r.id AS response_id, r.employee_id, r.submitted_at,
              e.name AS employee_name, e.email AS employee_email, e.department, e.location
         FROM engagement.responses r
         JOIN engagement.answers a ON a.response_id = r.id
         LEFT JOIN core.employees e ON e.id = r.employee_id
        WHERE r.survey_id=$1`, [s.id])).rows;

    // An HRBP's file covers their own people. An UNATTRIBUTED response
    // cannot be placed in anybody's remit, so it is counted for HR and
    // left out of an HRBP's aggregate rather than guessed at.
    const inScope = (r) => !scope || (r.employee_id && scope.ids.has(r.employee_id));
    const mine = scope ? rows.filter(inScope) : rows;
    const responders = new Set(mine.map((r) => r.response_id));

    const wb = new ExcelJS.Workbook();
    const head = (ws, cells, widths) => {
      const h = ws.addRow(cells); h.font = { bold: true };
      ws.columns.forEach((c, i) => { c.width = widths[i] || 18; });
    };

    // ---- front sheet: what this file is, and what it is not
    const info = wb.addWorksheet('About');
    info.addRow(['Survey', s.title]);
    info.addRow(['Status', s.status]);
    info.addRow(['Exported', new Date().toISOString().slice(0, 16).replace('T', ' ')]);
    info.addRow(['Responses in this file', responders.size]);
    info.addRow(['Scope', scope
      ? `Your remit only — ${(scope.remit.locations || []).join(', ') || 'no locations'}`
        + `${(scope.remit.hods || []).length ? ` · HOD: ${scope.remit.hods.join(', ')}` : ''}`
      : 'The whole company']);
    info.addRow(['Anonymity', s.anonymity_default
      ? 'Anonymous. Only responses where the person asked to be named appear beside a name.'
      : 'Named survey.']);
    info.addRow(['Small cohorts', `An aggregate of fewer than ${ANON_FLOOR} responses is withheld — `
      + 'with that few, an average identifies the people who gave it.']);
    info.columns.forEach((c, i) => { c.width = i ? 90 : 26; });
    info.getColumn(1).font = { bold: true };

    // ---- per question
    const ws = wb.addWorksheet('Questions');
    head(ws, ['#', 'Question', 'Type', 'Responses', 'Average', 'Breakdown'], [6, 60, 12, 12, 12, 70]);
    for (const q of qs) {
      const a = mine.filter((r) => r.question_id === q.id);
      const n = a.filter((r) => r.value_num != null || r.value_text != null || (r.value_list || []).length).length;
      if (n && n < ANON_FLOOR) {
        ws.addRow([q.sort_order, q.prompt, q.qtype, n, '—',
          `withheld — fewer than ${ANON_FLOOR} responses in this scope`]);
        continue;
      }
      if (q.qtype === 'choice' || q.qtype === 'multi') {
        const tally = new Map((Array.isArray(q.options) ? q.options : []).map((o) => [String(o), 0]));
        for (const r of a) {
          const picked = q.qtype === 'multi' ? (r.value_list || []) : (r.value_text != null ? [r.value_text] : []);
          for (const v of picked) tally.set(String(v), (tally.get(String(v)) || 0) + 1);
        }
        ws.addRow([q.sort_order, q.prompt, q.qtype, n, '—',
          [...tally.entries()].sort((x, y) => y[1] - x[1]).map(([o, c]) => `${o}: ${c}`).join(' · ')]);
      } else if (q.qtype === 'text') {
        ws.addRow([q.sort_order, q.prompt, q.qtype, n, '—', 'see the Verbatims sheet']);
      } else {
        const nums = a.map((r) => r.value_num).filter((x) => x != null).map(Number);
        ws.addRow([q.sort_order, q.prompt, q.qtype, nums.length,
          nums.length ? +(nums.reduce((x, y) => x + y, 0) / nums.length).toFixed(2) : '—', '']);
      }
    }

    // ---- free text, never beside a name
    const vs = wb.addWorksheet('Verbatims');
    head(vs, ['Question', 'Answer'], [50, 110]);
    const verbN = mine.filter((r) => r.value_text != null
      && (qs.find((q) => q.id === r.question_id) || {}).qtype === 'text').length;
    if (verbN && verbN < ANON_FLOOR) {
      vs.addRow([`withheld — fewer than ${ANON_FLOOR} written answers in this scope`, '']);
    } else {
      for (const q of qs.filter((x) => x.qtype === 'text')) {
        for (const r of mine.filter((x) => x.question_id === q.id && x.value_text != null)) {
          vs.addRow([q.prompt, r.value_text]);
        }
      }
    }

    // ---- per person, ONLY where the person asked to be named
    const named = mine.filter((r) => r.employee_id);
    const ps = wb.addWorksheet('Named responses');
    head(ps, ['Employee', 'Email', 'Department', 'Location', 'Submitted', 'Question', 'Answer'],
      [26, 30, 22, 16, 18, 50, 60]);
    if (!named.length) {
      // WHY it is empty, not just that it is. Scoped and anonymous are
      // different answers and lead to different next steps — one means
      // "ask a wider remit", the other means "there is nothing to ask for".
      const anyNamedAtAll = rows.some((r) => r.employee_id);
      ps.addRow([scope && anyNamedAtAll
        ? 'Nobody in your remit has a named response on this survey.'
        : 'Nobody asked to be named on this survey, so there is no per-person sheet.',
        '', '', '', '', '', '']);
    } else {
      for (const r of named.sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name)))) {
        const q = qs.find((x) => x.id === r.question_id) || {};
        ps.addRow([r.employee_name, r.employee_email, r.department || '', r.location || '',
          r.submitted_at ? new Date(r.submitted_at).toISOString().slice(0, 16).replace('T', ' ') : '',
          q.prompt || '', r.value_num != null ? r.value_num : (r.value_text || (r.value_list || []).join(', '))]);
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    const safe = String(s.title).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'survey';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}-results.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { logger.error('survey results export', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.get('/surveys/:id/results', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const s = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'survey not found' });
    const part = (await db.query(
      `SELECT COUNT(*)::int AS invited, COUNT(completed_at)::int AS completed
         FROM engagement.invitations WHERE survey_id=$1`, [s.id])).rows[0];
    const qs = (await db.query(`SELECT id, qtype, prompt, options, sort_order FROM engagement.questions WHERE survey_id=$1 ORDER BY sort_order`, [s.id])).rows;
    const out = [];
    for (const q of qs) {
      // Choice and multi are TALLIED. They used to fall through to the
      // numeric branch and report "n=0 · avg" with the answers sitting
      // in the table unread — which hit the most operationally useful
      // question in a 30-day survey, the one naming what is blocking
      // somebody. Counted here, biggest first, with every offered
      // option listed so a zero is visible as a zero.
      if (q.qtype === 'choice' || q.qtype === 'multi') {
        const rows = (await db.query(
          `SELECT value_text, value_list FROM engagement.answers WHERE question_id=$1`, [q.id])).rows;
        const tally = new Map((Array.isArray(q.options) ? q.options : []).map((o) => [String(o), 0]));
        let answered = 0;
        for (const r of rows) {
          const picked = q.qtype === 'multi'
            ? (r.value_list || [])
            : (r.value_text != null ? [r.value_text] : []);
          if (picked.length) answered++;
          for (const v of picked) tally.set(String(v), (tally.get(String(v)) || 0) + 1);
        }
        out.push({ ...q, n: answered,
          tally: [...tally.entries()].map(([option, count]) => ({ option, count,
            pct: answered ? Math.round((count / answered) * 100) : 0 }))
            .sort((a, b) => b.count - a.count || a.option.localeCompare(b.option)) });
        continue;
      }
      if (q.qtype === 'text') {
        const verb = (await db.query(
          `SELECT a.value_text FROM engagement.answers a WHERE a.question_id=$1 AND a.value_text IS NOT NULL LIMIT 200`, [q.id])).rows;
        out.push({ ...q, verbatims: verb.map(v => v.value_text) }); // no identity columns in reach
      } else {
        const nums = (await db.query(
          `SELECT a.value_num FROM engagement.answers a WHERE a.question_id=$1 AND a.value_num IS NOT NULL`, [q.id])).rows.map(r => +r.value_num);
        const avg = nums.length ? +(nums.reduce((x, y) => x + y, 0) / nums.length).toFixed(2) : null;
        out.push({ ...q, n: nums.length, average: avg, enps: q.qtype === 'enps' ? enps(nums) : undefined });
      }
    }
    // A manager assessment is about individuals, so an average across
    // the cohort is the least useful thing in it. The per-subject
    // scorecard is the point: "what did each manager say about each of
    // their new joiners". Only ever built for a manager survey, where
    // both names are on the record by design — a self survey's
    // responses stay unjoined to anybody.
    let subjects;
    if (s.audience_kind === 'manager_about_reportee') {
      const rows = (await db.query(
        `SELECT r.subject_employee_id, subj.name AS subject_name, subj.designation,
                mgr.name AS manager_name, r.submitted_at,
                q.id AS question_id, q.prompt, q.qtype, q.sort_order,
                a.value_num, a.value_text
           FROM engagement.responses r
           JOIN core.employees subj ON subj.id=r.subject_employee_id
           LEFT JOIN core.employees mgr ON mgr.id=r.employee_id
           JOIN engagement.answers a ON a.response_id=r.id
           JOIN engagement.questions q ON q.id=a.question_id
          WHERE r.survey_id=$1 AND r.subject_employee_id IS NOT NULL
          ORDER BY subj.name, q.sort_order`, [s.id])).rows;
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.subject_employee_id)) {
          by.set(r.subject_employee_id, { employee_id: r.subject_employee_id, name: r.subject_name,
            designation: r.designation, manager: r.manager_name, submitted_at: r.submitted_at, answers: [] });
        }
        by.get(r.subject_employee_id).answers.push({ prompt: r.prompt, qtype: r.qtype,
          value: r.value_num != null ? Number(r.value_num) : r.value_text });
      }
      subjects = [...by.values()].map((x) => {
        const nums = x.answers.filter((a) => typeof a.value === 'number').map((a) => a.value);
        return { ...x, average: nums.length ? +(nums.reduce((p, c) => p + c, 0) / nums.length).toFixed(2) : null };
      }).sort((a, b) => (a.average ?? 99) - (b.average ?? 99) || a.name.localeCompare(b.name));
      // Weakest first: the list exists to be acted on, and the person
      // a manager rated lowest is the one HR needs to see.
    }

    res.json({ survey: { id: s.id, title: s.title, survey_type: s.survey_type, status: s.status,
        audience_kind: s.audience_kind },
      participation: { ...part, rate: part.invited ? Math.round((part.completed / part.invited) * 100) : 0 },
      questions: out, ...(subjects ? { subjects } : {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, shouldAttribute, enps, sweepTenureSurveys, validateTrigger, cleanOptions };
