import { useEffect, useState } from 'react';
import { api } from '../utils/api';

// "See past years" — an employee's own performance history across
// published annual cycles, per a direct request. Reads the same table
// Super 50 already uses, just exposed as a personal history view.
export default function HistoryPage() {
  const [history, setHistory] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { api('/pms/my/history').then(r => setHistory(r.history)).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!history) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Past Cycles</h2>
        <p className="text-xs text-navy-400">Your rating history across published annual review cycles.</p>
      </div>
      {!history.length && <div className="card p-8 text-center text-sm text-navy-400">No published cycles yet — your history will appear here once an annual cycle you're part of is published.</div>}
      <div className="space-y-2">
        {history.map(h => (
          <div key={h.cycle_id} className="card p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">{h.cycle_name}</p>
              <p className="text-xs text-navy-400">{h.fiscal_year} · Published {new Date(h.published_at).toLocaleDateString()}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold text-navy-700">{h.rating_label || h.final_rating}</p>
              <p className="text-xs text-navy-400">({Number(h.final_rating).toFixed(1)})</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
