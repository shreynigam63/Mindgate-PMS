import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Check, Undo2 } from 'lucide-react';
import { api } from '../utils/api';
import { MidYearOnKra, groupByCategory, NO_CATEGORY } from './MyKRASheetPage';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import StatusTabs, { statusTabs } from '../StatusTabs';
import KraTable from '../KraTable';

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
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('submitted');   // the manager's own queue first
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = () => api('/pms/team/kra-sheets')
    .then(r => { setData(r); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const pendingCount = data.sheets.filter(s => s.status === 'submitted').length;

  // Pending and approved are separate tabs now, not one list with a count
  // in the header. An approved sheet used to look identical to one nobody
  // had touched until you opened it.
  const TABS = [
    { key: 'submitted', label: 'Pending your review', tone: 'bg-amber2-500 text-white',
      match: v => v === 'submitted' },
    { key: 'approved', label: 'Approved', tone: 'bg-leaf-500 text-white',
      match: v => v === 'approved' },
    { key: 'returned', label: 'Returned', tone: 'bg-rose-500 text-white',
      match: v => v === 'returned' },
    { key: 'open', label: 'Not submitted', tone: 'bg-navy-700 text-white',
      match: v => !v || v === 'draft' || v === 'not_started' },
  ];
  const tabs = statusTabs(data.sheets || [], 'status', TABS);
  const active = TABS.find(t => t.key === tab);

  // Filtered in the browser: this list is one team or one

  // department, not the whole company, so there is nothing to gain

  // from a round trip per keystroke.

  const sheetsShown = (data.sheets || [])
    .filter(s => !active || active.match(s.status))
    .filter(s => matches(q, s.employee_name, s.designation, s.department, s.status));

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Team KRA Sheets" hue="navy">
        <span className="chip bg-navy-50 text-navy-600">{data.cycle.name}</span>
        {pendingCount > 0 && <span className="chip bg-amber-100 text-amber-700">{pendingCount} awaiting your review</span>}
      </PageHead>
      {/* Fixed: this used to say "No direct reports found in the employee
          mirror" for an EMPTY sheets list — but that list previously came
          from an inner join on kra_sheets, so it read empty even when
          direct reports genuinely existed and simply hadn't touched their
          KRA yet. Now driven by core.employees directly (see the backend
          fix), so an empty list here means zero reports, for real. */}
      <StatusTabs tabs={tabs} value={tab} onChange={setTab} />
      <SearchBox value={q} onChange={setQ} placeholder="Search your team by name, designation or status…"
        shown={sheetsShown.length} total={(data.sheets || []).filter(s => !active || active.match(s.status)).length} />
      {!data.sheets.length && <div className="card p-8 text-center text-sm text-navy-400">No direct reports found.</div>}
      {sheetsShown.map(s => (
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
          {/* Grouped by the sheet's Parameters column, and by the same
              function the employee's own page uses — a manager reviewing a
              sheet should see the structure the employee filled in, and
              two implementations of one grouping would drift apart.
              Read-only here: the parameter is set on the sheet, not in
              review. The per-group weight makes an unbalanced scorecard
              visible at approval time, which is when it can still be
              sent back. */}
          {/* THE SAME TABLE the employee filled in and the library
              publishes. A manager reviewing a sheet should see the
              structure the employee saw — a third rendering of one thing
              is how the three drift apart. Read-only: the parameter is
              set on the sheet, not in review. */}
          {detail.kras.length > 0 && (
            <KraTable
              groups={groupByCategory(detail.kras)}
              kpiHeaderNote="(measuring metrics & data source)"
              totalLabel={detail.weights.ok
                ? 'Total weight'
                : 'Total weight — does not total 100, flag with the employee'}
              total={detail.weights.total}
              totalOk={detail.weights.ok}
              renderKra={({ k }) => <span>{k.title}</span>}
              renderKpi={({ k }) => (
                <div className="space-y-1">
                  <span className="whitespace-pre-line">{k.measures || <i className="text-navy-300">no KPI recorded</i>}</span>
                  {k.description && <div className="text-navy-400">{k.description}</div>}
                  <MidYearOnKra midyear={k.midyear} />
                </div>
              )}
              renderWeight={({ k }) => <span>{k.weight == null ? '—' : `${Number(k.weight)}%`}</span>}
            />
          )}
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
