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

// BAND IS OFF THE MATRIX (13 Oct: "remove band from career pathing
// matrix and just keep it on grade and level sheet"). A matrix level is
// the GRADE alone — "E3 · Band 6" reads as E3, "Band 6" as nothing — and
// it is for reference: no move is matched on level any more, only on
// role and department. Stored rows keep whatever text they were written
// with; everything that reads or writes a level goes through this.
/** The grade a level names (E3), '' for a band alone, else the text as written. */
function gradeOnly(s) {
  const p = parseLevel(s);
  if (!p) return '';
  if (p.grade) return p.grade.toUpperCase();
  if (p.band) return '';
  return String(s).trim();
}

module.exports = { parseLevel, gradeOnly };
