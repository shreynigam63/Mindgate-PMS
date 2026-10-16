import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, phaseLabel, phaseColor } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { grade } from '../grade';
import { useTimesheetRatings, TimesheetRatingChip, TimesheetRatingNote } from '../TimesheetRating';
import NineBoxPage from './NineBoxPage';

// Matches Self-Appraisal/Team Evaluation's convention: per-KRA ratings in
// letter grades, overall figures in descriptive wording — fixed local
// maps rather than the cycle's own rating_scale labels, since this
// pairing should hold regardless of which label set a cycle has stored.
// The three local label maps that used to live here are gone: they were
// one of three copies in this app that did not agree, and the client
// asked on 24 Sep for ratings "only in Alphabets and not numbers". One
// formatter now, in grade.js, with the stored number in the tooltip.
// Takes the cycle's own scale. Without it this fell back to the default
// five-point ladder, which is right for the scales in use today and
// silently wrong for any other — the same gap that put a bare 4.1 on
// the Mid-Year checkpoint.
const overallLabel = (value, scale) => grade(value, scale);

// HOD REVIEW, three tabs (15 Oct): the review queue as it was, the team
// analysis — the Delivery Head's reporting line, direct reportees and each
// manager's team — and the 9-box of that same team only.
const HOD_TABS = [['queue', 'Review queue'], ['analysis', 'Team analysis'], ['nine-box', '9-Box Grid (my team)']];
export default function HodQueuePage() {
  const [params, setParams] = useSearchParams();
  const tab = HOD_TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'queue';
  return (
    <div className={`space-y-4 mx-auto ${tab === 'nine-box' ? 'max-w-6xl' : 'max-w-4xl'}`}>
      <PageHead title="HOD Review" hue="navy" sub={tab === 'nine-box' ? 'Everyone on your reporting line. You are not shown on your own grid.' : null} />
      <div className="tabbar">
        {HOD_TABS.map(([k, label]) => (
          <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setParams(k === 'queue' ? {} : { tab: k })}>{label}</button>
        ))}
      </div>
      {tab === 'queue' && <HodQueue />}
      {tab === 'analysis' && <TeamAnalysis />}
      {tab === 'nine-box' && <NineBoxPage key="reporting" view="reporting" embedded />}
    </div>
  );
}

function HodQueue() {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = () => api('/pms/hod/queue').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;
  const editable = data.cycle.phase === 'hod_eval';
  // Filtered in the browser: this list is one team or one
  // department, not the whole company, so there is nothing to gain
  // from a round trip per keystroke.
  const queueShown = (data.queue || []).filter(row => matches(q, row.name, row.department, row.manager_name));
  const EMPTY = {
    no_departments: 'HR has not assigned you a department yet, so there is nobody to review. Ask HR to add you under HR → HOD.',
    before_hod_phase: `HOD Review opens after manager evaluations. The cycle is in ${phaseLabel(data.cycle.phase)} now.`,
    none_submitted: 'Nothing is waiting on you: no manager in your departments has submitted an evaluation yet.',
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
        {data.departments?.length > 0 && <span className="text-xs text-navy-400">departments: {data.departments.join(', ')}</span>}
      </div>
      <SearchBox value={q} onChange={setQ} placeholder="Search the queue by name, department or manager…"
        shown={queueShown.length} total={(data.queue || []).length} />
      {!data.queue.length && <div className="card p-8 text-center text-sm text-navy-400">{EMPTY[data.empty_reason] || 'Nothing awaiting HOD review — manager evaluations feed this queue as they are submitted.'}</div>}
      {!!data.queue.length && !editable && <p className="text-xs text-navy-500">View only: ratings can be given during the HOD Review phase.</p>}
      {queueShown.map(q => (
        <div key={q.employee_id} className="card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpenId(v => v === q.employee_id ? null : q.employee_id)}>
            {openId === q.employee_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-sm font-semibold flex-1">{q.name}</span>
            <span className="text-[11px] text-navy-400">{q.department || '—'}</span>
            <span className="text-xs">Manager: <b>{overallLabel(q.manager_rating, data.cycle.rating_scale)}</b></span>
          </button>
          {openId === q.employee_id && <HodRow q={q} editable={editable} reload={load} scale={data.cycle.rating_scale} />}
        </div>
      ))}
    </div>
  );
}

// Requested: this view should show ratings given by BOTH the employee
// (self) and the manager against EACH KRA, not just the two flat overall
// numbers — so the HOD can see exactly what's behind the
// manager's rating before finalising their own.
function HodRow({ q, editable, reload, scale }) {
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [v, setV] = useState(q.hod_rating ?? '');
  const [comment, setComment] = useState(q.hod_comment || '');
  const [saved, setSaved] = useState(null);
  const [err, setErr] = useState(null);
  const ts = useTimesheetRatings(q.employee_id);

  useEffect(() => {
    api(`/pms/hod/queue/${q.employee_id}/kras`).then(setDetail).catch(e => setDetailErr(e.message));
  }, [q.employee_id]);

  const save = async (submit) => {
    setErr(null);
    try {
      await api(`/pms/hod/queue/${q.employee_id}`, { method: 'PUT', body: JSON.stringify({ overall_rating: v === '' ? null : Number(v), comment: comment.trim() || null, submit }) });
      setSaved(submit ? 'Submitted. The rating is locked and goes to HR Calibration.' : 'Saved. You can come back and submit it later.');
      reload();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      {detailErr && <p className="text-xs text-rose-600">{detailErr}</p>}
      {!detail && !detailErr && <p className="text-xs text-navy-400">Loading KRAs…</p>}
      {detail && (
        <div className="space-y-2">
          {!detail.kras.length && <p className="text-xs text-navy-400">No KRAs found for this employee this cycle.</p>}
          {!!detail.kras.length && <TimesheetRatingNote data={ts} />}
          {detail.kras.map(k => {
            const self = detail.self_entries[k.id] && detail.self_entries[k.id].self_rating;
            const mgr = detail.manager_entries[k.id] && detail.manager_entries[k.id].rating;
            const mgrComment = detail.manager_entries[k.id] && detail.manager_entries[k.id].comment;
            return (
              <div key={k.id} className="bg-navy-50 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold flex-1">{k.title}</p>
                  <span className="text-navy-400">{k.weight}%</span>
                </div>
                <div className="flex flex-wrap gap-4">
                  <p>Employee: <b>{grade(self, scale)}</b></p>
                  <p>Manager: <b>{grade(mgr, scale)}</b></p>
                </div>
                <TimesheetRatingChip data={ts} kraId={k.id} />
                {mgrComment && <p className="text-navy-500"><b>Manager's comment:</b> {mgrComment}</p>}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-navy-100">
        <div>
          <p className="text-xs text-navy-500">Manager's overall: <b>{overallLabel(q.manager_rating, scale)}</b></p>
        </div>
        <div className="flex items-center gap-2">
          <label className="lbl mb-0">HOD rating</label>
          {q.hod_status === 'submitted' ? (
            <span className="font-mono text-sm">{overallLabel(q.hod_rating, scale)}</span>
          ) : (
            <input className="inp w-20 text-right inline-block" type="number" step="0.5" min="1" max="5" value={v} onChange={e => setV(e.target.value)} disabled={!editable} />
          )}
        </div>
      </div>
      {q.hod_status !== 'submitted' && editable && (
        <div className="space-y-2">
          <textarea className="inp" rows={2} placeholder="Comment (optional)" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-sec" onClick={() => save(false)}>Save</button>
            <button className="btn-pri" onClick={() => save(true)}>Submit</button>
          </div>
        </div>
      )}
      {q.hod_status === 'submitted' && q.hod_comment && <p className="text-xs text-navy-600"><b>Your comment:</b> {q.hod_comment}</p>}
      {saved && <p className="text-xs text-emerald-700">{saved}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

// The Delivery Head's whole reporting line, then their direct reportees,
// then each manager's team. Every figure is counted on the server.
const PROGRESS = [
  ['kra_approved', 'KRAs approved'], ['self_submitted', 'Self-appraisals'], ['manager_submitted', 'Manager evaluations'], ['hod_submitted', 'Your reviews'],
];
function Bar({ n, of }) {
  const pct = of ? Math.round((n / of) * 100) : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex-1 h-1.5 rounded bg-navy-100 min-w-[60px]"><div className="h-1.5 rounded bg-brand-500" style={{ width: `${pct}%` }} /></div>
      <span className="w-14 text-right text-navy-600">{n} / {of}</span>
    </div>
  );
}
function GroupCard({ g, open, onToggle, people }) {
  const max = Math.max(1, ...g.distribution.map((d) => d.count));
  return (
    <div className="card p-4 space-y-3">
      <button type="button" className="w-full flex flex-wrap items-center gap-2 text-left" onClick={onToggle}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-sm font-semibold text-navy-800 flex-1">{g.title}{g.manager && g.manager.designation ? <span className="font-normal text-navy-400"> · {g.manager.designation}</span> : null}</span>
        <span className="chip bg-navy-50 text-navy-600">{g.headcount} people</span>
        <span className="chip bg-violet-50 text-violet-700">Average {g.avg_grade || '—'}{g.rated ? ` · ${g.rated} rated` : ''}</span>
      </button>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
        {PROGRESS.map(([k, label]) => (
          <div key={k}><p className="text-[11px] text-navy-500">{label}</p><Bar n={g[k]} of={g.headcount} /></div>
        ))}
      </div>
      <div>
        <p className="text-[11px] text-navy-500 mb-1">Ratings</p>
        <div className="flex items-end gap-2 h-16">
          {g.distribution.map((d) => (
            <div key={d.label} className="flex flex-col items-center justify-end flex-1 h-full">
              <span className="text-[10px] text-navy-600">{d.count}</span>
              <div className="w-full rounded-t bg-navy-300" style={{ height: `${(d.count / max) * 70}%`, minHeight: d.count ? 4 : 0 }} />
              <span className="text-[11px] font-semibold text-navy-700">{d.label}</span>
            </div>
          ))}
        </div>
      </div>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
              <th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Manager</th><th className="px-2 py-1.5">KRAs</th>
              <th className="px-2 py-1.5">Self</th><th className="px-2 py-1.5">Manager eval</th><th className="px-2 py-1.5">Your review</th><th className="px-2 py-1.5">Rating</th>
            </tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-b border-navy-50">
                  <td className="px-2 py-1.5 font-semibold text-navy-800">{p.name}{p.is_manager ? <span className="chip bg-navy-50 text-navy-500 ml-1">manager</span> : null}</td>
                  <td className="px-2 py-1.5">{p.manager_name || '—'}</td>
                  <td className="px-2 py-1.5">{p.kra_status || 'none'}</td>
                  <td className="px-2 py-1.5">{p.self_status === 'submitted' ? 'submitted' : (p.self_status || 'not started').replace('_', ' ')}</td>
                  <td className="px-2 py-1.5">{p.manager_status || 'pending'}</td>
                  <td className="px-2 py-1.5">{p.hod_status === 'submitted' ? 'done' : '—'}</td>
                  <td className="px-2 py-1.5 font-semibold">{p.final_grade || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function TeamAnalysis() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { api('/pms/hod/team/analysis').then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!d.people.length) return <div className="card p-8 text-center text-sm text-navy-400">Nobody reports to you yet.</div>;
  const byId = new Map(d.people.map((p) => [p.id, p]));
  const below = (managerId) => {
    const out = []; const stack = d.people.filter((p) => p.manager_id === managerId);
    const seen = new Set();
    while (stack.length) { const p = stack.pop(); if (seen.has(p.id)) continue; seen.add(p.id); out.push(p); stack.push(...d.people.filter((x) => x.manager_id === p.id)); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  const membersOf = (g) => (g.key === 'direct' ? d.people.filter((p) => !byId.has(p.manager_id)) : below(g.key));
  const overall = { key: 'overall', title: 'Your whole team', manager: null, ...d.overall };
  return (
    <div className="space-y-3">
      {d.cycle ? <p className="text-xs text-navy-500">{d.cycle.name} · {phaseLabel(d.cycle.phase)} · the rating shown is your review where you have submitted it, else the manager's submitted one.</p>
        : <p className="text-xs text-navy-500">No active cycle — headcount only.</p>}
      {[overall, ...d.groups].map((g) => (
        <GroupCard key={g.key} g={g} open={open === g.key} onToggle={() => setOpen((v) => (v === g.key ? null : g.key))}
          people={g.key === 'overall' ? [...d.people].sort((a, b) => a.name.localeCompare(b.name)) : membersOf(g)} />
      ))}
    </div>
  );
}
