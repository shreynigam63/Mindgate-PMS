import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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

const CLOSED_PHASES = ['closed', 'cancelled'];

// "PMS Completion Report" — who has and hasn't completed their PMS in a
// given cycle, per a direct request. Read-only over data that already
// exists (KRA/Dev Plan/Self-Appraisal/Manager Evaluation status per
// employee). Any cycle is selectable, closed ones included.
export default function CompletionReportPage() {
  const [data, setData] = useState(null);
  const [cycles, setCycles] = useState(null);
  const [cycleId, setCycleId] = useState('');
  const [err, setErr] = useState(null);
  const [reseeding, setReseeding] = useState(false);
  const [reseedMsg, setReseedMsg] = useState(null);

  // The cycle list is fetched separately from the report itself. That
  // separation is the actual fix: previously the selector could never
  // appear when the report resolved to no cycle, which is what left this
  // page as a dead-end "No active cycle" card. /pms/cycles returns every
  // cycle with no phase filter, so no new endpoint is needed.
  useEffect(() => {
    api('/pms/cycles')
      .then(r => {
        const list = r.cycles || [];
        setCycles(list);
        const active = list.find(c => !CLOSED_PHASES.includes(c.phase));
        // Prefer the active cycle; with none, fall back to the most
        // recent (the endpoint already orders by created_at DESC).
        setCycleId(String((active || list[0])?.id || ''));
      })
      .catch(e => { setCycles([]); setErr(e.message); });
  }, []);

  const load = (id) => {
    setData(null); setErr(null);
    api(`/pms/reports/completion${id ? `?cycle_id=${encodeURIComponent(id)}` : ''}`)
      .then(setData).catch(e => setErr(e.message));
  };
  useEffect(() => { if (cycles) load(cycleId); }, [cycleId, cycles]);

  const reseed = async () => {
    setReseeding(true); setReseedMsg(null); setErr(null);
    try {
      const r = await api('/pms/hod/re-seed', { method: 'POST' });
      setReseedMsg(`Checked ${r.checked} submitted evaluation${r.checked === 1 ? '' : 's'} — created ${r.created} new queue entr${r.created === 1 ? 'y' : 'ies'}${r.skipped_no_head ? `, skipped ${r.skipped_no_head} (no department head assigned yet)` : ''}.`);
    } catch (e) { setErr(e.message); }
    setReseeding(false);
  };

  if (!cycles) return <p className="text-sm text-navy-400">Loading…</p>;

  const rows = data?.rows || [];
  const completeCount = rows.filter(r => r.complete).length;
  const selected = cycles.find(c => String(c.id) === String(cycleId));
  // Re-seeding writes HOD queue entries against the active cycle, so the
  // button is meaningless — and misleading — while viewing a closed one.
  const isActive = selected && !CLOSED_PHASES.includes(selected.phase);

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">PMS Completion Report</h2>
        {cycles.length > 0 && (
          <select className="input py-1 text-xs w-auto" value={cycleId} onChange={e => setCycleId(e.target.value)}>
            {cycles.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}{CLOSED_PHASES.includes(c.phase) ? ` (${c.phase})` : ''}
              </option>
            ))}
          </select>
        )}
        {data?.cycle && <span className="chip bg-emerald-100 text-emerald-700">{completeCount} / {rows.length} complete</span>}
        {isActive && (
          <button className="btn-sec ml-auto" disabled={reseeding} onClick={reseed}>
            <RefreshCw size={13} className="inline mr-1" />{reseeding ? 'Re-seeding…' : 'Re-seed HOD evaluations'}
          </button>
        )}
      </div>
      <p className="text-xs text-navy-400 -mt-2">
        "Complete" means KRA approved, target achievements approved, Self-Appraisal submitted, and Manager Evaluation submitted.
        Delivery Head Review isn't counted here — it isn't the employee's own action to finish.
      </p>
      {reseedMsg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{reseedMsg}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
              <th className="px-3 py-2">Employee</th><th className="px-3 py-2">Dept</th>
              <th className="px-3 py-2">KRA</th><th className="px-3 py-2">Dev Plan</th>
              <th className="px-3 py-2">Self-Appraisal</th><th className="px-3 py-2">Manager Eval</th>
              <th className="px-3 py-2">HOD</th><th className="px-3 py-2">Overall</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.employee_id} className="border-b border-navy-50">
                <td className="px-3 py-2 font-semibold">{r.name}</td>
                <td className="px-3 py-2 text-navy-400">{r.department || '—'}</td>
                <td className="px-3 py-2"><StatusChip value={r.kra_status} /></td>
                <td className="px-3 py-2"><StatusChip value={r.devplan_status} /></td>
                <td className="px-3 py-2"><StatusChip value={r.self_appraisal_status} /></td>
                <td className="px-3 py-2"><StatusChip value={r.manager_eval_status} /></td>
                <td className="px-3 py-2"><StatusChip value={r.hod_status} /></td>
                <td className="px-3 py-2">
                  <span className={`chip ${r.complete ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{r.complete ? 'Complete' : 'Pending'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-6 text-center text-sm text-navy-400">
            {!cycles.length ? 'No cycles found.'
              : !data ? 'Loading…'
              : 'No active employees found.'}
          </p>
        )}
      </div>
    </div>
  );
}
