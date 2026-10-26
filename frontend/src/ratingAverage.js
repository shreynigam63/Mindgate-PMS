// The average of KRA ratings, as the server works it out
// (timesheet-kra-score.js averageRating) — here so the approval screen can
// show the month's average move as the approver changes a KRA's rating.
//
// 26 Oct: "average ratings should be based on value of rating and not
// percentage derived from number of hours worked". Each rating counts at
// its value (A+ 5, A 4, B+ 3, B 2 — `values` comes from the server), by the
// KRA's weight, and the average reads back as the nearest rating, a half
// going up.
const norm = (l) => String(l || '').trim().toLowerCase();

export function nearestRating(value, values) {
  if (value == null || !values || !values.length) return null;
  const desc = values.slice().sort((a, b) => b.value - a.value);
  return desc.reduce((best, r) => (Math.abs(r.value - value) < Math.abs(best.value - value) ? r : best), desc[0]).label;
}

// rows: [{ rating, weight }]. Null when nothing is rated.
export function averageRating(rows, values) {
  const val = new Map((values || []).map((v) => [norm(v.label), Number(v.value)]));
  const rated = (rows || []).filter((r) => val.has(norm(r.rating)) && Number(r.weight) > 0);
  const w = rated.reduce((t, r) => t + Number(r.weight), 0);
  if (!(w > 0)) return null;
  const value = Math.round((rated.reduce((t, r) => t + val.get(norm(r.rating)) * Number(r.weight), 0) / w) * 100) / 100;
  return { value, rating: nearestRating(value, values), count: rated.length };
}

// "A+ 5, A 4, B+ 3, B 2" — the values, for the line that explains the average.
export const valuesText = (values) => (values || []).map((v) => `${v.label} ${v.value}`).join(', ');
