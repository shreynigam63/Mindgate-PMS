// Rewards & Recognition — the HTTP half.
//
// The three things that decide anything live in their own pure modules,
// as asked: rnr-eligibility.js (the rule engine), rnr-quota.js (the 3%
// pool), rnr-workflow.js (the four-stage approval). This file reads the
// database, calls them, and writes down what happened. Nothing here
// decides whether somebody is eligible or whether a quota allows an
// approval — that is the point of the split, and it is what makes the
// eligibility rules testable without a database and replaceable when
// Zoho becomes the source of employee data.
//
// PERMISSIONS reuse the roles that already exist rather than inventing a
// parallel set: a manager nominates (pms_team_eval), the Delivery Head
// approves (pms_hod), the HR Business Partner approves (pms_hrbp), HR
// finalises (pms_admin). An HRBP's view is narrowed to their remit by the
// HRBP gateway, which runs on this router already.

const express = require('express');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const elig = require('./rnr-eligibility');
const quota = require('./rnr-quota');
const wf = require('./rnr-workflow');
const seed077 = require('../../migrations/077-rnr');

const router = express.Router();
const T = (req) => req.user.tenant_id;

// index.js creates the tenant AFTER runMigrations, so a fresh install
// would have an RnR module with no awards and no band mapping in it.
async function ensureMasters(tenantId) {
  const n = (await db.query(`SELECT count(*)::int n FROM rnr.awards WHERE tenant_id=$1`, [tenantId])).rows[0].n;
  if (!n) await seed077.seedFor(db, tenantId);
}

async function mastersFor(tenantId) {
  await ensureMasters(tenantId);
  const [awards, bandLevels, statuses, settings] = await Promise.all([
    db.query(`SELECT * FROM rnr.awards WHERE tenant_id=$1 ORDER BY sort_order, name`, [tenantId]),
    db.query(`SELECT band, level FROM rnr.band_levels WHERE tenant_id=$1 ORDER BY band`, [tenantId]),
    db.query(`SELECT status, is_active FROM rnr.employment_statuses WHERE tenant_id=$1 ORDER BY status`, [tenantId]),
    db.query(`SELECT value FROM rnr.settings WHERE tenant_id=$1`, [tenantId]),
  ]);
  return { awards: awards.rows, bandLevels: bandLevels.rows, statuses: statuses.rows,
    settings: (settings.rows[0] && settings.rows[0].value) || {} };
}

const activeStatusList = (statuses) => statuses.filter((s) => s.is_active).map((s) => s.status);

async function activeHeadcount(tenantId, statuses) {
  const list = activeStatusList(statuses);
  if (!list.length) return 0;
  return (await db.query(
    `SELECT count(*)::int n FROM core.employees
      WHERE tenant_id=$1 AND archived_at IS NULL AND lower(status) = ANY($2::text[])`,
    [tenantId, list.map((s) => s.toLowerCase())])).rows[0].n;
}

/** Awards already held or already nominated, per employee, for the rule engine. */
async function priorAwardsBy(tenantId, cycleId) {
  const rows = (await db.query(
    `SELECT n.employee_id, n.award_id, n.status, n.cycle_id, c.award_date, c.nominations_open
       FROM rnr.nominations n JOIN rnr.cycles c ON c.id = n.cycle_id
      WHERE n.tenant_id=$1 AND n.employee_id IS NOT NULL AND n.status <> 'rejected'`, [tenantId])).rows;
  const year = new Date().getUTCFullYear();
  const by = {};
  for (const r of rows) {
    (by[r.employee_id] = by[r.employee_id] || []).push({
      award_id: r.award_id,
      won: ['final_approved', 'awarded'].includes(r.status),
      same_cycle: cycleId && r.cycle_id === cycleId,
      same_year: new Date(r.award_date || r.nominations_open || Date.now()).getUTCFullYear() === year,
    });
  }
  return by;
}

const audit = async (tenantId, nominationId, req, action, from, to, comment) =>
  db.query(
    `INSERT INTO rnr.events (tenant_id, nomination_id, actor_email, actor_role, action, from_status, to_status, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, nominationId, req.user.email, req.user.role || null, action, from, to, comment || null])
    .catch((e) => logger.error('rnr audit failed', { error: e.message }));

// ---------------------------------------------------------------------------
// Masters

router.get('/rnr/masters', async (req, res) => {
  try {
    const m = await mastersFor(T(req));
    const head = await activeHeadcount(T(req), m.statuses);
    res.json({ ...m, active_headcount: head,
      // Said once, where HR will see it: the two columns the rules need
      // that the master does not carry yet.
      data_gaps: await dataGaps(T(req)) });
  } catch (e) { logger.error('rnr masters', { error: e.message }); res.status(500).json({ error: e.message }); }
});

/** What is missing from the employee master that the rules depend on. */
async function dataGaps(tenantId) {
  const r = (await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE role_band IS NULL OR btrim(role_band)='')::int no_band,
            count(*) FILTER (WHERE total_experience_years IS NULL)::int no_experience,
            count(*) FILTER (WHERE date_of_joining IS NULL)::int no_doj
       FROM core.employees WHERE tenant_id=$1 AND archived_at IS NULL`, [tenantId])).rows[0];
  const msgs = [];
  if (r.no_band) msgs.push(`${r.no_band} of ${r.total} employees have no band, so no band-based award can reach them.`);
  if (r.no_experience) msgs.push(`${r.no_experience} of ${r.total} have no total professional experience on record — the Junior awards are scored on it.`);
  if (r.no_doj) msgs.push(`${r.no_doj} of ${r.total} have no date of joining, so service and loyalty cannot be worked out.`);
  return { ...r, messages: msgs };
}

const adminOnly = async (req, res) => {
  if (await hasPermission(req.user, 'pms_admin')) return true;
  res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
  return false;
};

router.put('/rnr/masters/settings', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const cur = (await db.query(`SELECT value FROM rnr.settings WHERE tenant_id=$1`, [T(req)])).rows[0];
    const next = { ...((cur && cur.value) || {}), ...(req.body || {}) };
    if (next.quota_pct != null && (!(Number(next.quota_pct) >= 0) || Number(next.quota_pct) > 100)) {
      return res.status(422).json({ error: 'The quota percentage has to be between 0 and 100.' });
    }
    if (next.rounding && !['down', 'up', 'nearest'].includes(next.rounding)) {
      return res.status(422).json({ error: 'Rounding is one of: down, up, nearest.' });
    }
    await db.query(`INSERT INTO rnr.settings (tenant_id,value) VALUES ($1,$2::jsonb)
                    ON CONFLICT (tenant_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [T(req), JSON.stringify(next)]);
    res.json({ ok: true, settings: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rnr/masters/bands', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const rows = Array.isArray(req.body && req.body.bands) ? req.body.bands : [];
    for (const b of rows) {
      if (!String(b.band || '').trim()) return res.status(422).json({ error: 'Every row needs a band name.' });
      if (!['junior', 'mid', 'senior'].includes(b.level)) {
        return res.status(422).json({ error: `"${b.band}" maps to "${b.level}", which is not junior, mid or senior.` });
      }
    }
    await db.query(`DELETE FROM rnr.band_levels WHERE tenant_id=$1`, [T(req)]);
    for (const b of rows) {
      await db.query(`INSERT INTO rnr.band_levels (tenant_id,band,level) VALUES ($1,$2,$3)`,
        [T(req), String(b.band).trim(), b.level]);
    }
    res.json({ ok: true, bands: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rnr/masters/statuses', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const rows = Array.isArray(req.body && req.body.statuses) ? req.body.statuses : [];
    if (!rows.some((s) => s.is_active)) {
      return res.status(422).json({ error: 'At least one status has to count as active, or the quota denominator is zero and nobody can be nominated.' });
    }
    await db.query(`DELETE FROM rnr.employment_statuses WHERE tenant_id=$1`, [T(req)]);
    for (const s of rows) {
      await db.query(`INSERT INTO rnr.employment_statuses (tenant_id,status,is_active) VALUES ($1,$2,$3)`,
        [T(req), String(s.status).trim().toLowerCase(), !!s.is_active]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rnr/masters/awards/:id', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    const min = b.min_experience_years === '' ? null : b.min_experience_years;
    const max = b.max_experience_years === '' ? null : b.max_experience_years;
    if (min != null && max != null && Number(max) <= Number(min)) {
      return res.status(422).json({
        error: `The window has to open before it closes — ${min} to ${max} is empty. `
             + 'The maximum is exclusive, so "1 to 3" means 1 year up to but not including 3.' });
    }
    const r = await db.query(
      `UPDATE rnr.awards SET name=COALESCE($3,name), level=COALESCE($4,level),
         frequency=COALESCE($5,frequency), min_experience_years=$6, max_experience_years=$7,
         experience_basis=COALESCE($8,experience_basis), criteria=COALESCE($9,criteria),
         award_value_paise=COALESCE($10,award_value_paise), active=COALESCE($11,active),
         min_tenure_months=$12
       WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [T(req), req.params.id, b.name || null, b.level || null, b.frequency || null,
       min, max, b.experience_basis || null, b.criteria || null,
       b.award_value_paise == null ? null : Number(b.award_value_paise),
       b.active == null ? null : !!b.active,
       b.min_tenure_months === '' || b.min_tenure_months == null ? null : Number(b.min_tenure_months)]);
    if (!r.rows.length) return res.status(404).json({ error: 'award not found' });
    res.json({ ok: true, award: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Cycles and the quota

router.get('/rnr/cycles', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT c.*, (SELECT count(*)::int FROM rnr.nominations n WHERE n.cycle_id=c.id) AS nominations,
              (SELECT count(*)::int FROM rnr.nominations n WHERE n.cycle_id=c.id
                 AND n.status IN ('final_approved','awarded')) AS approved
         FROM rnr.cycles c WHERE c.tenant_id=$1 ORDER BY c.nominations_open DESC`, [T(req)])).rows;
    res.json({ cycles: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rnr/cycles', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const b = req.body || {};
    for (const f of ['name', 'kind', 'nominations_open', 'nominations_close']) {
      if (!b[f]) return res.status(422).json({ error: `${f.replace(/_/g, ' ')} is required.` });
    }
    const KINDS = require('../../migrations/080-half-yearly-cycles').KINDS;
    if (!KINDS.includes(b.kind)) {
      return res.status(422).json({ error: `A cycle is one of: ${KINDS.join(', ')}.` });
    }
    if (new Date(b.nominations_close) < new Date(b.nominations_open)) {
      return res.status(422).json({ error: 'Nominations cannot close before they open.' });
    }
    const r = await db.query(
      `INSERT INTO rnr.cycles (tenant_id,name,kind,period_label,nominations_open,nominations_close,
         approval_deadline,award_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [T(req), b.name, b.kind, b.period_label || null, b.nominations_open, b.nominations_close,
       b.approval_deadline || null, b.award_date || null]);
    res.json({ ok: true, cycle: r.rows[0] });
  } catch (e) {
    if (String(e.message).includes('uq_rnr_cycles_name')) {
      return res.status(422).json({ error: 'A cycle with that name already exists.' });
    }
    res.status(500).json({ error: e.message });
  }
});

router.post('/rnr/cycles/:id/open', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const m = await mastersFor(T(req));
    const c = (await db.query(`SELECT * FROM rnr.cycles WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'cycle not found' });
    if (c.status !== 'draft') return res.status(409).json({ error: `This cycle is already ${c.status}.` });
    // THE DENOMINATOR IS FROZEN HERE. See the note in rnr-quota.js.
    const head = await activeHeadcount(T(req), m.statuses);
    const pct = m.settings.quota_pct == null ? 3 : Number(m.settings.quota_pct);
    const total = quota.capacity(head, pct, m.settings.rounding);
    const r = await db.query(
      `UPDATE rnr.cycles SET status='open', active_headcount=$3, quota_pct=$4, quota_total=$5
        WHERE id=$1 AND tenant_id=$2 RETURNING *`, [c.id, T(req), head, pct, total]);
    logger.info('rnr cycle opened', { cycle: c.id, head, pct, total });
    res.json({ ok: true, cycle: r.rows[0],
      note: `Quota fixed at ${total} awards — ${pct}% of the ${head} active employees counted today, `
          + `rounded ${m.settings.rounding || 'down'}.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rnr/cycles/:id/close', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const r = await db.query(
      `UPDATE rnr.cycles SET status='closed' WHERE id=$1 AND tenant_id=$2 AND status='open' RETURNING *`,
      [req.params.id, T(req)]);
    if (!r.rows.length) return res.status(409).json({ error: 'Only an open cycle can be closed.' });
    res.json({ ok: true, cycle: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Where a cycle's quota stands, and how HR has split it. */
async function quotaFor(tenantId, cycle) {
  const approvedRows = (await db.query(
    `SELECT a.level, count(*)::int n FROM rnr.nominations nm JOIN rnr.awards a ON a.id=nm.award_id
      WHERE nm.tenant_id=$1 AND nm.cycle_id=$2 AND nm.status IN ('final_approved','awarded')
        AND a.counts_towards_quota
      GROUP BY a.level`, [tenantId, cycle.id])).rows;
  const approved = approvedRows.reduce((s, r) => s + r.n, 0);
  const overrides = (await db.query(
    `SELECT count(*)::int n FROM rnr.quota_overrides WHERE cycle_id=$1`, [cycle.id])).rows[0].n;
  // Approved, but outside the cap — loyalty milestones. Counted and shown
  // rather than hidden: "42 of 42 approved" beside eleven more awards
  // nobody can see is how a number stops being trusted.
  const outside = (await db.query(
    `SELECT count(*)::int n FROM rnr.nominations nm JOIN rnr.awards a ON a.id=nm.award_id
      WHERE nm.tenant_id=$1 AND nm.cycle_id=$2 AND nm.status IN ('final_approved','awarded')
        AND NOT a.counts_towards_quota`, [tenantId, cycle.id])).rows[0].n;
  const allocations = (await db.query(
    `SELECT level, slots FROM rnr.cycle_allocations WHERE cycle_id=$1`, [cycle.id])).rows;
  const st = quota.standing({
    activeCount: cycle.active_headcount, pct: cycle.quota_pct,
    rounding: null, approved, overrides,
  });
  // The cycle stores the number it was opened with; recomputing from the
  // percentage would reintroduce the drift freezing it was meant to stop.
  st.maximum = cycle.quota_total == null ? st.maximum : cycle.quota_total;
  st.balance = st.maximum - approved;
  st.exhausted = approved >= st.maximum;
  st.beyond_cap = Math.max(0, approved - st.maximum);
  return { ...st, outside_quota: outside,
    by_level: Object.fromEntries(approvedRows.map((r) => [r.level, r.n])),
    allocations: Object.fromEntries(allocations.map((a) => [a.level, a.slots])) };
}

router.get('/rnr/cycles/:id/quota', async (req, res) => {
  try {
    const c = (await db.query(`SELECT * FROM rnr.cycles WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'cycle not found' });
    res.json({ cycle: c, quota: await quotaFor(T(req), c) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/rnr/cycles/:id/allocations', async (req, res) => {
  try {
    if (!(await adminOnly(req, res))) return;
    const c = (await db.query(`SELECT * FROM rnr.cycles WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'cycle not found' });
    const v = quota.validateAllocation(req.body && req.body.allocations, c.quota_total || 0);
    if (!v.ok) return res.status(422).json({ error: v.error });
    await db.query(`DELETE FROM rnr.cycle_allocations WHERE cycle_id=$1`, [c.id]);
    for (const row of v.rows) {
      await db.query(`INSERT INTO rnr.cycle_allocations (tenant_id,cycle_id,level,slots) VALUES ($1,$2,$3,$4)`,
        [T(req), c.id, row.level, row.slots]);
    }
    res.json({ ok: true, allocated: v.total, unallocated: v.unallocated, maximum: v.maximum });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Nominating

/** The caller's reportees, or everybody for HR. */
async function nominatablePool(req) {
  const wide = await hasPermission(req.user, 'pms_admin');
  return (await db.query(
    `SELECT id, emp_code, name, email, department, designation, role_band, date_of_joining,
            status, total_experience_years, manager_id
       FROM core.employees
      WHERE tenant_id=$1 AND archived_at IS NULL ${wide ? '' : 'AND manager_id=$2'}
      ORDER BY name`, wide ? [T(req)] : [T(req), req.user.id])).rows;
}

// THE UX REQUIREMENT, stated plainly in the brief: do not show the whole
// population and ask the manager to work out eligibility. Pick the award,
// and the system lists only who qualifies — with the count per award on
// the picker itself.
router.get('/rnr/nominate/options', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) {
      return res.status(403).json({ error: "Requires 'pms_team_eval'", needs: 'pms_team_eval' });
    }
    const m = await mastersFor(T(req));
    const cycle = (await db.query(
      `SELECT * FROM rnr.cycles WHERE tenant_id=$1 AND id=$2`, [T(req), req.query.cycle_id || null])).rows[0]
      || (await db.query(`SELECT * FROM rnr.cycles WHERE tenant_id=$1 AND status='open'
                           ORDER BY nominations_open DESC LIMIT 1`, [T(req)])).rows[0];
    if (!cycle) return res.json({ cycle: null, options: [], note: 'No RnR cycle is open.' });
    const pool = await nominatablePool(req);
    const prior = await priorAwardsBy(T(req), cycle.id);
    const ctx = { asOf: cycle.award_date || cycle.nominations_close, settings: m.settings,
      bandLevels: m.bandLevels, statuses: m.statuses, priorAwardsBy: prior };
    const options = m.awards
      .filter((a) => a.active && a.frequency === cycle.kind)
      .map((a) => ({ id: a.id, key: a.key, name: a.name, level: a.level, criteria: a.criteria,
        is_team: a.is_team, discretionary: a.discretionary,
        eligible_count: a.is_team ? null : elig.eligibleFrom(pool, a, ctx).length }));
    res.json({ cycle, options, pool_size: pool.length });
  } catch (e) { logger.error('rnr options', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.get('/rnr/nominate/eligible', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) {
      return res.status(403).json({ error: "Requires 'pms_team_eval'", needs: 'pms_team_eval' });
    }
    const m = await mastersFor(T(req));
    const award = m.awards.find((a) => a.id === req.query.award_id);
    if (!award) return res.status(404).json({ error: 'award not found' });
    const cycle = (await db.query(`SELECT * FROM rnr.cycles WHERE id=$1 AND tenant_id=$2`,
      [req.query.cycle_id || null, T(req)])).rows[0];
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    const pool = await nominatablePool(req);
    const prior = await priorAwardsBy(T(req), cycle.id);
    const ctx = { asOf: cycle.award_date || cycle.nominations_close, settings: m.settings,
      bandLevels: m.bandLevels, statuses: m.statuses };
    const eligible = []; const blocked = [];
    for (const e of pool) {
      const r = elig.check(e, award, { ...ctx, priorAwards: prior[e.id] || [] });
      (r.eligible ? eligible : blocked).push({ employee: e, facts: r.facts, reasons: r.reasons });
    }
    // The blocked list is returned too, with its reasons — a manager who
    // expected somebody to be there needs to see why they are not,
    // without emailing HR, which is the process this replaces.
    res.json({ award, cycle, eligible, blocked, total: eligible.length });
  } catch (e) { logger.error('rnr eligible', { error: e.message }); res.status(500).json({ error: e.message }); }
});

router.post('/rnr/nominations', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) {
      return res.status(403).json({ error: "Requires 'pms_team_eval'", needs: 'pms_team_eval' });
    }
    const b = req.body || {};
    const m = await mastersFor(T(req));
    const award = m.awards.find((a) => a.id === b.award_id);
    if (!award) return res.status(404).json({ error: 'award not found' });
    const cycle = (await db.query(`SELECT * FROM rnr.cycles WHERE id=$1 AND tenant_id=$2`, [b.cycle_id, T(req)])).rows[0];
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    if (cycle.status !== 'open') return res.status(409).json({ error: `Nominations are not open — this cycle is ${cycle.status}.` });

    if (award.needs_justification && !String(b.justification || '').trim()) {
      return res.status(422).json({ error: 'A nomination needs a written justification. '
        + 'It is what the Delivery Head, the HRBP and HR each decide on.' });
    }

    let snapshot = null;
    if (!award.is_team) {
      if (!b.employee_id) return res.status(422).json({ error: 'Name the employee being nominated.' });
      const emp = (await db.query(
        `SELECT id, name, email, department, role_band, date_of_joining, status, total_experience_years, manager_id
           FROM core.employees WHERE id=$1 AND tenant_id=$2 AND archived_at IS NULL`, [b.employee_id, T(req)])).rows[0];
      if (!emp) return res.status(404).json({ error: 'employee not found' });
      // Nobody nominates themselves, and nobody approves their own.
      if (emp.id === req.user.id) {
        return res.status(422).json({ error: 'You cannot nominate yourself.' });
      }
      const prior = await priorAwardsBy(T(req), cycle.id);
      const r = elig.check(emp, award, {
        asOf: cycle.award_date || cycle.nominations_close, settings: m.settings,
        bandLevels: m.bandLevels, statuses: m.statuses, priorAwards: prior[emp.id] || [] });
      if (!r.eligible) {
        // THE SENTENCE THE BRIEF ASKED FOR, followed by the specific
        // reason — never just "not eligible", which sends the manager to
        // HR and recreates the process this replaces.
        return res.status(422).json({
          error: 'Employee is not eligible for this award category.',
          reasons: r.reasons, facts: r.facts });
      }
      snapshot = { ...r.facts, checked_at: new Date().toISOString(), award: award.key };
    } else if (!String(b.team_name || '').trim()) {
      return res.status(422).json({ error: 'A team award needs a team name.' });
    }

    const n = (await db.query(
      `INSERT INTO rnr.nominations (tenant_id, cycle_id, award_id, employee_id, nominated_by,
         achievement, business_impact, justification, comments, team_name, team_members, project,
         quantified_impact, status, eligibility_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending_delivery_head',$14::jsonb) RETURNING *`,
      [T(req), cycle.id, award.id, award.is_team ? null : b.employee_id, req.user.id,
       b.achievement || null, b.business_impact || null, b.justification || null, b.comments || null,
       b.team_name || null, b.team_members || null, b.project || null, b.quantified_impact || null,
       snapshot ? JSON.stringify(snapshot) : null])).rows[0];

    await audit(T(req), n.id, req, 'submit', 'draft', 'pending_delivery_head', b.justification || null);
    await notifyStage(T(req), n, award, 'pending_delivery_head').catch(() => {});
    res.json({ ok: true, nomination: n, status_label: wf.LABELS[n.status] });
  } catch (e) { logger.error('rnr nominate', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// The approval queues

const QUEUE_PERMISSION = {
  pending_delivery_head: 'pms_hod',
  pending_hrbp: 'pms_hrbp',
  pending_hr: 'pms_admin',
};

router.get('/rnr/nominations', async (req, res) => {
  try {
    const status = req.query.status || null;
    const mine = req.query.mine === 'true';
    const rows = (await db.query(
      `SELECT n.*, a.name AS award_name, a.key AS award_key, a.level AS award_level, a.is_team,
              e.name AS employee_name, e.emp_code, e.department, e.role_band, e.date_of_joining,
              e.location, e.hod_name, e.total_experience_years,
              m.name AS nominated_by_name, c.name AS cycle_name
         FROM rnr.nominations n
         JOIN rnr.awards a ON a.id=n.award_id
         JOIN rnr.cycles c ON c.id=n.cycle_id
         LEFT JOIN core.employees e ON e.id=n.employee_id
         JOIN core.employees m ON m.id=n.nominated_by
        WHERE n.tenant_id=$1 ${status ? 'AND n.status=$2' : ''} ${mine ? `AND n.nominated_by=$${status ? 3 : 2}` : ''}
        ORDER BY n.created_at DESC`,
      mine ? (status ? [T(req), status, req.user.id] : [T(req), req.user.id])
           : (status ? [T(req), status] : [T(req)]))).rows;
    res.json({ nominations: rows.map((r) => ({ ...r, status_label: wf.LABELS[r.status] || r.status })),
      total: rows.length, labels: wf.LABELS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/rnr/nominations/:id', async (req, res) => {
  try {
    const n = (await db.query(
      `SELECT n.*, a.name AS award_name, a.level AS award_level, a.criteria, a.is_team,
              e.name AS employee_name, e.emp_code, e.department, e.designation, e.role_band,
              e.date_of_joining, e.status AS employee_status, e.total_experience_years,
              e.location, e.hod_name, m.name AS nominated_by_name, c.name AS cycle_name, c.award_date
         FROM rnr.nominations n
         JOIN rnr.awards a ON a.id=n.award_id JOIN rnr.cycles c ON c.id=n.cycle_id
         LEFT JOIN core.employees e ON e.id=n.employee_id
         JOIN core.employees m ON m.id=n.nominated_by
        WHERE n.id=$1 AND n.tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!n) return res.status(404).json({ error: 'nomination not found' });
    const events = (await db.query(
      `SELECT actor_email, actor_role, action, from_status, to_status, comment, at
         FROM rnr.events WHERE nomination_id=$1 ORDER BY at`, [n.id])).rows;
    // Everything this person has had before — what an approver is
    // actually weighing, and what stops the same person winning twice.
    const history = n.employee_id ? (await db.query(
      `SELECT a.name AS award_name, c.name AS cycle_name, n2.status, n2.created_at
         FROM rnr.nominations n2 JOIN rnr.awards a ON a.id=n2.award_id
         JOIN rnr.cycles c ON c.id=n2.cycle_id
        WHERE n2.tenant_id=$1 AND n2.employee_id=$2 AND n2.id <> $3
        ORDER BY n2.created_at DESC`, [T(req), n.employee_id, n.id])).rows : [];
    res.json({ nomination: { ...n, status_label: wf.LABELS[n.status] || n.status },
      events, history, progress: wf.progress(n.status) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rnr/nominations/:id/decide', async (req, res) => {
  try {
    const b = req.body || {};
    const n = (await db.query(`SELECT * FROM rnr.nominations WHERE id=$1 AND tenant_id=$2`,
      [req.params.id, T(req)])).rows[0];
    if (!n) return res.status(404).json({ error: 'nomination not found' });

    const needed = QUEUE_PERMISSION[n.status];
    if (needed && !(await hasPermission(req.user, needed))) {
      return res.status(403).json({ error: `This nomination is waiting on ${wf.LABELS[n.status]}.`, needs: needed });
    }
    // A manager cannot approve their own nomination — stated in the brief
    // and worth enforcing rather than trusting the role split, because an
    // HR admin who is also somebody's manager holds every permission.
    if (n.nominated_by === req.user.id && ['approve'].includes(b.action)) {
      return res.status(403).json({ error: 'You raised this nomination, so you cannot approve it.' });
    }

    const t = wf.transition(n.status, b.action, { reason: b.reason });
    if (!t.ok) return res.status(422).json({ error: t.error });

    // THE QUOTA IS CHECKED AT THE LAST GATE, not earlier: a nomination
    // that fails at the Delivery Head never consumes a slot, so holding
    // one for it would shrink the cycle for everybody else.
    let overrideRow = null;
    if (b.action === 'approve' && t.next === 'final_approved') {
      const award = (await db.query(`SELECT * FROM rnr.awards WHERE id=$1`, [n.award_id])).rows[0];
      // A loyalty milestone is a fact about a date, not an award won
      // against competition. Refusing one because the pool is full would
      // be refusing to recognise that somebody has worked here ten years.
      if (award.counts_towards_quota === false) {
        await db.query(`UPDATE rnr.nominations SET status=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2`,
          [n.id, T(req), t.next]);
        await audit(T(req), n.id, req, b.action, n.status, t.next,
          `${award.name} does not consume an award slot.`);
        await notifyStage(T(req), { ...n, status: t.next }, award, t.next).catch(() => {});
        return res.json({ ok: true, status: t.next, status_label: wf.LABELS[t.next],
          outside_quota: true,
          note: `${award.name} sits outside the cycle quota, so no slot was used.` });
      }
      const cycle = (await db.query(`SELECT * FROM rnr.cycles WHERE id=$1`, [n.cycle_id])).rows[0];
      const st = await quotaFor(T(req), cycle);
      const may = quota.mayApprove({
        standing: st, level: award.level,
        levelApproved: st.by_level[award.level] || 0,
        levelSlots: st.allocations[award.level] == null ? null : st.allocations[award.level],
        override: String(b.override_reason || '').trim() ? { reason: b.override_reason } : null,
      });
      if (!may.ok) return res.status(409).json({ error: may.error, quota: st, needs_override: true });
      if (may.via === 'override') {
        overrideRow = (await db.query(
          `INSERT INTO rnr.quota_overrides (tenant_id,cycle_id,nomination_id,reason,approver_email)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [T(req), n.cycle_id, n.id, String(b.override_reason).trim(), req.user.email])).rows[0];
      }
    }

    await db.query(`UPDATE rnr.nominations SET status=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2`,
      [n.id, T(req), t.next]);
    await audit(T(req), n.id, req, b.action, n.status, t.next,
      b.reason || (overrideRow ? `HR override: ${overrideRow.reason}` : null));
    const award = (await db.query(`SELECT * FROM rnr.awards WHERE id=$1`, [n.award_id])).rows[0];
    await notifyStage(T(req), { ...n, status: t.next }, award, t.next, b.reason).catch(() => {});

    res.json({ ok: true, status: t.next, status_label: wf.LABELS[t.next],
      override: overrideRow ? { reason: overrideRow.reason, by: overrideRow.approver_email } : null });
  } catch (e) { logger.error('rnr decide', { error: e.message }); res.status(500).json({ error: e.message }); }
});

/** Who hears about it, and what they are told. */
async function notifyStage(tenantId, n, award, status, reason) {
  const tell = async (employeeId, title, body, link) => {
    if (employeeId) await notify(tenantId, employeeId, 'rnr', title, body, link).catch(() => {});
  };
  const name = award ? award.name : 'an RnR award';
  if (status === 'pending_delivery_head') {
    await tell(n.nominated_by, 'Your RnR nomination has been submitted',
      `${name} — it is now with the Delivery Head.`, '/rnr/my-nominations');
    const heads = (await db.query(
      `SELECT e.id FROM core.employees e JOIN core.user_roles ur
         ON ur.tenant_id=e.tenant_id AND lower(ur.email)=lower(e.email)
        WHERE e.tenant_id=$1 AND e.status='active' AND ur.role='hod'`, [tenantId])).rows;
    for (const h of heads) {
      await tell(h.id, 'An RnR nomination is waiting on you',
        `${name} — pending Delivery Head approval.`, '/rnr/approvals');
    }
  }
  if (status === 'rejected' || status === 'sent_back') {
    await tell(n.nominated_by,
      status === 'rejected' ? 'Your RnR nomination was rejected' : 'Your RnR nomination was sent back',
      `${name}. Reason: ${reason || 'none given'}`, '/rnr/my-nominations');
  }
  if (status === 'final_approved' && n.employee_id) {
    await tell(n.employee_id, `Congratulations — you have been selected for ${name}`,
      'Your award has been finally approved. HR will be in touch with the details.', '/home');
  }
}

module.exports = { router, quotaFor, activeHeadcount, mastersFor, dataGaps };
