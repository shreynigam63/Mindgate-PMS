// The 1-5 competency control, and the words that go with it.
//
// One component, used by the employee's form, the manager's assessment
// and every read-only display, so a "4" means the same thing and LOOKS
// the same thing everywhere. The labels come from the server
// (pms.competency_scale) rather than being written here — every client
// re-words them, and the house rule is that labels are data.

// Level colours run cool-to-warm with the required level as the
// reference point, so "below what this job needs" reads at a glance
// without anybody parsing a number.
const TONE = {
  1: 'bg-rose-100 text-rose-700 border-rose-200',
  2: 'bg-amber-100 text-amber-700 border-amber-200',
  3: 'bg-sky-100 text-sky-700 border-sky-200',
  4: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  // leaf only has 50/100/500/600 in the config — leaf-700 and
  // leaf-200 do not exist, and a missing Tailwind shade compiles to
  // NOTHING rather than failing, which is the same silent hole that
  // left two page bands with no background on 23 Sep.
  5: 'bg-leaf-100 text-leaf-600 border-leaf-500/30',
};

export const levelLabel = (scale, level) => {
  const row = (scale || []).find((s) => Number(s.level) === Number(level));
  return row ? row.label : (level == null ? '—' : String(level));
};

// The picker. `value` may be null — that is "not rated yet", which is a
// different fact from "rated 1", and the control has to be able to say
// so rather than defaulting to something.
export default function RatingPicker({ scale, value, onChange, disabled, required }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {(scale || []).map((s) => {
        const on = Number(value) === Number(s.level);
        return (
          <button key={s.level} type="button" disabled={disabled}
            title={`${s.level} — ${s.label}${s.description ? `: ${s.description}` : ''}`}
            aria-pressed={on}
            onClick={() => onChange(on ? null : s.level)}
            className={`w-8 h-8 rounded-lg text-xs font-bold border transition-colors
              ${on ? TONE[s.level] : 'bg-white border-navy-100 text-navy-400 hover:border-navy-300'}
              ${disabled ? 'opacity-60 cursor-default' : ''}`}>
            {s.level}
          </button>
        );
      })}
      {required != null && (
        // The bar this person is being measured against, stated next to
        // the control rather than in a legend somewhere else.
        <span className="text-[10px] text-navy-400 ml-1 whitespace-nowrap">needs {required}</span>
      )}
    </span>
  );
}

// A rating as read-only text, with its word. Used wherever a number
// alone would make somebody scroll back to the scale.
export function LevelChip({ scale, level, required }) {
  if (level == null) return <span className="chip bg-navy-50 text-navy-400">not rated</span>;
  const short = required != null && level < required;
  return (
    <span className={`chip border ${TONE[level] || 'bg-navy-50 text-navy-600'}`}>
      {level} · {levelLabel(scale, level)}{short ? ` (needs ${required})` : ''}
    </span>
  );
}

// The legend. Printed once per page, under the first block of ratings.
export function ScaleLegend({ scale }) {
  return (
    <p className="text-[11px] text-navy-400 flex flex-wrap items-center gap-x-3 gap-y-1">
      {(scale || []).map((s) => (
        <span key={s.level} className="whitespace-nowrap">
          <b className="text-navy-600">{s.level}</b> {s.label}
          {s.description ? <span className="text-navy-300"> — {s.description}</span> : null}
        </span>
      ))}
    </p>
  );
}
