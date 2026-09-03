import { useEffect, useRef, useState } from 'react';
import { Send, Paperclip, Trash2, Download, Star } from 'lucide-react';
import { api, phaseLabel, phaseColor, API_BASE } from '../utils/api';
import ReviewAssist from './ReviewAssist';
import MeetingPanel from './MeetingPanel';

// Requested: per-KRA rating uses letter grades (A+ down to C), but the
// computed OVERALL average is shown with the older descriptive wording
// (Outstanding down to Needs Improvement) — two different label sets for
// the same underlying 1-5 values, by deliberate choice (a nuanced,
// familiar rubric for detailed per-KRA feedback; plainer, more universally
// understood language for the one summary figure). Kept as fixed local
// maps rather than trusting cycle.rating_scale's own .label field, since
// that field can differ per cycle (some still carry the old descriptive
// default, some the newer letter-grade one) and this pairing needs to
// hold regardless of which one a given cycle happens to have stored.
const KRA_GRADE_LABEL = { 5: 'A+', 4: 'A', 3: 'B+', 2: 'B', 1: 'C' };
const OVERALL_DESCRIPTIVE_LABEL = { 5: 'Outstanding', 4: 'Exceeds', 3: 'Meets Expectations', 2: 'Developing', 1: 'Needs Improvement' };

// The overall rating is a weighted average, so it's usually fractional
// (e.g. 3.7) — this finds the CLOSEST whole value to label it with,
// rather than requiring an exact match.
function nearestWholeValue(value, scale) {
  if (value == null || !Array.isArray(scale) || !scale.length) return null;
  let closest = scale[0].value;
  for (const s of scale) { if (Math.abs(s.value - value) < Math.abs(closest - value)) closest = s.value; }
  return closest;
}

export default function SelfAppraisalPage() {
  const [data, setData] = useState(null);
  const [entries, setEntries] = useState({});
  const [f, setF] = useState({ went_well: '', could_improve: '' });
  const [overallRating, setOverallRating] = useState(null);
  const [state, setState] = useState('idle');
  const [err, setErr] = useState(null);
  // Requested: for an ANNUAL cycle, the employee must complete the same
  // 7-parameter self-scoring the manager scores against before they can
  // submit — tracked here so the Submit button reflects it live, not just
  // discovered as a 422 on click.
  const [paramsComplete, setParamsComplete] = useState(true);
  const [paramsMissing, setParamsMissing] = useState(0);
  const timer = useRef(null);

  useEffect(() => {
    api('/pms/my/self-appraisal').then(r => {
      setData(r);
      if (r.appraisal) {
        setEntries(r.appraisal.entries || {});
        setF({ went_well: r.appraisal.went_well || '', could_improve: r.appraisal.could_improve || '' });
        setOverallRating(r.appraisal.overall_self_rating ?? null);
      }
    }).catch(e => setErr(e.message));
  }, []);

  const persist = async (patch) => {
    setState('saving');
    try { const r = await api('/pms/my/self-appraisal', { method: 'PUT', body: JSON.stringify(patch) }); setOverallRating(r.overall_self_rating ?? null); setState('saved'); }
    catch (e) { setState('error'); setErr(e.message); }
  };
  const queue = (patch) => {
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(patch), 1200);
  };
  const setEntry = (kraId, k) => (e) => {
    const next = { ...entries, [kraId]: { ...(entries[kraId] || {}), [k]: e.target.value } };
    setEntries(next); queue({ entries: next });
  };
  // Requested: a rating scale per KRA, not one free-standing overall pick
  // — clicking a KRA's chip saves immediately (not debounced, since it's
  // a single click, not typed text) and the server recomputes the
  // weighted-average overall from every KRA's self_rating right away.
  // Every cycle type, annual included — the per-KRA grades are the only
  // input to the overall self-rating. The 7-parameter self-scoring below
  // is a separate self-assessment and does not feed this number.
  const setKraRating = (kraId, value) => {
    const next = { ...entries, [kraId]: { ...(entries[kraId] || {}), self_rating: value } };
    setEntries(next); persist({ entries: next });
  };
  const setField = (k) => (e) => { const next = { ...f, [k]: e.target.value }; setF(next); queue({ [k]: e.target.value }); };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const a = data.appraisal;
  const isAnnual = data.cycle.cycle_type === 'annual';
  const open = data.cycle.phase === 'self_appraisal' && a.status !== 'submitted';
  const canSubmit = open && (!isAnnual || paramsComplete);
  const badge = { idle: null, dirty: ['Unsaved…', 'text-navy-400'], saving: ['Saving…', 'text-amber-600'], saved: ['Saved ✓', 'text-emerald-600'], error: ['Save failed', 'text-rose-600'] }[state];

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Self-Appraisal</h2>
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
        {a.status === 'submitted' && <span className="chip bg-emerald-100 text-emerald-700">submitted — locked</span>}
        {badge && <span className={`text-[11px] font-medium ${badge[1]}`}>{badge[0]}</span>}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}

      {/* Same assist as the mid-year page, requested for both: the record
          the employee already built — connects, target achievements,
          Aspiring Career — read back to them per KRA before they write. */}
      {open && <ReviewAssist stage="annual" label="self-appraisal" />}
      {open && <MeetingPanel context="annual" title="Appraisal discussion with your manager" />}

      <div className="card p-3 space-y-1">
        <label className="lbl mb-0">Overall self-rating (weighted average of the KRAs below)</label>
        {overallRating != null ? (
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-navy-700">{OVERALL_DESCRIPTIVE_LABEL[nearestWholeValue(overallRating, data.cycle.rating_scale)] || overallRating}</span>
            <span className="text-xs text-navy-400">({Number(overallRating).toFixed(1)})</span>
          </div>
        ) : (
          <p className="text-xs text-navy-400">Rate each KRA below to see your overall average here.</p>
        )}
        {isAnnual && <p className="text-[10px] text-navy-400">Your own assessment. The official annual rating is set by your manager, from the 7 organisational parameters.</p>}
      </div>

      {isAnnual && (
        <SelfParameterScoring editable={open} scale={data.cycle.rating_scale} onUpdate={(r) => { setParamsComplete(r.complete); setParamsMissing(r.missing.length); }} />
      )}

      {!data.kras.length && <div className="card p-4 text-sm text-amber-700 bg-amber-50 border-amber-200">No approved KRAs found — complete KRA setting first.</div>}
      {data.kras.map(k => (
        <div key={k.id} className="card p-3 space-y-2">
          <div className="flex justify-between items-baseline">
            <p className="text-sm font-semibold">{k.title}</p>
            <span className="text-[11px] text-navy-400">{k.weight}%</span>
          </div>
          {/* Requested: per-KRA A+-C ratings visible on annual cycles too,
              not just mid-year. These are the sole input to the overall
              self-rating on every cycle type; the "which rating counts"
              question the note below answers is now between this figure
              and the MANAGER's, not between this and the employee's own
              7-parameter self-assessment. */}
          <div className="flex flex-wrap gap-1.5">
            {(data.cycle.rating_scale || []).map(s => (
              <button key={s.value} type="button" disabled={!open}
                className={`chip ${Number((entries[k.id] || {}).self_rating) === s.value ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600'}`}
                onClick={() => setKraRating(k.id, s.value)}>{KRA_GRADE_LABEL[s.value] || s.label}</button>
            ))}
          </div>
          {isAnnual && <p className="text-[10px] text-navy-400">Your grade here feeds the overall self-rating above.</p>}
          <textarea className="inp" rows={3} placeholder="What you achieved against this KRA — be specific, name evidence"
            value={(entries[k.id] || {}).narrative || ''} onChange={setEntry(k.id, 'narrative')} disabled={!open} />
        </div>
      ))}
      <div className="card p-3 space-y-2">
        <label className="lbl">What went well this cycle</label>
        <textarea className="inp" rows={3} value={f.went_well} onChange={setField('went_well')} disabled={!open} />
        <label className="lbl">What could improve</label>
        <textarea className="inp" rows={3} value={f.could_improve} onChange={setField('could_improve')} disabled={!open} />
      </div>
      <EvidenceSection editable={open} />
      {open && (
        <div className="space-y-1.5">
          <button className="btn-pri" disabled={!canSubmit} onClick={async () => {
            try { await api('/pms/my/self-appraisal/submit', { method: 'POST' }); location.reload(); }
            catch (e) { setErr(e.message); }
          }}><Send size={13} className="inline mr-1" />Submit — locks your appraisal</button>
          {isAnnual && !paramsComplete && (
            <p className="text-[11px] text-amber-700">Score all 7 organisational parameters above before submitting ({paramsMissing} remaining).</p>
          )}
        </div>
      )}
    </div>
  );
}

// Requested with a reference screenshot: the employee's own Self-Appraisal
// had no way to self-score against the same 7 Organizational Parameters
// the manager scores against (BR-6.2/6.3) — only the manager could, via
// TeamEvalPage's ParameterScoring. This is the employee's own mirror of
// that component, hitting the /my/parameter-scores endpoints.
//
// It is titled and framed as a SELF-ASSESSMENT, not as the annual rating.
// This block used to supply the figure shown at the top of the page under
// the heading "Overall Annual Rating (weighted average of the 7
// parameters below)", which read as though an employee set their own
// official rating. They never did: the official annual rating is the
// manager's scoring of these same 7 parameters, and the employee's
// overall_self_rating is the per-KRA weighted average. Only the wording
// and the wiring changed — the self-scores themselves are still captured,
// still required before submitting on an annual cycle, and still stored
// under scored_by_role='self'.
function SelfParameterScoring({ editable, scale, onUpdate }) {
  const [data, setDataLocal] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/my/parameter-scores').then(r => { setDataLocal(r); onUpdate(r); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const setScore = async (parameterId, value) => {
    try {
      const r = await api('/pms/my/parameter-scores', { method: 'PUT', body: JSON.stringify({ scores: { [parameterId]: Number(value) } }) });
      // The server's recomputed figures, not just the one star that moved
      // — the heading shows the running weighted self-assessment and the
      // "N not yet scored" count, both of which went stale here before.
      setDataLocal(d => d ? { ...d, scores: { ...d.scores, [parameterId]: Number(value) },
        weighted_rating: r.weighted_rating, complete: r.complete, missing: r.missing } : d);
      onUpdate(r);
    } catch (e) { setErr(e.message); }
  };

  if (err) return <p className="text-xs text-rose-600">{err}</p>;
  if (!data) return <p className="text-xs text-navy-400">Loading parameters…</p>;

  return (
    <div className="card p-3 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="lbl mb-0">Your self-assessment against the 7 Organizational Parameters {!data.complete && <span className="text-amber-600 font-normal">— {data.missing.length} not yet scored</span>}</p>
        {data.weighted_rating != null && (
          <span className="text-xs text-navy-500">
            <span className="font-semibold">{OVERALL_DESCRIPTIVE_LABEL[nearestWholeValue(data.weighted_rating, scale)] || data.weighted_rating}</span>
            <span className="text-navy-400"> ({Number(data.weighted_rating).toFixed(1)})</span>
          </span>
        )}
      </div>
      <p className="text-[10px] text-navy-400">How you rate yourself against the drivers your manager also scores. Your manager's scores — not these — set your official annual rating.</p>
      <div className="grid sm:grid-cols-2 gap-2">
        {data.parameters.map(p => (
          <div key={p.id} className="bg-navy-50 rounded-lg px-3 py-2 space-y-1">
            <p className="text-xs font-semibold">{p.name} <span className="text-navy-400 font-normal">({p.weight_pct}% weight)</span></p>
            <div className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map(v => (
                <button key={v} type="button" disabled={!editable} onClick={() => setScore(p.id, v)} className="p-0.5">
                  <Star size={16} className={v <= (data.scores[p.id] || 0) ? 'fill-amber-400 text-amber-400' : 'text-navy-200'} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EvidenceSection({ editable }) {
  const [files, setFiles] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/my/self-appraisal/evidence').then(r => setFiles(r.evidence)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  const onUpload = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setErr(null);
    const fd = new FormData(); fd.append('file', file);
    try { await api('/pms/my/self-appraisal/evidence', { method: 'POST', body: fd }); load(); }
    catch (err2) { setErr(err2.message); }
  };
  const remove = async (id) => {
    try { await api(`/pms/my/self-appraisal/evidence/${id}`, { method: 'DELETE' }); load(); }
    catch (e2) { setErr(e2.message); }
  };
  const token = localStorage.getItem('apms_token');

  return (
    <div className="card p-3 space-y-2">
      <label className="lbl">Supporting evidence</label>
      {(files || []).map(f => (
        <div key={f.id} className="flex items-center justify-between text-xs bg-navy-50 rounded-lg px-2 py-1.5">
          <span className="flex items-center gap-1"><Paperclip size={12} className="text-navy-400" />{f.filename} <span className="text-navy-400">({Math.round(f.file_size / 1024)} KB)</span></span>
          <span className="flex items-center gap-1">
            <a href={`${API_BASE}/pms/evidence/${f.id}/download?token=${token}`} className="btn-sec !p-1" target="_blank" rel="noreferrer"><Download size={12} /></a>
            {editable && <button className="btn-sec !p-1" onClick={() => remove(f.id)}><Trash2 size={12} /></button>}
          </span>
        </div>
      ))}
      {editable && <input type="file" onChange={onUpload} className="text-xs" />}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
