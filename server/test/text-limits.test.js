// node --test — how much can be typed into a box (20 Oct, from the
// client's QA: Def-022, Def-023, Def-025). One-line fields 150 characters;
// anything written at length 220 words and 2,000 characters; meeting
// minutes, transcripts, templates and settings left alone. Pure.
const { test } = require('node:test');
const assert = require('node:assert');
const { textProblem, textLimits } = require('../core/text-limits');

const words = (n) => Array(n).fill('word').join(' ');
const run = (method, url, body) => {
  let status = null; let sent = null; let passed = false;
  const res = { status(s) { status = s; return this; }, json(b) { sent = b; return this; } };
  textLimits({ method, originalUrl: url, body }, res, () => { passed = true; });
  return { status, sent, passed };
};

test('a one-line field is held to 150 characters, named in words', () => {
  assert.equal(textProblem({ title: 'x'.repeat(150) }), null);
  assert.equal(textProblem({ title: 'x'.repeat(151) }), '"Title" is too long — keep it to 150 characters (it has 151).');
  assert.match(textProblem({ kras: [{ title: 'ok', measures: 'fine' }, { title: 'y'.repeat(200) }] }), /"Title".*150 characters/);
});

test('a comment or description is held to 220 words, and 2,000 characters for one long unbroken string', () => {
  assert.equal(textProblem({ went_well: words(220) }), null);
  assert.equal(textProblem({ went_well: words(221) }), '"What went well" is too long — keep it to 220 words (it has 221).');
  // Def-022's screenshot: one "word" thousands of letters long.
  assert.match(textProblem({ top_responsibilities: 'Ajman'.repeat(500) }), /"Top 5 responsibilities".*2000 characters/);
  // Per-KRA entries keyed by id: the field inside is what is checked.
  const id = 'a0c1f9b2-1111-2222-3333-444455556666';
  assert.match(textProblem({ entries: { [id]: { self_rating: 4, narrative: words(300) } } }), /"Narrative".*220 words \(it has 300\)/);
  assert.match(textProblem({ kras: [{ title: 'Quality', measures: words(230) }] }), /"How it is measured \(KPI\)"/);
});

test('numbers, ids, links and settings are not text a person typed, and are not counted', () => {
  assert.equal(textProblem({ weight: 50, employee_id: 'a0c1f9b2-1111-2222-3333-444455556666', meet_link: `https://meet.example.com/${'a'.repeat(300)}`,
    logo: `data:image/png;base64,${'A'.repeat(5000)}`, held_at: '2026-10-20' }), null);
});

test('the middleware refuses with 422 on a save, and leaves reads and long-by-nature routes alone', () => {
  const long = { description: words(400) };
  let r = run('POST', '/api/v1/people/queries', { title: 'Payslip', ...long });
  assert.equal(r.status, 422);
  assert.match(r.sent.error, /"Description" is too long — keep it to 220 words \(it has 400\)/);
  assert.equal(run('GET', '/api/v1/people/queries', long).passed, true);
  // Meeting minutes and transcripts are long by nature.
  assert.equal(run('PUT', '/api/v1/pms/mom/meetings/x/minutes', { notes: words(900) }).passed, true);
  assert.equal(run('PUT', '/api/v1/pms/meetings/x/transcript', { text: words(5000) }).passed, true);
  assert.equal(run('POST', '/api/v1/people/onboarding/tasks/x/mark-sent', { body: words(600) }).passed, true);
  // Within the limit, through.
  assert.equal(run('POST', '/api/v1/people/queries', { title: 'Payslip', description: words(50) }).passed, true);
});
