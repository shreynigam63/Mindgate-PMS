// node --test — the 9-box rules, as the client's build specification
// states them (13 Oct). Pure: no database.
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../modules/performance/nine-box-rules');

const S = r.normaliseSettings(null);

test('bands: Low below 3.0, Medium 3.0–3.9, High 4.0 and above', () => {
  assert.equal(r.band(2.99, S), 0);
  assert.equal(r.band(3.0, S), 1);
  assert.equal(r.band(3.9, S), 1);
  assert.equal(r.band(3.95, S), 1, '3.95 is Medium: High starts at 4.0');
  assert.equal(r.band(4.0, S), 2);
  assert.equal(r.band(5, S), 2);
  assert.equal(r.band(1, S), 0);
  assert.equal(r.band(null, S), null, 'no score is no band, not Low');
  assert.equal(r.band('', S), null);
  // An average that lands a hair under a limit is not pushed below it.
  assert.equal(r.band(3.9999999, S), 2);
});

test('2.8 is Low now — under the old fractions-of-the-scale rule it was Medium', () => {
  assert.equal(r.band(2.8, S), 0);
  assert.equal(r.band(2.6, S), 0);
});

test('band limits are settings: moving them re-bands', () => {
  const s = { ...S, mid_from: 2.5, high_from: 4.5 };
  assert.equal(r.band(2.8, s), 1);
  assert.equal(r.band(4.2, s), 1);
  assert.equal(r.band(4.5, s), 2);
});

test('performance is the adjustment, else the Delivery Head, else the manager', () => {
  assert.deepEqual(r.performanceScore({ adjustment: '4.5', hod: 3, manager: 2 }), { score: 4.5, source: 'adjustment' });
  assert.deepEqual(r.performanceScore({ adjustment: null, hod: '3.0', manager: 2 }), { score: 3, source: 'hod' });
  assert.deepEqual(r.performanceScore({ manager: '2.0' }), { score: 2, source: 'manager' });
  assert.deepEqual(r.performanceScore({}), { score: null, source: null });
});

test('the competency score is the manager\'s average from a SUBMITTED assessment', () => {
  const rows = [{ manager_rating: 4 }, { manager_rating: 5 }, { manager_rating: null }];
  assert.equal(r.competencyScore(rows, { submitted: true }).score, 4.5);
  assert.equal(r.competencyScore(rows, { submitted: true }).rated, 2);
  const draft = r.competencyScore(rows, { submitted: false });
  assert.equal(draft.score, null, 'a draft does not count');
  assert.equal(draft.reason, 'not_submitted');
  assert.equal(r.competencyScore([], { submitted: false }).reason, 'not_started');
});

test('the questions score counts only when every question is answered 1–5', () => {
  const q = r.DEFAULT_QUESTIONS;
  assert.equal(q.length, 4);
  assert.deepEqual(q.map((x) => x.key), ['learning_agility', 'leadership', 'ownership', 'readiness']);
  assert.equal(r.questionsScore(q, { learning_agility: 4, leadership: 5, ownership: 4, readiness: 5 }).score, 4.5);
  const three = r.questionsScore(q, { learning_agility: 4, leadership: 5, ownership: 4 });
  assert.equal(three.score, null);
  assert.equal(three.answered, 3);
  assert.equal(r.questionsScore(q, { learning_agility: 6, leadership: 5, ownership: 4, readiness: 5 }).score, null);
  assert.equal(r.questionsScore(q, { learning_agility: 3.5, leadership: 5, ownership: 4, readiness: 5 }).score, null);
});

test('potential is 50/50; one half alone stands in for both and is marked partial', () => {
  assert.deepEqual(r.potentialScore(4, 5, 50), { score: 4.5, partial: false, from: 'both' });
  assert.deepEqual(r.potentialScore(4, null, 50), { score: 4, partial: true, from: 'competencies' });
  assert.deepEqual(r.potentialScore(null, 3, 50), { score: 3, partial: true, from: 'questions' });
  assert.deepEqual(r.potentialScore(null, null, 50), { score: null, partial: false, from: null });
  // The weight is a setting.
  assert.equal(r.potentialScore(4, 2, 75).score, 3.5);
  assert.equal(r.potentialScore(4, 2, 0).score, 2);
});

const inputs = (perf, comp, quest, eligible = true) => ({
  performance: { score: perf, source: 'manager' },
  competency: { score: comp }, questions: { score: quest }, eligible,
});

test('ACCEPTANCE: rating 4.2 and potential 4.5 lands in (2,2) Top Performer', () => {
  const p = r.place(inputs(4.2, 4.5, 4.5), S);
  assert.equal(p.status, 'placed');
  assert.equal(p.box_key, '2,2');
  assert.equal(p.box_name, 'Top Performer');
  assert.equal(p.legacy_cell, 'high-high');
  assert.equal(r.actionFor(p.box_key, S).kind, 'succession');
});

test('ACCEPTANCE: rating 2.8 and potential 2.5 lands in (0,0) Underperformer', () => {
  const p = r.place(inputs(2.8, 2.5, 2.5), S);
  assert.equal(p.box_key, '0,0');
  assert.equal(p.box_name, 'Underperformer');
  assert.equal(r.actionFor(p.box_key, S).kind, 'pip');
});

test('the nine boxes carry the spec\'s names, written (Performance, Potential)', () => {
  const name = (perf, pot) => r.place(inputs(perf, pot, pot), S).box_name;
  assert.equal(name(3.5, 4.5), 'High Potential');      // (1,2)
  assert.equal(name(4.5, 3.5), 'High Performer');      // (2,1)
  assert.equal(name(2.0, 4.5), 'Rough Diamond');       // (0,2)
  assert.equal(name(3.5, 3.5), 'Core Player');         // (1,1)
  assert.equal(name(4.5, 2.0), 'Trusted Expert');      // (2,0)
  assert.equal(name(2.0, 3.5), 'Inconsistent Player'); // (0,1)
  assert.equal(name(3.5, 2.0), 'Effective Employee');  // (1,0)
  assert.equal(r.place(inputs(4.5, 2.0, 2.0), S).legacy_cell, 'high-low', 'the write-back keeps performance first');
});

test('not placed: new joiner, no rating, no potential — each said', () => {
  const nj = r.place(inputs(4.5, 4.5, 4.5, false), S);
  assert.equal(nj.status, 'not_placed');
  assert.equal(nj.not_placed_reason, 'new_joiner');
  assert.match(nj.not_placed_text, /first full cycle/);
  assert.equal(nj.perf_band, 2, 'the bands are still worked out — a low one still opens a PIP');
  assert.equal(r.place(inputs(null, 4, 4), S).not_placed_reason, 'no_rating');
  const np = r.place(inputs(2.5, null, null), S);
  assert.equal(np.not_placed_reason, 'no_potential');
  assert.equal(np.perf_band, 0);
});

test('an HR override moves one band; the latest per axis wins; null reverts', () => {
  const rows = [
    { axis: 'potential', to_band: 2, reason: 'Led the migration', overridden_by: 'hr@x', at: '2026-10-01T10:00:00Z' },
    { axis: 'potential', to_band: 1, reason: 'On reflection', overridden_by: 'hr@x', at: '2026-10-02T10:00:00Z' },
    { axis: 'performance', to_band: 0, reason: 'x', overridden_by: 'hr@x', at: '2026-10-01T09:00:00Z' },
    { axis: 'performance', to_band: null, reason: 'Back to the computed band', overridden_by: 'hr@x', at: '2026-10-03T09:00:00Z' },
  ];
  const ov = r.latestOverrides(rows);
  assert.equal(ov.potential.band, 1);
  assert.equal(ov.potential.reason, 'On reflection');
  assert.equal(ov.performance, null);
  const p = r.place(inputs(4.2, 2.0, 2.0), S, ov);
  assert.equal(p.computed_pot_band, 0);
  assert.equal(p.pot_band, 1);
  assert.equal(p.box_key, '2,1');
  // An override can place somebody whose potential is missing.
  const q = r.place(inputs(3.5, null, null), S, { potential: { band: 1, reason: 'r' } });
  assert.equal(q.box_key, '1,1');
});

test('movement: up and down by the sum of the bands, same, across, new', () => {
  assert.equal(r.movement('1,2', '2,2'), 'up');
  assert.equal(r.movement('2,2', '2,1'), 'down');
  assert.equal(r.movement('1,1', '1,1'), 'same');
  assert.equal(r.movement('2,0', '1,1'), 'across');
  assert.equal(r.movement(null, '1,1'), 'new');
  assert.equal(r.movement('1,1', null), null);
});

test('actions: development plans for the four, due dates from the spec\'s words', () => {
  for (const k of ['1,2', '2,1', '0,2', '0,1']) assert.equal(r.actionFor(k, S).kind, 'development_plan');
  assert.equal(r.actionFor('0,2', S).due_days, 30);
  assert.equal(r.actionFor('0,1', S).due_days, 60);
  assert.equal(r.actionFor('1,1', S).due_days, null);
  assert.equal(r.actionFor('2,2', S).action_key, 'box:2,2');
  // HR's wording is what the action says.
  const s = r.normaliseSettings({ boxes: { '1,1': { name: 'Core', action: 'Agree a plan by March' } } });
  assert.equal(r.actionFor('1,1', s).title, 'Agree a plan by March');
  assert.equal(s.boxes['2,2'].name, 'Top Performer', 'unset boxes keep the defaults');
});

test('settings are validated whole, with every problem named', () => {
  const ok = r.validateSettings({ mid_from: 3, high_from: 4, competency_weight: 50, boxes: S.boxes, questions: S.questions });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  const bad = r.validateSettings({ mid_from: 4, high_from: 3.55, competency_weight: 120,
    boxes: { ...S.boxes, '1,1': { name: '', action: '' } }, questions: [] });
  assert.equal(bad.ok, false);
  const all = bad.errors.join(' | ');
  assert.match(all, /Medium limit must be below the High limit/);
  assert.match(all, /one decimal place/);
  assert.match(all, /whole percentage/);
  assert.match(all, /\(1,1\) needs a name/);
  assert.match(all, /At least one potential question/);
});

test('once managers have answered, questions can be reworded but not added or removed', () => {
  const keys = S.questions.map((q) => q.key);
  const reworded = r.validateSettings({ mid_from: 3, high_from: 4, competency_weight: 50, boxes: S.boxes,
    questions: S.questions.map((q) => ({ ...q, label: `${q.label} (clarified)` })) }, { lockedQuestionKeys: keys });
  assert.equal(reworded.ok, true, reworded.errors.join('; '));
  const added = r.validateSettings({ mid_from: 3, high_from: 4, competency_weight: 50, boxes: S.boxes,
    questions: [...S.questions, { label: 'Resilience' }] }, { lockedQuestionKeys: keys });
  assert.equal(added.ok, false);
  assert.match(added.errors.join(' '), /cannot be added or removed/);
});

test('the band sentence follows the limits', () => {
  assert.equal(r.bandText(S), 'Low below 3.0 · Medium 3.0–3.9 · High 4.0 and above');
  assert.equal(r.bandText({ mid_from: 2.5, high_from: 4.5 }), 'Low below 2.5 · Medium 2.5–4.4 · High 4.5 and above');
});
