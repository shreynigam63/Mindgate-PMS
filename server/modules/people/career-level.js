// Does an employee's level satisfy a career transition's From Level?
//
// Found on 8 Oct: the matrix said "Band 6" and the employee master said
// "E3 · Band 6", the match was an exact string comparison, and so a
// Software Developer was told "a career path exists for your role, but it
// does not match your level" — about a path written for exactly their
// level. The suggested matrix writes "E3 · Band 6" (grade · band, from the
// Grade and Level sheet) while an HR-written row often says just "Band 6"
// or "E3", and the HRMS export says whatever it says. All of them mean the
// same rung.
//
// So a level is read as its parts — a GRADE code (E3, M1, L2) and a BAND
// (Band 6) — and two levels match when every part both of them name
// agrees, and at least one part does. "Band 6" fits "E3 · Band 6";
// "E3" fits it too; "E2 · Band 6" does not (E2 ≠ E3), nor does "Band 7".
// Text with no recognisable part falls back to an exact comparison, as
// before. Pure, so it is tested without a database.

const clean = (s) => String(s == null ? '' : s).toLowerCase()
  .replace(/[·•|/,;:_–—-]+/g, ' ').replace(/\s+/g, ' ').trim();

function parseLevel(s) {
  const text = clean(s);
  if (!text) return null;
  const b = text.match(/\bband\s*([a-z]?\d+[a-z]?)\b/);
  const band = b ? b[1] : null;
  const rest = b ? text.replace(b[0], ' ') : text;
  const g = rest.match(/\b([a-z]{1,3})\s?(\d{1,2}[a-z]?)\b/);
  const grade = g ? `${g[1]}${g[2]}` : null;
  return { text, grade, band };
}

/** True when an employee at `actual` may take a move written for `required`. Blank `required` = any level. */
function levelMatches(required, actual) {
  if (!clean(required)) return true;
  const r = parseLevel(required);
  const a = parseLevel(actual);
  if (!a) return false;
  if (r.text === a.text) return true;
  if (!r.grade && !r.band) return false;
  if (r.grade && a.grade && r.grade !== a.grade) return false;
  if (r.band && a.band && r.band !== a.band) return false;
  return !!((r.grade && a.grade) || (r.band && a.band));
}

module.exports = { parseLevel, levelMatches };
