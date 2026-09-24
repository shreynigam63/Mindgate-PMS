import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, ChevronDown, ChevronRight } from 'lucide-react';
import { api, phaseLabel, phaseColor, KraBullets } from '../utils/api';
import { AiModal } from './AiDraftPanel';
import AppraisalSummaryPanel, { KeptRecommendations } from './AppraisalSummaryPanel';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import StatusTabs, { statusTabs } from '../StatusTabs';
import Grade, { grade } from '../grade';

// Matches Self-Appraisal's convention: per-KRA picks in letter grades,
// the one computed overall in descriptive wording — see that page for
// the reasoning (nuanced rubric for detail, plain language for the
// summary figure). Fixed local maps, not the cycle's own rating_scale
// labels, for the same reason: this pairing should hold regardless of
// which label set a given cycle happens to have stored.

export default function TeamEvalPage() {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('pending');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => api('/pms/team/evaluations')
    .then(r => { setData(r); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  // Filtered in the browser: this list is one team or one

  // department, not the whole company, so there is nothing to gain

  // from a round trip per keystroke.

  // Same split as Team KRA Sheets: what you still owe, and what is done.
  const ETABS = [
    { key: 'pending', label: 'Still to write', tone: 'bg-amber2-500 text-white',
      match: v => v !== 'submitted' },
    { key: 'submitted', label: 'Submitted', tone: 'bg-leaf-500 text-white',
      match: v => v === 'submitted' },
  ];
  const etabs = statusTabs(data.team || [], 'eval_status', ETABS);
  const eactive = ETABS.find(t => t.key === tab);
  const teamShown = (data.team || [])
    .filter(t => !eactive || eactive.match(t.eval_status))
    .filter(t => matches(q, t.name, t.department, t.self_status, t.eval_status));

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Team Evaluation" hue="teal">
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
      </PageHead>
      <StatusTabs tabs={etabs} value={tab} onChange={setTab} />
      <SearchBox value={q} onChange={setQ} placeholder="Search your team by name, department or status…"
        shown={teamShown.length} total={(data.team || []).filter(t => !eactive || eactive.match(t.eval_status)).length} />
      {!data.team.length && <div className="card p-8 text-center text-sm text-navy-400">No direct reports found in the employee mirror.</div>}
      {teamShown.map(t => (
        <div key={t.employee_id} className="card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpenId(v => v === t.employee_id ? null : t.employee_id)}>
            {openId === t.employee_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-sm font-semibold flex-1">{t.name}</span>
            <span className={`chip ${t.self_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>self: {t.self_status || 'not started'}</span>
            <span className={`chip ${t.eval_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-600'}`}>eval: {t.eval_status || 'pending'}</span>
          </button>
          {openId === t.employee_id && <EvalEditor t={t} phase={data.cycle.phase} scale={data.cycle.rating_scale} reload={load} />}
        </div>
      ))}
    </div>
  );
}

function EvalEditor({ t, phase, scale, reload }) {
  const [f, setF] = useState({ overall_rating: t.overall_rating ?? '', strengths: t.strengths || '', improvement_areas: t.improvement_areas || '', potential_rating: t.potential_rating || '' });
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
          <p className="font-bold text-navy-500 uppercase text-[10px]">Their annual review</p>
          {t.went_well && <p><b>Went well:</b> {t.went_well}</p>}
          {t.could_improve && <p><b>Could improve:</b> {t.could_improve}</p>}
        </div>
      )}
      {/* The pre-read comes BEFORE the rating controls: it is meant to be
          read while deciding, not checked afterwards. Gated on editable so
          it does not appear on an evaluation already submitted. */}
      {editable && <AppraisalSummaryPanel stage="pre_publish" employeeId={t.employee_id} onKeep={() => setKeptKey(k => k + 1)} />}
      <KeptRecommendations key={keptKey} employeeId={t.employee_id} kind="appraisal_pre_publish" title="Kept discussion points" />

      {/* THE RATING, on every cycle type. Annual used to be the exception:
          the 7-parameter grid sat above this and governed the official
          annual rating, while these per-KRA ratings were marked "for
          reference" and their onOverallChange was a deliberate no-op.
          The parameters came out on 23 Sep at the client's instruction,
          so the special case came out with them — the overall is now the
          weighted average of the KRA ratings here, the same way mid-year
          has always worked, and the server computes it from the approved
          KRA weights rather than trusting this number. */}
      <PerKraRating employeeId={t.employee_id} scale={scale} editable={editable} overallRating={f.overall_rating}
        selfSubmitted={t.self_status === 'submitted'}
        selfEntries={t.self_entries || {}} onOverallChange={(v) => setF(s => ({ ...s, overall_rating: v }))} />
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
      {/* Potential, recorded here as well as at calibration. This is the
          MANAGER'S read, made with a year of context; calibration still
          settles the final 9-box placement with the distribution on
          screen, and sees this as its starting point. Neither overwrites
          the other — see migration 043. */}
      <div>
        <label className="lbl">Potential</label>
        <div className="flex gap-2">
          {[['', 'Not set'], ['low', 'Low'], ['mid', 'Medium'], ['high', 'High']].map(([v, label]) => (
            <button key={v} type="button" disabled={!editable}
              onClick={() => { setF(x => ({ ...x, potential_rating: v })); persist({ potential_rating: v || null }); }}
              className={`chip px-3 py-1.5 ${f.potential_rating === v
                ? 'bg-violet-600 text-white' : 'bg-white text-navy-500 border border-navy-100'} ${editable ? '' : 'opacity-50'}`}>
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-navy-400 mt-1">
          Your read on how far this person could go. Calibration sees it and settles the final
          9-box placement; this is not overwritten by that.
        </p>
      </div>
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
  // NO KRAs ON THE SHEET — and, since 23 Sep, this branch has to offer a
  // rating rather than only explain itself.
  //
  // It used to be enough to say "no KRAs": on an annual cycle the 7
  // parameters set the rating and the grid sat above this, so a manager
  // could still rate somebody whose sheet was never filled in. With the
  // parameters gone the per-KRA average is the only route, and an
  // employee with no KRAs would have left their manager no control at
  // all and a submit that fails with "overall_rating required".
  //
  // So the plain picker comes back for exactly this case. The server
  // accepts a typed overall_rating only when no entries are sent, which
  // is precisely here — a sheet WITH KRAs still has its overall computed
  // from the approved weights and cannot be typed over.
  if (!kras.length) {
    const setOverall = async (value) => {
      setSaveState('saving');
      try {
        await api(`/pms/team/evaluations/${employeeId}`, { method: 'PUT', body: JSON.stringify({ overall_rating: value }) });
        setSaveState('saved'); onOverallChange(value);
      } catch (e) { setSaveState('error'); setErr(e.message); }
    };
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-navy-400">
          No KRAs on this employee's sheet for this cycle, so there is nothing to rate
          line by line. Set the overall rating directly.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="lbl mb-0">Overall rating</span>
          {(scale || []).map((sc) => (
            <button key={sc.value} type="button" disabled={!editable}
              className={`chip ${Number(overallRating) === sc.value ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600'}`}
              onClick={() => setOverall(sc.value)}>{grade(sc.value, scale)}</button>
          ))}
          {saveState === 'saving' && <span className="text-[11px] text-amber-600">Saving…</span>}
          {saveState === 'saved' && <span className="text-[11px] text-emerald-600">Saved ✓</span>}
        </div>
      </div>
    );
  }

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
              <p className="text-[11px] text-navy-500">Employee's self-rating: <b>{grade(selfRating, scale)}</b></p>
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
                  onClick={() => setRating(k.id, s.value)}>{grade(s.value, scale)}</button>
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
            <Grade value={overallRating} scale={scale} className="text-emerald-700 font-bold" />
          ) : (
            <span className="text-navy-400">— rate each KRA above to see the weighted average</span>
          )}
        </p>
      )}
    </div>
  );
}

// ParameterScoring — the 7 Organizational Driver grid that used to sit on
// this card for annual cycles — was REMOVED on 23 Sep at the client's
// instruction: "we don't need 7 parameters in PMS for now, please remove
// from all tabs if available, in case it is needed in future we can
// check."
//
// Kept out of the UI only. pms.review_parameters, pms.parameter_scores and
// GET/PUT /pms/team/parameter-scores/:employeeId are untouched and still
// work, so putting the grid back is a UI change, not a rebuild. What the
// grid used to produce — the official annual overall_rating — now comes
// from the per-KRA ratings above, through the same weighted engine every
// other cycle type already used.
