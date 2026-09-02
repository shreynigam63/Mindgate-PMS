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
    const s = (await db.query(
      `INSERT INTO engagement.surveys (tenant_id, title, survey_type, description, target_audience,
         anonymity_default, allow_attribution_optin, closes_at, created_by)
       VALUES ($1,$2,COALESCE($3,'pulse'),$4,COALESCE($5,'all'),COALESCE($6,true),COALESCE($7,true),$8,$9) RETURNING *`,
      [T(req), b.title, b.survey_type || null, b.description || null, b.target_audience || null,
       b.anonymity_default, b.allow_attribution_optin, b.closes_at || null, req.user.email])).rows[0];
    const qs = Array.isArray(b.questions) ? b.questions : [];
    let i = 0;
    for (const q of qs) {
      if (!q.prompt) continue;
      await db.query(
        `INSERT INTO engagement.questions (tenant_id, survey_id, qtype, prompt, options, required, sort_order)
         VALUES ($1,$2,COALESCE($3,'scale'),$4,$5,COALESCE($6,true),$7)`,
        [T(req), s.id, q.qtype || null, q.prompt, q.options ? JSON.stringify(q.options) : null, q.required, (i += 10)]);
    }
    res.json({ ok: true, survey: s });
  } catch (e) { logger.error('survey create', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Open: builds the invitation set from the audience, notifies. Idempotent.
router.post('/surveys/:id/open', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'engagement_admin'))) return res.status(403).json({ error: "Requires 'engagement_admin'" });
    const s = (await db.query(`SELECT * FROM engagement.surveys WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'survey not found' });
    const qn = +(await db.query(`SELECT COUNT(*) c FROM engagement.questions WHERE survey_id=$1`, [s.id])).rows[0].c;
    if (!qn) return res.status(422).json({ error: 'Add at least one question before opening' });
    let where = `tenant_id=$1 AND status='active'`; const params = [T(req)];
    if (s.target_audience && s.target_audience.startsWith('department:')) {
      where += ` AND department=$2`; params.push(s.target_audience.slice('department:'.length));
    }
    const emps = (await db.query(`SELECT id FROM core.employees WHERE ${where}`, params)).rows;
    let invited = 0;
    for (const e of emps) {
      const r = await db.query(
        `INSERT INTO engagement.invitations (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING RETURNING employee_id`, [T(req), s.id, e.id]);
      if (r.rows.length) { invited++; await notify(T(req), e.id, 'survey_open', `Survey: ${s.title}`, null, '/engagement'); }
    }
    await db.query(`UPDATE engagement.surveys SET status='open', opens_at=now() WHERE id=$1`, [s.id]);
    res.json({ ok: true, invited, audience_size: emps.length });
  } catch (e) { logger.error('survey open', { error: e.message }); res.status(500).json({ error: e.message }); }
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
    if (!s) { client.release(); return res.status(404).json({ error: 'survey not found' }); }
    if (s.status !== 'open') { client.release(); return res.status(409).json({ error: 'Survey is not open' }); }
    const inv = (await db.query(`SELECT * FROM engagement.invitations WHERE survey_id=$1 AND employee_id=$2`, [s.id, req.user.id])).rows[0];
    if (!inv) { client.release(); return res.status(403).json({ error: 'Not invited to this survey' }); }
    if (inv.completed_at) { client.release(); return res.status(409).json({ error: 'Already completed' }); }
    const answers = (req.body && req.body.answers) || {};
    const qs = (await db.query(`SELECT id, qtype, required FROM engagement.questions WHERE survey_id=$1`, [s.id])).rows;
    const missing = qs.filter(q => q.required && answers[q.id] == null).length;
    if (missing) { client.release(); return res.status(422).json({ error: `${missing} required question(s) unanswered` }); }

    const attributedId = shouldAttribute(s, req.body && req.body.attribute) ? req.user.id : null;
    await client.query('BEGIN');
    const resp = (await client.query(
      `INSERT INTO engagement.responses (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3) RETURNING id`,
      [T(req), s.id, attributedId])).rows[0];
    for (const q of qs) {
      const a = answers[q.id];
      if (a == null) continue;
      await client.query(
        `INSERT INTO engagement.answers (response_id, question_id, value_num, value_text) VALUES ($1,$2,$3,$4)`,
        [resp.id, q.id, a.num != null ? Number(a.num) : null, a.text != null ? String(a.text).slice(0, 4000) : null]);
    }
    // Completion on the INVITATION — never on the response.
    await client.query(`UPDATE engagement.invitations SET completed_at=now() WHERE survey_id=$1 AND employee_id=$2`, [s.id, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, attributed: !!attributedId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('survey respond', { error: e.message });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
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
    const qs = (await db.query(`SELECT id, qtype, prompt, sort_order FROM engagement.questions WHERE survey_id=$1 ORDER BY sort_order`, [s.id])).rows;
    const out = [];
    for (const q of qs) {
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

module.exports = { router, shouldAttribute, enps };
