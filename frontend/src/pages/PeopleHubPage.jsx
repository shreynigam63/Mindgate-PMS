import { useEffect, useState } from 'react';
import { api } from '../utils/api';

export default function PeopleHubPage({ user }) {
  const [tab, setTab] = useState('events');
  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <h2 className="text-lg font-bold">People Hub</h2>
      <div className="flex gap-1 bg-navy-50 rounded-xl p-1 w-fit flex-wrap">
        {[['events', 'Events'], ['awards', 'Awards'], ['csr', 'CSR'], ['queries', 'Appraisal Queries']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg ${tab === k ? 'bg-white shadow-sm' : 'text-navy-500'}`}>{l}</button>
        ))}
      </div>
      {tab === 'events' && <Events />}
      {tab === 'awards' && <Awards user={user} />}
      {tab === 'csr' && <Csr />}
      {tab === 'queries' && <Queries />}
    </div>
  );
}

function Events() {
  const [rows, setRows] = useState(null);
  const load = () => api('/people/events').then(r => setRows(r.events));
  useEffect(() => { load(); }, []);
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;
  return (
    <div className="card divide-y divide-navy-100">
      {rows.map(e => (
        <div key={e.id} className="p-3 flex flex-wrap items-center gap-2">
          <div className="flex-1"><p className="text-sm font-semibold">{e.title}</p>
            <p className="text-xs text-navy-400">{new Date(e.starts_at).toLocaleString('en-IN')} {e.location && `· ${e.location}`} · {e.yes_count} attending</p></div>
          {['yes', 'maybe', 'no'].map(r => (
            <button key={r} className={`btn ${e.my_rsvp === r ? 'btn-pri' : 'btn-sec'}`}
              onClick={async () => { await api(`/people/events/${e.id}/rsvp`, { method: 'POST', body: JSON.stringify({ response: r }) }); load(); }}>{r}</button>
          ))}
        </div>
      ))}
      {!rows.length && <p className="p-6 text-center text-sm text-navy-400">No events scheduled.</p>}
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

function Csr() {
  const [rows, setRows] = useState(null);
  const load = () => api('/people/csr').then(r => setRows(r.csr));
  useEffect(() => { load(); }, []);
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;
  return (
    <div className="card divide-y divide-navy-100">
      {rows.map(c => (
        <div key={c.id} className="p-3 flex flex-wrap items-center gap-2">
          <div className="flex-1"><p className="text-sm font-semibold">{c.title}</p>
            <p className="text-xs text-navy-400">{c.event_date || 'date TBD'} · {c.participants} participating {c.my_hours != null && `· you: ${c.my_hours}h`}</p></div>
          <button className="btn-sec" onClick={async () => {
            const h = prompt('Hours you contributed (blank = sign up)');
            await api(`/people/csr/${c.id}/participate`, { method: 'POST', body: JSON.stringify({ hours: h ? Number(h) : null }) }); load();
          }}>{c.my_hours != null ? 'Update hours' : 'Participate'}</button>
        </div>
      ))}
      {!rows.length && <p className="p-6 text-center text-sm text-navy-400">No CSR activities.</p>}
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
