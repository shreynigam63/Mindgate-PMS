// node --test — no screen prints a performance rating as a number.
//
// Reported on 28 Sep with a screenshot of the Mid-Year checkpoint:
// "ratings still shows average number instead of alphabets average."
// The panel read `Self 4.1 (submitted)`.
//
// The 24 Sep instruction was "ratings should be measured only in
// Alphabets and not numbers", and it was answered with one formatter
// (src/grade.jsx). The formatter was then used on the screens that were
// looked at, and the rest went on printing the stored number. Five of
// them were still doing it four days later.
//
// So this is a SOURCE test, not a browser test, and deliberately: the
// thing that keeps failing is coverage — some page nobody opened — and
// only reading every page catches that. A browser test proves one
// screen on one set of demo data; this one cannot be satisfied by
// fixing the screens somebody happened to look at.
//
// It needs no stack and no database, so it runs in a second and there
// is no excuse to skip it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

// Fields that hold a PERFORMANCE rating — a number on the cycle's
// rating scale. Timesheet RAG status, engagement index and competency
// levels are different measures on different scales and are not here.
const RATING_FIELDS = [
  'self_rating', 'manager_rating', 'overall_rating', 'final_rating', 'hod_rating',
  'self_overall', 'manager_overall', 'partial_overall',
];

// Lines that name a rating field but are not rendering one. Each needs
// a reason, so the list cannot quietly grow into "everything".
const NOT_A_RENDER = [
  /^\s*(const|let|var|import|export)\b/,          // declarations
  /=>\s*$/,                                        // arrow heads
  /\b(useState|setState|set[A-Z]\w*)\s*\(/,        // state plumbing
  /JSON\.stringify|body:|method:|api\(/,           // requests
  /^\s*\/\/|^\s*\*|^\s*\{\s*\/\*/,                 // comments
  /\b(===|!==|\?\?=|\|\||&&)\s*(null|undefined)/,  // guards
  /\.filter\(|\.map\(\s*\(?\w+\)?\s*=>\s*\w+\.\w+\s*\)|\.reduce\(|\.sort\(/,
  /with_final_rating/,                             // a COUNT of people, not a rating
  /rating_label|rating_scale|potential_rating/,    // a word, the scale itself, 9-box axis
];

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name));
    else if (e.name.endsWith('.jsx')) files.push(join(dir, e.name));
  }
};
walk(SRC);

const read = (f) => readFileSync(f, 'utf8').split('\n');
const rel = (f) => f.slice(SRC.length);

// Every `{...}` on a line, with the character just before it, so an
// attribute value (`prop={x}`) can be told from a text-position brace
// (`<b>{x}</b>`). Only the second one puts a number in front of a
// person; the first is passing data to a component that will format it.
function textBraces(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '{') continue;
    let depth = 0, j = i;
    for (; j < line.length; j++) {
      if (line[j] === '{') depth++;
      else if (line[j] === '}') { depth--; if (!depth) break; }
    }
    if (depth) break;                       // unterminated on this line
    const before = line.slice(0, i).trimEnd().slice(-1);
    if (before !== '=') out.push(line.slice(i, j + 1));
    i = j;
  }
  return out;
}

test('every rating field reaches the screen through the grade formatter', () => {
  const raw = [];
  for (const f of files) {
    if (rel(f) === 'grade.jsx') continue;          // the formatter itself
    read(f).forEach((line, i) => {
      if (NOT_A_RENDER.some((re) => re.test(line))) return;
      // Wrapped is fine — <Grade value={x}/>, grade(x, scale) and the
      // page-local wrappers around it are the formatter.
      if (/<Grade\b/.test(line) || /\bgrade\s*\(/.test(line) || /Label\s*\(/.test(line)) return;
      for (const span of textBraces(line)) {
        for (const field of RATING_FIELDS) {
          // `field:` is an object key — a request payload or a state
          // patch, not something on screen.
          if (!new RegExp(`\\b${field}\\b`).test(span)) continue;
          if (new RegExp(`\\b${field}\\s*:`).test(span)) continue;
          raw.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 110)}`);
        }
      }
    });
  }
  assert.deepEqual(raw, [],
    'these print a stored rating number straight to the screen:\n  ' + raw.join('\n  '));
});

test('a rating is never formatted without the scale it belongs to', () => {
  // grade(x) with no scale silently falls back to a five-point ladder.
  // That is right for the scales in use today and wrong for any other,
  // and the wrongness is invisible — it shows a plausible letter.
  //
  // The two exceptions are a PUBLISHED rating from an earlier cycle,
  // where the current cycle's scale is the wrong one to read it with
  // and the cycle's own scale is not on the page. They are listed so
  // that a third one has to be argued for.
  const ALLOWED = [
    'pages/HomePage.jsx',        // last published rating, cycle not loaded
    'pages/HistoryPage.jsx',     // rating history, several cycles, several scales
    'pages/MyRatingPage.jsx',    // same
    'pages/ClosureLettersPage.jsx', // a letter for a cycle already closed
    'pages/IncrementSimulationPage.jsx', // published ratings across cycles
  ];
  const bare = [];
  for (const f of files) {
    if (rel(f) === 'grade.jsx' || ALLOWED.includes(rel(f))) continue;
    read(f).forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      // grade(x) — one argument, no scale.
      if (/\bgrade\(\s*[\w.?[\]]+\s*\)/.test(line)) bare.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      // <Grade value={…} /> with no scale prop.
      const g = /<Grade\b[^>]*\/?>/.exec(line);
      if (g && !/\bscale=/.test(g[0])) bare.push(`${rel(f)}:${i + 1}  ${g[0].slice(0, 100)}`);
    });
  }
  assert.deepEqual(bare, [],
    'these format a rating with no scale, so they read the default ladder:\n  ' + bare.join('\n  '));
});

test('no page reads a `scale` that its component was never given', () => {
  // The Mid-Year page had two of these: `grade(s.value, scale)` inside
  // components with no `scale` in scope and none in the module either.
  // Undeclared, so those branches threw a ReferenceError rather than
  // showing a wrong letter — they were the no-KRA fallback pickers,
  // which is why nobody hit them.
  const undeclared = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/\bscale\b/.test(src)) continue;
    // Declared as a prop, a variable, or an import anywhere in the file.
    const declared = /\{[^}]*\bscale\b[^}]*\}\s*\)\s*\{/.test(src)   // destructured prop
      || /\b(const|let|var)\s+scale\b/.test(src)
      || /\bscale\s*[,}]/.test(src.split('\n').filter((l) => /^(export )?function /.test(l)).join('\n'));
    if (declared) continue;
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/[(,]\s*scale\s*[),]/.test(line)) undeclared.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(undeclared, [],
    'these reference a `scale` that does not exist in the file:\n  ' + undeclared.join('\n  '));
});
