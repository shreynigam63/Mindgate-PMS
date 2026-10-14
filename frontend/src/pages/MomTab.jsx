// The MoM tab of the Connects page ("MoM Tab – PMS Build Specification",
// 14 Oct). Today's daily connect with its Google Meet link and Record, the
// list of MoMs, the action items, the team's settings and HR's daily
// report. A MoM opens on its own view (?mom=<id>): the recording and the
// Google Meet transcript, the editor while it is a draft (the AI's draft
// when a transcript was uploaded), read-only once published, with its
// versions and who has acknowledged it. The server is
// server/modules/performance/mom.js; the recorder is momRecorder.js.
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Video, ArrowLeft, Plus, Trash2, CheckCircle2, AlertTriangle, History, RotateCcw, Mic, Square, Download, Play, Sparkles, FileText } from 'lucide-react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import * as recorder from './momRecorder';

const STATUS = {
  scheduled: ['Scheduled', 'bg-navy-50 text-navy-600'],
  processing: ['Processing', 'bg-blue-100 text-blue-700'],
  draft_ready: ['Draft ready', 'bg-amber-100 text-amber-700'],
  published: ['Published', 'bg-emerald-100 text-emerald-700'],
  missing: ['Missing', 'bg-rose-100 text-rose-700'],
  cancelled: ['Not held', 'bg-navy-100 text-navy-500'],
};
const SECTION_LABEL = {
  summary: 'Summary', discussion: 'Discussion points', decisions: 'Decisions', blockers: 'Blockers',
  attendance: 'Attendance', times: 'Times', action_items: 'Action items',
};
const PRIORITY = { low: 'bg-navy-50 text-navy-600', medium: 'bg-amber-100 text-amber-700', high: 'bg-rose-100 text-rose-700' };
const when = (x) => (x ? new Date(x).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function MomStatus({ status, momStatus, version }) {
  if (!status) return <span className="chip bg-navy-50 text-navy-400">No connect</span>;
  const [label, cls] = status === 'scheduled' && momStatus === 'draft'
    ? ['Draft saved', 'bg-amber-100 text-amber-700'] : (STATUS[status] || [status, 'bg-navy-50 text-navy-600']);
  return <span className={`chip ${cls}`}>{label}{status === 'published' && version > 1 ? ` · v${version}` : ''}</span>;
}

const Loading = () => <p className="text-sm text-navy-400">Loading…</p>;
const Failed = ({ msg }) => <p className="text-sm text-rose-600">{msg}</p>;
const Empty = ({ children }) => <div className="card p-8 text-center text-sm text-navy-400">{children}</div>;
const clock = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(t / 3600) ? `${Math.floor(t / 3600)}:` : ''}${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
const listNames = (xs) => xs.map((x) => x.name).join(', ');

function useRecorder() {
  const [st, setSt] = useState(recorder.current());
  useEffect(() => recorder.subscribe(setSt), []);
  return st;
}
function useTick(on) {
  const [, setN] = useState(0);
  useEffect(() => { if (!on) return undefined; const h = setInterval(() => setN((n) => n + 1), 1000); return () => clearInterval(h); }, [on]);
}

export default function MomTab({ tabs, title = 'Connects', hue = 'azure' }) {
  const [params, setParams] = useSearchParams();
  const [ctx, setCtx] = useState(null);
  const loadCtx = () => api('/pms/mom/teams')
    .then((r) => setCtx({ can_manage: r.can_manage, hr: r.hr, me: r.me, teams: r.teams }))
    .catch(() => setCtx({ can_manage: false, hr: false, me: null, teams: [] }));
  useEffect(() => { loadCtx(); }, []);

  const set = (patch) => {
    const p = new URLSearchParams(params);
    p.set('tab', 'mom');
    for (const [k, v] of Object.entries(patch)) { if (v == null) p.delete(k); else p.set(k, v); }
    setParams(p);
  };
  const views = [['today', 'Today'], ['moms', 'MoMs'], ['actions', 'Action items'],
    ...(ctx && ctx.can_manage ? [['settings', 'Team settings']] : []), ...(ctx && ctx.hr ? [['report', 'Report']] : [])];
  const want = params.get('sub');
  const sub = !ctx ? (want || 'today') : (views.some(([k]) => k === want) ? want : 'today');
  const momId = params.get('mom');
  const open = (id) => set({ mom: id });

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title={title} hue={hue} sub="Daily connects, their minutes and action items" />
      {tabs}
      <RecorderBar open={open} />
      <ConsentBanner />
      {momId ? <MomView id={momId} onBack={() => set({ mom: null })} /> : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {views.map(([k, label]) => (
              <button key={k} type="button" onClick={() => set({ sub: k === 'today' ? null : k })}
                className={sub === k ? 'btn bg-navy-700 text-white' : 'btn-sec'}>{label}</button>
            ))}
          </div>
          {sub === 'today' && <Today ctx={ctx} open={open} goSettings={() => set({ sub: 'settings' })} />}
          {sub === 'moms' && <MomList open={open} />}
          {sub === 'actions' && <ActionItems ctx={ctx} open={open} />}
          {sub === 'settings' && ctx && <TeamSettings ctx={ctx} onSaved={loadCtx} />}
          {sub === 'report' && <Report open={open} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Today

function Today({ ctx, open, goSettings }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/mom/today').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <Failed msg={err} />;
  if (!d) return <Loading />;
  const own = ctx && ctx.teams.find((t) => t.manager_id === ctx.me);
  return (
    <div className="space-y-3">
      {own && !own.meet_link && (
        <div className="card p-3 text-sm flex flex-wrap items-center gap-2 border-amber-200 bg-amber-50/70">
          <AlertTriangle size={14} className="text-amber-600" />
          <span className="flex-1">Your team has no Google Meet link yet. Daily connects start once it is saved and HR switches them on.</span>
          <button type="button" className="btn-sec" onClick={goSettings}>Team settings</button>
        </div>
      )}
      {own && own.meet_link && !own.enabled && (
        <p className="text-xs text-navy-400">Daily connects for your team are off. HR switches them on.</p>
      )}
      {!d.meetings.length && <Empty>No connect for you today.</Empty>}
      {d.meetings.map((m) => (
        <div key={m.id} className="card p-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[12rem]">
            <div className="text-sm font-semibold text-navy-800">{m.title}</div>
            <div className="text-xs text-navy-400">{m.start_time}{m.end_time ? `–${m.end_time}` : ''} · Organiser {m.organiser_name || '—'}</div>
          </div>
          {m.recorded && <span className="chip bg-rose-50 text-rose-700">Recorded</span>}
          {m.draft_error && <span className="chip bg-rose-100 text-rose-700">AI draft failed</span>}
          <MomStatus status={m.status} momStatus={m.mom_status} version={m.version} />
          {m.meet_link && m.status === 'scheduled' && (
            <a className="btn-pri" href={m.meet_link} target="_blank" rel="noreferrer"><Video size={13} className="inline mr-1" />Join Google Meet</a>
          )}
          <button type="button" className="btn-sec" onClick={() => open(m.id)}>
            {m.can_edit && m.mom_status !== 'published' && m.status !== 'cancelled' ? 'Write MoM' : 'Open MoM'}
          </button>
          {m.can_edit && ['scheduled', 'missing', 'draft_ready'].includes(m.status) && (
            <div className="w-full"><RecordControl meeting={m} recorded={m.recorded} missing={m.consent_missing || []} onDone={load} /></div>
          )}
        </div>
      ))}
      <NoticeLine />
    </div>
  );
}

// ---------------------------------------------------------------- recording

// Record / Stop for one connect. Record stays off until everyone on the
// call has accepted the recording notice.
function RecordControl({ meeting, recorded, missing, onDone }) {
  const rs = useRecorder();
  const mine = rs.meetingId === meeting.id;
  const [err, setErr] = useState(null);
  const last = useRef(rs.phase);
  useEffect(() => { if (mine && last.current !== 'done' && rs.phase === 'done' && onDone) onDone(); last.current = rs.phase; }, [rs.phase]);
  useTick(mine && rs.phase === 'recording');
  if (missing.length) {
    return <p className="text-xs text-amber-700">Record is off for this connect: {listNames(missing)} {missing.length === 1 ? 'has' : 'have'} not accepted the recording notice. They accept it in the MoM tab; until then, write the MoM by hand.</p>;
  }
  if (!recorder.canRecord()) return <p className="text-xs text-navy-400">Recording needs Chrome or Edge on a laptop or desktop.</p>;
  if (mine && rs.phase === 'recording') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip bg-rose-600 text-white animate-pulse">● REC {clock(Date.now() - rs.startedAt)}</span>
        <button type="button" className="btn bg-rose-600 text-white hover:bg-rose-700" onClick={recorder.stop}><Square size={12} className="inline mr-1" />Stop</button>
        <span className="text-[11px] text-navy-400">{rs.sent} of {rs.total} pieces sent. You can switch tabs; closing this tab stops the recording.</span>
      </div>
    );
  }
  if (mine && rs.phase === 'saving') return <p className="text-xs text-navy-500">Saving the recording…</p>;
  if (mine && rs.phase === 'starting') return <p className="text-xs text-navy-500">Pick the Google Meet tab and tick “Share tab audio”…</p>;
  if (session(rs) && !mine) return <p className="text-xs text-navy-400">Another connect is being recorded.</p>;
  const go = async () => {
    setErr(null);
    let replace = false;
    if (recorded) {
      if (!window.confirm('This connect already has a recording. Recording again replaces it. Continue?')) return;
      replace = true;
    }
    try { await recorder.start(meeting, { replace }); } catch (e) {
      if (e.data && e.data.needs_replace && window.confirm('This connect already has a recording. Recording again replaces it. Continue?')) {
        try { await recorder.start(meeting, { replace: true }); } catch (e2) { setErr(e2.message); }
      } else setErr(e.message);
    }
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn bg-rose-600 text-white hover:bg-rose-700" onClick={go}><Mic size={13} className="inline mr-1" />{recorded ? 'Record again' : 'Record'}</button>
        <span className="text-[11px] text-navy-400">Join the call first. Tell everyone it is being recorded. When the browser asks, pick the Google Meet tab and tick “Share tab audio”.</span>
      </div>
      {(err || (mine && rs.error)) && <p className="text-xs text-rose-600">{err || rs.error}</p>}
    </div>
  );
}
const session = (rs) => ['starting', 'recording', 'saving'].includes(rs.phase);

// Across the tab: the running recording, and any recording this browser
// kept because it never reached the PMS whole.
function RecorderBar({ open }) {
  const rs = useRecorder();
  const [kept, setKept] = useState([]);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const loadKept = () => recorder.unsent().then(setKept).catch(() => setKept([]));
  useEffect(() => { loadKept(); }, [rs.phase]);
  useTick(rs.phase === 'recording');
  const act = async (fn, id) => { setBusy(id); setErr(null); try { await fn(id); await loadKept(); } catch (e) { setErr(e.message); } finally { setBusy(null); } };
  return (
    <>
      {rs.phase === 'recording' && (
        <div className="card p-3 flex flex-wrap items-center gap-2 border-rose-200 bg-rose-50/80">
          <span className="chip bg-rose-600 text-white animate-pulse">● REC {clock(Date.now() - rs.startedAt)}</span>
          <button type="button" className="text-sm font-semibold text-navy-800 underline" onClick={() => open(rs.meetingId)}>{rs.title}</button>
          <span className="text-xs text-navy-500 flex-1">{rs.sent} of {rs.total} pieces sent</span>
          <button type="button" className="btn bg-rose-600 text-white hover:bg-rose-700" onClick={recorder.stop}><Square size={12} className="inline mr-1" />Stop</button>
        </div>
      )}
      {rs.phase === 'done' && rs.meetingId && <p className="text-xs text-emerald-700">The recording of {rs.title} is saved in the PMS.</p>}
      {kept.map((k) => (
        <div key={k.meetingId} className="card p-3 flex flex-wrap items-center gap-2 border-amber-200 bg-amber-50/70">
          <AlertTriangle size={14} className="text-amber-600" />
          <span className="text-sm flex-1 min-w-[12rem]">The recording of <b>{k.title}</b> did not reach the PMS whole. It is kept in this browser ({Math.round(k.bytes / 1024)} KB).
            {rs.phase === 'unsent' && rs.meetingId === k.meetingId && rs.error ? ` ${rs.error}` : ''}</span>
          <button type="button" className="btn-pri" disabled={!!busy} onClick={() => act(recorder.resend, k.meetingId)}>{busy === k.meetingId ? 'Sending…' : 'Send again'}</button>
          <button type="button" className="btn-sec" disabled={!!busy} onClick={() => recorder.saveToLaptop(k.meetingId)}><Download size={13} className="inline mr-1" />Save to laptop</button>
          <button type="button" className="text-xs text-navy-500 underline" disabled={!!busy} onClick={() => window.confirm('Discard this recording from the browser?') && act(recorder.discard, k.meetingId)}>Discard</button>
        </div>
      ))}
      {err && <Failed msg={err} />}
    </>
  );
}

// "Before the first recording, each attendee accepts a recording notice."
function ConsentBanner() {
  const [c, setC] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/mom/consent').then(setC).catch(() => setC(null)); }, []);
  if (!c || c.accepted) return null;
  const accept = async () => {
    setBusy(true); setErr(null);
    try { await api('/pms/mom/consent', { method: 'POST', body: JSON.stringify({ accept: true }) }); setC({ ...c, accepted: true }); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 space-y-2 border-amber-200 bg-amber-50/60">
      <div className="text-sm font-semibold text-navy-800">Recording notice</div>
      <p className="text-sm text-navy-700">{c.notice.text}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-pri" disabled={busy} onClick={accept}>I accept</button>
        <span className="text-xs text-navy-500">Until you accept, the connects you are in are not recorded and their minutes are written by hand.</span>
        {err && <span className="text-xs text-rose-600">{err}</span>}
      </div>
    </div>
  );
}

function NoticeLine() {
  const [c, setC] = useState(null);
  const load = () => api('/pms/mom/consent').then(setC).catch(() => setC(null));
  useEffect(() => { load(); }, []);
  if (!c || !c.accepted) return null;
  const withdraw = async () => {
    if (!window.confirm('Withdraw your acceptance? Connects you are in will not be recorded or sent to the AI.')) return;
    await api('/pms/mom/consent', { method: 'POST', body: JSON.stringify({ accept: false }) }).catch(() => {});
    window.location.reload();
  };
  return <p className="text-[11px] text-navy-400">You accepted the recording notice on {when(c.accepted_at)}. <button type="button" className="underline" onClick={withdraw}>Withdraw</button></p>;
}

// ---------------------------------------------------------------- MoMs list

function MomList({ open }) {
  const [f, setF] = useState({ from: '', to: '', status: '', manager_id: '' });
  const [d, setD] = useState(null);
  const [managers, setManagers] = useState([]);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    setD(null); setErr(null);
    api(`/pms/mom/meetings${qs ? `?${qs}` : ''}`)
      .then((r) => { if (live) { setD(r); if (r.hr) setManagers(r.managers); } })
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [f.from, f.to, f.status, f.manager_id]);
  const field = (k) => ({ value: f[k], onChange: (e) => setF({ ...f, [k]: e.target.value }) });
  return (
    <div className="space-y-3">
      <div className="card p-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div><label className="lbl">From</label><input type="date" className="inp" {...field('from')} /></div>
        <div><label className="lbl">To</label><input type="date" className="inp" {...field('to')} /></div>
        <div>
          <label className="lbl">Status</label>
          <select className="inp" {...field('status')}>
            <option value="">All</option>
            {Object.entries(STATUS).filter(([k]) => !['processing', 'draft_ready'].includes(k))
              .map(([k, [label]]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        {managers.length > 0 && (
          <div>
            <label className="lbl">Team</label>
            <select className="inp" {...field('manager_id')}>
              <option value="">All teams</option>
              {managers.map((m) => <option key={m.manager_id} value={m.manager_id}>{m.name}</option>)}
            </select>
          </div>
        )}
      </div>
      {err && <Failed msg={err} />}
      {!err && !d && <Loading />}
      {d && !d.meetings.length && <Empty>No MoMs match.</Empty>}
      {d && d.meetings.length > 0 && (
        <div className="card divide-y divide-navy-50">
          {d.meetings.map((m) => (
            <button key={m.id} type="button" onClick={() => open(m.id)}
              className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-2 hover:bg-navy-50/60">
              <span className="text-xs font-mono text-navy-500 w-24 shrink-0">{m.date}</span>
              <span className="flex-1 min-w-[10rem] text-sm text-navy-800">{m.title}</span>
              {m.recorded && <span className="chip bg-rose-50 text-rose-700">Recorded</span>}
              {m.open_items > 0 && <span className="chip bg-amber-50 text-amber-700">{m.open_items} open item{m.open_items === 1 ? '' : 's'}</span>}
              {m.attended && m.mom_status === 'published' && !m.acknowledged && <span className="chip bg-blue-100 text-blue-700">To acknowledge</span>}
              <MomStatus status={m.status} momStatus={m.mom_status} version={m.version} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Action items

function ActionItems({ ctx, open }) {
  const [scope, setScope] = useState('mine');
  const [status, setStatus] = useState('open');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = () => {
    setErr(null);
    return api(`/pms/mom/action-items?scope=${scope}&status=${status}`).then(setD).catch((e) => setErr(e.message));
  };
  useEffect(() => { setD(null); load(); }, [scope, status]);
  const update = async (a, to) => {
    setBusy(a.id);
    try { await api(`/pms/mom/action-items/${a.id}`, { method: 'PUT', body: JSON.stringify({ status: to }) }); await load(); } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  const scopes = [['mine', 'Mine'], ...(ctx && ctx.can_manage ? [['team', 'My team']] : []), ...(ctx && ctx.hr ? [['all', 'All teams']] : [])];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {scopes.length > 1 && scopes.map(([k, label]) => (
          <button key={k} type="button" className={scope === k ? 'btn bg-navy-700 text-white' : 'btn-sec'} onClick={() => setScope(k)}>{label}</button>
        ))}
        <select className="inp w-auto ml-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="open">Open</option><option value="done">Done</option><option value="cancelled">Cancelled</option><option value="any">All</option>
        </select>
      </div>
      {err && <Failed msg={err} />}
      {!err && !d && <Loading />}
      {d && !d.items.length && <Empty>No action items here.</Empty>}
      {d && d.items.length > 0 && (
        <div className="card divide-y divide-navy-50">
          {d.items.map((a) => (
            <div key={a.id} className="px-4 py-3 flex flex-wrap items-center gap-2">
              <div className="flex-1 min-w-[12rem]">
                <div className="text-sm text-navy-800">{a.task}</div>
                <div className="text-xs text-navy-400">
                  {a.owner_name || 'No owner'} · due {a.due_date || '—'} ·{' '}
                  <button type="button" className="underline" onClick={() => open(a.meeting_id)}>{a.meeting_date} MoM</button>
                  {scope !== 'mine' && a.manager_name ? ` · ${a.manager_name}'s team` : ''}
                </div>
              </div>
              <span className={`chip ${PRIORITY[a.priority]}`}>{a.priority}</span>
              {a.carried_forward_count > 0 && <span className="chip bg-navy-50 text-navy-600">Carried ×{a.carried_forward_count}</span>}
              {a.overdue && <span className="chip bg-rose-100 text-rose-700">Overdue</span>}
              {a.status !== 'open' && <span className="chip bg-navy-100 text-navy-600">{a.status === 'done' ? `Done ${a.closed_on || ''}` : 'Cancelled'}</span>}
              {a.can_update && a.status === 'open' && (
                <>
                  <button type="button" className="btn-pri" disabled={busy === a.id} onClick={() => update(a, 'done')}><CheckCircle2 size={13} className="inline mr-1" />Done</button>
                  <button type="button" className="btn-sec" disabled={busy === a.id} onClick={() => update(a, 'cancelled')}>Cancel</button>
                </>
              )}
              {a.can_update && a.status !== 'open' && (
                <button type="button" className="btn-sec" disabled={busy === a.id} onClick={() => update(a, 'open')}><RotateCcw size={13} className="inline mr-1" />Reopen</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Team settings

function TeamSettings({ ctx, onSaved }) {
  const teams = ctx.hr ? ctx.teams : ctx.teams.filter((t) => t.manager_id === ctx.me);
  const noLink = teams.filter((t) => !t.meet_link).length;
  if (!teams.length && !ctx.hr) return <Empty>No teams yet — a team is a manager with direct reports.</Empty>;
  return (
    <div className="space-y-3">
      {ctx.hr && <MomSettings />}
      {ctx.hr && (
        <p className="text-xs text-navy-500">
          {teams.length} team{teams.length === 1 ? '' : 's'} · {teams.filter((t) => t.enabled).length} with daily connects on
          {noLink > 0 && <span className="text-amber-700"> · {noLink} without a Google Meet link</span>}
        </p>
      )}
      {teams.map((t) => <TeamRow key={t.manager_id} team={t} hr={ctx.hr} startOpen={!ctx.hr || teams.length === 1} onSaved={onSaved} />)}
    </div>
  );
}

function TeamRow({ team, hr, startOpen, onSaved }) {
  const [openRow, setOpenRow] = useState(startOpen);
  const [f, setF] = useState({
    meet_link: team.meet_link || '', daily_time: team.daily_time, duration_min: String(team.duration_min),
    attendee_ids: team.attendee_ids || null, enabled: !!team.enabled,
  });
  const [reports, setReports] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (openRow && !reports) api(`/pms/mom/teams/${team.manager_id}/reports`).then((r) => setReports(r.reports)).catch(() => setReports([]));
  }, [openRow]);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api(`/pms/mom/teams/${team.manager_id}`, { method: 'PUT', body: JSON.stringify({
        meet_link: f.meet_link, daily_time: f.daily_time, duration_min: Number(f.duration_min), attendee_ids: f.attendee_ids,
        ...(hr ? { enabled: f.enabled } : {}),
      }) });
      setMsg({ ok: true, text: 'Saved.' });
      onSaved();
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const toggle = (id) => {
    const cur = f.attendee_ids || (reports || []).map((r) => r.id);
    setF({ ...f, attendee_ids: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  return (
    <div className="card">
      <button type="button" className="w-full text-left px-4 py-3 flex flex-wrap items-center gap-2" onClick={() => setOpenRow((v) => !v)}>
        <span className="flex-1 min-w-[10rem] text-sm font-semibold text-navy-800">{team.manager_name}'s team
          <span className="font-normal text-navy-400"> · {team.reports} report{team.reports === 1 ? '' : 's'}{team.department ? ` · ${team.department}` : ''}</span>
        </span>
        {!team.meet_link && <span className="chip bg-amber-100 text-amber-700">No Meet link</span>}
        <span className={`chip ${team.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-500'}`}>{team.enabled ? 'Daily connects on' : 'Off'}</span>
      </button>
      {openRow && (
        <div className="px-4 pb-4 space-y-3 border-t border-navy-50 pt-3">
          <div>
            <label className="lbl" htmlFor={`link-${team.manager_id}`}>Google Meet link</label>
            <input id={`link-${team.manager_id}`} className="inp" placeholder="https://meet.google.com/abc-defg-hij" value={f.meet_link}
              onChange={(e) => setF({ ...f, meet_link: e.target.value })} />
            <p className="text-[11px] text-navy-400 mt-1">The same link is used for every daily connect. Create it once in Google Meet and paste it here.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 max-w-sm">
            <div><label className="lbl">Daily time</label><input type="time" className="inp" value={f.daily_time} onChange={(e) => setF({ ...f, daily_time: e.target.value })} /></div>
            <div><label className="lbl">Minutes</label><input type="number" min="5" max="240" className="inp" value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} /></div>
          </div>
          <div>
            <label className="lbl">Attendees</label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!f.attendee_ids} onChange={(e) => setF({ ...f, attendee_ids: e.target.checked ? null : (reports || []).map((r) => r.id) })} />
              All direct reports (follows the team as it changes)
            </label>
            {f.attendee_ids && (
              <div className="grid sm:grid-cols-2 gap-1 mt-2">
                {(reports || []).map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={f.attendee_ids.includes(r.id)} onChange={() => toggle(r.id)} />{r.name}
                  </label>
                ))}
              </div>
            )}
            {reports && reports.length > 0 && (
              <p className="text-[11px] text-navy-400 mt-1">
                Recording notice accepted by {reports.filter((r) => r.notice_accepted).length} of {reports.length}
                {reports.some((r) => !r.notice_accepted) && <> · not yet: {reports.filter((r) => !r.notice_accepted).map((r) => r.name).join(', ')}</>}
              </p>
            )}
          </div>
          {hr ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
              Daily connects on for this team
            </label>
          ) : (
            <p className="text-xs text-navy-400">Daily connects are {team.enabled ? 'on' : 'off'} for your team. HR switches them on or off.</p>
          )}
          <div className="flex items-center gap-2">
            <button type="button" className="btn-pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-rose-600'}`}>{msg.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

const EMAIL_LABELS = [
  ['reminder', 'The 15-minute reminder with the Meet link'],
  ['published', 'MoM published or revised, and comments on it'],
  ['action_items', 'Action items: assigned, due today, overdue, and 3 days overdue to the manager'],
  ['missing', 'Missing MoM at 6 pm'],
  ['draft', 'AI draft ready or failed, and a recording saved after a closed tab'],
];

// HR: how long recordings and transcripts are kept, and which notices are
// emailed as well as shown in the bell.
function MomSettings() {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/pms/mom/settings').then((r) => { setD(r); setF({ ...r.settings, recording_days: String(r.settings.recording_days), transcript_days: String(r.settings.transcript_days) }); })
      .catch((e) => setMsg({ ok: false, text: e.message }));
  }, []);
  if (!f) return msg ? <Failed msg={msg.text} /> : null;
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api('/pms/mom/settings', { method: 'PUT', body: JSON.stringify({ recording_days: Number(f.recording_days), transcript_days: Number(f.transcript_days), email: f.email }) });
      setMsg({ ok: true, text: 'Saved.' });
    } catch (e) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="card p-4 space-y-3">
      <div className="text-sm font-semibold text-navy-800">MoM settings</div>
      {d.storage && !d.storage.ok && <p className="text-xs text-rose-600">Recordings cannot be stored on this server: {d.storage.error}</p>}
      <div className="grid grid-cols-2 gap-2 max-w-md">
        <div><label className="lbl">Keep recordings (days)</label><input type="number" min="1" max="3650" className="inp" value={f.recording_days} onChange={(e) => setF({ ...f, recording_days: e.target.value })} /></div>
        <div><label className="lbl">Keep transcripts (days)</label><input type="number" min="1" max="3650" className="inp" value={f.transcript_days} onChange={(e) => setF({ ...f, transcript_days: e.target.value })} /></div>
      </div>
      <p className="text-[11px] text-navy-400">A change applies to what is already stored, counted from when each file arrived. MoMs and action items are kept permanently.</p>
      <div>
        <label className="lbl">Also send by email</label>
        <div className="space-y-1">
          {EMAIL_LABELS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!f.email[k]} onChange={(e) => setF({ ...f, email: { ...f.email, [k]: e.target.checked } })} />{label}
            </label>
          ))}
        </div>
        <p className="text-[11px] text-navy-400 mt-1">Every notice always appears in the bell.</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
        {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-rose-600'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- HR report

function Report({ open }) {
  const [date, setDate] = useState('');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setD(null); setErr(null);
    api(`/pms/mom/compliance${date ? `?date=${date}` : ''}`).then((r) => live && setD(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [date]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div><label className="lbl">Day</label><input type="date" className="inp w-auto" value={date || (d && d.date) || ''} onChange={(e) => setDate(e.target.value)} /></div>
        {d && (
          <div className="flex flex-wrap gap-1.5 pb-1">
            <span className="chip bg-navy-50 text-navy-600">{d.totals.teams} teams</span>
            <span className="chip bg-emerald-100 text-emerald-700">{d.totals.published} published</span>
            <span className="chip bg-rose-100 text-rose-700">{d.totals.missing} missing</span>
            <span className="chip bg-navy-50 text-navy-600">{d.totals.scheduled} pending</span>
            <span className="chip bg-navy-100 text-navy-500">{d.totals.cancelled} not held</span>
            {d.totals.draft_ready > 0 && <span className="chip bg-amber-100 text-amber-700">{d.totals.draft_ready} draft ready</span>}
          </div>
        )}
      </div>
      {err && <Failed msg={err} />}
      {!err && !d && <Loading />}
      {d && !d.working_day && <p className="text-xs text-navy-400">Not a working day — no daily connects.</p>}
      {d && !d.teams.length && <Empty>No team has daily connects on yet. Switch them on under Team settings.</Empty>}
      {d && d.teams.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-navy-400">
              <th className="px-4 py-2">Team</th><th className="px-2 py-2">Department</th><th className="px-2 py-2">MoM</th>
              <th className="px-2 py-2">Published</th><th className="px-2 py-2 text-right">Open items</th>
            </tr></thead>
            <tbody>
              {d.teams.map((t) => (
                <tr key={t.team_id} className="border-t border-navy-50">
                  <td className="px-4 py-2">
                    {t.meeting_id ? <button type="button" className="underline text-left" onClick={() => open(t.meeting_id)}>{t.manager_name}</button> : t.manager_name}
                  </td>
                  <td className="px-2 py-2 text-navy-500">{t.department || '—'}</td>
                  <td className="px-2 py-2">
                    <span className="inline-flex flex-wrap gap-1"><MomStatus status={t.status} />
                      {t.recorded && <span className="chip bg-rose-50 text-rose-700">Recorded</span>}
                      {t.source === 'ai' && <span className="chip bg-violet-100 text-violet-700">AI draft</span>}</span>
                  </td>
                  <td className="px-2 py-2 text-navy-500">{when(t.published_at) || '—'}</td>
                  <td className="px-2 py-2 text-right">{t.open_items}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- One MoM

function MomView({ id, onBack }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [revising, setRevising] = useState(false);
  const load = () => api(`/pms/mom/meetings/${id}`).then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); setRevising(false); load(); }, [id]);
  // While the AI drafts, look again every few seconds.
  const processing = d && d.meeting.status === 'processing';
  useEffect(() => { if (!processing) return undefined; const h = setTimeout(load, 4000); return () => clearTimeout(h); }, [d]);
  const back = <button type="button" className="text-xs text-navy-500 flex items-center gap-1" onClick={onBack}><ArrowLeft size={13} />Back</button>;
  if (err && !d) return <div className="space-y-3">{back}<Failed msg={err} /></div>;
  if (!d) return <div className="space-y-3">{back}<Loading /></div>;
  const m = d.meeting;
  const mi = d.minutes;
  const published = !!(mi && mi.status === 'published');
  const editing = d.can_edit && (!published || revising);
  return (
    <div className="space-y-4">
      {back}
      <div className="card p-4 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex-1 min-w-[12rem] text-base font-bold text-navy-800">{m.title}</h3>
          <MomStatus status={m.status} momStatus={mi && mi.status} version={mi && mi.version} />
        </div>
        <div className="text-xs text-navy-500">
          {m.date} · {m.start_time || '—'}{m.end_time ? `–${m.end_time}` : ''} · Organiser {m.organiser_name || '—'}
          {m.meet_link && <> · <a className="underline" href={m.meet_link} target="_blank" rel="noreferrer">Google Meet</a></>}
        </div>
        <div className="text-xs text-navy-400">Attendees: {m.attendees.map((a) => a.name).join(', ') || '—'}</div>
        {published && <div className="text-xs text-navy-400">Published by {mi.published_by} · {when(mi.published_at)}</div>}
        {m.status === 'cancelled' && <div className="text-sm text-navy-600 pt-1">Not held: {m.cancel_reason}</div>}
      </div>
      <MediaCard d={d} reload={load} />
      {editing && !processing && (
        <div className={d.transcript && d.transcript.text ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] items-start' : ''}>
          <Editor key={`${revising ? 'revise' : 'draft'}-${mi ? mi.updated_at : ''}`} d={d} revise={published} onDone={() => { setRevising(false); load(); }} onCancel={published ? () => setRevising(false) : null} />
          {d.transcript && d.transcript.text && <TranscriptPanel t={d.transcript} />}
        </div>
      )}
      {!editing && mi && (
        <div className="card p-4 space-y-4">
          {d.can_edit && published && (
            <div className="flex justify-end"><button type="button" className="btn-sec" onClick={() => setRevising(true)}>Revise (v{mi.version + 1})</button></div>
          )}
          {!published && <span className="chip bg-amber-100 text-amber-700">Draft — not published</span>}
          <MinutesBody v={{ ...mi, action_items: d.action_items, carried_forward: mi.carried_forward_snapshot }} names={namesOf(m)} />
        </div>
      )}
      {!editing && !mi && m.status !== 'cancelled' && <Empty>The MoM for this connect is not published yet.</Empty>}
      {editing && processing && <Empty><Sparkles size={14} className="inline mr-1 text-violet-600" />The AI is drafting the MoM from the transcript. This page updates by itself.</Empty>}
      {published && <Acks d={d} reload={load} />}
      {d.versions.length > 0 && <Versions id={id} versions={d.versions} names={namesOf(m)} />}
    </div>
  );
}

// The connect's recording (play, download, record, upload a file) and,
// for whoever writes the MoM, the Google Meet transcript and the AI draft.
function MediaCard({ d, reload }) {
  const m = d.meeting;
  const rec = d.recording;
  const editor = d.can_record || !!d.transcript;
  if (!rec && !editor) return null;
  const missing = (d.consent || []).filter((c) => !c.accepted);
  return (
    <div className="card p-4 space-y-4">
      <div className="space-y-2">
        <div className="lbl">Recording</div>
        {rec && !rec.deleted_at && <RecordingPlayer meetingId={m.id} rec={rec} />}
        {rec && rec.deleted_at && <p className="text-sm text-navy-500">The recording was deleted on {when(rec.deleted_at)} under the retention rule.</p>}
        {!rec && !d.can_record && <p className="text-sm text-navy-400">Not recorded.</p>}
        {d.can_record && (
          <>
            <RecordControl meeting={m} recorded={!!(rec && !rec.deleted_at)} missing={missing} onDone={reload} />
            {!missing.length && <FileUpload meetingId={m.id} recorded={!!(rec && !rec.deleted_at)} onDone={reload} />}
          </>
        )}
      </div>
      {d.can_record && <TranscriptUpload d={d} missing={missing} reload={reload} />}
      {!d.can_record && d.transcript && d.transcript.text && (
        <p className="text-xs text-navy-500">Transcript uploaded by {d.transcript.uploaded_by} on {when(d.transcript.created_at)}.</p>
      )}
    </div>
  );
}

async function fetchRecording(meetingId, download) {
  const token = localStorage.getItem('apms_token');
  const r = await fetch(`${API_BASE}/pms/mom/meetings/${meetingId}/recording${download ? '?download=1' : ''}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.blob();
}

function RecordingPlayer({ meetingId, rec }) {
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const play = async () => {
    setBusy(true); setErr(null);
    try { setUrl(URL.createObjectURL(await fetchRecording(meetingId, false))); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const download = async () => {
    setErr(null);
    try {
      const u = URL.createObjectURL(await fetchRecording(meetingId, true));
      const a = document.createElement('a'); a.href = u; a.download = `connect-recording.${(rec.mime.split('/')[1] || 'webm').replace('mpeg', 'mp3')}`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000);
    } catch (e) { setErr(e.message); }
  };
  const mins = rec.duration_sec ? `${Math.round(rec.duration_sec / 60)} min · ` : '';
  return (
    <div className="space-y-1">
      {url ? <audio controls autoPlay src={url} className="w-full max-w-lg" /> : (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-sec" disabled={busy} onClick={play}><Play size={13} className="inline mr-1" />{busy ? 'Loading…' : 'Play recording'}</button>
          <button type="button" className="btn-sec" onClick={download}><Download size={13} className="inline mr-1" />Download</button>
        </div>
      )}
      <p className="text-[11px] text-navy-400">{mins}{Math.max(1, Math.round(rec.size_bytes / 1024))} KB · recorded by {rec.uploaded_by} · deleted after {rec.delete_after}. Every play is logged.</p>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

// A recording saved to the laptop earlier, sent from here.
function FileUpload({ meetingId, recorded, onDone }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (recorded && !window.confirm('This connect already has a recording. The file replaces it. Continue?')) return;
    setErr(null); setP(0);
    try { await recorder.uploadFile(meetingId, file, { replace: recorded, onProgress: setP }); setP(null); onDone(); } catch (x) { setErr(x.message); setP(null); }
  };
  return (
    <div className="text-xs text-navy-500">
      {p === null ? (
        <label className="underline cursor-pointer">Or send a recording file saved on this laptop
          <input type="file" accept="audio/*,video/webm,video/mp4,.webm,.m4a,.mp3,.wav,.ogg" className="hidden" onChange={pick} /></label>
      ) : <span>Sending… {Math.round(p * 100)}%</span>}
      {err && <span className="text-rose-600"> {err}</span>}
    </div>
  );
}

// Part 3: the transcript Google Meet made of the call, uploaded here; the
// PMS's AI service drafts the MoM from it.
function TranscriptUpload({ d, missing, reload }) {
  const m = d.meeting;
  const t = d.transcript && d.transcript.text ? d.transcript : null;
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const send = async (build, again) => {
    setBusy(true); setErr(null);
    try {
      await api(`/pms/mom/meetings/${m.id}/${again ? 'redraft' : 'transcript'}`, { method: 'POST', body: build(false) });
      setPaste(false); setText(''); reload();
    } catch (e) {
      if (e.data && e.data.needs_replace && window.confirm('This connect already has a draft MoM. The AI draft will replace it. Continue?')) {
        try { await api(`/pms/mom/meetings/${m.id}/${again ? 'redraft' : 'transcript'}`, { method: 'POST', body: build(true) }); setPaste(false); setText(''); reload(); } catch (e2) { setErr(e2.message); }
      } else setErr(e.message);
    } finally { setBusy(false); }
  };
  const sendFile = (file) => send((replace) => { const fd = new FormData(); fd.append('file', file); if (replace) fd.append('replace', 'true'); return fd; });
  const sendText = () => send((replace) => JSON.stringify({ text, replace }));
  const redraft = () => send((replace) => JSON.stringify({ replace }), true);
  return (
    <div className="space-y-2 border-t border-navy-50 pt-3">
      <div className="lbl flex items-center gap-1"><FileText size={12} />Google Meet transcript → AI draft</div>
      {m.status === 'processing' && <p className="text-sm text-violet-700"><Sparkles size={13} className="inline mr-1" />Drafting the MoM from the transcript…</p>}
      {d.draft_error && m.status !== 'processing' && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-sm text-rose-700 flex flex-wrap items-center gap-2">
          <span className="flex-1">{d.draft_error}</span>
          {t && !missing.length && <button type="button" className="btn-sec" disabled={busy} onClick={redraft}>Try again</button>}
        </div>
      )}
      {t && <p className="text-xs text-navy-500">Uploaded by {t.uploaded_by} on {when(t.created_at)}{t.file_name ? ` (${t.file_name})` : ''}{t.speakers.length ? ` · speakers: ${t.speakers.join(', ')}` : ''} · deleted after {t.delete_after}.</p>}
      {missing.length > 0 ? (
        <p className="text-xs text-amber-700">The transcript cannot be sent to the AI until everyone on the call has accepted the recording notice ({listNames(missing)}). Write the MoM by hand.</p>
      ) : m.status !== 'processing' && (
        <>
          <p className="text-xs text-navy-500">After the call, Google Meet saves the transcript to the organiser's Google Drive (Meet Recordings folder) and emails a link to it.
            Open it, choose File → Download → Microsoft Word (.docx) or Plain text (.txt), and upload it here — or paste its text.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-pri" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>{busy ? 'Sending…' : t ? 'Upload a new transcript' : 'Upload transcript'}</button>
            <input ref={fileRef} type="file" accept=".docx,.txt,.vtt,.srt,.sbv,.md" className="hidden"
              onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) sendFile(f); }} />
            <button type="button" className="text-xs text-navy-500 underline" onClick={() => setPaste((v) => !v)}>{paste ? 'Hide' : 'Paste the text instead'}</button>
            {t && !d.draft_error && <button type="button" className="text-xs text-navy-500 underline" disabled={busy} onClick={redraft}>Draft again from this transcript</button>}
          </div>
          {paste && (
            <div className="space-y-2">
              <textarea className="inp font-mono text-xs" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the Google Meet transcript here" aria-label="Transcript text" />
              <button type="button" className="btn-pri" disabled={busy || !text.trim()} onClick={sendText}>Send to the AI</button>
            </div>
          )}
        </>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

function TranscriptPanel({ t }) {
  return (
    <details open className="card p-3 lg:sticky lg:top-4">
      <summary className="lbl cursor-pointer">Transcript</summary>
      <pre className="mt-2 text-xs whitespace-pre-wrap font-sans text-navy-700 max-h-[70vh] overflow-auto">{t.text}</pre>
    </details>
  );
}

const namesOf = (m) => Object.fromEntries([[m.organiser_id, m.organiser_name], ...m.attendees.map((a) => [a.id, a.name])]);

function Section({ title, children }) {
  return <div><div className="lbl">{title}</div>{children}</div>;
}

function MinutesBody({ v, names }) {
  const att = v.attendance || {};
  const present = Object.keys(att).filter((k) => att[k] === 'present').map((k) => names[k] || 'Former employee');
  const absent = Object.keys(att).filter((k) => att[k] === 'absent').map((k) => names[k] || 'Former employee');
  const list = (xs) => (xs && xs.length ? <ul className="list-disc pl-5 text-sm space-y-0.5">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-sm text-navy-400">None.</p>);
  return (
    <div className="space-y-4">
      {v.summary && <Section title="Summary"><p className="text-sm whitespace-pre-wrap">{v.summary}</p></Section>}
      {(present.length > 0 || absent.length > 0) && (
        <Section title="Attendance">
          <p className="text-sm">Present: {present.join(', ') || '—'}</p>
          {absent.length > 0 && <p className="text-sm text-navy-500">Absent: {absent.join(', ')}</p>}
        </Section>
      )}
      <Section title="Discussion points">{list(v.discussion)}</Section>
      <Section title="Decisions">{list(v.decisions)}</Section>
      <Section title="Action items">
        {(v.action_items || []).length ? (
          <div className="divide-y divide-navy-50 border border-navy-50 rounded-xl">
            {v.action_items.map((a, i) => (
              <div key={a.id || i} className="px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="flex-1 min-w-[10rem]">{a.task}</span>
                <span className="text-xs text-navy-500">{a.owner_name || '—'} · due {a.due_date || '—'}</span>
                <span className={`chip ${PRIORITY[a.priority] || ''}`}>{a.priority}</span>
                {a.status && a.status !== 'open' && <span className="chip bg-navy-100 text-navy-600">{a.status === 'done' ? 'Done' : 'Cancelled'}</span>}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-navy-400">None.</p>}
      </Section>
      <Section title="Blockers">
        {(v.blockers || []).length ? (
          <ul className="list-disc pl-5 text-sm space-y-0.5">{v.blockers.map((b, i) => <li key={i}>{b.issue}{b.help_from ? <span className="text-navy-500"> — help from {b.help_from}</span> : ''}</li>)}</ul>
        ) : <p className="text-sm text-navy-400">None.</p>}
      </Section>
      {v.carried_forward && v.carried_forward.length > 0 && (
        <Section title="Carried forward">
          <ul className="list-disc pl-5 text-sm space-y-0.5">
            {v.carried_forward.map((a) => <li key={a.id}>{a.task} <span className="text-navy-500">— {a.owner_name || '—'}, due {a.due_date || '—'}, from {a.from_date}</span></li>)}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ListField({ label, items, onChange, placeholder }) {
  return (
    <div>
      <label className="lbl">{label}</label>
      <div className="space-y-1.5">
        {items.map((x, i) => (
          <div key={i} className="flex gap-2">
            <input className="inp" value={x} placeholder={placeholder} aria-label={`${label} ${i + 1}`}
              onChange={(e) => onChange(items.map((y, j) => (j === i ? e.target.value : y)))} />
            <button type="button" className="btn-sec" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      <button type="button" className="btn-sec mt-1.5" onClick={() => onChange([...items, ''])}><Plus size={13} className="inline mr-1" />Add</button>
    </div>
  );
}

function Editor({ d, revise, onDone, onCancel }) {
  const m = d.meeting;
  const mi = d.minutes || {};
  const [f, setF] = useState(() => ({
    start_time: m.start_time || '', end_time: m.end_time || '',
    summary: mi.summary || '',
    discussion: mi.discussion && mi.discussion.length ? mi.discussion : [''],
    decisions: mi.decisions || [],
    blockers: mi.blockers || [],
    attendance: mi.attendance && Object.keys(mi.attendance).length ? mi.attendance : Object.fromEntries(m.attendees.map((a) => [a.id, 'present'])),
    action_items: (d.action_items || []).map((a) => ({ id: a.id, task: a.task, owner_id: a.owner_id || '', due_date: a.due_date || '', priority: a.priority, status: a.status })),
  }));
  const [carried, setCarried] = useState(d.carried_forward || []);
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState([]);
  const [note, setNote] = useState(null);
  const [notHeld, setNotHeld] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const item = (i, patch) => set('action_items', f.action_items.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const body = () => JSON.stringify({ ...f, action_items: f.action_items.map((a) => ({ ...a, owner_id: a.owner_id || null, due_date: a.due_date || null })) });
  const send = async (kind) => {
    setBusy(kind); setErrors([]); setNote(null);
    try {
      if (kind === 'save') {
        await api(`/pms/mom/meetings/${m.id}/minutes`, { method: 'PUT', body: body() });
        setNote('Draft saved.');
      } else {
        await api(`/pms/mom/meetings/${m.id}/${kind}`, { method: 'POST', body: body() });
        onDone();
      }
    } catch (e) { setErrors((e.data && e.data.errors) || [e.message]); } finally { setBusy(null); }
  };
  const markNotHeld = async () => {
    setBusy('cancel'); setErrors([]);
    try { await api(`/pms/mom/meetings/${m.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: notHeld }) }); onDone(); } catch (e) { setErrors([e.message]); } finally { setBusy(null); }
  };
  const closeCarried = async (a) => {
    try { await api(`/pms/mom/action-items/${a.id}`, { method: 'PUT', body: JSON.stringify({ status: 'done' }) }); setCarried((xs) => xs.filter((x) => x.id !== a.id)); } catch (e) { setErrors([e.message]); }
  };
  const people = d.people || [];
  const ai = mi.source === 'ai' && !revise;
  const notes = mi.ai_notes || {};
  const hints = Object.fromEntries((notes.carried_hints || []).map((h) => [h.id, h]));
  return (
    <div className="card p-4 space-y-4">
      {revise && <p className="text-xs text-navy-500">You are editing v{mi.version}. Publishing makes v{mi.version + 1}; attendees are told what changed.</p>}
      {ai && (
        <div className="space-y-2">
          <span className="chip bg-violet-100 text-violet-700"><Sparkles size={11} className="inline mr-1" />AI DRAFT from the Google Meet transcript — check every section before publishing</span>
          {mi.ai_confidence === 'low' && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800"><b>Low confidence.</b> {notes.confidence_reason} Review this draft closely.</div>
          )}
          {(notes.unmatched_owners || []).length > 0 && (
            <p className="text-xs text-amber-700">The AI heard these owners but could not match them to a person: {notes.unmatched_owners.join(', ')}. Choose the owner for those items.</p>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 max-w-sm">
        <div><label className="lbl">Started</label><input type="time" className="inp" value={f.start_time} onChange={(e) => set('start_time', e.target.value)} /></div>
        <div><label className="lbl">Ended</label><input type="time" className="inp" value={f.end_time} onChange={(e) => set('end_time', e.target.value)} /></div>
      </div>
      {m.attendees.length > 0 && (
        <div>
          <label className="lbl">Attendance</label>
          <div className="grid sm:grid-cols-2 gap-1">
            {m.attendees.map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={f.attendance[a.id] !== 'absent'}
                  onChange={(e) => set('attendance', { ...f.attendance, [a.id]: e.target.checked ? 'present' : 'absent' })} />{a.name}
              </label>
            ))}
          </div>
        </div>
      )}
      <div><label className="lbl" htmlFor="mom-summary">Summary</label>
        <textarea id="mom-summary" className="inp" rows={3} value={f.summary} onChange={(e) => set('summary', e.target.value)} /></div>
      <ListField label="Discussion points" items={f.discussion} onChange={(v) => set('discussion', v)} placeholder="What was discussed" />
      <ListField label="Decisions" items={f.decisions} onChange={(v) => set('decisions', v)} placeholder="What was decided" />
      <div>
        <label className="lbl">Action items</label>
        <div className="space-y-2">
          {f.action_items.map((a, i) => (
            <div key={a.id || `n${i}`} className="grid grid-cols-2 sm:grid-cols-[1fr_10rem_9rem_6.5rem_auto] gap-2 items-center border border-navy-50 rounded-xl p-2">
              <input className="inp col-span-2 sm:col-span-1" placeholder="Task" aria-label={`Task ${i + 1}`} value={a.task} onChange={(e) => item(i, { task: e.target.value })} />
              <select className="inp" aria-label={`Owner ${i + 1}`} value={a.owner_id} onChange={(e) => item(i, { owner_id: e.target.value })}>
                <option value="">Owner…</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                {a.owner_id && !people.some((p) => p.id === a.owner_id) && <option value={a.owner_id}>{(d.action_items.find((x) => x.id === a.id) || {}).owner_name || 'Current owner'}</option>}
              </select>
              <input type="date" className="inp" aria-label={`Due date ${i + 1}`} value={a.due_date} onChange={(e) => item(i, { due_date: e.target.value })} />
              <select className="inp" aria-label={`Priority ${i + 1}`} value={a.priority} onChange={(e) => item(i, { priority: e.target.value })}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
              </select>
              {a.status && a.status !== 'open'
                ? <span className="chip bg-navy-100 text-navy-600 justify-self-start">{a.status === 'done' ? 'Done' : 'Cancelled'}</span>
                : <button type="button" className="btn-sec justify-self-start" aria-label="Remove" onClick={() => set('action_items', f.action_items.filter((_, j) => j !== i))}><Trash2 size={13} /></button>}
            </div>
          ))}
        </div>
        <button type="button" className="btn-sec mt-1.5" onClick={() => set('action_items', [...f.action_items, { id: null, task: '', owner_id: '', due_date: '', priority: 'medium' }])}>
          <Plus size={13} className="inline mr-1" />Add action item
        </button>
      </div>
      <div>
        <label className="lbl">Blockers</label>
        <div className="space-y-1.5">
          {f.blockers.map((b, i) => (
            <div key={i} className="flex flex-wrap sm:flex-nowrap gap-2">
              <input className="inp" placeholder="Issue" aria-label={`Blocker ${i + 1}`} value={b.issue} onChange={(e) => set('blockers', f.blockers.map((x, j) => (j === i ? { ...x, issue: e.target.value } : x)))} />
              <input className="inp sm:w-48" placeholder="Help needed from" aria-label={`Help from ${i + 1}`} value={b.help_from || ''} onChange={(e) => set('blockers', f.blockers.map((x, j) => (j === i ? { ...x, help_from: e.target.value } : x)))} />
              <button type="button" className="btn-sec" aria-label="Remove" onClick={() => set('blockers', f.blockers.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        <button type="button" className="btn-sec mt-1.5" onClick={() => set('blockers', [...f.blockers, { issue: '', help_from: '' }])}><Plus size={13} className="inline mr-1" />Add blocker</button>
      </div>
      {!revise && (
        <div>
          <label className="lbl">Carried forward</label>
          {carried.length ? (
            <div className="divide-y divide-navy-50 border border-navy-50 rounded-xl">
              {carried.map((a) => (
                <div key={a.id} className="px-3 py-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="flex-1 min-w-[10rem]">{a.task}</span>
                  <span className="text-xs text-navy-500">{a.owner_name || '—'} · due {a.due_date || '—'} · from {a.from_date}</span>
                  {hints[a.id] && (
                    <span className={`chip ${hints[a.id].status === 'done' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-600'}`} title={hints[a.id].note}>
                      AI: {hints[a.id].status === 'done' ? 'said done in the call' : 'still open'}
                    </span>
                  )}
                  <button type="button" className="btn-sec" onClick={() => closeCarried(a)}><CheckCircle2 size={13} className="inline mr-1" />Mark done</button>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-navy-400">No open items from earlier MoMs.</p>}
          <p className="text-[11px] text-navy-400 mt-1">Open items from the team's earlier MoMs. They stay open until marked done.</p>
        </div>
      )}
      {errors.length > 0 && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-sm text-rose-700" role="alert">
          <ul className="list-disc pl-5">{errors.map((x, i) => <li key={i}>{x}</li>)}</ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!revise && <button type="button" className="btn-sec" disabled={!!busy} onClick={() => send('save')}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
        <button type="button" className="btn-pri" disabled={!!busy} onClick={() => send(revise ? 'revise' : 'publish')}>
          {busy === 'publish' || busy === 'revise' ? 'Publishing…' : revise ? `Publish v${mi.version + 1}` : 'Publish'}
        </button>
        {onCancel && <button type="button" className="btn-sec" disabled={!!busy} onClick={onCancel}>Cancel</button>}
        {note && <span className="text-xs text-emerald-700">{note}</span>}
        {!revise && m.status !== 'published' && notHeld === null && (
          <button type="button" className="text-xs text-navy-500 underline ml-auto" onClick={() => setNotHeld('')}>Connect not held?</button>
        )}
      </div>
      {notHeld !== null && (
        <div className="flex flex-wrap gap-2 items-center">
          <input className="inp flex-1 min-w-[12rem]" placeholder="Why it did not happen" value={notHeld} onChange={(e) => setNotHeld(e.target.value)} aria-label="Reason not held" />
          <button type="button" className="btn-sec" disabled={!notHeld.trim() || !!busy} onClick={markNotHeld}>Mark as not held</button>
          <button type="button" className="text-xs text-navy-500 underline" onClick={() => setNotHeld(null)}>Keep it</button>
        </div>
      )}
    </div>
  );
}

function Acks({ d, reload }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const version = d.minutes.version;
  const ack = async () => {
    setBusy(true); setErr(null);
    try { await api(`/pms/mom/meetings/${d.meeting.id}/acknowledge`, { method: 'POST', body: JSON.stringify({ comment }) }); await reload(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const others = d.acks.filter((a) => a.version === version && !(d.my_ack && a.employee_id === d.my_ack.employee_id));
  return (
    <div className="card p-4 space-y-3">
      <div className="lbl">Acknowledgements</div>
      {d.can_ack && (
        <div className="space-y-2">
          <textarea className="inp" rows={2} placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
          <div className="flex items-center gap-2">
            <button type="button" className="btn-pri" disabled={busy} onClick={ack}><CheckCircle2 size={13} className="inline mr-1" />Acknowledge v{version}</button>
            {err && <span className="text-xs text-rose-600">{err}</span>}
          </div>
        </div>
      )}
      {d.my_ack && <p className="text-sm text-emerald-700">You acknowledged v{d.my_ack.version} on {when(d.my_ack.acknowledged_at)}{d.my_ack.comment ? ` — “${d.my_ack.comment}”` : ''}.</p>}
      {(others.length > 0 || d.pending_acks.length > 0) && (
        <div className="space-y-1 text-sm">
          {others.map((a) => (
            <div key={a.employee_id}><span className="font-medium">{a.name}</span> <span className="text-xs text-navy-400">{when(a.acknowledged_at)}</span>{a.comment && <span className="text-navy-600"> — “{a.comment}”</span>}</div>
          ))}
          {d.pending_acks.length > 0 && <p className="text-xs text-navy-500">Not yet acknowledged: {d.pending_acks.map((p) => p.name).join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

function Versions({ id, versions, names }) {
  const [shown, setShown] = useState(null);
  const [err, setErr] = useState(null);
  const view = async (v) => {
    if (shown && shown.version === v) { setShown(null); return; }
    setErr(null);
    try { setShown((await api(`/pms/mom/meetings/${id}/versions/${v}`)).version); } catch (e) { setErr(e.message); }
  };
  return (
    <div className="card p-4 space-y-2">
      <div className="lbl flex items-center gap-1"><History size={12} />Versions</div>
      {versions.map((v) => (
        <div key={v.version}>
          <button type="button" className="text-left text-sm w-full flex flex-wrap gap-2 items-center" onClick={() => view(v.version)}>
            <span className="chip bg-navy-50 text-navy-700">v{v.version}</span>
            <span className="text-navy-600">{when(v.changed_at)} · {v.changed_by}</span>
            {v.version > 1 && <span className="text-xs text-navy-400">Changed: {v.changed.map((c) => SECTION_LABEL[c] || c).join(', ')}</span>}
          </button>
          {shown && shown.version === v.version && (
            <div className="mt-2 ml-2 pl-3 border-l-2 border-navy-100"><MinutesBody v={shown.snapshot} names={names} /></div>
          )}
        </div>
      ))}
      {err && <Failed msg={err} />}
    </div>
  );
}
