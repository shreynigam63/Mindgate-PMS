// Employee mirror + bulk import (CSV and Excel) — People Core.
//
// The employee master is IMPORTED from the client's HRMS, never maintained
// here. Correctness of the manager chain and departments is a stated
// implementation prerequisite (it routes the entire appraisal workflow), so
// the importer VALIDATES and reports per-row reasons — the no-silent-failure
// rule. Nothing loads unless the file is coherent; dry-run is the default.
//
// Accepted formats: .csv, .xlsx, .xls (BR-1.1 — "a bulk Excel upload option
// must be made available"). Both formats resolve to the same row shape and
// share one validator, so behaviour (required columns, manager-chain checks,
// date parsing, dry-run default) is identical regardless of file type.
//
// Columns (header row, case-insensitive, order-free):
//   emp_code, name, email, department, designation, role_band,
//   manager_email, date_of_joining (flexible formats), status
//
// validateEmployeeRows() is a PURE function — no db — so it is unit-tested
// directly and reused by the standalone tool in /tools.

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const bcrypt = require('bcryptjs');
const db = require('./db');
const logger = require('./logger');
const { authenticate } = require('./auth');
const { guardUuidParams } = require('./http');
const { apiPermissionParity, hasPermission } = require('./permissions');

// ---------- CSV parsing (self-contained; handles quotes and commas) --------
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// Flexible date → yyyy-mm-dd or null (subset of the proven AH parser:
// ISO first, dd-mm-yyyy with swap, "26 Aug 2026", ordinals, rollover rejected).
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
function flexDate(v) {
  if (v == null || String(v).trim() === '') return null;
  const iso = (y, mo, d) => {
    const dt = new Date(Date.UTC(y, mo, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  };
  const s = String(v).trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) {
    let [, d, mo, y] = m; d = +d; mo = +mo; y = +y; if (y < 100) y += 2000;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return iso(y, mo - 1, d);
  }
  if ((m = s.match(/^(\d{1,2})[\-\s]+([A-Za-z]{3,})[\-\s,]+(\d{2,4})$/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo != null) { let y = +m[3]; if (y < 100) y += 2000; return iso(y, mo, +m[1]); }
  }
  const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---------- Validation (pure) ----------------------------------------------
const REQUIRED = ['name', 'email'];
const KNOWN = ['emp_code','name','email','department','designation','role_band','manager_email','date_of_joining','status'];

// ---------- Excel (.xlsx/.xls) parsing — same array-of-rows shape as parseCsv
// so both formats feed the one validator below. Dates come back as either a
// real Date (Excel serial dates) or text; both are normalised to strings
// here so flexDate() in the shared validator handles them identically to a
// CSV cell, with no format-specific branching downstream.
//
// FIRST WORKSHEET ONLY — see parseExcelSheets below for the rest.
async function parseExcelBuffer(buffer) {
  const sheets = await parseExcelSheets(buffer);
  return sheets.length ? sheets[0].rows : [];
}

// Every worksheet in the workbook, as { name, rows, rowNumbers, merged } —
// same cell normalisation as parseExcelBuffer above, which now delegates
// here so there is one implementation of "an Excel cell becomes a string".
//
// The employee importer only ever wants the first sheet (one file, one
// list of people). The KRA importer needs all of them: the goal sheets
// actually in use carry one tab PER ROLE — "PM KRA", "KRA Technical
// Manager", "L1 Recon" — inside a single workbook, so reading only the
// first tab would silently import a twelfth of the file and report
// success. Sheets the caller cannot make sense of are its business to
// report, not this function's to hide.
async function parseExcelSheets(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    // Blank rows are dropped (they are formatting, not data), so the index
    // into `rows` is NOT the row number in the spreadsheet. Carry the real
    // one alongside: these sheets use blank rows as group separators, and
    // an error that says "row 5" about the row a human sees as row 6 is
    // worse than no row number at all.
    const rowNumbers = [];
    // Vertical merges, per cell: true when this cell is the CONTINUATION of
    // a merge that started on an earlier row. ExcelJS reports the master's
    // value on every cell of a merge, so without this a merged block reads
    // as the same value repeated down N rows — which for a weight column
    // means the file's weights appear to total N times what they do. Real
    // KRA sheets merge a KRA title (and its weight) down across its several
    // KPI rows, so this is the normal case, not an exotic one.
    const merged = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = [];
      const cont = [];
      // row.cellCount reflects the last populated column; iterate by number so
      // gaps (skipped cells) still line up with the header's column positions.
      for (let c = 1; c <= row.cellCount; c++) {
        const cell = row.getCell(c);
        cont.push(!!(cell.isMerged && cell.master && cell.master.row < row.number));
        let v = cell.value;
        if (v == null) v = '';
        else if (v instanceof Date) v = v.toISOString().slice(0, 10); // -> yyyy-mm-dd, flexDate handles it
        else if (typeof v === 'object' && 'text' in v) v = v.text; // rich text
        else if (typeof v === 'object' && 'result' in v) v = v.result; // formula cell
        else v = String(v);
        cells.push(v);
      }
      if (cells.some((c) => String(c).trim() !== '')) { rows.push(cells); rowNumbers.push(row.number); merged.push(cont); }
    });
    out.push({ name: ws.name, rows, rowNumbers, merged });
  }
  return out;
}

function validateEmployeeRows(rows) {
  if (!rows.length) return { ok: false, fatal: 'Empty file', rows: [], errors: [], warnings: [] };
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) return { ok: false, fatal: `Missing required column(s): ${missing.join(', ')}`, rows: [], errors: [], warnings: [] };
  const unknown = header.filter(h => !KNOWN.includes(h));

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = []; const errors = []; const warnings = [];
  const seenEmails = new Map();

  rows.slice(1).forEach((r, n) => {
    const line = n + 2; // 1-based + header
    const get = (c) => (idx[c] != null ? (r[idx[c]] || '').trim() : '');
    const rec = {
      line,
      emp_code: get('emp_code') || null,
      name: get('name'),
      email: get('email').toLowerCase(),
      department: get('department') || null,
      designation: get('designation') || null,
      role_band: get('role_band') || null,
      manager_email: (get('manager_email') || '').toLowerCase() || null,
      date_of_joining_raw: get('date_of_joining') || null,
      date_of_joining: flexDate(get('date_of_joining')),
      status: (get('status') || 'active').toLowerCase(),
    };
    if (!rec.name) errors.push({ line, error: 'name is empty' });
    if (!rec.email) errors.push({ line, error: 'email is empty' });
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) errors.push({ line, error: `invalid email "${rec.email}"` });
    else if (seenEmails.has(rec.email)) errors.push({ line, error: `duplicate email "${rec.email}" (first at line ${seenEmails.get(rec.email)})` });
    else seenEmails.set(rec.email, line);
    if (rec.date_of_joining_raw && !rec.date_of_joining) warnings.push({ line, warning: `unparseable date_of_joining "${rec.date_of_joining_raw}" — will be stored empty` });
    if (!['active', 'inactive'].includes(rec.status)) { warnings.push({ line, warning: `status "${rec.status}" not active|inactive — treated as active` }); rec.status = 'active'; }
    out.push(rec);
  });

  // Manager references + chain cycles (the routing prerequisite).
  const byEmail = new Map(out.map(r => [r.email, r]));
  for (const r of out) {
    if (!r.manager_email) continue;
    if (r.manager_email === r.email) { errors.push({ line: r.line, error: 'employee is their own manager' }); continue; }
    if (!byEmail.has(r.manager_email)) errors.push({ line: r.line, error: `manager_email "${r.manager_email}" not present in this file` });
  }
  // Cycle detection over manager edges.
  const state = new Map(); // email -> 0 visiting, 1 done
  for (const r of out) {
    if (state.get(r.email) === 1) continue;
    const path = [];
    let cur = r;
    while (cur) {
      if (state.get(cur.email) === 1) break;
      if (state.get(cur.email) === 0) {
        const cycle = path.slice(path.indexOf(cur.email)).concat(cur.email);
        errors.push({ line: cur.line, error: `manager chain cycle: ${cycle.join(' → ')}` });
        break;
      }
      state.set(cur.email, 0); path.push(cur.email);
      cur = cur.manager_email ? byEmail.get(cur.manager_email) : null;
    }
    for (const e of path) state.set(e, 1);
  }

  const noManager = out.filter(r => !r.manager_email).length;
  if (noManager > 1) warnings.push({ line: 0, warning: `${noManager} employees have no manager (expected ~1 top of org) — verify` });
  if (unknown.length) warnings.push({ line: 1, warning: `ignored unknown column(s): ${unknown.join(', ')}` });

  return { ok: errors.length === 0, fatal: null, rows: out, errors, warnings,
    summary: { total: out.length, errors: errors.length, warnings: warnings.length, departments: new Set(out.map(r => r.department).filter(Boolean)).size } };
}

// Format-specific entry points — both funnel into validateEmployeeRows so
// CSV and Excel get identical validation, identical error messages, and
// identical dry-run behaviour. Existing callers/tests keep using
// validateEmployeeCsv(text) unchanged.
function validateEmployeeCsv(text) {
  return validateEmployeeRows(parseCsv(text));
}
async function validateEmployeeXlsx(buffer) {
  let rows;
  try { rows = await parseExcelBuffer(buffer); }
  catch (e) { return { ok: false, fatal: `Could not read Excel file: ${e.message}`, rows: [], errors: [], warnings: [] }; }
  return validateEmployeeRows(rows);
}

// Sniff format from filename/mimetype rather than trusting one signal alone
// (some browsers send a generic octet-stream mimetype for .xlsx).
//
// NOTE on legacy .xls: that extension is the old pre-2007 binary format, not
// a variant of .xlsx — it needs a different parser entirely. The only
// actively-maintained npm option for it (`xlsx`/SheetJS) currently ships two
// unpatched high-severity advisories (prototype pollution, ReDoS) with no
// fix available, so it is deliberately not used here (see package.json —
// exceljs only). A real, uploaded .xls is therefore detected and rejected
// with a clear message rather than mis-parsed or silently mishandled.
function detectFormat(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.xls')) return 'xls-legacy';
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (file.mimetype === 'application/vnd.ms-excel') return 'xls-legacy';
  return 'csv'; // default: treat unrecognised uploads as CSV text, as before
}

// ---------- Load (transactional, two-pass for manager links) ---------------
// Who in this file manages someone else, and therefore needs a role that
// can actually approve their work.
//
// THE GAP THIS CLOSES: the importer establishes the ORG CHART
// (manager_email -> manager_id) but has never written core.user_roles,
// and principalByEmail defaults a missing row to 'employee'. Since
// pms_team_eval comes from the manager/hod/hr/admin bundles, every
// manager imported from an HRMS could RECEIVE their reports' KRA
// submissions and then be refused at the approval step with
// "Requires 'pms_team_eval'" — the flow dead-ended on exactly the person
// it needed. Found live from a manager's own login.
function managersInFile(rows) {
  const emails = new Set(rows.map((r) => r.email));
  const managing = new Set();
  for (const r of rows) if (r.manager_email && emails.has(r.manager_email)) managing.add(r.manager_email);
  return [...managing];
}

// Which of those would actually be granted — i.e. have no explicit role
// yet. Read-only, so the dry run can show HR the same list the commit
// will act on rather than surprising them after the fact.
async function pendingManagerRoleGrants(tenantId, rows) {
  const candidates = managersInFile(rows);
  if (!candidates.length) return [];
  const existing = (await db.query(
    `SELECT LOWER(email) AS email FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email) = ANY($2::text[])`,
    [tenantId, candidates])).rows.map((r) => r.email);
  return candidates.filter((e) => !existing.includes(e));
}

async function loadEmployees(tenantId, rows) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Pass 1: upsert people without manager links.
    for (const r of rows) {
      await client.query(
        `INSERT INTO core.employees (tenant_id, emp_code, name, email, department, designation, role_band, date_of_joining, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, email) DO UPDATE SET
           emp_code=EXCLUDED.emp_code, name=EXCLUDED.name, department=EXCLUDED.department,
           designation=EXCLUDED.designation, role_band=EXCLUDED.role_band,
           date_of_joining=EXCLUDED.date_of_joining, status=EXCLUDED.status, updated_at=now()`,
        [tenantId, r.emp_code, r.name, r.email, r.department, r.designation, r.role_band, r.date_of_joining, r.status]);
    }
    // Pass 2: manager links by email.
    for (const r of rows) {
      await client.query(
        `UPDATE core.employees e SET manager_id = m.id, updated_at = now()
           FROM core.employees m
          WHERE e.tenant_id=$1 AND LOWER(e.email)=LOWER($2)
            AND m.tenant_id=$1 AND LOWER(m.email)=LOWER($3)`,
        [tenantId, r.email, r.manager_email || '']);
      if (!r.manager_email) {
        await client.query(`UPDATE core.employees SET manager_id=NULL, updated_at=now() WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [tenantId, r.email]);
      }
    }
    // Pass 3 (BR-1.5 — "KRA information should automatically update
    // whenever there is a change in the HRMS, such as an employee
    // changing their manager..."): propagate a manager change to any
    // still-open cycle's KRA sheet and development plan. Only OPEN
    // cycles (phase not closed/cancelled) are touched — a closed cycle's
    // sheet keeps the manager who actually reviewed it at the time, for
    // audit accuracy; that's history, not something a later reassignment
    // should silently rewrite.
    for (const r of rows) {
      await client.query(
        `UPDATE pms.kra_sheets ks SET manager_id = e.manager_id, updated_at = now()
           FROM core.employees e, pms.cycles c
          WHERE ks.employee_id = e.id AND ks.cycle_id = c.id
            AND e.tenant_id=$1 AND LOWER(e.email)=LOWER($2)
            AND c.phase NOT IN ('closed','cancelled')
            AND ks.manager_id IS DISTINCT FROM e.manager_id`,
        [tenantId, r.email]);
      await client.query(
        `UPDATE pms.development_plans dp SET manager_id = e.manager_id, updated_at = now()
           FROM core.employees e, pms.cycles c
          WHERE dp.employee_id = e.id AND dp.cycle_id = c.id
            AND e.tenant_id=$1 AND LOWER(e.email)=LOWER($2)
            AND c.phase NOT IN ('closed','cancelled')
            AND dp.manager_id IS DISTINCT FROM e.manager_id`,
        [tenantId, r.email]);
    }
    // Grant the manager role to anyone this file shows managing someone,
    // who has no explicit role yet.
    //
    // ON CONFLICT DO NOTHING is load-bearing, not defensive: it means an
    // existing role is never touched. Without it a re-import would
    // DOWNGRADE an HR or admin who also happens to manage people, quietly
    // stripping permissions on a routine sync. Upgrades only, and only
    // into the gap.
    const grants = [];
    for (const email of managersInFile(rows)) {
      const r = await client.query(
        `INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,'manager')
         ON CONFLICT DO NOTHING RETURNING email`, [tenantId, email]);
      if (r.rowCount) grants.push(email);
    }
    await client.query('COMMIT');
    return { loaded: rows.length, manager_roles_granted: grants };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ---------- Router ----------------------------------------------------------
const ALLOWED_EXT = /\.(csv|xlsx|xls)$/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXT.test(file.originalname || '')) return cb(new Error('Only .csv, .xlsx, or .xls files are accepted'));
    cb(null, true);
  },
});
const router = express.Router();
router.use(authenticate, apiPermissionParity);
// Malformed uuid path params are rejected with 400 here, before any
// handler can pass one into a query (see core/http.js).
guardUuidParams(router);

// GET /employees/import-template.csv — download link for the bulk import
// form. Found missing during QA (no way to see the expected columns
// without guessing). Header row matches KNOWN exactly so this can never
// drift out of sync with what the importer actually accepts, plus one
// clearly-labelled example row to show the expected shape — remove it
// before uploading real data.
router.get('/import-template.csv', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const example = ['E1001', 'Jane Sample', 'jane.sample@example.com', 'Engineering', 'Software Engineer', 'G5', '', '2024-01-15', 'active'];
    const csv = [KNOWN.join(','), example.join(',')].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="employee_import_template.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    // people_admin restricts this list to HR + admin roles (see
    // migrations/002-default-permission-bundles.js — employee/manager/hod
    // roles have people_view, which does not include this). Gating GET
    // /employees separately at the API layer, not just hiding the nav
    // item in the frontend, is the real security control — a determined
    // non-HR user could otherwise call this endpoint directly (via curl,
    // browser devtools, etc.) and dump the whole employee list even if
    // the button is hidden from them in the UI.
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const r = await db.query(
      `SELECT e.id, e.emp_code, e.name, e.email, e.department, e.designation, e.role_band,
              e.status, e.date_of_joining, m.name AS manager_name, m.email AS manager_email,
              (lc.email IS NOT NULL) AS has_login, COALESCE(ur.role, 'employee') AS role
         FROM core.employees e LEFT JOIN core.employees m ON m.id = e.manager_id
         LEFT JOIN core.local_credentials lc ON lc.tenant_id = e.tenant_id AND LOWER(lc.email) = LOWER(e.email)
         LEFT JOIN core.user_roles ur ON ur.tenant_id = e.tenant_id AND LOWER(ur.email) = LOWER(e.email)
        WHERE e.tenant_id = $1 ORDER BY e.name`, [req.user.tenant_id]);
    res.json({ employees: r.rows });
  } catch (e) { logger.error('employees list', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Direct, single-employee edit — profile fields only (name/department/
// designation/role_band/manager/date_of_joining/status). email is
// DELIBERATELY not editable here: core.local_credentials and
// core.user_roles are both keyed by (tenant_id, email), not employee id —
// changing an employee's email through this route without also cascading
// that change to those two tables would silently orphan their password
// and role, breaking their login with no visible error anywhere. Simpler
// and safer to just not allow it from this quick-edit form; re-import via
// CSV/Excel (which already upserts by email as the identity) remains the
// path for that, same as it always has been.
router.put('/:employeeId', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const emp = (await db.query(`SELECT id, email FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, req.user.tenant_id])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });

    const { name, department, designation, role_band, manager_email, date_of_joining, status } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    let managerId = null;
    if (manager_email && manager_email.trim()) {
      const me = manager_email.trim().toLowerCase();
      if (me === emp.email.toLowerCase()) return res.status(422).json({ error: 'an employee cannot be their own manager' });
      const mgr = (await db.query(`SELECT id FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=$2`, [req.user.tenant_id, me])).rows[0];
      if (!mgr) return res.status(422).json({ error: `no employee with email "${me}" exists yet — add them first, or leave manager blank` });
      managerId = mgr.id;
    }
    const dojParsed = date_of_joining ? flexDate(date_of_joining) : null;
    if (date_of_joining && !dojParsed) return res.status(422).json({ error: `date_of_joining "${date_of_joining}" isn't a recognisable date` });

    await db.query(
      `UPDATE core.employees SET name=$1, department=$2, designation=$3, role_band=$4,
              manager_id=$5, date_of_joining=$6, status=COALESCE($7,status), updated_at=now()
        WHERE id=$8`,
      [name.trim(), department || null, designation || null, role_band || null, managerId, dojParsed, status || null, emp.id]);

    // Same BR-1.5 propagation the bulk importer already does for a manager
    // change — this edit path can change someone's manager too, so it
    // needs the identical fix, not a narrower one.
    await db.query(
      `UPDATE pms.kra_sheets ks SET manager_id=$1, updated_at=now()
         FROM pms.cycles c WHERE ks.employee_id=$2 AND ks.cycle_id=c.id AND c.phase NOT IN ('closed','cancelled')`,
      [managerId, emp.id]);
    await db.query(
      `UPDATE pms.development_plans dp SET manager_id=$1, updated_at=now()
         FROM pms.cycles c WHERE dp.employee_id=$2 AND dp.cycle_id=c.id AND c.phase NOT IN ('closed','cancelled')`,
      [managerId, emp.id]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deletes one employee and everything that is fundamentally THEIRS,
// inside a single transaction — either all of it succeeds, or none of
// it does. people_admin-only.
//
// Two different things happen depending on which side of a relationship
// this employee is on:
//   1. Records that are their OWN (their KRAs, self-appraisals, connects
//      logged about them, etc.) are deleted outright.
//   2. Records where they appear as someone ELSE's manager/reviewer are
//      handled two different ways depending on the schema: where that
//      column is nullable (core.employees.manager_id, pms.kra_sheets.
//      manager_id, pms.development_plans.manager_id), it's set to NULL —
//      the other employee's own record is untouched, they just show as
//      currently unmanaged. Where that column is NOT NULL by schema
//      (pms.manager_evaluations.manager_id, pms.hod_evaluations.hod_id,
//      pms.connects.manager_id, pms.connect_reminders_log.manager_id),
//      there is no valid way to null it out, so THAT SPECIFIC ROW is
//      deleted too — this removes the manager-side review record for a
//      report, not the report's own underlying KRA/self-appraisal data,
//      which is untouched. This is a real, structural consequence of
//      deleting someone who was reviewing others, not a bug — worth
//      knowing before deleting anyone who managed people.
// core.local_credentials/user_roles/user_permissions are keyed by email,
// not id, and are cleaned up by email for the same reason.
router.delete('/:employeeId', async (req, res) => {
  const client = await db.getClient();
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const T = req.user.tenant_id;
    const id = req.params.employeeId;
    const emp = (await db.query(`SELECT id, name, email FROM core.employees WHERE id=$1 AND tenant_id=$2`, [id, T])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.id === req.user.id) return res.status(422).json({ error: 'You cannot delete your own account while signed in as them.' });

    await client.query('BEGIN');

    // ---- Nullable manager-style references: preserve the OTHER employee's record ----
    await client.query(`UPDATE core.employees SET manager_id=NULL WHERE tenant_id=$1 AND manager_id=$2`, [T, id]);
    await client.query(`UPDATE pms.kra_sheets SET manager_id=NULL WHERE tenant_id=$1 AND manager_id=$2`, [T, id]);
    await client.query(`UPDATE pms.development_plans SET manager_id=NULL WHERE tenant_id=$1 AND manager_id=$2`, [T, id]);
    await client.query(`UPDATE people.award_nominations SET nominated_by=NULL WHERE tenant_id=$1 AND nominated_by=$2`, [T, id]);

    // ---- NOT NULL manager-style references: the specific review row can't survive without one ----
    await client.query(`DELETE FROM pms.manager_evaluations WHERE tenant_id=$1 AND manager_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.hod_evaluations WHERE tenant_id=$1 AND hod_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.connects WHERE tenant_id=$1 AND manager_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.connect_reminders_log WHERE tenant_id=$1 AND manager_id=$2`, [T, id]);
    await client.query(`DELETE FROM people.award_nominations WHERE tenant_id=$1 AND nominated_by=$2`, [T, id]);

    // ---- This employee's OWN records — cascades handle child rows
    // automatically (pms.kras via sheet_id, pms.evidence via appraisal_id,
    // pms.development_goals via plan_id, pms.pip_weekly_entries via pip_id,
    // people.appraisal_query_messages via query_id — all ON DELETE CASCADE). ----
    await client.query(`DELETE FROM core.department_heads WHERE employee_id=$1`, [id]);
    await client.query(`DELETE FROM core.notifications WHERE employee_id=$1`, [id]);
    await client.query(`DELETE FROM core.employee_consents WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.kra_sheets WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.self_appraisals WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.manager_evaluations WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.hod_evaluations WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.top_talent WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.pip_records WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.employee_performance_history WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.closure_letters WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.parameter_scores WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.development_plans WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.connect_reminders_log WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM pms.pulse_checks WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM engagement.invitations WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM engagement.responses WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM people.event_rsvps WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM people.csr_participations WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM people.appraisal_queries WHERE tenant_id=$1 AND employee_id=$2`, [T, id]);
    await client.query(`DELETE FROM people.award_nominations WHERE tenant_id=$1 AND nominee_id=$2`, [T, id]);

    // ---- Login/permission rows, keyed by email not id ----
    await client.query(`DELETE FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [T, emp.email]);
    await client.query(`DELETE FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [T, emp.email]);
    await client.query(`DELETE FROM core.user_permissions WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [T, emp.email]);

    // Audit entry BEFORE the employee row itself disappears, so the
    // name/email are still known at the moment this is recorded.
    await client.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'EMPLOYEE_DELETED','employees',$3,$4)`,
      [T, req.user.email, id, JSON.stringify({ name: emp.name, email: emp.email })]);

    await client.query(`DELETE FROM core.employees WHERE id=$1 AND tenant_id=$2`, [id, T]);

    await client.query('COMMIT');
    logger.info('employee deleted', { tenantId: T, deletedEmail: emp.email, by: req.user.email });
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// HR-provisioned login access — the ONLY way, right now, for anyone other
// than the original one-time bootstrap admin to get a real login. Real
// production auth is meant to be the client's SSO/IdP (core/auth.js's own
// comments), which was never actually built — until it is, HR provisioning
// a password directly is the supported path for standing up additional
// test/real users, not open self-service signup. HR chooses the password
// here on the employee's behalf (this is a deliberate exception to the
// "never let anyone but the account holder choose their own password"
// principle used everywhere else in this app, e.g. core/setup.js's
// bootstrap-admin) — acceptable for now because there is no working
// self-service alternative at all; whoever receives this password should
// change it once real SSO exists.
router.post('/:employeeId/credentials', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const { password } = req.body || {};
    if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    const emp = (await db.query(`SELECT email FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, req.user.tenant_id])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    const hash = await bcrypt.hash(password, 10);
    await db.query(
      `INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash=EXCLUDED.password_hash`,
      [req.user.tenant_id, emp.email.toLowerCase(), hash]);
    logger.info('employee credentials set', { tenantId: req.user.tenant_id, email: emp.email, by: req.user.email });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assigns which permission bundle an employee's login uses (employee /
// manager / hod / hr / admin — see migrations/002-default-permission-
// bundles.js). Absence of a row here defaults to 'employee' already
// (core/auth.js's principalByEmail), so this route only needs to handle
// setting a non-default role, plus clearing back to the default.
router.put('/:employeeId/role', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const { role } = req.body || {};
    const VALID = ['employee', 'manager', 'hod', 'hr', 'admin'];
    if (!VALID.includes(role)) return res.status(400).json({ error: `role must be one of: ${VALID.join(', ')}` });
    const emp = (await db.query(`SELECT email FROM core.employees WHERE id=$1 AND tenant_id=$2`, [req.params.employeeId, req.user.tenant_id])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (role === 'employee') {
      await db.query(`DELETE FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [req.user.tenant_id, emp.email]);
    } else {
      await db.query(
        `INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, email) DO UPDATE SET role=EXCLUDED.role`,
        [req.user.tenant_id, emp.email.toLowerCase(), role]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Found live: assigning someone the "hod" role (above) grants the
// PERMISSION to open Delivery Head Review, but /hod/queue scopes what
// they actually SEE by core.department_heads (which department they
// head) — a completely separate table that nothing in this app ever
// wrote to. Setting someone's role to "hod" alone left their queue
// permanently empty ("Nothing awaiting Delivery Head review"), with no
// way for HR to fix it — this is that missing piece.
router.get('/department-heads', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const depts = (await db.query(
      `SELECT DISTINCT department FROM core.employees WHERE tenant_id=$1 AND status='active' AND department IS NOT NULL ORDER BY department`,
      [req.user.tenant_id])).rows.map((r) => r.department);
    const heads = (await db.query(
      `SELECT dh.department, dh.employee_id, e.name, e.email FROM core.department_heads dh
         JOIN core.employees e ON e.id=dh.employee_id WHERE dh.tenant_id=$1`, [req.user.tenant_id])).rows;
    const headByDept = Object.fromEntries(heads.map((h) => [h.department, h]));
    res.json({ departments: depts.map((d) => ({ department: d, head: headByDept[d] || null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/department-heads/:department', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const { employee_id } = req.body || {};
    const department = decodeURIComponent(req.params.department);
    if (!employee_id) {
      await db.query(`DELETE FROM core.department_heads WHERE tenant_id=$1 AND department=$2`, [req.user.tenant_id, department]);
      return res.json({ ok: true, department, head: null });
    }
    const emp = (await db.query(`SELECT id, name, email FROM core.employees WHERE id=$1 AND tenant_id=$2 AND status='active'`, [employee_id, req.user.tenant_id])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    await db.query(
      `INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, department) DO UPDATE SET employee_id=EXCLUDED.employee_id`,
      [req.user.tenant_id, department, employee_id]);
    // Audits inline against core.audit_log, matching this file's other two
    // audit writes (employee delete, CSV import). This line previously
    // called audit(...) — a helper that exists only in
    // modules/performance/index.js and writes to a DIFFERENT table
    // (pms.audit_log, keyed by cycle_id/employee_id) — so it threw
    // "ReferenceError: audit is not defined" on EVERY successful call.
    // Found by exercising the route against a live deploy: the
    // department head was already committed by the INSERT above, then
    // the throw was caught below and returned 500, so callers saw a
    // failure for work that had actually succeeded — and HR had no way
    // to tell the assignment stuck. Anything that reads the state
    // afterwards (GET /department-heads, the HOD queue) showed it
    // correctly, which is exactly what made it confusing.
    //
    // Logged, not thrown, for the same reason: the write it records has
    // already committed, so a failed audit insert must not turn a
    // completed assignment back into an error response.
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'DEPARTMENT_HEAD_SET','department_heads',$3,$4)`,
      [req.user.tenant_id, req.user.email, employee_id, JSON.stringify({ department })])
      .catch(e => logger.warn('department head audit failed', { error: e.message }));
    res.json({ ok: true, department, head: { employee_id: emp.id, name: emp.name, email: emp.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /employees/import  (multipart file, .csv/.xlsx/.xls) ?commit=1 to load; default DRY RUN.
router.post('/import', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
}), async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });

    const format = detectFormat(req.file);
    if (format === 'xls-legacy') {
      return res.status(400).json({ error: 'Legacy .xls files are not supported — please re-save the file as .xlsx (File > Save As > Excel Workbook) and upload again.' });
    }
    const report = format === 'xlsx'
      ? await validateEmployeeXlsx(req.file.buffer)
      : validateEmployeeCsv(req.file.buffer.toString('utf8'));
    if (report.fatal) return res.status(400).json({ error: report.fatal });
    const commit = req.query.commit === '1';
    if (!report.ok) return res.status(422).json({ ok: false, committed: false, ...report });
    if (!commit) {
      // Show the role grants the commit WOULD make. HR should see who is
      // about to gain approval rights before it happens, not discover it
      // afterwards — same reasoning as reporting per-row errors here.
      const willGrant = await pendingManagerRoleGrants(req.user.tenant_id, report.rows);
      return res.json({ ok: true, committed: false, note: 'Dry run — pass ?commit=1 to load.',
        manager_roles_to_grant: willGrant, ...report });
    }
    const loaded = await loadEmployees(req.user.tenant_id, report.rows);
    await db.query(`INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
                    VALUES ($1,$2,'EMPLOYEE_CSV_IMPORT','employees',$3)`,
      [req.user.tenant_id, req.user.email,
       JSON.stringify({ ...report.summary, manager_roles_granted: loaded.manager_roles_granted })]);
    // Granting approval rights is a permission change, so it is audited in
    // its own right rather than only as a line inside the import summary —
    // "why can this person approve" needs a queryable answer.
    for (const email of loaded.manager_roles_granted || []) {
      await db.query(`INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
                      VALUES ($1,$2,'ROLE_GRANTED','user_roles',$3,$4)`,
        [req.user.tenant_id, req.user.email, email,
         JSON.stringify({ role: 'manager', reason: 'manages someone in the imported file; had no explicit role' })]);
    }
    res.json({ ok: true, committed: true, ...loaded, warnings: report.warnings, summary: report.summary });
  } catch (e) { logger.error('employee import', { error: e.message }); res.status(500).json({ error: e.message }); }
});

module.exports = { router, validateEmployeeCsv, validateEmployeeXlsx, validateEmployeeRows, flexDate, parseCsv, parseExcelBuffer, parseExcelSheets, detectFormat, loadEmployees };
