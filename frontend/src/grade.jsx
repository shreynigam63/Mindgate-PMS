// NOTE: .jsx, not .js — this file exports a component, and Vite only
// runs the JSX transform on .jsx here.

// A performance rating, written the way the client wants it read.
//
// Asked for on 24 Sep: "please make sure that ratings should be measured
// only in Alphabets and not numbers."
//
// Ratings are STORED as numbers and always will be — a weighted average
// of per-KRA scores is arithmetic, and letters cannot be averaged. What
// changes is that no screen shows the number as the answer. The number
// is still there underneath, as the `title` on the element, so anybody
// who needs to check the maths can hover; it is simply not the thing
// being reported.
//
// ONE formatter, not one per page. Before this there were three
// different local copies of "turn 4 into a word", two of them with
// their own hardcoded label maps, and they did not agree — the HOD
// queue said "Exceeds (4.0)" where My Rating said "4". A rating that
// reads differently on two screens is a rating people stop trusting.

// The fallback ladder. Used only when a cycle carries no rating_scale
// of its own, which is true of nothing in production but true of a
// tenant that has never had a cycle configured.
const FALLBACK = [
  { label: 'A+', value: 5 }, { label: 'A', value: 4 }, { label: 'B+', value: 3 },
  { label: 'B', value: 2 }, { label: 'C', value: 1 },
];

// A label is a GRADE if it looks like one: one letter, optionally with
// a + or -. "A+", "B", "C" qualify; "Outstanding" and "Exceeds" do not.
const isGradeLabel = (l) => /^[A-Za-z][+-]?$/.test(String(l || '').trim());

// The scale to read grades off.
//
// A cycle that already grades in letters is used as-is. A cycle graded
// in WORDS — "Needs Improvement" up to "Outstanding", which is what
// this product shipped with and what the demo tenant still uses — is
// mapped onto the letter ladder BY POSITION: its top value becomes A+,
// the next A, and so on.
//
// That mapping is the client's 24 Sep instruction taken at its word:
// "ratings should be measured only in Alphabets and not numbers". A
// descriptive label is not a number, but it is not an alphabet grade
// either, and a product that shows letters on one tenant and words on
// another has not done what was asked. A scale longer than the ladder
// keeps its own labels rather than inventing grades below C.
const rows = (scale) => {
  const list = Array.isArray(scale) && scale.length ? scale : FALLBACK;
  if (list.every((r) => isGradeLabel(r.label))) return list;
  const desc = [...list].sort((a, b) => Number(b.value) - Number(a.value));
  return desc.map((r, i) => ({ ...r, label: i < FALLBACK.length ? FALLBACK[i].label : r.label }));
};

// The grade for a value. A stored rating is often fractional — 4.2 out
// of a weighted average — and there is no grade for 4.2, so it takes
// the NEAREST one. That is a real loss of precision and the reason the
// exact figure stays in the tooltip rather than being dropped.
export function gradeFor(value, scale) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  const list = rows(scale);
  return list.reduce((best, r) =>
    (Math.abs(Number(r.value) - n) < Math.abs(Number(best.value) - n) ? r : best), list[0]).label;
}

// The string to put on screen: the grade alone. An em dash for "not
// rated", which is a different thing from a low grade and must not
// render as one.
export const grade = (value, scale) => gradeFor(value, scale) || '—';

// What goes in the tooltip. The exact stored number, named, so hovering
// explains rather than just repeating.
export function gradeTitle(value, scale) {
  if (value === null || value === undefined || value === '') return 'Not rated';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  const g = gradeFor(n, scale);
  const exact = Number.isInteger(n) ? String(n) : n.toFixed(2);
  // Only say "rounded" when it actually was.
  const onScale = rows(scale).some((r) => Number(r.value) === n);
  return onScale ? `Grade ${g} (stored as ${exact})`
                 : `Grade ${g} — nearest to the computed score ${exact}`;
}

// The whole thing as an element. Used wherever a rating is displayed so
// the tooltip comes with it and cannot be forgotten.
export default function Grade({ value, scale, className = '' }) {
  return (
    <span className={className} title={gradeTitle(value, scale)}>{grade(value, scale)}</span>
  );
}

// For a <select> of grades, and for anywhere a list of the grades is
// needed. Highest first, which is how people read a rating scale.
export const gradeOptions = (scale) =>
  [...rows(scale)].sort((a, b) => Number(b.value) - Number(a.value));
