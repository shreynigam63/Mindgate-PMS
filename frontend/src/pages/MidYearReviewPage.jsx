import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, CheckCircle2, Clock, ChevronDown, ChevronRight } from 'lucide-react';
import { api, phaseLabel, phaseColor, DraftBadge } from '../utils/api';

// Rebuilt per an explicit request with a reference screenshot: previously
// this page only ever showed a read-only summary of the ANNUAL self-
// appraisal/manager-evaluation screens (linking out to edit them there).
// Now it's a real, self-contained editing screen — employee narrative +
// self-rating, manager narrative + rating, side by side, each with its
// own "Generate AI draft" and independent sign-off — backed by
// pms.midyear_checkins (migration 020), gated to the new mid_year_review
// phase (phase-machine.js).
export default function MidYearReviewPage() {
  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <h2 className="text-lg font-bold">Mid-Year Review</h2>
      <MyMidYearCard />
      <TeamMidYearReviews />
    </div>
  );
}

// Matches the convention already established on Self-Appraisal/Team
// Evaluation: picking a rating uses letter grades (A+ down to C), but
// any READ-ONLY summary display of a rating uses the older descriptive
// wording (Outstanding down to Needs Improvement) — fixed local maps
// rather than trusting cycle.rating_scale's own .label field, since that
// field differs per cycle and this pairing needs to hold regardless.
const KRA_GRADE_LABEL = { 5: 'A+', 4: 'A', 3: 'B+', 2: 'B', 1: 'C' };
const OVERALL_DESCRIPTIVE_LABEL = { 5: 'Outstanding', 4: 'Exceeds', 3: 'Meets Expectations', 2: 'Developing', 1: 'Needs Improvement' };
function overallLabel(value) {
  if (value == null) return null;
  return OVERALL_DESCRIPTIVE_LABEL[Number(value)] || value;
}

function StatusPill({ label, signed }) {
  return (
    <div className="flex items-center justify-between bg-navy-50 rounded-lg px-3 py-2">
      <span className="text-[11px] font-semibold text-navy-500 uppercase tracking-wide">{label}</span>
      <span className={`chip flex items-center gap-1 ${signed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
        {signed ? <CheckCircle2 size={11} /> : <Clock size={11} />}{signed ? 'Signed' : 'Pending'}
      </span>
    </div>
  );
}

function MyMidYearCard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [selfRating, setSelfRating] = useState('');
  const [selfNarrative, setSelfNarrative] = useState('');
  const [saveState, setSaveState] = useState('idle');
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState(null);
  const timer = useRef(null);

  const load = () => api('/pms/my/midyear-review').then((r) => {
    setData(r);
    if (r.checkin) { setSelfRating(r.checkin.self_rating ?? ''); setSelfNarrative(r.checkin.self_narrative || ''); }
    setErr(null);
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const persist = async (patch) => {
    setSaveState('saving');
    try { await api('/pms/my/midyear-review', { method: 'PUT', body: JSON.stringify(patch) }); setSaveState('saved'); }
    catch (e) { setSaveState('error'); setErr(e.message); }
  };
  const scheduleSave = (narrative) => {
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist({ self_narrative: narrative }), 1200);
  };
  const pickRating = (value) => { setSelfRating(value); persist({ self_rating: value }); };
  const askDraft = async () => {
    setDrafting(true); setErr(null);
    try { const r = await api('/agentic/midyear-draft', { method: 'POST', body: JSON.stringify({ employee_id: data.checkin.employee_id, perspective: 'self' }) }); setDraft(r); }
    catch (e) { setErr(e.message); }
    setDrafting(false);
  };
  const submit = async () => {
    setErr(null);
    // Found live: clicking "Save & sign" right after typing could submit
    // before the debounced autosave (scheduleSave, 1200ms) had actually
    // landed — the backend would then see the OLD narrative (often still
    // empty) and reject the submit with "Add your reflection before
    // signing," even though the employee had clearly just typed one.
    // Flushing the current values first, and cancelling any pending
    // timer, removes that race entirely.
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    try {
      await persist({ self_rating: selfRating || null, self_narrative: selfNarrative });
      await api('/pms/my/midyear-review/submit', { method: 'POST' });
      load();
    } catch (e) { setErr(e.message); }
  };

  if (err && !data) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className="card p-4"><p className="text-sm text-navy-400">Loading…</p></div>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const selfSigned = data.checkin.self_status === 'submitted';
  const mgrSigned = data.checkin.manager_status === 'submitted';
  const editable = data.editable && !selfSigned;
  const badge = { idle: null, dirty: ['Unsaved…', 'text-navy-400'], saving: ['Saving…', 'text-amber-600'], saved: ['Saved ✓', 'text-emerald-600'], error: ['Save failed', 'text-rose-600'] }[saveState];

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold text-sm">Mid-Year Review · {data.cycle.name}</p>
          <p className="text-xs text-navy-400">Halfway checkpoint against KRAs and the development plan</p>
        </div>
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{phaseLabel(data.cycle.phase)}</span>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <StatusPill label="Employee (you)" signed={selfSigned} />
        <StatusPill label="Manager" signed={mgrSigned} />
      </div>

      {!data.editable && !selfSigned && (
        <p className="text-xs text-navy-400 bg-navy-50 rounded-lg p-2">
          Mid-Year Review opens once HR moves the cycle from Growth Planning to Mid-Year Review (currently: {phaseLabel(data.cycle.phase)}).
        </p>
      )}

      {editable && (
        <div className="bg-gradient-to-r from-fuchsia-50 to-rose-50 border border-fuchsia-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold text-fuchsia-700">+ Start with an AI draft</p>
            <p className="text-[11px] text-navy-500">Reads your KRAs and every 1-on-1 connect logged this cycle, then writes a balanced progress summary you can edit before submitting.</p>
          </div>
          <button className="btn-pri !bg-fuchsia-700" disabled={drafting} onClick={askDraft}>
            <Sparkles size={13} className="inline mr-1" />{drafting ? 'Drafting…' : 'Generate AI draft'}
          </button>
        </div>
      )}
      {draft && (
        <div className="bg-navy-800 text-slate-100 rounded-lg p-3 text-xs space-y-2">
          <DraftBadge />
          <p>{draft.narrative}</p>
          {(draft.gaps || []).length > 0 && <p className="text-amber-300">Input gaps: {draft.gaps.join(' · ')}</p>}
          <button className="btn-sec !bg-navy-700 !text-white !border-navy-600"
            onClick={() => { setSelfNarrative(draft.narrative); persist({ self_narrative: draft.narrative }); }}>
            Copy into narrative (then edit)
          </button>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="border border-navy-100 rounded-xl p-3 space-y-2">
          <p className="text-[10px] uppercase font-bold text-navy-400">From the employee (you)</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="lbl mb-0">Self-rating</span>
            {(data.cycle.rating_scale || []).map((s) => (
              <button key={s.value} type="button" disabled={!editable}
                className={`chip ${Number(selfRating) === s.value ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600'}`}
                onClick={() => pickRating(s.value)}>{KRA_GRADE_LABEL[s.value] || s.label}</button>
            ))}
          </div>
          <textarea className="inp" rows={4} placeholder="Reflect on progress this half — highlights, challenges, focus for next half."
            disabled={!editable} value={selfNarrative} onChange={(e) => { setSelfNarrative(e.target.value); scheduleSave(e.target.value); }} />
          <div className="flex items-center gap-2">
            {editable && <button className="btn-sec" onClick={() => { if (timer.current) clearTimeout(timer.current); persist({ self_rating: selfRating || null, self_narrative: selfNarrative }); }}>Save</button>}
            {editable && <button className="btn-pri" onClick={submit}><Send size={12} className="inline mr-1" />Save & sign</button>}
            {badge && <span className={`text-[11px] font-medium ${badge[1]}`}>{badge[0]}</span>}
          </div>
        </div>
        <div className="border border-navy-100 rounded-xl p-3 space-y-2">
          <p className="text-[10px] uppercase font-bold text-navy-400">From the manager</p>
          <p className="text-xs"><b>Mid-year rating:</b> {overallLabel(data.checkin.manager_rating) ?? '—'}</p>
          <p className="text-xs text-navy-500">{data.checkin.manager_narrative || 'Not written yet.'}</p>
        </div>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

// Manager side — mirrors the "expand a report" pattern already used by
// Team KRA Sheets / Team Development Plans, so a manager sees the same
// interaction everywhere. Uses the existing /team/evaluations list for
// "who are my reports" (already fetched elsewhere in the app) and the
// new /team/midyear-review/:employeeId for the detail once expanded.
function TeamMidYearReviews() {
  const [team, setTeam] = useState(null);
  const [openId, setOpenId] = useState(null);
  useEffect(() => { api('/pms/team/evaluations').then((r) => setTeam(r.team || [])).catch(() => setTeam([])); }, []);

  if (!team || !team.length) return null;

  return (
    <div className="space-y-2">
      <p className="font-bold text-sm">Team Mid-Year Reviews</p>
      {team.map((t) => (
        <div key={t.employee_id} className="card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpenId((v) => (v === t.employee_id ? null : t.employee_id))}>
            {openId === t.employee_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-sm font-semibold flex-1">{t.name}</span>
          </button>
          {openId === t.employee_id && <TeamMidYearDetail employeeId={t.employee_id} />}
        </div>
      ))}
    </div>
  );
}

function TeamMidYearDetail({ employeeId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [managerRating, setManagerRating] = useState('');
  const [managerNarrative, setManagerNarrative] = useState('');
  const [saveState, setSaveState] = useState('idle');
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState(null);
  const timer = useRef(null);

  const load = () => api(`/pms/team/midyear-review/${employeeId}`).then((r) => {
    setData(r);
    if (r.checkin) { setManagerRating(r.checkin.manager_rating ?? ''); setManagerNarrative(r.checkin.manager_narrative || ''); }
    setErr(null);
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [employeeId]);

  const persist = async (patch) => {
    setSaveState('saving');
    try { await api(`/pms/team/midyear-review/${employeeId}`, { method: 'PUT', body: JSON.stringify(patch) }); setSaveState('saved'); }
    catch (e) { setSaveState('error'); setErr(e.message); }
  };
  const scheduleSave = (narrative) => {
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist({ manager_narrative: narrative }), 1200);
  };
  const pickRating = (value) => { setManagerRating(value); persist({ manager_rating: value }); };
  const askDraft = async () => {
    setDrafting(true); setErr(null);
    try { const r = await api('/agentic/midyear-draft', { method: 'POST', body: JSON.stringify({ employee_id: employeeId, perspective: 'manager' }) }); setDraft(r); }
    catch (e) { setErr(e.message); }
    setDrafting(false);
  };
  const submit = async () => {
    setErr(null);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    try {
      await persist({ manager_rating: managerRating || null, manager_narrative: managerNarrative });
      await api(`/pms/team/midyear-review/${employeeId}/submit`, { method: 'POST' });
      load();
    } catch (e) { setErr(e.message); }
  };

  if (err && !data) return <p className="border-t border-navy-100 p-4 text-xs text-rose-600">{err}</p>;
  if (!data) return <p className="border-t border-navy-100 p-4 text-xs text-navy-400">Loading…</p>;
  if (!data.cycle) return <p className="border-t border-navy-100 p-4 text-xs text-navy-400">No active cycle.</p>;

  const selfSigned = data.checkin.self_status === 'submitted';
  const mgrSigned = data.checkin.manager_status === 'submitted';
  const editable = data.editable && !mgrSigned;
  const badge = { idle: null, dirty: ['Unsaved…', 'text-navy-400'], saving: ['Saving…', 'text-amber-600'], saved: ['Saved ✓', 'text-emerald-600'], error: ['Save failed', 'text-rose-600'] }[saveState];

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      <div className="grid sm:grid-cols-2 gap-2">
        <StatusPill label="Employee" signed={selfSigned} />
        <StatusPill label="You" signed={mgrSigned} />
      </div>
      <div className="bg-navy-50 rounded-lg p-3 text-xs space-y-1">
        <p className="font-bold text-navy-500 uppercase text-[10px]">Their reflection</p>
        {data.checkin.self_narrative ? <p>{data.checkin.self_narrative}</p> : <p className="text-navy-400">Not written yet.</p>}
      </div>
      {editable && (
        <div className="bg-gradient-to-r from-fuchsia-50 to-rose-50 border border-fuchsia-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-navy-500">Draft a narrative from their KRAs, your logged 1-on-1s this cycle, and their reflection above.</p>
          <button className="btn-pri !bg-fuchsia-700" disabled={drafting} onClick={askDraft}>
            <Sparkles size={13} className="inline mr-1" />{drafting ? 'Drafting…' : 'Generate AI draft'}
          </button>
        </div>
      )}
      {draft && (
        <div className="bg-navy-800 text-slate-100 rounded-lg p-3 text-xs space-y-2">
          <DraftBadge />
          <p>{draft.narrative}</p>
          <button className="btn-sec !bg-navy-700 !text-white !border-navy-600"
            onClick={() => { setManagerNarrative(draft.narrative); persist({ manager_narrative: draft.narrative }); }}>
            Copy into narrative (then edit)
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="lbl mb-0">Mid-year rating</span>
        <select className="inp w-auto" value={managerRating} disabled={!editable} onChange={(e) => pickRating(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">—</option>
          {(data.cycle.rating_scale || []).map((s) => (
            <option key={s.value} value={s.value}>{KRA_GRADE_LABEL[s.value] || s.label}</option>
          ))}
        </select>
      </div>
      <textarea className="inp" rows={3} placeholder="Your narrative for this employee's mid-year progress."
        disabled={!editable} value={managerNarrative} onChange={(e) => { setManagerNarrative(e.target.value); scheduleSave(e.target.value); }} />
      <div className="flex items-center gap-2">
        {editable && <button className="btn-sec" onClick={() => { if (timer.current) clearTimeout(timer.current); persist({ manager_rating: managerRating || null, manager_narrative: managerNarrative }); }}>Save</button>}
        {editable && <button className="btn-pri" onClick={submit}><Send size={12} className="inline mr-1" />Save & sign</button>}
        {badge && <span className={`text-[11px] font-medium ${badge[1]}`}>{badge[0]}</span>}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
