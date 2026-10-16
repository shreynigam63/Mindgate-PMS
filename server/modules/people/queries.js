// Queries (15 Oct; until then "Appraisal Queries", a thread with HR only).
//
// A query has a title, the people it is raised to and a description. The
// people are colleagues picked by name or email; each is told in the app
// and by email, and can answer. With nobody named it goes to HR, whose
// inbox (HR → Queries) holds every query in the company.
//
// WHO SEES A QUERY: the person who raised it, the people it is raised to,
// and HR. People Hub → Queries is the first two; HR → Queries is HR's.
// Someone in HR answers a query raised to them from the HR tab, so it is
// not repeated in their People Hub.
//
// Status: open (waiting on an answer) → answered (the last word was not
// the raiser's) → closed. A raiser's reply on an answered query opens it
// again; a closed query takes no more replies.
const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { guardUuidParams } = require('../../core/http');
const { holdsPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');

const T = (req) => req.user.tenant_id;
const SELF_LINK = '/people?tab=queries';
const HR_LINK = '/admin/queries';
const MAX_TO = 10;
const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max);
const isHr = (user) => holdsPermission(user, 'people_admin');
const fail = (res, e, what) => {
  logger.error(`queries: ${what}`, { error: e.message });
  res.status(500).json({ error: `Could not ${what}. Try again in a minute.` });
};

// The query, the people it is raised to, and how the caller stands to it.
async function load(req, id) {
  const q = (await db.query(
    `SELECT q.*, e.name AS raised_by_name, e.email AS raised_by_email
       FROM people.appraisal_queries q JOIN core.employees e ON e.id=q.employee_id
      WHERE q.id=$1 AND q.tenant_id=$2`, [id, T(req)])).rows[0];
  if (!q) return null;
  const to = (await db.query(
    `SELECT e.id, e.name, e.email FROM people.appraisal_query_recipients r JOIN core.employees e ON e.id=r.employee_id
      WHERE r.query_id=$1 ORDER BY e.name`, [q.id])).rows;
  const raiser = q.employee_id === req.user.id;
  const recipient = to.some((p) => p.id === req.user.id);
  const hr = await isHr(req.user);
  return { q, to, raiser, recipient, hr, may: raiser || recipient || hr };
}

// Where a person's notice should take them: HR answer from the HR tab.
async function linkFor(tenantId, employeeId) {
  const e = (await db.query(
    `SELECT e.email, coalesce(r.role, 'employee') AS role FROM core.employees e
       LEFT JOIN core.user_roles r ON r.tenant_id=e.tenant_id AND lower(r.email)=lower(e.email)
      WHERE e.id=$1 AND e.tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!e) return SELF_LINK;
  return (await isHr({ email: e.email, role: e.role, tenant_id: tenantId })) ? HR_LINK : SELF_LINK;
}

// Everyone who answers the HR inbox. A query raised to nobody goes there,
// and until 16 Oct nobody was told it had arrived (from QA).
async function hrPeople(tenantId) {
  const rows = (await db.query(
    `SELECT DISTINCT e.id, e.email, ur.role FROM core.employees e
       LEFT JOIN core.user_roles ur ON ur.tenant_id=e.tenant_id AND lower(ur.email)=lower(e.email)
      WHERE e.tenant_id=$1 AND e.status='active' AND e.archived_at IS NULL
        AND ((ur.role IS NOT NULL AND ur.role <> 'employee')
             OR EXISTS (SELECT 1 FROM core.user_permissions up WHERE up.tenant_id=e.tenant_id AND lower(up.email)=lower(e.email)))`,
    [tenantId])).rows;
  const out = [];
  for (const r of rows) if (await isHr({ email: r.email, role: r.role || 'employee', tenant_id: tenantId })) out.push(r.id);
  return out;
}

async function tell(tenantId, ids, kind, title, body, opts) {
  for (const id of ids) {
    try { await notify(tenantId, id, kind, title, body, await linkFor(tenantId, id), opts); } catch (e) {
      logger.warn('query notice failed', { kind, employee_id: id, error: e.message });
    }
  }
}

const LIST_COLS = `q.id, q.subject AS title, q.status, q.created_at, q.updated_at, q.closed_at, q.employee_id,
  e.name AS raised_by_name, e.email AS raised_by_email, e.department AS raised_by_department,
  (SELECT count(*)::int FROM people.appraisal_query_messages m WHERE m.query_id=q.id) AS messages,
  (SELECT max(m.at) FROM people.appraisal_query_messages m WHERE m.query_id=q.id) AS last_at,
  coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'email', p.email) ORDER BY p.name)
     FROM people.appraisal_query_recipients r JOIN core.employees p ON p.id=r.employee_id WHERE r.query_id=q.id), '[]') AS raised_to`;

const router = express.Router();
guardUuidParams(router);

// view=mine (People Hub): raised by me, and raised to me unless I am HR.
// view=all (HR → Queries): every query, for HR.
router.get('/', async (req, res) => {
  try {
    const hr = await isHr(req.user);
    if (req.query.view === 'all') {
      if (!hr) return res.status(403).json({ error: "Requires 'people_admin'", needs: 'people_admin' });
      const status = ['open', 'answered', 'closed'].includes(req.query.status) ? req.query.status : null;
      const rows = (await db.query(
        `SELECT ${LIST_COLS},
                EXISTS (SELECT 1 FROM people.appraisal_query_recipients r WHERE r.query_id=q.id AND r.employee_id=$2) AS to_me,
                NOT EXISTS (SELECT 1 FROM people.appraisal_query_recipients r WHERE r.query_id=q.id) AS to_hr
           FROM people.appraisal_queries q JOIN core.employees e ON e.id=q.employee_id
          WHERE q.tenant_id=$1 ${status ? 'AND q.status=$3' : ''}
          ORDER BY (q.status='closed'), coalesce((SELECT max(m.at) FROM people.appraisal_query_messages m WHERE m.query_id=q.id), q.created_at) DESC`,
        status ? [T(req), req.user.id, status] : [T(req), req.user.id])).rows;
      return res.json({ queries: rows, admin: true });
    }
    const rows = (await db.query(
      `SELECT ${LIST_COLS}, (q.employee_id=$2) AS mine
         FROM people.appraisal_queries q JOIN core.employees e ON e.id=q.employee_id
        WHERE q.tenant_id=$1 AND (q.employee_id=$2
              ${hr ? '' : 'OR EXISTS (SELECT 1 FROM people.appraisal_query_recipients r WHERE r.query_id=q.id AND r.employee_id=$2)'})
        ORDER BY (q.status='closed'), q.created_at DESC`, [T(req), req.user.id])).rows;
    res.json({ queries: rows, admin: hr,
      hr_note: hr ? 'Queries raised to you, and every query in the company, are on HR → Queries.' : null });
  } catch (e) { fail(res, e, 'load the queries'); }
});

// Whom to raise it to: colleagues by name or email.
router.get('/people', async (req, res) => {
  try {
    const q = clean(req.query.q, 80).toLowerCase();
    if (q.length < 2) return res.json({ people: [] });
    const rows = (await db.query(
      `SELECT id, name, email, designation, department FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND archived_at IS NULL AND id<>$2
          AND (lower(name) LIKE $3 OR lower(email) LIKE $3)
        ORDER BY (lower(email)=$4) DESC, name LIMIT 15`,
      [T(req), req.user.id, `%${q.replace(/[%_\\]/g, '\\$&')}%`, q])).rows;
    res.json({ people: rows });
  } catch (e) { fail(res, e, 'search for people'); }
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  const title = clean(b.title != null ? b.title : b.subject, 150);
  const description = clean(b.description != null ? b.description : b.body, 4000);
  if (!title) return res.status(400).json({ error: 'Give the query a title.' });
  if (!description) return res.status(400).json({ error: 'Describe your query.' });
  const ids = [...new Set((Array.isArray(b.to) ? b.to : []).map(String))];
  if (ids.length > MAX_TO) return res.status(400).json({ error: `Raise it to at most ${MAX_TO} people.` });
  if (ids.includes(req.user.id)) return res.status(400).json({ error: 'You cannot raise a query to yourself.' });
  const client = await db.getClient();
  try {
    let to = [];
    if (ids.length) {
      if (ids.some((x) => !/^[0-9a-f-]{36}$/i.test(x))) return res.status(400).json({ error: 'Pick the people from the list.' });
      to = (await client.query(
        `SELECT id, name FROM core.employees WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND status='active' AND archived_at IS NULL`,
        [T(req), ids])).rows;
      if (to.length !== ids.length) return res.status(400).json({ error: 'One of those people is not an active employee.' });
    }
    await client.query('BEGIN');
    const q = (await client.query(
      `INSERT INTO people.appraisal_queries (tenant_id, employee_id, cycle_id, subject) VALUES ($1,$2,$3,$4) RETURNING id, subject AS title, status, created_at`,
      [T(req), req.user.id, b.cycle_id || null, title])).rows[0];
    await client.query(`INSERT INTO people.appraisal_query_messages (tenant_id, query_id, author_id, body) VALUES ($1,$2,$3,$4)`,
      [T(req), q.id, req.user.id, description]);
    for (const p of to) {
      await client.query(`INSERT INTO people.appraisal_query_recipients (tenant_id, query_id, employee_id) VALUES ($1,$2,$3)`, [T(req), q.id, p.id]);
    }
    await client.query('COMMIT');
    const hearers = to.length ? to.map((p) => p.id) : (await hrPeople(T(req))).filter((id) => id !== req.user.id);
    await tell(T(req), hearers, 'query_raised', `${req.user.name || req.user.email} raised a query: ${title}`,
      description.length > 300 ? `${description.slice(0, 297)}…` : description, { email: true });
    res.json({ ok: true, query: q,
      message: to.length ? `Query raised to ${to.map((p) => p.name).join(', ')}. They have been told by email.` : 'Query raised to HR.' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, e, 'raise the query');
  } finally { client.release(); }
});

router.get('/:id/messages', async (req, res) => {
  try {
    const a = await load(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'No such query.' });
    if (!a.may) return res.status(403).json({ error: 'This query was not raised by you or to you.' });
    const messages = (await db.query(
      `SELECT m.id, m.body, m.at, m.author_id, e.name AS author_name FROM people.appraisal_query_messages m
         JOIN core.employees e ON e.id=m.author_id WHERE m.query_id=$1 ORDER BY m.at`, [a.q.id])).rows;
    res.json({ query: { ...a.q, title: a.q.subject, raised_to: a.to }, messages,
      may_reply: a.q.status !== 'closed', may_close: a.q.status !== 'closed' });
  } catch (e) { fail(res, e, 'open the query'); }
});

async function close(req, a) {
  await db.query(`UPDATE people.appraisal_queries SET status='closed', closed_at=now(), closed_by=$2, updated_at=now() WHERE id=$1`, [a.q.id, req.user.id]);
  const others = [a.q.employee_id, ...a.to.map((p) => p.id)].filter((id) => id !== req.user.id);
  await tell(T(req), others, 'query_closed', `Query closed: ${a.q.subject}`, `Closed by ${req.user.name || req.user.email}.`);
}

router.post('/:id/reply', async (req, res) => {
  try {
    const a = await load(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'No such query.' });
    if (!a.may) return res.status(403).json({ error: 'This query was not raised by you or to you.' });
    const body = clean((req.body || {}).body, 4000);
    const shut = !!(req.body || {}).close;
    if (a.q.status === 'closed') return res.status(409).json({ error: 'This query is closed.' });
    if (!body && !shut) return res.status(400).json({ error: 'Write a reply.' });
    if (body) {
      await db.query(`INSERT INTO people.appraisal_query_messages (tenant_id, query_id, author_id, body) VALUES ($1,$2,$3,$4)`,
        [T(req), a.q.id, req.user.id, body]);
      const status = a.raiser ? 'open' : 'answered';
      await db.query(`UPDATE people.appraisal_queries SET status=$2, updated_at=now() WHERE id=$1`, [a.q.id, status]);
      const excerpt = body.length > 300 ? `${body.slice(0, 297)}…` : body;
      if (a.raiser) {
        await tell(T(req), a.to.map((p) => p.id), 'query_reply', `New reply on: ${a.q.subject}`, excerpt);
      } else {
        await tell(T(req), [a.q.employee_id], 'query_reply', `Reply on your query: ${a.q.subject}`, excerpt, { email: true });
      }
    }
    if (shut) await close(req, a);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'send the reply'); }
});

router.post('/:id/close', async (req, res) => {
  try {
    const a = await load(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'No such query.' });
    if (!a.may) return res.status(403).json({ error: 'This query was not raised by you or to you.' });
    if (a.q.status === 'closed') return res.status(409).json({ error: 'This query is already closed.' });
    await close(req, a);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'close the query'); }
});

module.exports = { router };
