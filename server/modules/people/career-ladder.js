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
// EVERY ROW NAMES A DEPARTMENT, since 25 Sep. It did not before: the
// draft led with a company-wide block (blank Department, which the
// importer reads as "every department") and added department rows only
// where a department's ladder differed. That is correct behaviour for
// the importer and it produced a sheet whose Department column was
// mostly empty, which is what Mindgate reported:
//
//   "career matrix sheet has blank department files"
//   "download suggested matrix should be derived from department and
//    designation as per employees list available in PMS"
//
// So the draft is built per department, from the designations that
// department actually employs. The importer still accepts a blank
// Department — that feature is untouched, and HR can still blank a row
// by hand to make a rung company-wide — but nothing SUGGESTS one.
//
// EVERY ROW IS EXACTLY ONE RUNG, since 25 Sep (second report):
//
//   "suggested matrix should only show 1 level of matrix not more than
//    one level ... attached excel shows more than 1 level jump for
//    designations as well, please correct the same"
//
// They were right, and the cause was that the target was drawn only
// from the titles the DEPARTMENT holds. Business Finance employs an
// Executive and a Senior Manager and nothing in between, so the draft
// proposed Executive -> Senior Manager: five rungs in one row, offered
// to a person as their next step. Twenty-eight of the 210 rows on the
// sheet they sent back jumped two rungs or more, one of them five.
//
// The next rung is now chosen FIRST and the title second: take the rung
// directly above on the company ladder, then find the truest name for
// it — the senior form of the same job, the same job written wider, the
// standard title for that rung, the commonest role the department holds
// there, in that order. The target may therefore be a title the
// department does not employ yet, which is the point of a career path;
// the note says so when that happens. Expected Level Change is 1 on
// every row, because one rung is what every row now is.
function suggestTransitions(rows) {
  const clean = (rows || [])
    .map((r) => ({
      department: String(r.department || '').trim(),
      designation: String(r.designation || '').trim(),
      headcount: Number(r.headcount) || 0,
    }))
    .filter((r) => r.designation);

  // Every title anyone holds, company-wide. Used to name a rung that
  // the department itself has nobody on — never to invent one.
  const company = new Map();
  for (const r of clean) {
    const c = company.get(r.designation) || { designation: r.designation, headcount: 0 };
    c.headcount += r.headcount;
    company.set(r.designation, c);
  }
  const pool = roleSet([...company.values()]);
  // The rungs THIS COMPANY actually has somebody on. A spine rung that
  // nobody anywhere holds is not a rung here, so it is stepped over
  // rather than becoming a dead end: a company with no Deputy Vice
  // President promotes an AVP to Vice President, and that is still one
  // rung of its own ladder. Without this, every title under an empty
  // rung simply vanished from the draft.
  const rungs = SPINE.filter((l) => pool.some((r) => r.level === l));

  const byDept = new Map();
  for (const r of clean) {
    // A row with no department on the master cannot be filed under one.
    // Reported as its own bucket rather than dropped, so HR can see the
    // gap on their own data instead of wondering why a title is missing.
    const key = r.department || '(no department on the employee record)';
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(r);
  }

  const out = [];
  for (const [department, list] of [...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const held = new Set(list.map((r) => r.designation));
    for (const t of ladder(list, pool, rungs)) {
      const inDept = held.has(t.to.designation);
      const who = inDept
        ? `${t.to.headcount} ${t.to.headcount === 1 ? 'person holds' : 'people hold'} ${t.to.designation} in ${department} today`
        : `nobody in ${department} holds ${t.to.designation} today — the rung is named from the company ladder`;
      out.push(row(department, t, `${note(t)} · ${who}`));
    }
  }
  return out;
}

// The ladder within one set of designations: for each title, the next
// rung up. `pool` is the company-wide set, consulted only to name a
// rung the department has nobody on. Exported for the test, which is
// where the ordering rules earn their keep.
//
// GENERIC is the plain ladder every company has under its job titles,
// and it is also the SPINE: the rungs themselves, in order. A step is
// one entry along it, so "one rung" has a single definition that both
// the target and the Expected Level Change column are read from.
const GENERIC = {
  1: 'Trainee', 2: 'Executive', 3: 'Senior Executive', 4: 'Lead',
  // No level 5 on the spine: Architect and Assistant Manager sit there
  // on the rank scale, but they are side roles, not a rung everybody
  // passes through — a Lead's next step here is Manager. Both still
  // appear as a FROM role, and step to the first rung above them.
  6: 'Manager', 7: 'Senior Manager',
  8: 'Assistant Vice President', 9: 'Deputy Vice President',
  10: 'Vice President I', 11: 'Vice President II',
  12: 'Senior Vice President I', 13: 'Senior Vice President II', 14: 'Business Head',
};
const SPINE = Object.keys(GENERIC).map(Number).sort((a, b) => a - b);

// The rung directly above a level — the only target any suggested row
// is allowed to have. `rungs` is the ladder in play: the spine by
// default, or the rungs this company is actually on. null at the top.
const nextRung = (level, rungs = SPINE) => rungs.find((l) => l > level) ?? null;

function roleSet(list) {
  const seen = new Map();
  for (const r of list) {
    const cur = seen.get(r.designation);
    if (cur) { cur.headcount += r.headcount; continue; }
    seen.set(r.designation, { ...r, ...rankOf(r.designation), family: familyOf(r.designation) });
  }
  return [...seen.values()].sort((a, b) => a.level - b.level || b.headcount - a.headcount
    || a.designation.localeCompare(b.designation));
}

function ladder(list, pool, rungs) {
  const roles = roleSet(list);
  const wider = pool && pool.length ? pool : roles;
  const steps = (rungs && rungs.length) ? rungs : SPINE.filter((l) => wider.some((r) => r.level === l));

  const out = [];
  for (const from of roles) {
    const level = nextRung(from.level, steps);
    if (level == null) continue;                 // the top of the ladder
    // Candidates ON THAT RUNG ONLY. The department's own people first,
    // so a department that already has somebody there keeps its own
    // title; the company-wide set is the fallback for naming a rung
    // nobody in the department is on yet.
    const here = roles.filter((r) => r.level === level);
    const anywhere = wider.filter((r) => r.level === level);

    const sameJob = (r) => r.family === from.family && r.designation !== from.designation;
    // A title that is recognisably the same job written wider or
    // narrower — "Support Executive" -> "Senior Executive", "Trainee
    // Tester" -> "Software Tester". Whole words only, and both families
    // must be real, or an empty family matches everything.
    const related = (r) => r.family && from.family && r.family !== from.family
      && (from.family.endsWith(` ${r.family}`) || r.family.endsWith(` ${from.family}`));
    const isGeneric = (r) => r.designation.toLowerCase() === String(GENERIC[level] || '').toLowerCase();
    const anyone = () => true;

    // In order. The department's own people come before the company's
    // for every rule, so a department that already has somebody on the
    // rung keeps its own title for it. The standard title beats the
    // commonest one, because without that the fallback is "biggest team
    // wins" — and since Senior Software Developer is the biggest role
    // in this company, that made the sheet say a Customer Service
    // Representative's next step was Senior Software Developer.
    const RULES = [
      [here, sameJob, 'same_job'], [anywhere, sameJob, 'same_job'],
      [here, related, 'related'], [anywhere, related, 'related'],
      [here, isGeneric, 'generic'], [here, anyone, 'commonest'],
      [anywhere, isGeneric, 'generic'], [anywhere, anyone, 'commonest'],
    ];
    let found = null;
    for (const [pool_, test, why] of RULES) {
      const hit = pool_.filter(test);
      if (hit.length) { found = { to: pick(hit), why }; break; }
    }

    // Nobody anywhere in the company is on the rung above. Proposing a
    // title no employee record has ever carried would put a role on the
    // sheet that HR cannot match against anything, so the row is left
    // out and the absence is the data's answer, not a dropped row.
    if (!found) continue;
    if (found.to.designation === from.designation) continue;
    out.push({ from, to: found.to, why: found.why });
  }
  return out;
}

const pick = (pool_) => [...pool_].sort((a, b) => b.headcount - a.headcount
  || a.designation.localeCompare(b.designation))[0];

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

// A rung only needs a human when the role it comes FROM is a
// specialised title with no senior form and nothing recognisably
// related above it. "Trainee → Executive" is the generic ladder read
// off both ends and is simply right.
//
// A rung the department has nobody on is NOT flagged. It was, briefly,
// while the one-rung rule was being written, and that put PLEASE CHECK
// on 85 of 210 rows — including "Business Analyst → Senior Business
// Analyst" and "Oracle DBA → Sr. Oracle DBA", which are exactly right
// and want no review at all. A flag on 40% of the sheet tells HR
// nothing. The note still SAYS nobody holds it there, in words, which
// is the honest form of that information: pointing at a rung the
// department has not filled yet is what a career path is for.
const onSpine = (d) => Object.values(GENERIC).some((g) => g.toLowerCase() === String(d).toLowerCase());
const note = (t) => ((t.why === 'generic' || t.why === 'commonest')
  && t.from.level <= 2 && !onSpine(t.from.designation) ? CHECK : WHY[t.why]);

function row(department, { from, to }, note_) {
  const [min, typical] = tenure(from.level, to.level);
  return {
    department,
    from_role: from.designation,
    from_level: null,
    to_role: to.designation,
    to_level: null,
    // Always 1. Every suggested row is a single rung along the spine by
    // construction, so the raw difference between two rank numbers —
    // which has gaps, and which put a 5 in this column — is not what
    // this field means.
    expected_level_change: 1,
    min_time_months: min,
    typical_time_months: typical,
    required_competencies: competenciesFor(to.level),
    notes: note_,
  };
}

module.exports = { suggestTransitions, ladder, rankOf, familyOf, tenure, competenciesFor,
                   GENERIC, SPINE, nextRung, WHY, CHECK };
