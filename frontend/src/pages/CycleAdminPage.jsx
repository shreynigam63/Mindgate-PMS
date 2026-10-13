import { useEffect, useState } from 'react';
import { Plus, ArrowRight, RotateCcw, Rocket, Activity, BellRing, Trash2, Save, X, Info, History, ChevronDown, ChevronUp, Grid3x3 } from 'lucide-react';
import { api, PHASES, phaseLabel, phaseColor } from '../utils/api';
import { AiModal } from './AiDraftPanel';
import PageHead from '../PageHead';

export default function CycleAdminPage() {
  const [cycles, setCycles] = useState(null);
  const [err, setErr] = useState(null);
  const [health, setHealth] = useState(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState(null);
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
  const [published, setPublished] = useState(null);
  const [nineBoxFor, setNineBoxFor] = useState(null);
  const publish = async (c) => {
    const nine = c.cycle_type === 'annual'
      ? ' It also places everyone on the 9-box and creates its actions: a PIP for Underperformer (0,0) and for anyone below the Low limit who cannot be placed, development actions, and the succession pool.'
      : '';
    if (!confirm(`Publish ratings to all employees? This writes performance history and notifies everyone rated.${nine}`)) return;
    setBusy(true); setErr(null);
    try {
      const r = await api('/pms/publish', { method: 'POST' });
      setPublished(r);
      load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  // The reminder engine is a catch-up rather than a clock (see
  // server/modules/performance/reminders.js): it runs at boot and daily,
  // and replays anything the free instance slept through. This button is
  // for the case where that is not soon enough — HR opened a phase late,
  // or wants to confirm the sweep works. Pressing it twice is harmless.
  const runReminders = async () => {
    setBusy(true); setErr(null); setSweep(null);
    try {
      const r = await api('/pms/reminders/run', { method: 'POST' });
      const { ok, total, ...rules } = r;
      setSweep(total
        ? `Sent ${total}: ` + Object.entries(rules).filter(([, n]) => n).map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`).join(', ')
        : 'Nothing due — everyone is either up to date or already reminded.');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const cycleHealth = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/agentic/cycle-health', { method: 'POST' }); setHealth(r); setHealthOpen(true); }
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
      <PageHead title="Appraisal Cycles" hue="azure">
        <button className="btn-pri" onClick={() => setShowNew(true)}><Plus size={13} className="inline mr-1" />New cycle</button>
        <button className="btn-sec" disabled={busy} onClick={cycleHealth}><Activity size={13} className="inline mr-1" />{busy ? 'Working…' : 'Cycle health (agent)'}</button>
        <button className="btn-sec" disabled={busy} onClick={runReminders}><BellRing size={13} className="inline mr-1" />{busy ? 'Working…' : 'Run reminder sweep'}</button>
      </PageHead>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {sweep && <p className="text-xs text-emerald-700">{sweep}</p>}
      {published && <PublishResult r={published} onClose={() => setPublished(null)} />}
      {/* Over the page, not above the cycle list — this screen's job is
          the cycles and their phase controls. */}
      {health?.draft && !healthOpen && (
        <button className="text-[11px] font-semibold text-navy-600 hover:underline" onClick={() => setHealthOpen(true)}>
          Reopen the cycle health read
        </button>
      )}
      {health?.draft && healthOpen && (
        <AiModal title="Cycle health" onClose={() => setHealthOpen(false)}>
          <p className="text-sm font-semibold">{health.draft.headline}</p>
          {health.draft.bottleneck && <p><b>Bottleneck:</b> {health.draft.bottleneck}</p>}
          {(health.draft.chase_this_week || []).length > 0 && (
            <div><p className="font-semibold text-navy-500">Chase this week</p>
              <ul className="list-disc pl-4">{health.draft.chase_this_week.map((c, i) => <li key={i}>{c}</li>)}</ul></div>
          )}
          {(health.draft.caveats || []).length > 0 && <p className="text-navy-400">Caveats: {health.draft.caveats.join(' · ')}</p>}
        </AiModal>
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
                {c.phase === 'publish' && <button className="btn-pri !bg-emerald-700" disabled={busy} onClick={() => publish(c)}><Rocket size={13} className="inline mr-1" />Publish ratings</button>}
                {c.cycle_type === 'annual' && <button className="btn-sec" onClick={() => setNineBoxFor(c)}><Grid3x3 size={13} className="inline mr-1" />9-Box settings</button>}
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
      {showNew && <NewCycleModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
      {nineBoxFor && <NineBoxSettingsModal cycle={nineBoxFor} onClose={() => setNineBoxFor(null)} />}
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
  DEVPLAN_SUBMITTED: 'Target achievements submitted', SELF_APPRAISAL_SUBMITTED: 'Annual Review submitted',
  MANAGER_EVAL_SUBMITTED: 'Manager Evaluation submitted', HOD_EVAL_SUBMITTED: 'HOD Review submitted',
  HOD_QUEUE_RESEEDED: 'HOD queue re-seeded', MIDYEAR_SELF_SUBMITTED: 'Mid-Year self sign-off', MIDYEAR_MANAGER_SUBMITTED: 'Mid-Year manager sign-off',
  PARAMETER_SCORES_UPDATED: '7-parameter scores updated', REVIEW_PARAMETERS_UPDATED: 'Review parameters updated',
  RATING_ADJUSTED: 'Rating adjusted (Calibration)', PIP_AUTO_OPENED: 'PIP auto-opened', PIP_THRESHOLD_SET: 'PIP threshold set',
  RETENTION_ALERT_SENT: 'Retention alert sent', SUPER50_FLAGGED: 'Flagged on Super 50', SUPER50_UNFLAGGED: 'Removed from Super 50',
  CONNECT_LOGGED: 'Connect logged', CONNECT_SIGNED_OFF: 'Connect signed off', CONNECT_REMINDERS_CHECKED: 'Connect reminders checked',
  CLOSURE_LETTER_GENERATED: 'Closure letter generated',
  NINE_BOX_PLACED: '9-box placed', NINE_BOX_NOT_PLACED: '9-box: not placed', NINE_BOX_OVERRIDDEN: '9-box band overridden',
  NINE_BOX_SETTINGS_UPDATED: '9-box settings changed', NINE_BOX_ACTION_CREATED: '9-box action created',
  NINE_BOX_ACTION_DONE: '9-box action done', NINE_BOX_ACTION_REOPENED: '9-box action reopened',
  NINE_BOX_ACTION_SUPERSEDED: '9-box action replaced', NINE_BOX_ESCALATED: 'Escalated: two cycles in (0,0)',
  SUCCESSION_POOL_ADDED: 'Added to the succession pool', SUCCESSION_POOL_REMOVED: 'Left the succession pool',
  POTENTIAL_ANSWERED: 'Potential questions answered',
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

// ReviewParametersConfig — the HR editor for the 7 organisational
// parameters and their weights (BR-6.2) — was REMOVED from this page on
// 23 Sep at the client's instruction: "we don't need 7 parameters in PMS
// for now, please remove from all tabs if available, in case it is needed
// in future we can check."
//
// It is a UI removal. pms.review_parameters still holds the tenant's
// seven rows, and GET/PUT /pms/review-parameters still serve and validate
// them, so nothing a client has already configured is lost and putting
// the editor back is putting this component back.

const BOX_ORDER = ['2,2', '1,2', '2,1', '0,2', '1,1', '2,0', '0,1', '1,0', '0,0'];
const NOT_PLACED_WORDS = { new_joiner: 'new joiners', no_rating: 'no rating', no_potential: 'no potential input' };

// What publish did, said in full rather than in an alert().
function PublishResult({ r, onClose }) {
  const n = r.nine_box;
  return (
    <div className="card p-4 text-xs space-y-1.5 border-emerald-200">
      <div className="flex items-start gap-2">
        <p className="text-sm font-bold text-emerald-800 flex-1">Published: {r.published}</p>
        <button className="text-navy-400 hover:text-navy-600" onClick={onClose} aria-label="Close"><X size={16} /></button>
      </div>
      {n && (
        <>
          <p><b>9-box:</b> {n.placed} placed{n.not_placed ? `, ${n.not_placed} not placed (${Object.entries(n.not_placed_by_reason).map(([k, v]) => `${v} ${NOT_PLACED_WORDS[k] || k}`).join(', ')})` : ''}.</p>
          <p className="text-navy-600">{BOX_ORDER.filter((k) => n.by_box[k]).map((k) => `(${k}) ${n.by_box[k]}`).join(' · ')}</p>
          <p>{n.actions_created} action{n.actions_created === 1 ? '' : 's'} created · {n.succession_added} added to the succession pool · {r.pips_opened} PIP{r.pips_opened === 1 ? '' : 's'} opened
            {n.retention_alerts ? ` · ${n.retention_alerts} retention alert${n.retention_alerts === 1 ? '' : 's'}` : ''}
            {n.escalations ? ` · ${n.escalations} escalated after two cycles in (0,0)` : ''}</p>
        </>
      )}
      {!n && <p>{r.pips_opened} PIP{r.pips_opened === 1 ? '' : 's'} opened.</p>}
      {r.failures.length > 0 && (
        <p className="text-rose-600">Failed: {r.failures.length} — {r.failures.slice(0, 3).map((f) => f.reason).join('; ')}</p>
      )}
    </div>
  );
}

// The 9-box settings of one annual cycle (13 Oct build specification):
// band limits, the weight of potential's two halves, the nine box names
// and actions, the potential questions. Saving before publish re-places
// people at once and says how many moved; after publish they are fixed.
function NineBoxSettingsModal({ cycle, onClose }) {
  const [d, setD] = useState(null);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  useEffect(() => {
    api(`/pms/nine-box/settings?cycle_id=${cycle.id}`).then((r) => { setD(r); setF(JSON.parse(JSON.stringify(r.settings))); })
      .catch((e) => setErr(e.message));
  }, [cycle.id]);
  const locked = d && d.locked;
  const setBox = (k, field, v) => setF((x) => ({ ...x, boxes: { ...x.boxes, [k]: { ...x.boxes[k], [field]: v } } }));
  const setQ = (i, field, v) => setF((x) => ({ ...x, questions: x.questions.map((q, j) => (j === i ? { ...q, [field]: v } : q)) }));
  const save = async () => {
    setBusy(true); setErr(null); setErrors([]); setDone(null);
    try {
      const r = await api(`/pms/nine-box/settings/${cycle.id}`, { method: 'PUT', body: JSON.stringify({
        ...f, mid_from: Number(f.mid_from), high_from: Number(f.high_from), competency_weight: Number(f.competency_weight) }) });
      setDone(`Saved. ${r.moved ? `${r.moved} ${r.moved === 1 ? 'person moves' : 'people move'} box.` : 'Nobody changes box.'}`);
    } catch (e) { setErr(e.message); if (e.data && e.data.errors) setErrors(e.data.errors); }
    setBusy(false);
  };
  const below = f ? (Math.round(Number(f.high_from) * 10 - 1) / 10).toFixed(1) : '';
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-navy-900/40 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-100">
          <p className="text-base font-bold">9-Box settings — {cycle.name}</p>
          <button className="text-navy-400 hover:text-navy-600" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {!f && !err && <p className="p-5 text-sm text-navy-400">Loading…</p>}
        {err && !f && <p className="p-5 text-sm text-rose-600">{err}</p>}
        {f && (
          <div className="p-5 space-y-4 text-xs">
            {locked && <p className="bg-amber-50 text-amber-800 rounded-lg p-2">{locked}</p>}
            {!d.stored && <p className="text-navy-500">{d.inherited_from ? `Not set for this cycle yet — showing ${d.inherited_from.name}'s settings, which apply until you save.` : 'Not set for this cycle yet — showing the defaults from the 9-box specification.'}</p>}
            <div>
              <p className="lbl">Bands (1–5 scale, both axes)</p>
              <div className="flex flex-wrap items-end gap-3">
                <label>Medium from<input className="inp !w-20 mt-0.5" type="number" step="0.1" min="1" max="5" disabled={!!locked}
                  value={f.mid_from} onChange={(e) => setF({ ...f, mid_from: e.target.value })} /></label>
                <label>High from<input className="inp !w-20 mt-0.5" type="number" step="0.1" min="1" max="5" disabled={!!locked}
                  value={f.high_from} onChange={(e) => setF({ ...f, high_from: e.target.value })} /></label>
                <p className="text-navy-500 pb-2">Low below {Number(f.mid_from).toFixed(1)} · Medium {Number(f.mid_from).toFixed(1)}–{below} · High {Number(f.high_from).toFixed(1)} and above</p>
              </div>
            </div>
            <div>
              <p className="lbl">Potential</p>
              <label className="flex flex-wrap items-center gap-2">Competency score counts
                <input className="inp !w-20" type="number" step="5" min="0" max="100" disabled={!!locked}
                  value={f.competency_weight} onChange={(e) => setF({ ...f, competency_weight: e.target.value })} />
                % · the manager's questions {100 - Number(f.competency_weight || 0)}%
              </label>
              <p className="text-navy-400 mt-1">If one half is missing for somebody, the other is used alone and marked as one half.</p>
            </div>
            <div>
              <p className="lbl">Boxes — name and the action publish creates</p>
              <div className="space-y-2">
                {BOX_ORDER.map((k) => (
                  <div key={k} className="grid sm:grid-cols-[3rem_10rem_1fr] gap-1.5 items-start">
                    <span className="text-navy-400 pt-1.5">({k})</span>
                    <input className="inp" value={f.boxes[k].name} disabled={!!locked} onChange={(e) => setBox(k, 'name', e.target.value)} />
                    <input className="inp" value={f.boxes[k].action} disabled={!!locked} onChange={(e) => setBox(k, 'action', e.target.value)} />
                  </div>
                ))}
              </div>
              <p className="text-navy-400 mt-1">(0,0) always opens a PIP and (2,2) always joins the succession pool; the wording is yours.</p>
            </div>
            <div>
              <p className="lbl">Potential questions (rated 1–5 by the manager)</p>
              {d.questions_answered && <p className="text-navy-500 mb-1">Managers have already answered these this cycle, so they can be reworded but not added or removed.</p>}
              <div className="space-y-1.5">
                {f.questions.map((q, i) => (
                  <div key={q.key || i} className="grid sm:grid-cols-[14rem_1fr_auto] gap-1.5">
                    <input className="inp" value={q.label} disabled={!!locked} onChange={(e) => setQ(i, 'label', e.target.value)} placeholder="Question" />
                    <input className="inp" value={q.hint || ''} disabled={!!locked} onChange={(e) => setQ(i, 'hint', e.target.value)} placeholder="Hint shown to the manager" />
                    {!locked && !d.questions_answered && f.questions.length > 1 && (
                      <button className="text-navy-400 hover:text-rose-600 px-1" aria-label="Remove question"
                        onClick={() => setF((x) => ({ ...x, questions: x.questions.filter((_, j) => j !== i) }))}><X size={14} /></button>
                    )}
                  </div>
                ))}
              </div>
              {!locked && !d.questions_answered && f.questions.length < 8 && (
                <button className="text-[11px] text-navy-600 hover:underline mt-1" onClick={() => setF((x) => ({ ...x, questions: [...x.questions, { key: '', label: '', hint: '' }] }))}>
                  <Plus size={11} className="inline" /> Add a question
                </button>
              )}
            </div>
            {errors.length > 1 ? <ul className="text-rose-600 list-disc pl-4">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              : err && <p className="text-rose-600">{err}</p>}
            {done && <p className="text-emerald-700">{done}</p>}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-navy-100">
          {f && !locked && <button className="btn-sec mr-auto" onClick={() => setF(JSON.parse(JSON.stringify(d.defaults)))}>Reset to the specification's defaults</button>}
          <button className="btn-sec" onClick={onClose}>Close</button>
          {f && !locked && <button className="btn-pri" disabled={busy} onClick={save}><Save size={13} className="inline mr-1" />{busy ? 'Saving…' : 'Save'}</button>}
        </div>
      </div>
    </div>
  );
}
