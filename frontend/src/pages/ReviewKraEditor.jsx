import { useEffect, useState } from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { api } from '../utils/api';

// KRA, KPI and weightage, editable during the reviews.
//
// Asked for on 7 Oct: "KRA, KPIs and weightage should be editable in mid
// year, annual review." Shown on the Mid-Year Review and Annual Review
// screens of both the employee and the manager. The sheet itself stays
// approved; only an existing KRA's title, KPI and weight change — the
// ratings already given are keyed to those KRAs, so none can be added or
// removed here. The server audits every change and tells the other person.
export default function ReviewKraEditor({ employeeId, onSaved, title = 'KRAs, KPIs & weightage' }) {
  const [d, setD] = useState(null);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const load = () => api(`/pms/review/kras/${employeeId}`)
    .then((r) => { setD(r); setRows((r.kras || []).map((k) => ({ ...k, weight: String(Number(k.weight)) }))); })
    .catch((e) => setErr(e.message));
  useEffect(() => { if (employeeId) load(); }, [employeeId]);

  if (!d || !d.cycle || !(d.kras || []).length) return null;
  const total = rows.reduce((s, k) => s + (Number(k.weight) || 0), 0);
  const totalOk = Math.abs(total - 100) < 0.01;
  const set = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await api(`/pms/review/kras/${employeeId}`, {
        method: 'PUT',
        body: JSON.stringify({ kras: rows.map((k) => ({ id: k.id, title: k.title, measures: k.measures, weight: Number(k.weight) })) }),
      });
      setNote(r.changes.length ? `${r.changes.length} ${r.changes.length === 1 ? 'change' : 'changes'} saved.` : 'Nothing changed.');
      setEditing(false);
      await load();
      onSaved?.();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="border border-navy-100 rounded-xl p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase font-bold text-navy-400">{title}</p>
          <p className="text-[11px] text-navy-400">
            {d.editable
              ? 'Editable during the Mid-Year and Annual Review. Changes are recorded and the other person is told.'
              : d.reason}
          </p>
        </div>
        {d.editable && !editing && (
          <button className="btn-sec !py-1" onClick={() => { setEditing(true); setNote(null); }}>
            <Pencil size={12} className="inline mr-1" />Edit
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-navy-400">
              <th className="py-1 pr-2 font-semibold">KRA</th>
              <th className="py-1 pr-2 font-semibold">KPI</th>
              <th className="py-1 font-semibold text-right w-20">Weight %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((k, i) => (
              <tr key={k.id} className="border-t border-navy-50 align-top">
                <td className="py-1.5 pr-2">
                  {editing
                    ? <input className="inp !py-1" value={k.title} onChange={(e) => set(i, { title: e.target.value })} />
                    : <span className="font-semibold text-navy-800">{k.title}</span>}
                </td>
                <td className="py-1.5 pr-2">
                  {editing
                    ? <textarea className="inp !py-1" rows={2} value={k.measures || ''} onChange={(e) => set(i, { measures: e.target.value })} />
                    : <span className="text-navy-600">{k.measures || '—'}</span>}
                </td>
                <td className="py-1.5 text-right">
                  {editing
                    ? <input className="inp !py-1 text-right" type="number" min="1" max="100" step="1"
                        value={k.weight} onChange={(e) => set(i, { weight: e.target.value })} />
                    : <span className="font-mono">{Number(k.weight)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-navy-100">
              <td colSpan={2} className="py-1 text-right text-navy-400">Total</td>
              <td className={`py-1 text-right font-mono font-semibold ${totalOk ? 'text-emerald-700' : 'text-rose-600'}`}>{+total.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {editing && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-pri !py-1" disabled={busy || !totalOk} onClick={save}>
            <Save size={12} className="inline mr-1" />{busy ? 'Saving…' : 'Save KRAs'}
          </button>
          <button className="btn-sec !py-1" disabled={busy}
            onClick={() => { setEditing(false); setErr(null); setRows((d.kras || []).map((k) => ({ ...k, weight: String(Number(k.weight)) }))); }}>
            <X size={12} className="inline mr-1" />Cancel
          </button>
          {!totalOk && <span className="text-[11px] text-rose-600">Weights must total 100.</span>}
        </div>
      )}
      {note && <p className="text-[11px] text-emerald-700">{note}</p>}
      {err && <p className="text-[11px] text-rose-600">{err}</p>}
    </div>
  );
}
