// Turning answers into something HR can act on. Pure — no db, no
// express — because every number here is arithmetic and arithmetic is
// the part that has to be provably right.
//
// Asked for on 25 Sep, sections 20 to 25. NO LISTENING AGENT: excluded
// by Mindgate, and nothing in this file drafts, asks or infers
// anything. A flag fires because a stored number crossed a stored
// threshold, and the reason is always reconstructable from the row.

// A 1-5 answer and a 0-10 eNPS answer cannot be averaged together, so
// everything is carried on a 0-100 scale internally and shown back in
// its own units. 1-5 maps 1->0 and 5->100; 0-10 maps 0->0 and 10->100.
function toPercent(qtype, value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const v = Number(value);
  if (qtype === 'enps') return Math.max(0, Math.min(100, (v / 10) * 100));
  if (qtype === 'scale') return Math.max(0, Math.min(100, ((v - 1) / 4) * 100));
  return null;                       // choice/multi/text are not scored
}

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---- the red-flag engine (section 22) --------------------------------
//
// One answer against one rule. Rules come from engagement.flag_rules,
// so a client changes a threshold or the wording of an action by
// editing a row — never by a release.
function ruleMatches(rule, answer) {
  if (!rule || !answer) return false;
  if (rule.applies_to && rule.applies_to !== answer.qtype) return false;
  if (rule.dimension && rule.dimension !== answer.dimension) return false;

  const num = answer.value_num == null ? null : Number(answer.value_num);
  const texts = answer.qtype === 'multi'
    ? (answer.value_list || []).map(String)
    : (answer.value_text == null ? [] : [String(answer.value_text)]);

  switch (rule.comparator) {
    case 'lte':
      return num != null && rule.threshold_num != null && num <= Number(rule.threshold_num);
    case 'gte':
      return num != null && rule.threshold_num != null && num >= Number(rule.threshold_num);
    case 'between':
      return num != null && rule.threshold_num != null && rule.threshold_max != null
        && num >= Number(rule.threshold_num) && num <= Number(rule.threshold_max);
    case 'in':
      return texts.some((t) => (rule.match_values || []).includes(t));
    // "anything other than 'No significant blocker'" — but ONLY when
    // something was actually answered. An unanswered question is not a
    // blocker, and treating it as one would turn every skipped
    // question into an amber flag.
    case 'not_in':
      return texts.length > 0 && texts.some((t) => !(rule.match_values || []).includes(t));
    default:
      return false;
  }
}

// Every flag raised by one set of answers. `answers` carry qtype,
// dimension, value_num/value_text/value_list and enough identity for
// the caller to say who and when.
function flagsFor(answers, rules) {
  const out = [];
  for (const a of answers || []) {
    for (const r of rules || []) {
      if (r.active === false) continue;
      if (!ruleMatches(r, a)) continue;
      out.push({
        key: r.key, severity: r.severity, label: r.label, action: r.action,
        owner: r.owner, follow_up_days: r.follow_up_days,
        dimension: a.dimension || r.dimension || null,
        prompt: a.prompt, value: a.value_num != null ? Number(a.value_num)
          : (a.qtype === 'multi' ? (a.value_list || []).join(', ') : a.value_text),
      });
    }
  }
  return out;
}

// One row per RULE, not per answer. A person who rated seven
// role-clarity questions at 1 raised seven identical flags with the
// same action and the same owner — fifty-one rows for one new hire,
// which is the noise this engine exists to cut through. Grouped, that
// reads "Role clarity is low ×7" with the worst answer as evidence.
function groupFlags(flags) {
  const by = new Map();
  for (const f of flags || []) {
    if (!by.has(f.key)) {
      by.set(f.key, { key: f.key, severity: f.severity, label: f.label, action: f.action,
        owner: f.owner, follow_up_days: f.follow_up_days, dimension: f.dimension,
        count: 0, examples: [] });
    }
    const g = by.get(f.key);
    g.count++;
    // Three examples is enough to make the flag checkable without
    // reprinting the survey.
    if (g.examples.length < 3) g.examples.push({ prompt: f.prompt, value: f.value });
  }
  // Red first, then whichever fired most — the order HR should read.
  return [...by.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count
    : a.severity === 'red' ? -1 : 1));
}

// Red beats amber. One person with a red and four ambers is a red.
const worst = (flags) => (!flags || !flags.length ? 'green'
  : flags.some((f) => f.severity === 'red') ? 'red' : 'amber');

// ---- dimension scores and the 30/60/90 trend (section 23) ------------
//
// Scores one set of answers per dimension, on 0-100. Undimensioned and
// unscorable answers are ignored rather than counted as zero — a text
// answer is not a bad score.
function scoreByDimension(answers) {
  const buckets = new Map();
  for (const a of answers || []) {
    if (!a.dimension) continue;
    const pct = toPercent(a.qtype, a.value_num);
    if (pct == null) continue;
    if (!buckets.has(a.dimension)) buckets.set(a.dimension, []);
    buckets.get(a.dimension).push(pct);
  }
  const out = {};
  for (const [dim, xs] of buckets) out[dim] = round1(mean(xs));
  return out;
}

const overallScore = (byDim) => {
  const xs = Object.values(byDim || {}).filter((v) => v != null);
  return xs.length ? round1(mean(xs)) : null;
};

// Direction between two readings. A threshold of 3 points stops the
// arrow flickering on noise: a move from 62.0 to 63.4 is not a trend.
function direction(from, to, threshold = 3) {
  if (from == null || to == null) return null;
  if (to - from > threshold) return 'up';
  if (from - to > threshold) return 'down';
  return 'flat';
}

// One employee's readings across milestones, in milestone order.
// `readings` = [{ milestone, label, taken_at, answers }].
function trend(readings) {
  const points = (readings || [])
    .slice()
    .sort((a, b) => (a.milestone ?? 9999) - (b.milestone ?? 9999))
    .map((r) => ({ milestone: r.milestone, label: r.label, taken_at: r.taken_at,
      scores: scoreByDimension(r.answers), overall: overallScore(scoreByDimension(r.answers)) }));

  const dims = [...new Set(points.flatMap((p) => Object.keys(p.scores)))].sort();
  const rows = dims.map((dim) => {
    const series = points.map((p) => (p.scores[dim] == null ? null : p.scores[dim]));
    const seen = series.filter((v) => v != null);
    return { dimension: dim, series,
      first: seen.length ? seen[0] : null,
      latest: seen.length ? seen[seen.length - 1] : null,
      // Direction is first-to-latest, not last-two: "did this improve
      // over the ninety days" is the question, and a dip between two
      // adjacent readings is not the answer to it.
      direction: seen.length > 1 ? direction(seen[0], seen[seen.length - 1]) : null };
  });
  return { points, rows };
}

// ---- the aggregate onboarding read (section 24) -----------------------
//
// `people` = [{ employee_id, answers }]. Returns the index per
// dimension, the overall, and the blockers people actually named,
// biggest first — which is the half of the dashboard that tells HR
// what to fix rather than how bad it is.
// `blockerDimension` is its own dimension rather than 'productivity',
// because the productivity questions include a LEVEL question — "how
// would you describe your current level of productivity" with answers
// like "Still learning" — and counting those as blockers put "Still
// learning, 100%" at the top of the list of things to fix.
function newHireIndex(people, { blockerDimension = 'blocker' } = {}) {
  const perDim = new Map();
  const blockers = new Map();
  let scored = 0;

  for (const p of people || []) {
    const byDim = scoreByDimension(p.answers);
    if (Object.keys(byDim).length) scored++;
    for (const [dim, v] of Object.entries(byDim)) {
      if (!perDim.has(dim)) perDim.set(dim, []);
      perDim.get(dim).push(v);
    }
    for (const a of p.answers || []) {
      if (a.dimension !== blockerDimension) continue;
      const picked = a.qtype === 'multi' ? (a.value_list || [])
        : (a.qtype === 'choice' && a.value_text ? [a.value_text] : []);
      for (const v of picked) {
        if (/^no significant blocker$/i.test(v)) continue;   // not a blocker
        blockers.set(v, (blockers.get(v) || 0) + 1);
      }
    }
  }

  const dimensions = [...perDim.entries()]
    .map(([dimension, xs]) => ({ dimension, score: round1(mean(xs)), n: xs.length }))
    .sort((a, b) => a.score - b.score);   // weakest first: the list is to act on
  const all = dimensions.map((d) => d.score).filter((v) => v != null);
  return {
    people: (people || []).length,
    scored,
    overall: all.length ? round1(mean(all)) : null,
    dimensions,
    blockers: [...blockers.entries()]
      .map(([blocker, count]) => ({ blocker, count,
        pct: scored ? Math.round((count / scored) * 100) : 0 }))
      .sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker)),
  };
}

// ---- survey data against PMS data (section 25) ------------------------
//
// "Do employees who report low manager support during the first 90 days
// subsequently have lower performance or higher attrition?"
//
// Buckets people by their own score and reports, per bucket, what later
// happened to them. Deliberately NOT a correlation coefficient: with
// tens of people a coefficient invites a confidence nobody has earned,
// while "of the 9 who scored low, 3 have left" is a sentence HR can
// check against the names.
//
// `rows` = [{ employee_id, score, rating, left }]. `bands` are read
// from the caller so the cut points stay configurable.
const DEFAULT_BANDS = [
  { key: 'low', label: 'Scored low (under 50)', min: 0, max: 49.999 },
  { key: 'mid', label: 'Scored middling (50–74)', min: 50, max: 74.999 },
  { key: 'high', label: 'Scored high (75+)', min: 75, max: 100 },
];

function outcomeByBand(rows, bands = DEFAULT_BANDS) {
  const out = bands.map((b) => ({ ...b, n: 0, left: 0, rated: 0, ratings: {} }));
  let unscored = 0;
  for (const r of rows || []) {
    if (r.score == null) { unscored++; continue; }
    const band = out.find((b) => r.score >= b.min && r.score <= b.max);
    if (!band) continue;
    band.n++;
    if (r.left) band.left++;
    if (r.rating) { band.rated++; band.ratings[r.rating] = (band.ratings[r.rating] || 0) + 1; }
  }
  return {
    bands: out.map((b) => ({ ...b,
      attrition_pct: b.n ? Math.round((b.left / b.n) * 100) : null })),
    unscored,
    // Said plainly rather than implied by an empty table: a correlation
    // needs both halves, and on a tenant with no appraisal ratings yet
    // the performance half does not exist.
    has_ratings: out.some((b) => b.rated > 0),
  };
}

module.exports = { toPercent, ruleMatches, flagsFor, groupFlags, worst, scoreByDimension,
                   overallScore, direction, trend, newHireIndex, outcomeByBand,
                   DEFAULT_BANDS };
