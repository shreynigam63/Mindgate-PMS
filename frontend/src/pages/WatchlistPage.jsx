import { useEffect, useState } from 'react';
import { api } from '../utils/api';

export default function WatchlistPage() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/watchlist').then(r => setRows(r.watchlist)).catch(e => setErr(e.message)); }, []);

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Super 50 — High-Performer Watchlist</h2>
        <p className="text-xs text-navy-400">Employees with 3 consecutive top-tier ratings, most recently rated the highest grade. Recomputed automatically each time a cycle publishes; a lapsed streak removes someone from this list.</p>
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!err && !rows && <p className="text-sm text-navy-400">Loading…</p>}
      {rows && !rows.length && <div className="card p-8 text-center text-sm text-navy-400">No one currently qualifies — this list updates as cycles publish.</div>}
      {rows && rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr>
                <th className="text-left px-3 py-2">Name</th>
                <th className="text-left px-3 py-2">Department</th>
                <th className="text-left px-3 py-2">Designation</th>
                <th className="text-right px-3 py-2">Latest rating</th>
                <th className="text-right px-3 py-2">On watchlist since</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {rows.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-semibold">{r.name}</td>
                  <td className="px-3 py-2">{r.department || '—'}</td>
                  <td className="px-3 py-2">{r.designation || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.last_appraisal_rating}</td>
                  <td className="px-3 py-2 text-right">{new Date(r.super50_since).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
