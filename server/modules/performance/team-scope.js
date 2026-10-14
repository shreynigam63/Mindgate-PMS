// Whose records a "Team" page shows (15 Oct: Team Connects in the Manager,
// HOD, HRBP and HR tabs). One answer per tab:
//   manager  the caller's direct reports (pms_team_eval)
//   hod      everyone on the caller's reporting line, any depth (pms_hod)
//   hrbp     the caller's remit — locations and HODs HR gave them (pms_hrbp)
//   hr       everyone (pms_admin)
// The caller is never in their own team. Returns { all: true } for HR,
// { ids: Set } otherwise, or { status, error, needs } when the tab is not
// theirs.
const db = require('../../core/db');
const { hasPermission } = require('../../core/permissions');
const { hrbpScope } = require('../people');
const { reportingTree } = require('./reporting-tree');

const NEEDS = { manager: 'pms_team_eval', hod: 'pms_hod', hrbp: 'pms_hrbp', hr: 'pms_admin' };

async function teamScope(req, scope) {
  const need = NEEDS[scope];
  if (!need) return { status: 400, error: "scope must be 'manager', 'hod', 'hrbp' or 'hr'" };
  if (!(await hasPermission(req.user, need))) return { status: 403, error: `Requires '${need}'`, needs: need };
  const t = req.user.tenant_id;
  const me = req.user.id;
  if (scope === 'hr') return { scope, all: true };
  let ids;
  if (scope === 'hod') ids = await reportingTree(t, me);
  else if (scope === 'hrbp') ids = new Set(await hrbpScope.employeeIdsFor(t, req.user.email));
  else {
    ids = new Set((await db.query(
      `SELECT id FROM core.employees WHERE tenant_id=$1 AND manager_id=$2 AND status='active' AND archived_at IS NULL`, [t, me])).rows.map((r) => r.id));
  }
  ids.delete(me);
  return { scope, ids };
}

// May the caller read this one employee's team records (in any tab they hold)?
async function mayRead(req, employeeId) {
  if (employeeId === req.user.id) return true;
  for (const scope of ['hr', 'manager', 'hod', 'hrbp']) {
    const s = await teamScope(req, scope);
    if (s.error) continue;
    if (s.all || s.ids.has(employeeId)) return true;
  }
  return false;
}

module.exports = { teamScope, mayRead, NEEDS };
