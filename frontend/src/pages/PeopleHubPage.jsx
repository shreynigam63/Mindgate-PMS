import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import PageHead from '../PageHead';

export default function PeopleHubPage({ user }) {
  const [tab, setTab] = useState('events');
  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="People Hub" hue="teal" />
      <div className="flex gap-1 bg-navy-50 rounded-xl p-1 w-fit flex-wrap">
        {[['events', 'Events'], ['awards', 'Awards'], ['csr', 'CSR'], ['queries', 'Appraisal Queries']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg ${tab === k ? 'bg-white shadow-sm' : 'text-navy-500'}`}>{l}</button>
        ))}
      </div>
      {tab === 'events' && <Events manage={canManage(user)} />}
      {tab === 'awards' && <Awards user={user} />}
      {tab === 'csr' && <Csr manage={canManage(user)} />}
      {tab === 'queries' && <Queries />}
    </div>
  );
}

// HR and Super Admin schedule events and CSR on HR → Events & CSR (13 Oct);
// this tab links there for them. The same page row that shows them the menu
// entry decides it.
const canManage = (user) => (user && user.pages ? user.pages.includes('/admin/events') : ['admin', 'hr'].includes(user && user.role));
const ManageLink = ({ manage, label }) => (manage
  ? <div className="flex justify-end"><NavLink to="/admin/events" className="text-xs font-semibold text-brand-600">{label} →</NavLink></div>
  : null);
const when = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function Events({ manage }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/people/events').then(r => setRows(r.events)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!rows) return err ? <p className="text-sm text-rose-600">{err}</p> : <p className="text-sm text-navy-400">Loading…</p>;
  // Coming up first, soonest at the top; what has happened after it.
  const now = new Date();
  const upcoming = rows.filter(e => new Date(e.ends_at || e.starts_at) >= now).reverse();
  const past = rows.filter(e => new Date(e.ends_at || e.starts_at) < now);
  const rsvp = async (e, r) => {
    setErr(null);
    try { await api(`/people/events/${e.id}/rsvp`, { method: 'POST', body: JSON.stringify({ response: r }) }); load(); }
    catch (x) { setErr(x.message); load(); }
  };
  const row = (e, isPast) => (
    <div key={e.id} className="p-3 flex flex-wrap items-center gap-2">
      <div className="flex-1 min-w-[200px]"><p className={`text-sm font-semibold ${isPast ? 'text-navy-500' : ''}`}>{e.title}</p>
        <p className="text-xs text-navy-400">{when(e.starts_at)}{e.ends_at ? ` – ${when(e.ends_at)}` : ''}{e.location ? ` · ${e.location}` : ''} · {e.yes_count} attending</p>
        {e.description && <p className="text-xs text-navy-500 mt-0.5 whitespace-pre-line">{e.description}</p>}</div>
      {!isPast && ['yes', 'maybe', 'no'].map(r => (
        <button key={r} className={`btn ${e.my_rsvp === r ? 'btn-pri' : 'btn-sec'}`} onClick={() => rsvp(e, r)}>{r}</button>
      ))}
      {isPast && e.my_rsvp && <span className="chip bg-navy-50 text-navy-500">you said {e.my_rsvp}</span>}
    </div>
  );
  return (
    <div className="space-y-2">
      <ManageLink manage={manage} label="Schedule an event" />
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="card divide-y divide-navy-100">
        {upcoming.map(e => row(e, false))}
        {!upcoming.length && <p className="p-6 text-center text-sm text-navy-400">No events scheduled.</p>}
      </div>
      {past.length > 0 && (
        <div className="card divide-y divide-navy-100">
          <p className="lbl px-3 pt-3 mb-0">Past events</p>
          {past.map(e => row(e, true))}
        </div>
      )}
    </div>
  );
}

function Awards({ user }) {
  const [data, setData] = useState(null);
  useEffect(() => { api('/people/awards').then(setData); }, []);
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  return (
    <div className="card divide-y divide-navy-100">
      {data.cycles.map(c => (
        <div key={c.id} className="p-3 flex flex-wrap items-center gap-2">
          <div className="flex-1"><p className="text-sm font-semibold">{c.program_name} — {c.name}</p>
            <p className="text-xs text-navy-400">{c.nominations} nomination(s)</p></div>
          <span className={`chip ${c.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-600'}`}>{c.status}</span>
          {c.status === 'open' && <button className="btn-sec" onClick={async () => {
            const email = prompt('Nominee email'); if (!email) return;
            const emp = await api('/employees'); const nom = emp.employees.find(x => x.email === email.toLowerCase().trim());
            if (!nom) return alert('No employee with that email');
            const citation = prompt('Citation — why do they deserve it?'); if (!citation) return;
            try { await api(`/people/awards/cycles/${c.id}/nominate`, { method: 'POST', body: JSON.stringify({ nominee_id: nom.id, citation }) }); alert('Nominated.'); }
            catch (e) { alert(e.message); }
          }}>Nominate</button>}
        </div>
      ))}
      {!data.cycles.length && <p className="p-6 text-center text-sm text-navy-400">No award cycles.</p>}
    </div>
  );
}

function Csr({ manage }) {
  const [rows, setRows] = useState(null);
  const load = () => api('/people/csr').then(r => setRows(r.csr));
  useEffect(() => { load(); }, []);
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;
  return (
    <div className="space-y-2">
    <ManageLink manage={manage} label="Add a CSR activity" />
    <div className="card divide-y divide-navy-100">
      {rows.map(c => (
        <div key={c.id} className="p-3 flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[200px]"><p className="text-sm font-semibold">{c.title}</p>
            <p className="text-xs text-navy-400">{c.event_date ? String(c.event_date).slice(0, 10) : 'date TBD'}{Number(c.hours_credit) ? ` · ${Number(c.hours_credit)} hours credit` : ''} · {c.participants} participating {c.my_hours != null && `· you: ${c.my_hours}h`}</p>
            {c.description && <p className="text-xs text-navy-500 mt-0.5 whitespace-pre-line">{c.description}</p>}</div>
          <button className="btn-sec" onClick={async () => {
            const h = prompt('Hours you contributed (blank = sign up)');
            if (h === null) return;
            try { await api(`/people/csr/${c.id}/participate`, { method: 'POST', body: JSON.stringify({ hours: h.trim() ? Number(h) : null }) }); }
            catch (e) { alert(e.message); }
            load();
          }}>{c.my_hours != null ? 'Update hours' : 'Participate'}</button>
        </div>
      ))}
      {!rows.length && <p className="p-6 text-center text-sm text-navy-400">No CSR activities.</p>}
    </div>
    </div>
  );
}

function Queries() {
  const [data, setData] = useState(null);
  const [openQ, setOpenQ] = useState(null);
  const load = () => api('/people/queries').then(setData);
  useEffect(() => { load(); }, []);
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  return (
    <div className="space-y-3">
      <button className="btn-pri" onClick={async () => {
        const subject = prompt('Query subject'); if (!subject) return;
        const body = prompt('Your question'); if (!body) return;
        try { await api('/people/queries', { method: 'POST', body: JSON.stringify({ subject, body }) }); load(); }
        catch (e) { alert(e.message); }
      }}>Raise an appraisal query</button>
      <div className="card divide-y divide-navy-100">
        {data.queries.map(q => (
          <div key={q.id} className="p-3">
            <button className="w-full text-left flex items-center gap-2" onClick={() => setOpenQ(v => v === q.id ? null : q.id)}>
              <span className="text-sm font-semibold flex-1">{q.subject}</span>
              {data.admin && <span className="text-xs text-navy-400">{q.employee_name}</span>}
              <span className={`chip ${q.status === 'open' ? 'bg-amber-100 text-amber-700' : q.status === 'answered' ? 'bg-blue-100 text-blue-700' : 'bg-navy-50 text-navy-600'}`}>{q.status}</span>
            </button>
            {openQ === q.id && <Thread id={q.id} reload={load} />}
          </div>
        ))}
        {!data.queries.length && <p className="p-6 text-center text-sm text-navy-400">No queries.</p>}
      </div>
    </div>
  );
}

function Thread({ id, reload }) {
  const [t, setT] = useState(null);
  const [body, setBody] = useState('');
  const load = () => api(`/people/queries/${id}/messages`).then(setT);
  useEffect(() => { load(); }, [id]);
  if (!t) return null;
  return (
    <div className="mt-2 space-y-2 text-xs">
      {t.messages.map(m => <p key={m.id}><b>{m.author_name}:</b> {m.body}</p>)}
      <div className="flex gap-2">
        <input className="inp" placeholder="Reply…" value={body} onChange={e => setBody(e.target.value)} />
        <button className="btn-sec" onClick={async () => { await api(`/people/queries/${id}/reply`, { method: 'POST', body: JSON.stringify({ body }) }); setBody(''); load(); reload(); }}>Send</button>
      </div>
    </div>
  );
}
