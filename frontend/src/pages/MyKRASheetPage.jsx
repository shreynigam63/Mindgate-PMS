import { useEffect, useState } from 'react';
import { Plus, Trash2, Check, Send } from 'lucide-react';
import { api, phaseLabel, phaseColor } from '../utils/api';

export default function MyKRASheetPage() {
  const [data, setData] = useState(null);
  const [kras, setKras] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/pms/my/kra-sheet').then(r => { setData(r); setKras(r.kras || []); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active appraisal cycle. HR opens the cycle; your KRA sheet appears here.</div>;

  const total = kras.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  const locked = data.sheet.status === 'approved' || data.sheet.status === 'submitted';
  const editable = data.cycle.phase === 'kra_open' && !locked;
  const set = (i, k) => (e) => setKras(ks => ks.map((r, j) => j === i ? { ...r, [k]: e.target.value } : r));

  const save = async (thenSubmit) => {
    setBusy(true); setErr(null);
    try {
      await api('/pms/my/kra-sheet/kras', { method: 'PUT', body: JSON.stringify({ kras }) });
      if (thenSubmit) await api('/pms/my/kra-sheet/submit', { method: 'POST' });
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">My KRAs</h2>
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
        <span className={`chip ${data.sheet.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : data.sheet.status === 'returned' ? 'bg-rose-100 text-rose-700' : 'bg-navy-50 text-navy-600'}`}>sheet: {data.sheet.status}</span>
        <span className={`chip ${Math.abs(total - 100) < 0.01 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>weights: {total}/100</span>
      </div>
      {data.sheet.status === 'returned' && data.sheet.manager_comment && (
        <div className="card p-3 border-rose-200 bg-rose-50 text-sm text-rose-700"><b>Returned by your manager:</b> {data.sheet.manager_comment}</div>
      )}
      {kras.map((k, i) => (
        <div key={i} className="card p-3 space-y-2">
          <div className="flex gap-2">
            <input className="inp font-semibold" placeholder="KRA title *" value={k.title || ''} onChange={set(i, 'title')} disabled={!editable} />
            <input className="inp w-24 text-right" type="number" placeholder="wt %" value={k.weight ?? ''} onChange={set(i, 'weight')} disabled={!editable} />
            {editable && <button className="text-rose-500" onClick={() => setKras(ks => ks.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
          </div>
          <textarea className="inp" rows={2} placeholder="Description" value={k.description || ''} onChange={set(i, 'description')} disabled={!editable} />
          <input className="inp" placeholder="How it will be measured" value={k.measures || ''} onChange={set(i, 'measures')} disabled={!editable} />
        </div>
      ))}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <button className="btn-sec" onClick={() => setKras(ks => [...ks, { title: '', weight: '' }])}><Plus size={13} className="inline mr-1" />Add KRA</button>
          <button className="btn-sec" disabled={busy} onClick={() => save(false)}><Check size={13} className="inline mr-1" />Save draft</button>
          <button className="btn-pri" disabled={busy || Math.abs(total - 100) >= 0.01 || !kras.length} onClick={() => save(true)}
            title={Math.abs(total - 100) >= 0.01 ? 'Weights must total exactly 100' : ''}>
            <Send size={13} className="inline mr-1" />Save & submit to manager</button>
        </div>
      )}
      {!editable && !locked && <p className="text-xs text-navy-400">KRA editing opens in the {phaseLabel('kra_open')} phase.</p>}
    </div>
  );
}
