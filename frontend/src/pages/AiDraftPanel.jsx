import { useEffect, useState } from 'react';
import { Sparkles, RefreshCw, X, Maximize2, ChevronDown, ChevronUp } from 'lucide-react';
import { DraftBadge } from '../utils/api';

// Every AI draft in the app, in a popup instead of down the page.
//
// Requested with a screenshot of My Growth: the development-plan
// suggestions pushed the goal editor — the thing the page is for — well
// below the fold. The panels all have the same shape (a coloured strip
// with a run button, then a dark block of output that grows with the
// answer), and bulleting them made them TALLER, not shorter: a bullet is
// its own line where a paragraph wrapped. So the fix is one component,
// not eleven edits that drift apart.
//
// The strip stays where it was. What changes is that the answer opens over
// the page and leaves a single summary line behind, so the page keeps its
// own shape whether or not anyone has run the AI.
//
// TWO BEHAVIOURS THAT ARE THE POINT, not decoration:
//
// 1. Reopening never re-asks the model. The result is held here, so "View"
//    is instant and free; asking again is a separate, explicit button.
//    Otherwise every peek costs an API call, a wait, and a different
//    answer than the one the person was looking at a moment ago.
// 2. The popup does not close when the caller acts on a suggestion. On My
//    Growth you add four goals in one visit; closing on each would mean
//    reopening and re-scrolling four times. Callers mark their own items
//    as done (see MyGrowthPage's "Added ✓") and close once.
//
// Tailwind classes must be complete literals or the build purges them,
// which is why the accents are a map of full strings rather than
// `from-${accent}-50`.
const ACCENTS = {
  teal: { strip: 'bg-gradient-to-r from-teal-50 to-cyan-50 border-teal-100', title: 'text-teal-800', btn: 'btn-pri !bg-teal-700' },
  sky: { strip: 'bg-gradient-to-r from-teal-50 to-sky-50 border-teal-100', title: 'text-teal-700', btn: 'btn-pri !bg-teal-700' },
  indigo: { strip: 'bg-gradient-to-r from-indigo-50 to-violet-50 border-indigo-100', title: 'text-indigo-700', btn: 'btn-pri !bg-indigo-700' },
  amber: { strip: 'bg-gradient-to-r from-amber-50 to-orange-50 border-amber-100', title: 'text-amber-700', btn: 'btn-pri !bg-amber-600' },
  violet: { strip: 'bg-gradient-to-r from-violet-50 to-fuchsia-50 border-violet-100', title: 'text-violet-700', btn: 'btn-pri !bg-violet-700' },
};

export default function AiDraftPanel({
  title,
  description,
  idleLabel = 'Generate',
  busyLabel = 'Thinking…',
  againLabel = 'Ask again',
  accent = 'teal',
  run,
  summary,
  modalTitle,
  children,
  footer,
  disabled = false,
  disabledHint = null,
  wide = false,
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const a = ACCENTS[accent] || ACCENTS.teal;

  const ask = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await run();
      setResult(r);
      // Straight into the popup — the person just asked for this and
      // would otherwise have to click a second time to read their answer.
      setOpen(true);
    } catch (e) { setErr(e.message); setResult(null); }
    setBusy(false);
  };

  return (
    <div className="space-y-2">
      <div className={`${a.strip} border rounded-xl p-3 flex flex-wrap items-center justify-between gap-3`}>
        <div className="min-w-[16ch] flex-1">
          <p className={`text-xs font-bold ${a.title}`}>{title}</p>
          {description && <p className="text-[11px] text-navy-500">{description}</p>}
        </div>
        <button className={a.btn} disabled={busy || disabled} title={disabled ? disabledHint || '' : ''} onClick={ask}>
          {result ? <RefreshCw size={13} className="inline mr-1" /> : <Sparkles size={13} className="inline mr-1" />}
          {busy ? busyLabel : result ? againLabel : idleLabel}
        </button>
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}

      {/* What is left on the page once the answer exists: one line. It says
          what came back, so the page still reports the result without
          reprinting it. */}
      {result && !busy && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] bg-navy-50 border border-navy-100 rounded-lg px-3 py-2">
          <DraftBadge />
          <span className="text-navy-600">{summary ? summary(result) : 'Draft ready'}</span>
          <button className="ml-auto font-semibold text-navy-700 hover:underline flex items-center gap-1" onClick={() => setOpen(true)}>
            <Maximize2 size={11} />View
          </button>
          <button className="text-navy-400 hover:text-navy-600" onClick={() => { setResult(null); setOpen(false); }}>Dismiss</button>
        </div>
      )}

      {open && result && (
        <AiModal title={modalTitle || title} onClose={() => setOpen(false)} wide={wide}
          footer={footer ? footer(result) : null}>
          {children(result)}
        </AiModal>
      )}
    </div>
  );
}

// The modal shell. Same shape as the two dialogs already in the app
// (CycleAdminPage, CareerTransitionsPage) so this does not introduce a
// second look for the same thing — with the body made independently
// scrollable, since an AI answer has no length limit and these are the
// panels that got too tall in the first place.
export function AiModal({ title, onClose, children, footer, wide = false }) {
  // Escape closes, and the page behind does not scroll while it is open —
  // without the lock, scrolling inside the popup runs on to the page
  // underneath once the body hits its end.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-900/40" onClick={onClose}>
      <div className={`bg-white rounded-2xl shadow-xl w-full ${wide ? 'max-w-4xl' : 'max-w-2xl'} max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-navy-100 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-base font-bold truncate">{title}</p>
            <DraftBadge />
          </div>
          <button className="text-navy-400 hover:text-navy-600 shrink-0" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto grow text-xs space-y-3">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-navy-100 shrink-0 text-xs">{footer}</div>}
      </div>
    </div>
  );
}

// A list of AI suggestions you PICK FROM, rather than a block you read.
//
// Requested after the popup: stacked full cards give every suggestion the
// same weight whether you want it or not, so adding two out of eight means
// scrolling past six. The decision here is a selection, not a reading
// task — so the list is one line per suggestion with the detail one click
// away, and the adding happens once at the end.
//
// Only used where there is something to choose. The read-once drafts (a
// mid-year narrative, a meeting summary, the calibration brief) keep the
// plain popup: a checklist with nothing to select is a list with dead
// checkboxes on it.
//
// `items` are { key, group, title, teaser, meta, detail, added }.
// Selection lives with the caller, because the caller is what acts on it;
// expansion lives here, because nothing outside cares which rows are open.
export function SuggestionList({ items, selected, onToggle, single = false, emptyNote = 'Nothing suggested.' }) {
  const [expanded, setExpanded] = useState({});
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return <p className="text-navy-400">{emptyNote}</p>;

  const allOpen = list.every((i) => expanded[i.key]);
  const toggleAll = () => setExpanded(allOpen ? {} : Object.fromEntries(list.map((i) => [i.key, true])));

  // Group headings are printed when the group CHANGES, in the order the
  // items arrive — the model is told to weight its attention by KRA
  // weight, so that order carries meaning and must not be sorted away.
  let lastGroup = null;

  return (
    <div className="space-y-1">
      <div className="flex justify-end">
        <button className="text-[11px] font-semibold text-navy-500 hover:text-navy-700" onClick={toggleAll}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {list.map((it) => {
        const head = it.group && it.group !== lastGroup ? it.group : null;
        lastGroup = it.group || lastGroup;
        const open = !!expanded[it.key];
        const on = !!(selected || {})[it.key];
        return (
          <div key={it.key}>
            {head && <p className="text-teal-700 font-semibold mt-2 mb-1">{head}</p>}
            <div className="flex items-start gap-2.5 py-1.5 border-b border-navy-50 last:border-0">
              {/* Already-added rows lose the control rather than keeping a
                  tickbox that would add a second copy of the same goal. */}
              {it.added ? (
                <span className="chip bg-emerald-100 text-emerald-700 mt-0.5 shrink-0">Added ✓</span>
              ) : (
                <input type="checkbox" className="mt-1 shrink-0 accent-teal-700 w-3.5 h-3.5"
                  checked={on} onChange={() => onToggle(it.key)} aria-label={it.title} />
              )}
              <button className="flex-1 text-left min-w-0" onClick={() => setExpanded((p) => ({ ...p, [it.key]: !open }))}>
                <p className="font-semibold">{it.title}</p>
                {/* The teaser is the reason to open the row, so it is only
                    shown while the row is closed — repeating it above the
                    detail would just be the same sentence twice. */}
                {!open && it.teaser && <p className="text-navy-400 truncate">{it.teaser}</p>}
              </button>
              {it.meta && <span className="chip bg-navy-50 text-navy-500 shrink-0 whitespace-nowrap">{it.meta}</span>}
              <button className="text-navy-300 shrink-0" onClick={() => setExpanded((p) => ({ ...p, [it.key]: !open }))}
                aria-label={open ? 'Collapse' : 'Expand'}>
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
            {open && <div className="bg-navy-50/70 rounded-lg px-3 py-2 mb-1">{it.detail}</div>}
          </div>
        );
      })}
      {single && <p className="text-[11px] text-navy-400 pt-1">One can be chosen — picking another replaces it.</p>}
    </div>
  );
}
