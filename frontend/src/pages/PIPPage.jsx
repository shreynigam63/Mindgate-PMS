import { useEffect, useState } from 'react';
import { api } from '../utils/api';

const STATUS_LABEL = { open: 'Open', in_progress: 'In Progress', closed_successful: 'Closed — Successful', closed_unsuccessful: 'Closed — Unsuccessful' };
const STATUS_COLOR = {
  open: 'bg-rose-100 text-rose-700',
  in_progress: 'bg-amber-100 text-amber-700',
  closed_successful: 'bg-emerald-100 text-emerald-700',
  closed_unsuccessful: 'bg-slate-200 text-navy-600',
};

export default function PIPPage() {
  const [pips, setPips] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = () => api('/pms/pip').then(r => setPips(r.pips)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!pips) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Performance Improvement Plans</h2>
        <p className="text-xs text-navy-400">Auto-opened when a published rating falls below the cycle's threshold. Weekly notes are added by the manager or HR; the employee has read-only visibility.</p>
      </div>
      {!pips.length && <div className="card p-8 text-center text-sm text-navy-400">No PIPs — either none has been triggered, or you have none to view.</div>}
      <div className="space-y-2">
        {pips.map(p => (
          <div key={p.id} className="card">
            <button className="w-full flex items-center justify-between p-4 text-left" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
              <div>
                <p className="font-semibold text-sm">{p.employee_name} <span className="text-navy-400 font-normal">· {p.cycle_name || '—'}</span></p>
                <p className="text-xs text-navy-400">Opened {new Date(p.opened_at).toLocaleDateString()} · {p.opened_by}</p>
              </div>
              <span className={`chip ${STATUS_COLOR[p.status]}`}>{STATUS_LABEL[p.status] || p.status}</span>
            </button>
            {openId === p.id && <PIPDetail id={p.id} onChange={load} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function PIPDetail({ id, onChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const [weekEnding, setWeekEnding] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const load = () => api(`/pms/pip/${id}`).then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!data) return <p className="px-4 pb-4 text-xs text-navy-400">Loading…</p>;
  const { pip, weekly_entries } = data;
  const closed = pip.status.startsWith('closed');

  const addEntry = async () => {
    setErr(null);
    if (!weekEnding || !note.trim()) { setErr('Week-ending date and notes are required.'); return; }
    try { await api(`/pms/pip/${id}/entries`, { method: 'POST', body: JSON.stringify({ week_ending: weekEnding, notes: note }) }); setNote(''); setWeekEnding(''); load(); onChange?.(); }
    catch (e) { setErr(e.message); }
  };
  const close = async (status) => {
    setErr(null);
    if (!closeReason.trim()) { setErr('A closure reason is required.'); return; }
    try { await api(`/pms/pip/${id}`, { method: 'PUT', body: JSON.stringify({ status, closed_reason: closeReason }) }); load(); onChange?.(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="px-4 pb-4 space-y-3 border-t border-navy-100 pt-3">
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {pip.closed_reason && <p className="text-xs bg-navy-50 rounded-lg p-2"><span className="font-semibold">Closure note:</span> {pip.closed_reason}</p>}

      <div>
        <p className="lbl mb-1">Weekly notes</p>
        {!weekly_entries.length && <p className="text-xs text-navy-400">No weekly notes yet.</p>}
        <div className="space-y-1">
          {weekly_entries.map(w => (
            <div key={w.id} className="text-xs bg-navy-50 rounded-lg p-2">
              <p className="font-semibold">Week ending {new Date(w.week_ending).toLocaleDateString()} <span className="text-navy-400 font-normal">· {w.submitted_by}</span></p>
              <p className="mt-0.5">{w.notes}</p>
            </div>
          ))}
        </div>
      </div>

      {!closed && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <p className="lbl">Week ending</p>
            <input className="inp" type="date" value={weekEnding} onChange={e => setWeekEnding(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <p className="lbl">Notes</p>
            <input className="inp w-full" value={note} onChange={e => setNote(e.target.value)} placeholder="This week's progress / feedback" />
          </div>
          <button className="btn-sec" onClick={addEntry}>Add note</button>
        </div>
      )}

      {!closed && (
        <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-navy-100">
          <div className="flex-1 min-w-[200px]">
            <p className="lbl">Closure reason (required to close)</p>
            <input className="inp w-full" value={closeReason} onChange={e => setCloseReason(e.target.value)} placeholder="Why is this PIP being closed?" />
          </div>
          <button className="btn-pri" onClick={() => close('closed_successful')}>Close — Successful</button>
          <button className="btn-sec" onClick={() => close('closed_unsuccessful')}>Close — Unsuccessful</button>
        </div>
      )}
    </div>
  );
}
