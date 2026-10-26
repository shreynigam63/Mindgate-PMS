// THE PARAMETER ORDER (26 Oct): "order of parameters is wrong, it should
// be 1. Financial 2. Project Process 3. Internal / External Customer
// 4. People." Every KRA screen groups in this order — the library, the
// picker, My KRAs, a manager's view and approvals. A parameter outside the
// four keeps its place after them, in the order it first appears, and KRAs
// with no parameter still come last. Matched loosely, so "Project/Process"
// and "Customer" land where "Project / Process" and "Internal / External
// Customer" do.
export function paramRank(cat) {
  const c = String(cat || '').toLowerCase();
  if (/financ/.test(c)) return 0;
  if (/project|process/.test(c)) return 1;
  if (/customer/.test(c)) return 2;
  if (/people/.test(c)) return 3;
  return 4;
}
export const byParamOrder = (cats) => cats
  .map((c, i) => ({ c, i }))
  .sort((a, b) => paramRank(a.c) - paramRank(b.c) || a.i - b.i)
  .map((x) => x.c);
