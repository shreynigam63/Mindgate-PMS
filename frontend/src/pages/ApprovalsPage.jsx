import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { CheckCircle2, Clock } from 'lucide-react';

// Every pending decision in the company, in one queue.
//
// Two kinds of row, and the page is honest about the difference: a KRA
// sheet or a growth plan has been SUBMITTED and is waiting on an
// approve-or-return, so it gets a checkbox and an Approve button. A
// mid-year sign-off or an evaluation is waiting on someone to WRITE their
// assessment — there is nothing to approve yet, so those rows show who
// they are waiting on and nothing else. Offering an Approve button there
// would mean writing an empty evaluation in someone else's name.
const KIND = {
  kra_sheet: { label: 'KRA sheet', chip: 'bg-lagoon-50 text-lagoon-700' },
  growth_plan: { label: 'Growth plan', chip: 'bg-violet-50 text-violet-700' },
  midyear: { label: 'Mid-Year', chip: 'bg-amber2-50 text-amber2-600' },
  evaluation: { label: 'Evaluation', chip: 'bg-brand-50 text-brand-600' },
  hod_evaluation: { label: 'Delivery head', chip: 'bg-navy-50 text-navy-600' },
};

const days = (iso) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
};

export default function ApprovalsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);

  const load = () => api('/pms/approvals').then(d => { setData(d); setPicked({}); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div className="card p-4 text-sm text-rose-700">{err}</div>;
  if (!data) return <div className="card p-8 text-center text-sm text-navy-400">Loading…</div>;
  if (!data.cycle) return (
    <div className="space-y-4">
      <PageHead title="All Approvals" hue="violet" sub="Every pending decision across the whole company, in one place." />
      <div className="card p-8 text-center text-sm text-navy-400">No open cycle, so nothing is pending.</div>
    </div>
  );

  const rows = data.items.filter(i =>
    (filter === 'all' || i.kind === filter) &&
    (!q.trim() || `${i.employee_name} ${i.designation || ''} ${i.department || ''}`.toLowerCase().includes(q.toLowerCase())));
  const decidable = rows.filter(i => i.decidable);
  const chosen = decidable.filter(i => picked[`${i.kind}:${i.id}`]);

  const approveChosen = async () => {
    setBusy(true); setReport(null);
    try {
      const r = await api('/pms/approvals/bulk', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', items: chosen.map(i => ({ kind: i.kind, id: i.id })) }),
      });
      setReport(r);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const TABS = [['all', 'All pending', data.total],
    ...Object.entries(KIND).map(([k, v]) => [k, v.label, data.counts[k] || 0])].filter(t => t[0] === 'all' || t[2]);

  return (
    <div className="space-y-4">
      <PageHead title="All Approvals" hue="violet"
        sub={<>Every pending decision across the whole company, in one place · {data.cycle.name}</>}>
        <button className="btn-pri" disabled={!chosen.length || busy} onClick={approveChosen}>
          {busy ? 'Approving…' : `Approve selected${chosen.length ? ` (${chosen.length})` : ''}`}
        </button>
      </PageHead>

      {report && (
        <div className="card p-3 text-sm">
          <b>{report.approved} approved</b>{report.refused ? `, ${report.refused} refused` : ''}.
          {/* Per-row reasons, never a bare count: a refusal nobody can see
              is the same as a silent failure. */}
          {report.results.filter(r => r.error).map((r, i) => (
            <div key={i} className="text-xs text-rose-700 mt-1">{KIND[r.kind]?.label || r.kind}: {r.error}</div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {TABS.map(([k, label, n]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`chip px-3 py-1.5 ${filter === k ? 'bg-navy-700 text-white' : 'bg-white text-navy-500 border border-navy-100'}`}>
            {label} <b className="ml-1">{n}</b>
          </button>
        ))}
      </div>

      <input className="inp" placeholder="Search across every approval queue…" value={q} onChange={e => setQ(e.target.value)} />

      {!rows.length && <div className="card p-8 text-center text-sm text-navy-400">Nothing pending here.</div>}
      {!!rows.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase tracking-wide text-[10px]">
                <th className="p-3 w-8">
                  <input type="checkbox" className="accent-brand-500"
                    checked={!!decidable.length && chosen.length === decidable.length}
                    onChange={e => setPicked(e.target.checked
                      ? Object.fromEntries(decidable.map(i => [`${i.kind}:${i.id}`, true])) : {})} />
                </th>
                <th className="p-3">Employee</th><th className="p-3">Type</th>
                <th className="p-3">Waiting on</th><th className="p-3">Pending</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(i => {
                const key = `${i.kind}:${i.id}`;
                return (
                  <tr key={key} className="border-t border-navy-50">
                    <td className="p-3">
                      {i.decidable
                        ? <input type="checkbox" className="accent-brand-500" checked={!!picked[key]}
                            onChange={e => setPicked(p => ({ ...p, [key]: e.target.checked }))} />
                        : <Clock size={13} className="text-navy-300" title="Nothing submitted to approve yet — this is waiting on the named person" />}
                    </td>
                    <td className="p-3">
                      <div className="font-bold">{i.employee_name}</div>
                      <div className="text-[11px] text-navy-400">{i.designation || '—'}{i.department ? ` · ${i.department}` : ''}</div>
                    </td>
                    <td className="p-3"><span className={`chip ${KIND[i.kind].chip}`}>{KIND[i.kind].label}</span></td>
                    <td className="p-3">{i.waiting_on || <span className="text-rose-600">no manager set</span>}</td>
                    <td className="p-3">{days(i.since)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-3 text-xs text-navy-500 flex items-start gap-2">
        <CheckCircle2 size={14} className="text-violet-600 shrink-0 mt-0.5" />
        <span>
          As <b>super admin</b> you can approve at any level for any employee — including your own
          records. Every self-approval is stamped in the audit log. Rows with a clock are not
          waiting on an approval: the named person still has to write their assessment.
        </span>
      </div>
    </div>
  );
}
