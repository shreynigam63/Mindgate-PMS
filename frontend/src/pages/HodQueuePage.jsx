import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, phaseLabel, phaseColor } from '../utils/api';

// Matches Self-Appraisal/Team Evaluation's convention: per-KRA ratings in
// letter grades, overall figures in descriptive wording — fixed local
// maps rather than the cycle's own rating_scale labels, since this
// pairing should hold regardless of which label set a cycle has stored.
const KRA_GRADE_LABEL = { 5: 'A+', 4: 'A', 3: 'B+', 2: 'B', 1: 'C' };
const OVERALL_DESCRIPTIVE_LABEL = { 5: 'Outstanding', 4: 'Exceeds', 3: 'Meets Expectations', 2: 'Developing', 1: 'Needs Improvement' };
function nearestWholeValue(value) {
  if (value == null) return null;
  const values = [5, 4, 3, 2, 1];
  return values.reduce((closest, v) => Math.abs(v - value) < Math.abs(closest - value) ? v : closest, values[0]);
}
function overallLabel(value) {
  if (value == null) return '—';
  return `${OVERALL_DESCRIPTIVE_LABEL[nearestWholeValue(Number(value))] || value} (${Number(value).toFixed(1)})`;
}

export default function HodQueuePage() {
  const [data, setData] = useState(null); const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = () => api('/pms/hod/queue').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;
  const editable = data.cycle.phase === 'hod_eval';
  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Delivery Head Review</h2>
        <span className={`chip ${phaseColor(data.cycle.phase)}`}>{data.cycle.name} · {phaseLabel(data.cycle.phase)}</span>
        {data.departments?.length > 0 && <span className="text-xs text-navy-400">departments: {data.departments.join(', ')}</span>}
      </div>
      {!data.queue.length && <div className="card p-8 text-center text-sm text-navy-400">Nothing awaiting Delivery Head review — manager evaluations feed this queue as they are submitted.</div>}
      {data.queue.map(q => (
        <div key={q.employee_id} className="card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpenId(v => v === q.employee_id ? null : q.employee_id)}>
            {openId === q.employee_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-sm font-semibold flex-1">{q.name}</span>
            <span className="text-[11px] text-navy-400">{q.department || '—'}</span>
            <span className="text-xs">Manager: <b>{overallLabel(q.manager_rating)}</b></span>
          </button>
          {openId === q.employee_id && <HodRow q={q} editable={editable} reload={load} />}
        </div>
      ))}
    </div>
  );
}

// Requested: this view should show ratings given by BOTH the employee
// (self) and the manager against EACH KRA, not just the two flat overall
// numbers — so the Delivery Head can see exactly what's behind the
// manager's rating before finalising their own.
function HodRow({ q, editable, reload }) {
  const [detail, setDetail] = useState(null);
  const [detailErr, setDetailErr] = useState(null);
  const [v, setV] = useState(q.hod_rating ?? '');
  const [comment, setComment] = useState('');
  const [err, setErr] = useState(null);

  useEffect(() => {
    api(`/pms/hod/queue/${q.employee_id}/kras`).then(setDetail).catch(e => setDetailErr(e.message));
  }, [q.employee_id]);

  const save = async (submit) => {
    setErr(null);
    try {
      await api(`/pms/hod/queue/${q.employee_id}`, { method: 'PUT', body: JSON.stringify({ overall_rating: v === '' ? null : Number(v), comment: comment.trim() || null, submit }) });
      if (submit) reload();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      {detailErr && <p className="text-xs text-rose-600">{detailErr}</p>}
      {!detail && !detailErr && <p className="text-xs text-navy-400">Loading KRAs…</p>}
      {detail && (
        <div className="space-y-2">
          {!detail.kras.length && <p className="text-xs text-navy-400">No KRAs found for this employee this cycle.</p>}
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
                  <p>Employee: <b>{self != null ? (KRA_GRADE_LABEL[self] || self) : '—'}</b></p>
                  <p>Manager: <b>{mgr != null ? (KRA_GRADE_LABEL[mgr] || mgr) : '—'}</b></p>
                </div>
                {mgrComment && <p className="text-navy-500"><b>Manager's comment:</b> {mgrComment}</p>}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-navy-100">
        <div>
          <p className="text-xs text-navy-500">Manager's overall: <b>{overallLabel(q.manager_rating)}</b></p>
        </div>
        <div className="flex items-center gap-2">
          <label className="lbl mb-0">Delivery Head rating</label>
          {q.hod_status === 'submitted' ? (
            <span className="font-mono text-sm">{overallLabel(q.hod_rating)}</span>
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
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
