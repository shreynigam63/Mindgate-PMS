// The First-Week Journey — the client's "7 Days Onboarding Tracker"
// workbook as a screen. Asked for on 6 Oct, under New Hire Insights in
// both the HRBP and HR groups.
//
// The workbook's sheets, and where each one went:
//   Dashboard        -> the cards, "By owner" and "By day" at the top
//   Joiners          -> the joiner table
//   Tracker          -> one joiner's week, opened from the table
//   Feedback         -> the Day-7 card inside that week
//   Activity Matrix  -> "Activity matrix" (read here; the seed is the client's sheet)
//   Holidays         -> "Holidays" — weekends are skipped on their own
//
// Every date and status is computed by the server from the date of
// joining, the activity's working-day offset and the holiday list, the
// way the workbook's formulas did. Nothing on this screen is typed in
// twice: a joiner is picked from the employee master, so their manager,
// department and designation come from there.
import { useEffect, useState } from 'react';
import {
  Users, CalendarCheck, AlertTriangle, Star, Gauge, Plus, CalendarX, ListTree, X, Check, ChevronRight,
  ChevronDown, Trash2, Search, MessageSquareWarning, ArrowLeft, Mail, Send, Contact,
} from 'lucide-react';
import { api } from '../utils/api';

const STATUS_PILL = {
  Completed: 'pill-green', Overdue: 'pill-red', 'Due Today': 'pill-amber', Upcoming: 'pill-gray',
};
const DAY_HUE = ['#94a3b8', '#2563eb', '#7c4dde', '#0ea5a4', '#e7860d', '#ec4899', '#1f9d5c', '#d23a55'];
const fmtDate = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
const fmtDay = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—');
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const localToday = () => new Date().toLocaleDateString('en-CA');

function Kpi({ icon: Icon, hue, n, label, sub }) {
  return (
    <div className={`kpi kpi-${hue}`}>
      <span className="kpi-i"><Icon size={24} /></span>
      <span className="min-w-0">
        <span className="kpi-n">{n}</span>
        <span className="kpi-l">{label}</span>
        {sub && <span className="block text-[11px] text-navy-500 mt-0.5">{sub}</span>}
      </span>
    </div>
  );
}

function Bar({ pct, tone = 'bg-brand-500' }) {
  return (
    <div className="h-2 rounded-full bg-[#e8ecf3] overflow-hidden min-w-[60px]">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%` }} />
    </div>
  );
}

// Type-ahead over the employee master, for the joiner, buddy and HR POC.
function PersonPick({ placeholder, onPick, exclude }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined; }
    const t = setTimeout(() => api(`/people/onboarding/people?q=${encodeURIComponent(q.trim())}`)
      .then((r) => setHits(r.people || [])).catch(() => setHits([])), 220);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="relative">
      <label className="flex items-center gap-2 h-10 px-3 rounded-xl border border-navy-100 bg-white">
        <Search size={14} className="text-navy-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder}
          className="flex-1 min-w-0 text-[13px] outline-none bg-transparent" />
      </label>
      {hits.length > 0 && (
        <div className="topsearch-pop !top-[44px] max-h-64 overflow-y-auto">
          {hits.filter((h) => !exclude || !exclude(h)).map((h) => (
            <button key={h.id} type="button" onClick={() => { onPick(h); setQ(''); setHits([]); }}>
              <span className="ini !w-7 !h-7 !text-[11px]">{initials(h.name)}</span>
              <span className="flex-1 text-left">
                <span className="block font-semibold">{h.name}</span>
                <span className="block text-[11px] text-navy-400">{[h.designation, h.department].filter(Boolean).join(' · ')}</span>
              </span>
              {h.tracked && <span className="pill pill-gray">on tracker</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AddJoiner({ onDone, onClose }) {
  const [cands, setCands] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [doj, setDoj] = useState({});
  const load = () => api('/people/onboarding/candidates').then((r) => setCands(r.candidates || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const start = async (p) => {
    setErr(null); setBusy(p.employee_id || p.id);
    try {
      await api('/people/onboarding/joiners', { method: 'POST', body: JSON.stringify({
        employee_id: p.employee_id || p.id, doj: doj[p.employee_id || p.id] || undefined }) });
      await onDone();
      load();
    } catch (e) { setErr(e.message); }
    setBusy(null);
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <Plus size={18} className="text-brand-600" />
        <span className="panel-t">Start a joiner’s first week</span>
        <button type="button" className="ml-auto topicon !w-8 !h-8" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <p className="text-[12.5px] text-navy-500 mb-3">
        People in the employee master who joined in the last three weeks or join in the next six, and are not on the tracker yet.
        Starting creates all their activities, planned from the date of joining.
      </p>
      {err && <p className="text-[12.5px] text-rose-600 mb-2">{err}</p>}
      {!cands ? <p className="text-sm text-navy-400">Looking…</p> : cands.length === 0
        ? <p className="text-[13px] text-navy-500 mb-3">Nobody new in that window. Search below for anyone else.</p>
        : (
          <div className="divide-y divide-[#eef1f6] mb-3">
            {cands.map((c) => (
              <div key={c.employee_id} className="py-2 flex flex-wrap items-center gap-3">
                <span className="ini">{initials(c.name)}</span>
                <span className="flex-1 min-w-[180px]">
                  <span className="block text-[13.5px] font-semibold text-navy-900">{c.name}</span>
                  <span className="block text-[11.5px] text-navy-400">
                    {[c.designation, c.department, c.manager_name && `reports to ${c.manager_name}`].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <input type="date" className="inp !w-40 !py-1.5" value={doj[c.employee_id] || c.date_of_joining || ''}
                  onChange={(e) => setDoj({ ...doj, [c.employee_id]: e.target.value })} aria-label="Date of joining" />
                <button type="button" className="btn-pri" disabled={busy === c.employee_id} onClick={() => start(c)}>
                  {busy === c.employee_id ? 'Starting…' : 'Start tracker'}
                </button>
              </div>
            ))}
          </div>
        )}
      <PersonPick placeholder="Someone else — search the employee master by name or code"
        exclude={(h) => h.tracked}
        onPick={(h) => (h.date_of_joining ? start(h)
          : setErr(`${h.name} has no date of joining in the employee master. Set it on Employees, or pick them from the list above with a date.`))} />
    </div>
  );
}

function Holidays({ onClose, onChanged }) {
  const [list, setList] = useState(null);
  const [d, setD] = useState(''); const [n, setN] = useState('');
  const [err, setErr] = useState(null);
  const load = () => api('/people/onboarding/holidays').then((r) => setList(r.holidays)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const add = async () => {
    setErr(null);
    try { await api('/people/onboarding/holidays', { method: 'POST', body: JSON.stringify({ date: d, name: n }) }); setD(''); setN(''); load(); onChanged(); }
    catch (e) { setErr(e.message); }
  };
  const del = async (date) => {
    try { await api(`/people/onboarding/holidays/${date}`, { method: 'DELETE' }); load(); onChanged(); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <CalendarX size={18} className="text-rose-500" />
        <span className="panel-t">Holidays</span>
        <span className="text-[12px] text-navy-400">Weekends are skipped on their own. Every plan moves when this list changes.</span>
        <button type="button" className="ml-auto topicon !w-8 !h-8" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      {err && <p className="text-[12.5px] text-rose-600 mb-2">{err}</p>}
      <div className="flex flex-wrap gap-2 mb-3">
        <input type="date" className="inp !w-44" value={d} onChange={(e) => setD(e.target.value)} />
        <input className="inp !w-64" placeholder="Holiday name" value={n} onChange={(e) => setN(e.target.value)} />
        <button type="button" className="btn-pri" disabled={!d || !n.trim()} onClick={add}>Add holiday</button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(list || []).map((h) => (
          <span key={h.date} className="inline-flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-xl bg-[#f5f7fb] text-[12.5px]">
            <b className="text-navy-900">{fmtDay(h.date)}</b> {h.name}
            <button type="button" className="p-1 rounded-md hover:bg-rose-50 text-rose-500" onClick={() => del(h.date)} aria-label={`Remove ${h.name}`}><Trash2 size={13} /></button>
          </span>
        ))}
        {list && !list.length && <p className="text-[13px] text-navy-500">No holidays yet.</p>}
      </div>
    </div>
  );
}

// The company-wide SPOC desks a task email can go to. Manager and Buddy
// come from each joiner's record, so they are listed but not set here.
function Spocs({ onClose }) {
  const [list, setList] = useState(null);
  const [edit, setEdit] = useState({});
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);
  const load = () => api('/people/onboarding/spocs').then((r) => {
    setList(r.spocs);
    setEdit(Object.fromEntries(r.spocs.map((x) => [x.role, { name: x.name || '', email: x.email || '' }])));
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const save = async (role) => {
    setErr(null); setSaved(null);
    try { await api(`/people/onboarding/spocs/${encodeURIComponent(role)}`, { method: 'PUT', body: JSON.stringify(edit[role]) }); setSaved(role); load(); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <Contact size={18} className="text-brand-600" />
        <span className="panel-t">SPOCs</span>
        <span className="text-[12px] text-navy-400">Who each task's “Email SPOC” goes to</span>
        <button type="button" className="ml-auto topicon !w-8 !h-8" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      {err && <p className="text-[12.5px] text-rose-600 mb-2">{err}</p>}
      <div className="divide-y divide-[#eef1f6]">
        {(list || []).map((x) => (
          <div key={x.role} className="py-2 flex flex-wrap items-center gap-2">
            <span className="w-28 font-semibold text-[13px] text-navy-900">{x.role}</span>
            {x.per_joiner ? <span className="text-[12.5px] text-navy-500">{x.note}</span> : (
              <>
                <input className="inp !w-48 !py-1.5" placeholder="Name (optional)" value={(edit[x.role] || {}).name || ''}
                  onChange={(e) => setEdit({ ...edit, [x.role]: { ...edit[x.role], name: e.target.value } })} />
                <input className="inp !w-64 !py-1.5" placeholder="email@company.com" value={(edit[x.role] || {}).email || ''}
                  onChange={(e) => setEdit({ ...edit, [x.role]: { ...edit[x.role], email: e.target.value } })} />
                <button type="button" className="btn-sec" onClick={() => save(x.role)}>Save</button>
                {saved === x.role && <span className="text-[12px] text-leaf-600">Saved</span>}
                {x.note && <span className="basis-full text-[11.5px] text-navy-400 pl-[7.5rem]">{x.note}</span>}
                {!x.email && <span className="text-[11.5px] text-amber-700">not set — tasks for {x.role} cannot be emailed</span>}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Matrix({ days, onClose }) {
  const [acts, setActs] = useState(null);
  useEffect(() => { api('/people/onboarding/activities').then((r) => setActs(r.activities)).catch(() => setActs([])); }, []);
  return (
    <div className="panel">
      <div className="panel-h">
        <ListTree size={18} className="text-violet-600" />
        <span className="panel-t">Activity matrix</span>
        <span className="text-[12px] text-navy-400">{acts ? `${acts.length} activities` : ''} · the client’s sheet, planned by working-day offset from the date of joining</span>
        <button type="button" className="ml-auto topicon !w-8 !h-8" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>#</th><th>Day</th><th>Theme</th><th>Activity</th><th>Owner</th><th>What we do</th><th>Expected outcome</th><th>Ack</th></tr></thead>
          <tbody>
            {(acts || []).map((a) => (
              <tr key={a.id}>
                <td className="text-navy-400">{a.code}</td>
                <td><span className="pill pill-blue">{a.day}</span></td>
                <td className="text-navy-500">{a.theme}</td>
                <td className="font-semibold text-navy-900">{a.activity}{!a.mandatory && <span className="pill pill-gray ml-1.5">optional</span>}</td>
                <td className="text-navy-600">{a.owner}</td>
                <td className="!whitespace-normal min-w-[260px] text-navy-600">{a.process}</td>
                <td className="!whitespace-normal min-w-[200px] text-navy-500">{a.outcome}</td>
                <td>{a.ack_required ? 'Yes' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {days && days.length > 0 && <p className="text-[11.5px] text-navy-400 mt-3">Days run Pre-Day 1 (two working days before joining) to Day 7 (six working days after).</p>}
    </div>
  );
}

// EMAIL THE SPOC. Asked for on 6 Oct: "clicking on each option should
// initiate email to particular spoc working for that task". The server
// decides who it goes to (the joiner's manager or buddy from their
// record; the IT, Admin, Recruiter… desks from the SPOC list) and drafts
// the text; it is editable here before it goes. When this instance's mail
// is still in simulated mode the email is logged, not delivered, and the
// screen says so — with a button to send it from your own mail app.
function EmailSpoc({ taskId, onSent, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    api(`/people/onboarding/tasks/${taskId}/email`)
      .then((r) => { setD(r); setSubject(r.subject); setBody(r.body); })
      .catch((e) => setErr(e.message));
  }, [taskId]);
  if (err && !d) return <p className="text-[12px] text-rose-600 px-3 pb-3">{err}</p>;
  if (!d) return <p className="text-[12px] text-navy-400 px-3 pb-3">Preparing the email…</p>;
  const send = async () => {
    setErr(null); setBusy(true);
    try { const r = await api(`/people/onboarding/tasks/${taskId}/email`, { method: 'POST', body: JSON.stringify({ subject, body }) }); setDone(r); onSent(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const mailto = `mailto:${d.to.map((x) => x.email).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <div className="px-3 pb-3 pt-3 border-t border-[#eef1f6] space-y-2.5 bg-[#f8faff]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="lbl !mb-0">To</span>
        {d.to.map((x) => (
          <span key={x.email} className="pill pill-blue" title={x.email}>{x.role}: {x.name || x.email} &lt;{x.email}&gt;</span>
        ))}
        {!d.to.length && <span className="text-[12px] text-navy-500">Nobody yet —</span>}
        <button type="button" className="ml-auto topicon !w-7 !h-7" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      {d.missing.map((m) => (
        <p key={m.role} className="text-[12px] text-amber-700">{m.role}: {m.why}</p>
      ))}
      {d.mail_mode !== 'live' && (
        <p className="text-[12px] text-amber-700">
          Email on this instance is in <b>simulated</b> mode — sending records it on the tracker but does not deliver it.
          Use <b>Open in my mail app</b> to send it yourself, or ask the administrator to turn live email on for this instance.
        </p>
      )}
      <input className="inp" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
      <textarea className="inp" rows={9} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-pri" disabled={busy || !d.to.length} onClick={send}>
          <Send size={12} className="inline mr-1" />{busy ? 'Sending…' : `Send to ${d.to.length || 'nobody'}`}
        </button>
        {!!d.to.length && <a className="btn-sec" href={mailto}><Mail size={12} className="inline mr-1" />Open in my mail app</a>}
        {done && (
          <span className={`text-[12px] ${done.outcome === 'sent' ? 'text-leaf-600' : 'text-amber-700'}`}>
            {done.outcome === 'sent' ? `Sent to ${done.to.join(', ')}.`
              : done.outcome === 'simulated' ? `Recorded for ${done.to.join(', ')} — not delivered (simulated mail).`
                : `Not delivered: ${done.outcome}. Try "Open in my mail app".`}
          </span>
        )}
        {err && <span className="text-[12px] text-rose-600">{err}</span>}
      </div>
      {!!(d.history || []).length && (
        <div className="text-[11.5px] text-navy-500 space-y-0.5">
          <p className="lbl !mb-0">Emailed before</p>
          {d.history.map((h, i) => (
            <p key={i}>{new Date(h.sent_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {' '}by {h.sent_by} to {h.to_emails.join(', ')} · {h.outcome}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// One task row, with its follow-up fields folded underneath.
function TaskRow({ t, onSaved, asOf }) {
  const [open, setOpen] = useState(false);
  const [mail, setMail] = useState(false);
  const [f, setF] = useState({
    completed_on: t.completed_on || '', ack_received: t.ack_received, remarks: t.remarks || '',
    issue: t.issue || '', action_owner: t.action_owner || '', closure_date: t.closure_date || '',
  });
  const [err, setErr] = useState(null);
  const save = async (patch) => {
    setErr(null);
    try { await api(`/people/onboarding/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await onSaved(); }
    catch (e) { setErr(e.message); }
  };
  const done = t.status === 'Completed';
  return (
    <div className={`rounded-xl border ${t.status === 'Overdue' ? 'border-rose-100 bg-rose-50/30' : 'border-[#eef1f6] bg-white'}`}>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
        <button type="button" aria-label={done ? 'Mark not done' : 'Mark done'}
          onClick={() => save({ completed_on: done ? null : localToday() })}
          className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${done ? 'bg-[#22a35a] border-[#22a35a] text-white' : 'border-navy-200 hover:border-brand-500'}`}>
          {done && <Check size={14} strokeWidth={3} />}
        </button>
        <span className="flex-1 min-w-[200px]">
          <span className={`block text-[13.5px] font-semibold ${done ? 'text-navy-500 line-through decoration-navy-300' : 'text-navy-900'}`}>
            {t.activity}{!t.mandatory && <span className="pill pill-gray ml-1.5 !no-underline">optional</span>}
          </span>
          <span className="block text-[11.5px] text-navy-400">{t.process}</span>
        </span>
        <button type="button" className="pill pill-blue hover:bg-brand-100" onClick={() => setMail((v) => !v)}
          title={`Email ${(t.spoc_roles || []).join(', ') || 'the SPOC'} about this task`}>
          <Mail size={11} className="mr-1" />{t.owner}
        </button>
        <span className="text-[12px] text-navy-500 w-24">{fmtDay(t.planned_date)}</span>
        <span className={`pill ${STATUS_PILL[t.status]}`}>
          {t.status}{t.status === 'Overdue' && t.days_overdue ? ` · ${t.days_overdue}d` : ''}{done && t.completed_on ? ` · ${fmtDate(t.completed_on)}` : ''}
        </span>
        {t.ack_required && (
          <button type="button" onClick={() => save({ ack_received: !t.ack_received })}
            className={`pill ${t.ack_received ? 'pill-green' : 'pill-amber'}`} title="Acknowledgement required for this activity">
            Ack {t.ack_received ? 'received' : 'pending'}
          </button>
        )}
        {t.issue && !t.closure_date && <MessageSquareWarning size={16} className="text-rose-500" title={t.issue} />}
        {t.last_emailed_at && (
          <span className="text-[11px] text-navy-400" title={(t.last_emailed_to || []).join(', ')}>
            emailed {new Date(t.last_emailed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          </span>
        )}
        <button type="button" className="btn-sec !px-2.5 !py-1.5" onClick={() => setMail((v) => !v)} aria-expanded={mail}>
          <Mail size={12} className="inline mr-1" />Email SPOC
        </button>
        <button type="button" className="topicon !w-8 !h-8" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Details">
          <ChevronDown size={16} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-2.5 border-t border-[#eef1f6] pt-3">
          <label><span className="lbl">Completion date</span>
            <input type="date" className="inp" max={asOf > localToday() ? localToday() : undefined} value={f.completed_on} onChange={(e) => setF({ ...f, completed_on: e.target.value })} /></label>
          <label className="lg:col-span-2"><span className="lbl">Employee feedback / remarks</span>
            <input className="inp" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></label>
          <label><span className="lbl">Issue identified</span>
            <input className="inp" value={f.issue} onChange={(e) => setF({ ...f, issue: e.target.value })} /></label>
          <label><span className="lbl">Action owner</span>
            <input className="inp" value={f.action_owner} onChange={(e) => setF({ ...f, action_owner: e.target.value })} /></label>
          <label><span className="lbl">Closure date</span>
            <input type="date" className="inp" value={f.closure_date} onChange={(e) => setF({ ...f, closure_date: e.target.value })} /></label>
          <div className="sm:col-span-2 lg:col-span-3 flex items-center gap-2">
            <button type="button" className="btn-pri" onClick={() => save(f)}>Save</button>
            {t.updated_by && <span className="text-[11px] text-navy-400">Last saved by {t.updated_by}</span>}
            {err && <span className="text-[12px] text-rose-600">{err}</span>}
          </div>
          <p className="sm:col-span-2 lg:col-span-3 text-[11.5px] text-navy-400">Expected outcome: {t.outcome}</p>
        </div>
      )}
      {mail && <EmailSpoc taskId={t.id} onSent={onSaved} onClose={() => setMail(false)} />}
      {err && !open && <p className="px-3 pb-2 text-[12px] text-rose-600">{err}</p>}
    </div>
  );
}

function Feedback({ joiner, questions, onSaved }) {
  const fb = joiner.feedback;
  const [r, setR] = useState(fb ? fb.ratings : {});
  const [t, setT] = useState({ worked_best: fb?.worked_best || '', improve: fb?.improve || '', open_issue: fb?.open_issue || '' });
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);
  const save = async () => {
    setErr(null); setOk(false);
    try {
      await api(`/people/onboarding/joiners/${joiner.id}/feedback`, { method: 'PUT', body: JSON.stringify({ ratings: r, ...t }) });
      setOk(true); await onSaved();
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="panel">
      <div className="panel-h">
        <Star size={18} className="text-amber-500" />
        <span className="panel-t">Day-7 feedback</span>
        <span className="text-[12px] text-navy-400">1 = strongly disagree · 5 = strongly agree</span>
        {fb && fb.average != null && <span className="ml-auto pill pill-green">Average {fb.average.toFixed(2)} / 5</span>}
      </div>
      <div className="space-y-2">
        {questions.map((q) => (
          <div key={q.code} className="flex flex-wrap items-center gap-3">
            <span className="flex-1 min-w-[240px] text-[13px] text-navy-800"><b className="text-navy-400 mr-1.5">{q.code}</b>{q.statement}</span>
            <span className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setR({ ...r, [q.code]: n })}
                  className={`w-8 h-8 rounded-lg text-[13px] font-bold ${r[q.code] === n
                    ? (n <= 2 ? 'bg-rose-500 text-white' : n === 3 ? 'bg-amber-400 text-white' : 'bg-[#22a35a] text-white')
                    : 'bg-[#f1f4f9] text-navy-600 hover:bg-navy-100'}`}>{n}</button>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="grid md:grid-cols-3 gap-2.5 mt-3">
        <label><span className="lbl">What worked best?</span><input className="inp" value={t.worked_best} onChange={(e) => setT({ ...t, worked_best: e.target.value })} /></label>
        <label><span className="lbl">What should we improve?</span><input className="inp" value={t.improve} onChange={(e) => setT({ ...t, improve: e.target.value })} /></label>
        <label><span className="lbl">Any issue still open?</span><input className="inp" value={t.open_issue} onChange={(e) => setT({ ...t, open_issue: e.target.value })} /></label>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <button type="button" className="btn-pri" onClick={save}>Save feedback</button>
        {ok && <span className="text-[12px] text-leaf-600">Saved.</span>}
        {err && <span className="text-[12px] text-rose-600">{err}</span>}
        {fb && <span className="text-[11px] text-navy-400 ml-auto">Recorded by {fb.recorded_by}</span>}
      </div>
    </div>
  );
}

function JoinerWeek({ id, asOf, days, onBack, onChanged }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api(`/people/onboarding/joiners/${id}?asOf=${asOf}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id, asOf]);
  const refresh = async () => { await load(); onChanged(); };
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Opening…</p>;
  const j = d.joiner;
  const setPerson = async (k, p) => {
    try { await api(`/people/onboarding/joiners/${j.id}`, { method: 'PATCH', body: JSON.stringify({ [k]: p ? p.id : null }) }); refresh(); }
    catch (e) { setErr(e.message); }
  };
  const remove = async () => {
    if (!window.confirm(`Take ${j.name} off the tracker? Their ${j.total} activities and any feedback are deleted.`)) return;
    try { await api(`/people/onboarding/joiners/${j.id}`, { method: 'DELETE' }); onChanged(); onBack(); }
    catch (e) { setErr(e.message); }
  };
  const byDay = days.map((day, i) => ({ ...day, i, tasks: j.tasks.filter((t) => t.day === day.day) })).filter((x) => x.tasks.length);
  const completeDay = async (tasks) => {
    const open = tasks.filter((t) => !t.completed_on && t.planned_date <= localToday()).map((t) => t.id);
    if (!open.length) return;
    try { await api(`/people/onboarding/joiners/${j.id}/complete`, { method: 'POST', body: JSON.stringify({ task_ids: open }) }); refresh(); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="space-y-4">
      <button type="button" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-600" onClick={onBack}>
        <ArrowLeft size={15} /> All joiners
      </button>
      <div className="panel">
        <div className="flex flex-wrap items-start gap-4">
          <span className="ini !w-14 !h-14 !text-[18px]">{initials(j.name)}</span>
          <div className="flex-1 min-w-[220px]">
            <p className="text-[20px] font-bold text-navy-900 leading-tight">{j.name}</p>
            <p className="text-[13px] text-navy-500">{[j.designation, j.department, j.location].filter(Boolean).join(' · ')}</p>
            <p className="text-[12.5px] text-navy-500 mt-1">
              Joined <b className="text-navy-800">{fmtDay(j.doj)}</b> · Day 7 is <b className="text-navy-800">{fmtDay(j.day7_date)}</b>
              {j.manager_name && <> · reports to <b className="text-navy-800">{j.manager_name}</b></>}
            </p>
          </div>
          <div className="text-right">
            <span className={`pill ${j.status === 'Completed' ? 'pill-green' : j.overdue ? 'pill-red' : 'pill-blue'}`}>{j.status}</span>
            <p className="text-[28px] font-extrabold text-navy-900 leading-none mt-2">{Math.round(j.pct)}%</p>
            <p className="text-[12px] text-navy-500">{j.completed} of {j.total} done · {j.current_day}</p>
          </div>
        </div>
        <div className="mt-3"><Bar pct={j.pct} tone={j.overdue ? 'bg-amber-400' : 'bg-[#22a35a]'} /></div>
        <div className="grid md:grid-cols-2 gap-3 mt-4">
          {[['buddy_id', 'Buddy', j.buddy_name], ['hr_poc_id', 'HR POC', j.hr_poc_name]].map(([k, label, cur]) => (
            <div key={k}>
              <span className="lbl">{label}</span>
              {cur ? (
                <span className="inline-flex items-center gap-2 h-10 px-3 rounded-xl bg-[#f5f7fb] text-[13px] font-semibold text-navy-800">
                  {cur}
                  <button type="button" className="text-navy-400 hover:text-rose-500" onClick={() => setPerson(k, null)} aria-label={`Clear ${label}`}><X size={14} /></button>
                </span>
              ) : <PersonPick placeholder={`Choose a ${label.toLowerCase()}`} onPick={(p) => setPerson(k, p)} exclude={(p) => p.id === j.employee_id} />}
            </div>
          ))}
        </div>
      </div>

      {byDay.map((x) => {
        const done = x.tasks.filter((t) => t.status === 'Completed').length;
        const late = x.tasks.filter((t) => t.status === 'Overdue').length;
        return (
          <div key={x.day} className="panel">
            <div className="panel-h flex-wrap">
              <span className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-[12px] font-extrabold shrink-0"
                style={{ background: DAY_HUE[x.i % DAY_HUE.length] }}>{x.day === 'Pre-Day 1' ? 'Pre' : x.day.replace('Day ', 'D')}</span>
              <span>
                <span className="block panel-t leading-tight">{x.day} · {x.theme}</span>
                <span className="block text-[12.5px] italic text-navy-500">“{x.question}”</span>
              </span>
              <span className="ml-auto flex items-center gap-2">
                {late > 0 && <span className="pill pill-red">{late} overdue</span>}
                <span className="pill pill-gray">{done}/{x.tasks.length} done</span>
                {done < x.tasks.length && (
                  <button type="button" className="btn-sec" onClick={() => completeDay(x.tasks)}
                    title="Marks every activity planned for today or earlier as done today">Mark due ones done</button>
                )}
              </span>
            </div>
            <div className="space-y-1.5">
              {x.tasks.map((t) => <TaskRow key={`${t.id}-${t.updated_at || ''}`} t={t} asOf={asOf} onSaved={refresh} />)}
            </div>
          </div>
        );
      })}

      <Feedback key={j.feedback ? j.feedback.recorded_at : 'none'} joiner={j} questions={d.questions} onSaved={refresh} />

      <div className="flex justify-end">
        <button type="button" className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-rose-600" onClick={remove}>
          <Trash2 size={14} /> Take {j.name} off the tracker
        </button>
      </div>
    </div>
  );
}

export default function OnboardingTracker() {
  const [asOf, setAsOf] = useState(localToday());
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [panel, setPanel] = useState(null);
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('active');
  const load = () => api(`/people/onboarding?asOf=${asOf}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [asOf]);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading the tracker…</p>;
  if (open) return <JoinerWeek id={open} asOf={asOf} days={d.days} onBack={() => setOpen(null)} onChanged={load} />;

  const k = d.kpis;
  const joiners = d.joiners.filter((j) => (filter === 'all' ? true : filter === 'late' ? j.overdue > 0 : j.status !== 'Completed'));
  const maxOwner = Math.max(1, ...d.by_owner.map((o) => o.total));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] text-navy-500 flex-1 min-w-[260px]">
          Every activity of a joiner’s first week — who owns it, when it is due, and whether it happened. Dates skip weekends and holidays.
        </p>
        <label className="flex items-center gap-2 text-[12.5px] text-navy-600">Report date
          <input type="date" className="inp !w-40 !py-1.5" value={asOf} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></label>
        <button type="button" className="btn-sec" onClick={() => setPanel(panel === 'matrix' ? null : 'matrix')}><ListTree size={13} className="inline mr-1" />Activity matrix</button>
        <button type="button" className="btn-sec" onClick={() => setPanel(panel === 'spocs' ? null : 'spocs')}><Contact size={13} className="inline mr-1" />SPOCs</button>
        <button type="button" className="btn-sec" onClick={() => setPanel(panel === 'holidays' ? null : 'holidays')}><CalendarX size={13} className="inline mr-1" />Holidays</button>
        <button type="button" className="btn-pri" onClick={() => setPanel(panel === 'add' ? null : 'add')}><Plus size={13} className="inline mr-1" />Add joiner</button>
      </div>

      {panel === 'add' && <AddJoiner onDone={load} onClose={() => setPanel(null)} />}
      {panel === 'holidays' && <Holidays onClose={() => setPanel(null)} onChanged={load} />}
      {panel === 'spocs' && <Spocs onClose={() => setPanel(null)} />}
      {panel === 'matrix' && <Matrix days={d.days} onClose={() => setPanel(null)} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <Kpi icon={Users} hue="blue" n={k.in_onboarding} label="Joiners in onboarding" sub={k.completed_joiners ? `${k.completed_joiners} completed` : null} />
        <Kpi icon={CalendarCheck} hue="amber" n={k.due_today} label="Activities due today" />
        <Kpi icon={AlertTriangle} hue="red" n={k.overdue} label="Overdue activities" sub={k.open_issues ? `${k.open_issues} open issues` : null} />
        <Kpi icon={Star} hue="violet" n={k.feedback_avg != null ? k.feedback_avg.toFixed(2) : '—'} label="Avg. Day-7 feedback (of 5)"
          sub={k.feedback_count ? `${k.feedback_count} joiner${k.feedback_count === 1 ? '' : 's'} rated` : 'none recorded yet'} />
        <Kpi icon={Gauge} hue="green" n={k.completion_pct != null ? `${Math.round(k.completion_pct)}%` : '—'} label="Overall completion" />
      </div>

      {d.joiners.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-[0.9fr_1.1fr] gap-4">
          <div className="panel">
            <div className="panel-h"><span className="panel-t">By owner</span>
              <span className="text-[12px] text-navy-400">a shared activity counts for each owner named</span></div>
            <table className="tbl">
              <thead><tr><th>Owner</th><th className="text-right">Overdue</th><th className="text-right">Due today</th><th className="text-right">Done</th><th className="w-1/3">Load</th></tr></thead>
              <tbody>
                {d.by_owner.map((o) => (
                  <tr key={o.owner}>
                    <td className="font-semibold text-navy-900">{o.owner}</td>
                    <td className="text-right">{o.overdue ? <span className="pill pill-red">{o.overdue}</span> : <span className="text-navy-300">0</span>}</td>
                    <td className="text-right">{o.due_today ? <span className="pill pill-amber">{o.due_today}</span> : <span className="text-navy-300">0</span>}</td>
                    <td className="text-right text-navy-600">{o.completed}</td>
                    <td>
                      <div className="h-2 rounded-full bg-[#e8ecf3] overflow-hidden flex" style={{ width: `${(o.total / maxOwner) * 100}%` }}>
                        <span className="bg-[#22a35a]" style={{ width: `${(o.completed / o.total) * 100}%` }} />
                        <span className="bg-rose-400" style={{ width: `${(o.overdue / o.total) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <div className="panel-h"><span className="panel-t">By day of the journey</span></div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {d.by_day.map((x, i) => {
                const meta = d.days.find((y) => y.day === x.day) || {};
                return (
                  <div key={x.day} className="rounded-xl p-3 bg-[#f7f9fd] border border-[#eef1f6]" title={meta.question}>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: DAY_HUE[i % DAY_HUE.length] }} />
                      <span className="text-[13px] font-bold text-navy-900">{x.day}</span>
                      {x.overdue > 0 && <span className="pill pill-red !px-1.5 !py-0 ml-auto">{x.overdue}</span>}
                    </div>
                    <p className="text-[11px] text-navy-400 truncate mt-0.5">{meta.theme}</p>
                    <p className="text-[20px] font-extrabold text-navy-900 mt-1.5">{x.pct == null ? '—' : `${Math.round(x.pct)}%`}</p>
                    <Bar pct={x.pct} tone="bg-brand-500" />
                    <p className="text-[11px] text-navy-500 mt-1">{x.completed} of {x.total} done</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="panel !p-0">
        <div className="flex flex-wrap items-end gap-x-6 px-5 pt-4">
          <span className="text-[17px] font-bold text-navy-900 pb-2.5">New joiners</span>
          <div className="tabbar flex-1 border-b-0">
            {[['active', 'In onboarding'], ['late', 'With overdue'], ['all', 'All']].map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? 'on' : ''} onClick={() => setFilter(key)}>{label}</button>
            ))}
          </div>
        </div>
        <div className="border-t border-navy-100" />
        <div className="px-5 py-4 overflow-x-auto">
          {d.joiners.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-[15px] font-semibold text-navy-800">No joiner is on the tracker yet.</p>
              <p className="text-[13px] text-navy-500 mt-1">Use <b>Add joiner</b> — recent and upcoming joiners from the employee master are listed there, ready to start.</p>
            </div>
          ) : joiners.length === 0 ? <p className="text-[13px] text-navy-500 py-4">Nobody in this view.</p> : (
            <table className="tbl">
              <thead><tr>
                <th>Employee</th><th>Department</th><th>Joined</th><th>Manager</th><th>Buddy</th><th>Where</th>
                <th className="min-w-[140px]">Progress</th><th className="text-right">Overdue</th><th>Status</th><th>Feedback</th><th />
              </tr></thead>
              <tbody>
                {joiners.map((j) => (
                  <tr key={j.id} className="cursor-pointer hover:bg-[#f9fafe]" onClick={() => setOpen(j.id)}>
                    <td><span className="flex items-center gap-2.5"><span className="ini">{initials(j.name)}</span>
                      <span><span className="block font-semibold text-navy-900">{j.name}</span>
                        <span className="block text-[11.5px] text-navy-400">{j.designation}</span></span></span></td>
                    <td className="text-navy-500">{j.department || '—'}</td>
                    <td className="text-navy-600">{fmtDate(j.doj)}</td>
                    <td className="text-navy-600">{j.manager_name || '—'}</td>
                    <td className="text-navy-600">{j.buddy_name || <span className="pill pill-amber">not set</span>}</td>
                    <td><span className="pill pill-blue">{j.current_day}</span></td>
                    <td><span className="flex items-center gap-2"><Bar pct={j.pct} tone={j.overdue ? 'bg-amber-400' : 'bg-[#22a35a]'} />
                      <span className="text-[12px] text-navy-600 w-9 text-right">{Math.round(j.pct)}%</span></span></td>
                    <td className="text-right">{j.overdue ? <span className="pill pill-red">{j.overdue}</span> : <span className="text-navy-300">0</span>}</td>
                    <td><span className={`pill ${j.status === 'Completed' ? 'pill-green' : j.overdue ? 'pill-red' : 'pill-blue'}`}>{j.status}</span></td>
                    <td>{j.feedback_avg != null ? <span className="pill pill-green">{j.feedback_avg.toFixed(1)} / 5</span> : <span className="text-navy-400 text-[12px]">Pending</span>}</td>
                    <td><ChevronRight size={16} className="text-navy-400" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
