// Bulk upload for the Career Pathing Matrix.
//
// Asked for on 17 Sep: "can we have template upload option so HR can
// upload template for next defined roles." The matrix is built one
// transition at a time through the New transition modal, and a company
// with 90 job titles on file has hundreds of sensible next steps — that
// is an afternoon of clicking, and no way to review the whole ladder
// before committing it.
//
// Same two-step shape HR already knows from the KRA Library: download a
// template, fill it in, Validate (writes nothing, reports every bad row
// at once), then Publish. Pure — no db, no express — so the row rules
// can be tested directly, which is where the bugs in an importer live.

// The spreadsheet columns, in order, and what each maps to. The labels
// match the New transition modal's field names so somebody filling the
// sheet recognises them from the screen they already use.
const COLUMNS = [
  ['from_role', 'From Role'],
  ['from_level', 'From Level'],
  ['to_role', 'To Role'],
  ['to_level', 'To Level'],
  ['expected_level_change', 'Expected Level Change'],
  ['min_time_months', 'Min Time In Current Role (Months)'],
  ['typical_time_months', 'Typical Time In Current Role (Months)'],
  ['required_competencies', 'Required Competencies'],
  ['notes', 'Notes'],
];

// Header matching is forgiving on purpose: HR re-saves these files
// through Excel and Google Sheets, which rewrite spacing and case, and a
// file rejected wholesale for "Min Time in Role (months)" teaches nobody
// anything. Everything non-alphanumeric is dropped before comparing.
const key = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = new Map();
for (const [field, label] of COLUMNS) ALIASES.set(key(label), field);
for (const [alias, field] of [
  ['fromdesignation', 'from_role'], ['currentrole', 'from_role'], ['role', 'from_role'],
  ['todesignation', 'to_role'], ['nextrole', 'to_role'], ['targetrole', 'to_role'],
  ['fromband', 'from_level'], ['currentlevel', 'from_level'],
  ['toband', 'to_level'], ['nextlevel', 'to_level'], ['targetlevel', 'to_level'],
  ['levelchange', 'expected_level_change'], ['expectedlevelchange', 'expected_level_change'],
  ['mintimemonths', 'min_time_months'], ['mintimeinrolemonths', 'min_time_months'],
  ['minmonths', 'min_time_months'],
  ['typicaltimemonths', 'typical_time_months'], ['typicaltimeinrolemonths', 'typical_time_months'],
  ['typicalmonths', 'typical_time_months'],
  ['competencies', 'required_competencies'], ['requiredcompetency', 'required_competencies'],
  ['skills', 'required_competencies'],
  ['note', 'notes'], ['comments', 'notes'],
]) ALIASES.set(alias, field);

const txt = (v) => String(v == null ? '' : v).trim();

// One competency per line in the modal. A spreadsheet cell can hold
// newlines, but a CSV round-trip usually flattens them, so ; and | are
// accepted too — HR should not have to know which of the three their
// tool survived.
function competencies(cell) {
  return txt(cell).split(/[\n;|]+/).map((s) => s.trim()).filter(Boolean);
}

// Integers only, and a blank is a legitimate "not specified" rather than
// a zero. "12 months" and "+1" are accepted because people write them.
function wholeNumber(cell, label, line, errors) {
  const raw = txt(cell);
  if (!raw) return null;
  const m = raw.match(/^([+-]?\d+)(\s*months?)?$/i);
  if (!m) {
    errors.push({ line, error: `${label} must be a whole number — got "${raw}"` });
    return null;
  }
  return Number(m[1]);
}

// The identity of a transition: which step on the ladder it describes.
// Case- and space-insensitive, because "Senior  Manager" and "senior
// manager" are the same rung and publishing both would put two identical
// arrows on the matrix.
const norm = (v) => txt(v).toLowerCase().replace(/\s+/g, ' ');
const rung = (role, level) => `${norm(role)}@${norm(level)}`;
const rowKey = (r) => `${rung(r.from_role, r.from_level)} → ${rung(r.to_role, r.to_level)}`;

// rows: array of arrays, first non-empty row is the header.
// knownRoles: lower-cased designations actually on file — used for
// warnings only, never to reject.
//
// Returns { ok, fatal, rows, errors, warnings, summary }, the same shape
// the KRA importers return, so the page can render the report with the
// component it already has.
function validateCareerTransitionRows(rows, knownRoles = new Set()) {
  const out = [];
  const errors = [];
  const warnings = [];
  const empty = { ok: false, rows: [], errors: [], warnings: [],
    summary: { total_rows: 0, errors: 0, warnings: 0, create: 0, update: 0 } };

  if (!Array.isArray(rows) || !rows.length) return { ...empty, fatal: 'Empty file' };

  // Find the header rather than assuming row 1: these files often carry a
  // title or an instruction banner above the table, and the template this
  // app produces has one.
  let headerAt = -1;
  let idx = null;
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i] || [];
    const map = {};
    for (let c = 0; c < cells.length; c++) {
      const f = ALIASES.get(key(cells[c]));
      if (f && map[f] == null) map[f] = c;
    }
    if (map.from_role != null && map.to_role != null) { headerAt = i; idx = map; break; }
  }
  if (headerAt === -1) {
    return { ...empty, fatal: 'Could not find the header row — it must contain at least "From Role" and "To Role".' };
  }

  const seen = new Map();
  for (let i = headerAt + 1; i < rows.length; i++) {
    const cells = rows[i] || [];
    const line = i + 1;                       // 1-based, as the spreadsheet shows it
    const get = (f) => (idx[f] != null ? txt(cells[idx[f]]) : '');
    // A row with nothing in it is a spacer, not a mistake.
    if (!cells.some((c) => txt(c))) continue;

    const fromRole = get('from_role');
    const toRole = get('to_role');
    if (!fromRole || !toRole) {
      errors.push({ line, error: 'From Role and To Role are both required' });
      continue;
    }

    const rec = {
      line,
      from_role: fromRole,
      from_level: get('from_level') || null,
      to_role: toRole,
      to_level: get('to_level') || null,
      expected_level_change: wholeNumber(get('expected_level_change'), 'Expected Level Change', line, errors),
      min_time_months: wholeNumber(get('min_time_months'), 'Min Time In Current Role', line, errors),
      typical_time_months: wholeNumber(get('typical_time_months'), 'Typical Time In Current Role', line, errors),
      required_competencies: competencies(get('required_competencies')),
      notes: get('notes') || null,
    };

    // A transition from a rung to itself is not a step, and the matrix
    // would render an arrow pointing at its own tail.
    if (rung(rec.from_role, rec.from_level) === rung(rec.to_role, rec.to_level)) {
      errors.push({ line, error: `"${fromRole}" moves to itself — a transition needs a different role or level` });
      continue;
    }

    const k = rowKey(rec);
    if (seen.has(k)) {
      errors.push({ line, error: `duplicate of line ${seen.get(k)} — the same transition twice in one file` });
      continue;
    }
    seen.set(k, line);

    // Roles nobody holds are a WARNING, never an error. The whole point
    // of a career matrix is to describe roles people are growing INTO,
    // and a target role with no incumbent today is the normal case, not a
    // typo. Same judgement the KRA importer makes.
    for (const [role, which] of [[fromRole, 'From Role'], [toRole, 'To Role']]) {
      if (knownRoles.size && !knownRoles.has(role.trim().toLowerCase())) {
        warnings.push({ line, warning: `${which} "${role}" is not a designation any active employee holds` });
      }
    }
    if (rec.min_time_months != null && rec.typical_time_months != null
        && rec.typical_time_months < rec.min_time_months) {
      warnings.push({ line, warning: `typical time (${rec.typical_time_months}m) is less than the minimum (${rec.min_time_months}m)` });
    }

    out.push(rec);
  }

  if (!out.length && !errors.length) {
    return { ...empty, fatal: 'No transition rows found below the header.' };
  }

  return {
    ok: errors.length === 0,
    rows: out,
    errors,
    warnings,
    summary: { total_rows: out.length, errors: errors.length, warnings: warnings.length },
  };
}

module.exports = { validateCareerTransitionRows, COLUMNS, rowKey, competencies };
