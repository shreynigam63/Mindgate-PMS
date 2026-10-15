import { useEffect, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { api } from '../utils/api';
import { wallToIso, isoToWall, showAt, endOfEvent } from '../utils/zone';
import PageHead from '../PageHead';
import { Plus, Save, Trash2, Pencil, Users, X } from 'lucide-react';

// HR's Events & CSR page (13 Oct: "apart from awards, there is no option
// for HR to start Events from HR Admin tab ... linked with People Hub").
// What is scheduled here is what everyone sees, and answers, on People Hub
// → Events and → CSR. A new one tells every employee in the app.

// <input type="datetime-local"> speaks wall-clock time with no zone; the
// server stores an instant. Both are read in the COMPANY's zone (the
// server says which), so 6 pm is 6 pm in Pune for whoever types or reads
// it. An event with no end time runs to the end of the day it starts
// (endOfEvent), the rule the server closes RSVPs by. See utils/zone.js.
// What HR is told after creating one: the truth about the notice.
const toldWho = (n, asked) => (!asked ? '' : n == null
  ? ' The in-app notice could not be sent — tell people another way, or try again later.'
  : `, and ${n} employee${n === 1 ? ' has' : 's have'} been told in the app`);

const day = (d) => (d ? String(d).slice(0, 10) : '');

const BLANK_EVENT = { title: '', starts_at: '', ends_at: '', location: '', description: '', notify: true };
const BLANK_CSR = { title: '', event_date: '', hours_credit: '', description: '', notify: true };

export default function EventsAdminPage() {
  const [events, setEvents] = useState(null);
  const [csr, setCsr] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  // Opened from another page with an event to plan (Super 50 Benefits →
  // Plan the felicitation): the form starts filled in, nothing is saved.
  const [params] = useSearchParams();
  const [ev, setEv] = useState(() => ({ ...BLANK_EVENT, title: params.get('title') || '', description: params.get('description') || '' }));
  const [evId, setEvId] = useState(null);       // the event being edited, or null for a new one
  const [c, setC] = useState(BLANK_CSR);
  const [cId, setCId] = useState(null);
  const [who, setWho] = useState(null);          // { kind, id, title, rows }
  const [tz, setTz] = useState('Asia/Kolkata');  // the company's zone, from the server
  const [saving, setSaving] = useState(false);   // one save at a time: a double click is not two events
  const when = (iso) => showAt(iso, tz);

  const load = async () => {
    try {
      const [e, s] = await Promise.all([api('/people/events'), api('/people/csr')]);
      setEvents(e.events || []); setCsr(s.csr || []); if (e.timezone) setTz(e.timezone);
    } catch (x) { setErr(x.message); }
  };
  useEffect(() => { load(); }, []);

  const act = async (fn, done) => {
    if (saving) return false;
    setErr(null); setMsg(null); setSaving(true);
    try { const r = await fn(); setMsg(typeof done === 'function' ? done(r) : done); await load(); return true; }
    catch (x) { setErr(x.message); return false; }
    finally { setSaving(false); }
  };

  const saveEvent = async () => {
    const starts = wallToIso(ev.starts_at, tz);
    const ends = ev.ends_at ? wallToIso(ev.ends_at, tz) : null;
    if (!starts) { setErr('The start is not a valid date and time.'); return; }
    if (ends === undefined) { setErr('The end is not a valid date and time.'); return; }
    const body = { title: ev.title, location: ev.location, description: ev.description, starts_at: starts, ends_at: ends };
    const ok = await act(
      () => (evId
        ? api(`/people/events/${evId}`, { method: 'PUT', body: JSON.stringify(body) })
        : api('/people/events', { method: 'POST', body: JSON.stringify({ ...body, notify: ev.notify }) })),
      evId ? 'Event updated. People Hub shows the change.'
        : (r) => `Event scheduled. It is on People Hub → Events${toldWho(r && r.notified, ev.notify)}.`);
    if (ok) { setEv(BLANK_EVENT); setEvId(null); }
  };
  const saveCsr = async () => {
    const body = { title: c.title, event_date: c.event_date || null, hours_credit: c.hours_credit, description: c.description };
    const ok = await act(
      () => (cId
        ? api(`/people/csr/${cId}`, { method: 'PUT', body: JSON.stringify(body) })
        : api('/people/csr', { method: 'POST', body: JSON.stringify({ ...body, notify: c.notify }) })),
      cId ? 'Activity updated. People Hub shows the change.'
        : (r) => `CSR activity added. It is on People Hub → CSR${toldWho(r && r.notified, c.notify)}.`);
    if (ok) { setC(BLANK_CSR); setCId(null); }
  };
  const showWho = async (kind, row) => {
    setErr(null);
    try {
      const r = kind === 'event'
        ? (await api(`/people/events/${row.id}/rsvps`)).rsvps
        : (await api(`/people/csr/${row.id}/participants`)).participants;
      setWho({ kind, id: row.id, title: row.title, rows: r });
    } catch (x) { setErr(x.message); }
  };

  const editEvent = (e) => {
    setEvId(e.id);
    setEv({ title: e.title, starts_at: isoToWall(e.starts_at, tz), ends_at: isoToWall(e.ends_at, tz), location: e.location || '', description: e.description || '', notify: false });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const deleteEvent = (e) => {
    const n = e.rsvp_count ?? e.yes_count;
    if (!window.confirm(`Delete "${e.title}"? Its ${n} RSVP${n === 1 ? '' : 's'} (yes, maybe and no) are deleted with it, and it disappears from People Hub.`)) return;
    act(() => api(`/people/events/${e.id}`, { method: 'DELETE' }), 'Event deleted.');
  };

  if (!events || !csr) return err ? <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>
    : <p className="text-sm text-navy-400">Loading…</p>;

  const upcoming = events.filter((e) => endOfEvent(e, tz) >= new Date()).reverse();
  const past = events.filter((e) => endOfEvent(e, tz) < new Date());

  return (
    <div className="space-y-3 max-w-5xl mx-auto">
      <PageHead title="Events & CSR" hue="violet"
        sub="Schedule events and CSR activities. Everyone sees and answers them on People Hub." />
      <div className="flex justify-end">
        <NavLink to="/people" className="text-xs font-semibold text-brand-600">View in People Hub →</NavLink>
      </div>
      {err && <div className="card p-3 text-xs border-l-4 border-rose-500 text-rose-700">{err}</div>}
      {msg && <div className="card p-3 text-xs border-l-4 border-leaf-500">{msg}</div>}

      {/* ---- Events ---- */}
      <div className="card p-4 space-y-3">
        <p className="lbl mb-0">{evId ? 'Edit event' : 'Schedule an event'}</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="lbl">Title *</label>
            <input className="inp" value={ev.title} maxLength={200} onChange={(e) => setEv({ ...ev, title: e.target.value })} placeholder="e.g. Diwali celebration" />
          </div>
          <div>
            <label className="lbl">Starts * <span className="normal-case font-normal text-navy-400">({tz})</span></label>
            <input className="inp" type="datetime-local" value={ev.starts_at} onChange={(e) => setEv({ ...ev, starts_at: e.target.value })} />
          </div>
          <div>
            <label className="lbl">Ends</label>
            <input className="inp" type="datetime-local" value={ev.ends_at} onChange={(e) => setEv({ ...ev, ends_at: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <label className="lbl">Location</label>
            <input className="inp" value={ev.location} maxLength={300} onChange={(e) => setEv({ ...ev, location: e.target.value })} placeholder="e.g. Pune office, 5th floor cafeteria · or a meeting link" />
          </div>
          <div className="sm:col-span-2">
            <label className="lbl">Description</label>
            <textarea className="inp" rows={3} value={ev.description} maxLength={4000} onChange={(e) => setEv({ ...ev, description: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!evId && (
            <label className="flex items-center gap-1.5 text-xs text-navy-600">
              <input type="checkbox" checked={ev.notify} onChange={(e) => setEv({ ...ev, notify: e.target.checked })} />
              Tell every employee in the app
            </label>
          )}
          <div className="flex-1" />
          {evId && <button className="btn-sec" onClick={() => { setEv(BLANK_EVENT); setEvId(null); }}>Cancel</button>}
          <button className="btn-pri" disabled={saving || !ev.title.trim() || !ev.starts_at} onClick={saveEvent}>
            {evId ? <><Save size={14} className="inline mr-1" />Save changes</> : <><Plus size={14} className="inline mr-1" />Schedule</>}
          </button>
        </div>
      </div>

      <div className="card divide-y divide-navy-100">
        <p className="lbl px-4 pt-3 mb-0">Upcoming events · {upcoming.length}</p>
        {upcoming.map((e) => <EventRow key={e.id} e={e} when={when} onEdit={() => editEvent(e)} onWho={() => showWho('event', e)} onDelete={() => deleteEvent(e)} />)}
        {!upcoming.length && <p className="p-4 text-sm text-navy-400">Nothing scheduled. Schedule one above and it appears on People Hub.</p>}
        {past.length > 0 && <p className="lbl px-4 pt-3 mb-0">Past events · {past.length}</p>}
        {past.map((e) => <EventRow key={e.id} e={e} when={when} past onEdit={() => editEvent(e)} onWho={() => showWho('event', e)} onDelete={() => deleteEvent(e)} />)}
      </div>

      {/* ---- CSR ---- */}
      <div className="card p-4 space-y-3">
        <p className="lbl mb-0">{cId ? 'Edit CSR activity' : 'Add a CSR activity'}</p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-3">
            <label className="lbl">Title *</label>
            <input className="inp" value={c.title} maxLength={200} onChange={(e) => setC({ ...c, title: e.target.value })} placeholder="e.g. Tree plantation drive" />
          </div>
          <div>
            <label className="lbl">Date</label>
            <input className="inp" type="date" value={c.event_date} onChange={(e) => setC({ ...c, event_date: e.target.value })} />
          </div>
          <div>
            <label className="lbl">Hours credit</label>
            <input className="inp" type="number" min="0" max="999" step="0.5" value={c.hours_credit} onChange={(e) => setC({ ...c, hours_credit: e.target.value })} placeholder="0" />
          </div>
          <div className="sm:col-span-3">
            <label className="lbl">Description</label>
            <textarea className="inp" rows={3} value={c.description} maxLength={4000} onChange={(e) => setC({ ...c, description: e.target.value })} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!cId && (
            <label className="flex items-center gap-1.5 text-xs text-navy-600">
              <input type="checkbox" checked={c.notify} onChange={(e) => setC({ ...c, notify: e.target.checked })} />
              Tell every employee in the app
            </label>
          )}
          <div className="flex-1" />
          {cId && <button className="btn-sec" onClick={() => { setC(BLANK_CSR); setCId(null); }}>Cancel</button>}
          <button className="btn-pri" disabled={saving || !c.title.trim()} onClick={saveCsr}>
            {cId ? <><Save size={14} className="inline mr-1" />Save changes</> : <><Plus size={14} className="inline mr-1" />Add</>}
          </button>
        </div>
      </div>

      <div className="card divide-y divide-navy-100">
        <p className="lbl px-4 pt-3 mb-0">CSR activities · {csr.length}</p>
        {csr.map((a) => (
          <div key={a.id} className="p-3 px-4 flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[200px]">
              <p className="text-sm font-semibold">{a.title}</p>
              <p className="text-xs text-navy-400">{day(a.event_date) || 'date to be set'} · {Number(a.hours_credit || 0)} hours credit · {a.participants} taking part</p>
              {a.description && <p className="text-xs text-navy-500 mt-0.5 whitespace-pre-line">{a.description}</p>}
            </div>
            <button className="btn-sec !text-xs" onClick={() => showWho('csr', a)}><Users size={13} className="inline mr-1" />Who</button>
            <button className="btn-sec !text-xs" onClick={() => {
              setCId(a.id);
              setC({ title: a.title, event_date: day(a.event_date), hours_credit: a.hours_credit ?? '', description: a.description || '', notify: false });
            }}><Pencil size={13} className="inline mr-1" />Edit</button>
            <button className="btn-sec !text-xs text-rose-600" onClick={() => {
              if (!window.confirm(`Delete "${a.title}"? Its ${a.participants} participation record(s) are deleted with it.`)) return;
              act(() => api(`/people/csr/${a.id}`, { method: 'DELETE' }), 'Activity deleted.');
            }}><Trash2 size={13} className="inline mr-1" />Delete</button>
          </div>
        ))}
        {!csr.length && <p className="p-4 text-sm text-navy-400">No CSR activities yet. Add one above and it appears on People Hub → CSR.</p>}
      </div>

      {who && (
        <div className="card p-4 space-y-2 border-l-4 border-brand-500">
          <div className="flex items-center">
            <p className="lbl mb-0 flex-1">{who.kind === 'event' ? 'RSVPs' : 'Taking part'} · {who.title}</p>
            <button className="text-navy-400" onClick={() => setWho(null)} aria-label="Close"><X size={16} /></button>
          </div>
          {who.rows.length ? (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-navy-400"><th className="py-1">Name</th><th>Department</th><th>{who.kind === 'event' ? 'Answer' : 'Hours'}</th><th>When</th></tr></thead>
              <tbody>
                {who.rows.map((r) => (
                  <tr key={r.employee_id} className="border-t border-navy-100">
                    <td className="py-1">{r.name}</td><td>{r.department || '—'}</td>
                    <td>{who.kind === 'event' ? r.response : (r.hours != null ? `${Number(r.hours)}h` : 'signed up')}</td>
                    <td>{when(r.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-xs text-navy-400">Nobody yet.</p>}
        </div>
      )}
    </div>
  );
}

function EventRow({ e, when, past, onEdit, onWho, onDelete }) {
  return (
    <div className="p-3 px-4 flex flex-wrap items-center gap-2">
      <div className="flex-1 min-w-[200px]">
        <p className={`text-sm font-semibold ${past ? 'text-navy-500' : ''}`}>{e.title}</p>
        <p className="text-xs text-navy-400">
          {when(e.starts_at)}{e.ends_at ? ` – ${when(e.ends_at)}` : ''}{e.location ? ` · ${e.location}` : ''} · {e.yes_count} attending
        </p>
        {e.description && <p className="text-xs text-navy-500 mt-0.5 whitespace-pre-line">{e.description}</p>}
      </div>
      <button className="btn-sec !text-xs" onClick={onWho}><Users size={13} className="inline mr-1" />RSVPs</button>
      <button className="btn-sec !text-xs" onClick={onEdit}><Pencil size={13} className="inline mr-1" />Edit</button>
      <button className="btn-sec !text-xs text-rose-600" onClick={onDelete}><Trash2 size={13} className="inline mr-1" />Delete</button>
    </div>
  );
}
