// The AI on connects (15 Oct).
//
// SORTED, NOT TYPED: "Achievement, Blockers and Feedback should be
// categorised automatically based on topic and what was discussed and no
// manual intervention needed." The form asks only what was discussed; on
// save, the AI sorts it into the three. It runs after the connect is saved
// (the save never waits on it), the result is marked as sorted by AI, and
// a failure is shown on the connect with Try again — the discussion is
// always kept as written.
//
// TRAINING FROM CONNECTS: suggestions for one employee drawn from what came
// up in their recent connects — blockers, feedback, recurring themes. A
// draft for the manager and the employee to discuss; stored with its input
// (agentic.drafts), like every AI draft here.
const db = require('../../core/db');
const logger = require('../../core/logger');
const { narrate } = require('../../core/ai');
const { activeCycle } = require('./active-cycle');

const SORT = `You sort the notes of a 1-on-1 connect (a conversation between an employee
and their manager or a colleague) into three parts:
- achievements: what the employee achieved, delivered or did well
- blockers: anything stuck, at risk, or needing help, and from whom
- feedback: coaching, direction or feedback given in the conversation
Ground every point in the notes and the topic; invent nothing. A part the
notes do not cover is an empty list — never pad it. Short, plain bullets,
at most 4 per part, each one line. Never rate or judge the person.
Respond ONLY with JSON:
{"achievements":["..."],"blockers":["..."],"feedback":["..."]}`;

const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean).map((x) => x.slice(0, 300)).slice(0, 6);
const asText = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : null);

const running = new Set();
async function categorise(tenantId, connectId, requestedBy) {
  if (running.has(connectId)) return;
  running.add(connectId);
  try {
    const cn = (await db.query(
      `UPDATE pms.connects SET ai_status='working', ai_error=NULL WHERE id=$1 AND tenant_id=$2 AND ai_status IN ('pending','failed')
       RETURNING topic, discussion_notes, notes`, [connectId, tenantId])).rows[0];
    if (!cn) return;
    const discussion = String(cn.discussion_notes || cn.notes || '').trim();
    if (!discussion) {
      await db.query(`UPDATE pms.connects SET ai_status=NULL WHERE id=$1`, [connectId]);
      return;
    }
    try {
      const out = await narrate({ tenantId, kind: 'connect_categorise', ref: { connect_id: connectId }, requestedBy,
        input: { topic: cn.topic || null, discussion }, maxTokens: 700, system: SORT });
      if (!out.draft || out.draft._unparsed) throw new Error('The AI reply could not be read.');
      await db.query(
        `UPDATE pms.connects SET achievements=$2, blockers=$3, feedback=$4, ai_status='done', ai_error=NULL, ai_categorised_at=now() WHERE id=$1`,
        [connectId, asText(list(out.draft.achievements)), asText(list(out.draft.blockers)), asText(list(out.draft.feedback))]);
    } catch (e) {
      const msg = e.status === 503 ? 'AI is not set up on this server, so the discussion was not sorted. It is kept as written.' : String(e.message || 'The AI could not sort the discussion.');
      logger.warn('connect categorise failed', { connect_id: connectId, error: e.message });
      await db.query(`UPDATE pms.connects SET ai_status='failed', ai_error=$2 WHERE id=$1`, [connectId, msg.slice(0, 300)]);
    }
  } catch (e) {
    logger.error('connect categorise run', { connect_id: connectId, error: e.message });
  } finally { running.delete(connectId); }
}

const TRAINING = `You suggest training for one employee from what came up in their recent
connects (1-on-1 conversations with their manager or colleagues). Use only
what the connects say — blockers, feedback, recurring themes, goals named —
and the employee's role and KRAs for context. Every suggestion names the
need it answers and the connect date(s) it comes from.
Prefer what is practical: a course or certification (only real, widely
recognised ones; never invent one; never name a price or a provider you are
not sure of), a workshop, mentoring or shadowing, or an on-the-job stretch.
3 to 6 suggestions, the most important first. If the connects show no
training need, say so in notes and return fewer. Never rate or judge the
person, and never mention a performance rating.
Respond ONLY with JSON:
{"themes":["needs seen across the connects, one line each"],
 "trainings":[{"title":"","type":"course|certification|workshop|mentoring|on_the_job","why":"the need it answers, one line","from":["YYYY-MM-DD"],"priority":"high|medium|low"}],
 "notes":["anything for the manager to check"]}`;

const TYPES = ['course', 'certification', 'workshop', 'mentoring', 'on_the_job'];

async function trainingFor(tenantId, employeeId, requestedBy) {
  const emp = (await db.query(
    `SELECT name, designation, department, total_experience_years FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp) throw Object.assign(new Error('Employee not found.'), { status: 404 });
  const connects = (await db.query(
    `SELECT to_char(held_at,'YYYY-MM-DD') AS date, topic, discussion_notes, notes, achievements, blockers, feedback
       FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2 ORDER BY held_at DESC, created_at DESC LIMIT 12`, [tenantId, employeeId])).rows;
  if (!connects.length) {
    throw Object.assign(new Error(`No connects are logged for ${emp.name} yet. Training suggestions come from what was discussed in them.`), { status: 422 });
  }
  // Their KRAs in the cycle that is live — the shared rule for which that is.
  const cycle = await activeCycle(tenantId);
  const kras = cycle ? (await db.query(
    `SELECT k.title FROM pms.kras k JOIN pms.kra_sheets s ON s.id=k.sheet_id
      WHERE s.tenant_id=$1 AND s.employee_id=$2 AND s.cycle_id=$3 ORDER BY k.sort_order LIMIT 12`,
    [tenantId, employeeId, cycle.id])).rows.map((r) => r.title) : [];
  const out = await narrate({
    tenantId, kind: 'connect_training', ref: { employee_id: employeeId }, requestedBy, maxTokens: 1500, system: TRAINING,
    input: {
      employee: { designation: emp.designation, department: emp.department, total_experience_years: emp.total_experience_years },
      kras,
      connects: connects.map((c) => ({ date: c.date, topic: c.topic, discussion: c.discussion_notes || c.notes,
        achievements: c.achievements, blockers: c.blockers, feedback: c.feedback })),
    },
  });
  const d = out.draft || {};
  if (d._unparsed) throw Object.assign(new Error('The AI reply could not be read. Try again.'), { status: 502 });
  const trainings = (Array.isArray(d.trainings) ? d.trainings : []).filter((x) => x && x.title).slice(0, 8).map((x) => ({
    title: String(x.title).slice(0, 200), type: TYPES.includes(x.type) ? x.type : 'course', why: String(x.why || '').slice(0, 300),
    from: list(x.from).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)),
    priority: ['high', 'medium', 'low'].includes(x.priority) ? x.priority : 'medium',
  }));
  return { id: out.id, created_at: out.created_at, employee: emp.name, connects_used: connects.length,
    themes: list(d.themes), trainings, notes: list(d.notes) };
}

module.exports = { categorise, trainingFor };
