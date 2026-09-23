// The row of status filters that sits above a work list.
//
// Managers asked to see pending and approved apart rather than mixed in
// one list with a count in the header — which is what Team KRA Sheets
// did, so an approved sheet looked identical to an untouched one until
// you opened it.
//
// The same control is used on the approvals queue, so a filter row means
// the same thing everywhere in the product.
//
// A tab with nothing behind it is not shown: an empty "Returned 0" is a
// question ("did something disappear?") rather than information. `All`
// is always offered, so there is a way back.
export default function StatusTabs({ tabs, value, onChange }) {
  const live = tabs.filter(t => t.key === 'all' || t.count > 0);
  if (live.length <= 1) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {live.map(t => {
        const on = t.key === value;
        return (
          <button key={t.key} type="button" onClick={() => onChange(t.key)}
            className={`chip px-3 py-1.5 transition-colors ${on
              ? (t.tone || 'bg-navy-700 text-white')
              : 'bg-white text-navy-500 border border-navy-100 hover:bg-navy-50'}`}>
            {t.label} <b className="ml-1">{t.count}</b>
          </button>
        );
      })}
    </div>
  );
}

// Build the tab list from rows and a status field. Order is deliberate:
// the work you owe comes first, because that is what the page is for.
export function statusTabs(rows, field, spec) {
  return [
    { key: 'all', label: 'All', count: rows.length },
    ...spec.map(s => ({
      ...s,
      count: rows.filter(r => s.match(r[field])).length,
    })),
  ];
}
