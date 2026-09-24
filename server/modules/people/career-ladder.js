// Suggesting a Career Pathing Matrix from the employee master.
//
// Asked for on 24 Sep: "please find template of career pathing matrix
// and fill the same as per department and designation, also create
// downloadable excel sheet for upload."
//
// The matrix has always been fillable by hand, one transition at a time,
// and uploadable in bulk since 17 Sep. What was missing is the first
// draft: this tenant has 34 departments and 90 distinct designations on
// file, which is several hundred plausible rungs, and nobody starts that
// from an empty sheet.
//
// So this reads the designations that ACTUALLY EXIST per department and
// proposes the ladder implied by them. Two rules, and only two:
//
//   * a designation's next rung is the senior form of the same job where
//     one exists ("Software Developer" → "Senior Software Developer"),
//     because that is the move people actually make;
//   * failing that, it is the GENERIC rung at the next level — Executive,
//     Senior Executive, Lead, Manager and so on — and only failing that
//     the commonest real role above it.
//
// The middle rule is not decoration. Without it the fallback is "lowest
// rung above, biggest team wins", and because Senior Software Developer
// is the biggest role in this company that made the company-wide sheet
// say a Customer Service Representative's next step is Senior Software
// Developer. Every such row is now marked in Notes as a generic guess,
// so HR can see exactly which ones need a human.
//
// NOTHING HERE IS AUTHORITATIVE. It is a draft for HR to edit and upload
// through the importer they already use, which is why it comes out as
// the importer's own sheet rather than being written to the database.
// Pure — no db, no express — so the ladder rules can be tested directly.

// Seniority, most specific pattern first. Order is the whole design:
// "Senior Manager" has to be read as a manager rung and not as the
// senior form of some "Manager", and "Senior Technical Lead" has to be
// read as a lead. A generic /^senior/ placed any earlier swallows both.
const RANKS = [
  [/\b(business|delivery|practice)\s+head\b|^head\b|\bchief\b/i, 14, 'Business head'],
  [/senior vice president\s*(ii|2)\b/i,                          13, 'Senior Vice President II'],
  [/senior vice president/i,                                     12, 'Senior Vice President'],
  [/vice president\s*(ii|2)\b/i,                                 11, 'Vice President II'],
  [/deputy vice president/i,                                      9, 'Deputy Vice President'],
  [/assistant vice president/i,                                   8, 'Assistant Vice President'],
  [/vice president/i,                                            10, 'Vice President'],
  [/\b(senior|sr\.?)\s.*manager|manager\s*[-–].*\b(senior|sr)\b/i, 7, 'Senior manager'],
  [/assistant\s+(general\s+)?(product\s+)?manager/i,              5, 'Assistant manager'],
  [/manager/i,                                                    6, 'Manager'],
  [/architect/i,                                                  5, 'Architect'],
  [/\blead\b|\bconsultant\b|subject matter expert/i,              4, 'Lead'],
  [/^(senior|sr\.?)\b/i,                                          3, 'Senior individual contributor'],
  [/trainee|intern\b/i,                                           1, 'Trainee'],
];
const BASE_RANK = [2, 'Individual contributor'];

function rankOf(designation) {
  const d = String(designation || '').trim();
  for (const [re, level, label] of RANKS) if (re.test(d)) return { level, label };
  return { level: BASE_RANK[0], label: BASE_RANK[1] };
}

// The same job without its seniority prefix, so "Senior Software
// Developer" and "Software Developer" are recognisably one ladder.
// Punctuation and spacing are dropped because the master carries both
// "Sr. Oracle DBA" and "Senior Linux Administrator".
function familyOf(designation) {
  const norm = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const full = norm(String(designation || ''));
  const stripped = norm(String(designation || '').replace(/^(senior|sr\.?|jr\.?|junior|trainee)\s+/i, ''));
  // "Trainee" on its own strips to nothing, and an empty family matches
  // every other family — so the prefix only comes off if a job is left.
  return stripped || full;
}

// How long a move of this size usually takes. Advisory on the sheet —
// the importer does not enforce either number — but an empty column
// teaches HR nothing about what the field is for.
function tenure(fromLevel, toLevel) {
  const top = Math.max(fromLevel, toLevel);
  if (top <= 2) return [12, 18];
  if (top === 3) return [18, 24];
  if (top <= 5) return [24, 36];
  if (top <= 7) return [30, 42];
  return [36, 48];
}

// What the move actually asks of somebody, worded as the competency
// master words it, so the matrix and the competency framework use one
// vocabulary instead of two. Keyed on the rung being moved INTO.
const COMPETENCIES = {
  2: ['Role-specific technical knowledge', 'Process knowledge', 'Quality & accuracy', 'Ownership & accountability'],
  3: ['Industry / domain knowledge', 'Problem solving', 'Ownership & accountability', 'Initiative'],
  4: ['Delegation', 'Coaching & mentoring', 'Giving feedback', 'Project execution'],
  5: ['Delegation', 'Performance management', 'Stakeholder management', 'Decision-making'],
  6: ['Performance management', 'Team motivation', 'Stakeholder management', 'Decision-making'],
  7: ['Strategic thinking', 'Change management', 'Performance management', 'Stakeholder management'],
  8: ['Strategic thinking', 'Change management', 'Stakeholder management', 'Customer orientation'],
};
const competenciesFor = (toLevel) => COMPETENCIES[toLevel] || COMPETENCIES[8];

// rows: [{ department, designation, headcount }] straight off the
// employee master. Returns the importer's own row shape, so the result
// can be written into the template sheet with no further mapping.
//
// A department is skipped when it has fewer than two rungs: a one-title
// department has no ladder to suggest, and a row inventing one would be
// the exact fiction this is supposed to avoid.
function suggestTransitions(rows) {
  const clean = (rows || [])
    .map((r) => ({
      department: String(r.department || '').trim(),
      designation: String(r.designation || '').trim(),
      headcount: Number(r.headcount) || 0,
    }))
    .filter((r) => r.designation);

  const out = [];

  // COMPANY-WIDE RUNGS FIRST. Blank department means "every department"
  // to the importer, and a department-specific row beats it for the same
  // move — so this is the fallback ladder for the thin departments, and
  // the specific rungs below override it wherever a department differs.
  const company = new Map();
  for (const r of clean) {
    const c = company.get(r.designation) || { designation: r.designation, headcount: 0 };
    c.headcount += r.headcount;
    company.set(r.designation, c);
  }
  for (const t of ladder([...company.values()])) {
    out.push(row('', t, note(t)));
  }

  // THEN THE DEPARTMENT-SPECIFIC ONES, but only where the department's
  // own ladder differs from the company-wide one — a row that repeats
  // the fallback verbatim adds nothing and makes the sheet unreadable.
  const wide = new Set(out.map((r) => `${r.from_role}\u0000${r.to_role}`));
  const byDept = new Map();
  for (const r of clean) {
    if (!r.department) continue;
    if (!byDept.has(r.department)) byDept.set(r.department, []);
    byDept.get(r.department).push(r);
  }
  for (const [department, list] of [...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const t of ladder(list)) {
      if (wide.has(`${t.from.designation}\u0000${t.to.designation}`)) continue;
      out.push(row(department, t, `${note(t)} · ${t.to.headcount} ${t.to.headcount === 1 ? 'person holds' : 'people hold'} ${t.to.designation} in ${department} today`));
    }
  }
  return out;
}

// The ladder within one set of designations: for each rung, the next one
// up. Exported for the test, which is where the ordering rules earn
// their keep.
//
// GENERIC is the plain ladder every company has under its job titles.
// A title is only used from here if it genuinely appears in the set
// being laddered — this proposes no role nobody holds.
const GENERIC = {
  1: 'Trainee', 2: 'Executive', 3: 'Senior Executive', 4: 'Lead',
  // No level 5 on the generic spine: Assistant Manager exists on the
  // master but only five people hold it, and a Lead's real next step
  // here is Manager. Assistant Manager still appears as a FROM role.
  6: 'Manager', 7: 'Senior Manager',
  8: 'Assistant Vice President', 9: 'Deputy Vice President',
  10: 'Vice President I', 11: 'Vice President II',
  12: 'Senior Vice President I', 13: 'Senior Vice President II', 14: 'Business Head',
};

function ladder(list) {
  const seen = new Map();
  for (const r of list) {
    const cur = seen.get(r.designation);
    if (cur) { cur.headcount += r.headcount; continue; }
    seen.set(r.designation, { ...r, ...rankOf(r.designation), family: familyOf(r.designation) });
  }
  const roles = [...seen.values()].sort((a, b) => a.level - b.level || b.headcount - a.headcount
    || a.designation.localeCompare(b.designation));
  if (roles.length < 2) return [];
  const byName = new Map(roles.map((r) => [r.designation.toLowerCase(), r]));

  const out = [];
  for (const from of roles) {
    const above = roles.filter((r) => r.level > from.level);
    if (!above.length) continue;

    // Rule one: the senior form of the same job.
    const sameJob = above.filter((r) => r.family === from.family);
    if (sameJob.length) {
      const lowest = Math.min(...sameJob.map((r) => r.level));
      out.push({ from, to: pick(sameJob, lowest), why: 'same_job' });
      continue;
    }

    // Rule two: a role that is recognisably the same job written wider
    // or narrower — "Support Executive" → "Senior Executive", "Trainee
    // Tester" → "Software Tester". Whole words only, and both families
    // must be real, or an empty family matches everything.
    const levels = [...new Set(above.map((r) => r.level))].sort((a, b) => a - b);
    const related = above.filter((r) => r.family && from.family && r.family !== from.family
      && (from.family.endsWith(` ${r.family}`) || r.family.endsWith(` ${from.family}`)));
    // ...but only if it is on the VERY NEXT rung. Without that guard
    // "Assistant Vice President" matched "Vice President" (level 10)
    // and skipped Deputy Vice President (level 9) sitting right above
    // it — a related title two rungs up is not a promotion path.
    if (related.length && Math.min(...related.map((r) => r.level)) === levels[0]) {
      out.push({ from, to: pick(related, levels[0]), why: 'related' });
      continue;
    }

    let generic = null;
    for (const lvl of levels) {
      const g = byName.get(String(GENERIC[lvl] || '').toLowerCase());
      if (g && g.level === lvl) { generic = g; break; }
    }
    if (generic) { out.push({ from, to: generic, why: 'generic' }); continue; }

    // Rule three: the commonest real role on the rung above.
    out.push({ from, to: pick(above, levels[0]), why: 'commonest' });
  }
  return out;
}

const pick = (pool, level) => pool.filter((r) => r.level === level)
  .sort((a, b) => b.headcount - a.headcount || a.designation.localeCompare(b.designation))[0];

// Why a row says what it says. The generic line is a request for a
// human: it means the master has no senior form of that job, so the
// suggestion is the plain ladder and probably needs editing.
// Why a row says what it says. Only `generic` from a base rung is a
// real guess: above that the generic spine (Lead, Manager, Senior
// Manager, AVP...) IS the company ladder and needs no apology. Flagging
// all 143 generic rows for review, as the first cut did, would have
// told HR to check the ones that were right.
const WHY = {
  same_job: 'Senior form of the same role on the employee master',
  related: 'Closest matching senior role on the employee master',
  generic: 'Standard rung on the company ladder',
  commonest: 'Commonest role on the rung above, from the employee master',
};
const CHECK = 'PLEASE CHECK — the master has no senior form of this role, so this is the plain ladder rather than a real next step.';

// A generic rung only needs a human when the role it comes FROM is a
// specialised title with no senior form. "Trainee → Executive" is the
// generic ladder read off both ends and is simply right.
const onSpine = (d) => Object.values(GENERIC).some((g) => g.toLowerCase() === String(d).toLowerCase());
const note = (t) => (t.why === 'generic' && t.from.level <= 2 && !onSpine(t.from.designation)
  ? CHECK : WHY[t.why]);

function row(department, { from, to }, note) {
  const [min, typical] = tenure(from.level, to.level);
  return {
    department,
    from_role: from.designation,
    from_level: null,
    to_role: to.designation,
    to_level: null,
    expected_level_change: to.level - from.level,
    min_time_months: min,
    typical_time_months: typical,
    required_competencies: competenciesFor(to.level),
    notes: note,
  };
}

module.exports = { suggestTransitions, ladder, rankOf, familyOf, tenure, competenciesFor, GENERIC, WHY, CHECK };
