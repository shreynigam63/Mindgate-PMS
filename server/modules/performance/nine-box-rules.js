// The 9-box grid, as the client's build specification states it (13 Oct,
// "9-Box Grid – PMS Build Specification").
//
// Every employee is placed on two scores, each on the 1–5 scale the PMS
// already uses and each banded the same way:
//
//   0 Low     below 3.0
//   1 Medium  3.0 to 3.9
//   2 High    4.0 and above        (both limits are settings per cycle)
//
// PERFORMANCE is the final rating: the calibration adjustment, else the
// Delivery Head's rating, else the manager's. The same order publish uses.
//
// POTENTIAL is the average of two halves, 50/50 by default and editable
// per cycle (the client's answer to open question 4):
//   - the competency score: the manager's ratings of the role's
//     competencies, averaged, from a submitted My Competencies assessment;
//   - the manager's four potential questions (learning agility,
//     leadership, ownership, readiness for a bigger role), each 1–5.
// When one half is missing the other is used alone and the score is
// marked partial, so a missing competency assessment does not leave a
// person off the grid.
//
// A box is written (Performance, Potential): (0,0) bottom-left, (2,2)
// top-right — the spec's standard layout, confirmed with the client.
//
// This replaces nine-box-derive.js (24 Sep), whose rules the spec
// overturns: bands were fractions of the scale (2.6 was Medium), and
// potential was a gap against required level over two categories only.
//
// Pure — no db, no express — so every rule here is settled by a test.

const LEGACY = ['low', 'mid', 'high'];
const BAND_NAMES = ['Low', 'Medium', 'High'];
const AXES = ['performance', 'potential'];

// The spec's nine boxes, names and default actions. HR edits names and
// actions per cycle; these are what a cycle starts from.
const DEFAULT_BOXES = {
  '2,2': { name: 'Top Performer', meaning: 'Delivers above target and ready for more',
    action: 'Added to the succession pool; retention review; checked against Super 50' },
  '1,2': { name: 'High Potential', meaning: 'Strong potential, performance still growing',
    action: 'Stretch assignment and development plan aimed at Top Performer (2,2)' },
  '2,1': { name: 'High Performer', meaning: 'Strong delivery, moderate potential',
    action: 'Recognition; development plan for the next level' },
  '0,2': { name: 'Rough Diamond', meaning: 'High potential, low current performance',
    action: 'Manager coaching and role-fit review within 30 days' },
  '1,1': { name: 'Core Player', meaning: 'Solid on both',
    action: 'Standard development plan' },
  '2,0': { name: 'Trusted Expert', meaning: 'Strong in current role, limited growth appetite',
    action: 'Retain in role; recognise expertise' },
  '0,1': { name: 'Inconsistent Player', meaning: 'Low performance, some potential',
    action: 'Improvement conversation and 60-day goals' },
  '1,0': { name: 'Effective Employee', meaning: 'Meets expectations in current role',
    action: 'Skills training in the current role' },
  '0,0': { name: 'Underperformer', meaning: 'Low on both',
    action: 'Automatic PIP opened at publish' },
};
const BOX_KEYS = ['2,2', '1,2', '2,1', '0,2', '1,1', '2,0', '0,1', '1,0', '0,0'];

const DEFAULT_QUESTIONS = [
  { key: 'learning_agility', label: 'Learning agility', hint: 'Picks up new skills, tools and situations quickly.' },
  { key: 'leadership', label: 'Leadership', hint: 'Guides, influences and develops others, with or without a title.' },
  { key: 'ownership', label: 'Ownership', hint: 'Takes responsibility for outcomes and follows through.' },
  { key: 'readiness', label: 'Readiness for a bigger role', hint: 'Could take on a larger scope in the next 1–2 years.' },
];

const DEFAULT_SETTINGS = Object.freeze({
  mid_from: 3.0, high_from: 4.0, competency_weight: 50,
  boxes: DEFAULT_BOXES, questions: DEFAULT_QUESTIONS,
});

// What the system does in each box at publish. FIXED, not a setting: the
// client settled that (0,0) opens a PIP and (2,2) joins the succession
// pool. HR changes the wording of the action, not whether a PIP opens.
// Due days come from the spec's own words ("within 30 days", "60-day").
const ACTION_KIND = {
  '0,0': 'pip',
  '2,2': 'succession',
  '1,2': 'development_plan', '2,1': 'development_plan', '0,2': 'development_plan', '0,1': 'development_plan',
  '1,1': 'follow_up', '2,0': 'follow_up', '1,0': 'follow_up',
};
const DUE_DAYS = { '0,2': 30, '0,1': 60 };

const NOT_PLACED = {
  new_joiner: 'New joiner — placed after their first full cycle',
  no_rating: 'No final rating yet',
  no_potential: 'No potential input — neither the four questions nor a submitted competency assessment',
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// A score's band. Rounded to two places first, so an average that lands
// on 3.9999… is not Low-by-a-hair: 3.95 is Medium, 4.0 is High.
function band(score, limits = DEFAULT_SETTINGS) {
  const s = num(score);
  if (s == null) return null;
  const r = round2(s);
  if (r >= Number(limits.high_from)) return 2;
  if (r >= Number(limits.mid_from)) return 1;
  return 0;
}

// Final rating and where it came from, in the order publish reads them.
function performanceScore({ adjustment, hod, manager } = {}) {
  if (num(adjustment) != null) return { score: round2(adjustment), source: 'adjustment' };
  if (num(hod) != null) return { score: round2(hod), source: 'hod' };
  if (num(manager) != null) return { score: round2(manager), source: 'manager' };
  return { score: null, source: null };
}

// The competency half: the manager's ratings, averaged, from an
// assessment the manager has SUBMITTED. A draft is the manager still
// deciding, and a number HR calibrates against should be one somebody
// committed to.
function competencyScore(rows = [], { submitted = false } = {}) {
  const rated = rows.map((r) => num(r && r.manager_rating)).filter((v) => v != null);
  const total = rows.length;
  if (!submitted) return { score: null, rated: rated.length, total, submitted: false, reason: total ? 'not_submitted' : 'not_started' };
  if (!rated.length) return { score: null, rated: 0, total, submitted: true, reason: 'not_rated' };
  return { score: round2(rated.reduce((a, b) => a + b, 0) / rated.length), rated: rated.length, total, submitted: true, reason: null };
}

// The questions half: counts only when every question is answered with a
// whole number 1–5. Three of four is a different question set from the
// one everybody else was measured on.
function questionsScore(questions = DEFAULT_QUESTIONS, answers = {}) {
  const a = answers || {};
  const vals = questions.map((q) => {
    const v = num(a[q.key]);
    return v != null && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
  });
  const answered = vals.filter((v) => v != null).length;
  if (!questions.length || answered < questions.length) {
    return { score: null, answered, total: questions.length, complete: false };
  }
  return { score: round2(vals.reduce((x, y) => x + y, 0) / vals.length), answered, total: questions.length, complete: true };
}

// The two halves, weighted. One half alone stands in for both, marked
// partial — the client's answer to open question 4.
function potentialScore(comp, quest, competencyWeight = 50) {
  const c = num(comp); const q = num(quest);
  const w = Math.min(100, Math.max(0, Number(competencyWeight)));
  if (c != null && q != null) return { score: round2((c * w + q * (100 - w)) / 100), partial: false, from: 'both' };
  if (c != null) return { score: c, partial: true, from: 'competencies' };
  if (q != null) return { score: q, partial: true, from: 'questions' };
  return { score: null, partial: false, from: null };
}

// The latest override per axis wins; a null to_band takes the axis back
// to its computed band. Rows are pms.nine_box_overrides, any order.
function latestOverrides(rows = []) {
  const out = {};
  const sorted = [...rows].sort((a, b) => new Date(a.at) - new Date(b.at));
  for (const r of sorted) {
    if (!AXES.includes(r.axis)) continue;
    out[r.axis] = r.to_band == null ? null : {
      band: Number(r.to_band), reason: r.reason, by: r.overridden_by, at: r.at,
    };
  }
  return out;
}

const boxKey = (p, q) => `${p},${q}`;
const legacyCell = (p, q) => `${LEGACY[p]}-${LEGACY[q]}`;
const boxName = (key, settings = DEFAULT_SETTINGS) => {
  const b = (settings.boxes || {})[key] || DEFAULT_BOXES[key];
  return b ? b.name : null;
};

// One person's placement.
//   inputs:   { performance: {score, source}, competency: competencyScore(),
//               questions: questionsScore(), eligible: bool }
//   settings: limits, weight, box names
//   overrides: latestOverrides()
function place(inputs, settings = DEFAULT_SETTINGS, overrides = {}) {
  const perf = inputs.performance || { score: null, source: null };
  const comp = inputs.competency || { score: null };
  const quest = inputs.questions || { score: null };
  const pot = potentialScore(comp.score, quest.score, settings.competency_weight);
  const computedPerf = band(perf.score, settings);
  const computedPot = band(pot.score, settings);
  const ov = { performance: overrides.performance || null, potential: overrides.potential || null };
  const perfBand = ov.performance ? ov.performance.band : computedPerf;
  const potBand = ov.potential ? ov.potential.band : computedPot;
  const base = {
    performance_score: perf.score, performance_source: perf.source,
    competency_score: comp.score ?? null, questions_score: quest.score ?? null,
    potential_score: pot.score, potential_partial: pot.partial, potential_from: pot.from,
    computed_perf_band: computedPerf, computed_pot_band: computedPot,
    perf_band: perfBand, pot_band: potBand, overrides: ov,
  };
  let reason = null;
  if (inputs.eligible === false) reason = 'new_joiner';
  else if (perfBand == null) reason = 'no_rating';
  else if (potBand == null) reason = 'no_potential';
  if (reason) {
    return { ...base, status: 'not_placed', not_placed_reason: reason, not_placed_text: NOT_PLACED[reason],
      box_key: null, box_name: null, legacy_cell: null };
  }
  const key = boxKey(perfBand, potBand);
  return { ...base, status: 'placed', not_placed_reason: null, not_placed_text: null,
    box_key: key, box_name: boxName(key, settings), legacy_cell: legacyCell(perfBand, potBand) };
}

// Box to box. "Up" and "down" by the sum of the two bands, so a move to
// the right or upwards is up; a move across the same diagonal (e.g.
// (2,0) to (1,1)) is neither, and is said as such rather than forced
// into one of the two.
function movement(prevKey, curKey) {
  if (!curKey) return null;
  if (!prevKey) return 'new';
  if (prevKey === curKey) return 'same';
  const sum = (k) => k.split(',').reduce((a, b) => a + Number(b), 0);
  const d = sum(curKey) - sum(prevKey);
  return d > 0 ? 'up' : d < 0 ? 'down' : 'across';
}

// The action a placement creates at publish. One per box, keyed on the
// box so a re-publish that moves somebody makes the new box's action and
// leaves the old one to be marked superseded.
function actionFor(key, settings = DEFAULT_SETTINGS) {
  if (!key) return null;
  const box = (settings.boxes || {})[key] || DEFAULT_BOXES[key];
  return { action_key: `box:${key}`, kind: ACTION_KIND[key], title: box.action, due_days: DUE_DAYS[key] || null };
}

// A cycle's settings as stored, laid over the defaults so a row written
// before a box or question existed still reads whole.
function normaliseSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS, boxes: { ...DEFAULT_BOXES }, questions: DEFAULT_QUESTIONS.map((q) => ({ ...q })) };
  const boxes = {};
  for (const k of BOX_KEYS) boxes[k] = { ...DEFAULT_BOXES[k], ...((row.boxes || {})[k] || {}) };
  const questions = Array.isArray(row.questions) && row.questions.length ? row.questions : DEFAULT_QUESTIONS;
  return {
    mid_from: Number(row.mid_from ?? DEFAULT_SETTINGS.mid_from),
    high_from: Number(row.high_from ?? DEFAULT_SETTINGS.high_from),
    competency_weight: Number(row.competency_weight ?? DEFAULT_SETTINGS.competency_weight),
    boxes, questions: questions.map((q) => ({ key: q.key, label: q.label, hint: q.hint || '' })),
  };
}

// Validating what HR sends. Every problem at once, so the form can mark
// all of them rather than one per save.
function validateSettings(body = {}, { lockedQuestionKeys = null } = {}) {
  const errors = [];
  const mid = num(body.mid_from); const high = num(body.high_from); const w = num(body.competency_weight);
  if (mid == null || high == null) errors.push('Both band limits are needed.');
  else {
    if (mid < 1 || high > 5) errors.push('Band limits sit on the 1–5 scale.');
    if (!(mid < high)) errors.push('The Medium limit must be below the High limit.');
    if (Math.round(mid * 10) !== mid * 10 || Math.round(high * 10) !== high * 10) errors.push('Band limits take one decimal place, e.g. 3.0.');
  }
  if (w == null || !Number.isInteger(w) || w < 0 || w > 100) errors.push('The competency weight is a whole percentage, 0 to 100.');
  const boxes = {};
  for (const k of BOX_KEYS) {
    const b = (body.boxes || {})[k] || {};
    const name = String(b.name ?? '').trim();
    const action = String(b.action ?? '').trim();
    if (!name) errors.push(`Box (${k}) needs a name.`);
    if (!action) errors.push(`Box (${k}) needs an action.`);
    if (name.length > 60) errors.push(`Box (${k}): the name is longer than 60 characters.`);
    if (action.length > 300) errors.push(`Box (${k}): the action is longer than 300 characters.`);
    boxes[k] = { name, action, meaning: DEFAULT_BOXES[k].meaning };
  }
  const names = BOX_KEYS.map((k) => boxes[k].name.toLowerCase()).filter(Boolean);
  if (new Set(names).size !== names.length) errors.push('Two boxes have the same name.');
  const qs = Array.isArray(body.questions) ? body.questions : [];
  const questions = [];
  const seen = new Set();
  for (const [i, q] of qs.entries()) {
    const label = String((q && q.label) || '').trim();
    let key = String((q && q.key) || '').trim().toLowerCase();
    if (!key) key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!label) { errors.push(`Question ${i + 1} needs a wording.`); continue; }
    if (label.length > 120) errors.push(`Question ${i + 1} is longer than 120 characters.`);
    if (!key || seen.has(key)) { errors.push(`Question ${i + 1} repeats another question.`); continue; }
    seen.add(key);
    questions.push({ key, label, hint: String((q && q.hint) || '').trim().slice(0, 200) });
  }
  if (!questions.length && !errors.some((e) => e.startsWith('Question'))) errors.push('At least one potential question is needed.');
  if (questions.length > 8) errors.push('Eight questions at most.');
  // Once a manager has answered, the question set is fixed for the cycle:
  // a new question would leave every saved answer incomplete, and a
  // removed one would drop part of what was already said. Wording can
  // still be clarified.
  if (lockedQuestionKeys) {
    const now = questions.map((q) => q.key).sort().join('|');
    if (now !== [...lockedQuestionKeys].sort().join('|')) {
      errors.push('Managers have already answered the potential questions this cycle, so questions cannot be added or removed — only reworded.');
    }
  }
  return {
    ok: !errors.length, errors,
    value: { mid_from: mid, high_from: high, competency_weight: w, boxes, questions },
  };
}

// The band sentence a screen prints beside the grid.
function bandText(s = DEFAULT_SETTINGS) {
  const mid = Number(s.mid_from).toFixed(1); const high = Number(s.high_from).toFixed(1);
  const below = (Math.round(Number(s.high_from) * 10 - 1) / 10).toFixed(1);
  return `Low below ${mid} · Medium ${mid}–${below} · High ${high} and above`;
}

module.exports = {
  LEGACY, BAND_NAMES, AXES, BOX_KEYS, DEFAULT_BOXES, DEFAULT_QUESTIONS, DEFAULT_SETTINGS,
  ACTION_KIND, DUE_DAYS, NOT_PLACED,
  band, performanceScore, competencyScore, questionsScore, potentialScore, latestOverrides,
  boxKey, legacyCell, boxName, place, movement, actionFor, normaliseSettings, validateSettings, bandText, round2,
};
