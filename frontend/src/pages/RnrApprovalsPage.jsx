import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { CheckCircle2, XCircle, CornerUpLeft, AlertTriangle, Clock } from 'lucide-react';

// The approval queue, for whichever stage the person opening it owns.
//
// One page rather than three, because the three queues differ only in
// which status they read and which permission opens them — and three
// copies of an approval screen is three places a rule has to be changed.
//
// WHAT AN APPROVER NEEDS IN FRONT OF THEM is listed in the brief and is
// all here: date of joining, experience, band, award, the manager's
// justification, and what this person has already been given. The last
// one is what stops the same name winning in three consecutive quarters
// without anybody noticing.

const QUEUES = {
  '/rnr/approvals/delivery-head': { status: 'pending_delivery_head', title: 'Delivery Head approvals',
    sub: 'Nominations your managers have raised, waiting on you.' },
  '/hrbp/rnr-approvals': { status: 'pending_hrbp', title: 'HRBP approvals',
    sub: 'Nominations the Delivery Head has approved. Yours to check against policy.' },
  '/rnr/approvals/hr': { status: 'pending_hr', title: 'Final HR approval',
    sub: 'The last gate. This is where the award quota is applied.' },
};

const fmt = (d) => (d ? String(d).slice(0, 10) : '—');

export default function RnrApprovalsPage() {
  const { pathname } = useLocation();
  const q = QUEUES[pathname] || QUEUES['/rnr/approvals/hr'];
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const [detail, setDetail] = useState(null);
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState('');
  const [quota, setQuota] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => api(`/people/rnr/nominations?status=${q.status}`)
    .then((r) => setRows(r.nominations)).catch((e) => setErr(e.message));
  useEffect(() => { setRows(null); setOpen(null); setMsg(null); load(); }, [q.status]);

  // The final gate shows the quota, because that is the gate it enforces.
  useEffect(() => {
    if (q.status !== 'pending_hr') { setQuota(null); return; }
    api('/people/rnr/cycles').then(async (r) => {
      const c = (r.cycles || []).find((x) => x.status === 'open') || (r.cycles || [])[0];
      if (c) setQuota(await api(`/people/rnr/cycles/${c.id}/quota`));
    }).catch(() => {});
  }, [q.status]);

  const openOne = async (n) => {
    setOpen(n); setDetail(null); setReason(''); setOverride(''); setMsg(null); setErr(null);
    try { setDetail(await api(`/people/rnr/nominations/${n.id}`)); } catch (e) { setErr(e.message); }
  };

  const decide = async (action) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api(`/people/rnr/nominations/${open.id}/decide`, { method: 'POST',
        body: JSON.stringify({ action, reason, override_reason: override || undefined }) });
      setMsg(`${open.employee_name || open.team_name} — now ${r.status_label}.`
        + (r.override ? ` Approved past the quota under an override: ${r.override.reason}` : ''));
      setOpen(null); setOverride(''); load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (err && !rows) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-3 max-w-6xl mx-auto">
      <PageHead title={q.title} hue="amber" sub={q.sub} />

      {quota && (
        <div className={`card p-3 text-xs flex flex-wrap items-center gap-x-4 gap-y-1
          ${quota.quota.exhausted ? 'border-l-4 border-rose-500' : ''}`}>
          <span><b>{quota.quota.active}</b> active employees</span>
          <span>allocation <b>{quota.quota.pct}%</b></span>
          <span>maximum <b>{quota.quota.maximum}</b></span>
          <span>approved <b>{quota.quota.approved}</b></span>
          <span className={quota.quota.balance <= 0 ? 'text-rose-600 font-semibold' : ''}>
            balance <b>{quota.quota.balance}</b>
          </span>
          {quota.quota.outside_quota > 0 && (
            <span className="text-navy-500">+{quota.quota.outside_quota} outside the cap (loyalty)</span>
          )}
          {quota.quota.exhausted && (
            <span className="text-rose-600 flex items-center gap-1">
              <AlertTriangle size={12} />Quota exhausted — further approval needs an HR override.
            </span>
          )}
        </div>
      )}

      {msg && <div className="card p-3 text-xs border-l-4 border-leaf-500">{msg}</div>}

      {!rows.length && (
        <div className="card p-8 text-center text-sm text-navy-400">Nothing is waiting on you.</div>
      )}

      {rows.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr>
                <th className="text-left px-3 py-2">Nominee</th>
                <th className="text-left px-3 py-2">Award</th>
                <th className="text-left px-3 py-2">Band</th>
                <th className="text-left px-3 py-2">Joined</th>
                <th className="text-left px-3 py-2">Experience</th>
                <th className="text-left px-3 py-2">Raised by</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {rows.map((n) => (
                <tr key={n.id}>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-navy-900">{n.employee_name || n.team_name}</span>
                    <span className="block text-[10px] text-navy-400">{n.department || (n.is_team ? 'team award' : '—')}</span>
                  </td>
                  <td className="px-3 py-2">{n.award_name}
                    <span className="block text-[10px] text-navy-400">{n.award_level}</span></td>
                  <td className="px-3 py-2">{n.role_band || '—'}</td>
                  <td className="px-3 py-2">{fmt(n.date_of_joining)}</td>
                  <td className="px-3 py-2">{n.total_experience_years ?? '—'} yrs</td>
                  <td className="px-3 py-2">{n.nominated_by_name}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn-sec !py-1" onClick={() => openOne(n)}>Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="card p-4 space-y-3 border-l-4 border-amber-500">
          <div className="flex items-center justify-between">
            <p className="lbl mb-0">{open.employee_name || open.team_name} · {open.award_name}</p>
            <button className="btn-sec !py-1" onClick={() => setOpen(null)}>Close</button>
          </div>
          {!detail ? <p className="text-xs text-navy-400">Loading…</p> : (
            <>
              <div className="grid sm:grid-cols-4 gap-2 text-[11px]">
                {[['Band', detail.nomination.role_band], ['Joined', fmt(detail.nomination.date_of_joining)],
                  ['Experience', `${detail.nomination.total_experience_years ?? '—'} yrs`],
                  ['Status', detail.nomination.employee_status]].map(([k, v]) => (
                  <div key={k} className="bg-navy-50 rounded-lg px-2 py-1.5">
                    <span className="block text-navy-400">{k}</span><b>{v || '—'}</b>
                  </div>
                ))}
              </div>
              {[['Achievement', detail.nomination.achievement], ['Business impact', detail.nomination.business_impact],
                ['Justification', detail.nomination.justification], ['Comments', detail.nomination.comments]]
                .filter(([, v]) => v).map(([k, v]) => (
                <div key={k}><p className="text-[11px] text-navy-500">{k}</p>
                  <p className="text-xs text-navy-800">{v}</p></div>
              ))}

              {/* What they have had before. The duplicate-award control. */}
              <div>
                <p className="text-[11px] text-navy-500">Previous RnR</p>
                {detail.history.length
                  ? <ul className="text-xs list-disc pl-4">
                      {detail.history.map((h, i) => (
                        <li key={i}>{h.award_name} · {h.cycle_name} · <span className="text-navy-400">{h.status}</span></li>
                      ))}
                    </ul>
                  : <p className="text-xs text-navy-400">None — this is their first nomination.</p>}
              </div>

              {/* The audit trail, visible to the person deciding. */}
              <div>
                <p className="text-[11px] text-navy-500">History</p>
                <ul className="text-[11px] text-navy-500 space-y-0.5">
                  {detail.events.map((e, i) => (
                    <li key={i} className="flex gap-2">
                      <Clock size={10} className="mt-0.5 shrink-0" />
                      <span>{String(e.at).slice(0, 16).replace('T', ' ')} · {e.actor_email} · {e.action}
                        {e.comment ? ` — ${e.comment}` : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <label className="text-[11px] text-navy-500 block mb-1">
                  Reason — required to reject or send back
                </label>
                <textarea className="inp" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>

              {/* Only HR sees this, and only when it is needed. */}
              {q.status === 'pending_hr' && quota && quota.quota.exhausted && (
                <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 space-y-1">
                  <p className="text-[11px] text-rose-700 font-semibold">
                    The quota for this cycle is used up. Approving anyway is an override, and is recorded.
                  </p>
                  <input className="inp !text-xs" placeholder="Reason for the override"
                    value={override} onChange={(e) => setOverride(e.target.value)} />
                </div>
              )}

              {err && <p className="text-xs text-rose-600">{err}</p>}
              <div className="flex flex-wrap gap-2">
                <button className="btn-pri" disabled={busy} onClick={() => decide('approve')}>
                  <CheckCircle2 size={13} className="inline mr-1" />Approve
                </button>
                <button className="btn-sec" disabled={busy} onClick={() => decide('send_back')}>
                  <CornerUpLeft size={13} className="inline mr-1" />Send back
                </button>
                <button className="btn-sec !text-rose-600" disabled={busy} onClick={() => decide('reject')}>
                  <XCircle size={13} className="inline mr-1" />Reject
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
