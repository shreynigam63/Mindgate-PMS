// Give a new hire their KRAs the moment their details land in the system.
//
// Asked for on 18 Sep: "new hires should be assigned KRAs directly as per
// their department and designation once their details are added in system."
// The earlier framing of the same point added the constraint that matters
// most: "Manager approval is still required, but the KRA itself must remain
// open."
//
// So this COPIES the library shelf onto the new employee's sheet and leaves
// the sheet in 'draft' — theirs to review and submit. It deliberately does
// NOT submit on their behalf: submitting is the act that hands the sheet to
// a manager for approval, and an employee who has never seen their own
// objectives cannot meaningfully have asked for them to be approved. The
// client's own "manager approval is still required" is what decides this —
// approval implies a submission, and a submission implies a person.
//
// WHERE IT FIRES. There is exactly one way an employee can be created:
// POST /api/v1/employees/import. There is no single-employee create route,
// so the importer is the whole surface — called AFTER the commit, for the
// same reason profile-change.js is (see that file's header): this writes
// through the pool, so inside the import's transaction it would either not
// see the rows it is meant to read or block on their locks.
//
// WHO COUNTS AS NEW. The importer already computes `beforeByEmail` — who was
// on file before the file landed. A row whose email is not in that map is
// appearing for the first time. Pass 4 already relies on exactly this to
// tell a real designation change from a re-import, so a re-import of the
// whole company assigns nothing to the 1,397 people it also contains.
//
// WHAT IT WILL NOT DO. It never touches a sheet that already carries KRAs,
// and never one that has left 'draft' or 'returned'. A re-import must be
// safe to run twice, and somebody's own picks must never be silently
// replaced by a shelf.
const db = require('../../core/db');
const { notify } = require('../../core/notifications');
const logger = require('../../core/logger');

// Only these two are the employee's to hold. A submitted or approved sheet
// belongs to the flow, and an auto-assign landing in it would rewrite
// objectives somebody is already being appraised against.
const FILLABLE = ['draft', 'returned'];

// The shared resolver — the same one the employee's own page uses, so the
// KRAs assigned here always land on the cycle they will actually see. This
// file no longer carries its own copy of the predicate: that copy had the
// draft-cycle bug too, and a new hire's KRAs going to an unstarted cycle
// would have been invisible to everyone.
const { activeCycle } = require('./active-cycle');

const activeCycleFor = activeCycle;

// Is department matching switched on for this tenant? Mirrors
// kraLibraryScope() in index.js — same setting, same default.
async function departmentScoped(tenantId) {
  const r = await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='kra_library_scope'`, [tenantId]);
  const v = r.rows[0] && r.rows[0].value;
  return String(v && v.mode || v || 'designation') === 'department+designation';
}

// The shelf this employee should get, and which rule picked it.
//
// The precedence is the one migration 034 documents and kraLibraryFor()
// serves to the picker: the employee's OWN department's shelf when one has
// been published for their title, otherwise the company-wide shelf for that
// title (the rows with no department). Never both — a title with two shelves
// would otherwise hand out its KRAs twice.
//
// Matching is on trimmed, case-folded text, like every other comparison
// against the library, because the upload is a spreadsheet and " Finance "
// and "finance" are the same department to everyone except a computer.
async function shelfFor(tenantId, employee) {
  const designation = String(employee.designation || '').trim();
  const department = String(employee.department || '').trim();
  if (!designation) return { rows: [], scope: null, reason: 'no_designation' };

  const pick = async (whereDept, params) => (await db.query(
    `SELECT title, description, measures, category, suggested_weight, sort_order
       FROM pms.kra_library
      WHERE tenant_id=$1 AND lower(btrim(designation))=lower(btrim($2)) AND ${whereDept}
      ORDER BY sort_order, title`, params)).rows;

  if (department && await departmentScoped(tenantId)) {
    const own = await pick('lower(btrim(department))=lower(btrim($3))', [tenantId, designation, department]);
    if (own.length) return { rows: own, scope: 'department+designation', reason: null };
  }

  const wide = await pick("(department IS NULL OR btrim(department)='')", [tenantId, designation]);
  if (wide.length) return { rows: wide, scope: 'designation', reason: null };
  return { rows: [], scope: null, reason: 'no_shelf_for_designation' };
}

// Assign one employee's KRAs. Returns what happened, always — a caller
// putting this in an import report needs a reason for every skip, not a
// silent zero.
async function assignFromLibrary(tenantId, employeeId, { actorEmail = null } = {}) {
  const emp = (await db.query(
    `SELECT id, name, designation, department, manager_id, status
       FROM core.employees WHERE id=$1 AND tenant_id=$2`, [employeeId, tenantId])).rows[0];
  if (!emp) return { assigned: 0, reason: 'employee_not_found' };
  // An inactive row is a leaver or a placeholder; giving it objectives
  // would put it in a manager's queue.
  if (emp.status !== 'active') return { assigned: 0, reason: 'not_active' };

  const cycle = await activeCycleFor(tenantId);
  if (!cycle) return { assigned: 0, reason: 'no_open_cycle' };

  const shelf = await shelfFor(tenantId, emp);
  // Reported, never guessed at. 16 live designations have no shelf, and an
  // employee silently left with an empty sheet looks identical to one the
  // feature simply forgot.
  if (!shelf.rows.length) {
    return { assigned: 0, reason: shelf.reason, designation: emp.designation, department: emp.department };
  }

  let sheet = (await db.query(
    `SELECT id, status FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`,
    [cycle.id, employeeId])).rows[0];
  if (!sheet) {
    sheet = (await db.query(
      `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, manager_id)
       VALUES ($1,$2,$3,$4) RETURNING id, status`,
      [tenantId, cycle.id, employeeId, emp.manager_id])).rows[0];
  }
  if (!FILLABLE.includes(sheet.status)) return { assigned: 0, reason: `sheet_${sheet.status}` };

  // The guard that makes a re-import safe and keeps somebody's own picks
  // theirs. Checked here rather than trusted from the "is this a new hire"
  // signal, because that signal lives in the caller and this must hold
  // whoever calls it.
  const already = (await db.query(
    `SELECT count(*)::int AS n FROM pms.kras WHERE sheet_id=$1`, [sheet.id])).rows[0].n;
  if (already) return { assigned: 0, reason: 'already_has_kras', existing: already };

  const client = await db.getClient();
  // Declared out here, not in the try: both are read after the commit, to
  // report and to notify.
  let total = 0;
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const k of shelf.rows) {
      if (!k.title || !String(k.title).trim()) continue;
      // Number(x) || 0 matches writeKras() and the pms.kras column, which is
      // NOT NULL DEFAULT 0: a library row with no suggested weight becomes a
      // 0% KRA the employee has to weight themselves, which is visible and
      // fixable, rather than a failed insert.
      const weight = Number(k.suggested_weight) || 0;
      total += weight;
      await client.query(
        `INSERT INTO pms.kras (tenant_id, sheet_id, title, description, weight, measures, category, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, sheet.id, String(k.title).trim(), k.description || null, weight, k.measures || null,
         k.category && String(k.category).trim() ? String(k.category).trim() : null, (inserted + 1) * 10]);
      inserted += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  total = Number(total.toFixed(2));
  // NOT normalised to 100. The weights are HR's numbers, and quietly
  // rescaling them would invent a split nobody approved — one live shelf
  // (Senior Software Engineer) totals 105%, and the employee's own page
  // already shows an amber warning and refuses the submit until it is 100.
  // Reporting it is what lets HR fix the shelf instead of wondering why one
  // designation cannot submit.
  const weightsOk = Math.abs(total - 100) < 0.01;

  await db.query(
    `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
     VALUES ($1,$2,'KRA_AUTOASSIGNED_ON_JOINING','kra_sheets',$3,$4)`,
    [tenantId, actorEmail, sheet.id,
     JSON.stringify({ employee_id: employeeId, cycle_id: cycle.id, kras: inserted,
       designation: emp.designation, department: emp.department,
       matched_scope: shelf.scope, weight_total: total })]);

  await notify(tenantId, employeeId, 'kra_autoassigned',
    'Your KRAs are ready to review',
    `${inserted} KRAs for ${emp.designation} have been added to your sheet`
      + `${shelf.scope === 'department+designation' ? ` in ${emp.department}` : ''}. `
      + (weightsOk
        ? 'Review them, adjust if you need to, then submit them to your manager for approval.'
        : `Their weights total ${total}% and must come to 100% before you can submit — adjust them, then send to your manager.`),
    '/my/kras');

  return {
    assigned: inserted, reason: null, sheet_id: sheet.id, cycle_id: cycle.id,
    matched_scope: shelf.scope, designation: emp.designation, department: emp.department,
    weight_total: total, weights_ok: weightsOk,
  };
}

// The wrapper the importer uses. One employee's failure must not lose an
// import that is already durable, and must not be silent either — the
// caller puts every reason in the report.
async function assignFromLibrarySafely(tenantId, employeeId, opts = {}) {
  try {
    return await assignFromLibrary(tenantId, employeeId, opts);
  } catch (e) {
    logger.error('kra auto-assign on joining', {
      error: e.message, tenant_id: tenantId, employee_id: employeeId });
    return { assigned: 0, reason: 'error', error: e.message };
  }
}

module.exports = {
  assignFromLibrary, assignFromLibrarySafely, shelfFor, activeCycleFor, departmentScoped, FILLABLE,
};
