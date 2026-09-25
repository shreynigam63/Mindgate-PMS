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
const db = require('../../core/db');
const logger = require('../../core/logger');
const { authenticate } = require('../../core/auth');
const { guardUuidParams } = require('../../core/http');
const { apiPermissionParity, hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { normaliseRule, audienceSql, describeRule, needsJoiningDate,
        triggerRule, MILESTONES } = require('./audience');
const { seedTemplates } = require('../../migrations/056-survey-templates');

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
async function resolveAudience(tenantId, survey) {
  const rule = triggerRule(survey);
  const { where, params } = audienceSql(rule, { start: 2 });
  const rows = (await db.query(
    `SELECT id, name, email FROM core.employees
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
  return { rule, employees: rows, count: rows.length, no_joining_date: noJoiningDate,
           description: describeRule(rule) };
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
router.use(authenticate, apiPermissionParity);
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
    const bad = validateTrigger(b);
    if (bad) return res.status(422).json({ error: bad });
    const rule = normaliseRule(b.audience_rule);
    const s = (await db.query(
      `INSERT INTO engagement.surveys (tenant_id, title, survey_type, description, target_audience,
         audience_rule, trigger_type, trigger_day, trigger_window_days,
         anonymity_default, allow_attribution_optin, closes_at, created_by)
       VALUES ($1,$2,COALESCE($3,'pulse'),$4,'rule',$5,COALESCE($6,'manual'),$7,COALESCE($8,7),
               COALESCE($9,true),COALESCE($10,true),$11,$12) RETURNING *`,
      [T(req), b.title, b.survey_type || null, b.description || null,
       JSON.stringify(rule), b.trigger_type || null,
       b.trigger_type === 'tenure' ? Number(b.trigger_day) : null,
       b.trigger_window_days == null ? null : Number(b.trigger_window_days),
       b.anonymity_default, b.allow_attribution_optin, b.closes_at || null, req.user.email])).rows[0];
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
        `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order)
         VALUES ($1,$2,COALESCE($3,'scale'),$4,$5,COALESCE($6,true),$7)`,
        [T(req), s.id, q.qtype || null, q.prompt, opts.length ? JSON.stringify(opts) : null,
         q.required, (i += 10)]);
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
      return res.status(409).json({ error: 'This survey is already open, so its audience is fixed. Close it and create a new one to change who it goes to.' });
    }
    const b = req.body || {};
    const bad = validateTrigger({ ...cur, ...b });
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
    audit(req, 'SURVEY_UPDATED', { survey: s.id, audience: describeRule(rule), trigger: s.trigger_type });
    res.json({ ok: true, survey: s });
  } catch (e) { logger.error('survey update', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---- the survey library (phase 3) ------------------------------------
//
// Asked for on 25 Sep: HR picks "Day 30 Connect" rather than typing
// twenty questions. The rows are per-tenant and editable, so this
// reads them rather than the file they were seeded from.
router.get('/templates', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    // A tenant created before this table existed, or one made since by
    // a path that does not seed, would otherwise open an empty picker
    // and conclude the feature is broken. Seeding is idempotent.
    const have = +(await db.query(
      `SELECT count(*)::int AS n FROM engagement.survey_templates WHERE tenant_id=$1`, [T(req)])).rows[0].n;
    if (!have) {
      const n = await seedTemplates(db, T(req));
      logger.info('survey templates seeded on demand', { tenant: T(req), inserted: n });
    }
    const rows = (await db.query(
      `SELECT id, key, category, title, description, trigger_type, trigger_day, trigger_window_days,
              anonymity_default, audience_rule, questions, blocked_reason, sort_order,
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
    const anon = b.anonymity_default == null ? tpl.anonymity_default : !!b.anonymity_default;

    const s = (await db.query(
      `INSERT INTO engagement.surveys (tenant_id, title, survey_type, description, target_audience,
         audience_rule, trigger_type, trigger_day, trigger_window_days,
         anonymity_default, allow_attribution_optin, template_key, created_by)
       VALUES ($1,$2,'pulse',$3,'rule',$4,$5,$6,$7,$8,$8,$9,$10) RETURNING *`,
      [T(req), b.title || tpl.title, tpl.description || null, JSON.stringify(rule),
       merged.trigger_type, merged.trigger_type === 'tenure' ? merged.trigger_day : null,
       merged.trigger_window_days, anon, tpl.key, req.user.email])).rows[0];

    const qs = Array.isArray(tpl.questions) ? tpl.questions : [];
    let i = 0;
    for (const q of qs) {
      const opts = cleanOptions(q.options);
      await db.query(
        `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order)
         VALUES ($1,$2,COALESCE($3,'scale'),$4,$5,COALESCE($6,true),$7)`,
        [T(req), s.id, q.qtype || null, q.prompt, opts.length ? JSON.stringify(opts) : null,
         q.required, (i += 10)]);
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
    const bad = validateTrigger(b);
    if (bad) return res.status(422).json({ error: bad });
    const a = await resolveAudience(T(req), b);
    res.json({ count: a.count, description: a.description, no_joining_date: a.no_joining_date,
      sample: a.employees.slice(0, 8).map((e) => e.name) });
  } catch (e) { logger.error('audience preview', { error: e.message }); res.status(500).json({ error: e.message }); }
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
  for (const e of a.employees) {
    const r = await db.query(
      `INSERT INTO engagement.invitations (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING employee_id`, [tenantId, survey.id, e.id]);
    if (r.rows.length) {
      invited++;
      await notify(tenantId, e.id, 'survey_open', `Survey: ${survey.title}`, null, '/engagement');
    }
  }
  return { invited, matched: a.count, description: a.description, no_joining_date: a.no_joining_date };
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
      standing: s.trigger_type === 'tenure' });
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
              i.completed_at
         FROM engagement.invitations i JOIN engagement.surveys s ON s.id=i.survey_id
        WHERE i.tenant_id=$1 AND i.employee_id=$2 AND s.status='open' ORDER BY i.invited_at DESC`,
      [T(req), req.user.id]);
    res.json({ invitations: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/surveys/:id/questions', async (req, res) => {
  try {
    const inv = (await db.query(`SELECT 1 FROM engagement.invitations WHERE survey_id=$1 AND employee_id=$2`,
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
    const inv = (await db.query(`SELECT * FROM engagement.invitations WHERE survey_id=$1 AND employee_id=$2`, [s.id, req.user.id])).rows[0];
    if (!inv) { return res.status(403).json({ error: 'Not invited to this survey' }); }
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
      `INSERT INTO engagement.responses (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3) RETURNING id`,
      [T(req), s.id, attributedId])).rows[0];
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
    await client.query(`UPDATE engagement.invitations SET completed_at=now() WHERE survey_id=$1 AND employee_id=$2`, [s.id, req.user.id]);
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
    res.json({ survey: { id: s.id, title: s.title, survey_type: s.survey_type, status: s.status },
      participation: { ...part, rate: part.invited ? Math.round((part.completed / part.invited) * 100) : 0 },
      questions: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, shouldAttribute, enps, sweepTenureSurveys, validateTrigger, cleanOptions };
