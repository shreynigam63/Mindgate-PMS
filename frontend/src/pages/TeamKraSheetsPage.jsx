import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Check, Undo2 } from 'lucide-react';
import { api } from '../utils/api';
import { MidYearOnKra } from './MyKRASheetPage';

// Fix guide item #5 (BR-1.3): confirmed root cause was that no frontend
// page anywhere called the existing, working GET /team/kra-sheets and
// POST /team/kra-sheets/:sheetId/decide endpoints — "Team Evaluation" is a
// different feature (manager ratings, BR-5.4/6.x), not KRA approval. This
// page is the missing piece, built on the same expandable-list pattern as
// TeamEvalPage.jsx for a consistent feel.
const STATUS_COLOR = {
  not_started: 'bg-navy-50 text-navy-500',
  draft: 'bg-slate-100 text-navy-600',
  submitted: 'bg-amber-100 text-amber-700',
  returned: 'bg-rose-100 text-rose-700',
  approved: 'bg-emerald-100 text-emerald-700',
};

export default function TeamKraSheetsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => api('/pms/team/kra-sheets').then(r => { setData(r); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const pendingCount = data.sheets.filter(s => s.status === 'submitted').length;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Team KRA Sheets</h2>
        <span className="chip bg-navy-50 text-navy-600">{data.cycle.name}</span>
        {pendingCount > 0 && <span className="chip bg-amber-100 text-amber-700">{pendingCount} awaiting your review</span>}
      </div>
      {/* Fixed: this used to say "No direct reports found in the employee
          mirror" for an EMPTY sheets list — but that list previously came
          from an inner join on kra_sheets, so it read empty even when
          direct reports genuinely existed and simply hadn't touched their
          KRA yet. Now driven by core.employees directly (see the backend
          fix), so an empty list here means zero reports, for real. */}
      {!data.sheets.length && <div className="card p-8 text-center text-sm text-navy-400">No direct reports found.</div>}
      {data.sheets.map(s => (
        <div key={s.employee_id} className="card overflow-hidden">
          <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpenId(v => v === s.employee_id ? null : s.employee_id)}>
            {openId === s.employee_id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="text-sm font-semibold flex-1">{s.employee_name}</span>
            <span className="text-[11px] text-navy-400">{s.kra_count} KRA{s.kra_count === 1 ? '' : 's'} · {s.total_weight}%</span>
            <span className={`chip ${STATUS_COLOR[s.status] || STATUS_COLOR.not_started}`}>{s.status}</span>
          </button>
          {openId === s.employee_id && (
            s.id
              ? <SheetEditor sheet={s} reload={load} />
              : <p className="border-t border-navy-100 p-4 text-xs text-navy-400">This report hasn't started their KRAs for this cycle yet — nothing to review.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function SheetEditor({ sheet, reload }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/pms/team/kra-sheets/${sheet.id}/kras`).then(setDetail).catch(e => setErr(e.message));
  }, [sheet.id]);

  const decide = async (decision) => {
    if (decision === 'returned' && !comment.trim()) { setErr('A return needs a comment — the employee must know why.'); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/pms/team/kra-sheets/${sheet.id}/decide`, { method: 'POST', body: JSON.stringify({ decision, comment: comment.trim() || null }) });
      reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const canDecide = sheet.status === 'submitted';

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      {sheet.manager_comment && (
        <div className="bg-navy-50 border border-navy-100 rounded-lg p-3 text-xs">
          <p className="font-bold text-navy-500 uppercase text-[10px]">Your last comment</p>
          <p>{sheet.manager_comment}</p>
        </div>
      )}
      {!detail && !err && <p className="text-xs text-navy-400">Loading KRAs…</p>}
      {detail && (
        <div className="space-y-2">
          {!detail.kras.length && <p className="text-xs text-navy-400">No KRAs added yet.</p>}
          {detail.kras.map(k => (
            <div key={k.id} className="bg-navy-50 rounded-lg p-3 text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold flex-1">{k.title}</p>
                <span className="text-navy-500 font-medium">{k.weight}%</span>
              </div>
              {k.description && <p className="text-navy-600">{k.description}</p>}
              {k.measures && <p className="text-navy-400"><b>Measures:</b> {k.measures}</p>}
              <MidYearOnKra midyear={k.midyear} />
            </div>
          ))}
          <p className={`text-[11px] font-medium ${detail.weights.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
            Total weight: {detail.weights.total}%{!detail.weights.ok && ' (does not total 100 — flag with the employee)'}
          </p>
        </div>
      )}
      {canDecide && (
        <div className="space-y-2">
          <textarea className="inp" rows={2} placeholder="Comment (required if returning)" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button className="btn-pri" disabled={busy} onClick={() => decide('approved')}><Check size={13} className="inline mr-1" />Approve</button>
            <button className="btn-sec" disabled={busy} onClick={() => decide('returned')}><Undo2 size={13} className="inline mr-1" />Return for edits</button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
