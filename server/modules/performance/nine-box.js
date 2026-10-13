// The 9-box grid — screens, settings, overrides, the manager's potential
// step, and what publish does with a placement. The rules themselves are
// pure, in nine-box-rules.js; this file feeds them and keeps their result.
//
// ONE CALCULATION, TWO TIMES. Before publish, every screen works the box
// out live from the cycle's ratings, competency assessments, potential
// answers, overrides and settings — so a changed band limit or an HR
// override moves people at once (acceptance: "changing the band limits
// re-places employees before publish"). At publish the same function's
// result is written to pms.nine_box_placements and, from then on, that is
// what every screen reads: a published box does not move because somebody
// later edits a setting.
//
// WHO SEES WHAT (the spec's permissions row):
//   company      HR and Super Admin (pms_admin) — the whole company
//   departments  a Delivery Head (pms_hod) — the departments they head
//                in core.department_heads
//   team         a manager (pms_team_eval) — their direct reports
// Nobody sees their own box, in any view: "employees do not see their
// box" covers HR and managers too, who are employees. An HRBP's company
// view is cut to their remit before anything is counted.

const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { guardUuidParams } = require('../../core/http');
const { visibleRows } = require('../../core/scope-hooks');
const { hasPermission } = require('../../core/permissions');
const { notify } = require('../../core/notifications');
const { activeCycle } = require('./active-cycle');
const { eligibleForCycle, appraisalYearOf } = require('./eligibility');
const pm = require('./phase-machine');
const rules = require('./nine-box-rules');

const T = (req) => req.user.tenant_id;

// Written inside the caller's transaction and AWAITED: "every placement,
// override and action logged with who, when and why" is a requirement,
// and the module's best-effort audit() swallows a failed write.
async function auditTx(client, req, action, cycleId, employeeId, details) {
  const self = !!(employeeId && req.user && employeeId === req.user.id);
  const body = self ? { ...(details || {}), self_action: true } : details;
  await client.query(
    `INSERT INTO pms.audit_log (tenant_id, actor_email, action, cycle_id, employee_id, details)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [T(req), req.user.email, action, cycleId || null, employeeId || null, body ? JSON.stringify(body) : null]);
}

async function inTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

const n = (v) => (v == null ? null : Number(v));

// ------------------------------------------------------------------ settings

// A cycle's settings: its own row, else the latest earlier cycle's (HR
// set them once and they carry forward), else the spec's defaults.
async function settingsFor(t, cycle) {
  const own = (await db.query(
    `SELECT * FROM pms.nine_box_settings WHERE tenant_id=$1 AND cycle_id=$2`, [t, cycle.id])).rows[0];
  if (own) return { ...rules.normaliseSettings(own), stored: true, inherited_from: null, updated_by: own.updated_by, updated_at: own.updated_at };
  const prev = (await db.query(
    `SELECT s.*, c.name AS cycle_name FROM pms.nine_box_settings s JOIN pms.cycles c ON c.id=s.cycle_id
      WHERE s.tenant_id=$1 AND c.created_at < $2 ORDER BY c.created_at DESC LIMIT 1`,
    [t, cycle.created_at])).rows[0];
  return { ...rules.normaliseSettings(prev), stored: false,
    inherited_from: prev ? { cycle_id: prev.cycle_id, name: prev.cycle_name } : null };
}

const publicSettings = (s) => ({
  mid_from: s.mid_from, high_from: s.high_from, competency_weight: s.competency_weight,
  boxes: s.boxes, questions: s.questions, band_text: rules.bandText(s),
});

// ------------------------------------------------------------------ inputs

// Everybody calibration and publish work on (a submitted manager
// evaluation this cycle), with each input the placement needs. One query
// for the lot: 1,400 people must not be 1,400 round trips.
async function loadInputs(t, cycle, { employeeIds = null } = {}) {
  const params = [t, cycle.id];
  if (employeeIds) params.push(employeeIds);
  const rows = (await db.query(
    `SELECT e.id AS employee_id, e.name, e.email, e.emp_code, e.department, e.location, e.designation,
            e.manager_id, m.name AS manager_name, e.date_of_joining, e.super50_flag,
            dg.grade,
            adj.to_rating AS adjustment, he.overall_rating AS hod, me.overall_rating AS manager,
            ca.manager_status AS competency_status,
            COALESCE((SELECT json_agg(json_build_object('manager_rating', cr.manager_rating))
                        FROM pms.competency_ratings cr WHERE cr.assessment_id = ca.id), '[]'::json) AS competency_rows,
            pa.answers AS potential_answers
       FROM core.employees e
       JOIN pms.manager_evaluations me ON me.cycle_id=$2 AND me.employee_id=e.id AND me.status='submitted'
       LEFT JOIN core.employees m ON m.id = e.manager_id
       LEFT JOIN pms.designation_grade dg ON dg.tenant_id = e.tenant_id AND dg.lower_designation = lower(btrim(e.designation))
       LEFT JOIN pms.hod_evaluations he ON he.cycle_id=$2 AND he.employee_id=e.id AND he.status='submitted'
       LEFT JOIN LATERAL (SELECT to_rating FROM pms.rating_adjustments ra
                           WHERE ra.cycle_id=$2 AND ra.employee_id=e.id ORDER BY at DESC LIMIT 1) adj ON true
       LEFT JOIN pms.competency_assessments ca ON ca.tenant_id=e.tenant_id AND ca.cycle_id=$2 AND ca.employee_id=e.id
       LEFT JOIN pms.potential_answers pa ON pa.cycle_id=$2 AND pa.employee_id=e.id
      WHERE e.tenant_id=$1 ${employeeIds ? 'AND e.id = ANY($3::uuid[])' : ''}
      ORDER BY e.name`, params)).rows;
  const ov = (await db.query(
    `SELECT employee_id, axis, from_band, to_band, reason, overridden_by, at
       FROM pms.nine_box_overrides WHERE tenant_id=$1 AND cycle_id=$2
       ${employeeIds ? 'AND employee_id = ANY($3::uuid[])' : ''} ORDER BY at`, params)).rows;
  const overrides = new Map();
  for (const o of ov) {
    if (!overrides.has(o.employee_id)) overrides.set(o.employee_id, []);
    overrides.get(o.employee_id).push(o);
  }
  return { rows, overrides };
}

// Each person's previous box: their latest placement in an EARLIER cycle,
// placed or not. A cycle in which they were not placed breaks a streak,
// so "two cycles in (0,0)" means two in a row.
async function previousPlacements(t, cycle, employeeIds = null) {
  const params = [t, cycle.created_at, cycle.id];
  if (employeeIds) params.push(employeeIds);
  const rows = (await db.query(
    `SELECT DISTINCT ON (p.employee_id) p.employee_id, p.cycle_id, c.name AS cycle_name, p.box_key, p.status
       FROM pms.nine_box_placements p JOIN pms.cycles c ON c.id = p.cycle_id
      WHERE p.tenant_id=$1 AND c.created_at < $2 AND p.cycle_id <> $3
        ${employeeIds ? 'AND p.employee_id = ANY($4::uuid[])' : ''}
      ORDER BY p.employee_id, c.created_at DESC`, params)).rows;
  return new Map(rows.map((r) => [r.employee_id, r]));
}

// The cycle's appraisal year, for the new-joiner rule (eligibility.js:
// a July appraisal covers people who joined by the 31 December before).
function eligibility(cycle, doj) {
  const e = eligibleForCycle(doj, appraisalYearOf(cycle.fiscal_year, cycle.created_at));
  // No joining date on the master is not a reason to leave somebody off
  // the grid: they were evaluated, and the master is the HRMS's to fix.
  return e.reason === 'joined_after_cutoff' ? false : true;
}

// The live placement of everybody in the cycle (or of the ids given).
async function computePlacements(t, cycle, { employeeIds = null, settings = null } = {}) {
  const s = settings || await settingsFor(t, cycle);
  const [{ rows, overrides }, prev] = await Promise.all([
    loadInputs(t, cycle, { employeeIds }), previousPlacements(t, cycle, employeeIds)]);
  const people = rows.map((r) => {
    const p = rules.place({
      performance: rules.performanceScore({ adjustment: r.adjustment, hod: r.hod, manager: r.manager }),
      competency: rules.competencyScore(r.competency_rows || [], { submitted: r.competency_status === 'submitted' }),
      questions: rules.questionsScore(s.questions, r.potential_answers || {}),
      eligible: eligibility(cycle, r.date_of_joining),
    }, s, rules.latestOverrides(overrides.get(r.employee_id) || []));
    const before = prev.get(r.employee_id);
    const prevKey = before && before.status === 'placed' ? before.box_key : null;
    return {
      employee_id: r.employee_id, name: r.name, email: r.email, emp_code: r.emp_code,
      department: r.department, location: r.location, designation: r.designation, grade: r.grade,
      manager_id: r.manager_id, manager_name: r.manager_name, super50: !!r.super50_flag,
      competency_status: r.competency_status || 'not_started',
      questions_answered: rules.questionsScore(s.questions, r.potential_answers || {}).answered,
      ...p,
      prev_cycle_id: before ? before.cycle_id : null, prev_cycle_name: before ? before.cycle_name : null,
      prev_box_key: prevKey, movement: rules.movement(prevKey, p.box_key),
    };
  });
  return { settings: s, people };
}

// Has this cycle's grid been published? Placements exist and the cycle is
// at publish or past it. A cycle rolled back to calibration is live again
// until it is published once more.
async function isPublished(t, cycle) {
  if (!['publish', 'closed'].includes(cycle.phase)) return false;
  return !!(await db.query(`SELECT 1 FROM pms.nine_box_placements WHERE tenant_id=$1 AND cycle_id=$2 LIMIT 1`,
    [t, cycle.id])).rows[0];
}

// Stored placements of a published cycle, in the live shape. Names,
// departments, managers and grades are read from the master as it is
// NOW, so a view is "my people today" and their box as it was published.
async function storedPlacements(t, cycleId) {
  const rows = (await db.query(
    `SELECT p.*, e.name, e.email, e.emp_code, e.department AS cur_department, e.location AS cur_location,
            e.designation, e.manager_id AS cur_manager_id, m.name AS manager_name, dg.grade AS cur_grade,
            pc.name AS prev_cycle_name
       FROM pms.nine_box_placements p
       JOIN core.employees e ON e.id = p.employee_id
       LEFT JOIN core.employees m ON m.id = e.manager_id
       LEFT JOIN pms.designation_grade dg ON dg.tenant_id = e.tenant_id AND dg.lower_designation = lower(btrim(e.designation))
       LEFT JOIN pms.cycles pc ON pc.id = p.prev_cycle_id
      WHERE p.tenant_id=$1 AND p.cycle_id=$2 ORDER BY e.name`, [t, cycleId])).rows;
  return rows.map((r) => ({
    employee_id: r.employee_id, name: r.name, email: r.email, emp_code: r.emp_code,
    department: r.cur_department, location: r.cur_location, designation: r.designation, grade: r.cur_grade,
    manager_id: r.cur_manager_id, manager_name: r.manager_name, super50: r.super50,
    performance_score: n(r.performance_score), performance_source: r.performance_source,
    competency_score: n(r.competency_score), questions_score: n(r.questions_score),
    potential_score: n(r.potential_score), potential_partial: r.potential_partial,
    computed_perf_band: r.computed_perf_band, computed_pot_band: r.computed_pot_band,
    perf_band: r.perf_band, pot_band: r.pot_band, overrides: r.overrides || {},
    status: r.status, not_placed_reason: r.not_placed_reason,
    not_placed_text: r.not_placed_reason ? rules.NOT_PLACED[r.not_placed_reason] || r.not_placed_reason : null,
    box_key: r.box_key, box_name: r.box_name, legacy_cell: r.legacy_cell,
    prev_cycle_id: r.prev_cycle_id, prev_cycle_name: r.prev_cycle_name, prev_box_key: r.prev_box_key, movement: r.movement,
    placed_at: r.placed_at, settings_snapshot: r.settings,
  }));
}

// A cycle's rows as every screen reads them.
async function cycleRows(t, cycle) {
  if (await isPublished(t, cycle)) {
    const people = await storedPlacements(t, cycle.id);
    const snap = people.find((p) => p.settings_snapshot);
    const settings = snap ? rules.normaliseSettings(snap.settings_snapshot) : await settingsFor(t, cycle);
    return { published: true, settings, people };
  }
  const live = await computePlacements(t, cycle);
  return { published: false, settings: live.settings, people: live.people };
}

// ------------------------------------------------------------------ scope

const VIEWS = { company: 'pms_admin', departments: 'pms_hod', team: 'pms_team_eval' };

// Who this caller may see in a view, as a filter over rows. Returns
// { error } with the permission named when the view is not theirs.
async function scopeFor(req, view) {
  const need = VIEWS[view];
  if (!need) return { status: 400, error: "view must be 'company', 'departments' or 'team'" };
  if (!(await hasPermission(req.user, need))) return { status: 403, error: `Requires '${need}'`, needs: need };
  const me = req.user.id;
  if (view === 'company') return { view, keep: (r) => r.employee_id !== me };
  if (view === 'team') return { view, keep: (r) => r.employee_id !== me && r.manager_id === me };
  // Departments: the ones this person heads. pms_admin heads them all.
  if (await hasPermission(req.user, 'pms_admin')) return { view, all: true, keep: (r) => r.employee_id !== me };
  const mine = (await db.query(
    `SELECT department FROM core.department_heads WHERE tenant_id=$1 AND employee_id=$2 ORDER BY department`,
    [T(req), me])).rows.map((r) => r.department);
  const set = new Set(mine);
  return {
    view, departments: mine,
    note: mine.length ? null : 'You are not set up as the head of any department, so there is nobody to show. HR sets department heads under Employees.',
    keep: (r) => r.employee_id !== me && set.has(r.department),
  };
}

const FILTERS = ['department', 'location', 'manager_id', 'grade'];
const NONE = '(not recorded)';

function filterOptions(rows) {
  const uniq = (f) => [...new Set(rows.map((r) => r[f] || NONE))].sort();
  const managers = new Map();
  for (const r of rows) if (r.manager_id) managers.set(r.manager_id, r.manager_name || 'Unknown');
  return {
    departments: uniq('department'), locations: uniq('location'), grades: uniq('grade'),
    managers: [...managers].map(([id, name]) => ({ manager_id: id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function applyFilters(rows, q) {
  const want = {};
  for (const f of FILTERS) if (q[f]) want[f] = String(q[f]);
  const out = rows.filter((r) => Object.entries(want).every(([f, v]) => (r[f] || NONE) === v));
  return { rows: out, applied: want };
}

// The cycle a view asks for: ?cycle_id (any annual cycle, closed ones
// too, so history stays readable), else the live annual cycle, else the
// latest annual cycle that was published.
async function cycleFor(req) {
  const t = T(req);
  const id = String(req.query.cycle_id || '').trim();
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, error: 'cycle_id is not valid' };
    const c = (await db.query(`SELECT * FROM pms.cycles WHERE tenant_id=$1 AND id=$2`, [t, id])).rows[0];
    if (!c) return { status: 404, error: 'cycle not found' };
    if (c.cycle_type !== 'annual') return { status: 409, error: 'The 9-box is placed on annual cycles only.' };
    return { cycle: c };
  }
  const live = await activeCycle(t, 'annual');
  if (live) return { cycle: live };
  const last = (await db.query(
    `SELECT c.* FROM pms.cycles c WHERE c.tenant_id=$1 AND c.cycle_type='annual'
        AND EXISTS (SELECT 1 FROM pms.nine_box_placements p WHERE p.cycle_id=c.id)
      ORDER BY c.created_at DESC LIMIT 1`, [t])).rows[0];
  if (last) return { cycle: last };
  return { status: 409, error: 'There is no annual cycle yet, so there is no 9-box to show.' };
}

async function annualCycles(t) {
  return (await db.query(
    `SELECT c.id, c.name, c.phase, c.fiscal_year,
            EXISTS (SELECT 1 FROM pms.nine_box_placements p WHERE p.cycle_id=c.id)
              AND c.phase IN ('publish','closed') AS published
       FROM pms.cycles c WHERE c.tenant_id=$1 AND c.cycle_type='annual' AND c.phase <> 'cancelled'
      ORDER BY c.created_at DESC`, [t])).rows;
}

// Everything a view needs: cycle, settings, the scoped and filtered rows.
// Rows are cut to an HRBP's remit BEFORE anything is counted.
async function viewData(req) {
  const view = String(req.query.view || '');
  const scope = await scopeFor(req, view);
  if (scope.error) return scope;
  const cf = await cycleFor(req);
  if (cf.error) return cf;
  const t = T(req);
  const { published, settings, people } = await cycleRows(t, cf.cycle);
  const scoped = visibleRows(req, people.filter(scope.keep), 'employee_id');
  const { rows, applied } = applyFilters(scoped, req.query);
  return { view, scope, cycle: cf.cycle, published, settings, scoped, rows, applied };
}

// One person, as a screen shows them. HR's company view carries the
// Super 50 flag and the override reasons; a manager's or Delivery Head's
// view says a band was overridden but not the room's reasoning.
function personOut(r, view) {
  const hr = view === 'company';
  const ov = r.overrides || {};
  const said = (o) => (o ? (hr ? { band: o.band, reason: o.reason, by: o.by, at: o.at } : { band: o.band }) : null);
  return {
    employee_id: r.employee_id, name: r.name, emp_code: r.emp_code, department: r.department, location: r.location,
    designation: r.designation, grade: r.grade, manager_id: r.manager_id, manager_name: r.manager_name,
    performance_score: r.performance_score, performance_source: r.performance_source,
    competency_score: r.competency_score, questions_score: r.questions_score,
    potential_score: r.potential_score, potential_partial: r.potential_partial,
    computed_perf_band: r.computed_perf_band, computed_pot_band: r.computed_pot_band,
    perf_band: r.perf_band, pot_band: r.pot_band,
    overridden: { performance: said(ov.performance), potential: said(ov.potential) },
    status: r.status, not_placed_reason: r.not_placed_reason, not_placed_text: r.not_placed_text,
    box_key: r.box_key, box_name: r.box_name,
    prev_box_key: r.prev_box_key, prev_cycle_name: r.prev_cycle_name || null, movement: r.movement,
    ...(hr ? { super50: !!r.super50 } : {}),
  };
}

function grid(rows, settings, view) {
  const placed = rows.filter((r) => r.status === 'placed');
  const boxes = {};
  for (const k of rules.BOX_KEYS) {
    const people = placed.filter((r) => r.box_key === k).map((r) => personOut(r, view));
    boxes[k] = {
      key: k, name: settings.boxes[k].name, action: settings.boxes[k].action, meaning: settings.boxes[k].meaning,
      count: people.length, pct: placed.length ? Math.round((people.length / placed.length) * 1000) / 10 : 0, people,
    };
  }
  const notPlaced = rows.filter((r) => r.status !== 'placed').map((r) => personOut(r, view));
  return { boxes, not_placed: { count: notPlaced.length, people: notPlaced },
    totals: { in_view: rows.length, placed: placed.length, not_placed: notPlaced.length } };
}

// ------------------------------------------------------------------ reports

async function previousCycleWithPlacements(t, cycle) {
  return (await db.query(
    `SELECT c.* FROM pms.cycles c WHERE c.tenant_id=$1 AND c.cycle_type='annual' AND c.created_at < $2
        AND EXISTS (SELECT 1 FROM pms.nine_box_placements p WHERE p.cycle_id=c.id)
      ORDER BY c.created_at DESC LIMIT 1`, [t, cycle.created_at])).rows[0] || null;
}

async function reportsFor(req, d) {
  const t = T(req);
  const placed = d.rows.filter((r) => r.status === 'placed');
  // Grid by department.
  const byDept = new Map();
  for (const r of d.rows) {
    const k = r.department || NONE;
    if (!byDept.has(k)) byDept.set(k, { department: k, boxes: Object.fromEntries(rules.BOX_KEYS.map((b) => [b, 0])), not_placed: 0, total: 0 });
    const g = byDept.get(k);
    g.total += 1;
    if (r.status === 'placed') g.boxes[r.box_key] += 1; else g.not_placed += 1;
  }
  // Distribution against the previous annual cycle, over the same view
  // and filters, so "this year vs last" compares like with like.
  const prevCycle = await previousCycleWithPlacements(t, d.cycle);
  let previous = null;
  if (prevCycle) {
    const prevRows = applyFilters(visibleRows(req, (await storedPlacements(t, prevCycle.id)).filter(d.scope.keep), 'employee_id'), req.query).rows;
    const pp = prevRows.filter((r) => r.status === 'placed');
    previous = {
      cycle: { id: prevCycle.id, name: prevCycle.name },
      placed: pp.length,
      boxes: Object.fromEntries(rules.BOX_KEYS.map((k) => {
        const c = pp.filter((r) => r.box_key === k).length;
        return [k, { count: c, pct: pp.length ? Math.round((c / pp.length) * 1000) / 10 : 0 }];
      })),
    };
  }
  const current = Object.fromEntries(rules.BOX_KEYS.map((k) => {
    const c = placed.filter((r) => r.box_key === k).length;
    return [k, { count: c, pct: placed.length ? Math.round((c / placed.length) * 1000) / 10 : 0 }];
  }));
  const distribution = rules.BOX_KEYS.map((k) => ({
    key: k, name: d.settings.boxes[k].name,
    count: current[k].count, pct: current[k].pct,
    prev_count: previous ? previous.boxes[k].count : null, prev_pct: previous ? previous.boxes[k].pct : null,
    delta: previous ? current[k].count - previous.boxes[k].count : null,
  }));
  // Succession: (2,2) ready now; (1,2) and (2,1) ready in 1–2 years.
  const succ = new Map();
  for (const r of placed) {
    const ready = r.box_key === '2,2' ? 'ready_now' : (r.box_key === '1,2' || r.box_key === '2,1') ? 'ready_1_2_years' : null;
    if (!ready) continue;
    const k = r.department || NONE;
    if (!succ.has(k)) succ.set(k, { department: k, ready_now: [], ready_1_2_years: [] });
    succ.get(k)[ready].push(personOut(r, d.view));
  }
  return {
    by_department: [...byDept.values()].sort((a, b) => a.department.localeCompare(b.department)),
    distribution, previous_cycle: previous ? previous.cycle : null, previous_placed: previous ? previous.placed : null,
    succession: [...succ.values()].sort((a, b) => a.department.localeCompare(b.department)),
  };
}

// Each person's box over the last three annual cycles, oldest first.
async function movementFor(req, d) {
  const t = T(req);
  const earlier = (await db.query(
    `SELECT c.* FROM pms.cycles c WHERE c.tenant_id=$1 AND c.cycle_type='annual' AND c.created_at < $2
        AND EXISTS (SELECT 1 FROM pms.nine_box_placements p WHERE p.cycle_id=c.id)
      ORDER BY c.created_at DESC LIMIT 2`, [t, d.cycle.created_at])).rows.reverse();
  const history = [];
  for (const c of earlier) {
    const rows = await storedPlacements(t, c.id);
    history.push({ cycle: c, by: new Map(rows.map((r) => [r.employee_id, r])) });
  }
  const cycles = [...earlier.map((c) => ({ id: c.id, name: c.name })), { id: d.cycle.id, name: d.cycle.name, current: true, published: d.published }];
  const counts = { up: 0, down: 0, same: 0, across: 0, new: 0 };
  const people = d.rows.map((r) => {
    const boxes = [...history.map((h) => {
      const p = h.by.get(r.employee_id);
      return p ? { box_key: p.box_key, box_name: p.box_name, status: p.status } : null;
    }), { box_key: r.box_key, box_name: r.box_name, status: r.status }];
    const steps = [];
    for (let i = 1; i < boxes.length; i += 1) {
      const a = boxes[i - 1]; const b = boxes[i];
      steps.push(a && b && a.box_key && b.box_key ? rules.movement(a.box_key, b.box_key) : null);
    }
    const last = steps[steps.length - 1];
    if (last && counts[last] !== undefined) counts[last] += 1;
    else if (!last && r.box_key) counts.new += 1;
    return { employee_id: r.employee_id, name: r.name, department: r.department, manager_name: r.manager_name,
      boxes, steps, current_movement: last || (r.box_key ? 'new' : null),
      ...(d.view === 'company' ? { super50: !!r.super50 } : {}) };
  });
  return { cycles, people, counts };
}

// ------------------------------------------------------------------ router

const router = express.Router();
guardUuidParams(router);

const refuse = (res, s) => res.status(s.status).json({ error: s.error, ...(s.needs ? { needs: s.needs } : {}) });

router.get('/', async (req, res) => {
  try {
    const d = await viewData(req);
    if (d.error) return refuse(res, d);
    res.json({
      cycle: { id: d.cycle.id, name: d.cycle.name, phase: d.cycle.phase, fiscal_year: d.cycle.fiscal_year },
      cycles: await annualCycles(T(req)),
      view: d.view, status: d.published ? 'published' : 'provisional',
      settings: publicSettings(d.settings),
      filters: filterOptions(d.scoped), applied: d.applied,
      note: d.scope.note || null,
      ...grid(d.rows, d.settings, d.view),
    });
  } catch (e) { logger.error('nine-box grid', { error: e.message }); res.status(500).json({ error: 'Could not load the 9-box.' }); }
});

router.get('/movement', async (req, res) => {
  try {
    const d = await viewData(req);
    if (d.error) return refuse(res, d);
    res.json({ cycle: { id: d.cycle.id, name: d.cycle.name }, view: d.view, ...(await movementFor(req, d)) });
  } catch (e) { logger.error('nine-box movement', { error: e.message }); res.status(500).json({ error: 'Could not load the movement view.' }); }
});

router.get('/reports', async (req, res) => {
  try {
    const d = await viewData(req);
    if (d.error) return refuse(res, d);
    res.json({ cycle: { id: d.cycle.id, name: d.cycle.name }, view: d.view,
      status: d.published ? 'published' : 'provisional', settings: publicSettings(d.settings),
      ...(await reportsFor(req, d)) });
  } catch (e) { logger.error('nine-box reports', { error: e.message }); res.status(500).json({ error: 'Could not load the 9-box reports.' }); }
});

const bandWord = (b) => (b == null ? '' : rules.BAND_NAMES[b]);
const MOVE_WORD = { up: 'Up', down: 'Down', same: 'Same', across: 'Across', new: 'First placement' };

router.get('/export.xlsx', async (req, res) => {
  try {
    const d = await viewData(req);
    if (d.error) return refuse(res, d);
    const hr = d.view === 'company';
    const wb = new ExcelJS.Workbook();
    const head = (ws) => { ws.getRow(1).font = { bold: true }; ws.views = [{ state: 'frozen', ySplit: 1 }]; };

    const ws = wb.addWorksheet('Placements');
    ws.columns = [
      { header: 'Emp code', key: 'emp_code', width: 12 }, { header: 'Name', key: 'name', width: 26 },
      { header: 'Department', key: 'department', width: 20 }, { header: 'Location', key: 'location', width: 14 },
      { header: 'Grade', key: 'grade', width: 8 }, { header: 'Manager', key: 'manager_name', width: 22 },
      { header: 'Box', key: 'box', width: 8 }, { header: 'Box name', key: 'box_name', width: 20 },
      { header: 'Performance score', key: 'performance_score', width: 12 }, { header: 'Performance band', key: 'perf', width: 12 },
      { header: 'Competency score', key: 'competency_score', width: 12 }, { header: 'Questions score', key: 'questions_score', width: 12 },
      { header: 'Potential score', key: 'potential_score', width: 12 }, { header: 'Potential band', key: 'pot', width: 12 },
      { header: 'Potential from', key: 'partial', width: 18 },
      { header: 'Overridden', key: 'overridden', width: 40 },
      { header: 'Previous box', key: 'prev', width: 12 }, { header: 'Movement', key: 'movement', width: 14 },
      { header: 'Not placed because', key: 'why', width: 40 },
      ...(hr ? [{ header: 'Super 50', key: 'super50', width: 9 }] : []),
    ];
    head(ws);
    for (const r of d.rows) {
      const p = personOut(r, d.view);
      const ov = ['performance', 'potential'].map((a) => (p.overridden[a]
        ? `${a}: ${bandWord(p.overridden[a].band)}${p.overridden[a].reason ? ` — ${p.overridden[a].reason}` : ''}` : null)).filter(Boolean).join(' | ');
      ws.addRow({
        ...p, box: p.box_key ? `(${p.box_key})` : 'Not placed', box_name: p.box_name || '',
        perf: bandWord(p.perf_band), pot: bandWord(p.pot_band),
        partial: p.potential_score == null ? '' : (p.potential_partial ? 'one half only' : 'both halves'),
        overridden: ov, prev: p.prev_box_key ? `(${p.prev_box_key})` : '', movement: MOVE_WORD[p.movement] || '',
        why: p.not_placed_text || '', super50: p.super50 ? 'yes' : '',
        grade: p.grade || NONE, location: p.location || NONE,
      });
    }

    const rep = await reportsFor(req, d);
    const bd = wb.addWorksheet('By department');
    bd.columns = [{ header: 'Department', key: 'department', width: 24 },
      ...rules.BOX_KEYS.map((k) => ({ header: `${d.settings.boxes[k].name} (${k})`, key: k, width: 14 })),
      { header: 'Not placed', key: 'not_placed', width: 11 }, { header: 'Total', key: 'total', width: 8 }];
    head(bd);
    for (const g of rep.by_department) bd.addRow({ department: g.department, ...g.boxes, not_placed: g.not_placed, total: g.total });

    const ds = wb.addWorksheet('Distribution');
    ds.columns = [{ header: 'Box', key: 'key', width: 8 }, { header: 'Name', key: 'name', width: 22 },
      { header: 'This cycle', key: 'count', width: 11 }, { header: '% of placed', key: 'pct', width: 11 },
      { header: rep.previous_cycle ? `Previous (${rep.previous_cycle.name})` : 'Previous cycle', key: 'prev_count', width: 22 },
      { header: 'Previous %', key: 'prev_pct', width: 11 }, { header: 'Change', key: 'delta', width: 9 }];
    head(ds);
    for (const r of rep.distribution) {
      ds.addRow({ ...r, key: `(${r.key})`, prev_count: r.prev_count ?? 'no earlier cycle', prev_pct: r.prev_pct ?? '', delta: r.delta ?? '' });
    }

    const ss = wb.addWorksheet('Succession pool');
    ss.columns = [{ header: 'Department', key: 'department', width: 24 }, { header: 'Readiness', key: 'ready', width: 18 },
      { header: 'Name', key: 'name', width: 26 }, { header: 'Box', key: 'box', width: 20 },
      { header: 'Performance', key: 'performance_score', width: 12 }, { header: 'Potential', key: 'potential_score', width: 12 },
      ...(hr ? [{ header: 'Super 50', key: 'super50', width: 9 }] : [])];
    head(ss);
    for (const g of rep.succession) {
      for (const p of g.ready_now) ss.addRow({ ...p, department: g.department, ready: 'Ready now', box: `${p.box_name} (${p.box_key})`, super50: p.super50 ? 'yes' : '' });
      for (const p of g.ready_1_2_years) ss.addRow({ ...p, department: g.department, ready: 'Ready in 1–2 years', box: `${p.box_name} (${p.box_key})`, super50: p.super50 ? 'yes' : '' });
    }

    const mv = await movementFor(req, d);
    const ms = wb.addWorksheet('Movement');
    ms.columns = [{ header: 'Name', key: 'name', width: 26 }, { header: 'Department', key: 'department', width: 20 },
      ...mv.cycles.map((c, i) => ({ header: c.name, key: `c${i}`, width: 22 })),
      { header: 'Latest move', key: 'move', width: 16 }];
    head(ms);
    for (const p of mv.people) {
      const row = { name: p.name, department: p.department, move: MOVE_WORD[p.current_movement] || '' };
      p.boxes.forEach((b, i) => { row[`c${i}`] = b ? (b.box_key ? `${b.box_name} (${b.box_key})` : 'Not placed') : '—'; });
      ms.addRow(row);
    }

    const ns = wb.addWorksheet('About');
    ns.columns = [{ header: 'Item', key: 'k', width: 24 }, { header: 'Value', key: 'v', width: 90 }];
    head(ns);
    ns.addRow({ k: 'Cycle', v: d.cycle.name });
    ns.addRow({ k: 'Status', v: d.published ? 'Published' : 'Provisional — worked out live, not yet published' });
    ns.addRow({ k: 'View', v: d.view });
    ns.addRow({ k: 'Bands', v: rules.bandText(d.settings) });
    ns.addRow({ k: 'Potential', v: `${d.settings.competency_weight}% competency score, ${100 - d.settings.competency_weight}% the manager's potential questions; one half alone when the other is missing` });
    ns.addRow({ k: 'Filters', v: Object.entries(d.applied).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="nine-box-${d.view}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { logger.error('nine-box export', { error: e.message }); res.status(500).json({ error: 'Could not build the 9-box export.' }); }
});

// -------- settings (HR)

async function settingsLock(t, cycle) {
  if (cycle.cycle_type !== 'annual') return 'The 9-box is placed on annual cycles only.';
  if (['closed', 'cancelled'].includes(cycle.phase)) return 'This cycle is closed.';
  if (await isPublished(t, cycle)) return 'This cycle\'s 9-box is published. Its settings are kept as they were when people were placed.';
  return null;
}

async function answeredKeys(t, cycleId) {
  const rows = (await db.query(
    `SELECT DISTINCT jsonb_object_keys(answers) AS k FROM pms.potential_answers WHERE tenant_id=$1 AND cycle_id=$2`,
    [t, cycleId])).rows;
  return rows.map((r) => r.k);
}

router.get('/settings', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
    const cf = await cycleFor(req);
    if (cf.error) return refuse(res, cf);
    const t = T(req);
    const s = await settingsFor(t, cf.cycle);
    const answered = await answeredKeys(t, cf.cycle.id);
    res.json({
      cycle: { id: cf.cycle.id, name: cf.cycle.name, phase: cf.cycle.phase },
      settings: publicSettings(s), stored: s.stored, inherited_from: s.inherited_from,
      updated_by: s.updated_by || null, updated_at: s.updated_at || null,
      locked: await settingsLock(t, cf.cycle), questions_answered: answered.length > 0,
      defaults: publicSettings(rules.normaliseSettings(null)),
    });
  } catch (e) { logger.error('nine-box settings', { error: e.message }); res.status(500).json({ error: 'Could not load the 9-box settings.' }); }
});

router.put('/settings/:cycleId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
    const t = T(req);
    const cycle = (await db.query(`SELECT * FROM pms.cycles WHERE tenant_id=$1 AND id=$2`, [t, req.params.cycleId])).rows[0];
    if (!cycle) return res.status(404).json({ error: 'cycle not found' });
    const lock = await settingsLock(t, cycle);
    if (lock) return res.status(409).json({ error: lock });
    const answered = await answeredKeys(t, cycle.id);
    const v = rules.validateSettings(req.body || {}, { lockedQuestionKeys: answered.length ? (await settingsFor(t, cycle)).questions.map((q) => q.key) : null });
    if (!v.ok) return res.status(422).json({ error: v.errors[0], errors: v.errors });
    const before = await computePlacements(t, cycle);
    const out = await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO pms.nine_box_settings (tenant_id, cycle_id, mid_from, high_from, competency_weight, boxes, questions, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (cycle_id) DO UPDATE SET mid_from=EXCLUDED.mid_from, high_from=EXCLUDED.high_from,
           competency_weight=EXCLUDED.competency_weight, boxes=EXCLUDED.boxes, questions=EXCLUDED.questions,
           updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [t, cycle.id, v.value.mid_from, v.value.high_from, v.value.competency_weight,
          JSON.stringify(v.value.boxes), JSON.stringify(v.value.questions), req.user.email]);
      const after = await computePlacements(t, cycle, { settings: rules.normaliseSettings(v.value) });
      const was = new Map(before.people.map((p) => [p.employee_id, p.box_key]));
      const moved = after.people.filter((p) => (was.get(p.employee_id) || null) !== (p.box_key || null)).length;
      const pick = (s) => ({ mid_from: s.mid_from, high_from: s.high_from, competency_weight: s.competency_weight,
        boxes: s.boxes, questions: s.questions });
      await auditTx(client, req, 'NINE_BOX_SETTINGS_UPDATED', cycle.id, null,
        { before: pick(before.settings), after: pick(v.value), moved });
      return { moved, placed: after.people.filter((p) => p.status === 'placed').length };
    });
    res.json({ ok: true, settings: publicSettings(rules.normaliseSettings(v.value)), moved: out.moved, placed: out.placed });
  } catch (e) { logger.error('nine-box settings save', { error: e.message }); res.status(500).json({ error: 'Could not save the 9-box settings.' }); }
});

// -------- HR override of one band, in calibration

router.post('/override', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'", needs: 'pms_admin' });
    const t = T(req);
    const c = await activeCycle(t);
    if (!c || !pm.phaseAllows(c.phase, 'top_talent')) return res.status(409).json({ error: 'Calibration is not open, so a band cannot be overridden.' });
    if (c.cycle_type !== 'annual') return res.status(409).json({ error: 'The 9-box is placed on annual cycles only.' });
    const b = req.body || {};
    const axis = String(b.axis || '');
    if (!rules.AXES.includes(axis)) return res.status(422).json({ error: "axis must be 'performance' or 'potential'" });
    const to = b.band === null || b.band === undefined || b.band === '' ? null : Number(b.band);
    if (to !== null && !(Number.isInteger(to) && to >= 0 && to <= 2)) return res.status(422).json({ error: 'band must be 0 (Low), 1 (Medium), 2 (High), or null to go back to the worked-out band' });
    const reason = String(b.reason || '').trim();
    if (!reason) return res.status(422).json({ error: 'A reason is required. It is kept with the override and shown in the audit trail.' });
    if (reason.length > 500) return res.status(422).json({ error: 'The reason is longer than 500 characters.' });
    const id = String(b.employee_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(422).json({ error: 'employee_id is required' });
    const cur = (await computePlacements(t, c, { employeeIds: [id] })).people[0];
    if (!cur) return res.status(404).json({ error: 'That person is not in this cycle\'s calibration (no submitted manager evaluation).' });
    const key = axis === 'performance' ? 'perf_band' : 'pot_band';
    const active = cur.overrides[axis];
    if (to === null && !active) return res.status(409).json({ error: `There is no ${axis} override to take back.` });
    if (to !== null && to === cur[key]) return res.status(409).json({ error: `${cur.name} is already ${rules.BAND_NAMES[to]} on ${axis}.` });
    await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO pms.nine_box_overrides (tenant_id, cycle_id, employee_id, axis, from_band, to_band, reason, overridden_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [t, c.id, id, axis, cur[key], to, reason, req.user.email]);
      await auditTx(client, req, 'NINE_BOX_OVERRIDDEN', c.id, id, {
        axis, from: cur[key], to: to === null ? (axis === 'performance' ? cur.computed_perf_band : cur.computed_pot_band) : to,
        reverted: to === null, reason, box_before: cur.box_key,
      });
    });
    const now = (await computePlacements(t, c, { employeeIds: [id] })).people[0];
    res.json({ ok: true, placement: personOut(now, 'company') });
  } catch (e) { logger.error('nine-box override', { error: e.message }); res.status(500).json({ error: 'Could not save the override.' }); }
});

// -------- actions created at publish

router.get('/actions', async (req, res) => {
  try {
    const d = await viewData(req);
    if (d.error) return refuse(res, d);
    const ids = d.rows.map((r) => r.employee_id);
    const rows = ids.length ? (await db.query(
      `SELECT a.id, a.employee_id, e.name, e.department, a.box_key, a.action_key, a.kind, a.title,
              a.assignee_id, asg.name AS assignee_name, to_char(a.due_date,'YYYY-MM-DD') AS due_date,
              a.status, a.pip_id, a.created_at, a.closed_by, a.closed_at, a.close_note
         FROM pms.nine_box_actions a
         JOIN core.employees e ON e.id = a.employee_id
         LEFT JOIN core.employees asg ON asg.id = a.assignee_id
        WHERE a.tenant_id=$1 AND a.cycle_id=$2 AND a.employee_id = ANY($3::uuid[])
        ORDER BY (a.status='open') DESC, a.due_date NULLS LAST, e.name`, [T(req), d.cycle.id, ids])).rows : [];
    const named = new Map(Object.entries(d.settings.boxes).map(([k, v]) => [k, v.name]));
    res.json({ cycle: { id: d.cycle.id, name: d.cycle.name }, view: d.view,
      actions: rows.map((a) => ({ ...a, box_name: a.box_key ? named.get(a.box_key) : null })),
      open: rows.filter((a) => a.status === 'open').length });
  } catch (e) { logger.error('nine-box actions', { error: e.message }); res.status(500).json({ error: 'Could not load the 9-box actions.' }); }
});

// Closing an action: the person it is assigned to (the manager), the
// employee's current manager, or HR. A note says what was done.
router.put('/actions/:id', async (req, res) => {
  try {
    const t = T(req);
    const a = (await db.query(
      `SELECT a.*, e.manager_id FROM pms.nine_box_actions a JOIN core.employees e ON e.id=a.employee_id
        WHERE a.tenant_id=$1 AND a.id=$2`, [t, req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'action not found' });
    const admin = await hasPermission(req.user, 'pms_admin');
    const mine = a.assignee_id === req.user.id || a.manager_id === req.user.id;
    if (!admin && !(mine && await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: 'Not an action for you to close.' });
    if (a.employee_id === req.user.id && !admin) return res.status(403).json({ error: 'Not an action for you to close.' });
    const b = req.body || {};
    const status = String(b.status || '');
    if (!['done', 'open'].includes(status)) return res.status(422).json({ error: "status must be 'done' or 'open'" });
    if (a.status === 'superseded') return res.status(409).json({ error: 'This action was replaced when the person moved box at a later publish.' });
    const note = String(b.note || '').trim();
    if (status === 'done' && !note) return res.status(422).json({ error: 'Say what was done — a short note is kept with the action.' });
    if (note.length > 1000) return res.status(422).json({ error: 'The note is longer than 1,000 characters.' });
    await inTransaction(async (client) => {
      await client.query(
        `UPDATE pms.nine_box_actions SET status=$2,
                closed_by = CASE WHEN $2='done' THEN $3 ELSE NULL END,
                closed_at = CASE WHEN $2='done' THEN now() ELSE NULL END,
                close_note = CASE WHEN $2='done' THEN $4 ELSE close_note END
          WHERE id=$1`, [a.id, status, req.user.email, note || null]);
      await auditTx(client, req, status === 'done' ? 'NINE_BOX_ACTION_DONE' : 'NINE_BOX_ACTION_REOPENED',
        a.cycle_id, a.employee_id, { action_id: a.id, action_key: a.action_key, title: a.title, note: note || null });
    });
    res.json({ ok: true });
  } catch (e) { logger.error('nine-box action close', { error: e.message }); res.status(500).json({ error: 'Could not update the action.' }); }
});

// ------------------------------------------------------------------ the manager's potential step

// Mounted on /team/evaluations: the Potential step of Team Evaluation.
const teamRouter = express.Router();
guardUuidParams(teamRouter);

async function potentialTarget(req) {
  if (!(await hasPermission(req.user, 'pms_team_eval'))) return { status: 403, error: "Requires 'pms_team_eval'", needs: 'pms_team_eval' };
  const t = T(req);
  const emp = (await db.query(`SELECT id, name, manager_id FROM core.employees WHERE id=$1 AND tenant_id=$2`,
    [req.params.employeeId, t])).rows[0];
  if (!emp) return { status: 404, error: 'employee not found' };
  if (emp.manager_id !== req.user.id && !(await hasPermission(req.user, 'pms_admin'))) return { status: 403, error: 'Not your report' };
  const c = await activeCycle(t);
  return { emp, cycle: c };
}

async function potentialView(t, cycle, emp) {
  const s = await settingsFor(t, cycle);
  const ans = (await db.query(`SELECT answers, updated_at FROM pms.potential_answers WHERE cycle_id=$1 AND employee_id=$2`,
    [cycle.id, emp.id])).rows[0];
  const a = (await db.query(
    `SELECT ca.manager_status,
            COALESCE((SELECT json_agg(json_build_object('manager_rating', cr.manager_rating))
                        FROM pms.competency_ratings cr WHERE cr.assessment_id=ca.id), '[]'::json) AS rows
       FROM pms.competency_assessments ca WHERE ca.tenant_id=$1 AND ca.cycle_id=$2 AND ca.employee_id=$3`,
    [t, cycle.id, emp.id])).rows[0];
  const answers = (ans && ans.answers) || {};
  const comp = rules.competencyScore(a ? a.rows : [], { submitted: !!a && a.manager_status === 'submitted' });
  const q = rules.questionsScore(s.questions, answers);
  const pot = rules.potentialScore(comp.score, q.score, s.competency_weight);
  const band = rules.band(pot.score, s);
  return {
    applies: true,
    cycle: { id: cycle.id, name: cycle.name, phase: cycle.phase },
    employee: { id: emp.id, name: emp.name },
    editable: pm.phaseAllows(cycle.phase, 'manager_edit'),
    questions: s.questions, answers, updated_at: ans ? ans.updated_at : null,
    questions_score: q,
    competency: { ...comp, status: a ? a.manager_status : 'not_started' },
    potential: { ...pot, band, band_name: band == null ? null : rules.BAND_NAMES[band] },
    weights: { competency: s.competency_weight, questions: 100 - s.competency_weight },
    band_text: rules.bandText(s),
  };
}

teamRouter.get('/:employeeId/potential', async (req, res) => {
  try {
    const g = await potentialTarget(req);
    if (g.error) return refuse(res, g);
    if (!g.cycle) return res.json({ applies: false, reason: 'No cycle is open.' });
    if (g.cycle.cycle_type !== 'annual') return res.json({ applies: false, reason: 'The Potential step is part of the annual review, where the 9-box is placed.' });
    res.json(await potentialView(T(req), g.cycle, g.emp));
  } catch (e) { logger.error('potential read', { error: e.message }); res.status(500).json({ error: 'Could not load the potential questions.' }); }
});

teamRouter.put('/:employeeId/potential', async (req, res) => {
  try {
    const g = await potentialTarget(req);
    if (g.error) return refuse(res, g);
    const c = g.cycle;
    if (!c || !pm.phaseAllows(c.phase, 'manager_edit')) return res.status(409).json({ error: `Manager evaluation is not open (phase: ${c ? c.phase : 'none'})` });
    if (c.cycle_type !== 'annual') return res.status(409).json({ error: 'The Potential step is part of the annual review.' });
    const t = T(req);
    const s = await settingsFor(t, c);
    const keys = new Set(s.questions.map((q) => q.key));
    const given = (req.body || {}).answers;
    if (!given || typeof given !== 'object' || Array.isArray(given)) return res.status(422).json({ error: 'answers is required, e.g. {"learning_agility": 4}' });
    const bad = [];
    const clean = {};
    for (const [k, v] of Object.entries(given)) {
      if (!keys.has(k)) { bad.push(`${k}: not one of this cycle's questions`); continue; }
      if (v === null || v === '') { clean[k] = null; continue; }
      const nv = Number(v);
      if (!Number.isInteger(nv) || nv < 1 || nv > 5) { bad.push(`${k}: must be a whole number from 1 to 5`); continue; }
      clean[k] = nv;
    }
    if (bad.length) return res.status(422).json({ error: bad[0], errors: bad });
    await inTransaction(async (client) => {
      const cur = ((await client.query(`SELECT answers FROM pms.potential_answers WHERE cycle_id=$1 AND employee_id=$2 FOR UPDATE`,
        [c.id, g.emp.id])).rows[0] || {}).answers || {};
      const next = { ...cur };
      for (const [k, v] of Object.entries(clean)) { if (v === null) delete next[k]; else next[k] = v; }
      await client.query(
        `INSERT INTO pms.potential_answers (tenant_id, cycle_id, employee_id, answers, rated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (cycle_id, employee_id) DO UPDATE SET answers=EXCLUDED.answers, rated_by=EXCLUDED.rated_by, updated_at=now()`,
        [t, c.id, g.emp.id, JSON.stringify(next), req.user.id]);
      await auditTx(client, req, 'POTENTIAL_ANSWERED', c.id, g.emp.id, { before: cur, after: next });
    });
    res.json({ ok: true, ...(await potentialView(t, c, g.emp)) });
  } catch (e) { logger.error('potential save', { error: e.message }); res.status(500).json({ error: 'Could not save the potential answers.' }); }
});

// ------------------------------------------------------------------ publish

async function hrRecipients(t) {
  return (await db.query(
    `SELECT DISTINCT e.id FROM core.employees e JOIN core.user_roles ur ON ur.tenant_id=e.tenant_id AND LOWER(ur.email)=LOWER(e.email)
      WHERE e.tenant_id=$1 AND e.status='active' AND ur.role IN ('hr','admin')`, [t])).rows.map((r) => r.id);
}

const quietly = (p) => p.catch((e) => logger.warn('nine-box notify failed', { error: e.message }));

// Called by POST /publish for an annual cycle, after the ratings are
// written and Super 50 recomputed. `ids` are the people whose rating was
// published; `wasFlagged` is each person's Super 50 flag BEFORE this
// publish recomputed it (a Super 50 employee who leaves (2,2) is
// alerted even if this same publish unflags them).
async function publishPlacements(req, cycle, { ids, wasFlagged = new Map() }) {
  const t = T(req);
  const out = { placed: 0, not_placed: 0, by_box: Object.fromEntries(rules.BOX_KEYS.map((k) => [k, 0])),
    not_placed_by_reason: {}, actions_created: 0, actions_superseded: 0, succession_added: 0,
    retention_alerts: 0, escalations: 0, pips_opened: 0, failures: [] };
  if (!ids.length) return out;
  const { settings, people } = await computePlacements(t, cycle, { employeeIds: ids });
  const snapshot = { mid_from: settings.mid_from, high_from: settings.high_from, competency_weight: settings.competency_weight,
    boxes: settings.boxes, questions: settings.questions };
  const by = `system:publish (${req.user.email})`;
  const later = { pips: [], retention: [], escalation: [], managers: new Map() };

  for (const p of people) {
    try {
      const done = await inTransaction(async (client) => {
        const r = { pip: null, retention: false, escalated: false, created: 0 };
        await client.query(
          `INSERT INTO pms.nine_box_placements (tenant_id, cycle_id, employee_id, status, not_placed_reason,
             performance_score, performance_source, competency_score, questions_score, potential_score, potential_partial,
             computed_perf_band, computed_pot_band, perf_band, pot_band, overrides, box_key, box_name, legacy_cell,
             department, location, manager_id, grade, prev_cycle_id, prev_box_key, movement, super50, settings, placed_by, placed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,now())
           ON CONFLICT (cycle_id, employee_id) DO UPDATE SET status=EXCLUDED.status, not_placed_reason=EXCLUDED.not_placed_reason,
             performance_score=EXCLUDED.performance_score, performance_source=EXCLUDED.performance_source,
             competency_score=EXCLUDED.competency_score, questions_score=EXCLUDED.questions_score,
             potential_score=EXCLUDED.potential_score, potential_partial=EXCLUDED.potential_partial,
             computed_perf_band=EXCLUDED.computed_perf_band, computed_pot_band=EXCLUDED.computed_pot_band,
             perf_band=EXCLUDED.perf_band, pot_band=EXCLUDED.pot_band, overrides=EXCLUDED.overrides,
             box_key=EXCLUDED.box_key, box_name=EXCLUDED.box_name, legacy_cell=EXCLUDED.legacy_cell,
             department=EXCLUDED.department, location=EXCLUDED.location, manager_id=EXCLUDED.manager_id, grade=EXCLUDED.grade,
             prev_cycle_id=EXCLUDED.prev_cycle_id, prev_box_key=EXCLUDED.prev_box_key, movement=EXCLUDED.movement,
             super50=EXCLUDED.super50, settings=EXCLUDED.settings, placed_by=EXCLUDED.placed_by, placed_at=now()`,
          [t, cycle.id, p.employee_id, p.status, p.not_placed_reason,
            p.performance_score, p.performance_source, p.competency_score, p.questions_score, p.potential_score, !!p.potential_partial,
            p.computed_perf_band, p.computed_pot_band, p.perf_band, p.pot_band, JSON.stringify(p.overrides || {}),
            p.box_key, p.box_name, p.legacy_cell,
            p.department, p.location, p.manager_id, p.grade, p.prev_cycle_id, p.prev_box_key, p.movement,
            !!p.super50, JSON.stringify(snapshot), by]);
        await auditTx(client, req, p.status === 'placed' ? 'NINE_BOX_PLACED' : 'NINE_BOX_NOT_PLACED', cycle.id, p.employee_id, {
          box: p.box_key, box_name: p.box_name, reason: p.not_placed_reason,
          performance: { score: p.performance_score, source: p.performance_source, band: p.perf_band, computed: p.computed_perf_band },
          potential: { score: p.potential_score, competency: p.competency_score, questions: p.questions_score,
            partial: !!p.potential_partial, band: p.pot_band, computed: p.computed_pot_band },
          overrides: p.overrides, previous_box: p.prev_box_key, movement: p.movement,
          limits: { mid_from: settings.mid_from, high_from: settings.high_from, competency_weight: settings.competency_weight },
        });
        // The HRMS write-back keeps its old shape ('high-mid'), and a
        // person not placed this cycle has no box — never last year's.
        await client.query(`UPDATE core.employees SET nine_box_cell=$2, potential_rating=$3, updated_at=now() WHERE id=$1`,
          [p.employee_id, p.legacy_cell, p.pot_band == null ? null : rules.LEGACY[p.pot_band]]);

        // A re-publish that moved somebody: the old box's open action is
        // replaced by the new one, and says so.
        const sup = await client.query(
          `UPDATE pms.nine_box_actions SET status='superseded', closed_by=$4, closed_at=now(),
                  close_note='Replaced: the person was placed in a different box when the cycle was published again.'
            WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3 AND status='open'
              AND action_key LIKE 'box:%' AND action_key <> $5 RETURNING id, action_key`,
          [t, cycle.id, p.employee_id, by, p.box_key ? `box:${p.box_key}` : '']);
        for (const s of sup.rows) {
          await auditTx(client, req, 'NINE_BOX_ACTION_SUPERSEDED', cycle.id, p.employee_id, { action_id: s.id, action_key: s.action_key, now_box: p.box_key });
        }
        r.superseded = sup.rows.length;

        // The PIP: (0,0), and anybody below the Low limit who could not
        // be placed (the client's answer to open question 2). Never
        // re-opened or duplicated by a second publish.
        const pipDue = p.box_key === '0,0' || (p.status !== 'placed' && p.perf_band === 0);
        if (pipDue) {
          const pip = await client.query(
            `INSERT INTO pms.pip_records (tenant_id, employee_id, cycle_id, status, opened_by)
             VALUES ($1,$2,$3,'open',$4) ON CONFLICT (tenant_id, employee_id, cycle_id) DO NOTHING RETURNING id`,
            [t, p.employee_id, cycle.id, by]);
          if (pip.rows[0]) {
            r.pip = pip.rows[0].id;
            await auditTx(client, req, 'PIP_AUTO_OPENED', cycle.id, p.employee_id, {
              final_rating: p.performance_score, rule: p.box_key === '0,0' ? 'nine_box_underperformer' : 'below_low_limit_not_placed',
              box: p.box_key, not_placed_reason: p.not_placed_reason, low_limit: settings.mid_from });
          }
        }

        if (p.status === 'placed') {
          const act = rules.actionFor(p.box_key, settings);
          const pipId = r.pip || (p.box_key === '0,0' ? ((await client.query(
            `SELECT id FROM pms.pip_records WHERE tenant_id=$1 AND employee_id=$2 AND cycle_id=$3`, [t, p.employee_id, cycle.id])).rows[0] || {}).id || null : null);
          const ins = await client.query(
            `INSERT INTO pms.nine_box_actions (tenant_id, cycle_id, employee_id, box_key, action_key, kind, title, assignee_id, due_date, pip_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::int IS NULL THEN NULL ELSE (now() + make_interval(days => $9::int))::date END, $10, $11)
             ON CONFLICT (tenant_id, cycle_id, employee_id, action_key) DO NOTHING RETURNING id`,
            [t, cycle.id, p.employee_id, p.box_key, act.action_key, act.kind, act.title, p.manager_id, act.due_days, pipId, by]);
          if (ins.rows[0]) {
            r.created += 1;
            await auditTx(client, req, 'NINE_BOX_ACTION_CREATED', cycle.id, p.employee_id,
              { action_id: ins.rows[0].id, box: p.box_key, kind: act.kind, title: act.title, due_days: act.due_days, assignee_id: p.manager_id });
          }
        }

        // The succession pool: everybody in (2,2), by department, checked
        // against Super 50.
        if (p.box_key === '2,2') {
          const sp = await client.query(
            `INSERT INTO pms.succession_pool (tenant_id, cycle_id, employee_id, department, readiness, super50, added_by)
             VALUES ($1,$2,$3,$4,'ready_now',$5,$6)
             ON CONFLICT (cycle_id, employee_id) DO UPDATE SET department=EXCLUDED.department, super50=EXCLUDED.super50
             RETURNING (xmax = 0) AS inserted`, [t, cycle.id, p.employee_id, p.department, !!p.super50, by]);
          if (sp.rows[0] && sp.rows[0].inserted) {
            r.succession = true;
            await auditTx(client, req, 'SUCCESSION_POOL_ADDED', cycle.id, p.employee_id, { department: p.department, super50: !!p.super50 });
          }
        } else {
          const gone = await client.query(`DELETE FROM pms.succession_pool WHERE cycle_id=$1 AND employee_id=$2 RETURNING employee_id`, [cycle.id, p.employee_id]);
          if (gone.rows[0]) await auditTx(client, req, 'SUCCESSION_POOL_REMOVED', cycle.id, p.employee_id, { now_box: p.box_key });
        }

        // Two cycles running in (0,0): HR decides on separation or a
        // role change.
        if (p.box_key === '0,0' && p.prev_box_key === '0,0') {
          const esc = await client.query(
            `INSERT INTO pms.nine_box_actions (tenant_id, cycle_id, employee_id, box_key, action_key, kind, title, assignee_id, created_by)
             VALUES ($1,$2,$3,'0,0','escalation','escalation',$4,NULL,$5)
             ON CONFLICT (tenant_id, cycle_id, employee_id, action_key) DO NOTHING RETURNING id`,
            [t, cycle.id, p.employee_id, 'Two cycles in a row as Underperformer (0,0): HR to decide on separation or a role change', by]);
          if (esc.rows[0]) {
            r.escalated = true; r.created += 1;
            await auditTx(client, req, 'NINE_BOX_ESCALATED', cycle.id, p.employee_id, { previous_cycle_id: p.prev_cycle_id });
          }
        }

        // A (2,2) who drops a box — or a Super 50 employee who leaves
        // (2,2) — alerts HR and the manager.
        if (p.prev_box_key === '2,2' && p.status === 'placed' && p.box_key !== '2,2') {
          const s50 = !!(wasFlagged.get(p.employee_id) || p.super50);
          const ra = await client.query(
            `INSERT INTO pms.nine_box_actions (tenant_id, cycle_id, employee_id, box_key, action_key, kind, title, assignee_id, created_by)
             VALUES ($1,$2,$3,$4,'retention_alert','retention',$5,$6,$7)
             ON CONFLICT (tenant_id, cycle_id, employee_id, action_key) DO NOTHING RETURNING id`,
            [t, cycle.id, p.employee_id, p.box_key,
              `Retention review: moved out of Top Performer (2,2) to ${p.box_name} (${p.box_key})${s50 ? ' — on the Super 50 watchlist' : ''}`,
              p.manager_id, by]);
          if (ra.rows[0]) {
            r.retention = { super50: s50 }; r.created += 1;
            await auditTx(client, req, 'RETENTION_ALERT_SENT', cycle.id, p.employee_id,
              { trigger: 'nine_box_drop', from: '2,2', to: p.box_key, super50: s50 });
          }
        }
        return r;
      });
      if (p.status === 'placed') { out.placed += 1; out.by_box[p.box_key] += 1; } else {
        out.not_placed += 1;
        out.not_placed_by_reason[p.not_placed_reason] = (out.not_placed_by_reason[p.not_placed_reason] || 0) + 1;
      }
      out.actions_created += done.created;
      out.actions_superseded += done.superseded || 0;
      if (done.succession) out.succession_added += 1;
      if (done.pip) { out.pips_opened += 1; later.pips.push(p); }
      if (done.escalated) { out.escalations += 1; later.escalation.push(p); }
      if (done.retention) { out.retention_alerts += 1; later.retention.push({ ...p, s50: done.retention.super50 }); }
      if (p.manager_id) {
        const m = later.managers.get(p.manager_id) || { placed: 0, actions: 0 };
        m.placed += p.status === 'placed' ? 1 : 0; m.actions += done.created;
        later.managers.set(p.manager_id, m);
      }
    } catch (e) {
      logger.error('nine-box placement failed', { employee_id: p.employee_id, error: e.message });
      out.failures.push({ employee_id: p.employee_id, reason: `9-box: ${e.message}` });
    }
  }

  // Notifications, after every placement is committed. The employee is
  // told about a PIP exactly as before — nothing an employee receives
  // names a box. Managers and HR get one digest each, not one per person.
  for (const p of later.pips) {
    await quietly(notify(t, p.employee_id, 'pip_opened', `A Performance Improvement Plan has been opened for ${cycle.name}`, null, '/pip'));
  }
  const hr = await hrRecipients(t);
  for (const p of later.retention) {
    const title = `Retention alert: ${p.name} has moved out of Top Performer`;
    const body = `${p.name} was Top Performer (2,2) last cycle and is now ${p.box_name} (${p.box_key}) in ${cycle.name}${p.s50 ? '. They are on the Super 50 watchlist' : ''}. Consider a retention conversation.`;
    for (const id of new Set([...hr, ...(p.manager_id ? [p.manager_id] : [])])) {
      if (id === p.employee_id) continue;
      await quietly(notify(t, id, 'nine_box_retention_alert', title, body, hr.includes(id) ? '/admin/nine-box' : '/team/nine-box'));
    }
  }
  for (const p of later.escalation) {
    for (const id of hr) {
      if (id === p.employee_id) continue;
      await quietly(notify(t, id, 'nine_box_escalation', `${p.name}: two cycles in a row as Underperformer`,
        `${p.name} is in Underperformer (0,0) for the second cycle running (${cycle.name}). The 9-box asks HR to decide on separation or a role change.`, '/admin/nine-box'));
    }
  }
  for (const [mid, m] of later.managers) {
    await quietly(notify(t, mid, 'nine_box_digest', `9-box placements for ${cycle.name}`,
      `${m.placed} of your team ${m.placed === 1 ? 'was' : 'were'} placed on the 9-box. ${m.actions ? `${m.actions} follow-up action${m.actions === 1 ? ' is' : 's are'} waiting for you.` : 'No follow-up actions for you.'}`,
      '/team/nine-box'));
  }
  const summary = rules.BOX_KEYS.filter((k) => out.by_box[k]).map((k) => `${settings.boxes[k].name} ${out.by_box[k]}`).join(', ');
  for (const id of hr) {
    await quietly(notify(t, id, 'nine_box_digest', `9-box published for ${cycle.name}`,
      `${out.placed} placed${out.not_placed ? `, ${out.not_placed} not placed` : ''}. ${summary}. ${out.succession_added} joined the succession pool; ${out.pips_opened} PIP${out.pips_opened === 1 ? '' : 's'} opened.`,
      '/admin/nine-box'));
  }
  return out;
}

module.exports = {
  router, teamRouter, settingsFor, computePlacements, cycleRows, isPublished, publishPlacements, personOut, scopeFor,
};
