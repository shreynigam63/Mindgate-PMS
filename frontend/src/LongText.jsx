// A box for writing at length (20 Oct, from the client's QA: Def-022,
// Def-023, Def-025 — the text boxes took any amount of text). At most 220
// words and 2,000 characters, the counter under the box shows where you
// are, and typing or pasting past the limit stops at the limit. The server
// holds the same rule (server/core/text-limits.js), so the limit is the
// same whichever way the text arrives.
//
// One-line fields (titles, names) are held to 150 characters with
// maxLength on the input itself.
export const WORD_LIMIT = 220;
export const LONG_CHARS = 2000;
export const SHORT_CHARS = 150;

export const countWords = (s) => (String(s || '').match(/\S+/g) || []).length;

// The text up to the end of its n-th word.
export function clipWords(s, n) {
  const re = /\S+/g;
  let m; let count = 0;
  while ((m = re.exec(s))) {
    count += 1;
    if (count === n) return s.slice(0, m.index + m[0].length);
  }
  return s;
}

export default function LongText({ value, onChange, limit = WORD_LIMIT, className = '', ...rest }) {
  const n = countWords(value);
  // A box that stretched in a row keeps stretching inside its wrapper.
  const wrap = /\bflex-1\b/.test(className) ? 'flex-1 min-w-0' : /\bw-full\b/.test(className) ? 'w-full' : '';
  const tone = n >= limit ? 'text-rose-600' : n >= limit * 0.9 ? 'text-amber-700' : 'text-navy-400';
  return (
    <div className={wrap}>
      <textarea {...rest} className={className} value={value} maxLength={LONG_CHARS}
        onChange={(e) => {
          if (countWords(e.target.value) > limit) e.target.value = clipWords(e.target.value, limit);
          if (onChange) onChange(e);
        }} />
      {!rest.disabled && !rest.readOnly && (
        <p className={`text-[10.5px] text-right mt-0.5 ${tone}`} aria-live="polite">
          {n} / {limit} words{n >= limit ? ' — the limit' : ''}
        </p>
      )}
    </div>
  );
}

// The red asterisk on a field that must be filled (20 Oct, Def-025).
export function Req() {
  return <span className="text-rose-600 font-bold ml-0.5" title="Required" aria-label="required">*</span>;
}
