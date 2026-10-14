// HOD Review → Team analysis (15 Oct: "Overall team analysis as per
// reportees and managers reporting to HOD").
//
// The Delivery Head's team is their reporting line (reporting-tree.js):
// their direct reportees, and through each manager among them, that
// manager's team. The analysis is the cycle's progress and its ratings for
// the whole line, then for the direct reportees, then for each manager's
// team. Every figure is counted here — no AI.
const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { hasPermission } = require('../../core/permissions');
const { activeCycle } = require('./active-cycle');
const { reportingTree } = require('./reporting-tree');
const { gradeFor, gradeLabels } = require('./grade');

const r1 = (x) => Math.round(x * 10) / 10;

// The figures for one group of people. Pure.
function summarise(members, scale) {
  const count = (f) => members.filter(f).length;
  const rated = members.map((m) => (m.final_rating == null ? null : Number(m.final_rating))).filter((v) => v != null && Number.isFinite(v));
  const avg = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
  const by = {};
  for (const v of rated) { const g = gradeFor(v, scale); by[g] = (by[g] || 0) + 1; }
  return {
    headcount: members.length,
    kra_approved: count((m) => m.kra_status === 'approved'),
    kra_waiting: count((m) => m.kra_status === 'submitted'),
    kra_not_submitted: count((m) => !m.kra_status || m.kra_status === 'draft' || m.kra_status === 'returned'),
    self_submitted: count((m) => m.self_status === 'submitted'),
    manager_submitted: count((m) => m.manager_status === 'submitted'),
    hod_submitted: count((m) => m.hod_status === 'submitted'),
    rated: rated.length,
    avg_rating: avg == null ? null : r1(avg),
    avg_grade: avg == null ? null : gradeFor(avg, scale),
    distribution: gradeLabels(scale).map((label) => ({ label, count: by[label] || 0 })),
  };
}

// Direct reportees first, then one group per manager reporting to the
// HOD — that manager's whole team below them. Pure.
function groupsOf(people, hodId, scale) {
  const kids = new Map();
  for (const p of people) {
    if (!kids.has(p.manager_id)) kids.set(p.manager_id, []);
    kids.get(p.manager_id).push(p);
  }
  const below = (id) => {
    const out = [];
    const stack = [...(kids.get(id) || [])];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      stack.push(...(kids.get(p.id) || []));
    }
    return out;
  };
  const direct = (kids.get(hodId) || []).sort((a, b) => a.name.localeCompare(b.name));
  const groups = [{ key: 'direct', title: 'Your direct reportees', manager: null, ...summarise(direct, scale) }];
  for (const d of direct) {
    const team = below(d.id);
    if (!team.length) continue;
    groups.push({ key: d.id, title: `${d.name}'s team`, manager: { id: d.id, name: d.name, designation: d.designation }, ...summarise(team, scale) });
  }
  return groups;
}

const router = express.Router();

router.get('/analysis', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_hod'))) return res.status(403).json({ error: "Requires 'pms_hod'", needs: 'pms_hod' });
    const t = req.user.tenant_id;
    const ids = [...(await reportingTree(t, req.user.id))];
    const c = await activeCycle(t);
    const scale = c ? c.rating_scale : null;
    const people = ids.length ? (await db.query(
      `SELECT e.id, e.name, e.designation, e.department, e.manager_id, m.name AS manager_name,
              ks.status AS kra_status, sa.status AS self_status,
              me.status AS manager_status, me.overall_rating AS manager_rating,
              he.status AS hod_status, he.overall_rating AS hod_rating
         FROM core.employees e
         LEFT JOIN core.employees m ON m.id = e.manager_id
         LEFT JOIN pms.kra_sheets ks ON ks.employee_id = e.id AND ks.cycle_id = $3
         LEFT JOIN pms.self_appraisals sa ON sa.employee_id = e.id AND sa.cycle_id = $3
         LEFT JOIN pms.manager_evaluations me ON me.employee_id = e.id AND me.cycle_id = $3
         LEFT JOIN pms.hod_evaluations he ON he.employee_id = e.id AND he.cycle_id = $3
        WHERE e.tenant_id=$1 AND e.id = ANY($2::uuid[])
        ORDER BY e.name`, [t, ids, c ? c.id : null])).rows : [];
    // The rating that stands: the HOD's once submitted, else the manager's
    // submitted one. Drafts are not ratings yet.
    for (const p of people) {
      p.final_rating = p.hod_status === 'submitted' && p.hod_rating != null ? Number(p.hod_rating)
        : p.manager_status === 'submitted' && p.manager_rating != null ? Number(p.manager_rating) : null;
      p.final_grade = p.final_rating == null ? null : gradeFor(p.final_rating, scale);
      p.is_manager = people.some((x) => x.manager_id === p.id);
    }
    res.json({
      cycle: c ? { id: c.id, name: c.name, phase: c.phase } : null,
      overall: summarise(people, scale),
      groups: groupsOf(people, req.user.id, scale),
      people: people.map(({ manager_rating, hod_rating, ...p }) => p),
    });
  } catch (e) { logger.error('hod team analysis', { error: e.message }); res.status(500).json({ error: 'Could not build the team analysis.' }); }
});

module.exports = { router, summarise, groupsOf };
