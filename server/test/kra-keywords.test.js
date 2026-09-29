// node --test — keywords on a KRA.
//
// Phase 1 of the Zoho timesheet rating engine specced on 29 Sep:
// "Each employee's KRA library items must have associated Keywords."
//
// Pure: parsing and normalising, no database. These rules decide what
// phase 2's matching will actually see, so getting them wrong is not a
// display bug — it is a coverage percentage that counts one idea three
// times and a rating built on it.
//
// NOTHING SCORES ANYTHING YET, and no test here pretends otherwise.
const { test } = require('node:test');
const assert = require('node:assert');
const k = require('../modules/performance/kra-keywords');

test('a spreadsheet cell becomes a list', () => {
  // How they will actually arrive: one cell, the separators a human
  // reaches for, and whatever whitespace survived the paste.
  assert.deepEqual(
    k.parseKeywords('Development, Bug Fixing; Code Review | Sprint  Execution'),
    ['development', 'bug fixing', 'code review', 'sprint execution']);
  assert.deepEqual(k.parseKeywords('Development\nBug Fixing\r\nCode Review'),
    ['development', 'bug fixing', 'code review']);
});

test('multi-word keywords are NOT split on spaces', () => {
  // The bug this prevents: splitting "bug fixing" into "bug" and
  // "fixing" makes every task mentioning a bug match, and every task
  // mentioning fixing anything at all. The phrase is the keyword.
  assert.deepEqual(k.parseKeywords('bug fixing'), ['bug fixing']);
  assert.deepEqual(k.parseKeywords('cross-team support'), ['cross-team support']);
});

test('case and spacing collapse to one keyword, not three', () => {
  // Stored three ways, a coverage percentage counts one idea three
  // times and HR sees a list that looks like a mistake.
  assert.deepEqual(k.parseKeywords(['Bug Fixing', 'bug fixing', '  BUG   FIXING  ']), ['bug fixing']);
  assert.deepEqual(k.parseKeywords('Code Review, code review'), ['code review']);
});

test('empties and separators alone produce nothing, not blank keywords', () => {
  // A trailing comma is the commonest thing in a hand-typed cell. A
  // blank keyword would match every task ever logged.
  for (const raw of ['', '   ', ',,,', ' , ; | ', null, undefined, []]) {
    assert.deepEqual(k.parseKeywords(raw), [], JSON.stringify(raw));
  }
  assert.deepEqual(k.parseKeywords('development,'), ['development']);
});

test('a sentence pasted into the cell is refused, and said so', () => {
  // Someone will paste the KRA description. Silently storing it gives a
  // keyword that matches nothing and a list that looks broken.
  const long = 'deliver all client projects on time and within the agreed quality thresholds every quarter';
  assert.ok(long.length > k.MAX_LENGTH);
  assert.deepEqual(k.parseKeywords(`development, ${long}`), ['development']);
  const r = k.parseWithReasons(`development, ${long}`);
  assert.deepEqual(r.keywords, ['development']);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0].reason, /sentence, not a keyword/);
});

test('what was dropped is reported, never silently lost', () => {
  // Same discipline as the employee importer: per-row reasons, so a
  // bulk upload can say what it did not take.
  const r = k.parseWithReasons('a, a, b');
  assert.deepEqual(r.keywords, ['a', 'b']);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].reason, 'duplicate');
});

test('a KRA cannot carry more keywords than it has meaning', () => {
  const many = Array.from({ length: 60 }, (_, i) => `kw${i}`).join(',');
  const got = k.parseKeywords(many);
  assert.equal(got.length, k.MAX_KEYWORDS);
  const r = k.parseWithReasons(many);
  assert.equal(r.keywords.length, k.MAX_KEYWORDS);
  assert.ok(r.dropped.length > 0);
  assert.match(r.dropped[0].reason, /over the limit/);
});

test('display title-cases without changing what is stored', () => {
  assert.equal(k.displayKeyword('bug fixing'), 'Bug Fixing');
  assert.equal(k.displayKeyword('cross-team support'), 'Cross-team Support');
  assert.equal(k.displayKeyword(''), '');
});

// ---- the three bulk modes ----------------------------------------------

test('ADD leaves what is already there alone', () => {
  // The mode HR will use most: tag forty Development KRAs without
  // touching the keywords somebody already curated on them.
  assert.deepEqual(k.applyMode(['development'], 'Code Review', 'add'),
    ['development', 'code review']);
  // Idempotent: applying the same set twice does not duplicate.
  assert.deepEqual(k.applyMode(['development', 'code review'], 'Code Review, development', 'add'),
    ['development', 'code review']);
  // Existing order is preserved, so a curated list does not reshuffle.
  assert.deepEqual(k.applyMode(['zebra', 'apple'], 'mango', 'add'), ['zebra', 'apple', 'mango']);
});

test('REMOVE takes out only what was named', () => {
  assert.deepEqual(k.applyMode(['development', 'code review', 'testing'], 'code review', 'remove'),
    ['development', 'testing']);
  // Removing something absent is a no-op, not an error.
  assert.deepEqual(k.applyMode(['development'], 'nothing here', 'remove'), ['development']);
  // Case-insensitively, because the stored form is lowercase.
  assert.deepEqual(k.applyMode(['bug fixing'], 'Bug Fixing', 'remove'), []);
});

test('REPLACE replaces, and add never silently becomes replace', () => {
  assert.deepEqual(k.applyMode(['development', 'testing'], 'code review', 'replace'), ['code review']);
  assert.deepEqual(k.applyMode(['development', 'testing'], 'code review', 'add'),
    ['development', 'testing', 'code review']);
});

test('the add cap holds even when the existing list is already long', () => {
  const full = Array.from({ length: k.MAX_KEYWORDS }, (_, i) => `kw${i}`);
  assert.equal(k.applyMode(full, 'one more', 'add').length, k.MAX_KEYWORDS);
});

// ---- what the bulk route will accept ------------------------------------

test('a bulk edit needs keywords, and an unknown mode is refused', () => {
  assert.match(k.validateBulk({ mode: 'sideways', keywords: 'a' }), /Unknown mode/);
  assert.match(k.validateBulk({ mode: 'add', keywords: '' }), /at least one keyword/i);
  assert.match(k.validateBulk({ mode: 'remove', keywords: '   ' }), /at least one keyword/i);
  assert.equal(k.validateBulk({ mode: 'add', keywords: 'development' }), null);
});

test('CLEARING every matching KRA has to be said out loud', () => {
  // "replace with nothing" is a legitimate instruction and a
  // destructive one over a filter that may match 800 rows. It must not
  // be inferable from an empty box somebody tabbed past.
  assert.match(k.validateBulk({ mode: 'replace', keywords: '' }), /clear the keywords on every matching KRA/);
  assert.equal(k.validateBulk({ mode: 'replace', keywords: '', confirm_clear: true }), null);
  // And with keywords present it needs no confirmation.
  assert.equal(k.validateBulk({ mode: 'replace', keywords: 'testing' }), null);
});
