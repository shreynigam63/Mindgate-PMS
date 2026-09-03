import { useEffect, useState } from 'react';
import { Plus, Trash2, Send, CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';
import { api, phaseLabel, phaseColor, DraftBadge } from '../utils/api';

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

// ---------------- Target achievements for the year (BR-2.1/2.2/2.3) --------
// Displayed as "Target achievements for the year". The stored shape stays
// development_plans / development_goals and every route keeps its path —
// the annual review, the manager queue, the completion report and the
// phase-change notification all reference it, and renaming those for a
// wording change would be breaking for no user-visible gain.
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
        <p className="font-bold text-sm flex-1">Target achievements for the year</p>
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

// AI development-plan suggestions, drawn from the employee's own approved
// KRAs. Lives inside GoalList because that is where setGoals is — a
// suggestion is only useful if it can be dropped straight into the editor,
// and lifting the panel out would mean plumbing a callback back down for
// no gain.
function DevPlanAiPanel({ onAdd }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);

  const ask = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api('/agentic/devplan-suggest', { method: 'POST' })); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const d = res && res.draft;

  return (
    <div className="space-y-2">
      <div className="bg-gradient-to-r from-teal-50 to-cyan-50 border border-teal-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-teal-800">+ Suggest goals from my KRAs</p>
          <p className="text-[11px] text-navy-500">Reads the KRAs you are accountable for this cycle and proposes development goals that build the capability each one needs.</p>
        </div>
        <button className="btn-pri !bg-teal-700" disabled={busy} onClick={ask}>
          <Sparkles size={13} className="inline mr-1" />{busy ? 'Thinking…' : 'Suggest goals'}
        </button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {d && (
        <div className="bg-navy-800 text-slate-100 rounded-lg p-3 text-[11px] space-y-3">
          <DraftBadge />
          {(d.suggested_goals || []).map((g, i) => (
            <div key={i} className="border border-navy-600 rounded-lg p-2.5 space-y-1">
              <p className="font-semibold text-sm">{g.title}</p>
              {g.serves_kra && <p className="text-teal-300">Serves KRA: {g.serves_kra}</p>}
              {g.why && <p>{g.why}</p>}
              {g.how_to_measure && <p className="text-slate-300">Evidence of progress: {g.how_to_measure}</p>}
              {g.suggested_timeline && <p className="text-slate-400">Suggested timeline: {g.suggested_timeline}</p>}
              <button className="btn-sec !bg-navy-700 !text-white !border-navy-600 !text-[11px] !py-1"
                onClick={() => onAdd(g)}>Add as goal (then edit)</button>
            </div>
          ))}
          {(d.uncovered_kras || []).length > 0 && <p className="text-amber-300">KRAs with no development goal yet: {d.uncovered_kras.join(' · ')}</p>}
          {(d.already_covered || []).length > 0 && <p className="text-slate-400">Already covered: {d.already_covered.join(' · ')}</p>}
          {(d.gaps || []).length > 0 && <p className="text-slate-400">Input gaps: {d.gaps.join(' · ')}</p>}
        </div>
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
    // Checked here as well as on the server so the employee is told which
    // goals need a date without a round trip. The server check is the one
    // that actually enforces it — this is only to answer faster.
    const titled = goals.filter(g => (g.title || '').trim());
    const undated = titled.filter(g => !(g.target_date || '').trim());
    if (undated.length) {
      setErr(`Add a target date to ${undated.length === 1 ? 'this goal' : `these ${undated.length} goals`} before saving: ${undated.map(g => g.title.trim()).join(', ')}`);
      return;
    }
    if (!titled.length) { setErr('Add at least one goal with a title.'); return; }
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
            {/* The target date was always saved and returned; this view just
                never drew it, while the manager's view of the same goals did
                — so the person who set the date was the one who could not
                see it. Same "Target: <date>" format as that view. */}
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold flex-1">{g.title}</p>
              {g.target_date
                ? <span className="text-navy-400 shrink-0">Target: {new Date(g.target_date).toLocaleDateString()}</span>
                : <span className="text-amber-600 shrink-0">No target date</span>}
            </div>
            {g.description && <p className="text-navy-500">{g.description}</p>}
            <ProgressBar value={g.progress_pct} onChange={(v) => setProgress(g.id, v)} />
          </div>
        ))}
      </div>
    );
  }

  // The suggestion's timeline is prose the model chose ("by end of Q3",
  // "within 6 months"), not a date. It is carried into the description so
  // it is not lost, and deliberately NOT parsed into target_date: turning
  // vague wording into a hard deadline would invent precision the model
  // never gave and silently commit the employee to a date nobody picked.
  // The date field is left empty and required, so it is a conscious choice.
  const addSuggested = (g) => setGoals((gs) => [...gs, {
    title: g.title || '',
    description: [
      g.why,
      g.how_to_measure ? `Evidence of progress: ${g.how_to_measure}` : null,
      g.suggested_timeline ? `Suggested timeline: ${g.suggested_timeline} — set a target date above.` : null,
    ].filter(Boolean).join('\n\n'),
    target_date: '', progress_pct: 0,
  }]);

  return (
    <div className="space-y-3">
      <DevPlanAiPanel onAdd={addSuggested} />
      <p className="text-[11px] text-navy-400">Added suggestions arrive as editable goals — set a <b>target date</b> on each, then press <b>Save goals</b>, then submit for approval.</p>
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
            <label className="lbl">Target date <span className="text-rose-600">*</span></label>
            <input className={`inp w-full ${!(g.target_date || '') ? '!border-rose-300 !bg-rose-50/50' : ''}`}
              type="date" required value={g.target_date || ''} onChange={e => update(i, 'target_date', e.target.value)} />
            {!(g.target_date || '') && <p className="text-[11px] text-rose-600 mt-1">Required before this goal can be saved.</p>}
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

// ---------------- Aspiring Career (BR-3.1/3.2) ------------------------------
// Displayed as "Aspiring Career"; the table, API fields and route all still
// say career_path/people.career_paths. Renaming only the label was
// deliberate — the stored shape is referenced by the annual review, the
// team overview and the HR pathing matrix, and churning those for a
// wording change would be a breaking change for no user-visible gain.
// AI aspiring-career suggestions. Constrained server-side to the
// transitions HR configured from the employee's current role, so anything
// it proposes is a role the select below will actually accept.
function CareerAiPanel({ onUse }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const ask = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api('/agentic/career-suggest', { method: 'POST' })); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const d = res && res.draft;

  return (
    <div className="space-y-2">
      <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-indigo-800">+ Where could I aim next?</p>
          <p className="text-[11px] text-navy-500">Reads your designation and department against the career paths HR has configured, and suggests what a one-to-two year aspiration could look like.</p>
        </div>
        <button className="btn-pri !bg-indigo-700" disabled={busy} onClick={ask}>
          <Sparkles size={13} className="inline mr-1" />{busy ? 'Thinking…' : 'Suggest a path'}
        </button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {d && (
        <div className="bg-navy-800 text-slate-100 rounded-lg p-3 text-[11px] space-y-3">
          <DraftBadge />
          {d.no_path_configured && <p className="text-amber-300">No career path is configured from your current role yet — HR needs to define one in the Career Pathing Matrix.</p>}
          {(d.aspirations || []).map((a, i) => (
            <div key={i} className="border border-navy-600 rounded-lg p-2.5 space-y-1">
              <p className="font-semibold text-sm">{a.target_role}</p>
              {a.fit && <p>{a.fit}</p>}
              {a.typical_time && <p className="text-indigo-300">Typical time: {a.typical_time}</p>}
              {(a.competencies_to_build || []).length > 0 && (
                <div><p className="text-slate-300 font-semibold">Competencies to build</p>
                  <ul className="list-disc pl-4">{a.competencies_to_build.map((c, n) => <li key={n}>{c}</li>)}</ul></div>
              )}
              {(a.first_steps || []).length > 0 && (
                <div><p className="text-slate-300 font-semibold">Start this cycle</p>
                  <ul className="list-disc pl-4">{a.first_steps.map((c, n) => <li key={n}>{c}</li>)}</ul></div>
              )}
              {(a.suggested_milestones || []).length > 0 && (
                <div><p className="text-slate-300 font-semibold">Milestones to track</p>
                  <ul className="list-disc pl-4">{a.suggested_milestones.map((m, n) => (
                    <li key={n}>{m.title}{m.description && <span className="text-slate-400"> — {m.description}</span>}</li>
                  ))}</ul></div>
              )}
              <button className="btn-sec !bg-navy-700 !text-white !border-navy-600 !text-[11px] !py-1"
                onClick={() => onUse(a)}>Use this (then edit)</button>
            </div>
          ))}
          {(d.notes || []).length > 0 && <p className="text-slate-400">{d.notes.join(' · ')}</p>}
        </div>
      )}
    </div>
  );
}

// Why the target-role list is empty. Deterministic and shown above the AI
// panel: an empty list has several causes and only one of them is "HR has
// not set this up". Saying "nothing is configured" when a transition
// exists but was excluded on level sent people looking for a row that was
// already there.
function CareerPathGap({ d }) {
  if (!d || d.reason === 'ok') return null;

  if (d.reason === 'level_mismatch') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs space-y-1.5">
        <p className="font-bold text-amber-800">A career path exists for your role, but it does not match your level</p>
        <p className="text-navy-600">
          The matrix has {d.excluded_by_level.length === 1 ? 'a transition' : `${d.excluded_by_level.length} transitions`} from
          <b> {d.designation}</b>, but {d.excluded_by_level.length === 1 ? 'it is' : 'they are'} restricted to a level that
          does not match your role band {d.role_band ? <>(<b>{d.role_band}</b>)</> : <>(<b>not set on your record</b>)</>}.
        </p>
        <ul className="list-disc pl-4 text-navy-500">
          {d.excluded_by_level.map((t, i) => (
            <li key={i}>→ {t.to_role} — requires level <b>{t.requires_level}</b></li>
          ))}
        </ul>
        <p className="text-navy-600">
          Ask HR to either clear the level on that transition (blank means <i>any level</i>) or correct your role band.
        </p>
      </div>
    );
  }
  if (d.reason === 'all_inactive') {
    return <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
      <p className="font-bold text-amber-800">The career path from your role is deactivated</p>
      <p className="text-navy-600">{d.inactive} transition{d.inactive === 1 ? ' is' : 's are'} configured from <b>{d.designation}</b> but switched off. Ask HR to reactivate.</p>
    </div>;
  }
  if (d.reason === 'no_designation') {
    return <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
      <p className="font-bold text-amber-800">Your designation is not set</p>
      <p className="text-navy-600">Career paths are matched on designation, so nothing can be suggested until HR completes your record.</p>
    </div>;
  }
  return <div className="bg-navy-50 border border-navy-100 rounded-xl p-3 text-xs">
    <p className="font-bold text-navy-700">No career path configured yet</p>
    <p className="text-navy-500">Nothing has been defined from <b>{d.designation}</b> in the Career Pathing Matrix. Ask HR to add one.</p>
  </div>;
}

function CareerPathCard() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ target_role: '', target_timeline: '', plan: '' });
  const [milestones, setMilestones] = useState([]);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const load = () => api('/people/career/my-path').then(r => {
    setData(r);
    setForm({ target_role: r.path?.target_role || '', target_timeline: r.path?.target_timeline || '', plan: r.path?.plan || '' });
    setMilestones((r.milestones || []).map(m => ({ ...m, target_date: m.target_date ? String(m.target_date).slice(0, 10) : '' })));
  }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  // The path is saved FIRST: milestones hang off it, so on the very first
  // save there is no row for them to attach to until this lands.
  const save = async () => {
    setErr(null); setSaved(false);
    if (!form.target_role.trim()) { setErr('A target role is required.'); return; }
    const missingDate = milestones.findIndex(m => m.title.trim() && !m.target_date);
    if (missingDate >= 0) { setErr(`Milestone ${missingDate + 1} needs a target date.`); return; }
    try {
      await api('/people/career/my-path', { method: 'PUT', body: JSON.stringify(form) });
      await api('/people/career/my-milestones', {
        method: 'PUT',
        body: JSON.stringify({ milestones: milestones.filter(m => m.title.trim()) }),
      });
      setSaved(true); load();
    } catch (e) { setErr(e.message); }
  };

  // Progress is NOT phase-gated — it happens all year, and a gate would
  // mean marking something done months after you did it.
  const setProgress = async (id, pct) => {
    try { const r = await api(`/people/career/my-milestones/${id}/progress`, { method: 'PUT', body: JSON.stringify({ progress_pct: pct }) });
      setData(d => ({ ...d, progress_pct: r.progress_pct }));
      setMilestones(ms => ms.map(m => (m.id === id ? { ...m, progress_pct: pct } : m)));
    } catch (e) { setErr(e.message); }
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
        <p className="font-bold text-sm flex-1">Aspiring Career</p>
        {data.cycle_phase && <span className={`chip ${phaseColor(data.cycle_phase)}`}>{phaseLabel(data.cycle_phase)}</span>}
      </div>
      <CareerPathGap d={data.path_diagnostics} />
      {editable && <CareerAiPanel onUse={(a) => {
        setForm((fm) => ({
          target_role: a.target_role || fm.target_role,
          target_timeline: a.typical_time || fm.target_timeline,
          plan: [a.fit, (a.competencies_to_build || []).length ? `Competencies to build:\n- ${a.competencies_to_build.join('\n- ')}` : null,
                 (a.first_steps || []).length ? `First steps:\n- ${a.first_steps.join('\n- ')}` : null].filter(Boolean).join('\n\n'),
        }));
        // Suggested milestones land as editable drafts with no date —
        // a date is required to save, so the employee has to commit to
        // one rather than accept whatever the model would have guessed.
        if ((a.suggested_milestones || []).length) {
          setMilestones((ms) => [...ms, ...a.suggested_milestones.map((m) => ({
            title: m.title, description: m.description || '', target_date: '', progress_pct: 0,
          }))]);
        }
      }} />}
      {editable && <p className="text-[11px] text-navy-400">Unsaved until you press <b>Save</b>.</p>}
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

      {/* Milestones are what make this a plan rather than an aspiration:
          the steps towards the role, each with a date and a progress
          figure. Progress stays editable outside Growth Planning, because
          progress happens all year. */}
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <label className="lbl mb-0 flex-1">Milestones towards this role</label>
          {data.progress_pct != null && <span className="text-[11px] font-semibold text-teal-700">{data.progress_pct}% overall</span>}
        </div>
        {!milestones.length && <p className="text-[11px] text-navy-400">No milestones yet — add the steps you'll take, so progress is something you can point at.</p>}
        {milestones.map((m, i) => (
          <div key={m.id || `new-${i}`} className="border border-navy-100 rounded-lg p-2 space-y-1">
            <div className="flex gap-2">
              <input className="inp flex-1" placeholder="Milestone *" value={m.title || ''} disabled={!editable}
                onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input className="inp w-40" type="date" value={m.target_date || ''} disabled={!editable}
                onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, target_date: e.target.value } : x)))} />
              {editable && <button className="text-rose-500" onClick={() => setMilestones(ms => ms.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
            </div>
            <input className="inp text-xs" placeholder="What done looks like" value={m.description || ''} disabled={!editable}
              onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            {m.id && (
              <div className="flex items-center gap-2">
                <input type="range" min="0" max="100" step="5" value={m.progress_pct ?? 0} className="flex-1"
                  onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, progress_pct: Number(e.target.value) } : x)))}
                  onMouseUp={e => setProgress(m.id, Number(e.target.value))}
                  onTouchEnd={e => setProgress(m.id, Number(e.target.value))} />
                <span className="text-[11px] w-10 text-right font-medium">{m.progress_pct ?? 0}%</span>
              </div>
            )}
          </div>
        ))}
        {editable && (
          <button className="btn-sec !py-1 !text-[11px]"
            onClick={() => setMilestones(ms => [...ms, { title: '', description: '', target_date: '', progress_pct: 0 }])}>
            <Plus size={12} className="inline mr-1" />Add milestone
          </button>
        )}
        {!editable && milestones.length > 0 && <p className="text-[11px] text-navy-400">Milestone text is editable in Growth Planning — progress can be updated any time.</p>}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {editable ? (
        <>
          <button className="btn-pri" onClick={save}>Save</button>
          {saved && <span className="text-[11px] text-emerald-600 font-medium ml-2">Saved ✓</span>}
        </>
      ) : (
        <p className="text-xs text-navy-400">Aspiring Career editing opens in the {phaseLabel('growth_planning')} phase, once HR locks KRAs.</p>
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
      <p className="font-bold text-sm">Team target achievements</p>
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
