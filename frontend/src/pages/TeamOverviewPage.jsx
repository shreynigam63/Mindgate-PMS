import { useEffect, useState } from 'react';
import { api } from '../utils/api';

const STATUS_COLOR = {
  approved: 'bg-emerald-100 text-emerald-700', submitted: 'bg-emerald-100 text-emerald-700',
  returned: 'bg-rose-100 text-rose-700',
  in_progress: 'bg-amber-100 text-amber-700', draft: 'bg-amber-100 text-amber-700', pending: 'bg-amber-100 text-amber-700',
  not_started: 'bg-navy-50 text-navy-400',
};
function StatusChip({ value }) {
  return <span className={`chip ${STATUS_COLOR[value] || 'bg-navy-50 text-navy-600'}`}>{value.replace('_', ' ')}</span>;
}

// "Team overview" — all reportees' progress in one view, per a direct
// request. This data already exists split across separate screens (Team
// KRA Sheets, My Growth's team section, Team Evaluation, Connects); this
// consolidates it read-only, without duplicating any of those screens'
// own editing capability.
export default function TeamOverviewPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => { api('/pms/team/overview').then(setData).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Team Overview</h2>
        <span className="chip bg-navy-50 text-navy-600">{data.cycle.name}</span>
      </div>
      {!data.rows.length && <div className="card p-8 text-center text-sm text-navy-400">No direct reports found.</div>}
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
              <th className="px-3 py-2">Employee</th><th className="px-3 py-2">Dept</th>
              <th className="px-3 py-2">KRA</th><th className="px-3 py-2">Dev Plan</th>
              <th className="px-3 py-2">Career Path</th>
              <th className="px-3 py-2">Self-Appraisal</th><th className="px-3 py-2">Manager Eval</th>
              <th className="px-3 py-2">Connects (this cycle)</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(r => (
              <tr key={r.employee_id} className="border-b border-navy-50">
                <td className="px-3 py-2 font-semibold">{r.name}</td>
                <td className="px-3 py-2 text-navy-400">{r.department || '—'}</td>
                <td className="px-3 py-2"><StatusChip value={r.kra_status} /></td>
                <td className="px-3 py-2"><StatusChip value={r.devplan_status} /></td>
                <td className="px-3 py-2">{r.has_career_path ? <span className="chip bg-emerald-100 text-emerald-700">Set</span> : <span className="chip bg-navy-50 text-navy-400">Not set</span>}</td>
                <td className="px-3 py-2"><StatusChip value={r.self_appraisal_status} /></td>
                <td className="px-3 py-2"><StatusChip value={r.manager_eval_status} /></td>
                <td className="px-3 py-2 text-navy-600">{r.connects_this_cycle}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
