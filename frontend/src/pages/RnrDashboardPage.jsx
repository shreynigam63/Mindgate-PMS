import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { Award, TrendingUp } from 'lucide-react';

// The RnR dashboard, and the cycle tracker the brief asks for.
//
// One page for every role rather than four, because the four differ only
// in which rows they are allowed to see — and the server already decides
// that. An HRBP's numbers arrive narrowed to their remit through the
// gateway, which is why nothing here filters by person.

const STEPS = ['draft', 'pending_delivery_head', 'pending_hrbp', 'pending_hr', 'final_approved', 'awarded'];
const LABEL = { draft: 'Draft', pending_delivery_head: 'HOD', pending_hrbp: 'HRBP',
  pending_hr: 'Final HR', final_approved: 'Approved', awarded: 'Awarded',
  rejected: 'Rejected', sent_back: 'Sent back' };

export default function RnrDashboardPage() {
  const [n, setN] = useState(null);
  const [quota, setQuota] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api('/people/rnr/nominations').then((r) => setN(r.nominations)).catch((e) => setErr(e.message));
    api('/people/rnr/cycles').then(async (r) => {
      const c = (r.cycles || []).find((x) => x.status === 'open') || (r.cycles || [])[0];
      if (c) setQuota(await api(`/people/rnr/cycles/${c.id}/quota`));
    }).catch(() => {});
  }, []);

  if (err) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!n) return <p className="text-sm text-navy-400">Loading…</p>;

  const by = (key) => n.reduce((a, x) => ({ ...a, [x[key] || '—']: (a[x[key] || '—'] || 0) + 1 }), {});
  const byStatus = by('status');
  const count = (s) => byStatus[s] || 0;

  return (
    <div className="space-y-3 max-w-6xl mx-auto">
      <PageHead title="Rewards & Recognition" hue="amber"
        sub={quota ? `${quota.cycle.name} · ${quota.cycle.status}` : 'No cycle open yet.'} />

      {quota && (
        <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {[['Active employees', quota.quota.active], ['Allocation', `${quota.quota.pct}%`],
            ['Maximum awards', quota.quota.maximum], ['Approved', quota.quota.approved],
            ['Balance', quota.quota.balance],
            ['Utilisation', quota.quota.maximum ? `${Math.round((quota.quota.approved / quota.quota.maximum) * 100)}%` : '—'],
          ].map(([k, v]) => (
            <div key={k} className="card p-3">
              <span className="block text-[10.5px] text-navy-400">{k}</span>
              <b className="text-xl">{v}</b>
            </div>
          ))}
        </div>
      )}

      {/* The cycle tracker, as a row of counts rather than a diagram:
          a stage with nothing in it is the useful signal, and a picture
          hides it. */}
      <div className="card p-4">
        <p className="lbl">Where the {n.length} nomination{n.length === 1 ? ' is' : 's are'}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={`chip ${count(s) ? 'bg-amber-100 text-amber-800 font-semibold' : 'bg-navy-50 text-navy-400'}`}>
                {LABEL[s]} · {count(s)}
              </span>
              {i < STEPS.length - 1 && <span className="text-navy-300">→</span>}
            </span>
          ))}
        </div>
        {(count('rejected') > 0 || count('sent_back') > 0) && (
          <p className="text-[11px] text-navy-500 mt-2">
            {count('rejected')} rejected · {count('sent_back')} sent back for changes
          </p>
        )}
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        {[['By award', by('award_name')], ['By department', by('department')], ['By band', by('role_band')]]
          .map(([title, map]) => (
          <div key={title} className="card p-4">
            <p className="lbl">{title}</p>
            {Object.keys(map).length === 0 && <p className="text-xs text-navy-400">Nothing yet.</p>}
            <ul className="text-xs space-y-1">
              {Object.entries(map).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <li key={k} className="flex justify-between"><span className="text-navy-600">{k}</span><b>{v}</b></li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr><th className="text-left px-3 py-2">Nominee</th><th className="text-left px-3 py-2">Award</th>
              <th className="text-left px-3 py-2">Band</th><th className="text-left px-3 py-2">Raised by</th>
              <th className="text-left px-3 py-2">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {n.map((x) => (
              <tr key={x.id}>
                <td className="px-3 py-2 font-semibold">{x.employee_name || x.team_name}</td>
                <td className="px-3 py-2">{x.award_name}</td>
                <td className="px-3 py-2">{x.role_band || '—'}</td>
                <td className="px-3 py-2">{x.nominated_by_name}</td>
                <td className="px-3 py-2"><span className="chip bg-navy-50 text-navy-600">{x.status_label}</span></td>
              </tr>
            ))}
            {!n.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-navy-400">No nominations in this cycle yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
