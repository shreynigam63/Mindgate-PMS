import { useState } from 'react';
import { Sparkles, Info } from 'lucide-react';
import { api } from '../utils/api';
import { AiModal } from './AiDraftPanel';

// "Suggest KRAs for me" — the agentic counterpart to the library picker.
//
// Asked for on 23 Sep: AI-suggested KRAs on My KRAs, by the employee's
// department and designation.
//
// IT IS A PICKER, NOT A FILLER, for the same reason the library one is:
// which hundred points apply is the employee's call with their manager,
// and auto-filling would turn a starting point into an instruction. The
// tick-then-Add shape is deliberately identical to the library picker
// sitting next to it — one interaction, learnt once.
//
// WHAT IT IS ALLOWED TO SAY. Every suggestion is a KRA HR has already
// published, chosen from a closed list server-side; the model selects and
// may sharpen wording, and the row shows WHICH shelf it came from. The
// weight is the library's own figure, never the model's. So a row here is
// traceable to something a human approved — which is the only version of
// this feature worth having in a system that decides people's ratings.

const RING = {
  own_shelf: { label: 'your role', chip: 'bg-lagoon-50 text-lagoon-700' },
  department: { label: 'your department', chip: 'bg-violet-50 text-violet-700' },
  company: { label: 'company-wide', chip: 'bg-navy-50 text-navy-500' },
};

export default function KraSuggestPanel({ onAdd, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [picked, setPicked] = useState({});

  const ask = async () => {
    setBusy(true); setErr(null); setPicked({});
    try {
      const r = await api('/agentic/kra-suggest', { method: 'POST' });
      setData(r);
      setOpen(true);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Two lists, kept apart on purpose: what HR published, and what the
  // agent drafted for this role because the library did not reach. They
  // are indexed into one picked map with a prefix so a tick can never
  // land on the wrong row.
  const suggestions = (data && data.suggestions) || [];
  const drafted = (data && data.drafted) || [];
  const chosen = [
    ...suggestions.filter((_, i) => picked['l' + i]),
    ...drafted.filter((_, i) => picked['d' + i]),
  ];

  const add = () => {
    onAdd(chosen.map((s) => ({
      title: s.title,
      measures: s.kpi || '',
      description: '',
      category: s.parameter || '',
      // The library's suggested weight, carried through. Blank stays
      // blank — a shelf entry with no suggested weight must not arrive
      // as a zero the employee then has to notice and fix.
      weight: s.suggested_weight == null ? '' : Number(s.suggested_weight),
    })));
    setPicked({});
    setOpen(false);
  };

  // Grouped by parameter, like everything else that lists KRAs.
  const groupOf = (list, prefix) => {
    const out = [];
    for (const [i, s] of list.entries()) {
      const cat = (s.parameter || '').trim() || 'No parameter set';
      let g = out.find((x) => x.cat === cat);
      if (!g) { g = { cat, rows: [] }; out.push(g); }
      g.rows.push({ s, key: prefix + i });
    }
    return out;
  };
  const groups = groupOf(suggestions, 'l');
  const draftGroups = groupOf(drafted, 'd');

  const Row = ({ s, k }) => (
    <label className="flex gap-2.5 items-start bg-white border border-navy-100 rounded-lg p-2.5 cursor-pointer">
      <input type="checkbox" className="accent-brand-500 mt-1" checked={!!picked[k]}
        onChange={(e) => setPicked((p) => ({ ...p, [k]: e.target.checked }))} />
      <span className="min-w-0 flex-1 text-xs space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <b className="text-sm text-navy-900">{s.title}</b>
          {s.source === 'ai' ? (
            <span className="chip bg-amber2-50 text-amber2-600">drafted for your role</span>
          ) : (
            <>
              <span className={`chip ${RING[s.ring].chip}`}>{RING[s.ring].label}</span>
              {s.ring !== 'own_shelf' && (
                <span className="text-[10.5px] text-navy-400">from {s.from_designation}</span>
              )}
              {s.adapted && (
                <span className="chip bg-navy-50 text-navy-500" title="Wording adapted for your role; the original is in the library">
                  reworded
                </span>
              )}
            </>
          )}
        </span>
        {s.kpi && <span className="block text-navy-500"><b>KPI:</b> {s.kpi}</span>}
        {s.why && <span className="block text-navy-400 italic">{s.why}</span>}
      </span>
      <span className="text-xs font-bold text-navy-600 shrink-0">
        {s.suggested_weight == null ? '—' : `${s.suggested_weight}%`}
      </span>
    </label>
  );

  return (
    <>
      <button type="button" className="btn-sec" disabled={disabled || busy} onClick={ask}>
        <Sparkles size={13} className="inline mr-1 text-amber-500" />
        {busy ? 'Reading your role library…' : 'Suggest KRAs for my role'}
      </button>
      {err && <p className="text-[11px] text-rose-600 mt-1">{err}</p>}

      {open && data && (
        <AiModal wide title={`Suggested KRAs — ${data.designation}${data.department ? ` · ${data.department}` : ''}`}
          onClose={() => setOpen(false)}
          footer={
            <div className="flex items-center gap-3">
              <span className="text-xs text-navy-500">{chosen.length} selected</span>
              <button className="btn-sec !py-1.5" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn-pri !py-1.5" disabled={!chosen.length} onClick={add}>
                Add {chosen.length || ''} to my sheet
              </button>
            </div>
          }>
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-[11.5px] text-navy-500 bg-navy-50 rounded-lg p-2.5">
              <Info size={13} className="shrink-0 mt-0.5 text-navy-400" />
              <span>
                Two lists below. <b>Library</b> entries were published by HR and carry HR's
                suggested weight. <b>Drafted</b> entries were written for your role because the
                library does not cover them — they carry no weight until you set one. Everything
                you add stays fully editable.
              </span>
            </div>

            {data.balance && <p className="text-xs text-navy-600"><b>Balance:</b> {data.balance}</p>}

            {!suggestions.length && !drafted.length && (
              <p className="text-sm text-navy-400">
                Nothing to suggest — your sheet already covers this role.
              </p>
            )}

            {groups.length > 0 && (
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-wide text-lagoon-700">
                  From your KRA Library · approved by HR
                </p>
                {groups.map((g) => (
                  <div key={g.cat} className="space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-navy-500">{g.cat}</p>
                    {g.rows.map(({ s, key }) => <Row key={key} s={s} k={key} />)}
                  </div>
                ))}
              </div>
            )}

            {/* PART TWO, and the separation is the point. These were
                written by the agent for this designation and department
                because the library did not cover them. They are drafts
                for a human to approve, they carry NO weight, and the
                heading says all of that before anybody ticks one. */}
            {draftGroups.length > 0 && (
              <div className="space-y-2 border-t border-navy-100 pt-3">
                <p className="text-[11px] font-bold uppercase tracking-wide text-amber2-600">
                  Drafted for {data.designation}{data.department ? ` · ${data.department}` : ''} — not in your library
                </p>
                <p className="text-[11.5px] text-navy-500 bg-amber2-50 rounded-lg p-2.5">
                  {data.library_empty
                    ? <>Nothing has been published for your role yet, so these were written from your
                       designation and department.</>
                    : <>Your library does not cover these, so they were written from your designation
                       and department.</>}
                  {' '}They carry <b>no weight</b> until you set one, and your manager approves them
                  with the rest of your sheet.
                </p>
                {draftGroups.map((g) => (
                  <div key={g.cat} className="space-y-1.5">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-navy-500">{g.cat}</p>
                    {g.rows.map(({ s, key }) => <Row key={key} s={s} k={key} />)}
                  </div>
                ))}
              </div>
            )}

            {/* What the library could NOT cover. Said out loud rather than
                filled in with something invented — that is the whole rule
                this feature runs on. */}
            {(data.gaps || []).length > 0 && (
              <div className="text-[11.5px] text-amber2-700 bg-amber2-50 rounded-lg p-2.5">
                <b>Not covered by your library</b> — write these yourself, or ask HR to publish them:
                <ul className="list-disc pl-4 mt-1">{data.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
              </div>
            )}
          </div>
        </AiModal>
      )}
    </>
  );
}
