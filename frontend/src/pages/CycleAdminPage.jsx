import { useEffect, useState } from 'react';
import { Plus, ArrowRight, RotateCcw, Rocket, Activity, Sparkles, Trash2, Save, X, Info, History, ChevronDown, ChevronUp } from 'lucide-react';
import { api, PHASES, phaseLabel, phaseColor, DraftBadge } from '../utils/api';

export default function CycleAdminPage() {
  const [cycles, setCycles] = useState(null);
  const [err, setErr] = useState(null);
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api('/pms/cycles').then(r => setCycles(r.cycles)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const [showNew, setShowNew] = useState(false);
  // Requested: a dedicated view of each cycle's OWN history. pms.audit_log
  // already records every one of these events with who/when — this is
  // purely a new read + display, nothing about how events get logged
  // changes.
  const [openActivity, setOpenActivity] = useState(null);
  const [activity, setActivity] = useState({});
  const toggleActivity = async (c) => {
    if (openActivity === c.id) { setOpenActivity(null); return; }
    setOpenActivity(c.id);
    if (!activity[c.id]) {
      try { const r = await api(`/pms/cycles/${c.id}/activity`); setActivity(a => ({ ...a, [c.id]: r.events })); }
      catch (e) { setActivity(a => ({ ...a, [c.id]: { error: e.message } })); }
    }
  };
  const phase = async (c, to, rollback) => {
    setErr(null);
    try { await api(`/pms/cycles/${c.id}/phase`, { method: 'POST', body: JSON.stringify({ to, rollback }) }); load(); }
    catch (e) { setErr(e.message); }
  };
  const publish = async () => {
    if (!confirm('Publish ratings to all employees? This writes performance history and notifies everyone rated.')) return;
    setBusy(true); setErr(null);
    try {
      const r = await api('/pms/publish', { method: 'POST' });
      alert(`Published: ${r.published}. ${r.failures.length ? `Failed: ${r.failures.length} — ` + r.failures.slice(0, 3).map(f => f.reason).join('; ') : ''}`);
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const cycleHealth = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/agentic/cycle-health', { method: 'POST' }); setHealth(r); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // Fix guide item #2: backend already supported cancel (POST .../phase
  // with { cancel: true }, guarded by phase-machine's canCancel()) — this
  // was purely a missing button, no server change needed.
  const cancelCycle = async (c) => {
    if (!confirm(`Cancel "${c.name}"? This cannot be undone — the cycle moves to Cancelled and can no longer be advanced.`)) return;
    setErr(null);
    try { await api(`/pms/cycles/${c.id}/phase`, { method: 'POST', body: JSON.stringify({ cancel: true }) }); load(); }
    catch (e) { setErr(e.message); }
  };
  // Lets a cycle created under an earlier default (e.g. the old 6-grade
  // A+/A/B+/B/C/D scale) actually switch to the current one — otherwise
  // narrowing the DEFAULT only affects brand new cycles, leaving anything
  // already in progress stuck on whatever it started with.
  const resetRatingScale = async (c) => {
    if (!confirm(`Reset "${c.name}"'s rating scale to the current default (A+, A, B+, B, C)? Any ratings already entered on the old scale will keep their number, just re-labelled.`)) return;
    setErr(null);
    try {
      await api(`/pms/cycles/${c.id}/rating-scale`, {
        method: 'PUT',
        body: JSON.stringify({
          rating_scale: [{ value: 5, label: 'A+' }, { value: 4, label: 'A' }, { value: 3, label: 'B+' }, { value: 2, label: 'B' }, { value: 1, label: 'C' }],
          bell_curve: { '5': 5, '4': 15, '3': 35, '2': 30, '1': 15 },
        }),
      });
      load();
    } catch (e) { setErr(e.message); }
  };

  if (err && !cycles) return <p className="text-sm text-rose-600">{err}</p>;
  if (!cycles) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Appraisal Cycles</h2>
        <button className="btn-pri" onClick={() => setShowNew(true)}><Plus size={13} className="inline mr-1" />New cycle</button>
        <button className="btn-sec" disabled={busy} onClick={cycleHealth}><Activity size={13} className="inline mr-1" />{busy ? 'Working…' : 'Cycle health (agent)'}</button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {health?.draft && (
        <div className="bg-navy-800 text-slate-100 rounded-xl p-4 text-xs space-y-2">
          <div className="flex items-center gap-2"><Sparkles size={13} className="text-amber-300" /><DraftBadge /></div>
          <p className="text-sm font-semibold">{health.draft.headline}</p>
          {health.draft.bottleneck && <p><b>Bottleneck:</b> {health.draft.bottleneck}</p>}
          {(health.draft.chase_this_week || []).map((c, i) => <p key={i}>→ {c}</p>)}
          {(health.draft.caveats || []).length > 0 && <p className="text-navy-400">Caveats: {health.draft.caveats.join(' · ')}</p>}
        </div>
      )}
      {cycles.map(c => {
        const i = PHASES.indexOf(c.phase);
        const next = i >= 0 && i < PHASES.length - 1 ? PHASES[i + 1] : null;
        const prev = i > 0 ? PHASES[i - 1] : null;
        return (
          <div key={c.id} className="card p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-bold flex-1">{c.name} <span className="text-navy-400 font-normal">· {c.fiscal_year} · {c.cycle_type}</span></p>
              <span className={`chip ${phaseColor(c.phase)}`}>{phaseLabel(c.phase)}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {PHASES.map((p, j) => (
                <span key={p} className={`px-2 py-1 rounded ${j < i ? 'bg-emerald-50 text-emerald-600' : j === i ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-400'}`}>{phaseLabel(p)}</span>
              ))}
            </div>
            {!['closed', 'cancelled'].includes(c.phase) && (
              <div className="flex flex-wrap gap-2">
                {next && <button className="btn-pri" onClick={() => phase(c, next, false)}><ArrowRight size={13} className="inline mr-1" />Advance to {phaseLabel(next)}</button>}
                {prev && <button className="btn-sec" onClick={() => phase(c, prev, true)}><RotateCcw size={13} className="inline mr-1" />Roll back to {phaseLabel(prev)}</button>}
                {c.phase === 'publish' && <button className="btn-pri !bg-emerald-700" disabled={busy} onClick={publish}><Rocket size={13} className="inline mr-1" />Publish ratings</button>}
                {(c.rating_scale || []).some(s => s.value === 6) && (
                  <button className="btn-sec" onClick={() => resetRatingScale(c)}>Update to 5-grade scale (A+-C)</button>
                )}
                <button className="btn-sec !text-rose-600 !border-rose-200" onClick={() => cancelCycle(c)}><Trash2 size={13} className="inline mr-1" />Cancel cycle</button>
              </div>
            )}
            <button className="text-[11px] text-navy-400 flex items-center gap-1" onClick={() => toggleActivity(c)}>
              <History size={12} />{openActivity === c.id ? 'Hide activity' : 'View activity'}
              {openActivity === c.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {openActivity === c.id && <CycleActivity events={activity[c.id]} />}
          </div>
        );
      })}
      {!cycles.length && <div className="card p-8 text-center text-sm text-navy-400">No cycles yet. Create one to begin — it starts in Draft; advance to KRA Setting when ready.</div>}
      <ReviewParametersConfig />
      {showNew && <NewCycleModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
    </div>
  );
}

// Replaces three sequential prompt() dialogs (browser popups, not part of
// the page) with a proper in-page form, per a direct request with a
// mockup. The "Defaults applied" box shows the actual A+/A/B+/B/C/D
// letter-grade scale new cycles are created with (per a follow-up request
// to make this real, not just cosmetic) — see the rating_scale default in
// POST /cycles and rating-rules.js's updated Super 50 comment for how the
// rest of the app was kept consistent with the wider 1-6 scale this
// introduced.
// Readable labels for every audit() action currently written anywhere in
// the app (checked directly against the source, not guessed) — anything
// added later without a mapping still shows sensibly via the fallback
// (SNAKE_CASE -> "Snake case").
const ACTION_LABELS = {
  CYCLE_CREATED: 'Cycle created', CYCLE_PUBLISHED: 'Cycle published', CYCLE_RATING_SCALE_UPDATED: 'Rating scale updated',
  PHASE_ADVANCE: 'Phase advanced', PHASE_ROLLBACK: 'Phase rolled back', CYCLE_CANCELLED: 'Cycle cancelled',
  KRA_BULK_UPLOAD: 'KRA bulk upload', KRA_SUBMITTED: 'KRA submitted', KRA_SUBMITTED_ON_BEHALF: 'KRA submitted on behalf',
  KRA_ENTERED_ON_BEHALF: 'KRA entered on behalf', KRA_TITLES_CLEANED: 'KRA titles cleaned up',
  DEVPLAN_SUBMITTED: 'Target achievements submitted', SELF_APPRAISAL_SUBMITTED: 'Self-Appraisal submitted',
  MANAGER_EVAL_SUBMITTED: 'Manager Evaluation submitted', HOD_EVAL_SUBMITTED: 'Delivery Head Review submitted',
  HOD_QUEUE_RESEEDED: 'HOD queue re-seeded', MIDYEAR_SELF_SUBMITTED: 'Mid-Year self sign-off', MIDYEAR_MANAGER_SUBMITTED: 'Mid-Year manager sign-off',
  PARAMETER_SCORES_UPDATED: '7-parameter scores updated', REVIEW_PARAMETERS_UPDATED: 'Review parameters updated',
  RATING_ADJUSTED: 'Rating adjusted (Calibration)', PIP_AUTO_OPENED: 'PIP auto-opened', PIP_THRESHOLD_SET: 'PIP threshold set',
  RETENTION_ALERT_SENT: 'Retention alert sent', SUPER50_FLAGGED: 'Flagged on Super 50', SUPER50_UNFLAGGED: 'Removed from Super 50',
  CONNECT_LOGGED: 'Connect logged', CONNECT_SIGNED_OFF: 'Connect signed off', CONNECT_REMINDERS_CHECKED: 'Connect reminders checked',
  CLOSURE_LETTER_GENERATED: 'Closure letter generated',
};
function actionLabel(a) { return ACTION_LABELS[a] || a.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()); }

function CycleActivity({ events }) {
  if (!events) return <p className="text-xs text-navy-400 pl-1">Loading…</p>;
  if (events.error) return <p className="text-xs text-rose-600 pl-1">{events.error}</p>;
  if (!events.length) return <p className="text-xs text-navy-400 pl-1">No recorded activity for this cycle yet.</p>;
  return (
    <div className="bg-navy-50 rounded-lg p-3 space-y-1.5 max-h-64 overflow-y-auto">
      {events.map((e, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px]">
          <span className="text-navy-400 shrink-0 w-32">{new Date(e.at).toLocaleString()}</span>
          <span className="font-semibold text-navy-700 shrink-0">{actionLabel(e.action)}</span>
          <span className="text-navy-400">— {e.actor_email || 'system'}{e.employee_name ? ` · ${e.employee_name}` : ''}</span>
          {e.details && (e.details.from || e.details.to) && (
            <span className="text-navy-400">({e.details.from ?? '—'} → {e.details.to ?? '—'})</span>
          )}
        </div>
      ))}
    </div>
  );
}

function NewCycleModal({ onClose, onCreated }) {
  const thisYear = new Date().getFullYear();
  const defaultFY = `FY${String(thisYear).slice(-2)}-${String(thisYear + 1).slice(-2)}`;
  const [fiscalYear, setFiscalYear] = useState(defaultFY);
  const [cycleType, setCycleType] = useState('annual');
  const [name, setName] = useState(`Annual Appraisal ${defaultFY}`);
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [startsAt, setStartsAt] = useState(today);
  const [endsAt, setEndsAt] = useState(nextYear);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Suggests a sensible cycle name from Fiscal Year + Type, but only
  // until the person actually edits the name field themselves — matches
  // the mockup's "Annual Appraisal FY26-27" auto-filled from the fields
  // above it, without fighting a manual edit afterwards.
  useEffect(() => {
    if (nameTouched) return;
    setName(`${cycleType === 'midyear' ? 'Mid-Year Review' : 'Annual Appraisal'} ${fiscalYear}`);
  }, [fiscalYear, cycleType, nameTouched]);

  const create = async () => {
    if (!name.trim() || !fiscalYear.trim()) { setErr('Cycle name and fiscal year are required.'); return; }
    setBusy(true); setErr(null);
    try {
      await api('/pms/cycles', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), fiscal_year: fiscalYear.trim(), cycle_type: cycleType,
          description: description.trim() || null, opens_at: startsAt || null, closes_at: endsAt || null,
        }),
      });
      onCreated();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-900/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-100">
          <p className="text-base font-bold">New PMS Cycle</p>
          <button className="text-navy-400 hover:text-navy-600" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="lbl">Fiscal Year</label>
              <input className="inp" value={fiscalYear} onChange={e => setFiscalYear(e.target.value)} placeholder="e.g. FY26-27" />
            </div>
            <div>
              <label className="lbl">Type</label>
              <select className="inp" value={cycleType} onChange={e => setCycleType(e.target.value)}>
                <option value="annual">Annual</option>
                <option value="midyear">Mid-Year</option>
              </select>
            </div>
          </div>
          <div>
            <label className="lbl">Cycle Name</label>
            <input className="inp" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} placeholder="e.g. Annual Appraisal FY26-27" />
          </div>
          <div>
            <label className="lbl">Description (optional)</label>
            <textarea className="inp" rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief note about this cycle" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="lbl">Starts</label>
              <input className="inp" type="date" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
            </div>
            <div>
              <label className="lbl">Ends</label>
              <input className="inp" type="date" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
            </div>
          </div>
          <div className="bg-navy-50 rounded-xl p-3 text-xs text-navy-500 space-y-1">
            <p className="flex items-center gap-1.5 font-semibold text-navy-600"><Info size={13} />Defaults applied</p>
            <p><b>Rating scale:</b> A+, A, B+, B, C</p>
            <p><b>Bell curve:</b> A+ 5% · A 15% · B+ 35% · B 30% · C 15%</p>
            <p className="text-navy-400">These can be adjusted after creation.</p>
          </div>
          {err && <p className="text-xs text-rose-600">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-navy-100">
          <button className="btn-sec" onClick={onClose}>Cancel</button>
          <button className="btn-pri" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create cycle'}</button>
        </div>
      </div>
    </div>
  );
}

// BR-6.2: "HR can configure the 7 organisational parameters and their
// weightings used to arrive at the final rating." Weights must sum to
// exactly 100 to save — same rule as KRA weights (phase-machine's
// weightsValid, enforced server-side; mirrored here so the Save button
// disables before a doomed request round-trips.
function ReviewParametersConfig() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const load = () => api('/pms/review-parameters').then(r => setRows(r.parameters.map(p => ({ ...p, weight_pct: String(p.weight_pct) })))).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err && !rows) return <p className="text-xs text-rose-600">{err}</p>;
  if (!rows) return <p className="text-sm text-navy-400">Loading…</p>;

  const total = rows.reduce((s, r) => s + (Number(r.weight_pct) || 0), 0);
  const validTotal = Math.abs(total - 100) < 0.01;
  const blankCount = rows.filter(r => !r.name.trim()).length;

  const update = (i, field, value) => setRows(rs => rs.map((r, j) => j === i ? { ...r, [field]: value } : r));
  const remove = (i) => setRows(rs => rs.filter((_, j) => j !== i));
  const add = () => setRows(rs => [...rs, { name: '', weight_pct: '0' }]);

  const save = async () => {
    setErr(null); setSaved(false);
    if (rows.some(r => !r.name.trim())) { setErr('Every parameter needs a name — see the rows highlighted in red below.'); return; }
    try {
      await api('/pms/review-parameters', { method: 'PUT', body: JSON.stringify({ parameters: rows.map(r => ({ id: r.id, name: r.name, weight_pct: Number(r.weight_pct) })) }) });
      setSaved(true); load();
    } catch (e) { setErr(e.message); }
  };

  // Rebuilt with an explicit table layout (grid-template-columns) rather
  // than flex-1/fixed-width siblings sharing a row — found live, per a
  // screenshot: the name column was rendering collapsed to a sliver next
  // to an oversized weight column, making every parameter's name
  // unreadable. A fixed column grid removes any ambiguity about how much
  // space each field gets, and a persistent header row labels each
  // column once instead of relying only on per-row placeholder text.
  return (
    <div className="card p-4 space-y-3">
      <div>
        <p className="font-bold text-sm">7 Organizational Parameters</p>
        <p className="text-xs text-navy-400">Used to compute the weighted overall rating on annual-cycle evaluations (BR-6.2/6.3). Weights must sum to 100.</p>
      </div>
      {blankCount > 0 && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
          {blankCount} parameter{blankCount === 1 ? '' : 's'} {blankCount === 1 ? 'has' : 'have'} no name set — highlighted below. Type a name for each before saving.
        </p>
      )}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: '2.5rem 1fr 7rem 2rem' }}>
        <span className="lbl mb-0">#</span>
        <span className="lbl mb-0">Parameter Name</span>
        <span className="lbl mb-0 text-right">Weight %</span>
        <span></span>
        {rows.map((r, i) => {
          const blank = !r.name.trim();
          return (
            <div key={r.id || i} className="contents">
              <div className="flex items-center justify-center text-xs font-semibold text-navy-400">{i + 1}</div>
              <input
                className={`inp ${blank ? '!border-rose-300 !bg-rose-50/50' : ''}`}
                value={r.name}
                onChange={e => update(i, 'name', e.target.value)}
                placeholder="e.g. Client Delivery Excellence"
              />
              <div className="flex items-center gap-1">
                <input className="inp text-right" type="number" step="0.5" min="0" value={r.weight_pct} onChange={e => update(i, 'weight_pct', e.target.value)} />
                <span className="text-xs text-navy-400">%</span>
              </div>
              <button className="btn-sec !p-1.5 justify-self-start" onClick={() => remove(i)} title="Remove parameter"><Trash2 size={13} /></button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-sec" onClick={add}><Plus size={13} className="inline mr-1" />Add parameter</button>
        <span className={`text-xs font-semibold ${validTotal ? 'text-emerald-700' : 'text-rose-600'}`}>Total: {total}%{!validTotal && ' (must be 100)'}</span>
        <button className="btn-pri" disabled={!validTotal} onClick={save}><Save size={13} className="inline mr-1" />Save</button>
        {saved && <span className="text-[11px] text-emerald-600 font-medium">Saved ✓</span>}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
