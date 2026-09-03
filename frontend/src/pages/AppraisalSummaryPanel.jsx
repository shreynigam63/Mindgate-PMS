import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { api, KraBullets } from '../utils/api';
import AiDraftPanel, { SuggestionList } from './AiDraftPanel';

// The AI Appraisal Summary, at whichever of its two stages the caller is.
//
// Two stages, two audiences, two prompts — see the server for why they are
// not one document with a different header. This component only renders
// whichever came back; it never decides which is appropriate, because the
// server enforces that (the pre-read is not the employee's to pull about
// themselves).
const STAGES = {
  pre_publish: {
    title: 'AI pre-read — before you set the rating',
    blurb: 'Reads the whole year against each KRA: what the evidence shows, where the self and manager readings differ, and where the record is too thin to defend a rating.',
    cta: 'Build the pre-read',
    sections: [['evidence', 'Evidence'], ['divergence', 'Self vs manager'], ['thin_evidence', 'Thin evidence']],
    extras: [['evidence_gaps', 'Missing from the record']],
    // Keepable, and therefore rendered as a tick-list rather than in
    // `extras` — printing it in both places would be the same sentences
    // twice, once to read and once to choose.
    keep: { flat: 'discussion_points', label: 'For the calibration conversation', noun: 'discussion points' },
    accent: 'amber',
  },
  employee: {
    title: 'AI summary of your year',
    blurb: 'What your year contained, KRA by KRA — achievements, what got in the way, and what to build next. Your rating is shown separately; this does not restate it.',
    cta: 'Summarise my year',
    sections: [['achievements', 'Achievements'], ['challenges', 'What got in the way']],
    extras: [['year_in_review', 'Target achievements and Aspiring Career'], ['record_gaps', 'Where your record was thin']],
    keep: { perKra: 'build_next', label: 'What to build next', noun: 'suggestions' },
    accent: 'sky',
  },
};

export default function AppraisalSummaryPanel({ stage, employeeId, onKeep }) {
  const cfg = STAGES[stage];
  const [sel, setSel] = useState({});
  const [kept, setKept] = useState(false);

  // The forward-looking bullets, flattened into one tickable list. Only
  // these are offered: "what you achieved" is a statement about the past
  // and there is nothing to accept or turn down about it.
  const keepItems = (d) => {
    if (!cfg.keep) return [];
    if (cfg.keep.perKra) {
      return (d.by_kra || []).flatMap((g, gi) => (g[cfg.keep.perKra] || []).map((t, i) => ({
        key: `${gi}-${i}`, group: g.kra, title: t, ref: { kra: g.kra },
      })));
    }
    return (d[cfg.keep.flat] || []).map((t, i) => ({ key: `f-${i}`, title: t, ref: {} }));
  };

  return (
    <AiDraftPanel
      accent={cfg.accent}
      title={`✦ ${cfg.title}`}
      description={cfg.blurb}
      idleLabel={cfg.cta}
      busyLabel="Reading the year…"
      againLabel="Refresh"
      modalTitle={cfg.title}
      run={async () => {
        setSel({}); setKept(false);
        return api('/agentic/appraisal-summary', { method: 'POST', body: JSON.stringify({ stage, employee_id: employeeId }) });
      }}
      summary={(out) => {
        const n = ((out.draft || {}).by_kra || []).length;
        return `Read ${n} KRA${n === 1 ? '' : 's'} across the year`;
      }}
      footer={onKeep ? (out) => (
        <KeepBar items={keepItems(out.draft || {}).filter((it) => sel[it.key])}
          total={keepItems(out.draft || {}).length} noun={(cfg.keep || {}).noun || 'suggestions'}
          draftId={out.id} employeeId={employeeId} stage={stage}
          kept={kept} onKept={() => { setKept(true); setSel({}); onKeep(); }} />
      ) : null}
    >
      {(out) => {
        const d = out.draft || {};
        return (
          <div className="space-y-3">
            <KraBullets byKra={d.by_kra} crossCutting={d.cross_cutting} sections={cfg.sections} />
            {cfg.extras.map(([key, label]) => ((d[key] || []).length > 0 && (
              <div key={key}>
                <p className="font-semibold text-navy-500">{label}</p>
                <ul className="list-disc pl-4">{d[key].map((x, i) => <li key={i}>{x}</li>)}</ul>
              </div>
            )))}
            {/* Ticked, not read: these are the ones that can be put on the
                record to accept or turn down later. */}
            {onKeep && cfg.keep && keepItems(d).length > 0 && (
              <div className="pt-1 border-t border-navy-100">
                <p className="font-semibold text-navy-500 mb-1">{cfg.keep.label}</p>
                <SuggestionList items={keepItems(d).map((it) => ({ ...it, added: kept }))}
                  selected={sel} onToggle={(k) => setSel((p) => ({ ...p, [k]: !p[k] }))} />
              </div>
            )}
          </div>
        );
      }}
    </AiDraftPanel>
  );
}

// Keeping a point turns it from panel text into a row someone can act on
// later (see migration 029).
//
// It used to be all-or-nothing: one button that kept every forward-looking
// bullet. Keeping eight when two are worth acting on is how a list of
// recommendations becomes noise nobody reads, so the caller now passes the
// ones that were actually ticked.
function KeepBar({ items, total, noun, draftId, employeeId, stage, kept, onKept }) {
  const [err, setErr] = useState(null);
  if (!total) return null;

  const keep = async () => {
    setErr(null);
    try {
      await api('/agentic/recommendations', {
        method: 'POST',
        body: JSON.stringify({
          about_employee_id: employeeId, kind: `appraisal_${stage}`, draft_id: draftId,
          items: items.map((it) => ({ title: it.title, ref: it.ref })),
        }),
      });
      onKept();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {kept
        ? <p className="text-emerald-700">Kept — they are on the record now, to accept or turn down later.</p>
        : (
          <>
            <button className="btn-pri !text-[11px] !py-1" disabled={!items.length} onClick={keep}>
              {items.length ? `Keep ${items.length} selected` : `Keep selected ${noun}`}
            </button>
            <span className="text-navy-500">Tick the {noun} worth acting on — {total} suggested.</span>
          </>
        )}
      {err && <p className="text-[11px] text-rose-600">{err}</p>}
    </div>
  );
}

// The kept recommendations, with the two decisions that can be made about
// them. A dismissal needs a reason — that is what makes a pattern of poor
// suggestions readable instead of just felt.
export function KeptRecommendations({ employeeId, kind, title = 'Kept AI recommendations' }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [noteFor, setNoteFor] = useState(null);
  const [note, setNote] = useState('');

  const q = new URLSearchParams({ ...(employeeId ? { about_employee_id: employeeId } : {}), ...(kind ? { kind } : {}) });
  const load = () => api(`/agentic/recommendations?${q}`).then(r => setRows(r.recommendations)).catch(e => setErr(e.message));
  // In an effect, not during render: called inline it would fire again on
  // every re-render before the first response landed, which is a burst of
  // identical requests rather than one.
  useEffect(() => { load(); }, [employeeId, kind]);

  const decide = async (id, status, reason) => {
    setErr(null);
    try {
      await api(`/agentic/recommendations/${id}`, { method: 'PUT', body: JSON.stringify({ status, note: reason }) });
      setNoteFor(null); setNote(''); load();
    } catch (e) { setErr(e.message); }
  };

  if (!rows || !rows.length) return null;
  const chip = { suggested: 'bg-navy-100 text-navy-600', accepted: 'bg-emerald-100 text-emerald-700', done: 'bg-teal-100 text-teal-700', dismissed: 'bg-navy-50 text-navy-400' };

  return (
    <div className="card p-3 space-y-2">
      <p className="lbl mb-0">{title}</p>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {rows.map(r => (
        <div key={r.id} className="border-b border-navy-100 last:border-0 pb-2 text-xs space-y-1">
          <div className="flex items-start gap-2">
            <p className={`flex-1 ${r.status === 'dismissed' ? 'line-through text-navy-400' : ''}`}>{r.title}</p>
            <span className={`chip ${chip[r.status]}`}>{r.status}</span>
          </div>
          {r.ref?.kra && <p className="text-[11px] text-navy-400">against {r.ref.kra}</p>}
          {r.decision_note && <p className="text-[11px] text-navy-500 italic">{r.decision_note}</p>}
          {r.status === 'suggested' && (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-sec !py-0.5 !text-[11px]" onClick={() => decide(r.id, 'accepted')}><Check size={11} className="inline mr-1" />Accept</button>
              <button className="btn-sec !py-0.5 !text-[11px]" onClick={() => { setNoteFor(r.id); setNote(''); }}><X size={11} className="inline mr-1" />Dismiss</button>
            </div>
          )}
          {r.status === 'accepted' && (
            <button className="btn-sec !py-0.5 !text-[11px]" onClick={() => decide(r.id, 'done')}>Mark done</button>
          )}
          {noteFor === r.id && (
            <div className="flex flex-wrap gap-2">
              <input className="inp flex-1 !text-[11px]" placeholder="Why are you turning this down?" value={note} onChange={e => setNote(e.target.value)} />
              <button className="btn-pri !py-0.5 !text-[11px]" disabled={!note.trim()} onClick={() => decide(r.id, 'dismissed', note)}>Dismiss</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
