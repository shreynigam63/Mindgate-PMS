// Parsing a sheet of past appraisal ratings.
//
// Pure — no db, no express — because this is where importer bugs live
// and they are only findable by feeding the parser the shapes a real
// HR export actually has.
//
// Needed because the Super 50 rule reads "the last three annual
// reviews" and a new instance has none: 1,398 employees here and zero
// published cycles, so the window is empty for everybody and the rule
// can never fire. This loads what the client appraised on before.

const key = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const COLUMNS = [
  ['code', 'Employee Code'], ['email', 'Email'], ['name', 'Employee Name'],
  ['fiscal_year', 'Fiscal Year'], ['grade', 'Rating'],
];
const ALIASES = new Map();
for (const [field, label] of COLUMNS) ALIASES.set(key(label), field);
for (const [alias, field] of [
  ['employeeid', 'code'], ['empcode', 'code'], ['employeecode', 'code'], ['code', 'code'],
  ['emailid', 'email'], ['emailaddress', 'email'], ['officialemail', 'email'],
  ['employeename', 'name'], ['name', 'name'],
  ['year', 'fiscal_year'], ['fy', 'fiscal_year'], ['appraisalyear', 'fiscal_year'],
  ['reviewyear', 'fiscal_year'], ['cycle', 'fiscal_year'],
  ['rating', 'grade'], ['grade', 'grade'], ['finalrating', 'grade'],
  ['appraisalrating', 'grade'], ['overallrating', 'grade'],
]) ALIASES.set(alias, field);

const txt = (v) => String(v == null ? '' : v).trim();

// The first four-digit year anywhere in the label, so "FY24-25",
// "2024-25" and "2024" all sort as 2024. A two-digit "FY24" is read as
// 20xx, which is right for every year this product will see and wrong
// only for records from the 1900s, which no PMS is importing.
function sortYear(label) {
  // The FIRST run of digits, whatever is around it. Word boundaries do
  // not work here: in "FY24-25" there is no boundary between the Y and
  // the 24, so /\b\d{2}\b/ skipped to the 25 and read the year as
  // 2025 — one year out on every row — while "FY24" matched nothing at
  // all. A two-digit run is read as 20xx, which is right for every year
  // a PMS will import and wrong only for the 1900s.
  const m = txt(label).match(/\d+/);
  if (!m) return null;
  const d = m[0];
  if (d.length >= 4) return Number(d.slice(0, 4));
  if (d.length === 2) return 2000 + Number(d);
  return null;
}

// A grade label from the cycle's scale, or a bare number on that scale.
// Both, because an old HR sheet carries whichever the client used, and
// rejecting one of them would send them away to re-key 1,398 rows.
function toRating(cell, scale) {
  const raw = txt(cell);
  if (!raw) return { error: 'Rating is required' };
  const hit = (scale || []).find((s) => String(s.label || '').trim().toLowerCase() === raw.toLowerCase());
  if (hit) return { grade: String(hit.label), rating: Number(hit.value) };
  const n = Number(raw);
  if (!Number.isNaN(n)) {
    const values = (scale || []).map((s) => Number(s.value));
    const lo = Math.min(...values); const hi = Math.max(...values);
    if (values.length && (n < lo || n > hi)) {
      return { error: `Rating ${n} is outside this scale (${lo}-${hi})` };
    }
    const exact = (scale || []).find((s) => Math.round(Number(s.value)) === Math.round(n));
    return { grade: exact ? String(exact.label) : null, rating: n };
  }
  const allowed = (scale || []).map((s) => s.label).join(', ');
  return { error: `Rating "${raw}" is not a grade on this scale (${allowed}) or a number` };
}

// rows: arrays straight off the parsed sheet, banner and header rows
// included — the header is found rather than assumed, because these
// files arrive with a title row, a blank row, or neither.
function parsePriorRatings(rows, scale) {
  const out = { rows: [], errors: [] };
  const grid = (rows || []).filter((r) => Array.isArray(r));
  let headerAt = -1; let map = null;
  for (let i = 0; i < Math.min(grid.length, 10); i += 1) {
    const cand = new Map();
    grid[i].forEach((cell, idx) => {
      const f = ALIASES.get(key(cell));
      if (f && !cand.has(f)) cand.set(f, idx);
    });
    if (cand.has('fiscal_year') && cand.has('grade') && (cand.has('code') || cand.has('email'))) {
      headerAt = i; map = cand; break;
    }
  }
  if (headerAt === -1) {
    out.errors.push({ line: 1, error: 'Could not find the header row — it needs Fiscal Year, Rating, and Employee Code or Email.' });
    return out;
  }

  const seen = new Map();
  for (let i = headerAt + 1; i < grid.length; i += 1) {
    const line = i + 1;
    const cell = (f) => (map.has(f) ? txt(grid[i][map.get(f)]) : '');
    const code = cell('code').toLowerCase();
    const email = cell('email').toLowerCase();
    const fy = cell('fiscal_year');
    const gradeCell = cell('grade');
    // A wholly blank row is the trailing whitespace every sheet has,
    // not an error.
    if (!code && !email && !fy && !gradeCell) continue;
    if (!code && !email) { out.errors.push({ line, error: 'Employee Code or Email is required' }); continue; }
    if (!fy) { out.errors.push({ line, error: 'Fiscal Year is required' }); continue; }
    const sy = sortYear(fy);
    if (sy == null) { out.errors.push({ line, error: `Could not read a year out of "${fy}"` }); continue; }
    const r = toRating(gradeCell, scale);
    if (r.error) { out.errors.push({ line, error: r.error }); continue; }

    // The same person and year twice in one file is a mistake in the
    // file, and taking "the last one" silently is how the wrong rating
    // gets imported.
    const dupKey = `${code || email}\u0000${sy}`;
    if (seen.has(dupKey)) {
      out.errors.push({ line, error: `duplicate of line ${seen.get(dupKey)} — the same employee and year twice in one file` });
      continue;
    }
    seen.set(dupKey, line);
    out.rows.push({ line, code, email, name: cell('name'), fiscal_year: fy, sort_year: sy,
                    grade: r.grade, rating: r.rating });
  }
  if (!out.rows.length && !out.errors.length) {
    out.errors.push({ line: headerAt + 2, error: 'The sheet has a header but no rows.' });
  }
  return out;
}

module.exports = { parsePriorRatings, sortYear, toRating, COLUMNS };
