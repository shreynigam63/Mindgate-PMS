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
//   manager_email, manager_name, hod_name,
//   date_of_joining (flexible formats), status
//
// An HRMS export can be uploaded exactly as it comes out of the HRMS:
// HEADER_ALIASES maps the names those reports actually use ("Full Name",
// "Office Email", "Reporting Manager", "HOD") onto the ones above, and
// IGNORED_COLUMNS swallows the ones the PMS has no use for. The client's
// 1,397-row report was previously refused at the header check before a
// single row was read, with nothing wrong in the data at all.
//
// validateEmployeeRows() is a PURE function — no db — so it is unit-tested
// directly and reused by the standalone tool in /tools.

const express = require('express');
const { handoverOpenRecords, handoverSummary } = require('../modules/performance/manager-handover');
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
const KNOWN = ['emp_code','name','email','department','designation','role_band',
  'manager_email','manager_name','hod_name','date_of_joining','status'];

// The header spellings an HRMS export actually uses, mapped onto the names
// above. The client's report calls them "Full Name" and "Office Email"; the
// importer called them name and email, and the whole 1,397-row file was
// rejected at the header check with "Missing required column(s): name,
// email" before a single row was read. Nothing was wrong with the data.
//
// Aliases rather than a rename, so every file that already works keeps
// working — this only widens what is recognised.
const HEADER_ALIASES = {
  employee_code: 'emp_code', employee_id: 'emp_code', emp_id: 'emp_code', empcode: 'emp_code', code: 'emp_code',
  full_name: 'name', employee_name: 'name', emp_name: 'name',
  office_email: 'email', official_email: 'email', work_email: 'email', email_id: 'email', email_address: 'email',
  job_title: 'designation',
  band: 'role_band', grade: 'role_band',
  reporting_manager: 'manager_name', reporting_manager_name: 'manager_name', manager: 'manager_name',
  managers_email: 'manager_email', manager_email_id: 'manager_email', reporting_manager_email: 'manager_email',
  hod: 'hod_name', head_of_department: 'hod_name', department_head: 'hod_name',
  doj: 'date_of_joining', joining_date: 'date_of_joining', date_of_join: 'date_of_joining',
};

// Columns the HRMS export carries that the PMS has no use for. Listed so
// they are ignored SILENTLY rather than reported as "unknown column" — an
// export with a dozen irrelevant columns would otherwise bury the warnings
// that matter under noise about ones nobody needs to act on.
//
// Date of Birth, Gender and Salutation are in here deliberately: the
// product has no feature that reads them, and the less personal data the
// appraisal system holds, the better.
const IGNORED_COLUMNS = new Set([
  'company', 'salutation', 'date_of_birth', 'dob', 'gender', 'marital_status',
  'branch', 'branchcode', 'branch_code', 'sub_department', 'site_location', 'location',
  'business_hr', 'qualification', 'currentexperiance', 'current_experience', 'experience',
  'resignation_date', 'last_working_date',
]);

// An address for someone the HRMS has no email for. .invalid is reserved by
// RFC 2606 precisely so it can never resolve or accept mail, which is the
// point: these people exist in the org chart and can be rated by their
// manager, but the address is visibly not a real one and nothing will ever
// be delivered to it. They cannot sign in until HR adds a real address.
const NO_EMAIL_DOMAIN = 'no-email.invalid';
const isPlaceholderEmail = (e) => !!e && String(e).toLowerCase().endsWith('@' + NO_EMAIL_DOMAIN);
function placeholderEmail(empCode) {
  const slug = String(empCode || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `${slug}@${NO_EMAIL_DOMAIN}` : null;
}

// Names are matched on shape, not byte-for-byte: an HRMS writes "Priya
// Menon" in one column and "Priya  Menon" in another often enough that
// exact comparison would drop reporting lines for no reason a human would
// accept.
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

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
  // Header normalisation, then aliasing: "Office Email" -> office_email ->
  // email. Done in one place so every downstream lookup uses the canonical
  // name and knows nothing about what the HRMS happened to call it.
  const header = rows[0].map((h) => {
    const norm = String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return HEADER_ALIASES[norm] || norm;
  });
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) return { ok: false, fatal: `Missing required column(s): ${missing.join(', ')}`, rows: [], errors: [], warnings: [] };
  const unknown = header.filter(h => h && !KNOWN.includes(h) && !IGNORED_COLUMNS.has(h));

  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = []; const errors = []; const warnings = [];
  const seenEmails = new Map();
  const leaverCol = idx['resignation_date'] != null ? 'resignation_date'
    : (idx['last_working_date'] != null ? 'last_working_date' : null);

  rows.slice(1).forEach((r, n) => {
    const line = n + 2; // 1-based + header
    const get = (c) => (idx[c] != null ? String(r[idx[c]] ?? '').trim() : '');
    // All whitespace stripped, not just the ends: the client's export
    // carries addresses written "amit.nandi @mindgate.in". No valid
    // unquoted address contains a space, so removing them can only ever
    // repair the value — and it is reported, so the HRMS gets fixed too.
    const emailRaw = get('email');
    const emailClean = emailRaw.replace(/\s+/g, '').toLowerCase();
    const rec = {
      line,
      emp_code: get('emp_code') || null,
      name: get('name'),
      email: emailClean,
      email_is_placeholder: false,
      department: get('department') || null,
      designation: get('designation') || null,
      role_band: get('role_band') || null,
      manager_email: get('manager_email').replace(/\s+/g, '').toLowerCase() || null,
      manager_name: get('manager_name') || null,
      hod_name: get('hod_name') || null,
      date_of_joining_raw: get('date_of_joining') || null,
      date_of_joining: flexDate(get('date_of_joining')),
      status: (get('status') || 'active').toLowerCase(),
    };
    if (!rec.name) errors.push({ line, error: 'name is empty' });
    if (emailRaw && emailClean !== emailRaw.toLowerCase()) {
      warnings.push({ line, warning: `email "${emailRaw}" contains spaces — read as "${emailClean}"; fix it in the HRMS` });
    }

    // No address, or one already claimed by an earlier row. Neither can be
    // stored as-is: the address is the sign-in identity and is unique per
    // person. A placeholder keeps them in the org chart — their manager can
    // still rate them, they still appear in every report — and the address
    // itself says plainly that it is not real.
    const clash = rec.email && seenEmails.has(rec.email) ? seenEmails.get(rec.email) : null;
    if (!rec.email || clash) {
      const ph = placeholderEmail(rec.emp_code);
      if (!ph) {
        errors.push({ line, error: clash
          ? `duplicate email "${rec.email}" (first at line ${clash}) and no employee code to derive a placeholder from`
          : 'email is empty and there is no employee code to derive a placeholder from' });
      } else if (seenEmails.has(ph)) {
        errors.push({ line, error: `employee code "${rec.emp_code}" is already used at line ${seenEmails.get(ph)}` });
      } else {
        warnings.push({ line, warning: clash
          ? `email "${rec.email}" is already used at line ${clash} — this row was given the placeholder address "${ph}" and cannot sign in until HR gives them their own`
          : `no email on record — given the placeholder address "${ph}"; this employee cannot sign in until HR adds a real one` });
        rec.email = ph;
        rec.email_is_placeholder = true;
        seenEmails.set(ph, line);
      }
    } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) {
      errors.push({ line, error: `invalid email "${rec.email}"` });
    } else {
      seenEmails.set(rec.email, line);
    }

    if (rec.date_of_joining_raw && !rec.date_of_joining) warnings.push({ line, warning: `unparseable date_of_joining "${rec.date_of_joining_raw}" — will be stored empty` });
    if (!['active', 'inactive'].includes(rec.status)) { warnings.push({ line, warning: `status "${rec.status}" not active|inactive — treated as active` }); rec.status = 'active'; }
    // A leaving date with no status column says the HRMS knows this person
    // has gone and the file does not. Importing them as active would put a
    // leaver into the next appraisal cycle, so it is said out loud rather
    // than guessed at — the file's own status column still decides.
    if (leaverCol && get(leaverCol) && rec.status === 'active' && idx['status'] == null) {
      warnings.push({ line, warning: `${leaverCol.replace(/_/g, ' ')} is set ("${get(leaverCol)}") but there is no status column — imported as active` });
    }
    out.push(rec);
  });

  // Reporting Manager as a NAME. The client's export names the manager
  // rather than addressing them, which is how an HRMS presents an org
  // chart to a human. Resolved against the Full Name column of this same
  // file, so the file stays self-contained.
  //
  // An unresolved name is a WARNING, not an error, where an unresolved
  // manager_email stays an error: an address is an exact identifier and a
  // miss means the file contradicts itself, whereas a name is a soft key
  // and a miss usually means the manager simply is not in this extract
  // (they left, or sit outside the exported population). Refusing 1,397
  // rows over 41 such names would help nobody.
  const byName = new Map();
  for (const r of out) {
    const k = normName(r.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  let resolvedByName = 0;
  for (const r of out) {
    if (!r.manager_name || r.manager_email) continue;
    const hits = byName.get(normName(r.manager_name)) || [];
    if (!hits.length) {
      warnings.push({ line: r.line, warning: `reporting manager "${r.manager_name}" is not in this file — no reporting line set` });
    } else if (hits.length > 1) {
      errors.push({ line: r.line, error: `reporting manager "${r.manager_name}" is ambiguous — ${hits.length} employees share that name; use a manager_email column for this row` });
    } else if (hits[0] === r) {
      // The HRMS points 4 people at themselves. Wrong, but the only sane
      // reading is "no manager", and the org-chart-wide "N employees have
      // no manager" warning below already makes that visible. Refusing the
      // whole file over it would be the importer being difficult rather
      // than careful. A manager_email that self-references stays an error:
      // there the file states an identity and contradicts itself.
      warnings.push({ line: r.line, warning: `reporting manager "${r.manager_name}" is this employee — no reporting line set` });
    } else {
      r.manager_email = hits[0].email;
      resolvedByName++;
    }
  }

  // HOD -> department heads. The column names the person who heads the
  // employee's department, which is exactly what fills the Delivery Head
  // Review queue — a step HR would otherwise set up by hand, per
  // department, after every import.
  const headVotes = new Map(); // department -> Map(normalised name -> {name, count})
  for (const r of out) {
    if (!r.hod_name || !r.department) continue;
    if (!headVotes.has(r.department)) headVotes.set(r.department, new Map());
    const m = headVotes.get(r.department);
    const k = normName(r.hod_name);
    if (!m.has(k)) m.set(k, { name: r.hod_name, count: 0 });
    m.get(k).count++;
  }
  // UNANIMOUS OR NOTHING. The first cut of this took the most common HOD
  // per department, which looked reasonable and was wrong: in the client's
  // own data "Development" is 226 people naming 23 different HODs, because
  // their Department is a coarse grouping and the HOD column records each
  // person's actual head within it. Taking the modal name would have put
  // 226 people into one person's Delivery Head Review queue and called it
  // configuration.
  //
  // So a head is set automatically only where every employee in the
  // department names the same one. Everywhere else the disagreement is
  // reported and HR chooses on the Department Heads screen — which is a
  // decision about who reviews whom, and not one to infer from a tally.
  const departmentHeads = [];
  const headsNeedingAChoice = [];
  for (const [department, votes] of headVotes) {
    const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
    if (ranked.length > 1) {
      headsNeedingAChoice.push({ department, candidates: ranked.map((v) => ({ name: v.name, employees: v.count })) });
      warnings.push({ line: 0, warning: `department "${department}" names ${ranked.length} different HODs — no department head set automatically; choose one on the Department Heads screen` });
      continue;
    }
    const only = ranked[0];
    const hits = byName.get(normName(only.name)) || [];
    if (!hits.length) {
      warnings.push({ line: 0, warning: `HOD "${only.name}" for department "${department}" is not in this file — no department head set` });
    } else if (hits.length > 1) {
      warnings.push({ line: 0, warning: `HOD "${only.name}" for department "${department}" is ambiguous — ${hits.length} employees share that name; no department head set` });
    } else {
      departmentHeads.push({ department, name: hits[0].name, email: hits[0].email, employees: only.count });
    }
  }

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

  const placeholders = out.filter((r) => r.email_is_placeholder);
  return { ok: errors.length === 0, fatal: null, rows: out, errors, warnings,
    department_heads: departmentHeads,
    // Departments whose HOD column disagrees with itself. Reported rather
    // than resolved, because picking between them is HR's call.
    department_heads_need_a_choice: headsNeedingAChoice,
    // Everyone who will be loaded without a working address, named, so the
    // dry run answers "who can't sign in" without reading 1,400 warnings.
    placeholder_emails: placeholders.map((r) => ({ line: r.line, emp_code: r.emp_code, name: r.name, email: r.email })),
    summary: {
      total: out.length, errors: errors.length, warnings: warnings.length,
      departments: new Set(out.map(r => r.department).filter(Boolean)).size,
      managers_resolved_by_name: resolvedByName,
      department_heads: departmentHeads.length,
      department_heads_need_a_choice: headsNeedingAChoice.length,
      placeholder_emails: placeholders.length,
    } };
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

// What the commit WOULD assign, without writing anything. Read-only by
// construction: it only calls shelfFor(), which is a SELECT.
//
// "New" is decided the same way the commit decides it — not on file yet —
// so the dry run and the commit can never disagree about who is a new hire.
async function previewAutoAssign(tenantId, rows) {
  const { shelfFor } = require('../modules/performance/kra-autoassign');
  const emails = rows.map((r) => String(r.email || '').toLowerCase());
  const known = new Set((await db.query(
    `SELECT LOWER(email) AS email FROM core.employees
      WHERE tenant_id=$1 AND LOWER(email) = ANY($2::text[])`, [tenantId, emails])).rows
      .map((r) => r.email));

  const willAssign = [];
  const noShelf = [];
  // One lookup per distinct department+designation pair, not per row: an
  // HRMS export is the whole company and most people share a shelf.
  const seen = new Map();
  for (const r of rows) {
    if (known.has(String(r.email || '').toLowerCase())) continue;
    const key = `${String(r.department || '').trim().toLowerCase()}|${String(r.designation || '').trim().toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, await shelfFor(tenantId, r));
    const shelf = seen.get(key);
    if (shelf.rows.length) {
      const total = Number(shelf.rows.reduce((s, k) => s + (Number(k.suggested_weight) || 0), 0).toFixed(2));
      willAssign.push({ email: r.email, designation: r.designation, department: r.department,
        kras: shelf.rows.length, matched_scope: shelf.scope, weight_total: total,
        weights_ok: Math.abs(total - 100) < 0.01 });
    } else {
      noShelf.push({ email: r.email, designation: r.designation, department: r.department, reason: shelf.reason });
    }
  }
  return { new_hires: willAssign.length + noShelf.length,
           kras_to_auto_assign: willAssign, kras_with_no_shelf: noShelf };
}

async function loadEmployees(tenantId, rows, opts = {}) {
  // Required here rather than at the top of the file: see the header of
  // profile-change.js for why core reaches into the performance module for
  // this one rule, and why it does so lazily.
  const { watchedChanges, reopenLockedSheets, reopenLockedGrowthPlans, reopenLockedMidyear } = require('../modules/performance/profile-change');
  const departmentHeads = Array.isArray(opts.departmentHeads) ? opts.departmentHeads : [];
  const client = await db.getClient();
  // Sheets to reopen once the import COMMITS. Collected inside the
  // transaction, acted on outside it: profile-change.js writes through the
  // pool, so calling it here would either not see this transaction's work
  // or block on its own row locks. A rolled-back import must reopen
  // nothing, which is exactly what an empty list after a throw gives.
  const reopenAfterCommit = [];
  const reopenedPlans = [];
  const reopenedMidyear = [];
  // New hires to give KRAs to, on the same after-the-commit rule and for
  // the same reason. Collected as emails because their ids do not exist
  // until pass 1 has run; resolved once, after the commit.
  const newHireEmails = [];
  try {
    await client.query('BEGIN');
    // Pass 0: what these people looked like BEFORE the file landed, so
    // pass 4 can tell a real designation change from a re-import of the
    // same values. Read once for the whole file rather than per row — an
    // HRMS export is usually the entire company, and 1,400 extra queries
    // to answer a question one query answers is not a sync, it is a
    // stall.
    const beforeByEmail = new Map((await client.query(
      `SELECT LOWER(email) AS email, id, department, designation, role_band
         FROM core.employees
        WHERE tenant_id=$1 AND LOWER(email) = ANY($2::text[])`,
      [tenantId, rows.map((r) => String(r.email || '').toLowerCase())])).rows
        .map((r) => [r.email, r]));

    // Pass 1: upsert people without manager links.
    for (const r of rows) {
      // Appearing for the first time: not in the pass-0 snapshot. The same
      // signal pass 4 uses to tell a real designation change from a
      // re-import — which is what keeps a re-import of the whole company
      // from "onboarding" everyone in it.
      if (!beforeByEmail.has(String(r.email || '').toLowerCase())) newHireEmails.push(r.email);
      await client.query(
        `INSERT INTO core.employees (tenant_id, emp_code, name, email, department, designation, role_band, date_of_joining, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, email) DO UPDATE SET
           emp_code=EXCLUDED.emp_code, name=EXCLUDED.name, department=EXCLUDED.department,
           designation=EXCLUDED.designation, role_band=EXCLUDED.role_band,
           date_of_joining=EXCLUDED.date_of_joining, status=EXCLUDED.status, updated_at=now(),
           -- BACK ON THE LIST. This is what makes "clear the list, then
           -- upload a fresh sheet" work the way it was asked for on
           -- 25 Sep: archiving takes people off the list and keeps
           -- their records on the same row, and a sheet that names
           -- them again brings the row back — with its KRA sheets,
           -- appraisals and ratings still attached. Without this line
           -- the re-uploaded person would stay invisible and the
           -- feature would look broken.
           archived_at=NULL, archived_by=NULL`,
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
    // The same handover the quick-edit route runs, through the same
    // function — widened on 24 Sep to carry the mid-year check-in, the
    // evaluation and the competency assessment as well as the KRA
    // sheet and the growth plan.
    for (const r of rows) {
      const who = (await client.query(
        `SELECT id, manager_id FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
        [tenantId, r.email])).rows[0];
      if (!who) continue;
      await handoverOpenRecords(client, tenantId, who.id, who.manager_id);
    }
    // Pass 4: a KRA sheet is written FOR a job, so a department,
    // designation or role-band change reopens a sheet the employee can no
    // longer edit — the same rule the HR quick-edit route applies, because
    // this is the path most of these changes actually arrive on.
    //
    // Only people who were ALREADY on file can have changed: someone
    // appearing for the first time has no old designation and no sheet.
    for (const r of rows) {
      const before = beforeByEmail.get(String(r.email || '').toLowerCase());
      if (!before) continue;
      const moved = watchedChanges(before,
        { department: r.department, designation: r.designation, role_band: r.role_band });
      if (moved.length) reopenAfterCommit.push({ employeeId: before.id, changes: moved });
    }
    // Grant the manager role to anyone this file shows managing someone,
    // who has no explicit role yet.
    //
    // ON CONFLICT DO NOTHING is load-bearing, not defensive: it means an
    // existing role is never touched. Without it a re-import would
    // DOWNGRADE an HR or admin who also happens to manage people, quietly
    // stripping permissions on a routine sync. Upgrades only, and only
    // into the gap.
    const heads = new Set(departmentHeads.map((h) => String(h.email).toLowerCase()));
    const grants = [];
    for (const email of managersInFile(rows)) {
      if (heads.has(email)) continue; // granted below, at the higher level
      const r = await client.query(
        `INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,'manager')
         ON CONFLICT DO NOTHING RETURNING email`, [tenantId, email]);
      if (r.rowCount) grants.push(email);
    }

    // Department heads, from the file's HOD column. This is what fills the
    // Delivery Head Review queue, and setting it by hand after every import
    // is a step HR should not have to remember.
    const headGrants = [];
    const headsSet = [];
    for (const h of departmentHeads) {
      const emp = (await client.query(
        `SELECT id FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
        [tenantId, h.email])).rows[0];
      if (!emp) continue; // the validator resolved them from this same file, so this is belt and braces
      await client.query(
        `INSERT INTO core.department_heads (tenant_id, department, employee_id) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, department) DO UPDATE SET employee_id=EXCLUDED.employee_id`,
        [tenantId, h.department, emp.id]);
      headsSet.push({ department: h.department, name: h.name, email: h.email });
      // The hod bundle is the manager bundle plus pms_hod, so moving a
      // manager up to hod only ever adds permissions. hr and admin are left
      // alone — for them it WOULD be a downgrade, which is exactly the trap
      // the manager grant's ON CONFLICT DO NOTHING exists to avoid.
      const g = await client.query(
        `INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,'hod')
         ON CONFLICT (tenant_id, email) DO UPDATE SET role='hod'
           WHERE core.user_roles.role IN ('employee','manager')
         RETURNING email`, [tenantId, h.email]);
      if (g.rowCount) headGrants.push(h.email);
    }

    await client.query('COMMIT');

    // Now the file is committed, reopen the sheets its changes invalidated.
    // One employee's failure must not lose the rest of the import, which
    // is already durable — so each is attempted on its own and reported,
    // never swallowed.
    const reopened = [];
    const reopenFailures = [];
    // The growth plan is reopened on the same rule (039), reported under
    // its own key. Two separate try/catch blocks, not one: a growth plan
    // that fails to reopen must not stop the KRA sheet reopening, and the
    // report has to be able to say which of the two went wrong.
    for (const item of reopenAfterCommit) {
      try {
        const rows2 = await reopenLockedSheets(tenantId, item.employeeId, item.changes,
          { actorEmail: opts.actorEmail || null });
        if (rows2.length) reopened.push({ employee_id: item.employeeId, changes: item.changes, sheets: rows2.length });
      } catch (e) {
        logger.error({ msg: 'kra reopen after import failed', employee_id: item.employeeId, err: e.message });
        reopenFailures.push({ employee_id: item.employeeId, error: e.message });
      }
      try {
        const plans = await reopenLockedGrowthPlans(tenantId, item.employeeId, item.changes,
          { actorEmail: opts.actorEmail || null });
        if (plans.length) reopenedPlans.push({ employee_id: item.employeeId, changes: item.changes, plans: plans.length });
      } catch (e) {
        logger.error({ msg: 'growth plan reopen after import failed', employee_id: item.employeeId, err: e.message });
        reopenFailures.push({ employee_id: item.employeeId, error: e.message, kind: 'growth_plan' });
      }
      try {
        const mid = await reopenLockedMidyear(tenantId, item.employeeId, item.changes,
          { actorEmail: opts.actorEmail || null });
        if (mid.length) reopenedMidyear.push({ employee_id: item.employeeId, changes: item.changes, checkins: mid.length });
      } catch (e) {
        logger.error({ msg: 'midyear reopen after import failed', employee_id: item.employeeId, err: e.message });
        reopenFailures.push({ employee_id: item.employeeId, error: e.message, kind: 'midyear' });
      }
    }

    // New hires get their KRAs from the library shelf for their department
    // and designation, landing in 'draft' so they review and submit them —
    // manager approval still applies, and approval needs a submission a
    // person actually made. Per employee, so one failure cannot lose the
    // rest, and EVERY skip carries a reason: an employee quietly left with
    // an empty sheet is indistinguishable from the feature not running.
    const krasAssigned = [];
    const krasNotAssigned = [];
    if (newHireEmails.length) {
      const { assignFromLibrarySafely } = require('../modules/performance/kra-autoassign');
      const ids = (await db.query(
        `SELECT id, email, name FROM core.employees
          WHERE tenant_id=$1 AND LOWER(email) = ANY($2::text[])`,
        [tenantId, newHireEmails.map((e) => String(e || '').toLowerCase())])).rows;
      for (const emp of ids) {
        const out = await assignFromLibrarySafely(tenantId, emp.id, { actorEmail: opts.actorEmail || null });
        if (out.assigned) {
          krasAssigned.push({ employee_id: emp.id, email: emp.email, kras: out.assigned,
            matched_scope: out.matched_scope, weight_total: out.weight_total, weights_ok: out.weights_ok });
        } else {
          krasNotAssigned.push({ employee_id: emp.id, email: emp.email, reason: out.reason,
            ...(out.error ? { error: out.error } : {}) });
        }
      }
    }

    return { loaded: rows.length, manager_roles_granted: grants,
             department_heads_set: headsSet, hod_roles_granted: headGrants,
             kra_sheets_reopened: reopened, growth_plans_reopened: reopenedPlans,
             midyear_reopened: reopenedMidyear, kra_reopen_failures: reopenFailures,
             new_hires: newHireEmails.length,
             kras_auto_assigned: krasAssigned, kras_not_auto_assigned: krasNotAssigned };
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

// The template HR downloads. Its headers are now the ones the HRMS export
// already produces — "Employee Code", "Full Name", "Office Email",
// "Reporting Manager", "HOD" — rather than the importer's internal names,
// so the ordinary case is: run the HRMS report, upload it, done. Every
// older spelling still imports (HEADER_ALIASES), this only changes what we
// HAND OUT.
//
// Each entry is [header, example, note]. The note goes in a second sheet
// on the .xlsx, where it can be read, rather than into the header row,
// where it would have to be deleted before upload.
const TEMPLATE_COLUMNS = [
  ['Employee Code',     'MGS1001',                  'Required if anyone has no email — the placeholder address is built from it. Must be unique.'],
  ['Full Name',         'Jane Sample',              'Required. Also how the Reporting Manager and HOD columns are matched, so spell it the same way in all three.'],
  ['Office Email',      'jane.sample@example.com',  'The sign-in address; must be unique. Leave blank only if you have no address — that person gets a placeholder and cannot sign in.'],
  ['Department',        'Engineering',              'Groups the employee for reports and for the Delivery Head review queue.'],
  ['Designation',       'Senior Software Engineer', 'Decides which KRA library shelf this employee is offered. Spell it as it appears in the KRA library.'],
  ['Reporting Manager', 'Priya Menon',              'The manager\u2019s FULL NAME as written in this same file. Leave blank for the top of the organisation.'],
  ['HOD',               'Rajesh Kulkarni',          'Head of this employee\u2019s department, by full name. Where every row in a department agrees, the department head is set automatically.'],
  ['Date of Joining',   '15/01/2024',               'dd/mm/yyyy, or yyyy-mm-dd, or a real Excel date.'],
  ['Status',            'active',                   'active or inactive. Defaults to active if the column is absent.'],
];

router.get('/import-template.csv', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [
      TEMPLATE_COLUMNS.map((c) => q(c[0])).join(','),
      TEMPLATE_COLUMNS.map((c) => q(c[1])).join(','),
    ].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="employee_import_template.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The same template as a workbook, because the HRMS export is a workbook
// and HR should not have to convert formats to compare the two. Sheet 1 is
// the sheet to fill in; sheet 2 explains every column, so the instructions
// are not sitting in a row that has to be deleted before upload.
router.get('/import-template.xlsx', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    ws.addRow(TEMPLATE_COLUMNS.map((c) => c[0]));
    ws.addRow(TEMPLATE_COLUMNS.map((c) => c[1]));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3B6F' } };
    ws.getRow(1).height = 22;
    ws.getRow(2).font = { italic: true, color: { argb: 'FF8894A8' } };
    TEMPLATE_COLUMNS.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(16, Math.min(30, c[0].length + 8)); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const help = wb.addWorksheet('How to fill this in');
    help.addRow(['Column', 'Example', 'What it is for']);
    for (const c of TEMPLATE_COLUMNS) help.addRow(c);
    help.addRow([]);
    help.addRow(['Row 2 of the Employees sheet is an example — delete it before uploading.']);
    help.addRow(['Your HRMS export can be uploaded as it comes: its own column names are recognised.']);
    help.addRow(['Columns the PMS does not use (Date of Birth, Gender, Salutation, Branch, Qualification) are ignored.']);
    help.addRow(['Upload validates first and shows you every problem row. Nothing is saved until you commit.']);
    help.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    help.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3B6F' } };
    help.getColumn(1).width = 20; help.getColumn(2).width = 26; help.getColumn(3).width = 96;
    help.getColumn(3).alignment = { wrapText: true, vertical: 'top' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="employee_import_template.xlsx"');
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
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
    // Archived people are OFF THE LIST but still on file — see 054.
    // ?include_archived=true is how HR gets at them to restore one.
    const showArchived = req.query.include_archived === 'true';
    const r = await db.query(
      `SELECT e.id, e.emp_code, e.name, e.email, e.department, e.designation, e.role_band,
              e.status, e.date_of_joining, e.archived_at, e.archived_by,
              m.name AS manager_name, m.email AS manager_email,
              (lc.email IS NOT NULL) AS has_login, COALESCE(ur.role, 'employee') AS role
         FROM core.employees e LEFT JOIN core.employees m ON m.id = e.manager_id
         LEFT JOIN core.local_credentials lc ON lc.tenant_id = e.tenant_id AND LOWER(lc.email) = LOWER(e.email)
         LEFT JOIN core.user_roles ur ON ur.tenant_id = e.tenant_id AND LOWER(ur.email) = LOWER(e.email)
        WHERE e.tenant_id = $1 ${showArchived ? '' : 'AND e.archived_at IS NULL'}
        ORDER BY e.name`, [req.user.tenant_id]);
    const archived = (await db.query(
      `SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1 AND archived_at IS NOT NULL`,
      [req.user.tenant_id])).rows[0].n;
    // Computed here rather than stored: "has no real address" is a
    // transient state that ends the moment HR adds one, and the address
    // itself already says so. One constant decides it, server-side, so the
    // page never has to know the magic domain.
    res.json({
      employees: r.rows.map((e) => ({ ...e, email_is_placeholder: isPlaceholderEmail(e.email) })),
      archived_count: archived,
      showing_archived: showArchived,
    });
  } catch (e) { logger.error('employees list', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Export the employee master.
//
// Asked for on 24 Sep: "please provide export option on this page."
//
// It exports EVERY row the list endpoint returns, not the rows left after
// whatever is typed in the page's search box. The search on that page is
// applied in the browser over several fields at once; re-implementing it
// here would be a second copy of one rule, and the two would drift. So
// the button says "Export all" and means it.
//
// emp_code is written as TEXT in the .xlsx, which is the whole reason
// this is a server-side export rather than a CSV built in the browser:
// HRMS employee codes carry leading zeros, and Excel silently eats them
// off anything it decides is a number. A code that arrives as 00123 and
// opens as 123 is a broken export nobody notices until they try to match
// it back to the HRMS.
const EXPORT_COLUMNS = [
  ['Employee ID', 'emp_code', 26],
  ['Name', 'name', 28],
  ['Email', 'email', 34],
  ['Department', 'department', 22],
  ['Designation', 'designation', 26],
  ['Role band', 'role_band', 14],
  ['Manager', 'manager_name', 26],
  ["Manager's email", 'manager_email', 34],
  ['Date of joining', 'date_of_joining', 16],
  ['Status', 'status', 12],
  ['Login', 'has_login', 10],
  ['Role', 'role', 14],
];

async function exportRows(tenantId) {
  const r = await db.query(
    `SELECT e.emp_code, e.name, e.email, e.department, e.designation, e.role_band,
            e.status, e.date_of_joining, m.name AS manager_name, m.email AS manager_email,
            (lc.email IS NOT NULL) AS has_login, COALESCE(ur.role, 'employee') AS role
       FROM core.employees e LEFT JOIN core.employees m ON m.id = e.manager_id
       LEFT JOIN core.local_credentials lc ON lc.tenant_id = e.tenant_id AND LOWER(lc.email) = LOWER(e.email)
       LEFT JOIN core.user_roles ur ON ur.tenant_id = e.tenant_id AND LOWER(ur.email) = LOWER(e.email)
      WHERE e.tenant_id = $1 ORDER BY e.name`, [tenantId]);
  return r.rows.map((e) => ({
    ...e,
    has_login: e.has_login ? 'yes' : 'no',
    date_of_joining: e.date_of_joining ? new Date(e.date_of_joining).toISOString().slice(0, 10) : '',
  }));
}

router.get('/export.xlsx', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const rows = await exportRows(req.user.tenant_id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees');
    const header = ws.addRow(EXPORT_COLUMNS.map(([label]) => label));
    header.font = { bold: true };
    for (const row of rows) {
      const added = ws.addRow(EXPORT_COLUMNS.map(([, key]) => (row[key] == null ? '' : row[key])));
      // Text, not General: see the note above about leading zeros.
      added.getCell(1).numFmt = '@';
    }
    ws.columns.forEach((col, i) => { col.width = EXPORT_COLUMNS[i][2]; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) { logger.error('employees export xlsx', { error: e.message }); res.status(500).json({ error: 'Could not build the export' }); }
});

router.get('/export.csv', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const rows = await exportRows(req.user.tenant_id);
    const cell = (v) => {
      const t = String(v == null ? '' : v).replace(/\s*\n\s*/g, ' ');
      return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const csv = [EXPORT_COLUMNS.map(([label]) => label),
      ...rows.map((row) => EXPORT_COLUMNS.map(([, key]) => row[key]))]
      .map((r) => r.map(cell).join(',')).join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM: without it Excel opens a UTF-8 CSV as Windows-1252 and mangles
    // every non-ASCII name in the file.
    res.send('\uFEFF' + csv);
  } catch (e) { logger.error('employees export csv', { error: e.message }); res.status(500).json({ error: 'Could not build the export' }); }
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
    // department/designation/role_band are read BEFORE the update so the
    // reopen below can compare. Reading them after would compare a value
    // with itself and never reopen anything.
    const emp = (await db.query(
      `SELECT id, email, department, designation, role_band FROM core.employees WHERE id=$1 AND tenant_id=$2`,
      [req.params.employeeId, req.user.tenant_id])).rows[0];
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

    // BR-1.5 propagation, widened on 24 Sep: "Reporting manager change
    // will also lead to open KRA changes." It always moved the KRA
    // sheet and the growth plan; it did NOT move the mid-year
    // check-in, the evaluation or the competency assessment, so half a
    // person's records stayed with a manager who no longer managed
    // them. One shared function now, used by this route and by the
    // bulk importer, so the two cannot drift again — see
    // modules/performance/manager-handover.js for what moves and why
    // submitted work does not.
    const handedOver = await handoverOpenRecords(db, req.user.tenant_id, emp.id, managerId);

    // A KRA sheet is written FOR a job. Changing the job reopens a sheet
    // the employee can no longer edit, so they can refill it against the
    // role they now hold. A manager change does NOT reopen anything — the
    // objectives are the same, just reviewed by someone else.
    const { applyProfileChange } = require('../modules/performance/profile-change');
    const moved = await applyProfileChange(req.user.tenant_id, emp.id, emp,
      { department, designation, role_band }, { actorEmail: req.user.email });

    // Said out loud rather than done quietly: HR changed one field and a
    // submitted sheet went back to the employee as a side effect.
    res.json({ ok: true,
      reopened_kra_sheets: moved.reopened.length,
      reopened_growth_plans: (moved.reopened_growth_plans || []).length,
      reopened_midyear: (moved.reopened_midyear || []).length,
      // Said out loud too: a reassignment that quietly moved nine
      // records between two people's queues should say which.
      handed_over: handedOver,
      handover_message: handoverSummary(handedOver),
      changes: moved.changes });
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
// EVERYTHING that has to go before an employee row can. Lifted out of
// the single-delete route on 25 Sep so the bulk delete added the same
// day runs the identical sequence — two copies of a 30-statement
// cascade is two things to keep in step, and the one that gets
// forgotten leaves orphan rows behind a foreign key.
//
// Takes a client, not the pool: every caller wraps this in its own
// transaction, because a half-deleted employee is worse than none.
async function purgeEmployee(client, tenantId, emp) {
  const id = emp.id;
    // ---- Nullable manager-style references: preserve the OTHER employee's record ----
    await client.query(`UPDATE core.employees SET manager_id=NULL WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, id]);
    await client.query(`UPDATE pms.kra_sheets SET manager_id=NULL WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, id]);
    await client.query(`UPDATE pms.development_plans SET manager_id=NULL WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, id]);
    await client.query(`UPDATE people.award_nominations SET nominated_by=NULL WHERE tenant_id=$1 AND nominated_by=$2`, [tenantId, id]);

    // ---- NOT NULL manager-style references: the specific review row can't survive without one ----
    await client.query(`DELETE FROM pms.manager_evaluations WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.hod_evaluations WHERE tenant_id=$1 AND hod_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.connects WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.connect_reminders_log WHERE tenant_id=$1 AND manager_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM people.award_nominations WHERE tenant_id=$1 AND nominated_by=$2`, [tenantId, id]);

    // ---- This employee's OWN records — cascades handle child rows
    // automatically (pms.kras via sheet_id, pms.evidence via appraisal_id,
    // pms.development_goals via plan_id, pms.pip_weekly_entries via pip_id,
    // people.appraisal_query_messages via query_id — all ON DELETE CASCADE). ----
    await client.query(`DELETE FROM core.department_heads WHERE employee_id=$1`, [id]);
    await client.query(`DELETE FROM core.notifications WHERE employee_id=$1`, [id]);
    await client.query(`DELETE FROM core.employee_consents WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.kra_sheets WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.self_appraisals WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.manager_evaluations WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.hod_evaluations WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.top_talent WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.pip_records WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.employee_performance_history WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.closure_letters WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.parameter_scores WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.development_plans WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.connect_reminders_log WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM pms.pulse_checks WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM people.career_paths WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM engagement.invitations WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM engagement.responses WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM people.event_rsvps WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM people.csr_participations WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM people.appraisal_queries WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, id]);
    await client.query(`DELETE FROM people.award_nominations WHERE tenant_id=$1 AND nominee_id=$2`, [tenantId, id]);

    // ---- Login/permission rows, keyed by email not id ----
    await client.query(`DELETE FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [tenantId, emp.email]);
    await client.query(`DELETE FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [tenantId, emp.email]);
    await client.query(`DELETE FROM core.user_permissions WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [tenantId, emp.email]);
  await client.query(`DELETE FROM core.employees WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
}

// Add ONE person by hand. Asked for on 25 Sep: "add option for adding
// single employee as currently we don't have any integration to HRMS
// software." Until there is one, the only way in was a spreadsheet, and
// a spreadsheet for one new joiner is a spreadsheet nobody makes — so
// they get added late, or not at all.
//
// The same validation as the importer, deliberately: one employee added
// here and one added by a one-row upload must end up as the same
// record, or the two paths drift and the second one starts producing
// people the first would have refused.
router.post('/', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const T = req.user.tenant_id;
    const b = req.body || {};
    const str = (k) => String(b[k] == null ? '' : b[k]).trim();
    const name = str('name');
    const email = str('email').toLowerCase();
    if (!name) return res.status(422).json({ error: 'Full name is required' });
    if (!email && !str('emp_code')) {
      return res.status(422).json({ error: 'An office email is required — or an employee code, which a placeholder address is built from' });
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(422).json({ error: `"${email}" is not an email address` });
    }
    // flexDate's last resort is `new Date(s)`, which is generous enough
    // to read "the 4th" as April 2001 — fine for an HRMS export, where
    // a loose parser rescues a column somebody formatted oddly, and not
    // fine for a single typed field where a silent 2001 join date later
    // reads as somebody with 25 years' service on the eligibility rule.
    // So this accepts the shapes the template documents and nothing
    // else. The importer is deliberately left as it is.
    const rawDoj = str('date_of_joining');
    const DATE_SHAPES = [
      /^\d{4}-\d{1,2}-\d{1,2}$/,                       // 2026-07-01
      /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/,            // 01/07/2026
      /^\d{1,2}[-\s]+[A-Za-z]{3,}[-\s,]+\d{2,4}$/,      // 01-Jul-2026
    ];
    const doj = rawDoj ? flexDate(rawDoj) : null;
    if (rawDoj && (!doj || !DATE_SHAPES.some((re) => re.test(rawDoj)))) {
      return res.status(422).json({ error: `"${rawDoj}" is not a date — use dd/mm/yyyy, yyyy-mm-dd or dd-Mon-yyyy` });
    }
    const address = email || `${str('emp_code').toLowerCase().replace(/[^a-z0-9]+/g, '')}@${NO_EMAIL_DOMAIN}`;

    const clash = (await db.query(
      `SELECT name FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [T, address])).rows[0];
    if (clash) return res.status(409).json({ error: `${clash.name} already has that email address` });
    if (str('emp_code')) {
      const dupCode = (await db.query(
        `SELECT name FROM core.employees WHERE tenant_id=$1 AND LOWER(emp_code)=LOWER($2)`, [T, str('emp_code')])).rows[0];
      if (dupCode) return res.status(409).json({ error: `${dupCode.name} already has employee code ${str('emp_code')}` });
    }

    // The manager is named by email, and an address that is not on file
    // is REFUSED rather than quietly ignored — an employee silently
    // created with no reporting line is how somebody ends up invisible
    // to every manager screen in the product.
    let managerId = null;
    if (str('manager_email')) {
      const m = (await db.query(
        `SELECT id FROM core.employees WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [T, str('manager_email')])).rows[0];
      if (!m) return res.status(422).json({ error: `No employee on file with the email ${str('manager_email')} — add the manager first, or leave it blank` });
      managerId = m.id;
    }

    const row = (await db.query(
      `INSERT INTO core.employees (tenant_id, emp_code, name, email, department, designation, role_band, date_of_joining, manager_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')
       RETURNING id, emp_code, name, email, department, designation, role_band, date_of_joining, status`,
      [T, str('emp_code') || null, name, address, str('department') || null, str('designation') || null,
        str('role_band') || null, doj, managerId])).rows[0];

    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'EMPLOYEE_ADDED','employees',$3,$4)`,
      [T, req.user.email, row.id, JSON.stringify({ name: row.name, email: row.email, added_by_hand: true })]);
    logger.info('employee added by hand', { tenantId: T, email: row.email, by: req.user.email });
    res.status(201).json({ ok: true, employee: row, placeholder_email: isPlaceholderEmail(row.email) });
  } catch (e) { logger.error('employee add', { error: e.message }); res.status(500).json({ error: e.message }); }
});

// Take a SELECTION, or the whole list, OFF THE LIST. Asked for on
// 25 Sep: "there should be delete list option for deleting employee so
// we can upload new fresh sheet again", and refined the same day:
// "Delete employees option should only delete employees list and not
// rest of the strings attached to it currently."
//
// So this ARCHIVES. The employee row stays, keeps its id, and keeps
// every KRA sheet, appraisal, evaluation, connect and rating hanging
// off that id — see 054 for why deleting the row would have destroyed
// or orphaned all of it rather than preserving it.
//
// What archiving does:
//   * the row leaves the Employees list
//   * status becomes 'inactive', so it leaves every other screen too —
//     73 queries across the product already filter status='active'
//   * re-uploading a sheet containing that email brings them back,
//     with their history, because it is the same row
//
// The signed-in admin is still never in the blast radius: archiving
// yourself takes you off the list you are administering.
router.delete('/', async (req, res) => {
  const client = await db.getClient();
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const T = req.user.tenant_id;
    const body = req.body || {};
    const have = (await db.query(
      `SELECT count(*)::int AS n FROM core.employees WHERE tenant_id=$1 AND archived_at IS NULL`, [T])).rows[0].n;

    let targets;
    let cleared = false;
    if (Array.isArray(body.ids)) {
      if (!body.ids.length) return res.status(422).json({ error: 'No employees were selected.' });
      targets = (await db.query(
        `SELECT id, name, email FROM core.employees
          WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [T, body.ids])).rows;
    } else if (body.confirm_count != null) {
      if (!have) return res.status(409).json({ error: 'There are no employees on the list' });
      if (Number(body.confirm_count) !== have) {
        return res.status(409).json({
          error: `The list holds ${have} employees, not ${body.confirm_count} — it changed since the page loaded. Reload and try again.`,
          have,
        });
      }
      targets = (await db.query(
        `SELECT id, name, email FROM core.employees WHERE tenant_id=$1 AND archived_at IS NULL`, [T])).rows;
      cleared = true;
    } else {
      return res.status(422).json({
        error: 'Send ids to remove a selection, or confirm_count to clear the whole list', have,
      });
    }

    const skippedSelf = targets.some((t) => t.id === req.user.id);
    targets = targets.filter((t) => t.id !== req.user.id);
    if (!targets.length) {
      return res.status(422).json({ error: 'The only account selected is your own, which cannot be removed while you are signed in as it.' });
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
       VALUES ($1,$2,$3,'employees',$4)`,
      [T, req.user.email, cleared ? 'EMPLOYEE_LIST_CLEARED' : 'EMPLOYEES_ARCHIVED',
        JSON.stringify({ count: targets.length, cleared, kept_self: skippedSelf, archived: true,
          emails: targets.slice(0, 50).map((t) => t.email) })]);
    // Their login goes with them — somebody off the list must not be
    // able to sign in — but the ROW and everything attached to it stays.
    const ids = targets.map((t) => t.id);
    const emails = targets.map((t) => t.email.toLowerCase());
    await client.query(
      `UPDATE core.employees SET archived_at=now(), archived_by=$3, status='inactive', updated_at=now()
        WHERE tenant_id=$1 AND id = ANY($2::uuid[])`, [T, ids, req.user.email]);
    await client.query(
      `DELETE FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email) = ANY($2::text[])`, [T, emails]);
    await client.query('COMMIT');

    logger.warn('employees archived', { tenantId: T, archived: targets.length, cleared, by: req.user.email });
    res.json({
      ok: true, removed: targets.length, archived: targets.length, cleared, kept_self: skippedSelf,
      note: 'Removed from the list. Their KRA sheets, appraisals and ratings are kept — re-upload a sheet with the same email to bring them back. Their login is removed and is not restored automatically.',
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('employee bulk archive', { error: e.message });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Put an archived employee back on the list. The other half of 054 —
// without it, "removed from the list" is indistinguishable from gone,
// and a mis-click has no way back.
router.post('/:employeeId/restore', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const T = req.user.tenant_id;
    const r = await db.query(
      `UPDATE core.employees SET archived_at=NULL, archived_by=NULL, status='active', updated_at=now()
        WHERE tenant_id=$1 AND id=$2 AND archived_at IS NOT NULL RETURNING id, name, email`,
      [T, req.params.employeeId]);
    if (!r.rows.length) return res.status(404).json({ error: 'No archived employee with that id' });
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'EMPLOYEE_RESTORED','employees',$3,$4)`,
      [T, req.user.email, r.rows[0].id, JSON.stringify({ email: r.rows[0].email })]);
    // THE LOGIN DOES NOT COME BACK. Removing somebody deletes their
    // credential, and a password cannot be un-deleted — so restoring
    // the record has to say so, or HR restores a person, tells them
    // to sign in, and the person cannot. Caught by the demo tenant's
    // own browser tests going red after a manual archive.
    const hasLogin = !!(await db.query(
      `SELECT 1 FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [T, r.rows[0].email])).rows[0];
    res.json({
      ok: true,
      employee: r.rows[0],
      has_login: hasLogin,
      note: hasLogin ? 'Back on the list.'
        : 'Back on the list, with their records. Their login was removed when they came off it — grant a new password under Manage if they need to sign in.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One person, off the list — or, with ?purge=1, genuinely erased.
//
// The DEFAULT changed on 25 Sep to match the bulk route: "Delete
// employees option should only delete employees list and not rest of
// the strings attached to it currently." So the bin on a row now
// archives, and their record survives.
//
// ?purge=1 keeps the old behaviour, because two real cases need it: a
// GDPR erasure request, and a test row somebody typed by mistake that
// should leave no trace. It runs purgeEmployee, which is the
// 30-statement cascade, and it says what it destroyed.
router.delete('/:employeeId', async (req, res) => {
  const client = await db.getClient();
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const T = req.user.tenant_id;
    const id = req.params.employeeId;
    const purge = req.query.purge === '1';
    const emp = (await db.query(`SELECT id, name, email, archived_at FROM core.employees WHERE id=$1 AND tenant_id=$2`, [id, T])).rows[0];
    if (!emp) return res.status(404).json({ error: 'employee not found' });
    if (emp.id === req.user.id) {
      return res.status(422).json({ error: `You cannot ${purge ? 'delete' : 'remove'} your own account while signed in as them.` });
    }

    if (!purge) {
      if (emp.archived_at) return res.status(409).json({ error: `${emp.name} is already off the list` });
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
         VALUES ($1,$2,'EMPLOYEE_ARCHIVED','employees',$3,$4)`,
        [T, req.user.email, id, JSON.stringify({ name: emp.name, email: emp.email })]);
      await client.query(
        `UPDATE core.employees SET archived_at=now(), archived_by=$3, status='inactive', updated_at=now()
          WHERE tenant_id=$1 AND id=$2`, [T, id, req.user.email]);
      await client.query(`DELETE FROM core.local_credentials WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [T, emp.email]);
      await client.query('COMMIT');
      logger.info('employee archived', { tenantId: T, email: emp.email, by: req.user.email });
      return res.json({
        ok: true, archived: true,
        note: 'Removed from the list. Their KRA sheets, appraisals and ratings are kept — re-upload a sheet with the same email to bring them back. Their login is removed and is not restored automatically.',
      });
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'EMPLOYEE_PURGED','employees',$3,$4)`,
      [T, req.user.email, id, JSON.stringify({ name: emp.name, email: emp.email, permanent: true })]);
    await purgeEmployee(client, T, emp);
    await client.query('COMMIT');
    logger.warn('employee purged', { tenantId: T, deletedEmail: emp.email, by: req.user.email });
    res.json({ ok: true, purged: true });
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
    // The role before the change, for the same reason the edit route reads
    // the old designation first.
    const was = (await db.query(
      `SELECT role FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`,
      [req.user.tenant_id, emp.email])).rows[0];
    // No row means 'employee' — principalByEmail defaults it — so a first
    // grant of 'manager' is a change from 'employee', not from nothing.
    const before = (was && was.role) || 'employee';

    if (role === 'employee') {
      await db.query(`DELETE FROM core.user_roles WHERE tenant_id=$1 AND LOWER(email)=LOWER($2)`, [req.user.tenant_id, emp.email]);
    } else {
      await db.query(
        `INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, email) DO UPDATE SET role=EXCLUDED.role`,
        [req.user.tenant_id, emp.email.toLowerCase(), role]);
    }

    // "role" in the client's request covers this one too: an employee
    // promoted to manager is doing a different job, and their submitted
    // KRAs describe the old one.
    let reopened = [];
    let reopenedPlans = [];
    let reopenedMid = [];
    if (before !== role) {
      const { reopenLockedSheets, reopenLockedGrowthPlans, reopenLockedMidyear } = require('../modules/performance/profile-change');
      const changes = [{ field: 'Role', from: before, to: role }];
      reopened = await reopenLockedSheets(req.user.tenant_id, req.params.employeeId,
        changes, { actorEmail: req.user.email });
      // The growth plan goes back too (039): a plan aimed at growing into
      // the old role is the same kind of wrong as objectives written for it.
      reopenedPlans = await reopenLockedGrowthPlans(req.user.tenant_id, req.params.employeeId,
        changes, { actorEmail: req.user.email });
      // And the mid-year review (040) — a halfway reading of the old job.
      reopenedMid = await reopenLockedMidyear(req.user.tenant_id, req.params.employeeId,
        changes, { actorEmail: req.user.email });
    }
    res.json({ ok: true, reopened_kra_sheets: reopened.length,
      reopened_growth_plans: reopenedPlans.length, reopened_midyear: reopenedMid.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Found live: assigning someone the "hod" role (above) grants the
// PERMISSION to open Delivery Head Review, but /hod/queue scopes what
// they actually SEE by core.department_heads (which department they
// head) — a completely separate table that nothing in this app ever
// wrote to. Setting someone's role to "hod" alone left their queue
// permanently empty ("Nothing awaiting Delivery Head review"), with no
// way for HR to fix it — this is that missing piece.
// The list is the UNION of two things, and the distinction is shown rather
// than smoothed over:
//
//   in_use     — at least one active employee is filed under it. Cannot be
//                removed; removing it would orphan those people.
//   registered — HR added it (migration 038) and nobody is in it yet.
//                Removable, and assignable a head in advance.
//
// Derived-only was the old behaviour and it meant a department could not be
// set up before its first hire, and a typo from one HRMS import could never
// be taken off the page.
router.get('/department-heads', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const rows = (await db.query(
      `WITH held AS (
         SELECT btrim(department) AS name, count(*)::int AS employees
           FROM core.employees
          WHERE tenant_id=$1 AND status='active' AND coalesce(btrim(department),'') <> ''
          GROUP BY btrim(department)
       ), registered AS (
         SELECT btrim(name) AS name FROM core.departments WHERE tenant_id=$1
       ), all_names AS (
         SELECT name FROM held UNION SELECT name FROM registered
       )
       SELECT a.name AS department,
              coalesce(h.employees, 0) AS employees,
              (h.name IS NOT NULL) AS in_use,
              (r.name IS NOT NULL) AS registered
         FROM all_names a
         LEFT JOIN held h       ON lower(h.name) = lower(a.name)
         LEFT JOIN registered r ON lower(r.name) = lower(a.name)
        ORDER BY a.name`, [req.user.tenant_id])).rows;
    const heads = (await db.query(
      `SELECT dh.department, dh.employee_id, e.name, e.email FROM core.department_heads dh
         JOIN core.employees e ON e.id=dh.employee_id WHERE dh.tenant_id=$1`, [req.user.tenant_id])).rows;
    // Matched case-insensitively: a head may have been assigned against
    // "Finance" while employees carry "finance", and the page must show one
    // line with the head on it rather than two lines disagreeing.
    const headByDept = new Map(heads.map((h) => [String(h.department).trim().toLowerCase(), h]));
    res.json({
      departments: rows.map((d) => ({
        department: d.department,
        employees: d.employees,
        in_use: d.in_use,
        registered: d.registered,
        removable: !d.in_use,
        head: headByDept.get(String(d.department).trim().toLowerCase()) || null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a department before anybody is in it.
router.post('/departments', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const name = String((req.body && req.body.name) == null ? '' : req.body.name).trim();
    if (!name) return res.status(422).json({ error: 'A department needs a name' });
    if (name.length > 120) return res.status(422).json({ error: `That name is ${name.length} characters — keep it under 120` });

    // Already there, either registered or held by an employee. Said plainly
    // with which of the two it is, because "already exists" on a name HR
    // cannot see in the list is the confusing version.
    const held = (await db.query(
      `SELECT count(*)::int AS n FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND lower(btrim(coalesce(department,'')))=lower($2)`,
      [req.user.tenant_id, name])).rows[0].n;
    const reg = (await db.query(
      `SELECT name FROM core.departments WHERE tenant_id=$1 AND lower(btrim(name))=lower($2)`,
      [req.user.tenant_id, name])).rows[0];
    if (reg) return res.status(409).json({ error: `"${reg.name}" is already on the list` });
    if (held) {
      // Not registered but employees are in it — register it rather than
      // refusing, so the name stops being derived-only and becomes
      // manageable. Nothing about the employees changes.
      await db.query(`INSERT INTO core.departments (tenant_id, name, created_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [req.user.tenant_id, name, req.user.email]);
      return res.json({ ok: true, department: name, employees: held, note: `${held} employee${held === 1 ? '' : 's'} already in it` });
    }

    await db.query(`INSERT INTO core.departments (tenant_id, name, created_by) VALUES ($1,$2,$3)`,
      [req.user.tenant_id, name, req.user.email]);
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'DEPARTMENT_ADDED','departments',NULL,$3)`,
      [req.user.tenant_id, req.user.email, JSON.stringify({ department: name })])
      .catch(e => logger.warn('department add audit failed', { error: e.message }));
    res.json({ ok: true, department: name, employees: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a department. REFUSED while anybody is still in it — the whole
// point of the rule is that removing a department must never quietly leave
// employees pointing at something that is no longer on the list. The refusal
// says how many, because that is the number HR has to act on.
router.delete('/departments/:department', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'people_admin'))) return res.status(403).json({ error: "Requires 'people_admin'" });
    const name = decodeURIComponent(req.params.department).trim();
    if (!name) return res.status(422).json({ error: 'Which department?' });

    const held = (await db.query(
      `SELECT count(*)::int AS n FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND lower(btrim(coalesce(department,'')))=lower($2)`,
      [req.user.tenant_id, name])).rows[0].n;
    if (held) {
      return res.status(409).json({
        error: `${held} active employee${held === 1 ? ' is' : 's are'} still in "${name}" — move them to another department first`,
        employees: held,
      });
    }

    const gone = await db.query(
      `DELETE FROM core.departments WHERE tenant_id=$1 AND lower(btrim(name))=lower($2)`,
      [req.user.tenant_id, name]);
    // The head mapping goes with it. Leaving it behind would resurrect the
    // department on the next read of core.department_heads and hand a
    // Delivery Head a queue for something that no longer exists.
    const headGone = await db.query(
      `DELETE FROM core.department_heads WHERE tenant_id=$1 AND lower(btrim(department))=lower($2)`,
      [req.user.tenant_id, name]);
    if (!gone.rowCount && !headGone.rowCount) return res.status(404).json({ error: `"${name}" is not on the list` });

    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
       VALUES ($1,$2,'DEPARTMENT_REMOVED','departments',NULL,$3)`,
      [req.user.tenant_id, req.user.email, JSON.stringify({ department: name, head_cleared: headGone.rowCount > 0 })])
      .catch(e => logger.warn('department remove audit failed', { error: e.message }));
    res.json({ ok: true, department: name, head_cleared: headGone.rowCount > 0 });
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
      const heads = new Set((report.department_heads || []).map((h) => h.email.toLowerCase()));
      const willGrant = (await pendingManagerRoleGrants(req.user.tenant_id, report.rows))
        .filter((e) => !heads.has(e));
      // …and the KRAs the commit WOULD assign, on exactly the same
      // reasoning. A 1,400-row file that silently writes eight objectives
      // per new hire is the kind of surprise a dry run exists to prevent,
      // and this is also where HR finds out a designation has no shelf
      // BEFORE those people are sitting in the system with empty sheets.
      const krasToAssign = await previewAutoAssign(req.user.tenant_id, report.rows);
      return res.json({ ok: true, committed: false, note: 'Dry run — pass ?commit=1 to load.',
        manager_roles_to_grant: willGrant, hod_roles_to_grant: [...heads],
        ...krasToAssign, ...report });
    }
    const loaded = await loadEmployees(req.user.tenant_id, report.rows,
      { departmentHeads: report.department_heads, actorEmail: req.user.email });
    await db.query(`INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
                    VALUES ($1,$2,'EMPLOYEE_CSV_IMPORT','employees',$3)`,
      [req.user.tenant_id, req.user.email,
       JSON.stringify({ ...report.summary, manager_roles_granted: loaded.manager_roles_granted,
                        hod_roles_granted: loaded.hod_roles_granted })]);
    // Granting approval rights is a permission change, so it is audited in
    // its own right rather than only as a line inside the import summary —
    // "why can this person approve" needs a queryable answer.
    for (const email of loaded.manager_roles_granted || []) {
      await db.query(`INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
                      VALUES ($1,$2,'ROLE_GRANTED','user_roles',$3,$4)`,
        [req.user.tenant_id, req.user.email, email,
         JSON.stringify({ role: 'manager', reason: 'manages someone in the imported file; had no explicit role' })]);
    }
    for (const email of loaded.hod_roles_granted || []) {
      await db.query(`INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, entity_id, details)
                      VALUES ($1,$2,'ROLE_GRANTED','user_roles',$3,$4)`,
        [req.user.tenant_id, req.user.email, email,
         JSON.stringify({ role: 'hod', reason: 'named as the HOD of a department in the imported file' })]);
    }
    for (const h of loaded.department_heads_set || []) {
      await db.query(`INSERT INTO core.audit_log (tenant_id, actor_email, action, entity, details)
                      VALUES ($1,$2,'DEPARTMENT_HEAD_SET','department_heads',$3)`,
        [req.user.tenant_id, req.user.email,
         JSON.stringify({ department: h.department, head: h.email, source: 'HOD column of the imported file' })]);
    }
    res.json({ ok: true, committed: true, ...loaded,
      warnings: report.warnings, summary: report.summary,
      placeholder_emails: report.placeholder_emails,
      department_heads_need_a_choice: report.department_heads_need_a_choice });
  } catch (e) { logger.error('employee import', { error: e.message }); res.status(500).json({ error: e.message }); }
});

module.exports = { router, validateEmployeeCsv, validateEmployeeXlsx, validateEmployeeRows, flexDate, parseCsv, parseExcelBuffer, parseExcelSheets, detectFormat, loadEmployees, HEADER_ALIASES, NO_EMAIL_DOMAIN, isPlaceholderEmail, TEMPLATE_COLUMNS };
