import { useEffect, useState } from 'react';
import { Plus, Trash2, Send, CheckCircle2, RotateCcw } from 'lucide-react';
import { api, phaseLabel, phaseColor } from '../utils/api';

const STATUS_COLOR = {
  draft: 'bg-slate-100 text-navy-600',
  submitted: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  returned: 'bg-rose-100 text-rose-700',
};

export default function MyGrowthPage() {
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <h2 className="text-lg font-bold">My Growth</h2>
      <div className="grid lg:grid-cols-2 gap-4">
        <DevelopmentPlanCard />
        <CareerPathCard />
      </div>
      <TeamDevelopmentPlans />
    </div>
  );
}

// ---------------- Development Plan (BR-2.1/2.2/2.3) ------------------------
function DevelopmentPlanCard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/my/development-plan').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className="card p-4"><p className="text-sm text-navy-400">Loading…</p></div>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const editable = data.plan.status === 'draft' || data.plan.status === 'returned';

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p className="font-bold text-sm flex-1">Development Plan</p>
        <span className={`chip ${STATUS_COLOR[data.plan.status]}`}>{data.plan.status}</span>
      </div>
      {data.plan.status === 'returned' && data.plan.manager_comment && (
        <p className="text-xs bg-rose-50 text-rose-700 rounded-lg p-2"><b>Returned:</b> {data.plan.manager_comment}</p>
      )}
      <GoalList goals={data.goals} editable={editable} onSaved={load} />
      {editable && (
        <button className="btn-pri" disabled={!data.goals.length} onClick={async () => {
          try { await api('/pms/my/development-plan/submit', { method: 'POST' }); load(); }
          catch (e) { setErr(e.message); }
        }}><Send size={13} className="inline mr-1" />Submit for approval</button>
      )}
    </div>
  );
}

function GoalList({ goals: initial, editable, onSaved }) {
  const [goals, setGoals] = useState(initial);
  const [err, setErr] = useState(null);
  useEffect(() => { setGoals(initial); }, [initial]);

  const update = (i, field, value) => setGoals(gs => gs.map((g, j) => j === i ? { ...g, [field]: value } : g));
  const remove = (i) => setGoals(gs => gs.filter((_, j) => j !== i));
  const add = () => setGoals(gs => [...gs, { title: '', description: '', target_date: '', progress_pct: 0 }]);

  const saveAll = async () => {
    setErr(null);
    try { await api('/pms/my/development-plan/goals', { method: 'PUT', body: JSON.stringify({ goals }) }); onSaved(); }
    catch (e) { setErr(e.message); }
  };
  const setProgress = async (goalId, pct) => {
    try { await api(`/pms/my/development-plan/goals/${goalId}/progress`, { method: 'PUT', body: JSON.stringify({ progress_pct: pct }) }); onSaved(); }
    catch (e) { setErr(e.message); }
  };

  if (!editable) {
    return (
      <div className="space-y-2">
        {!goals.length && <p className="text-xs text-navy-400">No development goals recorded.</p>}
        {goals.map(g => (
          <div key={g.id} className="text-xs bg-navy-50 rounded-lg p-2 space-y-1">
            <p className="font-semibold">{g.title}</p>
            {g.description && <p className="text-navy-500">{g.description}</p>}
            <ProgressBar value={g.progress_pct} onChange={(v) => setProgress(g.id, v)} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {goals.map((g, i) => (
        <div key={g.id || i} className="border border-navy-100 rounded-xl p-3.5 space-y-3 bg-white">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <label className="lbl">Goal title</label>
              <input className="inp w-full font-medium" placeholder="e.g. Cloud Architecture Certification"
                value={g.title} onChange={e => update(i, 'title', e.target.value)} />
            </div>
            <button className="btn-sec !p-1.5 mt-6 shrink-0" onClick={() => remove(i)} title="Remove goal"><Trash2 size={13} /></button>
          </div>
          <div className="max-w-[200px]">
            <label className="lbl">Target date</label>
            <input className="inp w-full" type="date" value={g.target_date || ''} onChange={e => update(i, 'target_date', e.target.value)} />
          </div>
          <div>
            <label className="lbl">Description (optional)</label>
            <textarea className="inp w-full" rows={4} placeholder="Add detail — what you'll do, resources you'll use, milestones along the way. Paste as much as you need."
              value={g.description || ''} onChange={e => update(i, 'description', e.target.value)} />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button className="btn-sec" onClick={add}><Plus size={13} className="inline mr-1" />Add goal</button>
        <button className="btn-pri" onClick={saveAll}>Save goals</button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

function ProgressBar({ value, onChange, readOnly }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-navy-100 rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${value}%` }} />
      </div>
      {readOnly ? (
        <span className="text-xs font-medium text-navy-500 w-10 text-right">{value}%</span>
      ) : (
        <>
          <input className="inp w-16 !py-0.5 text-right" type="number" min="0" max="100" value={value}
            onChange={e => onChange(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
          <span className="text-[10px] text-navy-400">%</span>
        </>
      )}
    </div>
  );
}

// ---------------- Career Path (BR-3.1/3.2) ----------------------------------
function CareerPathCard() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ target_role: '', target_timeline: '', plan: '' });
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const load = () => api('/people/career/my-path').then(r => { setData(r); setForm({ target_role: r.path?.target_role || '', target_timeline: r.path?.target_timeline || '', plan: r.path?.plan || '' }); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setErr(null); setSaved(false);
    if (!form.target_role.trim()) { setErr('A target role is required.'); return; }
    try { await api('/people/career/my-path', { method: 'PUT', body: JSON.stringify(form) }); setSaved(true); load(); }
    catch (e) { setErr(e.message); }
  };

  if (err && !data) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className="card p-4"><p className="text-sm text-navy-400">Loading…</p></div>;

  // Fix guide item #6 follow-up: Career Path now opens alongside
  // Development Plan once HR locks KRA and advances to Growth Planning,
  // per the explicit request — previously this card had no phase gate at
  // all and was always editable.
  const editable = data.editable;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p className="font-bold text-sm flex-1">Career Path</p>
        {data.cycle_phase && <span className={`chip ${phaseColor(data.cycle_phase)}`}>{phaseLabel(data.cycle_phase)}</span>}
      </div>
      <div>
        <label className="lbl">Target role</label>
        {data.eligible_target_roles.length ? (
          <select className="inp" value={form.target_role} disabled={!editable} onChange={e => setForm(f => ({ ...f, target_role: e.target.value }))}>
            <option value="">—</option>
            {data.eligible_target_roles.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : (
          <input className="inp" value={form.target_role} disabled={!editable} onChange={e => setForm(f => ({ ...f, target_role: e.target.value }))} placeholder="e.g. Staff Engineer" />
        )}
        {data.eligible_target_roles.length > 0 && <p className="text-[11px] text-navy-400 mt-1">Limited to transitions HR has configured from your current role in the Career Pathing Matrix.</p>}
      </div>
      <div>
        <label className="lbl">Expected timeline</label>
        <input className="inp" value={form.target_timeline} disabled={!editable} onChange={e => setForm(f => ({ ...f, target_timeline: e.target.value }))} placeholder="e.g. 12-18 months" />
      </div>
      <div>
        <label className="lbl">Growth plan</label>
        <textarea className="inp" rows={4} value={form.plan} disabled={!editable} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))} placeholder="How you plan to get there" />
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {editable ? (
        <>
          <button className="btn-pri" onClick={save}>Save</button>
          {saved && <span className="text-[11px] text-emerald-600 font-medium ml-2">Saved ✓</span>}
        </>
      ) : (
        <p className="text-xs text-navy-400">Career Path editing opens in the {phaseLabel('growth_planning')} phase, once HR locks KRAs.</p>
      )}
    </div>
  );
}

// ---------------- Manager view — approve/return reports' plans --------------
// Not part of the BRD's Fig. 5 (that's the employee's own view), but a
// Development Plan stuck at "submitted" with no way to decide it is not a
// usable feature — this closes that loop. Silently hidden for anyone
// without pms_team_eval (the request 403s and the section just doesn't render).
//
// Rebuilt per direct feedback: the manager previously saw only a goal
// count + avg progress with no way to actually read what the employee
// wrote, and "Return with comment" used a native prompt() dialog (an
// ugly browser popup, not part of the page). Now mirrors
// TeamKraSheetsPage.jsx's pattern: expand a report to see every goal in
// full, with the comment box inline on the page itself.
function TeamDevelopmentPlans() {
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = () => api('/pms/team/development-plans').then(setData).catch(() => setData({ cycle: null, plans: [] }));
  useEffect(() => { load(); }, []);

  if (!data || !data.plans?.length) return null;

  return (
    <div className="space-y-2">
      <p className="font-bold text-sm">Team Development Plans</p>
      {data.plans.map(p => (
        <div key={p.id} className="card overflow-hidden">
          <button className="w-full flex items-center justify-between px-4 py-3 text-left" onClick={() => setOpenId(v => v === p.id ? null : p.id)}>
            <span className="text-sm font-semibold flex-1">{p.employee_name}</span>
            <span className="text-xs text-navy-400 mr-2">{p.goal_count} goals · {p.avg_progress}% avg</span>
            <span className={`chip ${STATUS_COLOR[p.status]}`}>{p.status}</span>
          </button>
          {openId === p.id && <TeamPlanDetail plan={p} reload={load} />}
        </div>
      ))}
    </div>
  );
}

function TeamPlanDetail({ plan, reload }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/pms/team/development-plans/${plan.id}/goals`).then(setDetail).catch(e => setErr(e.message));
  }, [plan.id]);

  const decide = async (decision) => {
    if (decision === 'returned' && !comment.trim()) { setErr('A return needs a comment — the employee must know why.'); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/pms/team/development-plans/${plan.id}/decide`, { method: 'POST', body: JSON.stringify({ decision, comment: comment.trim() || null }) });
      reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const canDecide = plan.status === 'submitted';

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      {plan.manager_comment && (
        <div className="bg-navy-50 border border-navy-100 rounded-lg p-3 text-xs">
          <p className="font-bold text-navy-500 uppercase text-[10px]">Your last comment</p>
          <p>{plan.manager_comment}</p>
        </div>
      )}
      {!detail && !err && <p className="text-xs text-navy-400">Loading goals…</p>}
      {detail && (
        <div className="space-y-2">
          {!detail.goals.length && <p className="text-xs text-navy-400">No goals added yet.</p>}
          {detail.goals.map(g => (
            <div key={g.id} className="bg-navy-50 rounded-lg p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold flex-1">{g.title}</p>
                {g.target_date && <span className="text-navy-400">Target: {new Date(g.target_date).toLocaleDateString()}</span>}
              </div>
              {g.description && <p className="text-navy-600">{g.description}</p>}
              <ProgressBar value={g.progress_pct} onChange={() => {}} readOnly />
            </div>
          ))}
        </div>
      )}
      {canDecide && (
        <div className="space-y-2">
          <textarea className="inp" rows={2} placeholder="Comment (required if returning)" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button className="btn-pri" disabled={busy} onClick={() => decide('approved')}><CheckCircle2 size={13} className="inline mr-1" />Approve</button>
            <button className="btn-sec" disabled={busy} onClick={() => decide('returned')}><RotateCcw size={13} className="inline mr-1" />Return for edits</button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
