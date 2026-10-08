// The HRBP tab: HR's operational screens, scoped to one partner's remit.
//
// READ-ONLY, deliberately, for this first cut. An HRBP sees their slice
// and approves nothing; approval rights are a separate decision and every
// write would need its own remit check on the way in. A screen that shows
// a button and then 403s is worse than one that never offered it.
//
// WHAT IS NOT HERE, and why. Increment Simulation (salary), Settings
// (tenant-wide configuration) and the KRA Library (publishes shelves
// org-wide, which is not a scoped act) are absent on purpose: an HRBP
// holding any of the three would simply be HR.
//
// EVERY ROUTE RESOLVES THE REMIT FIRST AND SAYS WHEN IT IS EMPTY. An
// unassigned HRBP gets an explicit sentence, not a blank table — and
// never the whole company. The resolver fails closed (see
// people/hrbp-scope.js); this layer's job is to make that visible rather
// than mysterious.
//
// The remit is a PEOPLE concept resolved from the employee master, so it
// is reached through the people module's exported interface rather than
// by requiring its internals.

const express = require('express');
const db = require('../../core/db');
const { hasPermission, holdsPermission } = require('../../core/permissions');
const logger = require('../../core/logger');
const { hrbpScope } = require('../people');
const approvals = require('./approvals');
const { compliance } = require('./timesheet-rules');

const router = express.Router();
const T = (req) => req.user.tenant_id;

const EMP = `e.id, e.name, e.email, e.department, e.designation, e.location, e.hod_name,
             e.status, e.nine_box_cell, e.potential_rating, e.last_appraisal_rating`;

/**
 * Everything a scoped route needs, resolved once. Returns null after
 * sending a 403 when the caller is not entitled to the tab at all.
 */
async function scopeOrRefuse(req, res) {
  if (!(await hasPermission(req.user, 'pms_hrbp'))) {
    res.status(403).json({ error: "Requires 'pms_hrbp'", needs: 'pms_hrbp' });
    return null;
  }
  const remit = await hrbpScope.remitFor(T(req), req.user.email);
  return remit;
}

/** The shape every list route returns when nobody is in the remit. */
const emptyRemitBody = (remit) => ({
  remit: { locations: remit.locations, hods: remit.hods, empty: true },
  reason: hrbpScope.emptyRemitReason(remit),
  people: [], items: [], total: 0,
});

/** The employees in the remit, with the columns every screen wants. */
async function peopleIn(req, remit, { includeInactive = false } = {}) {
  const { where, params } = hrbpScope.remitSql(remit, 2);
  return (await db.query(
    `SELECT ${EMP}, m.name AS manager_name
       FROM core.employees e LEFT JOIN core.employees m ON m.id = e.manager_id
      WHERE e.tenant_id=$1 AND e.archived_at IS NULL
            ${includeInactive ? '' : "AND e.status='active'"}${where}
      ORDER BY e.name`, [T(req), ...params])).rows;
}

async function activeCycle(tenantId) {
  return (await db.query(
    `SELECT id, name, fiscal_year, phase FROM pms.cycles
      WHERE tenant_id=$1 AND phase <> 'closed' ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0] || null;
}

// ---------------------------------------------------------------- the tab
// What the HRBP landing needs to explain itself: the remit as assigned,
// how many people it reaches, and — separately — whether the master even
// carries the fields the remit matches on. Those are two different kinds
// of empty and conflating them wastes an afternoon.
router.get('/me', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    const people = remit.empty ? [] : await peopleIn(req, remit);
    res.json({
      remit: { locations: remit.locations, hods: remit.hods, empty: remit.empty },
      reason: hrbpScope.emptyRemitReason(remit),
      coverage: await hrbpScope.coverageWarning(T(req)),
      counts: {
        people: people.length,
        departments: new Set(people.map((p) => p.department).filter(Boolean)).size,
        locations: new Set(people.map((p) => p.location).filter(Boolean)).size,
      },
    });
  } catch (e) { logger.error('hrbp me', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------- people
router.get('/employees', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    if (remit.empty) return res.json(emptyRemitBody(remit));
    const people = await peopleIn(req, remit, { includeInactive: req.query.include_inactive === 'true' });
    res.json({ remit, reason: null, people, total: people.length });
  } catch (e) { logger.error('hrbp employees', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ------------------------------------------------------------- approvals
// Filtered from the same queue HR reads, not a second query: two lists of
// "what is pending" that can disagree is the bug this avoids. Read-only —
// the HRBP sees the queue and decides nothing.
router.get('/approvals', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, items: [], counts: {}, total: 0, remit, reason: null });
    if (remit.empty) return res.json({ cycle: c, counts: {}, ...emptyRemitBody(remit) });
    const mine = new Set((await peopleIn(req, remit)).map((p) => p.id));
    const q = await approvals.pendingApprovals(T(req), c.id);
    const items = q.items.filter((i) => mine.has(i.employee_id));
    res.json({
      cycle: c, remit, reason: null, items, total: items.length,
      counts: items.reduce((a, i) => ({ ...a, [i.kind]: (a[i.kind] || 0) + 1 }), {}),
      // Named so the HRBP can see their view is a subset rather than
      // wondering why their number differs from HR's.
      org_total: q.total,
    });
  } catch (e) { logger.error('hrbp approvals', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------- KRA overview
router.get('/kra-overview', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    const c = await activeCycle(T(req));
    if (remit.empty) return res.json({ cycle: c, ...emptyRemitBody(remit) });
    const { where, params } = hrbpScope.remitSql(remit, 3);
    const rows = c ? (await db.query(
      `SELECT ${EMP}, s.status AS sheet_status, s.submitted_at,
              COALESCE(k.n, 0)::int AS kra_count, COALESCE(k.weight, 0)::numeric AS weight_total
         FROM core.employees e
         LEFT JOIN pms.kra_sheets s ON s.employee_id = e.id AND s.cycle_id = $2
         LEFT JOIN LATERAL (SELECT count(*) AS n, sum(weight) AS weight FROM pms.kras WHERE sheet_id = s.id) k ON true
        WHERE e.tenant_id=$1 AND e.archived_at IS NULL AND e.status='active'${where}
        ORDER BY e.name`, [T(req), c.id, ...params])).rows : [];
    res.json({
      cycle: c, remit, reason: null, people: rows, total: rows.length,
      summary: {
        no_sheet: rows.filter((r) => !r.sheet_status).length,
        draft: rows.filter((r) => r.sheet_status === 'draft').length,
        submitted: rows.filter((r) => r.sheet_status === 'submitted').length,
        approved: rows.filter((r) => r.sheet_status === 'approved').length,
        // A sheet that does not total 100 is the thing HR chases, so it
        // is counted rather than left for the reader to spot.
        off_100: rows.filter((r) => r.sheet_status && Number(r.weight_total) !== 100).length,
      },
    });
  } catch (e) { logger.error('hrbp kra overview', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// -------------------------------------------------------------- timesheet
router.get('/timesheet', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    if (remit.empty) return res.json(emptyRemitBody(remit));
    const people = await peopleIn(req, remit);
    const settings = (await db.query(
      `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [T(req)])).rows[0];
    const cfg = (settings && settings.value) || {};
    const ids = people.map((p) => p.id);
    const entries = ids.length ? (await db.query(
      `SELECT employee_id, to_char(log_date,'YYYY-MM-DD') AS log_date, hours
         FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id = ANY($2::uuid[])`,
      [T(req), ids])).rows : [];
    const by = new Map();
    for (const r of entries) {
      if (!by.has(r.employee_id)) by.set(r.employee_id, []);
      by.get(r.employee_id).push({ ...r, hours: Number(r.hours) });
    }
    // The same pure compliance function the Self and Manager tabs use, so
    // the three cannot report different percentages for one person.
    const rows = people.map((p) => {
      const c = compliance(by.get(p.id) || [], cfg, req.query.as_of);
      return { employee: p, has_data: !!(by.get(p.id) || []).length, total: c.total };
    });
    res.json({ remit, reason: null, settings: cfg, people: rows, total: rows.length,
      nothing_uploaded: rows.filter((r) => !r.has_data).length });
  } catch (e) { logger.error('hrbp timesheet', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ------------------------------------------------------- completion report
router.get('/completion-report', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    const c = await activeCycle(T(req));
    if (remit.empty) return res.json({ cycle: c, ...emptyRemitBody(remit) });
    if (!c) return res.json({ cycle: null, remit, reason: null, people: [], total: 0 });
    const { where, params } = hrbpScope.remitSql(remit, 3);
    const rows = (await db.query(
      `SELECT ${EMP},
              (s.id IS NOT NULL) AS has_kra_sheet, s.status AS kra_status,
              (sa.id IS NOT NULL AND sa.status='submitted') AS self_done,
              (ev.id IS NOT NULL AND ev.status='submitted') AS manager_done,
              (my.id IS NOT NULL AND my.self_status='submitted') AS midyear_self_done,
              (my.id IS NOT NULL AND my.manager_status='submitted') AS midyear_manager_done
         FROM core.employees e
         LEFT JOIN pms.kra_sheets s   ON s.employee_id = e.id AND s.cycle_id = $2
         LEFT JOIN pms.self_appraisals sa ON sa.employee_id = e.id AND sa.cycle_id = $2
         LEFT JOIN pms.manager_evaluations ev ON ev.employee_id = e.id AND ev.cycle_id = $2
         LEFT JOIN pms.midyear_checkins my ON my.employee_id = e.id AND my.cycle_id = $2
        WHERE e.tenant_id=$1 AND e.archived_at IS NULL AND e.status='active'${where}
        ORDER BY e.name`, [T(req), c.id, ...params])).rows;
    res.json({
      cycle: c, remit, reason: null, people: rows, total: rows.length,
      summary: {
        kra_sheets: rows.filter((r) => r.has_kra_sheet).length,
        self_done: rows.filter((r) => r.self_done).length,
        manager_done: rows.filter((r) => r.manager_done).length,
        midyear_self_done: rows.filter((r) => r.midyear_self_done).length,
        midyear_manager_done: rows.filter((r) => r.midyear_manager_done).length,
      },
    });
  } catch (e) { logger.error('hrbp completion', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// --------------------------------------------------- competency dashboard
router.get('/competency-dashboard', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    const c = await activeCycle(T(req));
    if (remit.empty) return res.json({ cycle: c, ...emptyRemitBody(remit) });
    if (!c) return res.json({ cycle: null, remit, reason: null, people: [], total: 0 });
    const { where, params } = hrbpScope.remitSql(remit, 3);
    const rows = (await db.query(
      `SELECT ${EMP}, a.self_status, a.manager_status,
              COALESCE(g.below, 0)::int AS below_required,
              COALESCE(g.rated, 0)::int AS rated
         FROM core.employees e
         LEFT JOIN pms.competency_assessments a ON a.employee_id = e.id AND a.cycle_id = $2
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE r.manager_rating IS NOT NULL AND r.manager_rating < r.required_level) AS below,
                  count(*) FILTER (WHERE r.manager_rating IS NOT NULL) AS rated
             FROM pms.competency_ratings r WHERE r.assessment_id = a.id) g ON true
        WHERE e.tenant_id=$1 AND e.archived_at IS NULL AND e.status='active'${where}
        ORDER BY e.name`, [T(req), c.id, ...params])).rows;
    res.json({
      cycle: c, remit, reason: null, people: rows, total: rows.length,
      summary: {
        self_submitted: rows.filter((r) => r.self_status === 'submitted').length,
        manager_submitted: rows.filter((r) => r.manager_status === 'submitted').length,
        below_required: rows.reduce((t, r) => t + r.below_required, 0),
      },
    });
  } catch (e) { logger.error('hrbp competency', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------- 9-box
router.get('/nine-box', async (req, res) => {
  try {
    const remit = await scopeOrRefuse(req, res); if (!remit) return;
    if (remit.empty) return res.json(emptyRemitBody(remit));
    const people = await peopleIn(req, remit);
    const cells = {};
    for (const p of people) {
      const k = p.nine_box_cell || 'unplaced';
      (cells[k] = cells[k] || []).push({ id: p.id, name: p.name, department: p.department, location: p.location });
    }
    // `people` as well as `cells`: the HRBP table reads a flat list like
    // every other view here, and a view that returns a different shape is
    // the one that renders an empty table while holding data.
    res.json({ remit, reason: null, cells, people, total: people.length,
      placed: people.filter((p) => p.nine_box_cell).length });
  } catch (e) { logger.error('hrbp nine box', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ============================ HR's side: who is an HRBP, and of what ======
// pms_admin, not pms_hrbp. A remit nobody but its holder can change is not
// a control, and an HRBP widening their own remit is the obvious abuse.

router.get('/admin/options', async (req, res) => {
  try {
    // Held, never lent: remits decide who sees what (8 Oct).
    if (!(await holdsPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Remits are set by HR.", needs: 'pms_admin' });
    const locations = (await db.query(
      `SELECT btrim(location) AS value, count(*)::int AS people
         FROM core.employees
        WHERE tenant_id=$1 AND archived_at IS NULL AND status='active'
              AND location IS NOT NULL AND btrim(location) <> ''
        GROUP BY 1 ORDER BY 2 DESC, 1`, [T(req)])).rows;
    const hods = (await db.query(
      `SELECT btrim(hod_name) AS value, count(*)::int AS people
         FROM core.employees
        WHERE tenant_id=$1 AND archived_at IS NULL AND status='active'
              AND hod_name IS NOT NULL AND btrim(hod_name) <> ''
        GROUP BY 1 ORDER BY 2 DESC, 1`, [T(req)])).rows;
    res.json({ locations, hods, coverage: await hrbpScope.coverageWarning(T(req)) });
  } catch (e) { logger.error('hrbp options', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.get('/admin/partners', async (req, res) => {
  try {
    // Held, never lent: remits decide who sees what (8 Oct).
    if (!(await holdsPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Remits are set by HR.", needs: 'pms_admin' });
    const rows = (await db.query(
      `SELECT s.email, s.kind, s.value, e.name
         FROM core.hrbp_scope s
         LEFT JOIN core.employees e ON e.tenant_id = s.tenant_id AND lower(e.email) = lower(s.email)
        WHERE s.tenant_id=$1 ORDER BY lower(s.email), s.kind, s.value`, [T(req)])).rows;
    const by = new Map();
    for (const r of rows) {
      const k = r.email.toLowerCase();
      if (!by.has(k)) by.set(k, { email: r.email, name: r.name || null, locations: [], hods: [] });
      by.get(k)[r.kind === 'location' ? 'locations' : 'hods'].push(r.value);
    }
    // Everyone holding the role, including those with nothing assigned —
    // an HRBP with an empty remit is exactly who HR needs to find.
    const holders = (await db.query(
      `SELECT lower(ur.email) AS email, e.name FROM core.user_roles ur
         LEFT JOIN core.employees e ON e.tenant_id = ur.tenant_id AND lower(e.email) = lower(ur.email)
        WHERE ur.tenant_id=$1 AND ur.role='hrbp'`, [T(req)])).rows;
    for (const h of holders) if (!by.has(h.email)) by.set(h.email, { email: h.email, name: h.name || null, locations: [], hods: [] });
    const partners = [...by.values()].sort((a, b) => a.email.localeCompare(b.email));
    res.json({ partners, unassigned: partners.filter((p) => !p.locations.length && !p.hods.length).map((p) => p.email) });
  } catch (e) { logger.error('hrbp partners', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.put('/admin/partners/:email', async (req, res) => {
  try {
    // Held, never lent: remits decide who sees what (8 Oct).
    if (!(await holdsPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Remits are set by HR.", needs: 'pms_admin' });
    const email = String(req.params.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email is required' });
    const { locations, hods } = req.body || {};
    if (!Array.isArray(locations) || !Array.isArray(hods)) {
      return res.status(400).json({ error: 'locations and hods must both be arrays — send [] to clear one' });
    }
    const clean = (a) => [...new Set(a.map((v) => String(v == null ? '' : v).trim()).filter(Boolean))];
    const L = clean(locations); const H = clean(hods);

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Replace rather than merge: the screen sends the whole remit, so a
      // value removed there has to disappear here. Merging would make an
      // assignment impossible to take away, which is the direction that
      // matters for access.
      await client.query(`DELETE FROM core.hrbp_scope WHERE tenant_id=$1 AND lower(email)=$2`, [T(req), email]);
      for (const [kind, vals] of [['location', L], ['hod', H]]) {
        for (const v of vals) {
          await client.query(
            `INSERT INTO core.hrbp_scope (tenant_id, email, kind, value, created_by)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [T(req), email, kind, v, req.user.email]);
        }
      }
      await client.query(
        `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
         VALUES ($1,$2,'HRBP_SCOPE_SET','hrbp_scope',NULL,$3)`,
        [T(req), req.user.email, JSON.stringify({ email, locations: L, hods: H })]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    // Answer with what the remit now reaches, so HR sees the consequence
    // of the assignment rather than just an ok.
    const remit = await hrbpScope.remitFor(T(req), email);
    const ids = await hrbpScope.employeeIdsFor(T(req), email);
    res.json({ ok: true, email, remit: { locations: remit.locations, hods: remit.hods, empty: remit.empty },
      reaches: ids.length, coverage: await hrbpScope.coverageWarning(T(req)) });
  } catch (e) { logger.error('hrbp set scope', { error: e.message }); res.status(500).json({ error: e.message }); }
});

module.exports = { router };
