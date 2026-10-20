// How much can be typed into a box (20 Oct, from the client's QA: Def-022,
// Def-023, Def-025 — the text boxes on My Competencies and My KRAs took any
// amount, including one unbroken string thousands of characters long).
//
//   - a one-line field (a title, a name, a topic): at most 150 characters;
//   - anything written at length (a comment, a description, an answer):
//     at most 220 words, and never more than 2,000 characters, which is
//     what stops a single 5,000-letter "word".
//
// The screens count as you type and stop at the limit; this is the same
// rule on the server, so it holds for every way in, not only the forms.
// Checked on every JSON save under /pms, /people and /engagement, field by
// field, nested lists and per-KRA entries included.
//
// LEFT ALONE, because they are long by nature and not typed into a box:
// meeting minutes and transcripts, HR's letter and email templates,
// settings, and anything that is not text a person wrote (ids, links,
// images, files).
const SHORT_CHARS = 150;
const WORD_LIMIT = 220;
const LONG_CHARS = 2000;

// Fields that are one line on screen.
const SHORT_KEYS = new Set([
  'title', 'subject', 'topic', 'name', 'team_name', 'project', 'target_role', 'target_timeline',
  'label', 'designation', 'department', 'category', 'area', 'expected', 'success_measure',
  'hint', 'item', 'provider', 'proposed_designation', 'proposed_band', 'role_band',
  'tech_primary', 'tech_secondary', 'tech_tertiary',
]);
// Never text a person typed into a form box.
const SKIP_KEY = /(^|_)(id|ids|url|link|meet_link|email|emails|logo|image|file|data|csv|json|token|password|secret|key|svg|html|template|templates|transcript|content|markdown|prompt|holidays|keywords|items|itemstext|date|at|scale|rating_scale|settings)$/i;
// Routes whose text is long by nature.
const SKIP_PATH = /^\/api\/v1\/(pms\/(mom|meetings|closure-letters|hr\/settings|timesheet\/settings|nine-box\/settings)|people\/onboarding|engagement\/templates)(\/|$)/;

const words = (s) => (String(s).match(/\S+/g) || []).length;
// The names the screens use, where the stored name is not one.
const LABELS = {
  measures: 'How it is measured (KPI)', went_well: 'What went well', could_improve: 'What could improve',
  improvement_areas: 'Areas to improve', self_evidence: 'Evidence', discussion_notes: 'What was discussed',
  manager_comment: "Manager's comment", hod_comment: 'Comment', performance_description: 'The concern',
  business_impact: 'Business impact', quantified_impact: 'Quantified impact', closed_reason: 'Why it is closed',
  manager_narrative: 'Your narrative', self_narrative: 'Your narrative', team_members: 'Team members',
  top_responsibilities: 'Top 5 responsibilities', critical_outcomes: 'Most critical outcomes',
  strongest_areas: 'Strongest areas', challenging_areas: 'Most challenging areas', develop_next: 'Competencies to develop',
  preferred_methods: 'Preferred development methods', aspiration_2_3_years: 'Where you see yourself in 2–3 years',
  next_role_competencies: 'Competencies for your next role', internal_mobility: 'Internal mobility', support_needed: 'Support needed',
};
const labelOf = (key) => LABELS[key] || String(key).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The first field over its limit, as a sentence, or null. Pure. */
function textProblem(body, path = []) {
  if (body == null || typeof body !== 'object') return null;
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    // Per-KRA maps are keyed by an id; the field inside is what is checked.
    const key = /^[0-9a-f-]{36}$/i.test(k) || /^\d+$/.test(k) ? path[path.length - 1] : k;
    if (typeof v === 'object') {
      const p = textProblem(v, [...path, key]);
      if (p) return p;
      continue;
    }
    if (typeof v !== 'string' || !key || SKIP_KEY.test(key)) continue;
    const s = v.trim();
    if (!s) continue;
    if (SHORT_KEYS.has(key)) {
      if (s.length > SHORT_CHARS) return `"${labelOf(key)}" is too long — keep it to ${SHORT_CHARS} characters (it has ${s.length}).`;
    } else {
      const n = words(s);
      if (n > WORD_LIMIT) return `"${labelOf(key)}" is too long — keep it to ${WORD_LIMIT} words (it has ${n}).`;
      if (s.length > LONG_CHARS) return `"${labelOf(key)}" is too long — keep it to ${LONG_CHARS} characters (it has ${s.length}).`;
    }
  }
  return null;
}

function textLimits(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  if (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return next();
  if (SKIP_PATH.test(req.originalUrl.split('?')[0])) return next();
  const problem = textProblem(req.body);
  if (problem) return res.status(422).json({ error: problem });
  next();
}

module.exports = { textLimits, textProblem, SHORT_CHARS, WORD_LIMIT, LONG_CHARS, SHORT_KEYS };
