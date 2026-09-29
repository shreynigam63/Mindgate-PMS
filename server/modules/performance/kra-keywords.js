// Keywords on a KRA — parsing, normalising and validating them.
//
// Phase 1 of the Zoho timesheet rating engine specced on 29 Sep.
// Pure: no db, no express, so every rule here is tested against a
// literal. Same split as timesheet-rules.js, which this will sit
// beside when the matching lands in phase 2.
//
// NOTHING HERE SCORES ANYTHING. The matching function is deliberately
// absent: the keywords have to be populated and argued over by HR
// before a rating hangs off them.
//
// WHY NORMALISE AT ALL. These arrive three ways — typed into a form,
// pasted as "Development, Bug Fixing, Code Review" into one
// spreadsheet cell, and inherited from a library row. If "Bug Fixing",
// "bug fixing" and " Bug  Fixing " are stored as three keywords, the
// coverage percentage they later feed counts one idea three times, and
// HR sees a list that looks like a mistake. So one shape, decided here
// and applied on every path in.

// Stored lowercase. Matching in phase 2 is case-insensitive over free
// text a developer typed into Zoho at 6pm, so preserving the case HR
// typed would be a display nicety that invites a case-sensitive bug
// later. The UI title-cases for display instead.
const MAX_KEYWORDS = 40;      // a KRA with 40 keywords matches everything
const MAX_LENGTH = 60;        // a sentence is not a keyword

// Splits on commas, semicolons, pipes and newlines — every separator a
// spreadsheet cell or a textarea actually arrives with. NOT on spaces:
// "bug fixing" and "code review" are two-word keywords, and splitting
// them would match any task mentioning "code" at all.
const SPLIT = /[,;|\n\r]+/;

function parseKeywords(raw) {
  if (raw == null) return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(SPLIT);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const k = String(p == null ? '' : p)
      .replace(/\s+/g, ' ')     // collapse runs of whitespace, including tabs from a paste
      .trim()
      .toLowerCase();
    if (!k) continue;
    if (k.length > MAX_LENGTH) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

// What was dropped and why, so a bulk upload can report per row rather
// than silently storing less than the file said. Same discipline as the
// employee importer: no silent failure, per-row reasons.
function parseWithReasons(raw) {
  const parts = raw == null ? [] : (Array.isArray(raw) ? raw : String(raw).split(SPLIT));
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const p of parts) {
    const original = String(p == null ? '' : p).trim();
    const k = original.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!k) continue;
    if (k.length > MAX_LENGTH) { dropped.push({ keyword: original, reason: `longer than ${MAX_LENGTH} characters — that is a sentence, not a keyword` }); continue; }
    if (seen.has(k)) { dropped.push({ keyword: original, reason: 'duplicate' }); continue; }
    if (kept.length >= MAX_KEYWORDS) { dropped.push({ keyword: original, reason: `over the limit of ${MAX_KEYWORDS} keywords on one KRA` }); continue; }
    seen.add(k);
    kept.push(k);
  }
  return { keywords: kept, dropped };
}

// Title Case for display. Stored lowercase, shown the way HR wrote it
// on a form — "Bug Fixing", not "bug fixing".
const displayKeyword = (k) => String(k || '')
  .split(' ')
  .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
  .join(' ');

// ---- the bulk editor's three modes -------------------------------------
//
// ADD is the default and the safe one: HR selects forty Development
// KRAs and adds "code review" to all of them without touching what is
// already there. REPLACE and REMOVE exist because the first bulk pass
// over 2,360 rows will contain mistakes that need undoing in bulk too.
const MODES = ['add', 'replace', 'remove'];

function applyMode(current, incoming, mode) {
  const cur = parseKeywords(current);
  const inc = parseKeywords(incoming);
  if (mode === 'replace') return inc;
  if (mode === 'remove') {
    const drop = new Set(inc);
    return cur.filter((k) => !drop.has(k));
  }
  // add — de-duplicated against what is already there, order preserved
  // so HR's existing list does not reshuffle under them.
  const have = new Set(cur);
  return [...cur, ...inc.filter((k) => !have.has(k))].slice(0, MAX_KEYWORDS);
}

// A sentence, or null. Goes straight to the screen mid-edit, so "invalid
// input" would be useless.
function validateBulk(b) {
  if (!MODES.includes(b.mode)) return `Unknown mode "${b.mode}" — use add, replace or remove.`;
  const kws = parseKeywords(b.keywords);
  // Replace with nothing IS a legitimate instruction — "clear these" —
  // but it is destructive over a filter that might match 800 rows, so
  // the route makes the caller say so explicitly rather than inferring
  // it from an empty box somebody tabbed past.
  if (!kws.length && b.mode !== 'replace') return 'Give at least one keyword.';
  if (!kws.length && b.mode === 'replace' && !b.confirm_clear) {
    return 'That would clear the keywords on every matching KRA. Tick the confirmation to do it.';
  }
  return null;
}

module.exports = { parseKeywords, parseWithReasons, displayKeyword, applyMode,
                   validateBulk, MODES, MAX_KEYWORDS, MAX_LENGTH };
