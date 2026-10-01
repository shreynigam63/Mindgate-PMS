// Who an HRBP may see.
//
// The one rule worth stating before any code: AN EMPTY REMIT IS NO
// ACCESS, never the whole company. Every function here fails closed. A
// scoping bug that fails open hands somebody the entire organisation's
// ratings, and it looks exactly like a working screen while it does it.
//
// The pure half is `matches` and `remitSql`: given a remit and a person,
// is that person in it, and what WHERE clause expresses the same thing in
// SQL. Those two must agree, so they are tested against the same cases —
// a scoping rule that is enforced one way in JavaScript and another way
// in a query is a rule that will drift.
//
// Union, not intersection: a person is in the remit if their location is
// one of the assigned locations OR their hod_name is one of the assigned
// HODs. The request was "as per location and HOD"; on the live master 26
// of 34 departments have no head set, so requiring both would usually
// resolve to nobody and read as a broken screen.

const db = require('../../core/db');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * The remit rows for one HRBP, as two lists.
 * @returns {{locations:string[], hods:string[], empty:boolean}}
 */
async function remitFor(tenantId, email) {
  const rows = (await db.query(
    `SELECT kind, value FROM core.hrbp_scope
      WHERE tenant_id=$1 AND lower(email)=lower($2)
      ORDER BY kind, value`, [tenantId, email])).rows;
  const locations = rows.filter((r) => r.kind === 'location').map((r) => r.value);
  const hods = rows.filter((r) => r.kind === 'hod').map((r) => r.value);
  return { locations, hods, empty: !locations.length && !hods.length };
}

/**
 * Is this employee inside the remit? Pure.
 * @param {{locations:string[], hods:string[]}} remit
 * @param {{location:?string, hod_name:?string}} employee
 */
function matches(remit, employee) {
  const locs = (remit.locations || []).map(norm).filter(Boolean);
  const hods = (remit.hods || []).map(norm).filter(Boolean);
  // Fails closed. Not a guard clause for tidiness — this is the rule.
  if (!locs.length && !hods.length) return false;
  const l = norm(employee && employee.location);
  const h = norm(employee && employee.hod_name);
  // A person with neither field set is in nobody's remit. That is the
  // honest answer while the master has not been re-imported: inventing a
  // default would put 1,427 people into the first HRBP's screens.
  //
  // ONE DEFENCE, NOT TWO. This read `if (l && locs.includes(l))` — a
  // second guard against a blank, on top of the .filter(Boolean) above.
  // The poison sweep showed the pair masking each other: removing either
  // alone left every test green, because the other still held, so neither
  // was actually pinned and a later tidy-up could have taken both. The
  // filter is the better place to keep it, since it also fixes the SQL
  // path, and `locs` cannot contain '' so `includes('')` is already false.
  if (locs.includes(l)) return true;
  if (hods.includes(h)) return true;
  return false;
}

/**
 * The same rule as SQL, to be ANDed into a query over core.employees
 * aliased `e`. Returns `{ where, params }` where `where` already begins
 * with AND, and params continue from `startIndex`.
 *
 * An empty remit yields `AND false` rather than an empty string: a
 * scoping clause that disappears when there is nothing to scope by is
 * how a filtered page quietly becomes an unfiltered one.
 */
function remitSql(remit, startIndex = 2) {
  const locs = (remit.locations || []).map(norm).filter(Boolean);
  const hods = (remit.hods || []).map(norm).filter(Boolean);
  if (!locs.length && !hods.length) return { where: ' AND false', params: [] };
  const parts = [];
  const params = [];
  let i = startIndex;
  if (locs.length) { parts.push(`lower(btrim(e.location)) = ANY($${i}::text[])`); params.push(locs); i += 1; }
  if (hods.length) { parts.push(`lower(btrim(e.hod_name)) = ANY($${i}::text[])`); params.push(hods); i += 1; }
  return { where: ` AND (${parts.join(' OR ')})`, params };
}

/**
 * Every employee id in the remit. Used by the pages that already take a
 * list of ids (the timesheet roster, for one) rather than building their
 * own WHERE.
 */
async function employeeIdsFor(tenantId, email, { includeInactive = false } = {}) {
  const remit = await remitFor(tenantId, email);
  if (remit.empty) return [];
  const { where, params } = remitSql(remit, 2);
  const rows = (await db.query(
    `SELECT e.id FROM core.employees e
      WHERE e.tenant_id=$1 AND e.archived_at IS NULL
            ${includeInactive ? '' : "AND e.status='active'"}${where}`,
    [tenantId, ...params])).rows;
  return rows.map((r) => r.id);
}

/**
 * What the screens print when a remit is empty. One sentence that says
 * what is missing and who fixes it — the house rule, and the difference
 * between a blank page and a page somebody can act on.
 */
function emptyRemitReason(remit, counts = {}) {
  if (!remit.empty) return null;
  return 'No locations or HODs are assigned to you yet, so there is nobody in your remit. '
    + 'HR sets this on the HRBP page under the HR tab.';
}

/**
 * The other way a correctly configured remit still shows nothing: the
 * master has no location or HOD on it, because it has not been imported
 * again since those columns were added.
 */
async function coverageWarning(tenantId) {
  const r = (await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE location IS NULL OR btrim(location)='')::int AS no_location,
            count(*) FILTER (WHERE hod_name IS NULL OR btrim(hod_name)='')::int AS no_hod
       FROM core.employees
      WHERE tenant_id=$1 AND archived_at IS NULL AND status='active'`, [tenantId])).rows[0];
  if (!r.total || (!r.no_location && !r.no_hod)) return null;
  return {
    total: r.total, no_location: r.no_location, no_hod: r.no_hod,
    message: `${r.no_location} of ${r.total} active employees have no location on record`
      + `${r.no_hod ? ` and ${r.no_hod} have no HOD` : ''}. `
      + 'They fall outside every HRBP remit until the employee master is imported again with those columns.',
  };
}

module.exports = { remitFor, matches, remitSql, employeeIdsFor, emptyRemitReason, coverageWarning, norm };
