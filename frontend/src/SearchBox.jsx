import { Search, X } from 'lucide-react';

// The one search control, so every list in the product filters the same
// way and looks the same doing it.
//
// Before this, four pages had hand-rolled boxes that each behaved a little
// differently and eleven had none at all. A person who learns that typing
// a department name narrows Team KRA Sheets should not have to discover
// whether the same works on Calibration.
//
// `shown`/`total` are passed when the list is being filtered: a count is
// what stops someone concluding a record is missing when it is only
// filtered out.
export default function SearchBox({ value, onChange, placeholder = 'Search…', shown, total }) {
  const filtering = value.trim().length > 0;
  // Nothing to search: don't offer a box. Without this the control
  // appeared on empty pages in some places and not others, depending on
  // whether the page happened to render its list inside a length check.
  if (total === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1 min-w-0">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400 pointer-events-none" />
        <input
          // The bang matters: .inp sets its own px-3.5 and is declared after
          // Tailwind's utilities in app.css, so a plain pl-9 loses to it and
          // the magnifier sits on top of the first letter.
          className="inp !pl-9 !pr-8"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {filtering && (
          <button type="button" onClick={() => onChange('')} aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-navy-400 hover:text-navy-700">
            <X size={13} />
          </button>
        )}
      </div>
      {filtering && total !== undefined && (
        <span className="text-[11px] text-navy-400 whitespace-nowrap">{shown} of {total}</span>
      )}
    </div>
  );
}

// Does this row match what was typed? Every field is stringified and
// lower-cased, so a search works the same over a name, a code, a
// designation, a department or a status without each caller thinking
// about it. All terms must match, in any field — typing "sales manager"
// finds a Sales Manager and also a Manager in Sales, which is the more
// useful reading of two words.
export function matches(query, ...fields) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = fields.filter(f => f !== null && f !== undefined).join(' ').toLowerCase();
  return q.split(/\s+/).every(term => hay.includes(term));
}
