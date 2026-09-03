import { useEffect, useState } from 'react';
import { ShieldCheck, Sparkles, Trash2, AlertTriangle, RefreshCw } from 'lucide-react';
import { api, DraftBadge } from '../utils/api';

// HR-ONLY: the AI reading of an annual review meeting, against the seven
// organisational parameters.
//
// This page shows a confidential assessment of a named person that they
// have not seen. Three things follow from that, and they are why the page
// looks the way it does:
//
//   - It says so, at the top, unmissably. Somebody screen-sharing during
//     a calibration call needs to know before the employee's name is on
//     the projector.
//   - Every open is recorded server-side. That is stated here too, because
//     people behave differently when they know, and they should know.
//   - It shows the manager's ACTUAL scores next to the AI's reading of the
//     conversation. That comparison is the point; the AI reading on its
//     own invites being mistaken for a rating.
const SIGNAL = {
  strong:        ['Strong',        'bg-emerald-100 text-emerald-700'],
  mixed:         ['Mixed',         'bg-amber-100 text-amber-700'],
  concern:       ['Concern',       'bg-rose-100 text-rose-700'],
  not_discussed: ['Not discussed', 'bg-navy-100 text-navy-500'],
};

export default function ParameterAnalysisPage() {
  const [index, setIndex] = useState(null);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => api('/agentic/parameter-analysis/index')
    .then(r => setIndex(r.analyses))
    .catch(e => { if (e.status === 403) setDenied(true); else setErr(e.message); });
  useEffect(() => { load(); }, []);

  const view = async (employeeId, cycleId) => {
    setErr(null); setBusy(true);
    try { setOpen(await api(`/agentic/parameter-analysis?employee_id=${employeeId}&cycle_id=${cycleId}`)); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const findMeetings = async (employeeId) => {
    setErr(null);
    try {
      const r = await api(`/pms/meetings?context=annual&employee_id=${employeeId}`);
      setMeetings(r.meetings);
      if (!r.meetings.length) setErr('No annual review meeting is recorded for that employee yet.');
    } catch (e) { setErr(e.message); }
  };

  const analyse = async (meetingId) => {
    setErr(null); setBusy(true);
    try { setOpen(await api('/agentic/parameter-analysis', { method: 'POST', body: JSON.stringify({ meeting_id: meetingId }) })); load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const retract = async (id) => {
    if (!confirm('Delete this analysis? It cannot be recovered.')) return;
    try { await api(`/agentic/parameter-analysis/${id}`, { method: 'DELETE' }); setOpen(null); load(); }
    catch (e) { setErr(e.message); }
  };

  if (denied) {
    return (
      <div className="card p-8 max-w-xl mx-auto text-center space-y-2">
        <AlertTriangle size={20} className="inline text-amber-500" />
        <p className="text-sm font-semibold">This report is for HR only</p>
        <p className="text-xs text-navy-500">
          The parameter analysis of an annual review meeting is visible to HR administrators by design — not to the
          employee it concerns, and not to their manager.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Annual Review — Parameter Analysis</h2>
        <p className="text-xs text-navy-400">
          What the annual review conversation showed against each of the seven organisational parameters, read from the
          meeting transcript.
        </p>
      </div>

      <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex gap-2">
        <ShieldCheck size={16} className="text-rose-600 shrink-0 mt-0.5" />
        <div className="text-xs text-rose-900">
          <p className="font-bold">Confidential — HR only</p>
          <p className="mt-0.5">
            The employee and their manager cannot see this, and it is not in the employee's own data download.
            Every time it is opened is recorded against your name. It carries no rating: the official parameter
            scores are the ones people gave, shown alongside for comparison.
          </p>
        </div>
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}

      <div className="card p-4 space-y-2">
        <p className="lbl mb-0">Run a new analysis</p>
        <p className="text-[11px] text-navy-400">
          Needs an annual review meeting with a transcript stored, and the employee's recorded consent for AI use of
          meeting recordings. Without consent the request is refused.
        </p>
        <EmployeePicker onPick={findMeetings} />
        {meetings.map(m => (
          <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 border border-navy-100 rounded-lg p-2 text-xs">
            <span className="break-all">{m.meeting_url}{m.scheduled_at && ` · ${new Date(m.scheduled_at).toLocaleString()}`}</span>
            {m.has_transcript
              ? <button className="btn-pri !py-1" disabled={busy} onClick={() => analyse(m.id)}>
                  <Sparkles size={12} className="inline mr-1" />{busy ? 'Reading…' : 'Analyse'}</button>
              : <span className="text-amber-700">no transcript stored</span>}
          </div>
        ))}
      </div>

      {index && index.length > 0 && (
        <div className="card p-4">
          <p className="lbl">On record ({index.length})</p>
          <div className="divide-y divide-navy-100">
            {index.map(a => (
              <div key={`${a.employee_id}-${a.cycle_id}`} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <p className="font-semibold">{a.name} <span className="font-normal text-navy-400">· {a.department || '—'}</span></p>
                  <p className="text-[11px] text-navy-400">{a.cycle_name} · by {a.analysed_by} · {new Date(a.updated_at).toLocaleDateString('en-IN')}</p>
                </div>
                <button className="btn-sec !py-1" onClick={() => view(a.employee_id, a.cycle_id)}>Open</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {open && <AnalysisDetail data={open} onRetract={retract} onRefresh={() => analyse(open.analysis.meeting_id)} busy={busy} />}
    </div>
  );
}

function EmployeePicker({ onPick }) {
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState('');
  useEffect(() => { api('/employees?status=active').then(r => setRows(r.employees || [])).catch(() => {}); }, []);
  return (
    <div className="flex flex-wrap gap-2">
      <select className="inp grow min-w-[220px]" value={sel} onChange={e => setSel(e.target.value)}>
        <option value="">Choose an employee…</option>
        {rows.map(e => <option key={e.id} value={e.id}>{e.name} — {e.email}</option>)}
      </select>
      <button className="btn-sec" disabled={!sel} onClick={() => onPick(sel)}>Find their annual meeting</button>
    </div>
  );
}

function AnalysisDetail({ data, onRetract, onRefresh, busy }) {
  const a = data.analysis;
  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold text-sm">Parameter analysis</p>
          <p className="text-[11px] text-navy-400">by {a.analysed_by} · {new Date(a.updated_at).toLocaleString()}</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-sec" disabled={busy || !a.meeting_id} onClick={onRefresh}><RefreshCw size={13} className="inline mr-1" />Re-run</button>
          <button className="btn-sec !p-1.5" onClick={() => onRetract(a.id)} title="Delete this analysis"><Trash2 size={14} /></button>
        </div>
      </div>
      <DraftBadge />

      {data.by_parameter.map(p => {
        const [label, cls] = SIGNAL[p.signal] || SIGNAL.not_discussed;
        return (
          <div key={p.parameter_id} className="border border-navy-100 rounded-lg p-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-xs flex-1">{p.parameter}</p>
              <span className="text-[11px] text-navy-500">weightage {p.weight_pct}%</span>
              <span className={`chip ${cls}`}>{label}</span>
            </div>
            {/* The human scores, from the database. Shown next to the AI
                reading precisely so the two are never confused. */}
            <p className="text-[11px] text-navy-500">
              {/* The employee's own self-score against each parameter was
                  shown here too. Employee self-scoring has been removed
                  from the Self-Appraisal, so no cycle can have one from
                  here on and a permanent em-dash would only read as "the
                  employee scored nothing". The manager's scoring is what
                  the official annual rating is built from anyway. */}
              Scored by manager: <b>{p.manager_score ?? '—'}</b>
              <span className="text-navy-400"> (these are the official scores; the analysis below is not a score)</span>
            </p>
            {(p.summary || []).length > 0 && (
              <ul className="list-disc pl-4 text-xs">{p.summary.map((x, i) => <li key={i}>{x}</li>)}</ul>
            )}
            {(p.alignment || []).length > 0 && (
              <div className="text-xs"><p className="font-semibold text-navy-600">Alignment with policy and values</p>
                <ul className="list-disc pl-4">{p.alignment.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
            )}
            {(p.evidence || []).length > 0 && (
              <details className="text-[11px] text-navy-500">
                <summary className="cursor-pointer">From the meeting ({p.evidence.length})</summary>
                <ul className="list-disc pl-4 mt-1">{p.evidence.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </details>
            )}
            {p.signal === 'not_discussed' && !(p.summary || []).length && (
              <p className="text-[11px] text-navy-400">The conversation did not cover this parameter.</p>
            )}
          </div>
        );
      })}

      {[['achievements', 'Achievements named'], ['went_well', 'What went well'], ['went_wrong', 'What went wrong'],
        ['improvement_areas', 'Improvement areas'], ['meeting_gaps', 'Not reached in the meeting']].map(([k, label]) => (
        ((data.overall || {})[k] || []).length > 0 && (
          <div key={k} className="text-xs">
            <p className="lbl mb-0">{label}</p>
            <ul className="list-disc pl-4">{data.overall[k].map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
        )
      ))}
    </div>
  );
}
