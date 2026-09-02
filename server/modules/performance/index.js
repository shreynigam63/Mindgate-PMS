// Performance & Growth — module router. The appraisal spine (spec §3):
// cycles/phases → KRA sheets → self-appraisal → manager eval → HOD eval →
// calibration (+ adjustments, top talent) → publish (history + rating
// mirror) → my rating/history. Connects and PIPs included; letters generate
// a record now and the branded PDF at Phase 4 (template engine decision).
//
// Guards: phase gates via the pure machine; role gates via hasPermission
// (pms_admin / pms_team_eval / pms_hod / pms_self per the seed bundles);
// row scope (my sheet, my team) in handlers per the security skill.

const express = require('express');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { authenticate } = require('../../core/auth');
const { guardUuidParams } = require('../../core/http');
const { apiPermissionParity, hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { requireConsent } = require('../../core/consent');
const { isSuper50Eligible, computeWeightedRating } = require('./rating-rules');
const { isConnectDue, shouldRemindAgain, computeCadenceProgress } = require('./connect-reminders');
const { parseCsv, parseExcelBuffer, detectFormat } = require('../../core/employees');
const pm = require('./phase-machine');

const router = express.Router();
router.use(authenticate, apiPermissionParity);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);

const T = (req) => req.user.tenant_id;
const audit = (req, action, cycleId, employeeId, details) =>
  db.query(`INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details)
            VALUES ($1,$2,$3,$4,$5,$6)`,
    [T(req), req.user.email, action, cycleId || null, employeeId || null, details ? JSON.stringify(details) : null])
    .catch(e => logger.warn('pms audit failed', { error: e.message }));

async function activeCycle(tenantId, type = null) {
  const r = await db.query(
    `SELECT * FROM pms.cycles WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled')
      ${type ? "AND cycle_type=$2" : ''} ORDER BY created_at DESC LIMIT 1`,
    type ? [tenantId, type] : [tenantId]);
  return r.rows[0] || null;
}

// Found live: with several non-closed test cycles under one tenant (easy
// to accumulate — draft cycles started and abandoned, etc.), plain
// activeCycle()'s "most recently CREATED" heuristic can pick a newer,
// earlier-phase cycle instead of the one HR actually just advanced to
// mid_year_review — silently resolving Mid-Year Review (and its AI
// draft's KRA/connect lookups) against the WRONG cycle, so the employee
// sees "not editable" even though the right cycle is clearly open.
// Prefers whichever non-closed cycle is CURRENTLY at, or has already
// passed, mid_year_review; only falls back to plain activeCycle() (e.g.
// showing "not open yet" correctly) when none has reached it yet.
async function activeCycleForMidyear(tenantId) {
  const passed = (await db.query(
    `SELECT * FROM pms.cycles WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled')
       AND phase = ANY($2::text[])
     ORDER BY (phase='mid_year_review') DESC, created_at DESC LIMIT 1`,
    [tenantId, ['mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval', 'calibration', 'publish']])).rows[0];
  if (passed) return passed;
  return activeCycle(tenantId);
}

// BR-6.6: "For employees flagged under BR-6.5 [Super 50], proactively
// alert HR/Management to consider retention actions." Fans out an in-app
// notification to every employee holding the hr or admin role in this
// tenant (core.user_roles) — not a single fixed recipient, since who holds
// those roles varies per client/tenant. Best-effort: a failed notify() for
// one HR user must not roll back the publish that triggered it.
async function alertHrOfRetentionRisk(tenantId, employee) {
  const hrAndAdmin = (await db.query(
    `SELECT e.id FROM core.employees e JOIN core.user_roles ur ON ur.tenant_id=e.tenant_id AND LOWER(ur.email)=LOWER(e.email)
      WHERE e.tenant_id=$1 AND e.status='active' AND ur.role IN ('hr','admin')`, [tenantId])).rows;
  const title = `Retention alert: ${employee.name} is a consistent top performer`;
  const body = 'Flagged on the Super 50 watchlist (3 consecutive top-tier ratings, most recently the highest grade). Consider retention actions — a bonus, fast-track promotion, or a leadership succession conversation.';
  await Promise.all(hrAndAdmin.map((h) =>
    notify(tenantId, h.id, 'retention_alert', title, body, '/pms/watchlist').catch((e) => logger.warn('retention alert notify failed', { error: e.message }))));
  return hrAndAdmin.length;
}

// ---------------- Cycles -----------------------------------------------------
router.get('/cycles', async (req, res) => {
  const r = await db.query(`SELECT * FROM pms.cycles WHERE tenant_id=$1 ORDER BY created_at DESC`, [T(req)]);
  res.json({ cycles: r.rows });
});

// Requested: a dedicated view of each cycle's OWN history. pms.audit_log
// already records every phase advance/rollback/cancellation, calibration
// adjustment, department-head change, and several other admin actions —
// each with who did it and exactly when — but nothing anywhere read it
// back. This is the first consumer of that table; write side (the
// `audit()` helper above) is unchanged.
router.get('/cycles/:id/activity', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = (await db.query(`SELECT id, name FROM pms.cycles WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'cycle not found' });
    const rows = (await db.query(
      `SELECT al.at, al.actor_email, al.action, al.details, e.name AS employee_name
         FROM pms.audit_log al
         LEFT JOIN core.employees e ON e.id=al.employee_id
        WHERE al.tenant_id=$1 AND al.cycle_id=$2
        ORDER BY al.at DESC`, [T(req), c.id])).rows;
    res.json({ cycle: { id: c.id, name: c.name }, events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cycles', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { name, fiscal_year, cycle_type, description, rating_scale, bell_curve, opens_at, closes_at, pip_threshold } = req.body || {};
    if (!name || !fiscal_year) return res.status(400).json({ error: 'name and fiscal_year required' });
    // Default rating scale: 5 letter grades, A+ down to C (values 5-1) —
    // narrowed from an earlier 6-grade A+/A/B+/B/C/D version per a direct
    // follow-up request to drop D and match a plain 1-5 range. Bell curve
    // folds the old D bucket's 5% into C (was 10%, now 15%) rather than
    // inventing new numbers from scratch.
    // See rating-rules.js for the Super 50 (BR-6.5) A/A+ mapping — that
    // logic is intentionally untouched here: it's tied to the SEPARATE
    // 7-parameter weighted engine's own 1-5 range (BR-6.2/6.3), never to
    // this cycle-level rating_scale, so it needed no change for this.
    const r = await db.query(
      `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, cycle_type, description, rating_scale, bell_curve, opens_at, closes_at, pip_threshold, created_by)
       VALUES ($1,$2,$3,COALESCE($4,'annual'),$5,COALESCE($6,DEFAULT),COALESCE($7,DEFAULT),$8,$9,COALESCE($10,DEFAULT),$11) RETURNING *`
        .replace('COALESCE($6,DEFAULT)', `COALESCE($6, '[{"value":5,"label":"A+"},{"value":4,"label":"A"},{"value":3,"label":"B+"},{"value":2,"label":"B"},{"value":1,"label":"C"}]'::jsonb)`)
        .replace('COALESCE($7,DEFAULT)', `COALESCE($7, '{"5":5,"4":15,"3":35,"2":30,"1":15}'::jsonb)`)
        .replace('COALESCE($10,DEFAULT)', `COALESCE($10, 3.0)`),
      [T(req), name, fiscal_year, cycle_type || null, description || null, rating_scale ? JSON.stringify(rating_scale) : null,
       bell_curve ? JSON.stringify(bell_curve) : null, opens_at || null, closes_at || null, pip_threshold ?? null, req.user.email]);
    audit(req, 'CYCLE_CREATED', r.rows[0].id, null, { name, fiscal_year });
    res.json({ ok: true, cycle: r.rows[0] });
  } catch (e) { logger.error('cycle create', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Lets HR update an EXISTING cycle's rating scale/bell curve — added
// alongside narrowing the DEFAULT from 6 grades to 5, since a cycle
// created under the old default (like one already mid-use) would
// otherwise be stuck on it forever; this makes the change actually
// usable without starting a brand new cycle.
router.put('/cycles/:id/rating-scale', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { rating_scale, bell_curve } = req.body || {};
    if (rating_scale && (!Array.isArray(rating_scale) || rating_scale.some((s) => typeof s.value !== 'number' || !s.label))) {
      return res.status(422).json({ error: 'rating_scale must be an array of {value:number, label:string}' });
    }
    const r = await db.query(
      `UPDATE pms.cycles SET rating_scale=COALESCE($1,rating_scale), bell_curve=COALESCE($2,bell_curve), updated_at=now()
       WHERE id=$3 AND tenant_id=$4 RETURNING *`,
      [rating_scale ? JSON.stringify(rating_scale) : null, bell_curve ? JSON.stringify(bell_curve) : null, req.params.id, T(req)]);
    if (!r.rows.length) return res.status(404).json({ error: 'cycle not found' });
    audit(req, 'CYCLE_RATING_SCALE_UPDATED', req.params.id, null, { rating_scale, bell_curve });
    res.json({ ok: true, cycle: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// BR-7.1: threshold is configurable by HR, per cycle — see migrations/006-pip.js
// for why this is a plain number on the existing 1-5 scale rather than a
// letter grade. Editable any time (not phase-gated) since the project plan
// expects it to be revisited during UAT once real test data exists.
router.put('/cycles/:id/pip-threshold', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { threshold } = req.body || {};
    if (typeof threshold !== 'number' || threshold <= 0) return res.status(400).json({ error: 'threshold (positive number) required' });
    const r = await db.query(`UPDATE pms.cycles SET pip_threshold=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING id, pip_threshold`,
      [threshold, req.params.id, T(req)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'cycle not found' });
    audit(req, 'PIP_THRESHOLD_SET', req.params.id, null, { threshold });
    res.json({ ok: true, cycle_id: r.rows[0].id, pip_threshold: r.rows[0].pip_threshold });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Phase transitions: advance / rollback / cancel — audited, machine-checked.
// Requested: phase changes (KRA Setting opening, Self-Appraisal opening,
// etc.) sent NO notification to anyone — audit-logged, but nothing told
// employees, managers, Delivery Heads, or HR that something had opened
// for them. Scoped role-wise per a confirmed mapping: only people who
// actually have something to do in a phase get notified about it, not
// the whole tenant every time.
const PHASE_OPEN_NOTICES = {
  kra_open: [{ audience: 'all', title: 'KRA Setting is now open', body: 'Set your KRAs for this cycle.' }],
  growth_planning: [{ audience: 'all', title: 'Growth Planning is now open', body: 'Set your Development Plan and Career Path for this cycle.' }],
  mid_year_review: [
    { audience: 'all', title: 'Mid-Year Review is now open', body: 'Your Mid-Year Review is open — add your reflection and self-rating.' },
    { audience: 'managers', title: 'Mid-Year Review is now open for your team', body: 'Mid-Year Review is open for your direct reports.' },
  ],
  self_appraisal: [{ audience: 'all', title: 'Self-Appraisal is now open', body: 'Self-Appraisal is now open for this cycle.' }],
  manager_eval: [{ audience: 'managers', title: 'Team Evaluation is now open', body: 'Team Evaluation is open for your direct reports.' }],
  hod_eval: [{ audience: 'delivery_heads', title: 'Delivery Head Review is now open', body: 'Delivery Head Review is now open for your department.' }],
  calibration: [{ audience: 'hr_admin', title: 'Calibration is now open', body: 'Calibration is now open for this cycle.' }],
};

async function notifyAudience(tenantId, audience, kind, title, body, link) {
  const audienceSql = {
    all: `SELECT id FROM core.employees WHERE tenant_id=$1 AND status='active'`,
    managers: `SELECT DISTINCT manager_id AS id FROM core.employees WHERE tenant_id=$1 AND status='active' AND manager_id IS NOT NULL`,
    delivery_heads: `SELECT DISTINCT employee_id AS id FROM core.department_heads WHERE tenant_id=$1`,
    hr_admin: `SELECT e.id FROM core.employees e JOIN core.user_roles ur ON LOWER(ur.email)=LOWER(e.email) AND ur.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND ur.role IN ('admin','hr')`,
  }[audience];
  if (!audienceSql) return;
  // Single INSERT...SELECT rather than one notify() call per employee —
  // this audience can run into the hundreds, and a bulk insert avoids
  // that many sequential round trips for what's otherwise an infrequent,
  // low-stakes broadcast.
  await db.query(
    `INSERT INTO core.notifications (tenant_id, employee_id, kind, title, body, link)
     SELECT $1, aud.id, $2, $3, $4, $5 FROM (${audienceSql}) aud`,
    [tenantId, kind, title, body || null, link || null]);
}

async function sendPhaseNotices(tenantId, phase, direction) {
  const notices = PHASE_OPEN_NOTICES[phase];
  if (!notices) return;
  for (const n of notices) {
    // Titles all consistently contain "is now open" / "is open" (verified
    // against every entry above), so this transform is reliable. Bodies
    // are NOT consistently phrased that way (e.g. "Set your KRAs for this
    // cycle." has nothing to find/replace) — a regex on body text silently
    // left closing notifications saying to go do the task that just
    // closed. Using a fixed, safe close-direction body instead of trying
    // to derive one from open-direction text.
    const title = direction === 'open' ? n.title : n.title.replace('is now open', 'has closed').replace('is open', 'is now closed');
    const body = direction === 'open' ? n.body : `This is no longer open.`;
    await notifyAudience(tenantId, n.audience, 'phase_change', title, body, '/pms/my/kras');
  }
}

router.post('/cycles/:id/phase', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { to, rollback, cancel } = req.body || {};
    const c = (await db.query(`SELECT * FROM pms.cycles WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!c) return res.status(404).json({ error: 'cycle not found' });
    let target = to, check;
    if (cancel) { check = pm.canCancel(c.phase); target = 'cancelled'; }
    else if (rollback) check = pm.canRollback(c.phase, to);
    else check = pm.canAdvance(c.phase, to);
    if (!check.ok) return res.status(409).json({ error: check.reason });
    await db.query(`UPDATE pms.cycles SET phase=$1, updated_at=now() WHERE id=$2`, [target, c.id]);
    audit(req, cancel ? 'CYCLE_CANCELLED' : rollback ? 'PHASE_ROLLBACK' : 'PHASE_ADVANCE', c.id, null, { from: c.phase, to: target });
    if (cancel) {
      await notifyAudience(T(req), 'all', 'phase_change', `${c.name} has been cancelled`, 'This performance cycle has been cancelled by HR.', '/pms/my/kras');
    } else if (rollback) {
      // Rolling back closes the phase being LEFT (c.phase) — notify its
      // audience it's no longer open, same as a forward close would.
      await sendPhaseNotices(T(req), c.phase, 'close');
    } else {
      await sendPhaseNotices(T(req), target, 'open');
    }
    res.json({ ok: true, phase: target });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- KRA sheets -------------------------------------------------
// My sheet for the active cycle (auto-created on first touch with my manager).
router.get('/my/kra-sheet', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, sheet: null });
    let s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!s) {
      const mgr = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [req.user.id])).rows[0];
      s = (await db.query(
        `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [T(req), c.id, req.user.id, mgr ? mgr.manager_id : null])).rows[0];
    }
    const kras = (await db.query(`SELECT * FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [s.id])).rows;
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, sheet: s, kras, weights: pm.weightsValid(kras) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/my/kra-sheet/kras', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'kra_edit')) return res.status(409).json({ error: `KRA editing is not open (phase: ${c ? c.phase : 'none'})` });
    const s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'sheet not found — GET /my/kra-sheet first' });
    if (s.status === 'approved') return res.status(409).json({ error: 'sheet is approved — ask HR to return it for edits' });
    const kras = Array.isArray(req.body && req.body.kras) ? req.body.kras : [];
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM pms.kras WHERE sheet_id=$1`, [s.id]);
      let i = 0;
      for (const k of kras) {
        if (!k.title || !String(k.title).trim()) continue;
        await client.query(
          `INSERT INTO pms.kras (tenant_id, sheet_id, title, description, weight, measures, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [T(req), s.id, String(k.title).trim(), k.description || null, Number(k.weight) || 0, k.measures || null, (i += 10)]);
      }
      await client.query(`UPDATE pms.kra_sheets SET status='draft', updated_at=now() WHERE id=$1`, [s.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    const saved = (await db.query(`SELECT * FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [s.id])).rows;
    res.json({ ok: true, kras: saved, weights: pm.weightsValid(saved) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/my/kra-sheet/submit', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'kra_submit')) return res.status(409).json({ error: 'KRA submission is not open' });
    const s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'sheet not found' });
    const kras = (await db.query(`SELECT weight FROM pms.kras WHERE sheet_id=$1`, [s.id])).rows;
    const w = pm.weightsValid(kras);
    if (!kras.length) return res.status(422).json({ error: 'Add at least one KRA before submitting' });
    if (!w.ok) return res.status(422).json({ error: `KRA weights must total 100 (currently ${w.total})` });
    await db.query(`UPDATE pms.kra_sheets SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [s.id]);
    audit(req, 'KRA_SUBMITTED', c.id, req.user.id, { kras: kras.length });
    const n = await notifySheetSubmitted(req, T(req), req.user.id, req.user.name, false);
    // Surfaced rather than swallowed: a sheet that reaches nobody is the
    // flow quietly stalling, and the employee is the only one who can see
    // this response.
    res.json({ ok: true, manager_notified: n.notified, ...(n.reason ? { warning: `Submitted, but no manager was notified — ${n.reason}. Ask HR to set your reporting manager.` } : {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Who to notify that a sheet is waiting for approval.
//
// Reads the employee's CURRENT manager from core.employees rather than
// pms.kra_sheets.manager_id. That column is a snapshot taken when the
// sheet row was created, and GET /team/kra-sheets and the decide guard
// both already ignore it for exactly that reason — it drifts when an
// HRMS import resolves a manager_email late, or when someone changes
// manager mid-cycle. Using the snapshot here meant the sheet correctly
// appeared in the NEW manager's queue while the "submitted" notification
// went to the OLD one, or to nobody when it was unset at creation. All
// three now resolve the manager the same way.
async function notifySheetSubmitted(req, tenantId, employeeId, byName, onBehalf) {
  const emp = (await db.query(`SELECT manager_id, name FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp || !emp.manager_id) return { notified: false, reason: 'no manager set on the employee record' };
  await notify(tenantId, emp.manager_id, 'kra_submitted',
    onBehalf ? `KRA sheet submitted for ${emp.name} by ${byName}` : `KRA sheet submitted by ${byName}`,
    onBehalf ? 'Submitted on their behalf by HR.' : null, '/pms/team');
  return { notified: true };
}

// Manager: my team's sheets + approve/return.
router.get('/team/kra-sheets', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, sheets: [] });
    // Found live: a manager's direct reports could be entirely missing
    // from this list even after submitting a KRA. Two compounding causes,
    // both fixed here:
    // (1) This started FROM pms.kra_sheets (inner join), so any report
    //     who hadn't yet touched their own KRA page — no sheet row exists
    //     until they do — never appeared at all, even though they're a
    //     valid report. GET /team/evaluations already gets this right by
    //     starting FROM core.employees with a LEFT JOIN; this now matches
    //     that same, established pattern.
    // (2) It filtered on kra_sheets.manager_id, a value SNAPSHOTTED at
    //     sheet-creation time — if the employee's manager_id in
    //     core.employees was ever wrong or unset at that moment (e.g. an
    //     HRMS import whose manager_email hadn't resolved yet) and only
    //     corrected afterwards, the sheet's stored snapshot never caught
    //     up. Now checks the employee's CURRENT manager_id live instead.
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name AS employee_name, e.email AS employee_email,
              s.id, s.status, s.manager_comment,
              COALESCE((SELECT COUNT(*)::int FROM pms.kras k WHERE k.sheet_id=s.id), 0) AS kra_count,
              COALESCE((SELECT SUM(k.weight) FROM pms.kras k WHERE k.sheet_id=s.id), 0) AS total_weight
         FROM core.employees e
         LEFT JOIN pms.kra_sheets s ON s.cycle_id=$1 AND s.employee_id=e.id
        WHERE e.tenant_id=$2 AND e.manager_id=$3 AND e.status='active' ORDER BY e.name`, [c.id, T(req), req.user.id]);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, sheets: r.rows.map((row) => ({ ...row, status: row.status || 'not_started' })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/kra-sheets/:sheetId/decide', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const { decision, comment } = req.body || {};
    if (!['approved', 'returned'].includes(decision)) return res.status(400).json({ error: "decision must be 'approved' or 'returned'" });
    const s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE id=$1 AND tenant_id=$2`, [req.params.sheetId, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'sheet not found' });
    // Live check against core.employees, not the stored (possibly stale)
    // kra_sheets.manager_id snapshot — see GET /team/kra-sheets above for
    // why that snapshot can drift.
    const decideEmp = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [s.employee_id])).rows[0];
    if ((!decideEmp || decideEmp.manager_id !== req.user.id) && !(await hasPermission(req.user, 'pms_admin')))
      return res.status(403).json({ error: 'Not your report' });
    if (s.status !== 'submitted') return res.status(409).json({ error: `sheet is ${s.status}, not submitted` });
    if (decision === 'returned' && !(comment && comment.trim())) return res.status(422).json({ error: 'A return needs a comment — the employee must know why' });
    await db.query(`UPDATE pms.kra_sheets SET status=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
      [decision, comment || null, s.id]);
    audit(req, `KRA_${decision.toUpperCase()}`, s.cycle_id, s.employee_id, { comment: comment || null });
    await notify(T(req), s.employee_id, 'kra_decided', `Your KRA sheet was ${decision}`, comment || null, '/pms');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fix guide item #5: managers had a list of pending sheets (above) but no
// way to see the actual KRA line items before approving/returning one —
// GET /team/kra-sheets only ever returned counts (kra_count/total_weight).
// This mirrors GET /my/kra-sheet's shape (sheet + kras + weights) but
// scoped to a manager viewing one of their reports' sheets.
router.get('/team/kra-sheets/:sheetId/kras', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE id=$1 AND tenant_id=$2`, [req.params.sheetId, T(req)])).rows[0];
    if (!s) return res.status(404).json({ error: 'sheet not found' });
    const viewEmp = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [s.employee_id])).rows[0];
    if ((!viewEmp || viewEmp.manager_id !== req.user.id) && !(await hasPermission(req.user, 'pms_admin')))
      return res.status(403).json({ error: 'Not your report' });
    const kras = (await db.query(`SELECT * FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [s.id])).rows;
    res.json({ sheet: s, kras, weights: pm.weightsValid(kras) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- HR: org-wide KRA overview + enter-on-behalf — BR-1.1/1.4 -
// FOUND MISSING 28-Aug-2026: /team/kra-sheets (above) is manager-scoped
// (WHERE manager_id=req.user.id) — there was no HR-wide view across every
// employee, and every KRA edit/submit route was hardcoded to req.user.id,
// so HR literally could not enter a KRA on someone else's behalf despite
// BR-1.4 requiring it. This section is the fix: an org-wide status view
// with search, and HR-scoped edit/submit routes parameterized by
// employee_id instead of assuming "self".
router.get('/kra/org-overview', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, counters: {}, employees: [] });
    const q = (req.query.q || '').trim();
    const rows = (await db.query(
      `SELECT e.id AS employee_id, e.name, e.department, m.name AS manager_name,
              s.id AS sheet_id, COALESCE(s.status, 'not_started') AS status,
              (SELECT COUNT(*)::int FROM pms.kras k WHERE k.sheet_id=s.id) AS kra_count
         FROM core.employees e
         LEFT JOIN core.employees m ON m.id=e.manager_id
         LEFT JOIN pms.kra_sheets s ON s.cycle_id=$1 AND s.employee_id=e.id
        WHERE e.tenant_id=$2 AND e.status='active'
          ${q ? "AND (e.name ILIKE $3 OR e.email ILIKE $3 OR e.department ILIKE $3)" : ''}
        ORDER BY e.name`,
      q ? [c.id, T(req), `%${q}%`] : [c.id, T(req)])).rows;
    const counters = { draft: 0, submitted: 0, returned: 0, approved: 0, not_started: 0 };
    for (const r of rows) counters[r.status] = (counters[r.status] || 0) + 1;
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, counters, employees: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ensures a sheet row exists for the target employee, same auto-create
// behaviour as GET /my/kra-sheet, so "enter on behalf" starts from the
// same clean state a self-service edit would.
async function ensureKraSheet(tenantId, cycleId, employeeId) {
  let s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [cycleId, employeeId])).rows[0];
  if (!s) {
    const mgr = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [employeeId])).rows[0];
    s = (await db.query(
      `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, cycleId, employeeId, mgr ? mgr.manager_id : null])).rows[0];
  }
  return s;
}

// GET /pms/hr/kra-sheet/bulk-upload-template.csv — same reasoning as the
// employee import template: a real "Download template" link instead of
// asking HR to guess the expected columns. Header matches
// KRA_BULK_KNOWN exactly; example rows show two KRAs for one employee
// whose weights sum to 100, since that grouping rule is the least
// obvious part of the format — remove the example rows before uploading.
//
// MUST be registered before GET /hr/kra-sheet/:employeeId below — Express
// matches routes in registration order, and ":employeeId" matches ANY
// path segment, including this literal one. Registering it after :employeeId
// caused exactly this: a request for .../bulk-upload-template.csv was
// swallowed by the param route, which then tried to use the literal
// string "bulk-upload-template.csv" as a uuid in a SQL query and failed
// with "invalid input syntax for type uuid" — found live during testing.
router.get('/hr/kra-sheet/bulk-upload-template.csv', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const rows = [
      KRA_BULK_KNOWN.join(','),
      ['jane.sample@example.com', 'Improve client response time to <24hrs', '60', 'Own first-response SLA for assigned accounts', 'Avg response time tracked in helpdesk'].join(','),
      ['jane.sample@example.com', 'Complete onboarding automation project', '40', 'Reduce manual setup steps for new joiners', 'Onboarding checklist automated in HRMS'].join(','),
    ];
    const csv = rows.join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="kra_bulk_upload_template.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/hr/kra-sheet/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, sheet: null, kras: [] });
    const emp = (await db.query(`SELECT id, name FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    const s = await ensureKraSheet(T(req), c.id, emp.id);
    const kras = (await db.query(`SELECT * FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [s.id])).rows;
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, employee: emp, sheet: s, kras, weights: pm.weightsValid(kras) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/hr/kra-sheet/:employeeId/kras', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'kra_edit')) return res.status(409).json({ error: `KRA editing is not open (phase: ${c ? c.phase : 'none'})` });
    const s = await ensureKraSheet(T(req), c.id, req.params.employeeId);
    if (s.status === 'approved') return res.status(409).json({ error: 'sheet is approved — return it for edits first' });
    const kras = Array.isArray(req.body && req.body.kras) ? req.body.kras : [];
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM pms.kras WHERE sheet_id=$1`, [s.id]);
      let i = 0;
      for (const k of kras) {
        if (!k.title || !String(k.title).trim()) continue;
        await client.query(
          `INSERT INTO pms.kras (tenant_id, sheet_id, title, description, weight, measures, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [T(req), s.id, String(k.title).trim(), k.description || null, Number(k.weight) || 0, k.measures || null, (i += 10)]);
      }
      await client.query(`UPDATE pms.kra_sheets SET status='draft', updated_at=now() WHERE id=$1`, [s.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    const saved = (await db.query(`SELECT * FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [s.id])).rows;
    audit(req, 'KRA_ENTERED_ON_BEHALF', c.id, req.params.employeeId, { kras: saved.length });
    res.json({ ok: true, kras: saved, weights: pm.weightsValid(saved) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/hr/kra-sheet/:employeeId/submit', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'kra_submit')) return res.status(409).json({ error: 'KRA submission is not open' });
    const s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    if (!s) return res.status(404).json({ error: 'sheet not found' });
    const kras = (await db.query(`SELECT weight FROM pms.kras WHERE sheet_id=$1`, [s.id])).rows;
    const w = pm.weightsValid(kras);
    if (!kras.length) return res.status(422).json({ error: 'Add at least one KRA before submitting' });
    if (!w.ok) return res.status(422).json({ error: `KRA weights must total 100 (currently ${w.total})` });
    await db.query(`UPDATE pms.kra_sheets SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [s.id]);
    audit(req, 'KRA_SUBMITTED_ON_BEHALF', c.id, req.params.employeeId, { kras: kras.length });
    // HR's on-behalf path is a deliberate backstop for employees who do not
    // self-serve, so it has to feed the SAME approval flow. It previously
    // did not notify anyone, so a sheet HR submitted sat in the manager's
    // queue with nothing telling them it had arrived — the flow stalled
    // precisely for the people who most needed HR to step in.
    const n = await notifySheetSubmitted(req, T(req), req.params.employeeId, req.user.name, true);
    res.json({ ok: true, manager_notified: n.notified, ...(n.reason ? { warning: `Submitted, but no manager was notified — ${n.reason}.` } : {}) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HR: reopen an APPROVED sheet for edits.
//
// Closes a genuine dead end. Three separate places told users to "return
// it for edits first" or "ask HR to return it" — the employee PUT, the HR
// PUT and the bulk upload all refuse an approved sheet — but no route
// could actually move one out of `approved`: the manager's decide route
// only accepts status='submitted'. So a typo found after approval was
// frozen for the rest of the cycle, and the advice the app itself gave
// was impossible to follow.
//
// Lands on `returned`, not `draft`, so it re-enters the existing flow at
// a state the employee's screen already understands and displays with the
// reason attached — and so it must be re-submitted and re-approved rather
// than quietly becoming live again.
//
// Requires the cycle to still allow KRA editing. Reopening into a phase
// where nobody can edit would produce a sheet that is unlocked and
// unusable at the same time; failing here with an instruction to roll the
// cycle back is the honest outcome.
router.post('/hr/kra-sheet/:employeeId/reopen', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { comment } = req.body || {};
    if (!comment || !String(comment).trim()) {
      return res.status(422).json({ error: 'A reopen needs a comment — the employee must know what to change.' });
    }
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    if (!pm.phaseAllows(c.phase, 'kra_edit')) {
      return res.status(409).json({ error: `KRA editing is closed in the ${c.phase} phase — roll the cycle back to KRA Setting before reopening a sheet, or the employee will not be able to edit it.` });
    }
    const s = (await db.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    if (!s) return res.status(404).json({ error: 'sheet not found' });
    if (s.status !== 'approved') return res.status(409).json({ error: `sheet is ${s.status}, not approved — only an approved sheet needs reopening` });

    await db.query(
      `UPDATE pms.kra_sheets SET status='returned', manager_comment=$1, decided_at=now(), updated_at=now() WHERE id=$2`,
      [String(comment).trim(), s.id]);
    audit(req, 'KRA_REOPENED', c.id, s.employee_id, { comment: String(comment).trim(), from: 'approved' });
    await notify(T(req), s.employee_id, 'kra_reopened', 'Your approved KRA sheet was reopened for edits', String(comment).trim(), '/pms');
    res.json({ ok: true, status: 'returned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- HR: bulk KRA upload — BR-1.1 ------------------------------
// "A bulk Excel upload option must be made available so as to avoid manual
// entry work in PMS." The existing bulk importer (core/employees.js) only
// covers employee MASTER data (name/email/manager/etc) — this is the
// missing piece for KRA CONTENT itself. Deliberately reuses the exact same
// parsing/validation/dry-run pattern (same shared parseCsv/parseExcelBuffer,
// same header-normalisation, same per-row line-numbered errors, same
// ?commit=1-required-to-load default) so behaviour is consistent and
// familiar to whoever already uses the employee importer.
//
// Columns (header row, case-insensitive, order-free):
//   employee_email, kra_title, weight, description, measures
// Rows are grouped by employee_email; each employee's KRA weights must sum
// to 100 (same weightsValid() rule as the single-entry route) before ANY
// row commits — a bad file for one employee should not partially load.
const KRA_BULK_REQUIRED = ['employee_email', 'kra_title', 'weight'];
const KRA_BULK_KNOWN = ['employee_email', 'kra_title', 'weight', 'description', 'measures'];

function validateKraBulkRows(rows, knownEmails, empByEmail) {
  if (!rows.length) return { ok: false, fatal: 'Empty file', rows: [], errors: [], warnings: [] };
  const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = KRA_BULK_REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) return { ok: false, fatal: `Missing required column(s): ${missing.join(', ')}`, rows: [], errors: [], warnings: [] };
  const unknown = header.filter((h) => !KRA_BULK_KNOWN.includes(h));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = []; const errors = []; const warnings = [];

  rows.slice(1).forEach((r, n) => {
    const line = n + 2; // 1-based + header
    const get = (c) => (idx[c] != null ? String(r[idx[c]] ?? '').trim() : '');
    const rec = {
      line,
      employee_email: get('employee_email').toLowerCase(),
      kra_title: get('kra_title'),
      weight: Number(get('weight')),
      description: get('description') || null,
      measures: get('measures') || null,
    };
    if (!rec.employee_email) errors.push({ line, error: 'employee_email is empty' });
    else if (!knownEmails.has(rec.employee_email)) errors.push({ line, error: `employee_email "${rec.employee_email}" not found among active employees` });
    if (!rec.kra_title) errors.push({ line, error: 'kra_title is empty' });
    if (!Number.isFinite(rec.weight) || rec.weight <= 0) errors.push({ line, error: `weight must be a positive number (got "${get('weight')}")` });
    // Found live: a bulk upload where the source file's kra_title column
    // had "(Employee Name - Designation)" typed onto the end of every
    // title, presumably by whoever filled the sheet — not something our
    // own code adds, confirmed by reading the parsing code, which passes
    // kra_title through verbatim. Warn (not reject) so it's caught at the
    // dry-run/Validate step, before it's committed, rather than after.
    const emp = empByEmail && empByEmail.get(rec.employee_email);
    if (emp && rec.kra_title) {
      const titleLower = rec.kra_title.toLowerCase();
      if (emp.name && titleLower.includes(emp.name.toLowerCase())) {
        warnings.push({ line, warning: `kra_title appears to include the employee's own name ("${emp.name}") — consider removing it for a cleaner display` });
      } else if (emp.designation && titleLower.includes(emp.designation.toLowerCase())) {
        warnings.push({ line, warning: `kra_title appears to include the employee's own designation ("${emp.designation}") — consider removing it for a cleaner display` });
      }
    }
    out.push(rec);
  });

  if (unknown.length) warnings.push({ line: 1, warning: `ignored unknown column(s): ${unknown.join(', ')}` });

  // Per-employee weight-sum check — same rule PUT /my/kra-sheet/kras enforces
  // at submit time, checked here up front so a bad file fails as a whole.
  const byEmployee = new Map();
  for (const r of out) {
    if (!r.employee_email) continue;
    if (!byEmployee.has(r.employee_email)) byEmployee.set(r.employee_email, []);
    byEmployee.get(r.employee_email).push(r);
  }
  for (const [email, kras] of byEmployee) {
    const check = pm.weightsValid(kras);
    if (!check.ok) errors.push({ line: kras[0].line, error: `${email}: KRA weights must total 100 (currently ${check.total})` });
  }

  return {
    ok: errors.length === 0, fatal: null, rows: out, errors, warnings,
    summary: { total_rows: out.length, employees: byEmployee.size, errors: errors.length, warnings: warnings.length },
  };
}

const kraUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(csv|xlsx|xls)$/i.test(file.originalname || '')) return cb(new Error('Only .csv, .xlsx, or .xls files are accepted'));
    cb(null, true);
  },
});

// POST /pms/hr/kra-sheet/bulk-upload (multipart file) ?commit=1 to load; dry run by default.
router.post('/hr/kra-sheet/bulk-upload', (req, res, next) => kraUpload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
}), async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'kra_edit')) return res.status(409).json({ error: `KRA editing is not open (phase: ${c ? c.phase : 'none'})` });

    const format = detectFormat(req.file);
    if (format === 'xls-legacy') {
      return res.status(400).json({ error: 'Legacy .xls files are not supported — please re-save the file as .xlsx (File > Save As > Excel Workbook) and upload again.' });
    }

    const employees = (await db.query(`SELECT LOWER(email) AS email, id, manager_id, name, designation FROM core.employees WHERE tenant_id=$1 AND status='active'`, [T(req)])).rows;
    const knownEmails = new Set(employees.map((e) => e.email));
    const empByEmail = new Map(employees.map((e) => [e.email, e]));

    const parsedRows = format === 'xlsx' ? await parseExcelBuffer(req.file.buffer) : parseCsv(req.file.buffer.toString('utf8'));
    const report = validateKraBulkRows(parsedRows, knownEmails, empByEmail);
    if (report.fatal) return res.status(400).json({ error: report.fatal });
    const commit = req.query.commit === '1';
    if (!report.ok) return res.status(422).json({ ok: false, committed: false, ...report });
    if (!commit) return res.json({ ok: true, committed: false, note: 'Dry run — pass ?commit=1 to load.', ...report });

    const byEmployee = new Map();
    for (const r of report.rows) {
      if (!byEmployee.has(r.employee_email)) byEmployee.set(r.employee_email, []);
      byEmployee.get(r.employee_email).push(r);
    }
    const skipped = [];
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const [email, kras] of byEmployee) {
        const emp = empByEmail.get(email);
        let s = (await client.query(`SELECT * FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, emp.id])).rows[0];
        if (!s) {
          s = (await client.query(
            `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING *`,
            [T(req), c.id, emp.id, emp.manager_id])).rows[0];
        } else if (s.status === 'approved') {
          skipped.push({ email, reason: 'sheet already approved — return it for edits first' });
          continue; // don't silently overwrite an already-approved sheet
        }
        await client.query(`DELETE FROM pms.kras WHERE sheet_id=$1`, [s.id]);
        let i = 0;
        for (const k of kras) {
          await client.query(
            `INSERT INTO pms.kras (tenant_id, sheet_id, title, description, weight, measures, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [T(req), s.id, k.kra_title, k.description, k.weight, k.measures, (i += 10)]);
        }
        await client.query(`UPDATE pms.kra_sheets SET status='draft', updated_at=now() WHERE id=$1`, [s.id]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    audit(req, 'KRA_BULK_UPLOAD', c.id, null, report.summary);
    res.json({ ok: true, committed: true, employees_loaded: byEmployee.size - skipped.length, skipped, warnings: report.warnings, summary: report.summary });
  } catch (e) { logger.error('kra bulk upload', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------- Development Plan (Org IDP) — BR-2.1/2.2/2.3 --------------
// Mirrors the KRA sheet pattern above deliberately: same draft/submitted/
// approved/returned lifecycle, same kra_open phase window (new devplan_*
// actions within it, see phase-machine.js), same one-row-per-employee-
// per-cycle shape. Progress updates (BR-2.3) are the one exception — NOT
// phase-gated, since "see progress at any point in the year" means
// ongoing tracking outside the KRA-setting window, once a plan exists.
router.get('/my/development-plan', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, plan: null, goals: [] });
    let p = (await db.query(`SELECT * FROM pms.development_plans WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!p) {
      const mgr = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [req.user.id])).rows[0];
      p = (await db.query(
        `INSERT INTO pms.development_plans (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING *`,
        [T(req), c.id, req.user.id, mgr ? mgr.manager_id : null])).rows[0];
    }
    const goals = (await db.query(`SELECT * FROM pms.development_goals WHERE plan_id=$1 ORDER BY sort_order`, [p.id])).rows;
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, plan: p, goals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/my/development-plan/goals', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'devplan_edit')) return res.status(409).json({ error: `Development plan editing is not open (phase: ${c ? c.phase : 'none'})` });
    const p = (await db.query(`SELECT * FROM pms.development_plans WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'plan not found — GET /my/development-plan first' });
    if (p.status === 'approved') return res.status(409).json({ error: 'plan is approved — ask HR to return it for edits' });
    const goals = Array.isArray(req.body && req.body.goals) ? req.body.goals : [];
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM pms.development_goals WHERE plan_id=$1`, [p.id]);
      let i = 0;
      for (const g of goals) {
        if (!g.title || !String(g.title).trim()) continue;
        await client.query(
          `INSERT INTO pms.development_goals (tenant_id, plan_id, title, description, target_date, progress_pct, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [T(req), p.id, String(g.title).trim(), g.description || null, g.target_date || null, Math.min(100, Math.max(0, Number(g.progress_pct) || 0)), (i += 10)]);
      }
      await client.query(`UPDATE pms.development_plans SET status='draft', updated_at=now() WHERE id=$1`, [p.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    const saved = (await db.query(`SELECT * FROM pms.development_goals WHERE plan_id=$1 ORDER BY sort_order`, [p.id])).rows;
    res.json({ ok: true, goals: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/my/development-plan/submit', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'devplan_submit')) return res.status(409).json({ error: 'Development plan submission is not open' });
    const p = (await db.query(`SELECT * FROM pms.development_plans WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'plan not found' });
    const goals = (await db.query(`SELECT id FROM pms.development_goals WHERE plan_id=$1`, [p.id])).rows;
    if (!goals.length) return res.status(422).json({ error: 'Add at least one development goal before submitting' });
    await db.query(`UPDATE pms.development_plans SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [p.id]);
    audit(req, 'DEVPLAN_SUBMITTED', c.id, req.user.id, { goals: goals.length });
    if (p.manager_id) await notify(T(req), p.manager_id, 'devplan_submitted', `Development plan submitted by ${req.user.name}`, null, '/pms/team');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Progress update — deliberately NOT phase-gated (BR-2.3: "at any point in
// the year"). Either the employee themself or their manager may update it;
// it's the one field on an already-approved plan either party can still
// touch.
router.put('/my/development-plan/goals/:goalId/progress', async (req, res) => {
  try {
    const g = (await db.query(
      `SELECT dg.*, dp.employee_id, dp.manager_id FROM pms.development_goals dg
         JOIN pms.development_plans dp ON dp.id=dg.plan_id WHERE dg.id=$1 AND dg.tenant_id=$2`,
      [req.params.goalId, T(req)])).rows[0];
    if (!g) return res.status(404).json({ error: 'goal not found' });
    if (g.employee_id !== req.user.id && g.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: 'Not your goal or report' });
    }
    const { progress_pct } = req.body || {};
    const n = Number(progress_pct);
    if (Number.isNaN(n) || n < 0 || n > 100) return res.status(400).json({ error: 'progress_pct must be between 0 and 100' });
    await db.query(`UPDATE pms.development_goals SET progress_pct=$1 WHERE id=$2`, [n, g.id]);
    res.json({ ok: true, progress_pct: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager: my team's plans + approve/return.
router.get('/team/development-plans', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, plans: [] });
    const r = await db.query(
      `SELECT p.*, e.name AS employee_name, e.email AS employee_email,
              (SELECT COUNT(*)::int FROM pms.development_goals g WHERE g.plan_id=p.id) AS goal_count,
              (SELECT COALESCE(AVG(g.progress_pct),0)::int FROM pms.development_goals g WHERE g.plan_id=p.id) AS avg_progress
         FROM pms.development_plans p JOIN core.employees e ON e.id=p.employee_id
        WHERE p.cycle_id=$1 AND p.manager_id=$2 ORDER BY e.name`, [c.id, req.user.id]);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, plans: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager needed to Approve/Return with only a goal count + avg progress
// visible — no way to actually read what the employee wrote before
// deciding. Mirrors GET /team/kra-sheets/:sheetId/kras' shape (plan +
// full goal list), scoped to the manager the same way.
router.get('/team/development-plans/:planId/goals', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const p = (await db.query(`SELECT * FROM pms.development_plans WHERE id=$1 AND tenant_id=$2`, [req.params.planId, T(req)])).rows[0];
    if (!p) return res.status(404).json({ error: 'plan not found' });
    if (p.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin')))
      return res.status(403).json({ error: 'Not your report' });
    const goals = (await db.query(`SELECT * FROM pms.development_goals WHERE plan_id=$1 ORDER BY sort_order`, [p.id])).rows;
    res.json({ plan: p, goals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/development-plans/:planId/decide', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const { decision, comment } = req.body || {};
    if (!['approved', 'returned'].includes(decision)) return res.status(400).json({ error: "decision must be 'approved' or 'returned'" });
    const p = (await db.query(`SELECT * FROM pms.development_plans WHERE id=$1 AND tenant_id=$2`, [req.params.planId, T(req)])).rows[0];
    if (!p) return res.status(404).json({ error: 'plan not found' });
    if (p.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin')))
      return res.status(403).json({ error: 'Not your report' });
    if (p.status !== 'submitted') return res.status(409).json({ error: `plan is ${p.status}, not submitted` });
    if (decision === 'returned' && !(comment && comment.trim())) return res.status(422).json({ error: 'A return needs a comment — the employee must know why' });
    await db.query(`UPDATE pms.development_plans SET status=$1, manager_comment=$2, decided_at=now(), updated_at=now() WHERE id=$3`,
      [decision, comment || null, p.id]);
    audit(req, `DEVPLAN_${decision.toUpperCase()}`, p.cycle_id, p.employee_id, { comment: comment || null });
    await notify(T(req), p.employee_id, 'devplan_decided', `Your development plan was ${decision}`, comment || null, '/pms/my-growth');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Self-appraisal --------------------------------------------
router.get('/my/self-appraisal', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null });
    let a = (await db.query(`SELECT * FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!a) a = (await db.query(
      `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id) VALUES ($1,$2,$3) RETURNING *`,
      [T(req), c.id, req.user.id])).rows[0];
    const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    const kras = sheet ? (await db.query(`SELECT id, title, weight FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase, cycle_type: c.cycle_type, rating_scale: c.rating_scale }, appraisal: a, kras });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/my/self-appraisal', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'self_edit')) return res.status(409).json({ error: `Self-appraisal is not open (phase: ${c ? c.phase : 'none'})` });
    const a = (await db.query(`SELECT * FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'GET /my/self-appraisal first' });
    if (a.status === 'submitted') return res.status(409).json({ error: 'Already submitted — locked' });
    const b = req.body || {};
    // Requested: a rating scale per KRA (not just one free-standing
    // "overall" pick), with the overall derived as the WEIGHTED AVERAGE
    // of those — reusing computeWeightedRating (the same weighted-average
    // math the 7-parameter annual engine already uses and has tests for),
    // just fed KRA weights + entries[*].self_rating instead of
    // organizational parameters. This is why overall_self_rating is
    // computed here, not taken from validateRating's discrete-match check
    // — an average of discrete grades is legitimately fractional (e.g.
    // 3.7), and that's correct, not an invalid value.
    //
    // UPDATED: on an ANNUAL cycle, overall_self_rating is now exclusively
    // driven by the 7-parameter self-scoring (PUT /my/parameter-scores),
    // same as the manager's overall_rating is exclusively driven by the
    // manager's 7-parameter scoring — the per-KRA average below is left
    // for non-annual cycles only, so the two computations never fight
    // over the same column.
    let overallRating = a.overall_self_rating;
    if (b.entries && c.cycle_type !== 'annual') {
      const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
      const kras = sheet ? (await db.query(`SELECT id, weight AS weight_pct FROM pms.kras WHERE sheet_id=$1`, [sheet.id])).rows : [];
      const scores = new Map(kras.map((k) => [k.id, b.entries[k.id] ? b.entries[k.id].self_rating : null]));
      const { rating } = computeWeightedRating(kras, scores);
      if (rating != null) overallRating = rating;
    } else if (b.overall_self_rating != null && c.cycle_type !== 'annual') {
      const rv = validateRating(b.overall_self_rating, c.rating_scale);
      if (!rv.ok) return res.status(422).json({ error: rv.reason });
      overallRating = rv.value;
    }
    await db.query(
      `UPDATE pms.self_appraisals SET status='in_progress',
         entries=COALESCE($2,entries), overall_self_rating=$3,
         went_well=COALESCE($4,went_well), could_improve=COALESCE($5,could_improve), updated_at=now()
       WHERE id=$1`,
      [a.id, b.entries ? JSON.stringify(b.entries) : null, overallRating, b.went_well ?? null, b.could_improve ?? null]);
    res.json({ ok: true, overall_self_rating: overallRating });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/my/self-appraisal/submit', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'self_submit')) return res.status(409).json({ error: 'Self-appraisal submission is not open' });
    const a = (await db.query(`SELECT * FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'nothing to submit' });
    if (a.status === 'submitted') return res.status(409).json({ error: 'already submitted' });
    // Requested: on an annual cycle, the employee must complete their
    // 7-parameter self-scoring before they can submit — mirrors the
    // manager side, where overall_rating (from the SAME 7 parameters)
    // must be complete before the manager's own evaluation submits.
    if (c.cycle_type === 'annual') {
      const params = (await db.query(`SELECT id, weight_pct FROM pms.review_parameters WHERE tenant_id=$1 AND active=true`, [T(req)])).rows;
      const scored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='self'`, [T(req), c.id, req.user.id])).rows;
      const scoreMap = Object.fromEntries(scored.map((s) => [s.parameter_id, Number(s.score)]));
      const weighted = computeWeightedRating(params, scoreMap);
      if (!weighted.complete) return res.status(422).json({ error: `Score all 7 organisational parameters before submitting (${weighted.missing.length} remaining)` });
    }
    await db.query(`UPDATE pms.self_appraisals SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [a.id]);
    audit(req, 'SELF_APPRAISAL_SUBMITTED', c.id, req.user.id, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Evidence upload — supports self-appraisal narratives ----
// pms.evidence existed since migration 003 with nothing writing to it
// ("Storage iface deferred to first upload need"). File bytes are stored
// directly in Postgres (bytea) — see migrations/013-file-storage.js for
// why, given Render's ephemeral filesystem and no object-storage
// credentials configured in this environment.
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/my/self-appraisal/evidence', (req, res, next) => evidenceUpload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
}), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const a = (await db.query(`SELECT * FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'GET /my/self-appraisal first' });
    if (a.status === 'submitted') return res.status(409).json({ error: 'Self-appraisal is submitted — cannot attach more evidence' });
    const { kra_id } = req.body || {};
    const row = (await db.query(
      `INSERT INTO pms.evidence (tenant_id, appraisal_id, kra_id, filename, file_data, content_type, file_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, filename, kra_id, file_size, uploaded_at`,
      [T(req), a.id, kra_id || null, req.file.originalname, req.file.buffer, req.file.mimetype, req.file.size])).rows[0];
    res.json({ ok: true, evidence: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/my/self-appraisal/evidence', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c) return res.json({ evidence: [] });
    const a = (await db.query(`SELECT id FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (!a) return res.json({ evidence: [] });
    const r = await db.query(
      `SELECT id, filename, kra_id, content_type, file_size, uploaded_at FROM pms.evidence WHERE appraisal_id=$1 ORDER BY uploaded_at DESC`, [a.id]);
    res.json({ evidence: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared download route — the evidence owner, their manager, or HR/admin
// may download. Streams the bytes with the original filename/content-type.
router.get('/evidence/:id/download', async (req, res) => {
  try {
    const row = (await db.query(
      `SELECT ev.*, sa.employee_id, e.manager_id FROM pms.evidence ev
         JOIN pms.self_appraisals sa ON sa.id=ev.appraisal_id
         JOIN core.employees e ON e.id=sa.employee_id
        WHERE ev.id=$1 AND ev.tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!row) return res.status(404).json({ error: 'evidence not found' });
    const isOwner = row.employee_id === req.user.id;
    const isManager = row.manager_id === req.user.id;
    if (!isOwner && !isManager && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not authorised to view this evidence' });
    if (!row.file_data) return res.status(404).json({ error: 'file data not found' });
    res.setHeader('Content-Type', row.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
    res.send(row.file_data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/my/self-appraisal/evidence/:id', async (req, res) => {
  try {
    const row = (await db.query(
      `SELECT ev.id, sa.employee_id, sa.status FROM pms.evidence ev JOIN pms.self_appraisals sa ON sa.id=ev.appraisal_id
        WHERE ev.id=$1 AND ev.tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!row) return res.status(404).json({ error: 'evidence not found' });
    if (row.employee_id !== req.user.id) return res.status(403).json({ error: 'Not your evidence' });
    if (row.status === 'submitted') return res.status(409).json({ error: 'Self-appraisal is submitted — cannot remove evidence' });
    await db.query(`DELETE FROM pms.evidence WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Mid-Year 7-Parameter Pulse Check (BRD Fig. 7b) -----------
// Self-only, informational, deliberately isolated from the Annual
// Review's 7-parameter engine (migrations/011-pulse-check.js explains
// why it's a separate table). No submit/approval step — "for their own
// reference" means there is nothing to route anywhere. Available only on
// a midyear cycle; the parameters/weights shown are the same
// pms.review_parameters HR configures for Annual, since Fig. 7b shows
// "the same 7 Organisational Drivers that will be formally scored at
// year-end" — but scoring here writes only to pms.pulse_checks, never to
// manager_evaluations or anything the Annual Review reads.
router.get('/my/pulse-check', async (req, res) => {
  try {
    // Was activeCycle(T(req), 'midyear') — required a cycle whose TYPE is
    // literally 'midyear', a separate mechanism from how Mid-Year Review
    // itself resolves the active cycle. That older, type-only check
    // predates Mid-Year Review being restructured into a PHASE of the
    // annual cycle rather than its own cycle type, and was never updated
    // to match — so Pulse Check showed "No active mid-year cycle" even
    // while the annual cycle was correctly sitting in Mid-Year Review.
    // activeCycleForMidyear() is phase-based, not type-based, so it
    // already covers both: a standalone midyear-type cycle, or an annual
    // cycle currently at/past its mid_year_review phase.
    const c = await activeCycleForMidyear(T(req));
    if (!c) return res.json({ cycle: null, parameters: [], scores: {} });
    const params = (await db.query(`SELECT id, name, weight_pct, sort_order FROM pms.review_parameters WHERE tenant_id=$1 AND active=true ORDER BY sort_order`, [T(req)])).rows;
    const scored = (await db.query(`SELECT parameter_id, score FROM pms.pulse_checks WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [T(req), c.id, req.user.id])).rows;
    const scores = Object.fromEntries(scored.map((s) => [s.parameter_id, Number(s.score)]));
    const answered = Object.keys(scores).length;
    const selfAverage = answered ? Math.round((Object.values(scores).reduce((s, v) => s + v, 0) / answered) * 10) / 10 : null;
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, parameters: params, scores, self_average: selfAverage, note: 'Informational only — this does not feed your Annual Review score.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/my/pulse-check', async (req, res) => {
  try {
    const c = await activeCycleForMidyear(T(req));
    if (!c) return res.status(409).json({ error: 'No active mid-year cycle' });
    const { scores } = req.body || {};
    if (!scores || typeof scores !== 'object') return res.status(400).json({ error: 'scores object required, e.g. {"<parameter_id>": 4}' });
    const params = (await db.query(`SELECT id FROM pms.review_parameters WHERE tenant_id=$1 AND active=true`, [T(req)])).rows;
    const validIds = new Set(params.map((p) => p.id));
    for (const [pid, val] of Object.entries(scores)) {
      if (!validIds.has(pid)) return res.status(400).json({ error: `unknown parameter_id: ${pid}` });
      const n = Number(val);
      if (Number.isNaN(n) || n < 1 || n > 5) return res.status(400).json({ error: `score for ${pid} must be a number between 1 and 5` });
    }
    for (const [pid, val] of Object.entries(scores)) {
      await db.query(
        `INSERT INTO pms.pulse_checks (tenant_id, cycle_id, employee_id, parameter_id, score) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (cycle_id, employee_id, parameter_id) DO UPDATE SET score=EXCLUDED.score, updated_at=now()`,
        [T(req), c.id, req.user.id, pid, Number(val)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Mid-Year Review — BR-5.1/5.2 (rebuilt) --------------------
// "Consolidates progress against KRAs and the development plan" (BR-5.1)
// + "requires independent sign-off from both the employee and the
// manager" (BR-5.2). REBUILT per an explicit request with a reference
// screenshot, replacing the old version that (a) only ever worked for a
// separate cycle_type='midyear' cycle rather than a phase any cycle
// passes through, and (b) was read-only — it linked out to the Self-
// Appraisal/Team Evaluation screens to actually edit anything, rather
// than being an editable screen itself with its own "Generate AI draft".
// Backed by pms.midyear_checkins (migration 020) — see phase-machine.js's
// comment on mid_year_review for why this is a separate table from
// self_appraisals/manager_evaluations, not a reuse of them.
async function ensureMidyearCheckin(tenantId, cycleId, employeeId) {
  let row = (await db.query(`SELECT * FROM pms.midyear_checkins WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [tenantId, cycleId, employeeId])).rows[0];
  if (!row) {
    const emp = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1`, [employeeId])).rows[0];
    row = (await db.query(
      `INSERT INTO pms.midyear_checkins (tenant_id, cycle_id, employee_id, manager_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, cycleId, employeeId, emp ? emp.manager_id : null])).rows[0];
  }
  return row;
}

function validateRating(value, ratingScale) {
  if (value == null || value === '') return { ok: true, value: null };
  const n = Number(value);
  const scale = Array.isArray(ratingScale) ? ratingScale : [];
  if (!scale.some((s) => s.value === n)) return { ok: false, reason: `rating must be one of: ${scale.map((s) => `${s.value} (${s.label})`).join(', ')}` };
  return { ok: true, value: n };
}

// ---- Mid-Year per-KRA scoring (migration 023) ----------------------------
// The KRAs a mid-year rating is scored against: the same sheet the annual
// self-appraisal uses, read-only here. KRAs lock when kra_open closes,
// which is two phases before mid_year_review, so what is being scored
// cannot shift underneath a review in progress.
async function midyearKras(tenantId, cycleId, employeeId) {
  const sheet = (await db.query(
    `SELECT id FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
    [tenantId, cycleId, employeeId])).rows[0];
  if (!sheet) return [];
  return (await db.query(
    `SELECT id, title, weight, measures FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`,
    [sheet.id])).rows;
}

// Merges an incoming per-KRA map onto what is stored, validates every
// rating a human picked against the cycle's scale, and derives the overall
// as the WEIGHTED AVERAGE of those — reusing computeWeightedRating(), the
// same function the annual engine uses, fed KRA weights as weight_pct.
//
// The derived overall is deliberately NOT put through validateRating: an
// average of discrete grades legitimately falls between them (3.7 is a
// correct answer, not an invalid scale value). Only the per-KRA ratings a
// person actually picks are checked against the scale.
//
// Unknown kra_ids are dropped rather than stored, so a stale browser tab
// cannot write entries for KRAs that no longer exist on the sheet.
function mergeMidyearEntries({ kras, stored, incoming, scale }) {
  const entries = { ...(stored || {}) };
  const byId = new Map(kras.map((k) => [k.id, k]));
  for (const [kraId, val] of Object.entries(incoming || {})) {
    if (!byId.has(kraId) || !val || typeof val !== 'object') continue;
    const next = { ...(entries[kraId] || {}) };
    if (val.rating !== undefined) {
      const rv = validateRating(val.rating, scale);
      if (!rv.ok) return { error: `${byId.get(kraId).title}: ${rv.reason}` };
      next.rating = rv.value;
    }
    if (val.narrative !== undefined) next.narrative = val.narrative;
    entries[kraId] = next;
  }
  return { entries, ...midyearOverall(kras, entries) };
}

// Overall from a stored entry map. `complete` is the gate the request
// asked for: the overall is only ASSIGNED once every KRA carries a
// rating, so a half-scored review reports no overall at all rather than
// an average of the part that happens to be filled in.
function midyearOverall(kras, entries) {
  const ratings = new Map(kras.map((k) => [k.id, entries && entries[k.id] ? entries[k.id].rating : null]));
  const w = computeWeightedRating(kras.map((k) => ({ id: k.id, weight_pct: k.weight })), ratings);
  return { overall: w.complete ? w.rating : null, partial_overall: w.rating, complete: w.complete, missing: w.missing };
}

router.get('/my/midyear-review', async (req, res) => {
  try {
    const c = await activeCycleForMidyear(T(req));
    if (!c) return res.json({ cycle: null, checkin: null });
    const row = await ensureMidyearCheckin(T(req), c.id, req.user.id);
    const editable = pm.phaseAllows(c.phase, 'midyear_self_edit');
    const kras = await midyearKras(T(req), c.id, req.user.id);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase, rating_scale: c.rating_scale }, checkin: row, editable,
      kras, scoring: midyearOverall(kras, row.self_entries) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/my/midyear-review', async (req, res) => {
  try {
    const c = await activeCycleForMidyear(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'midyear_self_edit')) return res.status(409).json({ error: `Mid-Year Review is not open (phase: ${c ? c.phase : 'none'}) — opens once HR moves the cycle from Growth Planning to Mid-Year Review` });
    const row = await ensureMidyearCheckin(T(req), c.id, req.user.id);
    if (row.self_status === 'submitted') return res.status(409).json({ error: 'Already submitted — locked' });
    const { self_rating, self_narrative, entries } = req.body || {};
    const kras = await midyearKras(T(req), c.id, req.user.id);

    // With KRAs mapped, the overall is DERIVED from the per-KRA ratings and
    // any directly-supplied self_rating is ignored — the requirement is
    // that the overall follows from rating every KRA, not that it is picked
    // separately. Without a KRA sheet there is nothing to average, so the
    // single rating stays the only thing that can be recorded; that keeps
    // mid-year usable for someone who has no sheet rather than locking
    // them out of their own checkpoint.
    if (kras.length) {
      const m = mergeMidyearEntries({ kras, stored: row.self_entries, incoming: entries, scale: c.rating_scale });
      if (m.error) return res.status(422).json({ error: m.error });
      // Assigned, not COALESCEd: the overall tracks the entries exactly, so
      // un-rating a KRA must clear it rather than leave a stale figure.
      await db.query(
        `UPDATE pms.midyear_checkins SET self_status='in_progress', self_entries=$2,
           self_rating=$3, self_narrative=COALESCE($4,self_narrative), updated_at=now()
         WHERE id=$1`,
        [row.id, JSON.stringify(m.entries), m.overall, self_narrative ?? null]);
      return res.json({ ok: true, overall_rating: m.overall, partial_overall: m.partial_overall, complete: m.complete, missing: m.missing });
    }
    const rv = validateRating(self_rating, c.rating_scale);
    if (!rv.ok) return res.status(422).json({ error: rv.reason });
    await db.query(
      `UPDATE pms.midyear_checkins SET self_status='in_progress',
         self_rating=COALESCE($2,self_rating), self_narrative=COALESCE($3,self_narrative), updated_at=now()
       WHERE id=$1`,
      [row.id, rv.value, self_narrative ?? null]);
    res.json({ ok: true, overall_rating: rv.value, kra_count: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/my/midyear-review/submit', async (req, res) => {
  try {
    const c = await activeCycleForMidyear(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'midyear_self_submit')) return res.status(409).json({ error: 'Mid-Year Review submission is not open' });
    const row = await ensureMidyearCheckin(T(req), c.id, req.user.id);
    if (row.self_status === 'submitted') return res.status(409).json({ error: 'already submitted' });
    if (!row.self_narrative || !row.self_narrative.trim()) return res.status(422).json({ error: 'Add your reflection before signing.' });
    // Every KRA rated before signing — the overall is derived from them, so
    // signing a partly-scored review would sign off no overall at all.
    const selfKras = await midyearKras(T(req), c.id, req.user.id);
    if (selfKras.length) {
      const sc = midyearOverall(selfKras, row.self_entries);
      if (!sc.complete) return res.status(422).json({ error: `Rate all ${selfKras.length} KRAs before signing — ${sc.missing.length} still unrated.` });
    }
    await db.query(`UPDATE pms.midyear_checkins SET self_status='submitted', self_submitted_at=now(), updated_at=now() WHERE id=$1`, [row.id]);
    audit(req, 'MIDYEAR_SELF_SUBMITTED', c.id, req.user.id, null);
    if (row.manager_id) await notify(T(req), row.manager_id, 'midyear_self_signed', `${req.user.name} signed their Mid-Year Review`, null, '/pms/team/midyear-review');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/team/midyear-review/:employeeId', async (req, res) => {
  try {
    const emp = (await db.query(`SELECT id, name, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin')) && !(await hasPermission(req.user, 'pms_hod'))) {
      return res.status(403).json({ error: 'Not your report' });
    }
    const c = await activeCycleForMidyear(T(req));
    if (!c) return res.json({ cycle: null, employee: { id: emp.id, name: emp.name }, checkin: null });
    const row = await ensureMidyearCheckin(T(req), c.id, emp.id);
    const editable = pm.phaseAllows(c.phase, 'midyear_manager_edit');
    const kras = await midyearKras(T(req), c.id, emp.id);
    // Both sides' scoring state: the manager legitimately sees the
    // employee's own per-KRA ratings and justifications while writing
    // theirs, which is the whole point of a checkpoint review.
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase, rating_scale: c.rating_scale },
      employee: { id: emp.id, name: emp.name }, checkin: row, editable, kras,
      scoring: midyearOverall(kras, row.manager_entries),
      self_scoring: midyearOverall(kras, row.self_entries) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/team/midyear-review/:employeeId', async (req, res) => {
  try {
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const c = await activeCycleForMidyear(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'midyear_manager_edit')) return res.status(409).json({ error: `Mid-Year Review is not open (phase: ${c ? c.phase : 'none'})` });
    const row = await ensureMidyearCheckin(T(req), c.id, emp.id);
    if (row.manager_status === 'submitted') return res.status(409).json({ error: 'Already submitted — locked' });
    const { manager_rating, manager_narrative, entries } = req.body || {};
    const kras = await midyearKras(T(req), c.id, emp.id);
    // Same derivation as the self journey — see PUT /my/midyear-review.
    if (kras.length) {
      const m = mergeMidyearEntries({ kras, stored: row.manager_entries, incoming: entries, scale: c.rating_scale });
      if (m.error) return res.status(422).json({ error: m.error });
      await db.query(
        `UPDATE pms.midyear_checkins SET manager_status='in_progress', manager_entries=$2,
           manager_rating=$3, manager_narrative=COALESCE($4,manager_narrative), updated_at=now()
         WHERE id=$1`,
        [row.id, JSON.stringify(m.entries), m.overall, manager_narrative ?? null]);
      return res.json({ ok: true, overall_rating: m.overall, partial_overall: m.partial_overall, complete: m.complete, missing: m.missing });
    }
    const rv = validateRating(manager_rating, c.rating_scale);
    if (!rv.ok) return res.status(422).json({ error: rv.reason });
    await db.query(
      `UPDATE pms.midyear_checkins SET manager_status='in_progress',
         manager_rating=COALESCE($2,manager_rating), manager_narrative=COALESCE($3,manager_narrative), updated_at=now()
       WHERE id=$1`,
      [row.id, rv.value, manager_narrative ?? null]);
    res.json({ ok: true, overall_rating: rv.value, kra_count: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/midyear-review/:employeeId/submit', async (req, res) => {
  try {
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const c = await activeCycleForMidyear(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'midyear_manager_submit')) return res.status(409).json({ error: 'Mid-Year Review submission is not open' });
    const row = await ensureMidyearCheckin(T(req), c.id, emp.id);
    if (row.manager_status === 'submitted') return res.status(409).json({ error: 'already submitted' });
    if (!row.manager_narrative || !row.manager_narrative.trim()) return res.status(422).json({ error: 'Add your narrative before signing.' });
    const mgrKras = await midyearKras(T(req), c.id, emp.id);
    if (mgrKras.length) {
      const sc = midyearOverall(mgrKras, row.manager_entries);
      if (!sc.complete) return res.status(422).json({ error: `Rate all ${mgrKras.length} KRAs before signing — ${sc.missing.length} still unrated.` });
    }
    await db.query(`UPDATE pms.midyear_checkins SET manager_status='submitted', manager_submitted_at=now(), updated_at=now() WHERE id=$1`, [row.id]);
    audit(req, 'MIDYEAR_MANAGER_SUBMITTED', c.id, emp.id, null);
    await notify(T(req), emp.id, 'midyear_manager_signed', `${req.user.name} signed off your Mid-Year Review`, null, '/pms/my/midyear');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Manager & HOD evaluation ----------------------------------
router.get('/team/evaluations', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, team: [] });
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, e.department,
              sa.status AS self_status, sa.entries AS self_entries, sa.overall_self_rating,
              sa.went_well, sa.could_improve,
              me.id AS eval_id, me.status AS eval_status, me.entries AS eval_entries,
              me.overall_rating, me.strengths, me.improvement_areas
         FROM core.employees e
         LEFT JOIN pms.self_appraisals sa ON sa.cycle_id=$1 AND sa.employee_id=e.id
         LEFT JOIN pms.manager_evaluations me ON me.cycle_id=$1 AND me.employee_id=e.id
        WHERE e.tenant_id=$2 AND e.manager_id=$3 AND e.status='active' ORDER BY e.name`,
      [c.id, T(req), req.user.id]);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase, rating_scale: c.rating_scale, cycle_type: c.cycle_type }, team: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/team/evaluations/:employeeId/kras', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ kras: [] });
    const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    const kras = sheet ? (await db.query(`SELECT id, title, weight FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    res.json({ kras });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/team/evaluations/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'manager_edit')) return res.status(409).json({ error: `Manager evaluation is not open (phase: ${c ? c.phase : 'none'})` });
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const b = req.body || {};
    // BR-6.2/6.3: on an ANNUAL cycle the overall rating must come from the
    // 7-parameter weighted engine (PUT /team/parameter-scores/:id), not a
    // directly typed number — otherwise the weighting requirement is just
    // a UI suggestion nobody has to follow. Mid-Year's own, separate
    // self+manager rating (BR-5.4) is unaffected; only annual is gated.
    if (c.cycle_type === 'annual' && b.overall_rating !== undefined) {
      return res.status(409).json({ error: 'On an annual cycle, overall_rating is computed from the 7 organisational parameters — use PUT /pms/team/parameter-scores/:employeeId instead' });
    }
    // Requested: a rating (+ comment) per KRA for the manager too, mirroring
    // Self-Appraisal's per-KRA rating — with overall_rating auto-computed as
    // the weighted average, same computeWeightedRating() reuse as there.
    // Scoped to non-annual cycles only (annual's overall_rating is already
    // exclusively governed by the 7-parameter engine above; per-KRA entries
    // can still be saved there as supplementary detail, they just don't
    // drive overall_rating on that cycle type).
    let overallRating = null; // null = leave untouched (COALESCE keeps the existing value)
    if (c.cycle_type !== 'annual') {
      if (b.entries) {
        const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, emp.id])).rows[0];
        const kras = sheet ? (await db.query(`SELECT id, weight AS weight_pct FROM pms.kras WHERE sheet_id=$1`, [sheet.id])).rows : [];
        const scores = new Map(kras.map((k) => [k.id, b.entries[k.id] ? b.entries[k.id].rating : null]));
        const { rating } = computeWeightedRating(kras, scores);
        if (rating != null) overallRating = rating;
      } else if (b.overall_rating != null) {
        overallRating = b.overall_rating;
      }
    }
    await db.query(
      `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, entries, overall_rating, strengths, improvement_areas, status)
       VALUES ($1,$2,$3,$4,COALESCE($5,'{}'::jsonb),$6,$7,$8,'pending')
       ON CONFLICT (cycle_id, employee_id) DO UPDATE SET
         entries=COALESCE($5,pms.manager_evaluations.entries),
         overall_rating=COALESCE($6,pms.manager_evaluations.overall_rating),
         strengths=COALESCE($7,pms.manager_evaluations.strengths),
         improvement_areas=COALESCE($8,pms.manager_evaluations.improvement_areas),
         updated_at=now()`,
      [T(req), c.id, emp.id, req.user.id, b.entries ? JSON.stringify(b.entries) : null,
       overallRating, b.strengths ?? null, b.improvement_areas ?? null]);
    res.json({ ok: true, overall_rating: overallRating });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/team/evaluations/:employeeId/submit', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'manager_submit')) return res.status(409).json({ error: 'Manager evaluation is not open' });
    const ev = (await db.query(`SELECT * FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    if (!ev) return res.status(404).json({ error: 'no evaluation drafted' });
    if (ev.overall_rating == null) return res.status(422).json({ error: 'overall_rating required to submit' });
    await db.query(`UPDATE pms.manager_evaluations SET status='submitted', submitted_at=now(), updated_at=now() WHERE id=$1`, [ev.id]);
    audit(req, 'MANAGER_EVAL_SUBMITTED', c.id, req.params.employeeId, { rating: ev.overall_rating });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- 7 Organizational Parameters — BR-6.2/BR-6.3 --------------
// Configuration (HR) and per-employee scoring (manager) for the Annual
// Review's weighted rating. See migrations/008-review-parameters.js for
// why this is annual-only and why the weights are configurable defaults.

// Any authenticated user can view the current parameter set — a manager
// needs to know what to score against, HR needs to see what they've
// configured, and there's nothing sensitive in the list itself.
router.get('/review-parameters', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, name, weight_pct, sort_order FROM pms.review_parameters
        WHERE tenant_id=$1 AND active=true ORDER BY sort_order`, [T(req)]);
    res.json({ parameters: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HR configures the 7 parameters' names/weights (BR-6.2: "HR can configure
// the 7 organisational parameters and their weightings"). Full replace of
// the active set in one call — simpler and safer than partial-patch
// semantics for something that must sum to 100 as a whole. Reuses
// phase-machine's weightsValid() so both KRAs and review parameters are
// held to the exact same "sums to 100 within 0.01" rule.
router.put('/review-parameters', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { parameters } = req.body || {};
    if (!Array.isArray(parameters) || !parameters.length) return res.status(400).json({ error: 'parameters (non-empty array) required' });
    for (const p of parameters) {
      if (!p.name || !p.name.trim()) return res.status(400).json({ error: 'each parameter needs a name' });
      if (typeof p.weight_pct !== 'number' || p.weight_pct <= 0) return res.status(400).json({ error: `${p.name}: weight_pct must be a positive number` });
    }
    const check = pm.weightsValid(parameters.map((p) => ({ weight: p.weight_pct })));
    if (!check.ok) return res.status(422).json({ error: `Weights must sum to 100 (currently ${check.total})` });
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE pms.review_parameters SET active=false WHERE tenant_id=$1`, [T(req)]);
      for (let i = 0; i < parameters.length; i++) {
        const p = parameters[i];
        if (p.id) {
          await client.query(
            `UPDATE pms.review_parameters SET name=$1, weight_pct=$2, sort_order=$3, active=true, updated_at=now()
              WHERE id=$4 AND tenant_id=$5`, [p.name.trim(), p.weight_pct, (i + 1) * 10, p.id, T(req)]);
        } else {
          await client.query(
            `INSERT INTO pms.review_parameters (tenant_id, name, weight_pct, sort_order) VALUES ($1,$2,$3,$4)`,
            [T(req), p.name.trim(), p.weight_pct, (i + 1) * 10]);
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    audit(req, 'REVIEW_PARAMETERS_UPDATED', null, null, { count: parameters.length });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager fetches the parameter list + their current scores for one
// report, plus the live weighted rating computed from whatever is scored
// so far (Fig. 8b's "live-recalculating weighted overall rating").
router.get('/team/parameter-scores/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    if (c.cycle_type !== 'annual') return res.status(409).json({ error: '7-parameter scoring applies to annual cycles only' });
    const emp = (await db.query(`SELECT id, manager_id, name FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const params = (await db.query(`SELECT id, name, weight_pct, sort_order FROM pms.review_parameters WHERE tenant_id=$1 AND active=true ORDER BY sort_order`, [T(req)])).rows;
    // scored_by_role='manager' — migration 021 let self and manager scores
    // coexist per parameter; this view is the manager's own only.
    const scored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='manager'`, [T(req), c.id, emp.id])).rows;
    const selfScored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='self'`, [T(req), c.id, emp.id])).rows;
    const scoreMap = Object.fromEntries(scored.map((s) => [s.parameter_id, Number(s.score)]));
    const selfScoreMap = Object.fromEntries(selfScored.map((s) => [s.parameter_id, Number(s.score)]));
    const weighted = computeWeightedRating(params, scoreMap);
    res.json({ employee: { id: emp.id, name: emp.name }, parameters: params, scores: scoreMap, self_scores: selfScoreMap, weighted_rating: weighted.rating, complete: weighted.complete, missing: weighted.missing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager submits/updates one or more parameter scores for a report.
// Recomputes the weighted rating across ALL active parameters every call
// and, once every parameter is scored, writes it straight into
// pms.manager_evaluations.overall_rating — the exact same column PIP,
// Super 50, 9-Box, and publish already read, so nothing downstream needed
// to change to consume a 7-parameter-derived rating instead of a
// manager-typed one. While incomplete, overall_rating is left untouched
// (COALESCE semantics already in the /team/evaluations route mean a null
// here doesn't clobber anything).
router.put('/team/parameter-scores/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'manager_edit')) return res.status(409).json({ error: `Manager evaluation is not open (phase: ${c ? c.phase : 'none'})` });
    if (c.cycle_type !== 'annual') return res.status(409).json({ error: '7-parameter scoring applies to annual cycles only' });
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const { scores } = req.body || {}; // { parameter_id: score, ... } — partial updates allowed
    if (!scores || typeof scores !== 'object') return res.status(400).json({ error: 'scores object required, e.g. {"<parameter_id>": 4}' });
    const params = (await db.query(`SELECT id, name, weight_pct FROM pms.review_parameters WHERE tenant_id=$1 AND active=true`, [T(req)])).rows;
    const validIds = new Set(params.map((p) => p.id));
    for (const [pid, val] of Object.entries(scores)) {
      if (!validIds.has(pid)) return res.status(400).json({ error: `unknown parameter_id: ${pid}` });
      const n = Number(val);
      if (Number.isNaN(n) || n < 1 || n > 5) return res.status(400).json({ error: `score for ${pid} must be a number between 1 and 5` });
    }
    for (const [pid, val] of Object.entries(scores)) {
      await db.query(
        `INSERT INTO pms.parameter_scores (tenant_id, cycle_id, employee_id, parameter_id, score, scored_by, scored_by_role)
         VALUES ($1,$2,$3,$4,$5,$6,'manager')
         ON CONFLICT (cycle_id, employee_id, parameter_id, scored_by_role) DO UPDATE SET score=EXCLUDED.score, scored_by=EXCLUDED.scored_by, updated_at=now()`,
        [T(req), c.id, emp.id, pid, Number(val), req.user.email]);
    }
    const allScored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='manager'`, [T(req), c.id, emp.id])).rows;
    const scoreMap = Object.fromEntries(allScored.map((s) => [s.parameter_id, Number(s.score)]));
    const weighted = computeWeightedRating(params, scoreMap);
    if (weighted.complete) {
      await db.query(
        `INSERT INTO pms.manager_evaluations (tenant_id, cycle_id, employee_id, manager_id, overall_rating, status)
         VALUES ($1,$2,$3,$4,$5,'pending')
         ON CONFLICT (cycle_id, employee_id) DO UPDATE SET overall_rating=$5, updated_at=now()`,
        [T(req), c.id, emp.id, req.user.id, weighted.rating]);
    }
    audit(req, 'PARAMETER_SCORES_UPDATED', c.id, emp.id, { scores, complete: weighted.complete, weighted_rating: weighted.rating });
    res.json({ ok: true, weighted_rating: weighted.rating, complete: weighted.complete, missing: weighted.missing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Requested with a reference screenshot: an employee's own Self-Appraisal
// had no way to self-score against the same 7 Organizational Parameters
// the manager scores against — only the manager could. This is the
// employee's own mirror of the two routes above, writing to the SAME
// pms.parameter_scores table (migration 021 added scored_by_role so both
// coexist per parameter without overwriting each other) but into
// pms.self_appraisals.overall_self_rating once complete, instead of
// pms.manager_evaluations.overall_rating — the self-score never becomes
// the OFFICIAL rating; that stays exclusively the manager's, per
// BR-6.2/6.3. Annual-cycle only, same restriction as the manager route.
router.get('/my/parameter-scores', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    if (c.cycle_type !== 'annual') return res.status(409).json({ error: '7-parameter scoring applies to annual cycles only' });
    const params = (await db.query(`SELECT id, name, weight_pct, sort_order FROM pms.review_parameters WHERE tenant_id=$1 AND active=true ORDER BY sort_order`, [T(req)])).rows;
    const scored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='self'`, [T(req), c.id, req.user.id])).rows;
    const scoreMap = Object.fromEntries(scored.map((s) => [s.parameter_id, Number(s.score)]));
    const weighted = computeWeightedRating(params, scoreMap);
    const editable = pm.phaseAllows(c.phase, 'self_edit');
    res.json({ parameters: params, scores: scoreMap, weighted_rating: weighted.rating, complete: weighted.complete, missing: weighted.missing, editable });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/my/parameter-scores', async (req, res) => {
  try {
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'self_edit')) return res.status(409).json({ error: `Self-appraisal is not open (phase: ${c ? c.phase : 'none'})` });
    if (c.cycle_type !== 'annual') return res.status(409).json({ error: '7-parameter scoring applies to annual cycles only' });
    const a = (await db.query(`SELECT status FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.user.id])).rows[0];
    if (a && a.status === 'submitted') return res.status(409).json({ error: 'Already submitted — locked' });
    const { scores } = req.body || {};
    if (!scores || typeof scores !== 'object') return res.status(400).json({ error: 'scores object required, e.g. {"<parameter_id>": 4}' });
    const params = (await db.query(`SELECT id, name, weight_pct FROM pms.review_parameters WHERE tenant_id=$1 AND active=true`, [T(req)])).rows;
    const validIds = new Set(params.map((p) => p.id));
    for (const [pid, val] of Object.entries(scores)) {
      if (!validIds.has(pid)) return res.status(400).json({ error: `unknown parameter_id: ${pid}` });
      const n = Number(val);
      if (Number.isNaN(n) || n < 1 || n > 5) return res.status(400).json({ error: `score for ${pid} must be a number between 1 and 5` });
    }
    for (const [pid, val] of Object.entries(scores)) {
      await db.query(
        `INSERT INTO pms.parameter_scores (tenant_id, cycle_id, employee_id, parameter_id, score, scored_by, scored_by_role)
         VALUES ($1,$2,$3,$4,$5,$6,'self')
         ON CONFLICT (cycle_id, employee_id, parameter_id, scored_by_role) DO UPDATE SET score=EXCLUDED.score, scored_by=EXCLUDED.scored_by, updated_at=now()`,
        [T(req), c.id, req.user.id, pid, Number(val), req.user.email]);
    }
    const allScored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='self'`, [T(req), c.id, req.user.id])).rows;
    const scoreMap = Object.fromEntries(allScored.map((s) => [s.parameter_id, Number(s.score)]));
    const weighted = computeWeightedRating(params, scoreMap);
    if (weighted.complete) {
      await db.query(
        `INSERT INTO pms.self_appraisals (tenant_id, cycle_id, employee_id, overall_self_rating, status)
         VALUES ($1,$2,$3,$4,'in_progress')
         ON CONFLICT (cycle_id, employee_id) DO UPDATE SET overall_self_rating=$4, status=CASE WHEN pms.self_appraisals.status='not_started' THEN 'in_progress' ELSE pms.self_appraisals.status END, updated_at=now()`,
        [T(req), c.id, req.user.id, weighted.rating]);
    }
    res.json({ ok: true, weighted_rating: weighted.rating, complete: weighted.complete, missing: weighted.missing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// HOD: department queue + decide.
router.get('/hod/queue', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_hod'))) return res.status(403).json({ error: "Requires 'pms_hod'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, queue: [] });
    const depts = (await db.query(`SELECT department FROM core.department_heads WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id])).rows.map(r => r.department);
    const isAdmin = await hasPermission(req.user, 'pms_admin');
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, e.department, me.overall_rating AS manager_rating,
              me.status AS manager_status, he.overall_rating AS hod_rating, he.status AS hod_status
         FROM core.employees e
         JOIN pms.manager_evaluations me ON me.cycle_id=$1 AND me.employee_id=e.id AND me.status='submitted'
         LEFT JOIN pms.hod_evaluations he ON he.cycle_id=$1 AND he.employee_id=e.id
        WHERE e.tenant_id=$2 ${isAdmin ? '' : 'AND e.department = ANY($3)'} ORDER BY e.department, e.name`,
      isAdmin ? [c.id, T(req)] : [c.id, T(req), depts]);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, departments: depts, queue: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Requested: the Delivery Head Review view should show ratings by BOTH
// the employee (self) and the manager against EACH KRA, not just the two
// flat overall numbers — so the DH can see exactly what's behind the
// manager's rating before finalising their own.
router.get('/hod/queue/:employeeId/kras', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_hod'))) return res.status(403).json({ error: "Requires 'pms_hod'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ kras: [] });
    const isAdmin = await hasPermission(req.user, 'pms_admin');
    if (!isAdmin) {
      const emp = (await db.query(`SELECT department FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
      const depts = (await db.query(`SELECT department FROM core.department_heads WHERE tenant_id=$1 AND employee_id=$2`, [T(req), req.user.id])).rows.map((r) => r.department);
      if (!emp || !depts.includes(emp.department)) return res.status(403).json({ error: 'Not your department' });
    }
    const sheet = (await db.query(`SELECT id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    const kras = sheet ? (await db.query(`SELECT id, title, weight FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [sheet.id])).rows : [];
    const sa = (await db.query(`SELECT entries FROM pms.self_appraisals WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    const me = (await db.query(`SELECT entries FROM pms.manager_evaluations WHERE cycle_id=$1 AND employee_id=$2`, [c.id, req.params.employeeId])).rows[0];
    res.json({ kras, self_entries: (sa && sa.entries) || {}, manager_entries: (me && me.entries) || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/hod/queue/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_hod'))) return res.status(403).json({ error: "Requires 'pms_hod'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'hod_edit')) return res.status(409).json({ error: `Delivery Head evaluation is not open (phase: ${c ? c.phase : 'none'})` });
    const { overall_rating, comment, submit } = req.body || {};
    await db.query(
      `INSERT INTO pms.hod_evaluations (tenant_id, cycle_id, employee_id, hod_id, overall_rating, comment, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (cycle_id, employee_id) DO UPDATE SET
         overall_rating=COALESCE($5,pms.hod_evaluations.overall_rating),
         comment=COALESCE($6,pms.hod_evaluations.comment),
         status=$7, submitted_at=COALESCE($8,pms.hod_evaluations.submitted_at)`,
      [T(req), c.id, req.params.employeeId, req.user.id, overall_rating ?? null, comment ?? null,
       submit ? 'submitted' : 'pending', submit ? new Date() : null]);
    if (submit) audit(req, 'HOD_EVAL_SUBMITTED', c.id, req.params.employeeId, { rating: overall_rating });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Calibration ------------------------------------------------
router.get('/calibration', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null });
    // Proposed = HOD rating where present, else manager rating; distribution vs bell curve.
    // Requested after a direct UX review: the adjustment reason (mandatory
    // at the point of adjustment) was being saved but never shown again
    // anywhere — the page's own caption calls it "the permanent answer to
    // why did my rating change," but nothing actually displayed that
    // answer. Extended the existing LATERAL join (already fetching
    // to_rating) to also carry reason/adjusted_by/at through, rather than
    // adding a second round trip for it.
    const rows = (await db.query(
      `SELECT e.id AS employee_id, e.name, e.department,
              me.overall_rating AS manager_rating, he.overall_rating AS hod_rating,
              COALESCE(adj.to_rating, he.overall_rating, me.overall_rating) AS proposed,
              adj.reason AS adjustment_reason, adj.adjusted_by, adj.at AS adjusted_at,
              tt.nine_box_cell, tt.potential_rating
         FROM core.employees e
         JOIN pms.manager_evaluations me ON me.cycle_id=$1 AND me.employee_id=e.id AND me.status='submitted'
         LEFT JOIN pms.hod_evaluations he ON he.cycle_id=$1 AND he.employee_id=e.id AND he.status='submitted'
         LEFT JOIN LATERAL (SELECT to_rating, reason, adjusted_by, at FROM pms.rating_adjustments ra
                             WHERE ra.cycle_id=$1 AND ra.employee_id=e.id ORDER BY at DESC LIMIT 1) adj ON true
         LEFT JOIN pms.top_talent tt ON tt.cycle_id=$1 AND tt.employee_id=e.id
        WHERE e.tenant_id=$2 ORDER BY e.department, e.name`, [c.id, T(req)])).rows;
    const dist = {};
    for (const r of rows) { const k = r.proposed == null ? 'unrated' : String(Math.round(r.proposed)); dist[k] = (dist[k] || 0) + 1; }
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase, bell_curve: c.bell_curve }, rows, distribution: dist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/calibration/adjust', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'adjust')) return res.status(409).json({ error: `Calibration is not open (phase: ${c ? c.phase : 'none'})` });
    const { employee_id, from_rating, to_rating, reason, session_id } = req.body || {};
    if (!employee_id || to_rating == null) return res.status(400).json({ error: 'employee_id and to_rating required' });
    if (!reason || !reason.trim()) return res.status(422).json({ error: 'A reason is required — adjustments must answer "why did my rating change"' });
    await db.query(
      `INSERT INTO pms.rating_adjustments (tenant_id, cycle_id, employee_id, session_id, from_rating, to_rating, reason, adjusted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [T(req), c.id, employee_id, session_id || null, from_rating ?? null, to_rating, reason.trim(), req.user.email]);
    audit(req, 'RATING_ADJUSTED', c.id, employee_id, { from: from_rating, to: to_rating, reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- 9-Box Grid — BR-6.4 -------------------------------------
// Aggregates pms.top_talent entries (nine_box_cell values already captured
// via the existing top-talent endpoint above) into the grid, at whichever
// of the three levels the BRD names: org-wide, per-department, or per
// reporting-line (each employee's direct manager). HR and Delivery Head
// both get view access, per BR-6.4's stated audience — unlike /watchlist
// (BR-6.5/6.6), which is HR/Management only.
//
// nine_box_cell convention (see frontend CalibrationPage.jsx's NINE_BOX
// list, unchanged here): "<performance>-<potential>", each low|mid|high.
router.get('/nine-box', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin')) && !(await hasPermission(req.user, 'pms_hod'))) {
      return res.status(403).json({ error: "Requires 'pms_admin' or 'pms_hod'" });
    }
    const level = ['org', 'department', 'manager'].includes(req.query.level) ? req.query.level : 'org';
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const rows = (await db.query(
      `SELECT e.id, e.name, e.department, m.name AS manager_name, tt.nine_box_cell, tt.potential_rating
         FROM pms.top_talent tt JOIN core.employees e ON e.id=tt.employee_id
         LEFT JOIN core.employees m ON m.id=e.manager_id
        WHERE tt.tenant_id=$1 AND tt.cycle_id=$2 AND tt.nine_box_cell IS NOT NULL`,
      [T(req), c.id])).rows;

    const groupKey = (r) => (level === 'department' ? (r.department || 'Unassigned') : level === 'manager' ? (r.manager_name || 'No manager') : 'Organisation');
    const groups = new Map();
    for (const r of rows) {
      const key = groupKey(r);
      if (!groups.has(key)) groups.set(key, { key, total: 0, cells: {} });
      const g = groups.get(key);
      g.total++;
      const cellKey = r.nine_box_cell;
      if (!g.cells[cellKey]) g.cells[cellKey] = [];
      g.cells[cellKey].push({ id: r.id, name: r.name });
    }
    res.json({ cycle: { id: c.id, name: c.name }, level, groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/calibration/top-talent', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'top_talent')) return res.status(409).json({ error: 'Calibration is not open' });
    const { employee_id, potential_rating, nine_box_cell } = req.body || {};
    if (!employee_id) return res.status(400).json({ error: 'employee_id required' });
    await db.query(
      `INSERT INTO pms.top_talent (tenant_id, cycle_id, employee_id, potential_rating, nine_box_cell, noted_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cycle_id, employee_id) DO UPDATE SET
         potential_rating=EXCLUDED.potential_rating, nine_box_cell=EXCLUDED.nine_box_cell, noted_by=EXCLUDED.noted_by, at=now()`,
      [T(req), c.id, employee_id, potential_rating || null, nine_box_cell || null, req.user.email]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Publish ----------------------------------------------------
// Final rating = latest adjustment, else HOD, else manager. Writes history,
// mirrors to core.employees (the write-back set), creates letter records,
// notifies. Idempotent per employee via history PK.
router.post('/publish', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c || !pm.phaseAllows(c.phase, 'publish')) return res.status(409).json({ error: `Publish is not open (phase: ${c ? c.phase : 'none'})` });
    const rows = (await db.query(
      `SELECT e.id AS employee_id, e.name AS employee_name,
              COALESCE(adj.to_rating, he.overall_rating, me.overall_rating) AS final_rating,
              tt.potential_rating, tt.nine_box_cell
         FROM core.employees e
         JOIN pms.manager_evaluations me ON me.cycle_id=$1 AND me.employee_id=e.id AND me.status='submitted'
         LEFT JOIN pms.hod_evaluations he ON he.cycle_id=$1 AND he.employee_id=e.id AND he.status='submitted'
         LEFT JOIN LATERAL (SELECT to_rating FROM pms.rating_adjustments ra
                             WHERE ra.cycle_id=$1 AND ra.employee_id=e.id ORDER BY at DESC LIMIT 1) adj ON true
         LEFT JOIN pms.top_talent tt ON tt.cycle_id=$1 AND tt.employee_id=e.id
        WHERE e.tenant_id=$2`, [c.id, T(req)])).rows;
    const scale = Array.isArray(c.rating_scale) ? c.rating_scale : [];
    const label = (v) => { const m = scale.find(s => Math.round(v) === s.value); return m ? m.label : null; };
    let published = 0; let pipsOpened = 0; let super50Flagged = 0; const failures = [];
    for (const r of rows) {
      if (r.final_rating == null) { failures.push({ employee_id: r.employee_id, reason: 'no rating at any layer' }); continue; }
      try {
        await db.query(
          `INSERT INTO pms.employee_performance_history (tenant_id, employee_id, cycle_id, final_rating, rating_label)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (employee_id, cycle_id) DO UPDATE SET final_rating=EXCLUDED.final_rating, rating_label=EXCLUDED.rating_label, published_at=now()`,
          [T(req), r.employee_id, c.id, r.final_rating, label(r.final_rating)]);
        await db.query(
          `UPDATE core.employees SET last_appraisal_rating=$2, last_appraisal_cycle_id=$3, last_appraisal_at=now(),
                  potential_rating=COALESCE($4,potential_rating), nine_box_cell=COALESCE($5,nine_box_cell), updated_at=now()
            WHERE id=$1`, [r.employee_id, String(r.final_rating), c.id, r.potential_rating, r.nine_box_cell]);
        await db.query(
          `INSERT INTO pms.closure_letters (tenant_id, cycle_id, employee_id) VALUES ($1,$2,$3)
           ON CONFLICT (cycle_id, employee_id) DO NOTHING`, [T(req), c.id, r.employee_id]);
        // BR-6.5: Super 50 watchlist — recomputed from this employee's last 3
        // published ANNUAL cycles (midyear publishes don't touch this; see
        // rating-rules.js for the letter-grade mapping and why annual-only).
        // A lapsed streak un-flags automatically — this is "currently on
        // the watchlist", not a permanent badge.
        if (c.cycle_type === 'annual') {
          const hist = (await db.query(
            `SELECT h.final_rating FROM pms.employee_performance_history h JOIN pms.cycles hc ON hc.id=h.cycle_id
              WHERE h.tenant_id=$1 AND h.employee_id=$2 AND hc.cycle_type='annual'
              ORDER BY h.published_at DESC LIMIT 3`, [T(req), r.employee_id])).rows;
          const eligible = isSuper50Eligible(hist.map((x) => x.final_rating));
          const emp = (await db.query(`SELECT super50_flag FROM core.employees WHERE id=$1`, [r.employee_id])).rows[0];
          const wasFlagged = !!(emp && emp.super50_flag);
          if (eligible && !wasFlagged) {
            await db.query(`UPDATE core.employees SET super50_flag=true, super50_since=now() WHERE id=$1`, [r.employee_id]);
            super50Flagged++;
            audit(req, 'SUPER50_FLAGGED', c.id, r.employee_id, { ratings: hist.map((x) => x.final_rating) });
            await notify(T(req), r.employee_id, 'super50_flagged', 'You have been recognised as a consistent top performer', null, '/pms/my-rating');
            // BR-6.6: proactively alert HR/Management to consider retention
            // actions for this newly-flagged employee.
            const alerted = await alertHrOfRetentionRisk(T(req), { id: r.employee_id, name: r.employee_name });
            audit(req, 'RETENTION_ALERT_SENT', c.id, r.employee_id, { alerted_recipients: alerted });
          } else if (!eligible && wasFlagged) {
            await db.query(`UPDATE core.employees SET super50_flag=false, super50_since=NULL WHERE id=$1`, [r.employee_id]);
            audit(req, 'SUPER50_UNFLAGGED', c.id, r.employee_id, { ratings: hist.map((x) => x.final_rating) });
          }
        }
        // BR-7.1: automatic PIP trigger below the cycle's configured threshold.
        // ON CONFLICT DO NOTHING (unique on tenant/employee/cycle, migration
        // 006) makes this safe if publish is re-run — it won't reopen or
        // duplicate a PIP that already exists for this cycle.
        if (Number(r.final_rating) < Number(c.pip_threshold)) {
          const pipR = await db.query(
            `INSERT INTO pms.pip_records (tenant_id, employee_id, cycle_id, status, opened_by)
             VALUES ($1,$2,$3,'open',$4) ON CONFLICT (tenant_id, employee_id, cycle_id) DO NOTHING RETURNING id`,
            [T(req), r.employee_id, c.id, `system:publish (${req.user.email})`]);
          if (pipR.rows[0]) {
            pipsOpened++;
            await notify(T(req), r.employee_id, 'pip_opened', `A Performance Improvement Plan has been opened for ${c.name}`, null, '/pms/my-rating');
            audit(req, 'PIP_AUTO_OPENED', c.id, r.employee_id, { final_rating: r.final_rating, threshold: c.pip_threshold });
          }
        }
        await notify(T(req), r.employee_id, 'rating_published', `Your ${c.name} rating is published`, null, '/pms/my-rating');
        published++;
      } catch (e) { failures.push({ employee_id: r.employee_id, reason: e.message }); }
    }
    audit(req, 'CYCLE_PUBLISHED', c.id, null, { published, failed: failures.length, pips_opened: pipsOpened, super50_flagged: super50Flagged });
    res.json({ ok: true, published, pips_opened: pipsOpened, super50_flagged: super50Flagged, failures });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Annual Review consolidation — BR-6.1 ---------------------
// "The system must support an end-of-year review workflow that
// consolidates KRA outcomes, development plan progress, and career path
// status." Everything this pulls together already exists as its own
// feature (KRAs, self-appraisal, manager eval, 7-parameter scoring,
// development plan, career path, rating history) — this is deliberately
// a read-only aggregation over those, not a new source of truth. Shared
// by both the self view and the manager/HR view below.
async function buildAnnualReviewSummary(tenantId, employeeId, cycleId) {
  const kraSheet = (await db.query(`SELECT * FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [tenantId, cycleId, employeeId])).rows[0];
  const kras = kraSheet ? (await db.query(`SELECT id, title, description, weight, measures FROM pms.kras WHERE sheet_id=$1 ORDER BY sort_order`, [kraSheet.id])).rows : [];
  const selfAppraisal = (await db.query(`SELECT status, entries, went_well, could_improve FROM pms.self_appraisals WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [tenantId, cycleId, employeeId])).rows[0];
  const managerEval = (await db.query(`SELECT status, entries, overall_rating, strengths, improvement_areas FROM pms.manager_evaluations WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [tenantId, cycleId, employeeId])).rows[0];
  // KRA "outcomes" = each KRA's definition joined with its self-rating and
  // manager-rating, keyed by kra_id in the two entries jsonb blobs above.
  const kraOutcomes = kras.map((k) => ({
    ...k,
    self: selfAppraisal?.entries?.[k.id] || null,
    manager: managerEval?.entries?.[k.id] || null,
  }));

  const devPlan = (await db.query(`SELECT id, status, manager_comment FROM pms.development_plans WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [tenantId, cycleId, employeeId])).rows[0];
  const devGoals = devPlan ? (await db.query(`SELECT title, description, target_date, progress_pct FROM pms.development_goals WHERE plan_id=$1 ORDER BY sort_order`, [devPlan.id])).rows : [];
  const devAvgProgress = devGoals.length ? Math.round(devGoals.reduce((s, g) => s + g.progress_pct, 0) / devGoals.length) : null;

  const careerPath = (await db.query(`SELECT target_role, plan, updated_at FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId])).rows[0];

  const params = (await db.query(`SELECT id, name, weight_pct FROM pms.review_parameters WHERE tenant_id=$1 AND active=true ORDER BY sort_order`, [tenantId])).rows;
  // scored_by_role='manager' — this section is explicitly the manager's
  // scoring progress (the frontend labels it "manager scoring in
  // progress"), which is what feeds the OFFICIAL weighted rating. Without
  // this filter, once an employee also self-scores the same parameters
  // (added in a later round), this query could return either party's
  // score unpredictably for the same parameter_id, depending on row
  // order — found during a manual BRD-vs-code review, fixed here before
  // it was ever actually hit in practice.
  const scored = (await db.query(`SELECT parameter_id, score FROM pms.parameter_scores WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND scored_by_role='manager'`, [tenantId, cycleId, employeeId])).rows;
  const scoreMap = Object.fromEntries(scored.map((s) => [s.parameter_id, Number(s.score)]));
  const weighted = computeWeightedRating(params, scoreMap);

  const history = (await db.query(
    `SELECT h.cycle_id, c.name AS cycle_name, c.fiscal_year, h.final_rating, h.rating_label, h.published_at
       FROM pms.employee_performance_history h JOIN pms.cycles c ON c.id=h.cycle_id
      WHERE h.tenant_id=$1 AND h.employee_id=$2 ORDER BY h.published_at DESC LIMIT 5`, [tenantId, employeeId])).rows;

  const superFlag = (await db.query(`SELECT super50_flag, super50_since FROM core.employees WHERE id=$1`, [employeeId])).rows[0];

  return {
    kra: { sheet: kraSheet || null, outcomes: kraOutcomes },
    development_plan: { plan: devPlan || null, goals: devGoals, avg_progress: devAvgProgress },
    career_path: careerPath || null,
    parameter_scores: { parameters: params, scores: scoreMap, weighted_rating: weighted.rating, complete: weighted.complete },
    manager_evaluation: managerEval || null,
    rating_history: history,
    super50: superFlag ? { flag: superFlag.super50_flag, since: superFlag.super50_since } : null,
  };
}

router.get('/my/annual-review', async (req, res) => {
  try {
    const c = await activeCycle(T(req), 'annual');
    if (!c) return res.json({ cycle: null });
    const summary = await buildAnnualReviewSummary(T(req), req.user.id, c.id);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, ...summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/team/annual-review/:employeeId', async (req, res) => {
  try {
    const emp = (await db.query(`SELECT id, name, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin')) && !(await hasPermission(req.user, 'pms_hod'))) {
      return res.status(403).json({ error: 'Not your report' });
    }
    const c = await activeCycle(T(req), 'annual');
    if (!c) return res.json({ cycle: null, employee: { id: emp.id, name: emp.name } });
    const summary = await buildAnnualReviewSummary(T(req), emp.id, c.id);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, employee: { id: emp.id, name: emp.name }, ...summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- My rating & history / Connects / PIP ----------------------
router.get('/my/rating', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT h.cycle_id, c.name AS cycle_name, c.fiscal_year, h.final_rating, h.rating_label, h.published_at
         FROM pms.employee_performance_history h JOIN pms.cycles c ON c.id=h.cycle_id
        WHERE h.tenant_id=$1 AND h.employee_id=$2 ORDER BY h.published_at DESC`, [T(req), req.user.id]);
    res.json({ history: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// meeting_based=true marks this log as populated from a recorded/transcribed
// meeting or a calendar/meeting-tool pull (BRD §6 NFR) rather than typed in
// directly by the manager/employee. That path is gated on the employee's
// own explicit consent — requireConsent() 403s before anything is written
// if it is missing. A plain typed-in log (meeting_based omitted or false)
// is unaffected and needs no consent, since nothing is being
// recorded/transcribed on the employee's behalf in that case.
router.post('/connects', async (req, res) => {
  try {
    // Fix guide item #8 (BR-4.2): achievements/blockers/feedback as their
    // own fields, not one free-text blob. `notes` is still accepted for
    // backward compatibility with anything already calling this route, but
    // new callers (the updated ConnectsPage) send the three fields instead.
    // duration_min/topic/discussion_notes added per a follow-up request.
    // action_items (migration 018): optional list built up in the form
    // before saving, inserted in the same transaction as the connect
    // itself so a partial save (connect with no items, or items with no
    // connect) can't happen. logged_by_id (migration 019) records who
    // actually submitted this — see the self-logging note below.
    const { employee_id, held_at, duration_min, topic, discussion_notes, notes, achievements, blockers, feedback, kra_ids, meeting_based, action_items } = req.body || {};
    if (!employee_id || !held_at) return res.status(400).json({ error: 'employee_id and held_at required' });

    // Previously this route required pms_team_eval unconditionally — an
    // employee logging their OWN 1-on-1 had no way to do so (the "Select
    // report" dropdown is empty for anyone without direct reports, since
    // it comes from GET /team/evaluations, which is itself pms_team_eval-
    // gated), so an employee always hit "Employee and date required" with
    // no way to satisfy it. Fixed: logging about YOURSELF needs no special
    // permission; logging on someone ELSE's behalf still requires
    // pms_team_eval, same as before.
    const isSelf = employee_id === req.user.id;
    let managerId;
    if (isSelf) {
      const emp = (await db.query(`SELECT manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.user.id, T(req)])).rows[0];
      managerId = emp ? emp.manager_id : null;
      if (!managerId) return res.status(422).json({ error: 'You have no manager on record — ask HR to set one before logging a connect.' });
    } else {
      if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
      managerId = req.user.id;
    }

    if (meeting_based) await requireConsent(T(req), employee_id);
    const items = Array.isArray(action_items) ? action_items.filter((i) => i && String(i.description || '').trim()) : [];

    const client = await db.getClient();
    let connectId;
    try {
      await client.query('BEGIN');
      const cn = (await client.query(
        `INSERT INTO pms.connects (tenant_id, manager_id, employee_id, held_at, duration_min, topic, discussion_notes, notes, achievements, blockers, feedback, kra_ids, meeting_based, logged_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::uuid[],'{}'::uuid[]),$13,$14) RETURNING id`,
        [T(req), managerId, employee_id, held_at, duration_min != null ? Number(duration_min) : null, topic || null, discussion_notes || null,
          notes || null, achievements || null, blockers || null, feedback || null,
          Array.isArray(kra_ids) ? kra_ids : null, !!meeting_based, req.user.id])).rows[0];
      connectId = cn.id;
      for (const item of items) {
        await client.query(
          `INSERT INTO pms.connect_action_items (tenant_id, connect_id, description, due_date) VALUES ($1,$2,$3,$4)`,
          [T(req), connectId, String(item.description).trim(), item.due_date || null]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    audit(req, 'CONNECT_LOGGED', null, employee_id, { held_at, action_items: items.length, self_logged: isSelf });
    if (isSelf) await notify(T(req), managerId, 'connect_logged_by_report', `${req.user.name} logged a 1-on-1 discussion for your sign-off`, null, '/pms/team/connects');
    res.json({ ok: true, id: connectId });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/connects', async (req, res) => {
  try {
    const mine = req.query.employee_id;
    const r = await db.query(
      `SELECT cn.*, e.name AS employee_name, m.name AS manager_name,
              COALESCE((SELECT json_agg(json_build_object('id', ai.id, 'description', ai.description, 'due_date', ai.due_date, 'done', ai.done) ORDER BY ai.created_at)
                        FROM pms.connect_action_items ai WHERE ai.connect_id=cn.id), '[]') AS action_items,
              COALESCE((SELECT json_agg(json_build_object('id', k.id, 'title', k.title))
                        FROM pms.kras k WHERE k.id = ANY(cn.kra_ids)), '[]') AS linked_kras
         FROM pms.connects cn JOIN core.employees e ON e.id=cn.employee_id JOIN core.employees m ON m.id=cn.manager_id
        WHERE cn.tenant_id=$1 AND (cn.employee_id=$2 OR cn.manager_id=$2) ${mine ? 'AND cn.employee_id=$3' : ''}
        ORDER BY cn.held_at DESC LIMIT 100`,
      mine ? [T(req), req.user.id, mine] : [T(req), req.user.id]);
    res.json({ connects: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle one action item's done state — independent of the connect it
// came from being signed off or not; a follow-up can still be ticked off
// weeks later. Manager (who logged the connect) or admin only, same
// scoping as sign-off.
router.put('/connects/:id/action-items/:itemId', async (req, res) => {
  try {
    const cn = (await db.query(`SELECT * FROM pms.connects WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!cn) return res.status(404).json({ error: 'connect not found' });
    if (cn.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your connect' });
    const { done } = req.body || {};
    const r = await db.query(
      `UPDATE pms.connect_action_items SET done=$1 WHERE id=$2 AND connect_id=$3 RETURNING id`,
      [!!done, req.params.itemId, cn.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'action item not found on this connect' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fix guide item #8 follow-up: the "Connect Cadence / Progress this
// cycle / Next due" header from the reference screenshot. Cadence is
// fixed at 90 days (matching connect-reminders.js's own default —
// "Quarterly"), applied against the active cycle's date range (falls
// back to a full year if the cycle has no opens_at/closes_at set).
router.get('/connects/cadence/:employeeId', async (req, res) => {
  try {
    const isSelf = req.params.employeeId === req.user.id;
    if (!isSelf && !(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (!isSelf && emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const c = await activeCycle(T(req));
    const cycleStart = c && c.opens_at ? new Date(c.opens_at) : null;
    const cycleEnd = c && c.closes_at ? new Date(c.closes_at) : null;

    const rangeParams = cycleStart && cycleEnd ? [T(req), req.params.employeeId, c.opens_at, c.closes_at] : [T(req), req.params.employeeId];
    const rangeClause = cycleStart && cycleEnd ? 'AND held_at BETWEEN $3 AND $4' : '';
    const loggedRow = (await db.query(
      `SELECT COUNT(*)::int AS n, MAX(held_at) AS last_held_at FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2 ${rangeClause}`,
      rangeParams)).rows[0];

    const result = computeCadenceProgress({
      cycleStart, cycleEnd, today: new Date(), loggedCount: loggedRow.n,
      lastHeldAt: loggedRow.last_held_at ? new Date(loggedRow.last_held_at) : null,
    });
    res.json({ ...result, next_due: result.next_due.toISOString().slice(0, 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fix guide item #8: lets the "Log a connect" form fetch the employee's
// current KRAs to link against (kra_ids), instead of the manager typing
// KRA references from memory. Manager-scoped the same way team/kra-sheets
// is — only for one's own reports (or HR/admin).
router.get('/connects/kra-options/:employeeId', async (req, res) => {
  try {
    const isSelf = req.params.employeeId === req.user.id;
    if (!isSelf && !(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const emp = (await db.query(`SELECT id, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (!isSelf && emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your report' });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ kras: [] });
    const kras = (await db.query(
      `SELECT k.id, k.title FROM pms.kras k JOIN pms.kra_sheets s ON s.id=k.sheet_id
        WHERE s.cycle_id=$1 AND s.employee_id=$2 ORDER BY k.sort_order`, [c.id, req.params.employeeId])).rows;
    res.json({ kras });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// BR-4.3: "Managers confirm and sign off each logged conversation."
// Sign-off is a distinct, explicit action from creating the log — a
// manager can log now and sign off after reviewing (e.g. after editing
// notes or reading the AI insights below), rather than the act of
// creation being silently treated as sign-off.
// Requested: "AI auto-tag KRAs" — the manual KRA-linking chips already
// existed at CREATE time, but nothing let anyone change the links on an
// already-saved connect. Kept deliberately narrow (kra_ids only, not a
// full edit-everything route) — that's all this feature needs.
router.put('/connects/:id', async (req, res) => {
  try {
    const cn = (await db.query(`SELECT * FROM pms.connects WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!cn) return res.status(404).json({ error: 'connect not found' });
    // Widened alongside connect-autotag: an employee needs to be able to
    // save the KRA links on a connect that's about THEM, not just the
    // manager — otherwise the auto-tag suggestion above has no way to
    // actually be applied when the employee is the one using it.
    if (cn.manager_id !== req.user.id && cn.employee_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: 'Not your connect to edit' });
    }
    if (cn.signed_off) return res.status(409).json({ error: 'Already signed off — locked' });
    const { kra_ids } = req.body || {};
    if (!Array.isArray(kra_ids)) return res.status(400).json({ error: 'kra_ids array required' });
    await db.query(`UPDATE pms.connects SET kra_ids=$2 WHERE id=$1`, [cn.id, kra_ids]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/connects/:id/sign-off', async (req, res) => {
  try {
    const cn = (await db.query(`SELECT * FROM pms.connects WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!cn) return res.status(404).json({ error: 'connect not found' });
    if (cn.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: 'Not your connect to sign off' });
    if (cn.signed_off) return res.status(409).json({ error: 'already signed off' });
    await db.query(`UPDATE pms.connects SET signed_off=true, signed_off_at=now() WHERE id=$1`, [cn.id]);
    audit(req, 'CONNECT_SIGNED_OFF', null, cn.employee_id, { connect_id: cn.id });
    await notify(T(req), cn.employee_id, 'connect_signed_off', 'Your manager signed off your quarterly connect', null, '/pms');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Quarterly Connect reminders — BR-4.4 ---------------------
// No separate worker/cron service exists in this deploy (see
// migrations/010-connect-reminders.js), so this is triggered two ways:
// an in-process daily interval (index.js) and this on-demand HR route
// (also useful for testing and as a manual fallback).
async function checkAndSendConnectReminders(tenantId) {
  const employees = (await db.query(
    `SELECT e.id, e.name, e.manager_id FROM core.employees e
      WHERE e.tenant_id=$1 AND e.status='active' AND e.manager_id IS NOT NULL`, [tenantId])).rows;
  let reminded = 0;
  const today = new Date();
  for (const emp of employees) {
    const last = (await db.query(
      `SELECT MAX(held_at) AS last_held FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, emp.id])).rows[0];
    const lastConnect = last.last_held ? new Date(last.last_held) : null;
    if (!isConnectDue(lastConnect, today)) continue;
    const lastReminder = (await db.query(
      `SELECT MAX(sent_at) AS last_sent FROM pms.connect_reminders_log WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, emp.id])).rows[0];
    const lastSent = lastReminder.last_sent ? new Date(lastReminder.last_sent) : null;
    if (!shouldRemindAgain(lastSent, today)) continue;
    await notify(tenantId, emp.manager_id, 'connect_due', `A quarterly connect with ${emp.name} is due`, null, '/pms');
    await notify(tenantId, emp.id, 'connect_due', 'Your quarterly connect with your manager is due', null, '/pms');
    await db.query(
      `INSERT INTO pms.connect_reminders_log (tenant_id, employee_id, manager_id) VALUES ($1,$2,$3)`,
      [tenantId, emp.id, emp.manager_id]);
    reminded++;
  }
  return reminded;
}

router.post('/connects/check-reminders', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const reminded = await checkAndSendConnectReminders(T(req));
    audit(req, 'CONNECT_REMINDERS_CHECKED', null, null, { reminded });
    res.json({ ok: true, reminded });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- PIP (Performance Improvement Plan) — BR-7.1/BR-7.2 -------
// Auto-opened at /publish (above) when final_rating < cycle.pip_threshold.
// Writers are the employee's manager or HR (BRD Owner/Approver column);
// the employee has read-only visibility into their own PIP and its weekly
// entries — matching "visible to the employee, manager, and HR."
async function isManagerOfOrAdmin(req, employeeId) {
  if (await hasPermission(req.user, 'pms_admin')) return true;
  const r = await db.query(`SELECT 1 FROM core.employees WHERE id=$1 AND tenant_id=$2 AND manager_id=$3`,
    [employeeId, T(req), req.user.id]);
  return !!r.rows[0];
}

router.get('/pip', async (req, res) => {
  try {
    const isAdmin = await hasPermission(req.user, 'pms_admin');
    const { employee_id, status } = req.query;
    const params = [T(req)]; const clauses = ['p.tenant_id=$1'];
    if (!isAdmin) {
      params.push(req.user.id);
      clauses.push(`(p.employee_id=$${params.length} OR EXISTS (SELECT 1 FROM core.employees me WHERE me.id=p.employee_id AND me.manager_id=$${params.length}))`);
    }
    if (employee_id) { params.push(employee_id); clauses.push(`p.employee_id=$${params.length}`); }
    if (status) { params.push(status); clauses.push(`p.status=$${params.length}`); }
    const r = await db.query(
      `SELECT p.*, e.name AS employee_name, e.department, c.name AS cycle_name
         FROM pms.pip_records p JOIN core.employees e ON e.id=p.employee_id
         LEFT JOIN pms.cycles c ON c.id=p.cycle_id
        WHERE ${clauses.join(' AND ')} ORDER BY p.opened_at DESC`, params);
    res.json({ pips: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/pip/:id', async (req, res) => {
  try {
    const p = (await db.query(`SELECT p.*, e.name AS employee_name FROM pms.pip_records p JOIN core.employees e ON e.id=p.employee_id
                                 WHERE p.id=$1 AND p.tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!p) return res.status(404).json({ error: 'PIP not found' });
    const isSelf = p.employee_id === req.user.id;
    if (!isSelf && !(await isManagerOfOrAdmin(req, p.employee_id))) return res.status(403).json({ error: 'Not visible to you' });
    const entries = (await db.query(
      `SELECT id, week_ending, notes, submitted_by, created_at FROM pms.pip_weekly_entries
        WHERE pip_id=$1 ORDER BY week_ending DESC`, [p.id])).rows;
    res.json({ pip: p, weekly_entries: entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manager/HR only — plan text, and status transitions through to a
// documented closure (BR-7.2 "through to a documented closure": closing
// requires closed_reason, not just a status flip).
router.put('/pip/:id', async (req, res) => {
  try {
    const p = (await db.query(`SELECT * FROM pms.pip_records WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!p) return res.status(404).json({ error: 'PIP not found' });
    if (!(await isManagerOfOrAdmin(req, p.employee_id))) return res.status(403).json({ error: 'Requires being this employee\'s manager, or pms_admin' });
    const { plan, status, closed_reason } = req.body || {};
    const VALID = ['open', 'in_progress', 'closed_successful', 'closed_unsuccessful'];
    if (status && !VALID.includes(status)) return res.status(400).json({ error: `status must be one of: ${VALID.join(', ')}` });
    if (status && status.startsWith('closed') && !closed_reason) return res.status(400).json({ error: 'closed_reason required to close a PIP' });
    const closing = status && status.startsWith('closed');
    await db.query(
      `UPDATE pms.pip_records SET plan=COALESCE($1,plan), status=COALESCE($2,status),
              closed_reason=COALESCE($3,closed_reason), closed_at=CASE WHEN $4 THEN now() ELSE closed_at END
        WHERE id=$5`, [plan || null, status || null, closed_reason || null, closing, p.id]);
    audit(req, closing ? 'PIP_CLOSED' : 'PIP_UPDATED', p.cycle_id, p.employee_id, { status, closed_reason });
    if (closing) await notify(T(req), p.employee_id, 'pip_closed', `Your Performance Improvement Plan has been closed (${status})`, null, '/pms/my-rating');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pip/:id/entries', async (req, res) => {
  try {
    const p = (await db.query(`SELECT * FROM pms.pip_records WHERE id=$1 AND tenant_id=$2`, [req.params.id, T(req)])).rows[0];
    if (!p) return res.status(404).json({ error: 'PIP not found' });
    if (!(await isManagerOfOrAdmin(req, p.employee_id))) return res.status(403).json({ error: 'Requires being this employee\'s manager, or pms_admin' });
    if (p.status.startsWith('closed')) return res.status(409).json({ error: 'PIP is closed — no further entries' });
    const { week_ending, notes } = req.body || {};
    if (!week_ending || !notes) return res.status(400).json({ error: 'week_ending and notes required' });
    await db.query(
      `INSERT INTO pms.pip_weekly_entries (tenant_id, pip_id, week_ending, notes, submitted_by) VALUES ($1,$2,$3,$4,$5)`,
      [T(req), p.id, week_ending, notes, req.user.email]);
    if (p.status === 'open') await db.query(`UPDATE pms.pip_records SET status='in_progress' WHERE id=$1`, [p.id]);
    await notify(T(req), p.employee_id, 'pip_entry_added', 'A new weekly note was added to your Performance Improvement Plan', null, '/pms/my-rating');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Super 50 / High-Performer Watchlist — BR-6.5 -------------
// HR/Management view (matches the BRD's Owner/Approver column for this
// requirement). The flag itself is recomputed at /publish, above; this
// route just surfaces who is currently on it, for retention/succession
// planning. Retention Alerts (BR-6.6, next feature) reads this same flag.
router.get('/watchlist', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const r = await db.query(
      `SELECT e.id, e.name, e.email, e.department, e.designation, e.super50_since,
              e.last_appraisal_rating, e.last_appraisal_at
         FROM core.employees e WHERE e.tenant_id=$1 AND e.super50_flag=true
        ORDER BY e.super50_since ASC`, [T(req)]);
    res.json({ watchlist: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Closure letter PDF generation -----------------------------
// A closure_letters row is created (record only, no PDF) at /publish
// above — the branded PDF itself was explicitly deferred ("Phase 4
// template engine decision", per this file's header comment). This
// closes that: HR reviews/edits the AI-drafted text (POST /agentic/
// letter-draft — a DRAFT only, never auto-applied, matching the AI
// human-approval safeguard) and explicitly triggers PDF generation with
// the final wording. The rating/label are read directly from the
// published history row, never re-typed, so the PDF cannot state a
// different number than what was actually published.
// HR-facing list: everyone with a closure_letters record for the active
// cycle (created automatically at /publish), showing whether the PDF
// has been generated yet.
router.get('/closure-letters', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'letters_admin')) && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: "Requires 'letters_admin' or 'pms_admin'" });
    }
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, letters: [] });
    const r = await db.query(
      `SELECT cl.employee_id, cl.cycle_id, e.name AS employee_name, h.final_rating, h.rating_label,
              (cl.file_data IS NOT NULL) AS generated, cl.generated_at
         FROM pms.closure_letters cl JOIN core.employees e ON e.id=cl.employee_id
         LEFT JOIN pms.employee_performance_history h ON h.employee_id=cl.employee_id AND h.cycle_id=cl.cycle_id
        WHERE cl.tenant_id=$1 AND cl.cycle_id=$2 ORDER BY e.name`, [T(req), c.id]);
    res.json({ cycle: { id: c.id, name: c.name }, letters: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/closure-letters/:employeeId/:cycleId/generate', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'letters_admin')) && !(await hasPermission(req.user, 'pms_admin'))) {
      return res.status(403).json({ error: "Requires 'letters_admin' or 'pms_admin'" });
    }
    const { salutation, body_paragraphs, closing_line } = req.body || {};
    if (!salutation || !Array.isArray(body_paragraphs) || !body_paragraphs.length || !closing_line) {
      return res.status(400).json({ error: 'salutation, body_paragraphs (non-empty array), and closing_line are required' });
    }
    const h = (await db.query(
      `SELECT h.final_rating, h.rating_label, c.name AS cycle_name, c.fiscal_year, e.name AS employee_name, e.designation
         FROM pms.employee_performance_history h JOIN pms.cycles c ON c.id=h.cycle_id JOIN core.employees e ON e.id=h.employee_id
        WHERE h.tenant_id=$1 AND h.employee_id=$2 AND h.cycle_id=$3`,
      [T(req), req.params.employeeId, req.params.cycleId])).rows[0];
    if (!h) return res.status(404).json({ error: 'No published rating for this employee/cycle — publish first' });
    const tenant = (await db.query(`SELECT name FROM core.tenants WHERE id=$1`, [T(req)])).rows[0];

    const doc = new PDFDocument({ margin: 60 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const pdfDone = new Promise((resolve) => doc.on('end', resolve));

    doc.fontSize(18).text(tenant.name, { align: 'center' });
    doc.moveDown(0.3).fontSize(11).fillColor('#666').text('Performance Cycle Closure Letter', { align: 'center' });
    doc.moveDown(1.5).fillColor('#000').fontSize(11);
    doc.text(`${h.cycle_name} (${h.fiscal_year})`);
    doc.text(`${h.employee_name}${h.designation ? ' — ' + h.designation : ''}`);
    doc.moveDown(1);
    doc.text(salutation);
    doc.moveDown(0.8);
    for (const p of body_paragraphs) { doc.text(p, { align: 'justify' }); doc.moveDown(0.6); }
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').text(`Final Rating: ${h.final_rating} — ${h.rating_label}`);
    doc.font('Helvetica').moveDown(1);
    doc.text(closing_line);
    doc.moveDown(2);
    doc.text(tenant.name, { align: 'left' });
    doc.end();
    await pdfDone;
    const pdfBuffer = Buffer.concat(chunks);

    await db.query(
      `UPDATE pms.closure_letters SET file_data=$1, content_type='application/pdf', generated_by=$2, generated_at=now()
        WHERE tenant_id=$3 AND employee_id=$4 AND cycle_id=$5`,
      [pdfBuffer, req.user.email, T(req), req.params.employeeId, req.params.cycleId]);
    audit(req, 'CLOSURE_LETTER_GENERATED', req.params.cycleId, req.params.employeeId, { bytes: pdfBuffer.length });
    await notify(T(req), req.params.employeeId, 'closure_letter_ready', `Your ${h.cycle_name} closure letter is ready`, null, '/pms/my-rating');
    res.json({ ok: true, bytes: pdfBuffer.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/closure-letters/:employeeId/:cycleId/download', async (req, res) => {
  try {
    const employeeId = req.params.employeeId === 'me' ? req.user.id : req.params.employeeId;
    const row = (await db.query(
      `SELECT cl.*, e.manager_id FROM pms.closure_letters cl JOIN core.employees e ON e.id=cl.employee_id
        WHERE cl.tenant_id=$1 AND cl.employee_id=$2 AND cl.cycle_id=$3`,
      [T(req), employeeId, req.params.cycleId])).rows[0];
    if (!row) return res.status(404).json({ error: 'no closure letter record' });
    const isOwner = row.employee_id === req.user.id;
    const isManager = row.manager_id === req.user.id;
    if (!isOwner && !isManager && !(await hasPermission(req.user, 'pms_admin')) && !(await hasPermission(req.user, 'letters_admin'))) {
      return res.status(403).json({ error: 'Not authorised' });
    }
    if (!row.file_data) return res.status(404).json({ error: 'PDF not generated yet' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="closure-letter.pdf"`);
    res.send(row.file_data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- Reporting & repair utilities -------------------------------
// The four items confirmed missing in a direct BRD/reference-menu review and
// then requested to be built: a completion report, a personal rating
// history, a consolidated team view, and an idempotent HOD-queue repair
// action. All read-only except the last, which only ever creates rows that
// SHOULD already exist (INSERT ... DO NOTHING) — never overwrites anything.

// "PMS Completion Report" — who has and hasn't completed their PMS this
// cycle, across every stage an employee is personally responsible for
// (KRA, Dev Plan, Self-Appraisal, Manager Evaluation). HOD review is
// intentionally excluded from "employee complete" — it isn't the
// employee's own action to finish.
router.get('/reports/completion', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    // The moment HR most wants this report is as a cycle closes or just
    // after — but activeCycle() filters out closed/cancelled, so the page
    // went blank exactly then. An explicit cycle_id names ANY cycle of
    // this tenant regardless of phase; without it, behaviour is
    // unchanged and we still default to whatever is active.
    let c;
    if (req.query.cycle_id) {
      // Check the id's shape first: an unparseable value would otherwise
      // fail on the uuid cast and surface as a 500 with a raw driver
      // message rather than a clean 404.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.query.cycle_id)) {
        return res.status(404).json({ error: 'Cycle not found' });
      }
      // Scoped by tenant_id as well as id, so one tenant can't read
      // another's cycle by guessing an id.
      c = (await db.query(`SELECT * FROM pms.cycles WHERE id=$1 AND tenant_id=$2`,
        [req.query.cycle_id, T(req)])).rows[0];
      if (!c) return res.status(404).json({ error: 'Cycle not found' });
    } else {
      c = await activeCycle(T(req));
    }
    if (!c) return res.json({ cycle: null, rows: [] });
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, e.department,
              COALESCE(ks.status, 'not_started') AS kra_status,
              COALESCE(dp.status, 'not_started') AS devplan_status,
              COALESCE(sa.status, 'not_started') AS self_appraisal_status,
              COALESCE(me.status, 'pending') AS manager_eval_status,
              COALESCE(he.status, 'pending') AS hod_status
         FROM core.employees e
         LEFT JOIN pms.kra_sheets ks ON ks.cycle_id=$1 AND ks.employee_id=e.id
         LEFT JOIN pms.development_plans dp ON dp.cycle_id=$1 AND dp.employee_id=e.id
         LEFT JOIN pms.self_appraisals sa ON sa.cycle_id=$1 AND sa.employee_id=e.id
         LEFT JOIN pms.manager_evaluations me ON me.cycle_id=$1 AND me.employee_id=e.id
         LEFT JOIN pms.hod_evaluations he ON he.cycle_id=$1 AND he.employee_id=e.id
        WHERE e.tenant_id=$2 AND e.status='active' ORDER BY e.department, e.name`,
      [c.id, T(req)]);
    const rows = r.rows.map((row) => ({
      ...row,
      complete: ['approved'].includes(row.kra_status) &&
        ['approved'].includes(row.devplan_status) &&
        row.self_appraisal_status === 'submitted' &&
        row.manager_eval_status === 'submitted',
    }));
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "See past years" — an employee's own rating history across published
// annual cycles (the same table Super 50 reads), plus a manager/admin
// view of a specific report's.
router.get('/my/history', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT h.cycle_id, c.name AS cycle_name, c.fiscal_year, h.final_rating, h.rating_label, h.published_at
         FROM pms.employee_performance_history h JOIN pms.cycles c ON c.id=h.cycle_id
        WHERE h.tenant_id=$1 AND h.employee_id=$2 ORDER BY h.published_at DESC`,
      [T(req), req.user.id]);
    res.json({ history: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/team/history/:employeeId', async (req, res) => {
  try {
    const emp = (await db.query(`SELECT id, name, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, T(req)])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin')) && !(await hasPermission(req.user, 'pms_hod'))) {
      return res.status(403).json({ error: 'Not your report' });
    }
    const r = await db.query(
      `SELECT h.cycle_id, c.name AS cycle_name, c.fiscal_year, h.final_rating, h.rating_label, h.published_at
         FROM pms.employee_performance_history h JOIN pms.cycles c ON c.id=h.cycle_id
        WHERE h.tenant_id=$1 AND h.employee_id=$2 ORDER BY h.published_at DESC`,
      [T(req), req.params.employeeId]);
    res.json({ employee: { id: emp.id, name: emp.name }, history: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "Team overview" — all of a manager's reports' progress in one view,
// across modules that today each live on their own separate screen (Team
// KRA Sheets, My Growth's team section, Team Evaluation, Connects).
router.get('/team/overview', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const c = await activeCycle(T(req));
    if (!c) return res.json({ cycle: null, rows: [] });
    const r = await db.query(
      `SELECT e.id AS employee_id, e.name, e.department,
              COALESCE(ks.status, 'not_started') AS kra_status,
              COALESCE(dp.status, 'not_started') AS devplan_status,
              (cp.target_role IS NOT NULL) AS has_career_path,
              COALESCE(sa.status, 'not_started') AS self_appraisal_status,
              COALESCE(me.status, 'pending') AS manager_eval_status,
              (SELECT COUNT(*)::int FROM pms.connects cn WHERE cn.tenant_id=$2 AND cn.employee_id=e.id AND cn.held_at >= COALESCE($1::date, cn.held_at)) AS connects_this_cycle
         FROM core.employees e
         LEFT JOIN pms.kra_sheets ks ON ks.cycle_id=$3 AND ks.employee_id=e.id
         LEFT JOIN pms.development_plans dp ON dp.cycle_id=$3 AND dp.employee_id=e.id
         LEFT JOIN people.career_paths cp ON cp.tenant_id=e.tenant_id AND cp.employee_id=e.id
         LEFT JOIN pms.self_appraisals sa ON sa.cycle_id=$3 AND sa.employee_id=e.id
         LEFT JOIN pms.manager_evaluations me ON me.cycle_id=$3 AND me.employee_id=e.id
        WHERE e.tenant_id=$2 AND e.manager_id=$4 AND e.status='active' ORDER BY e.name`,
      [c.opens_at || null, T(req), c.id, req.user.id]);
    res.json({ cycle: { id: c.id, name: c.name, phase: c.phase }, rows: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "Re-seed HOD evaluations" — idempotent. GET /hod/queue already shows a
// submitted manager evaluation even with no hod_evaluations row yet (LEFT
// JOIN), but nothing pre-creates that row — this proactively ensures one
// exists (status 'pending') for every employee whose manager evaluation is
// submitted, so the queue is fully seeded rather than relying on lazy
// creation the first time a Delivery Head opens each one. ON CONFLICT DO
// NOTHING — never overwrites an existing decision, safe to re-run anytime.
router.post('/hod/re-seed', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const c = await activeCycle(T(req));
    if (!c) return res.status(409).json({ error: 'No active cycle' });
    const submitted = (await db.query(
      `SELECT me.employee_id, e.department FROM pms.manager_evaluations me JOIN core.employees e ON e.id=me.employee_id
        WHERE me.tenant_id=$1 AND me.cycle_id=$2 AND me.status='submitted'`, [T(req), c.id])).rows;
    let created = 0;
    let skippedNoHead = 0;
    for (const row of submitted) {
      const head = (await db.query(`SELECT employee_id FROM core.department_heads WHERE tenant_id=$1 AND department=$2`, [T(req), row.department])).rows[0];
      // hod_evaluations.hod_id is NOT NULL — a department with no head
      // assigned yet has nowhere to route the row to, so it's skipped
      // rather than inserted with a placeholder. Assign the department
      // head first (HR Admin -> Department Heads), then re-run.
      if (!head) { skippedNoHead++; continue; }
      const result = await db.query(
        `INSERT INTO pms.hod_evaluations (tenant_id, cycle_id, employee_id, hod_id, status) VALUES ($1,$2,$3,$4,'pending')
         ON CONFLICT (cycle_id, employee_id) DO NOTHING RETURNING id`,
        [T(req), c.id, row.employee_id, head.employee_id]);
      if (result.rows.length) created++;
    }
    audit(req, 'HOD_QUEUE_RESEEDED', c.id, null, { checked: submitted.length, created, skippedNoHead });
    res.json({ ok: true, checked: submitted.length, created, skipped_no_head: skippedNoHead });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Found live: KRA titles from an earlier bulk upload had "(Employee Name -
// Designation)" typed onto the end of every title in the source file —
// confirmed this isn't something our own bulk-upload code adds (it passes
// kra_title through verbatim), so it's a one-time data-cleanup problem,
// not a recurring code bug. This is a repair action in the same spirit as
// /hod/re-seed: idempotent (running it again finds nothing left to strip),
// and only ever removes a suffix that exactly matches THAT KRA's own
// employee's name/designation — never touches a title that just happens
// to contain parentheses for some other reason.
router.post('/hr/kra-sheet/clean-titles', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const rows = (await db.query(
      `SELECT k.id, k.title, e.name, e.designation
         FROM pms.kras k
         JOIN pms.kra_sheets s ON s.id=k.sheet_id
         JOIN core.employees e ON e.id=s.employee_id
        WHERE k.tenant_id=$1`, [T(req)])).rows;
    let cleaned = 0;
    const examples = [];
    for (const row of rows) {
      if (!row.title || (!row.name && !row.designation)) continue;
      let next = row.title;
      const suffixes = [];
      if (row.name && row.designation) suffixes.push(`(${row.name} - ${row.designation})`);
      if (row.name) suffixes.push(`(${row.name})`);
      if (row.designation) suffixes.push(`(${row.designation})`);
      for (const suffix of suffixes) {
        if (next.toLowerCase().endsWith(suffix.toLowerCase())) {
          next = next.slice(0, next.length - suffix.length).trim();
          break;
        }
      }
      if (next !== row.title && next.length > 0) {
        await db.query(`UPDATE pms.kras SET title=$2 WHERE id=$1`, [row.id, next]);
        if (examples.length < 5) examples.push({ before: row.title, after: next });
        cleaned++;
      }
    }
    audit(req, 'KRA_TITLES_CLEANED', null, null, { checked: rows.length, cleaned });
    res.json({ ok: true, checked: rows.length, cleaned, examples });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// mergeMidyearEntries and midyearOverall are exported for direct unit
// testing, the same reason validateEmployeeRows is in core/employees.js:
// they are the pure part of the per-KRA scoring (no db), and the weighted
// average plus the "no overall until every KRA is rated" rule are exactly
// the behaviour worth pinning down without standing up a database.
module.exports = { router, checkAndSendConnectReminders, mergeMidyearEntries, midyearOverall };
