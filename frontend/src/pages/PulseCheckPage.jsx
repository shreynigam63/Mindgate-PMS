import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { api } from '../utils/api';

export default function PulseCheckPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/my/pulse-check').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const setScore = async (parameterId, value) => {
    const n = Number(value);
    setData(d => ({ ...d, scores: { ...d.scores, [parameterId]: n } }));
    try {
      await api('/pms/my/pulse-check', { method: 'PUT', body: JSON.stringify({ scores: { [parameterId]: n } }) });
      load();
    } catch (e) { setErr(e.message); }
  };

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active mid-year cycle.</div>;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-bold">7-Parameter Pulse Check</h2>
        <span className="chip bg-cyan-100 text-cyan-700">{data.cycle.name}</span>
      </div>
      <p className="text-xs text-navy-400 bg-navy-50 rounded-lg p-3">
        <Heart size={12} className="inline mr-1 text-rose-400" />
        {data.note}
      </p>
      <div className="space-y-1.5">
        {data.parameters.map(p => (
          <div key={p.id} className="flex items-center justify-between gap-2 bg-white border border-navy-100 rounded-lg px-3 py-2">
            <span className="text-sm">{p.name}</span>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map(v => (
                <button key={v} onClick={() => setScore(p.id, v)}
                  className={`w-8 h-8 rounded-full text-xs font-semibold ${data.scores[p.id] === v ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-500 hover:bg-navy-100'}`}>
                  {v}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {data.self_average != null && (
        <div className="card p-4 text-center">
          <p className="text-2xl font-bold">{data.self_average}</p>
          <p className="text-xs text-navy-400">Your average — for your own reflection only</p>
        </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
