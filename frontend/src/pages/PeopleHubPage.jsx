import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { showAt, endOfEvent } from '../utils/zone';

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

function Events({ manage }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  // Times in the company's zone, named, as HR entered them (utils/zone.js).
  const [tz, setTz] = useState('Asia/Kolkata');
  const when = (iso) => showAt(iso, tz);
  const load = () => api('/people/events').then(r => { setRows(r.events); if (r.timezone) setTz(r.timezone); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!rows) return err ? <p className="text-sm text-rose-600">{err}</p> : <p className="text-sm text-navy-400">Loading…</p>;
  // Coming up first, soonest at the top; what has happened after it.
  const now = new Date();
  const upcoming = rows.filter(e => endOfEvent(e, tz) >= now).reverse();
  const past = rows.filter(e => endOfEvent(e, tz) < now);
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

// Rewards & Recognition, read from RnR (13 Oct: the tab read an older
// awards system nothing else used). Everyone sees the open cycle, the
// awards, their own awards and the winners of each cycle once its award
// date has come; never a nominee or a pending nomination.
const LEVEL = { junior: 'Junior', mid: 'Mid-level', senior: 'Senior', all: 'All levels' };
const FREQ = { quarterly: 'quarterly', half_yearly: 'half-yearly', annual: 'annual' };
const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function Awards({ user }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/people/rnr/hub').then(setData).catch(e => setErr(e.message)); }, []);
  if (!data) return err ? <p className="text-sm text-rose-600">{err}</p> : <p className="text-sm text-navy-400">Loading…</p>;
  const c = data.open_cycle;
  const canNominate = data.can_nominate && (!user || !user.pages || user.pages.includes('/rnr/nominate'));
  return (
    <div className="space-y-3">
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px]">
          {c ? <>
            <p className="text-sm font-semibold">{c.name} is open for nominations</p>
            <p className="text-xs text-navy-400">Nominations {day(c.nominations_open)} – {day(c.nominations_close)}{c.award_date ? ` · awards on ${day(c.award_date)}` : ''}</p>
          </> : <p className="text-sm text-navy-500">No Rewards &amp; Recognition cycle is open for nominations right now.</p>}
        </div>
        {c && canNominate && <NavLink to="/rnr/nominate" className="btn-pri">Nominate for RnR →</NavLink>}
      </div>

      {data.mine.length > 0 && (
        <div className="card divide-y divide-navy-100">
          <p className="lbl px-3 pt-3 mb-0">Your awards</p>
          {data.mine.map((m, i) => (
            <div key={i} className="p-3 flex flex-wrap items-center gap-2">
              <div className="flex-1"><p className="text-sm font-semibold">{m.award_name}</p>
                <p className="text-xs text-navy-400">{m.cycle_name}{m.award_date ? ` · ${day(m.award_date)}` : ''}</p></div>
              <span className="chip bg-emerald-100 text-emerald-700">{m.status === 'awarded' ? 'Awarded' : 'Approved'}</span>
            </div>
          ))}
        </div>
      )}

      {data.winners.map(g => (
        <div key={g.cycle_id} className="card divide-y divide-navy-100">
          <p className="lbl px-3 pt-3 mb-0">Winners · {g.cycle_name}{g.award_date ? ` · ${day(g.award_date)}` : ''}</p>
          {g.winners.map((w, i) => (
            <div key={i} className="p-3 flex flex-wrap items-center gap-2">
              <span className="chip bg-amber-100 text-amber-800">{w.award_name}</span>
              {w.team_name
                ? <p className="text-sm"><b>{w.team_name}</b>{w.team_members ? <span className="text-navy-400"> · {w.team_members}</span> : null}</p>
                : <p className="text-sm"><b>{w.name}</b>{w.department ? <span className="text-navy-400"> · {w.department}</span> : null}</p>}
            </div>
          ))}
        </div>
      ))}
      {!data.winners.length && <p className="text-xs text-navy-400 px-1">Winners appear here on each cycle's award date.</p>}

      {data.awards.length > 0 && (
        <div className="card divide-y divide-navy-100">
          <p className="lbl px-3 pt-3 mb-0">The awards</p>
          {data.awards.map((a, i) => (
            <div key={i} className="p-3">
              <p className="text-sm font-semibold">{a.name} <span className="text-xs font-normal text-navy-400">· {a.is_team ? 'team' : 'individual'} · {FREQ[a.frequency] || a.frequency} · {LEVEL[a.level] || a.level}</span></p>
              {a.criteria && <p className="text-xs text-navy-500 mt-0.5 whitespace-pre-line">{a.criteria}</p>}
            </div>
          ))}
        </div>
      )}
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
            <p className="text-xs text-navy-400">{c.event_date ? String(c.event_date).slice(0, 10) : 'date TBD'}{Number(c.hours_credit) ? ` · ${Number(c.hours_credit)} hours credit` : ''} · {c.participants} participating {c.joined && (c.my_hours != null ? `· you: ${Number(c.my_hours)}h` : '· you have signed up')}</p>
            {c.description && <p className="text-xs text-navy-500 mt-0.5 whitespace-pre-line">{c.description}</p>}</div>
          <button className="btn-sec" onClick={async () => {
            const h = prompt(c.joined ? 'Hours you contributed (leave as is to keep them)' : 'Hours you contributed (blank = sign up)',
              c.my_hours != null ? String(Number(c.my_hours)) : '');
            if (h === null) return;
            // Sent as typed, so "4 hrs" is refused with a reason instead of
            // quietly wiping the hours already on record.
            try { await api(`/people/csr/${c.id}/participate`, { method: 'POST', body: JSON.stringify({ hours: h.trim() === '' ? null : h.trim() }) }); }
            catch (e) { alert(e.message); }
            load();
          }}>{c.joined ? 'Update hours' : 'Participate'}</button>
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
