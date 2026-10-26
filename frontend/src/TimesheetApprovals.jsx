// Timesheet approvals (26 Oct).
//
// "Once uploaded by HR, manager should have approval option for editing
// ratings generated per system and approve timesheet uploaded on system."
// One panel, two places:
//   scope="team"  Team Timesheet — the manager's reportees, and months a
//                 reportee's manager missed that have come up to them;
//   scope="all"   HR → Timesheet — everyone for HR, the remit for an HRBP.
// The server decides who may approve what (timesheet-approval.js); this
// only draws what it is given and offers Review where can_act_as is set.
import { Fragment, useEffect, useState } from 'react';
import { api } from './utils/api';
import { CheckCircle2, Clock, ArrowUpRight, XCircle, Pencil, ChevronDown, ChevronUp, ListChecks } from 'lucide-react';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}` : '');
const dmy = (iso) => (iso ? `${dm(iso)} ${iso.slice(0, 4)}` : '');
const AS = { manager: 'manager', upper_manager: 'upper manager', hrbp: 'HRBP', hr: 'HR' };

export function ApprovalStatus({ a }) {
  if (!a) return null;
  if (a.status === 'approved') {
    return (
      <span className="chip bg-emerald-50 text-emerald-700">
        <CheckCircle2 size={11} className="inline mr-1" />Approved{a.approved_as ? ` by ${AS[a.approved_as]}` : ''}
        {a.approved_at ? ` · ${dmy(String(a.approved_at).slice(0, 10))}` : ''}
      </span>
    );
  }
  if (a.status === 'pending') {
    return <span className="chip bg-amber-50 text-amber-700"><Clock size={11} className="inline mr-1" />With {a.manager_name || (a.manager && a.manager.name) || 'manager'} · due {dmy(a.due_on)}</span>;
  }
  if (a.status === 'escalated') {
    return <span className="chip bg-orange-50 text-orange-700"><ArrowUpRight size={11} className="inline mr-1" />Passed to {a.upper_manager_name || (a.upper_manager && a.upper_manager.name) || 'upper manager'} · due {dmy(a.escalation_due_on)}</span>;
  }
  return <span className="chip bg-rose-50 text-rose-700"><XCircle size={11} className="inline mr-1" />Not approved in time</span>;
}

function Review({ id, onDone }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState({});        // kra_id -> { rating, reason }
  const [month, setMonth] = useState({ rating: '', reason: '' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/pms/timesheet/approvals/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);
  if (err && !d) return <p className="text-xs text-rose-600 p-3">{err}</p>;
  if (!d) return <p className="text-xs text-navy-400 p-3">Loading…</p>;
  const kr = d.kra_ratings || { ratings: [] };
  const labels = (kr.bands || d.bands || []).map((b) => b.label);
  const canAct = !!d.approval.can_act_as && d.approval.status !== 'approved';
  const approve = async () => {
    setErr(null); setBusy(true);
    try {
      const kra_overrides = {};
      for (const [k, v] of Object.entries(edit)) if (v && v.rating) kra_overrides[k] = v;
      await api(`/pms/timesheet/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({
        kra_overrides, month_override: month.rating ? month : null, note }) });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="bg-navy-50/50 border-t border-navy-100 p-3 space-y-2">
      <p className="text-[11px] text-navy-500">
        The system's rating of each KRA for {dm(d.approval.period_start)} – {dm(d.approval.period_end)}: hours logged ÷ expected
        hours ({kr.working_days} working days × {kr.hours_per_day} h = {kr.required_hours} h, shared among the KRAs used).
        {canAct ? ' Change any rating if it does not reflect the month — say why — then approve.' : ''}
      </p>
      <table className="w-full text-xs bg-white rounded-lg overflow-hidden">
        <thead>
          <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
            <th className="px-2 py-1.5">KRA</th>
            <th className="px-2 py-1.5 text-right">Weight</th>
            <th className="px-2 py-1.5 text-right">Hours / expected</th>
            <th className="px-2 py-1.5">System rating</th>
            <th className="px-2 py-1.5">Approved rating</th>
          </tr>
        </thead>
        <tbody>
          {kr.ratings.filter((r) => r.measured || r.approval).map((r) => {
            const e = edit[r.kra_id] || {};
            const changed = e.rating && e.rating !== r.rating;
            return (
              <tr key={r.kra_id} className="border-b border-navy-50 align-top">
                <td className="px-2 py-1.5 font-semibold text-navy-900">{r.title}</td>
                <td className="px-2 py-1.5 text-right text-navy-500">{r.weight}%</td>
                <td className="px-2 py-1.5 text-right">{r.used === false ? <span className="text-navy-300">not used</span> : r.expected_hours ? `${r.hours} / ${r.expected_hours} h` : '—'}</td>
                <td className="px-2 py-1.5">
                  {r.rating ? <><span className="chip bg-navy-700 text-white">{r.rating}</span> <span className="text-navy-500">{r.effort_pct}%</span></>
                    : <span className="text-[10.5px] text-navy-400">{r.reason}</span>}
                </td>
                <td className="px-2 py-1.5">
                  {canAct && r.rating ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select className="inp !py-0.5 !px-1.5 !text-xs !w-auto" value={e.rating || r.rating}
                        onChange={(ev) => setEdit({ ...edit, [r.kra_id]: ev.target.value === r.rating ? null : { rating: ev.target.value, reason: e.reason || '' } })}>
                        {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                      {changed && (
                        <input className="inp !py-0.5 !text-xs flex-1 min-w-[180px]" maxLength={300}
                          placeholder="Why is it changed? (required)" value={e.reason || ''}
                          onChange={(ev) => setEdit({ ...edit, [r.kra_id]: { ...e, reason: ev.target.value } })} />
                      )}
                    </div>
                  ) : <span className="text-navy-300">—</span>}
                </td>
              </tr>
            );
          })}
          {kr.month && kr.month.rating && (
            <tr className="font-semibold text-navy-700">
              <td className="px-2 py-1.5" colSpan={3}>Month average <span className="font-normal text-[10.5px] text-navy-400">(KRAs used this month)</span></td>
              <td className="px-2 py-1.5"><span className="chip bg-navy-900 text-white">{kr.month.rating}</span> <span className="font-normal">{kr.month.effort_pct}%</span></td>
              <td className="px-2 py-1.5">
                {canAct ? (
                  <div className="flex flex-wrap items-center gap-1.5 font-normal">
                    <select className="inp !py-0.5 !px-1.5 !text-xs !w-auto" value={month.rating || kr.month.rating}
                      onChange={(ev) => setMonth(ev.target.value === kr.month.rating ? { rating: '', reason: '' } : { ...month, rating: ev.target.value })}>
                      {labels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    {month.rating && (
                      <input className="inp !py-0.5 !text-xs flex-1 min-w-[180px]" maxLength={300}
                        placeholder="Why is it changed? (required)" value={month.reason}
                        onChange={(ev) => setMonth({ ...month, reason: ev.target.value })} />
                    )}
                  </div>
                ) : <span className="text-navy-300">—</span>}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {canAct && (
        <div className="flex flex-wrap items-center gap-2">
          <input className="inp !py-1 !text-xs flex-1 min-w-[220px]" maxLength={500} placeholder="Note (optional)"
            value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn-pri !text-xs" disabled={busy} onClick={approve}>
            <CheckCircle2 size={12} className="inline mr-1" />Approve timesheet
          </button>
        </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

function AddKra() {
  const [p, setP] = useState(null);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const run = async (commit) => {
    setErr(null);
    try {
      const r = await api(`/pms/timesheet/approvals/kra${commit ? '?commit=1' : ''}`, { method: 'POST', body: '{}' });
      if (commit) { setMsg(`Added to ${r.managers.filter((m) => m.action === 'added').length} managers' sheets.`); setP(null); } else setP(r);
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="text-[11px]">
      {!p && <button className="btn-sec !text-xs" onClick={() => run(false)}><ListChecks size={12} className="inline mr-1" />Timesheet Approval KRA for managers</button>}
      {p && (
        <div className="rounded-lg border border-navy-100 p-2.5 space-y-1.5 mt-2">
          <p className="text-navy-700"><b>{p.to_add}</b> of {p.managers.length} managers get <b>{p.title}</b> at a fixed {p.weight}% on their {p.cycle.name} KRA sheet; their other KRAs are scaled to {100 - p.weight}% so the sheet still totals 100%.</p>
          <ul className="max-h-40 overflow-auto text-navy-600">
            {p.managers.map((m) => <li key={m.employee.id}>{m.employee.name} · {m.reportees} reportee{m.reportees === 1 ? '' : 's'} · {m.action}{m.total_before != null ? ` · sheet ${m.total_before}% → ${m.total_after}%` : ''}</li>)}
          </ul>
          <div className="flex gap-2">
            <button className="btn-pri !text-xs" disabled={!p.to_add} onClick={() => run(true)}>Add to {p.to_add} sheets</button>
            <button className="btn-sec !text-xs" onClick={() => setP(null)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className="text-emerald-700 mt-1">{msg}</p>}
      {err && <p className="text-rose-600 mt-1">{err}</p>}
    </div>
  );
}

export default function TimesheetApprovals({ scope = 'team', onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [status, setStatus] = useState('open');
  const [openId, setOpenId] = useState(null);
  const load = () => api(`/pms/timesheet/approvals?scope=${scope}&status=${status === 'open' ? 'open' : 'all'}`)
    .then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [scope, status]);
  if (err) return null;
  if (!d) return null;
  if (scope === 'team' && !d.approvals.length && !d.counts.approved && !d.counts.pending && !d.counts.escalated && !d.counts.lapsed) return null;
  const c = d.counts;
  return (
    <div className="card p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="lbl mb-0">Timesheet approvals</p>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="chip bg-amber-50 text-amber-700">{c.pending} with manager</span>
          <span className="chip bg-orange-50 text-orange-700">{c.escalated} passed up</span>
          <span className="chip bg-rose-50 text-rose-700">{c.lapsed} not approved</span>
          <span className="chip bg-emerald-50 text-emerald-700">{c.approved} approved</span>
          <select className="inp !py-0.5 !px-1.5 !text-xs !w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Waiting</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>
      <p className="text-[11px] text-navy-500">
        {scope === 'team'
          ? `Each month HR uploads goes to the person's manager to review and approve within ${d.cutoff_days} working days; after that it passes to the manager's manager for ${d.cutoff_days} more. Approving every reportee in time is your Timesheet Approval KRA.`
          : `Approval is the manager's, within ${d.cutoff_days} working days of the upload, then their manager's for ${d.cutoff_days} more. ${d.as === 'hrbp' ? 'You can approve for the people in your remit' : 'HR can approve any of them'} at any time.`}
      </p>
      {scope === 'all' && d.as === 'hr' && <AddKra />}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
              <th className="px-2 py-1.5">Employee</th>
              <th className="px-2 py-1.5">Month</th>
              <th className="px-2 py-1.5 text-right">Hours</th>
              <th className="px-2 py-1.5">Manager</th>
              <th className="px-2 py-1.5">Status</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {d.approvals.map((a) => (
              <Fragment key={a.id}>
                <tr className="border-b border-navy-50">
                  <td className="px-2 py-1.5"><b className="text-navy-900">{a.employee.name}</b><span className="block text-[10px] text-navy-400">{a.employee.designation}</span></td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{dm(a.period_start)} – {dm(a.period_end)}</td>
                  <td className="px-2 py-1.5 text-right">{a.hours ?? '—'}</td>
                  <td className="px-2 py-1.5 text-navy-600">{a.manager ? a.manager.name : '—'}</td>
                  <td className="px-2 py-1.5"><ApprovalStatus a={a} />
                    {!!(Object.keys(a.kra_overrides || {}).length || a.month_override) && <span className="ml-1 text-[10px] text-navy-400"><Pencil size={9} className="inline" /> ratings changed</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button className="text-[11px] font-semibold text-brand-600" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                      {a.can_act_as && a.status !== 'approved' ? 'Review & approve' : 'View'}
                      {openId === a.id ? <ChevronUp size={11} className="inline ml-0.5" /> : <ChevronDown size={11} className="inline ml-0.5" />}
                    </button>
                  </td>
                </tr>
                {openId === a.id && (
                  <tr><td colSpan={6} className="p-0">
                    <Review id={a.id} onDone={() => { setOpenId(null); load(); if (onChanged) onChanged(); }} />
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!d.approvals.length && (
              <tr><td colSpan={6} className="px-2 py-4 text-center text-navy-400">
                {status === 'open' ? 'Nothing waiting for approval.' : 'No uploaded months yet.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
