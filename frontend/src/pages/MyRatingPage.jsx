import { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api, API_BASE } from '../utils/api';

export default function MyRatingPage() {
  const [rows, setRows] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/my/rating').then(r => setRows(r.history)).catch(e => setErr(e.message)); }, []);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;
  const token = localStorage.getItem('apms_token');
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <h2 className="text-lg font-bold">My Rating History</h2>
      {!rows.length ? <div className="card p-8 text-center text-sm text-navy-400">No published ratings yet. Ratings appear here after HR publishes a cycle.</div> : (
        <div className="card divide-y divide-navy-100">
          {rows.map(r => (
            <div key={r.cycle_id} className="p-4 flex items-center justify-between">
              <div><p className="text-sm font-semibold">{r.cycle_name}</p><p className="text-xs text-navy-400">{r.fiscal_year} · published {new Date(r.published_at).toLocaleDateString('en-IN')}</p></div>
              <div className="flex items-center gap-3">
                <div className="text-right"><p className="text-xl font-bold">{r.final_rating}</p><p className="text-xs text-navy-500">{r.rating_label || ''}</p></div>
                <a href={`${API_BASE}/pms/closure-letters/me/${r.cycle_id}/download?token=${token}`} target="_blank" rel="noreferrer" className="btn-sec !p-1.5" title="Download closure letter">
                  <FileText size={14} />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-navy-400">Questions about a rating? Raise an appraisal query in People Hub — it reaches HR with a tracked thread.</p>
      <a href={`${API_BASE}/gdpr/export?token=${token}`} className="btn-sec inline-flex items-center gap-1 !text-xs">
        <Download size={12} />Download all my data (GDPR export)
      </a>
    </div>
  );
}
