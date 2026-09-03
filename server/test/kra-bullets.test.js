// node --test — AI drafts come back as short bullets grouped by KRA, and
// the plain text that lands in a form field is composed from those same
// bullets rather than written separately.
//
// Requested after a mid-year draft arrived as three dense paragraphs.
// Pure — no database, no model call.
const { test } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kb';
process.env.TENANT_SLUG = process.env.TENANT_SLUG || 'kb-test';
const { renderKraBullets, KRA_BULLET_RULES } = require('../modules/agentic');

test('renders one block per KRA, each bullet on its own line', () => {
  const byKra = [
    { kra: 'On-Time Delivery', progress: ['Shipped all four milestones on plan', 'No slippage on the March release'] },
    { kra: 'Code Review Compliance', progress: ['Peer review coverage held at 100%'] },
  ];
  assert.equal(renderKraBullets(byKra, 'progress'),
    'On-Time Delivery\n- Shipped all four milestones on plan\n- No slippage on the March release\n\n'
    + 'Code Review Compliance\n- Peer review coverage held at 100%');
});

test('a KRA with nothing in the requested list is left out, not shown as an empty heading', () => {
  // The model is told to return an empty list rather than pad it, so empty
  // is a real answer — printing a bare KRA heading would misrepresent it.
  const byKra = [
    { kra: 'On-Time Delivery', progress: ['Shipped on plan'], blockers: [] },
    { kra: 'Budget Adherence', progress: [], blockers: ['Vendor invoice still unresolved'] },
  ];
  assert.equal(renderKraBullets(byKra, 'progress'), 'On-Time Delivery\n- Shipped on plan');
  assert.equal(renderKraBullets(byKra, 'blockers'), 'Budget Adherence\n- Vendor invoice still unresolved');
});

test('cross-cutting points are appended once, under their own heading', () => {
  const out = renderKraBullets(
    [{ kra: 'On-Time Delivery', strengths: ['Consistent milestone tracking'] }],
    'strengths',
    ['Communicates risk early across every workstream']);
  assert.equal(out,
    'On-Time Delivery\n- Consistent milestone tracking\n\n'
    + 'Across KRAs\n- Communicates risk early across every workstream');
});

test('blank and whitespace-only bullets are dropped rather than rendered as empty dashes', () => {
  const out = renderKraBullets(
    [{ kra: 'Quality', strengths: ['Real point', '   ', '', null] }], 'strengths');
  assert.equal(out, 'Quality\n- Real point');
});

test('a draft with nothing in it renders as empty text, not "undefined"', () => {
  assert.equal(renderKraBullets(undefined, 'strengths'), '');
  assert.equal(renderKraBullets([], 'strengths'), '');
  assert.equal(renderKraBullets([{ kra: 'X' }], 'strengths'), '');
  assert.equal(renderKraBullets([{ kra: 'X', strengths: 'not an array' }], 'strengths'), '');
});

test('the house style states checkable limits, not adjectives', () => {
  // "Be concise" is advice every model already believes it follows. The
  // rules have to be things the model can verify about its own output.
  assert.match(KRA_BULLET_RULES, /at most 18 words/);
  assert.match(KRA_BULLET_RULES, /at most 3 bullets/i);
  assert.match(KRA_BULLET_RULES, /EXACT title/);
  assert.match(KRA_BULLET_RULES, /never paragraphs/i);
});
