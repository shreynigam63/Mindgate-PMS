import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus, Trash2, CheckCircle2, XCircle, Clock, Pencil } from 'lucide-react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';

const STATUS_LABEL = { open: 'Open', in_progress: 'In Progress', closed_successful: 'Closed — Successful', closed_unsuccessful: 'Closed — Unsuccessful' };
const STATUS_COLOR = {
  open: 'bg-rose-100 text-rose-700',
  in_progress: 'bg-amber-100 text-amber-700',
  closed_successful: 'bg-emerald-100 text-emerald-700',
  closed_unsuccessful: 'bg-slate-200 text-navy-600',
};
const GATE_LABEL = { pending: 'Pending', met: 'Met', not_met: 'Not met' };
const GATE_COLOR = { pending: 'bg-navy-50 text-navy-600', met: 'bg-emerald-100 text-emerald-700', not_met: 'bg-rose-100 text-rose-700' };
const day = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

// Performance Improvement Plans.
//
// Asked for on 7 Oct, from the Team Evaluation screen: the MANAGER writes
// the plan — "description as per low performance of employee", the
// "targeted areas", and the "gates where the improvement will be shown".
// /pip is everyone's (an employee reads their own plan); /team/pip is the
// manager's entry, where a plan is opened. Team Evaluation links here with
// ?employee= so the form opens for that person.
export default function PIPPage({ manager = false }) {
  const location = useLocation();
  const preset = new URLSearchParams(location.search).get('employee') || '';
  const [q, setQ] = useState('');
  const [pips, setPips] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(manager && !!preset);
  const [team, setTeam] = useState([]);
  const load = () => api('/pms/pip').then(r => setPips(r.pips)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (manager) api('/pms/team/evaluations').then((r) => setTeam(r.team || [])).catch(() => setTeam([]));
  }, [manager]);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!pips) return <p className="text-sm text-navy-400">Loading…</p>;

  const pipsShown = (pips || []).filter(p => matches(q, p.employee_name, p.cycle_name, p.status, p.department));

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Performance Improvement Plans" hue="amber"
        sub={manager
          ? 'Open a plan for a report whose performance is falling short: describe the concern, name the areas to improve, and set the gates where the improvement has to be shown.'
          : 'A plan names what has to improve and the gates where the improvement is checked. Your manager or HR writes it; you can read it here.'}>
        {manager && !creating && (
          <button className="btn-pri" onClick={() => setCreating(true)}><Plus size={13} className="inline mr-1" />Open an improvement plan</button>
        )}
      </PageHead>

      {manager && creating && (
        <PlanForm team={team} presetEmployeeId={preset}
          onCancel={() => setCreating(false)}
          onSaved={(id) => { setCreating(false); load(); setOpenId(id); }} />
      )}

      <SearchBox value={q} onChange={setQ} placeholder="Search plans by employee, cycle or status…"
        shown={pipsShown.length} total={(pips || []).length} />
      {!pips.length && (
        <div className="card p-8 text-center text-sm text-navy-400">
          {manager ? 'No improvement plans for your team.' : 'No improvement plans — either none has been opened, or you have none to view.'}
        </div>
      )}
      <div className="space-y-2">
        {pipsShown.map(p => (
          <div key={p.id} className="card">
            <button className="w-full flex items-center justify-between gap-2 p-4 text-left" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
              <div>
                <p className="font-semibold text-sm">{p.employee_name} <span className="text-navy-400 font-normal">· {p.cycle_name || '—'}</span></p>
                <p className="text-xs text-navy-400">
                  Opened {day(p.opened_at)} · {String(p.opened_by || '').startsWith('system:') ? 'on publish' : p.opened_by}
                  {p.gates_total > 0 && ` · gates met ${p.gates_met} of ${p.gates_total}`}
                </p>
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

const blankGate = () => ({ title: '', due_date: '', success_measure: '' });
const blankArea = () => ({ area: '', expected: '' });

// Used both to open a plan and to edit one. `initial` is the saved plan.
function PlanForm({ team, presetEmployeeId, initial, onCancel, onSaved }) {
  const [employeeId, setEmployeeId] = useState(initial ? initial.employee_id : presetEmployeeId || '');
  const [description, setDescription] = useState(initial ? initial.performance_description || '' : '');
  const [areas, setAreas] = useState(initial && (initial.target_areas || []).length ? initial.target_areas : [blankArea()]);
  const [gates, setGates] = useState(initial && (initial.gates || []).length
    ? initial.gates.map((g) => ({ ...g, due_date: iso(g.due_date) })) : [blankGate()]);
  const [start, setStart] = useState(initial ? iso(initial.start_date) : new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(initial ? iso(initial.end_date) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const setArea = (i, patch) => setAreas((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setGate = (i, patch) => setGates((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = async () => {
    setBusy(true); setErr(null);
    const body = {
      performance_description: description,
      target_areas: areas.filter((a) => a.area.trim()),
      gates: gates.filter((g) => String(g.title || '').trim()).map((g) => ({ id: g.id, title: g.title, due_date: g.due_date || null, success_measure: g.success_measure })),
      start_date: start || null, end_date: end || null,
    };
    try {
      if (initial) {
        await api(`/pms/pip/${initial.id}`, { method: 'PUT', body: JSON.stringify(body) });
        onSaved(initial.id);
      } else {
        if (!employeeId) throw new Error('Pick the employee this plan is for.');
        const r = await api('/pms/pip', { method: 'POST', body: JSON.stringify({ employee_id: employeeId, ...body }) });
        onSaved(r.id);
      }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className={`${initial ? '' : 'card p-4'} space-y-3`}>
      {!initial && (
        <div>
          <label className="lbl">Employee</label>
          <select className="inp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Select a report…</option>
            {team.map((t) => <option key={t.employee_id} value={t.employee_id}>{t.name}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className="lbl">1. Description of the performance concern</label>
        <textarea className="inp" rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="What is falling short, how it shows, since when — specific examples, not labels." />
      </div>

      <div>
        <label className="lbl">2. Targeted areas</label>
        <div className="space-y-1.5">
          {areas.map((a, i) => (
            <div key={i} className="grid sm:grid-cols-[1fr_1.4fr_auto] gap-1.5">
              <input className="inp" value={a.area} placeholder="Area (e.g. Delivery predictability)"
                onChange={(e) => setArea(i, { area: e.target.value })} />
              <input className="inp" value={a.expected || ''} placeholder="What good looks like (e.g. 90% of sprint scope delivered)"
                onChange={(e) => setArea(i, { expected: e.target.value })} />
              <button type="button" className="btn-sec !px-2" disabled={areas.length === 1}
                onClick={() => setAreas((xs) => xs.filter((_, j) => j !== i))} title="Remove"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <button type="button" className="text-[11px] font-semibold text-navy-600 hover:underline mt-1" onClick={() => setAreas((xs) => [...xs, blankArea()])}>+ Add an area</button>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <div><label className="lbl">Plan starts</label><input className="inp" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div><label className="lbl">Plan ends</label><input className="inp" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>

      <div>
        <label className="lbl">3. Gates — where the improvement will be shown</label>
        <p className="text-[11px] text-navy-400 mb-1">Each gate is a dated checkpoint. At its date you record whether the improvement was shown.</p>
        <div className="space-y-1.5">
          {gates.map((g, i) => {
            const locked = g.status && g.status !== 'pending';
            return (
              <div key={g.id || i} className="grid sm:grid-cols-[1.2fr_auto_1.4fr_auto] gap-1.5">
                <input className="inp" value={g.title} placeholder={`Gate ${i + 1} (e.g. 30-day review)`} disabled={locked}
                  onChange={(e) => setGate(i, { title: e.target.value })} />
                <input className="inp" type="date" value={g.due_date || ''} disabled={locked} onChange={(e) => setGate(i, { due_date: e.target.value })} />
                <input className="inp" value={g.success_measure || ''} placeholder="What must be shown by then" disabled={locked}
                  onChange={(e) => setGate(i, { success_measure: e.target.value })} />
                <button type="button" className="btn-sec !px-2" disabled={gates.length === 1 || locked}
                  onClick={() => setGates((xs) => xs.filter((_, j) => j !== i))} title={locked ? 'Reviewed — it stays' : 'Remove'}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
        <button type="button" className="text-[11px] font-semibold text-navy-600 hover:underline mt-1" onClick={() => setGates((xs) => [...xs, blankGate()])}>+ Add a gate</button>
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : initial ? 'Save plan' : 'Open the plan'}</button>
        <button className="btn-sec" disabled={busy} onClick={onCancel}>Cancel</button>
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
  const [editing, setEditing] = useState(false);
  const load = () => api(`/pms/pip/${id}`).then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!data) return <p className="px-4 pb-4 text-xs text-navy-400">{err || 'Loading…'}</p>;
  const { pip, weekly_entries, can_edit: canEdit } = data;
  const closed = pip.status.startsWith('closed');
  const areas = pip.target_areas || [];
  const gates = pip.gates || [];

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

  if (editing) {
    return (
      <div className="px-4 pb-4 border-t border-navy-100 pt-3">
        <PlanForm initial={pip} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); onChange?.(); }} />
      </div>
    );
  }

  return (
    <div className="px-4 pb-4 space-y-3 border-t border-navy-100 pt-3">
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {pip.closed_reason && <p className="text-xs bg-navy-50 rounded-lg p-2"><span className="font-semibold">Closure note:</span> {pip.closed_reason}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-navy-500">
          {pip.designation || ''}{pip.department ? ` · ${pip.department}` : ''}
          {(pip.start_date || pip.end_date) && ` · ${day(pip.start_date)} to ${day(pip.end_date)}`}
        </p>
        {canEdit && <button className="btn-sec !py-1" onClick={() => setEditing(true)}><Pencil size={12} className="inline mr-1" />Edit plan</button>}
      </div>

      <div>
        <p className="lbl mb-1">Performance concern</p>
        {pip.performance_description
          ? <p className="text-xs whitespace-pre-wrap bg-navy-50 rounded-lg p-2">{pip.performance_description}</p>
          : pip.plan
            ? <p className="text-xs whitespace-pre-wrap bg-navy-50 rounded-lg p-2">{pip.plan}</p>
            : <p className="text-xs text-navy-400">Not written yet{canEdit ? ' — use Edit plan.' : '.'}</p>}
      </div>

      <div>
        <p className="lbl mb-1">Targeted areas</p>
        {!areas.length && <p className="text-xs text-navy-400">None named yet.</p>}
        <ul className="text-xs space-y-1">
          {areas.map((a, i) => (
            <li key={i} className="flex gap-2"><b className="text-navy-800">{a.area}</b>{a.expected && <span className="text-navy-500">— {a.expected}</span>}</li>
          ))}
        </ul>
      </div>

      <div>
        <p className="lbl mb-1">Gates</p>
        {!gates.length && <p className="text-xs text-navy-400">No gates set yet.</p>}
        <div className="space-y-1.5">
          {gates.map((g) => <Gate key={g.id} pipId={pip.id} g={g} canEdit={canEdit} onDone={() => { load(); onChange?.(); }} />)}
        </div>
      </div>

      <div>
        <p className="lbl mb-1">Weekly notes</p>
        {!weekly_entries.length && <p className="text-xs text-navy-400">No weekly notes yet.</p>}
        <div className="space-y-1">
          {weekly_entries.map(w => (
            <div key={w.id} className="text-xs bg-navy-50 rounded-lg p-2">
              <p className="font-semibold">Week ending {day(w.week_ending)} <span className="text-navy-400 font-normal">· {w.submitted_by}</span></p>
              <p className="mt-0.5">{w.notes}</p>
            </div>
          ))}
        </div>
      </div>

      {canEdit && !closed && (
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

      {canEdit && !closed && (
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

function Gate({ pipId, g, canEdit, onDone }) {
  const [reviewing, setReviewing] = useState(false);
  const [note, setNote] = useState(g.review_note || '');
  const [err, setErr] = useState(null);
  const review = async (status) => {
    setErr(null);
    try {
      await api(`/pms/pip/${pipId}/gates/${g.id}/review`, { method: 'POST', body: JSON.stringify({ status, review_note: note }) });
      setReviewing(false); onDone();
    } catch (e) { setErr(e.message); }
  };
  const Icon = g.status === 'met' ? CheckCircle2 : g.status === 'not_met' ? XCircle : Clock;
  return (
    <div className="border border-navy-100 rounded-lg p-2 text-xs space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p><b className="text-navy-800">{g.title}</b> <span className="text-navy-400">· by {day(g.due_date)}</span></p>
        <span className={`chip flex items-center gap-1 ${GATE_COLOR[g.status]}`}><Icon size={11} />{GATE_LABEL[g.status] || g.status}</span>
      </div>
      {g.success_measure && <p className="text-navy-600">To show: {g.success_measure}</p>}
      {g.review_note && !reviewing && <p className="text-navy-500 italic">Review: {g.review_note}{g.reviewed_by ? ` — ${g.reviewed_by}` : ''}</p>}
      {canEdit && !reviewing && (
        <button className="text-[11px] font-semibold text-navy-600 hover:underline" onClick={() => setReviewing(true)}>
          {g.status === 'pending' ? 'Review this gate' : 'Change review'}
        </button>
      )}
      {reviewing && (
        <div className="space-y-1.5">
          <textarea className="inp" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was seen at this gate" />
          <div className="flex flex-wrap gap-1.5">
            <button className="btn-pri !py-1" onClick={() => review('met')}>Met</button>
            <button className="btn-sec !py-1" onClick={() => review('not_met')}>Not met</button>
            {g.status !== 'pending' && <button className="btn-sec !py-1" onClick={() => review('pending')}>Back to pending</button>}
            <button className="btn-sec !py-1" onClick={() => setReviewing(false)}>Cancel</button>
          </div>
          {err && <p className="text-rose-600">{err}</p>}
        </div>
      )}
    </div>
  );
}
