import { Fragment, useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import StatusTabs from '../StatusTabs';
import KraTable from '../KraTable';
import { MidYearOnKra, groupByCategory } from './MyKRASheetPage';
import { CheckCircle2, Clock, Check, Undo2, ChevronRight, ChevronDown } from 'lucide-react';

// Every pending decision in the company, in one queue.
//
// Two kinds of row, and the page is honest about the difference: a KRA
// sheet or a growth plan has been SUBMITTED and is waiting on an
// approve-or-return, so it gets a checkbox and an Approve button. A
// mid-year sign-off or an evaluation is waiting on someone to WRITE their
// assessment — there is nothing to approve yet, so those rows show who
// they are waiting on and nothing else. Offering an Approve button there
// would mean writing an empty evaluation in someone else's name.
//
// EVERY DECIDABLE ROW OPENS. Asked for on 23 Sep: "return KRA option is
// missing, please add the same / also KRA view option is not available."
// The page could bulk-approve and nothing else, which meant approving
// scorecards sight unseen and having no way to send one back at all —
// the reviewer had to leave for Team KRA Sheets, which is manager-scoped
// and does not list everybody.
//
// So a row expands into the thing itself: the KRA sheet in the same
// Parameters / KRAs / KPIs / Weightage table the employee filled in, or
// the growth plan's goals. Approve and Return sit underneath it, and a
// Return needs a comment — the server refuses one without.
//
// RETURN IS PER ROW ONLY, deliberately. Approving twenty sheets at once
// says the same thing twenty times and is fine; returning twenty at once
// would send twenty people one shared reason, which is worse than no
// reason. You return what you have just looked at.
const KIND = {
  kra_sheet: { label: 'KRA sheet', chip: 'bg-lagoon-50 text-lagoon-700' },
  growth_plan: { label: 'Growth plan', chip: 'bg-violet-50 text-violet-700' },
  midyear: { label: 'Mid-Year', chip: 'bg-amber2-50 text-amber2-600' },
  evaluation: { label: 'Evaluation', chip: 'bg-brand-50 text-brand-600' },
  hod_evaluation: { label: 'Delivery head', chip: 'bg-navy-50 text-navy-600' },
};

const days = (iso) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
};

export default function ApprovalsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  const [openKey, setOpenKey] = useState(null);

  const load = () => api('/pms/approvals').then(d => { setData(d); setPicked({}); setOpenKey(null); }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div className="card p-4 text-sm text-rose-700">{err}</div>;
  if (!data) return <div className="card p-8 text-center text-sm text-navy-400">Loading…</div>;
  if (!data.cycle) return (
    <div className="space-y-4">
      <PageHead title="All Approvals" hue="violet" sub="Every pending decision across the whole company, in one place." />
      <div className="card p-8 text-center text-sm text-navy-400">No open cycle, so nothing is pending.</div>
    </div>
  );

  const rows = data.items.filter(i =>
    (filter === 'all' || i.kind === filter) &&
    (!q.trim() || `${i.employee_name} ${i.designation || ''} ${i.department || ''}`.toLowerCase().includes(q.toLowerCase())));
  const decidable = rows.filter(i => i.decidable);
  const chosen = decidable.filter(i => picked[i.row_key]);

  const approveChosen = async () => {
    setBusy(true); setReport(null);
    try {
      const r = await api('/pms/approvals/bulk', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', items: chosen.map(i => ({ kind: i.kind, id: i.id })) }),
      });
      setReport(r);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  // The same control the manager pages use, so a filter row means one
  // thing across the product rather than three near-identical ones.
  const TABS = [
    { key: 'all', label: 'All pending', count: data.total },
    ...Object.entries(KIND).map(([k, v]) => ({ key: k, label: v.label, count: data.counts[k] || 0 })),
  ];

  return (
    <div className="space-y-4">
      <PageHead title="All Approvals" hue="violet"
        sub={<>Every pending decision across the whole company, in one place · {data.cycle.name}</>}>
        <button className="btn-pri" disabled={!chosen.length || busy} onClick={approveChosen}>
          {busy ? 'Approving…' : `Approve selected${chosen.length ? ` (${chosen.length})` : ''}`}
        </button>
      </PageHead>

      {report && (
        <div className="card p-3 text-sm">
          <b>{report.approved} approved</b>{report.refused ? `, ${report.refused} refused` : ''}.
          {/* Per-row reasons, never a bare count: a refusal nobody can see
              is the same as a silent failure. */}
          {report.results.filter(r => r.error).map((r, i) => (
            <div key={i} className="text-xs text-rose-700 mt-1">{KIND[r.kind]?.label || r.kind}: {r.error}</div>
          ))}
        </div>
      )}

      <StatusTabs tabs={TABS} value={filter} onChange={setFilter} />

      <input className="inp" placeholder="Search across every approval queue…" value={q} onChange={e => setQ(e.target.value)} />

      {!rows.length && <div className="card p-8 text-center text-sm text-navy-400">Nothing pending here.</div>}
      {!!rows.length && (
        <div className="card overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase tracking-wide text-[10px]">
                <th className="p-3 w-8">
                  <input type="checkbox" className="accent-brand-500"
                    checked={!!decidable.length && chosen.length === decidable.length}
                    onChange={e => setPicked(e.target.checked
                      ? Object.fromEntries(decidable.map(i => [`${i.kind}:${i.id}`, true])) : {})} />
                </th>
                <th className="p-3">Employee</th><th className="p-3">Type</th>
                <th className="p-3">Waiting on</th><th className="p-3">Pending</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(i => {
                const key = i.row_key;
                const open = openKey === key;
                return (
                  <Fragment key={key}>
                    <tr className="border-t border-navy-50">
                      <td className="p-3">
                        {i.decidable
                          ? <input type="checkbox" className="accent-brand-500" checked={!!picked[key]}
                              onChange={e => setPicked(p => ({ ...p, [key]: e.target.checked }))} />
                          : <Clock size={13} className="text-navy-300" title="Nothing submitted to approve yet — this is waiting on the named person" />}
                      </td>
                      <td className="p-3">
                        {/* The name is the way in. A decidable row opens
                            the record; a waiting row has nothing to show,
                            so it stays plain text rather than a button
                            that does nothing. */}
                        {i.decidable ? (
                          <button className="text-left flex items-start gap-1.5"
                            onClick={() => setOpenKey(k => (k === key ? null : key))}>
                            {open ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-navy-400" />
                                  : <ChevronRight size={13} className="mt-0.5 shrink-0 text-navy-400" />}
                            <span>
                              <span className="font-bold block">{i.employee_name}</span>
                              <span className="text-[11px] text-navy-400">{i.designation || '—'}{i.department ? ` · ${i.department}` : ''}</span>
                            </span>
                          </button>
                        ) : (
                          <>
                            <div className="font-bold pl-[18px]">{i.employee_name}</div>
                            <div className="text-[11px] text-navy-400 pl-[18px]">{i.designation || '—'}{i.department ? ` · ${i.department}` : ''}</div>
                          </>
                        )}
                      </td>
                      <td className="p-3"><span className={`chip ${KIND[i.kind].chip}`}>{KIND[i.kind].label}</span></td>
                      <td className="p-3">{i.waiting_on || <span className="text-rose-600">no manager set</span>}</td>
                      <td className="p-3">{days(i.since)}</td>
                    </tr>
                    {open && (
                      <tr className="border-t border-navy-50 bg-navy-50/40">
                        <td />
                        <td colSpan={4} className="p-3">
                          <Record item={i} onDone={load} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-3 text-xs text-navy-500 flex items-start gap-2">
        <CheckCircle2 size={14} className="text-violet-600 shrink-0 mt-0.5" />
        <span>
          Open a row to read the sheet or plan before deciding on it. <b>Approve</b> can be done in
          bulk from the button above; <b>Return</b> is one row at a time, because a return has to
          say why and one shared reason sent to twenty people is worse than none.
          As <b>super admin</b> you can decide at any level for any employee — including your own
          records. Every self-approval is stamped in the audit log. Rows with a clock are not
          waiting on an approval: the named person still has to write their assessment.
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The record itself, opened under its row.
//
// It reads through the SAME endpoints the manager's own queue reads —
// GET /pms/team/kra-sheets/:id/kras and
// GET /pms/team/development-plans/:planId/goals — rather than a new
// HR-only pair. Both already admit pms_admin alongside the row's own
// manager, and both are what Team KRA Sheets and Team Target Achievements
// render, so this page shows the same thing rather than a second opinion
// about what a sheet looks like.
//
// It decides through /pms/approvals/bulk with a single item. That is this
// page's own route and the only one whose canDecide is unconditionally
// true, which is the access All Approvals exists to give: a super admin
// deciding at any level for anyone, their own records included, with the
// audit row stamped self_action.
function Record({ item, onDone }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const path = item.kind === 'kra_sheet'
    ? `/pms/team/kra-sheets/${item.id}/kras`
    : `/pms/team/development-plans/${item.id}/goals`;

  useEffect(() => {
    setDetail(null); setErr(null);
    api(path).then(setDetail).catch(e => setErr(e.message));
  }, [path]);

  const decide = async (decision) => {
    if (decision === 'returned' && !comment.trim()) {
      setErr('A return needs a comment — the employee has to know what to change.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await api('/pms/approvals/bulk', {
        method: 'POST',
        body: JSON.stringify({ decision, comment: comment.trim() || null, items: [{ kind: item.kind, id: item.id }] }),
      });
      // The bulk route answers 200 with a per-row result, so a refusal
      // arrives as data rather than as a thrown error. Reading only the
      // HTTP status here would report a refused return as a success and
      // close the panel on it.
      const row = (r.results || [])[0];
      if (row && row.error) { setErr(row.error); return; }
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {!detail && !err && <p className="text-xs text-navy-400">Loading…</p>}

      {detail && item.kind === 'kra_sheet' && (
        detail.kras.length
          ? <KraTable
              groups={groupByCategory(detail.kras)}
              kpiHeaderNote="(measuring metrics & data source)"
              totalLabel={detail.weights.ok
                ? 'Total weight'
                : 'Total weight — does not total 100, send it back rather than approving it'}
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
          : <p className="text-xs text-navy-400">
              This sheet was submitted with no KRAs on it. Return it rather than approving an empty
              scorecard.
            </p>
      )}

      {detail && item.kind === 'growth_plan' && (
        detail.goals.length
          ? <div className="space-y-1.5">
              {detail.goals.map((g) => (
                <div key={g.id} className="bg-white border border-navy-100 rounded-lg p-2.5 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <b className="text-sm">{g.title}</b>
                    <span className="shrink-0 text-navy-500">{g.progress_pct == null ? '—' : `${g.progress_pct}%`}</span>
                  </div>
                  {g.measure && <div className="text-navy-500 mt-0.5 whitespace-pre-line">{g.measure}</div>}
                  {g.target_date && <div className="text-[11px] text-navy-400 mt-0.5">Target: {g.target_date}</div>}
                </div>
              ))}
            </div>
          : <p className="text-xs text-navy-400">
              This plan was submitted with no goals on it. Return it rather than approving an empty
              plan.
            </p>
      )}

      {/* Their manager's last comment, if the record has been round once
          already. Deciding without it means repeating a return somebody
          has already had. */}
      {detail && (detail.sheet || detail.plan) && (detail.sheet || detail.plan).manager_comment && (
        <div className="bg-white border border-navy-100 rounded-lg p-2.5 text-xs">
          <p className="font-bold text-navy-500 uppercase text-[10px]">Last comment on this record</p>
          <p>{(detail.sheet || detail.plan).manager_comment}</p>
        </div>
      )}

      <textarea className="inp" rows={2} value={comment} onChange={e => setComment(e.target.value)}
        placeholder="Comment — required to return, optional to approve" />
      <div className="flex flex-wrap gap-2">
        <button className="btn-pri" disabled={busy} onClick={() => decide('approved')}>
          <Check size={13} className="inline mr-1" />Approve
        </button>
        <button className="btn-sec" disabled={busy} onClick={() => decide('returned')}>
          <Undo2 size={13} className="inline mr-1" />Return for edits
        </button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
