import { useEffect, useState } from 'react';
import { Sparkles, FileDown, CheckCircle2 } from 'lucide-react';
import { api, DraftBadge, API_BASE } from '../utils/api';

export default function ClosureLettersPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/closure-letters').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Closure Letters</h2>
        <p className="text-xs text-navy-400">{data.cycle.name} — draft with AI, review, then generate the branded PDF. Nothing is ever sent without your review.</p>
      </div>
      {!data.letters.length && <div className="card p-8 text-center text-sm text-navy-400">No published ratings yet for this cycle — publish first.</div>}
      <div className="space-y-2">
        {data.letters.map(l => <LetterRow key={l.employee_id} l={l} reload={load} />)}
      </div>
    </div>
  );
}

function LetterRow({ l, reload }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const token = localStorage.getItem('apms_token');

  const askDraft = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/agentic/letter-draft', { method: 'POST', body: JSON.stringify({ employee_id: l.employee_id, cycle_id: l.cycle_id }) }); setDraft(r); setOpen(true); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/pms/closure-letters/${l.employee_id}/${l.cycle_id}/generate`, {
        method: 'POST', body: JSON.stringify({ salutation: draft.salutation, body_paragraphs: draft.body_paragraphs, closing_line: draft.closing_line }),
      });
      setOpen(false); setDraft(null); reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{l.employee_name}</p>
          <p className="text-xs text-navy-400">{l.final_rating} · {l.rating_label}</p>
        </div>
        {l.generated ? (
          <div className="flex items-center gap-2">
            <span className="chip bg-emerald-100 text-emerald-700 flex items-center gap-1"><CheckCircle2 size={12} />Generated</span>
            <a href={`${API_BASE}/pms/closure-letters/${l.employee_id}/${l.cycle_id}/download?token=${token}`} target="_blank" rel="noreferrer" className="btn-sec !p-1.5"><FileDown size={14} /></a>
          </div>
        ) : (
          <button className="btn-sec" disabled={busy} onClick={askDraft}><Sparkles size={13} className="inline mr-1 text-amber-500" />{busy ? 'Drafting…' : 'Draft with AI'}</button>
        )}
      </div>
      {open && draft && (
        <div className="bg-navy-800 text-slate-100 rounded-lg p-3 text-xs space-y-2">
          <DraftBadge />
          <textarea className="inp !bg-navy-700 !text-white !border-navy-600 w-full" rows={2} value={draft.salutation}
            onChange={e => setDraft(d => ({ ...d, salutation: e.target.value }))} />
          {draft.body_paragraphs.map((p, i) => (
            <textarea key={i} className="inp !bg-navy-700 !text-white !border-navy-600 w-full" rows={3} value={p}
              onChange={e => setDraft(d => ({ ...d, body_paragraphs: d.body_paragraphs.map((x, j) => j === i ? e.target.value : x) }))} />
          ))}
          <textarea className="inp !bg-navy-700 !text-white !border-navy-600 w-full" rows={2} value={draft.closing_line}
            onChange={e => setDraft(d => ({ ...d, closing_line: e.target.value }))} />
          <button className="btn-pri" disabled={busy} onClick={generate}>{busy ? 'Generating…' : 'Generate PDF'}</button>
        </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
