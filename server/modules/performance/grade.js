// A performance rating as a letter, server side.
//
// Asked for on 24 Sep: "please make sure that ratings should be
// measured only in Alphabets and not numbers."
//
// The browser has its own copy of this (frontend/src/grade.jsx) because
// the two cannot import each other. This one exists for the things the
// browser never renders: the closure-letter PDF and the spreadsheet
// exports. A letter grade on screen and a bare number in the PDF the
// employee actually keeps would be the worst of both.
//
// Ratings stay NUMERIC in the database. A weighted average of per-KRA
// scores is arithmetic and letters cannot be averaged; what changes is
// what gets printed.
const FALLBACK = [
  { label: 'A+', value: 5 }, { label: 'A', value: 4 }, { label: 'B+', value: 3 },
  { label: 'B', value: 2 }, { label: 'C', value: 1 },
];

// Mirrors frontend/src/grade.jsx exactly — see its header for why a
// word-based scale is mapped onto the letter ladder by position.
const isGradeLabel = (l) => /^[A-Za-z][+-]?$/.test(String(l || '').trim());
const rows = (scale) => {
  const list = Array.isArray(scale) && scale.length ? scale : FALLBACK;
  if (list.every((r) => isGradeLabel(r.label))) return list;
  const desc = [...list].sort((a, b) => Number(b.value) - Number(a.value));
  return desc.map((r, i) => ({ ...r, label: i < FALLBACK.length ? FALLBACK[i].label : r.label }));
};

// The nearest grade. A stored 4.2 has no grade of its own, so it takes
// the closest — which is a real loss of precision, and the reason
// anything that has to be exact keeps the number beside it.
function gradeFor(value, scale) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  const list = rows(scale);
  return list.reduce((best, r) =>
    (Math.abs(Number(r.value) - n) < Math.abs(Number(best.value) - n) ? r : best), list[0]).label;
}

const grade = (value, scale) => gradeFor(value, scale) || '—';

module.exports = { grade, gradeFor };
