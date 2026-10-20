import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { Plus, Send, X, CheckCircle2 } from 'lucide-react';
import LongText, { Req } from '../LongText';

// Queries (15 Oct; until then "Appraisal Queries", asked with two prompt
// boxes and seen only by HR). A query has a title, the people it is raised
// to — picked by name or email, and told by email — and a description,
// filled in on the page itself.
//
//   QueriesPanel    People Hub → Queries: what you raised, and what was
//                   raised to you (someone in HR answers theirs on the HR tab)
//   HrQueriesPage   HR → Queries: every query in the company

const STATUS = {
  open: ['Open', 'bg-amber-100 text-amber-700'],
  answered: ['Answered', 'bg-blue-100 text-blue-700'],
  closed: ['Closed', 'bg-navy-50 text-navy-600'],
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const names = (list) => (list && list.length ? list.map((p) => p.name).join(', ') : 'HR');

export function QueriesPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [writing, setWriting] = useState(false);
  const load = () => api('/people/queries').then((r) => { setData(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  const mine = data.queries.filter((q) => q.mine);
  const toMe = data.queries.filter((q) => !q.mine);
  return (
    <div className="space-y-3">
      {msg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{msg}</p>}
      {writing
        ? <QueryForm onDone={(m) => { setWriting(false); setMsg(m); load(); }} onCancel={() => setWriting(false)} />
        : <button className="btn-pri" onClick={() => { setWriting(true); setMsg(null); }}><Plus size={13} className="inline mr-1" />Raise query</button>}
      {data.admin && (
        <p className="text-[11.5px] text-navy-500">
          Queries raised to you, and every query in the company, are on <NavLink className="underline font-semibold" to="/admin/queries">HR → Queries</NavLink>.
        </p>
      )}
      <QueryList title="Raised by me" rows={mine} empty="You have not raised a query." reload={load} who="to" />
      {!data.admin && <QueryList title="Raised to me" rows={toMe} empty="No query has been raised to you." reload={load} who="from" />}
    </div>
  );
}

export default function HrQueriesPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [status, setStatus] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [q, setQ] = useState('');
  const load = () => api(`/people/queries?view=all${status ? `&status=${status}` : ''}`).then((r) => { setData(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [status]);
  const rows = data ? data.queries.filter((x) => (!onlyMine || x.to_me || x.to_hr)
    && matches(q, x.title, x.raised_by_name, x.raised_by_email, x.raised_by_department, names(x.raised_to))) : [];
  const open = data ? data.queries.filter((x) => x.status === 'open').length : 0;
  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Queries" hue="navy" sub="Every query raised in the company. Answer here the ones raised to you or to HR.">
        {data && <span className="chip bg-amber-100 text-amber-700">{open} open</span>}
      </PageHead>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {[['', 'All'], ['open', 'Open'], ['answered', 'Answered'], ['closed', 'Closed']].map(([k, l]) => (
          <button key={k || 'all'} type="button" className={`chip ${status === k ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600'}`} onClick={() => setStatus(k)}>{l}</button>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-navy-600 ml-2">
          <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />Raised to me or to HR
        </label>
      </div>
      {data && <SearchBox value={q} onChange={setQ} placeholder="Search by title, who raised it, or whom it is raised to…" shown={rows.length} total={data.queries.length} />}
      {!data ? <p className="text-sm text-navy-400">Loading…</p>
        : <QueryList rows={rows} empty="No queries here." reload={load} who="both" />}
    </div>
  );
}

function QueryForm({ onDone, onCancel }) {
  const [title, setTitle] = useState('');
  const [to, setTo] = useState([]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api('/people/queries', { method: 'POST', body: JSON.stringify({ title, to: to.map((p) => p.id), description }) });
      onDone(r.message);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 space-y-3">
      <p className="lbl">Raise a query</p>
      <label className="block">
        <span className="lbl">Title<Req /></span>
        <input className="inp" value={title} maxLength={150} placeholder="What is it about?" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div>
        <span className="lbl">Raise to</span>
        <PeoplePicker value={to} onChange={setTo} />
        <p className="text-[11px] text-navy-400 mt-1">Search by name or email. Each person is told by email. Leave it empty to raise it to HR.</p>
      </div>
      <label className="block">
        <span className="lbl">Description<Req /></span>
        <LongText className="inp" rows={5} maxLength={4000} value={description} placeholder="Describe your query" onChange={(e) => setDescription(e.target.value)} />
      </label>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="flex gap-2 justify-end">
        <button className="btn-sec" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn-pri" onClick={send} disabled={busy || !title.trim() || !description.trim()}>
          <Send size={13} className="inline mr-1" />{busy ? 'Raising…' : 'Raise query'}
        </button>
      </div>
    </div>
  );
}

function PeoplePicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const timer = useRef(null);
  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits([]); return undefined; }
    timer.current = setTimeout(() => {
      api(`/people/queries/people?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.people || [])).catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer.current);
  }, [q]);
  const add = (p) => { if (!value.some((x) => x.id === p.id)) onChange([...value, p]); setQ(''); setHits([]); };
  const shown = hits.filter((h) => !value.some((x) => x.id === h.id));
  return (
    <div className="relative">
      <div className="inp !p-1.5 flex flex-wrap gap-1.5 items-center">
        {value.map((p) => (
          <span key={p.id} className="chip bg-navy-50 text-navy-700 flex items-center gap-1 !text-[11px]">
            {p.name} <span className="text-navy-400 font-normal">{p.email}</span>
            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter((x) => x.id !== p.id))}><X size={11} /></button>
          </span>
        ))}
        <input maxLength={150} className="flex-1 min-w-[12rem] text-sm px-2 py-1 outline-none bg-transparent" value={q} placeholder={value.length ? 'Add another…' : 'Name or email'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); add(shown[0]); } }} />
      </div>
      {!!shown.length && (
        <div className="absolute z-20 mt-1 w-full card !rounded-xl max-h-64 overflow-y-auto">
          {shown.map((p) => (
            <button key={p.id} type="button" className="w-full text-left px-3 py-2 hover:bg-navy-50 text-sm" onClick={() => add(p)}>
              <b className="text-navy-700">{p.name}</b> <span className="text-navy-500">{p.email}</span>
              {(p.designation || p.department) && <div className="text-[11px] text-navy-400">{[p.designation, p.department].filter(Boolean).join(' · ')}</div>}
            </button>
          ))}
        </div>
      )}
      {q.trim().length >= 2 && !hits.length && <p className="text-[11px] text-navy-400 mt-1">Nobody matches “{q.trim()}”.</p>}
    </div>
  );
}

function QueryList({ title, rows, empty, reload, who }) {
  const [openId, setOpenId] = useState(null);
  return (
    <div>
      {title && <p className="lbl mb-1">{title}</p>}
      <div className="card divide-y divide-navy-100">
        {rows.map((q) => {
          const [label, cls] = STATUS[q.status] || [q.status, ''];
          return (
            <div key={q.id} className="p-3">
              <button className="w-full text-left flex items-start gap-2" onClick={() => setOpenId((v) => (v === q.id ? null : q.id))}>
                <span className="flex-1 min-w-0">
                  <span className="text-sm font-semibold text-navy-800 block">{q.title}</span>
                  <span className="text-[11px] text-navy-500">
                    {who !== 'to' && <>From <b>{q.raised_by_name}</b>{who === 'both' && q.raised_by_department ? ` (${q.raised_by_department})` : ''} · </>}
                    {who !== 'from' && <>To <b>{names(q.raised_to)}</b> · </>}
                    {when(q.last_at || q.created_at)}
                    {who === 'both' && (q.to_me ? ' · raised to you' : q.to_hr ? ' · raised to HR' : '')}
                  </span>
                </span>
                <span className={`chip ${cls} shrink-0`}>{label}</span>
              </button>
              {openId === q.id && <Thread id={q.id} reload={reload} />}
            </div>
          );
        })}
        {!rows.length && <p className="p-6 text-center text-sm text-navy-400">{empty}</p>}
      </div>
    </div>
  );
}

function Thread({ id, reload }) {
  const [t, setT] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const load = () => api(`/people/queries/${id}/messages`).then(setT).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  const act = async (path, payload) => {
    setBusy(true); setErr(null);
    try { await api(`/people/queries/${id}/${path}`, { method: 'POST', body: JSON.stringify(payload || {}) }); setBody(''); await load(); reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  if (err && !t) return <p className="text-xs text-rose-600 mt-2">{err}</p>;
  if (!t) return null;
  return (
    <div className="mt-3 space-y-2 text-sm border-l-2 border-navy-100 pl-3">
      {t.messages.map((m) => (
        <div key={m.id}>
          <p className="text-[11px] text-navy-400"><b className="text-navy-700">{m.author_name}</b> · {when(m.at)}</p>
          <p className="text-navy-700 whitespace-pre-wrap">{m.body}</p>
        </div>
      ))}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {t.may_reply ? (
        <div className="flex gap-2 items-start pt-1">
          <LongText className="inp" rows={2} placeholder="Reply…" value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex flex-col gap-1.5">
            <button className="btn-pri" disabled={busy || !body.trim()} onClick={() => act('reply', { body })}><Send size={13} className="inline mr-1" />Send</button>
            <button className="btn-sec" disabled={busy} onClick={() => act('close')}><CheckCircle2 size={13} className="inline mr-1" />Close</button>
          </div>
        </div>
      ) : <p className="text-[11px] text-navy-400">This query is closed.</p>}
    </div>
  );
}
