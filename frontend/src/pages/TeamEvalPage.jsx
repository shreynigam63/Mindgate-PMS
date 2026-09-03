import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, ChevronDown, ChevronRight } from 'lucide-react';
import { api, phaseLabel, phaseColor, KraBullets } from '../utils/api';
import { AiModal } from './AiDraftPanel';
import AppraisalSummaryPanel, { KeptRecommendations } from './AppraisalSummaryPanel';

// Matches Self-Appraisal's convention: per-KRA picks in letter grades,
// the one computed overall in descriptive wording — see that page for
// the reasoning (nuanced rubric for detail, plain language for the
// summary figure). Fixed local maps, not the cycle's own rating_scale
// labels, for the same reason: this pairing should hold regardless of
// which label set a given cycle happens to have stored.
const KRA_GRADE_LABEL = { 5: 'A+', 4: 'A', 3: 'B+', 2: 'B', 1: 'C' };
const OVERALL_DESCRIPTIVE_LABEL = { 5: 'Outstanding', 4: 'Exceeds', 3: 'Meets Expectations', 2: 'Developing', 1: 'Needs Improvement' };
function nearestWholeValue(value, scale) {
  if (value == null || !Array.isArray(scale) || !scale.length) return null;
  let closest = scale[0].value;
  for (const s of scale) { if (Math.abs(s.value - value) < Math.abs(closest - value)) closest = s.value; }
  return closest;
}

export default function TeamEvalPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => api('/pms/team/evaluations').then(r => { setData(r); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Team Evaluation</h2>
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
      </div>
      {!data.team.length && <div className="card p-8 text-center text-sm text-navy-400">No direct reports found in the employee mirror.</div>}
      {data.team.map(t => (
        <div key={t.employee_id} className="card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpenId(v => v === t.employee_id ? null : t.employee_id)}>
            {openId === t.employee_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-sm font-semibold flex-1">{t.name}</span>
            <span className={`chip ${t.self_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>self: {t.self_status || 'not started'}</span>
            <span className={`chip ${t.eval_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-600'}`}>eval: {t.eval_status || 'pending'}</span>
          </button>
          {openId === t.employee_id && <EvalEditor t={t} phase={data.cycle.phase} scale={data.cycle.rating_scale} cycleType={data.cycle.cycle_type} reload={load} />}
        </div>
      ))}
    </div>
  );
}

function EvalEditor({ t, phase, scale, cycleType, reload }) {
  const [f, setF] = useState({ overall_rating: t.overall_rating ?? '', strengths: t.strengths || '', improvement_areas: t.improvement_areas || '' });
  const [state, setState] = useState('idle');
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [keptKey, setKeptKey] = useState(0);
  const timer = useRef(null);
  const editable = phase === 'manager_eval' && t.eval_status !== 'submitted';

  const persist = async (patch) => {
    setState('saving');
    try { await api(`/pms/team/evaluations/${t.employee_id}`, { method: 'PUT', body: JSON.stringify(patch) }); setState('saved'); }
    catch (e) { setState('error'); setErr(e.message); }
  };
  const setText = (k) => (e) => {
    const v = e.target.value; setF(s => ({ ...s, [k]: v })); setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist({ [k]: v }), 1200);
  };
  const askDraft = async () => {
    setDrafting(true); setErr(null);
    try { const r = await api('/agentic/appraisal-draft', { method: 'POST', body: JSON.stringify({ employee_id: t.employee_id }) }); setDraft(r.draft); setDraftOpen(true); }
    catch (e) { setErr(e.message); }
    setDrafting(false);
  };
  const badge = { idle: null, dirty: ['Unsaved…', 'text-navy-400'], saving: ['Saving…', 'text-amber-600'], saved: ['Saved ✓', 'text-emerald-600'], error: ['Save failed', 'text-rose-600'] }[state];

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      {t.self_status === 'submitted' && (
        <div className="bg-navy-50 border border-navy-100 rounded-lg p-3 text-xs space-y-1">
          <p className="font-bold text-navy-500 uppercase text-[10px]">Their self-appraisal</p>
          {t.went_well && <p><b>Went well:</b> {t.went_well}</p>}
          {t.could_improve && <p><b>Could improve:</b> {t.could_improve}</p>}
        </div>
      )}
      {/* Requested: per-KRA A+-C ratings visible on Annual Manager
          Evaluation too, not just Mid-Year — previously mutually
          exclusive with the 7-parameter scoring. The 7 parameters remain
          what officially drives the annual overall_rating (unchanged,
          backend-enforced); PerKraRating's onOverallChange is a no-op on
          annual specifically so it can't overwrite that value — it only
          drives f.overall_rating on non-annual cycles, where it's the
          sole source of the overall rating. */}
      {cycleType === 'annual' && (
        <ParameterScoring employeeId={t.employee_id} editable={editable} initialRating={t.overall_rating} />
      )}
      {/* The pre-read comes BEFORE the rating controls: it is meant to be
          read while deciding, not checked afterwards. Gated on editable so
          it does not appear on an evaluation already submitted. */}
      {editable && <AppraisalSummaryPanel stage="pre_publish" employeeId={t.employee_id} onKeep={() => setKeptKey(k => k + 1)} />}
      <KeptRecommendations key={keptKey} employeeId={t.employee_id} kind="appraisal_pre_publish" title="Kept discussion points" />

      <PerKraRating employeeId={t.employee_id} scale={scale} editable={editable} overallRating={cycleType === 'annual' ? null : f.overall_rating}
        selfSubmitted={t.self_status === 'submitted'}
        selfEntries={t.self_entries || {}} onOverallChange={cycleType === 'annual' ? () => {} : (v) => setF(s => ({ ...s, overall_rating: v }))}
        hideOverallFooter={cycleType === 'annual'} />
      {cycleType === 'annual' && <p className="text-[10px] text-navy-400 -mt-2">Per-KRA ratings here are for reference — the 7 parameters above govern the official annual rating.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {editable && (
          <button className="btn-sec" disabled={drafting} onClick={askDraft}>
            <Sparkles size={13} className="inline mr-1 text-amber-500" />{drafting ? 'Drafting…' : 'Draft the writing'}
          </button>
        )}
        {badge && <span className={`text-[11px] font-medium ${badge[1]}`}>{badge[0]}</span>}
      </div>
      {/* The manager's evaluation form is the point of this card; the
          draft opens over it rather than sitting between the KRA ratings
          and the Strengths box. Copying closes it — the text is then in
          the fields behind. */}
      {draft && !draftOpen && (
        <button className="text-[11px] font-semibold text-navy-600 hover:underline self-start" onClick={() => setDraftOpen(true)}>
          Reopen the AI draft
        </button>
      )}
      {draft && draftOpen && (
        <AiModal title={`Appraisal draft — ${t.name}`} onClose={() => setDraftOpen(false)}
          footer={<button className="btn-pri" onClick={() => {
            setF(s => ({ ...s, strengths: draft.strengths || s.strengths, improvement_areas: draft.improvement_areas || s.improvement_areas }));
            persist({ strengths: draft.strengths, improvement_areas: draft.improvement_areas });
            setDraftOpen(false);
          }}>Copy into fields (then edit)</button>}>
          <KraBullets byKra={draft.by_kra} crossCutting={draft.cross_cutting}
            sections={[['strengths', 'Strengths'], ['improvement_areas', 'Improvement areas']]} />
          {(draft.evidence_notes || []).length > 0 && (
            <div><p className="font-semibold text-navy-500">Worth verifying</p>
              <ul className="list-disc pl-4">{draft.evidence_notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
          )}
          {(draft.gaps || []).length > 0 && <p className="text-amber-700">Input gaps: {draft.gaps.join(' · ')}</p>}
        </AiModal>
      )}
      <div><label className="lbl">Strengths</label>
        <textarea className="inp" rows={3} value={f.strengths} onChange={setText('strengths')} disabled={!editable} /></div>
      <div><label className="lbl">Improvement areas</label>
        <textarea className="inp" rows={3} value={f.improvement_areas} onChange={setText('improvement_areas')} disabled={!editable} /></div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {editable && (
        <button className="btn-pri" onClick={async () => {
          try { await api(`/pms/team/evaluations/${t.employee_id}/submit`, { method: 'POST' }); reload(); }
          catch (e) { setErr(e.message); }
        }}><Send size={13} className="inline mr-1" />Submit evaluation</button>
      )}
    </div>
  );
}

// Requested: a rating scale per KRA for the manager too (mirroring
// Self-Appraisal's per-KRA rating), with a comment per KRA, and the
// overall computed server-side as the weighted average — see
// PUT /team/evaluations/:employeeId. Employee's own self-rating per KRA
// is shown alongside (read-only) for direct comparison while rating.
function PerKraRating({ employeeId, scale, editable, overallRating, selfEntries, onOverallChange, hideOverallFooter, selfSubmitted }) {
  const [kras, setKras] = useState(null);
  const [entries, setEntries] = useState({});
  const [err, setErr] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const timer = useRef(null);

  useEffect(() => {
    api(`/pms/team/evaluations/${employeeId}/kras`).then(r => setKras(r.kras)).catch(e => setErr(e.message));
  }, [employeeId]);

  const persistEntries = async (next) => {
    setSaveState('saving');
    try {
      const r = await api(`/pms/team/evaluations/${employeeId}`, { method: 'PUT', body: JSON.stringify({ entries: next }) });
      setSaveState('saved');
      if (r.overall_rating != null) onOverallChange(r.overall_rating);
    } catch (e) { setSaveState('error'); setErr(e.message); }
  };
  const setRating = (kraId, value) => {
    const next = { ...entries, [kraId]: { ...(entries[kraId] || {}), rating: value } };
    setEntries(next); persistEntries(next);
  };
  const setComment = (kraId) => (e) => {
    const value = e.target.value;
    const next = { ...entries, [kraId]: { ...(entries[kraId] || {}), comment: value } };
    setEntries(next); setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persistEntries(next), 1200);
  };

  if (err) return <p className="text-xs text-rose-600">{err}</p>;
  if (!kras) return <p className="text-xs text-navy-400">Loading KRAs…</p>;
  if (!kras.length) return <p className="text-xs text-navy-400">No KRAs found for this employee this cycle.</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="lbl mb-0">Rate each KRA</p>
        {saveState === 'saving' && <span className="text-[11px] text-amber-600">Saving…</span>}
        {saveState === 'saved' && <span className="text-[11px] text-emerald-600">Saved ✓</span>}
      </div>
      {kras.map(k => {
        const selfRating = selfEntries[k.id] && selfEntries[k.id].self_rating;
        const selfNarrative = selfEntries[k.id] && selfEntries[k.id].narrative;
        const myRating = (entries[k.id] || {}).rating;
        return (
          <div key={k.id} className="bg-navy-50 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold flex-1">{k.title}</p>
              <span className="text-[11px] text-navy-400">{k.weight}%</span>
            </div>
            {selfRating != null && (
              <p className="text-[11px] text-navy-500">Employee's self-rating: <b>{KRA_GRADE_LABEL[selfRating] || selfRating}</b></p>
            )}
            {/* Requested: show what the employee actually wrote, not just
                their rating — paired directly above the comment box below,
                so it's clear the manager's comment is responding to this.
                Gated on submission (matching the existing "Their self-
                appraisal" summary box elsewhere on this page) — the data
                is fetched regardless of status, but showing a still-being-
                drafted, unsubmitted write-up to the manager would be a
                real visibility leak, not just a display choice. */}
            {selfSubmitted && selfNarrative && (
              <div className="bg-white border border-navy-100 rounded-lg p-2">
                <p className="text-[10px] font-semibold text-navy-400 uppercase tracking-wide mb-0.5">Employee's write-up</p>
                <p className="text-xs text-navy-600 whitespace-pre-wrap">{selfNarrative}</p>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {(scale || []).map(s => (
                <button key={s.value} type="button" disabled={!editable}
                  className={`chip ${Number(myRating) === s.value ? 'bg-navy-700 text-white' : 'bg-white text-navy-600 border border-navy-100'}`}
                  onClick={() => setRating(k.id, s.value)}>{KRA_GRADE_LABEL[s.value] || s.label}</button>
              ))}
            </div>
            <textarea className="inp !bg-white" rows={2} placeholder="Your comment on this KRA (optional)"
              value={(entries[k.id] || {}).comment ?? ''} onChange={setComment(k.id)} disabled={!editable} />
          </div>
        );
      })}
      {!hideOverallFooter && (
        <p className="text-sm">
          <span className="font-semibold">Overall rating: </span>
          {overallRating != null ? (
            <span className="text-emerald-700 font-bold">{OVERALL_DESCRIPTIVE_LABEL[nearestWholeValue(Number(overallRating), scale)] || overallRating} ({Number(overallRating).toFixed(1)})</span>
          ) : (
            <span className="text-navy-400">— rate each KRA above to see the weighted average</span>
          )}
        </p>
      )}
    </div>
  );
}

// BR-6.2/6.3: on an annual cycle the overall rating is computed from the 7
// Organizational Driver parameters, not typed directly — this replaces the
// plain rating <select> for annual cycles. Every parameter must be scored
// before the weighted rating counts as complete (and only then does it
// flow into overall_rating server-side, gating Submit evaluation below).
function ParameterScoring({ employeeId, editable, initialRating }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api(`/pms/team/parameter-scores/${employeeId}`).then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, [employeeId]);

  const setScore = async (parameterId, value) => {
    try {
      const r = await api(`/pms/team/parameter-scores/${employeeId}`, { method: 'PUT', body: JSON.stringify({ scores: { [parameterId]: Number(value) } }) });
      setData(d => d ? { ...d, scores: { ...d.scores, [parameterId]: Number(value) }, weighted_rating: r.weighted_rating, complete: r.complete, missing: r.missing } : d);
    } catch (e) { setErr(e.message); }
  };

  if (err) return <p className="text-xs text-rose-600">{err}</p>;
  if (!data) return <p className="text-xs text-navy-400">Loading parameters…</p>;

  return (
    <div className="space-y-2">
      <p className="lbl mb-0">7 Organizational Parameters {!data.complete && <span className="text-amber-600 font-normal">— {data.missing.length} not yet scored</span>}</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {data.parameters.map(p => (
          <div key={p.id} className="flex items-center justify-between gap-2 bg-navy-50 rounded-lg px-2 py-1.5">
            <span className="text-xs">{p.name} <span className="text-navy-400">({p.weight_pct}%)</span></span>
            <select className="inp !py-1 w-16" value={data.scores[p.id] ?? ''} disabled={!editable} onChange={e => setScore(p.id, e.target.value)}>
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        ))}
      </div>
      <p className="text-sm">
        <span className="font-semibold">Weighted overall rating: </span>
        <span className={data.complete ? 'text-emerald-700 font-bold' : 'text-navy-400'}>{data.weighted_rating ?? '—'}</span>
        {!data.complete && <span className="text-[11px] text-navy-400"> (updates live as parameters are scored; final once all 7 are)</span>}
      </p>
    </div>
  );
}
