import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { MapPin, Info, AlertTriangle } from 'lucide-react';

// The HRBP tab: HR's operational screens, scoped to one partner's remit.
//
// Seven routes, one component. They differ only in which endpoint they
// read and which columns they show, and seven near-identical files would
// drift — the Timesheet tabs taught that already.
//
// THE EMPTY STATE IS THE MOST IMPORTANT THING ON THIS PAGE. There are
// three different reasons an HRBP sees nothing and they need different
// actions:
//
//   1. nothing is assigned to them          -> HR assigns a remit
//   2. a remit is assigned but matches none -> the master has no
//                                              location/HOD on it yet
//   3. the remit matches people and the
//      screen is genuinely empty            -> nothing to do
//
// Rendering a blank table for all three is how somebody concludes the
// product is broken, so each says which one it is.

const VIEWS = {
  '/hrbp/employees': { key: 'employees', title: 'My people', endpoint: '/pms/hrbp/employees',
    sub: 'Everyone in your remit, from the employee master.' },
  '/hrbp/approvals': { key: 'approvals', title: 'Approvals in my remit', endpoint: '/pms/hrbp/approvals',
    sub: 'Pending decisions for your people. Read-only — the manager or HR decides.' },
  '/hrbp/kra-overview': { key: 'kra', title: 'KRA overview', endpoint: '/pms/hrbp/kra-overview',
    sub: 'Who has a sheet, what state it is in, and whose weights do not total 100.' },
  '/hrbp/timesheet': { key: 'timesheet', title: 'Timesheet compliance', endpoint: '/pms/hrbp/timesheet',
    sub: 'Whether your people filled their timesheets.' },
  '/hrbp/completion-report': { key: 'completion', title: 'PMS completion', endpoint: '/pms/hrbp/completion-report',
    sub: 'How far through the cycle each of your people is.' },
  '/hrbp/competency-dashboard': { key: 'competency', title: 'Competency', endpoint: '/pms/hrbp/competency-dashboard',
    sub: 'Self and manager assessments, and where the manager rated below the required level.' },
  '/hrbp/nine-box': { key: 'ninebox', title: '9-Box', endpoint: '/pms/hrbp/nine-box',
    sub: 'Performance against potential, for your people only.' },
};

const Remit = ({ remit, coverage }) => (
  <div className="card p-3 text-xs space-y-1">
    <p className="flex flex-wrap items-center gap-1.5">
      <MapPin size={12} className="text-amber-700" />
      <span className="text-navy-500">Your remit:</span>
      {(remit.locations || []).map((l) => <span key={l} className="chip bg-amber-50 text-amber-700">{l}</span>)}
      {(remit.hods || []).map((h) => <span key={h} className="chip bg-navy-50 text-navy-600">HOD: {h}</span>)}
      {!remit.locations.length && !remit.hods.length && <span className="text-navy-400">nothing assigned</span>}
    </p>
    {coverage && (
      <p className="text-amber-700 flex items-start gap-1">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />{coverage.message}
      </p>
    )}
  </div>
);

const Empty = ({ reason, remit, total }) => (
  <div className="card p-8 text-center text-sm text-navy-400">
    {reason
      ? <span className="text-navy-600">{reason}</span>
      : (remit && (remit.locations.length || remit.hods.length) && !total)
        ? <>Your remit is set, but nobody in the employee master matches it yet — nobody carries
            those locations or HODs. The master has to be imported again with those columns.</>
        : 'Nothing here for your people.'}
  </div>
);

export default function HrbpPage() {
  const { pathname } = useLocation();
  const view = VIEWS[pathname] || VIEWS['/hrbp/employees'];
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    setD(null); setErr(null);
    api(view.endpoint).then(setD).catch((e) => setErr(e.message));
  }, [view.endpoint]);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const remit = d.remit || { locations: [], hods: [] };
  const rows = d.people || d.items || [];
  const shown = rows.filter((r) => {
    const e = r.employee || r;
    return matches(q, e.name, e.email, e.department, e.location, r.employee_name);
  });

  return (
    <div className="space-y-3 max-w-6xl mx-auto">
      <PageHead title={view.title} hue="amber" sub={view.sub} />
      <Remit remit={remit} coverage={d.coverage} />

      {d.summary && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(d.summary).map(([k, v]) => (
            <span key={k} className="chip bg-navy-50 text-navy-600">
              {k.replace(/_/g, ' ')}: <b className="ml-1">{v}</b>
            </span>
          ))}
        </div>
      )}
      {d.org_total != null && (
        <p className="text-[11px] text-navy-400 flex items-center gap-1">
          <Info size={11} />Showing {d.total} of {d.org_total} across the company — your remit, not the whole queue.
        </p>
      )}

      {!rows.length ? <Empty reason={d.reason} remit={remit} total={d.total} /> : (
        <>
          <SearchBox value={q} onChange={setQ} placeholder="Search your people…" />
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
                <tr>
                  <th className="text-left px-3 py-2">Employee</th>
                  <th className="text-left px-3 py-2">Location</th>
                  <th className="text-left px-3 py-2">HOD</th>
                  <th className="text-left px-3 py-2">{view.key === 'approvals' ? 'Waiting on' : 'Department'}</th>
                  <th className="text-left px-3 py-2">{COL[view.key].head}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {shown.map((r, i) => {
                  const e = r.employee || r;
                  return (
                    <tr key={e.id || r.id || i}>
                      <td className="px-3 py-2">
                        <span className="font-semibold text-navy-900">{e.name || r.employee_name}</span>
                        <span className="block text-[10px] text-navy-400">{e.designation || ''}</span>
                      </td>
                      <td className="px-3 py-2">{e.location || <span className="text-navy-300">—</span>}</td>
                      <td className="px-3 py-2">{e.hod_name || <span className="text-navy-300">—</span>}</td>
                      <td className="px-3 py-2">{view.key === 'approvals' ? (r.waiting_on || '—') : (e.department || '—')}</td>
                      <td className="px-3 py-2">{COL[view.key].cell(r, e)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-navy-400">
            This tab is read-only. Decisions stay with the manager and HR.
          </p>
        </>
      )}
    </div>
  );
}

// The one column that differs per view, kept in one table so a new view is
// a row here rather than another copy of the page.
const pct = (v) => (v == null ? '—' : `${Number(v)}%`);
const COL = {
  employees:  { head: 'Manager', cell: (r, e) => e.manager_name || '—' },
  approvals:  { head: 'Pending', cell: (r) => <span className="chip bg-amber-50 text-amber-700">{String(r.kind || '').replace(/_/g, ' ')}</span> },
  kra:        { head: 'KRA sheet', cell: (r) => (
    <span className={r.sheet_status ? '' : 'text-rose-600'}>
      {r.sheet_status || 'no sheet'}
      {r.sheet_status && <span className="text-navy-400"> · {r.kra_count} KRAs · {Number(r.weight_total)}%</span>}
    </span>) },
  timesheet:  { head: 'Compliance', cell: (r) => (r.has_data
    ? <span className={r.total.rating === 'Green' ? 'text-leaf-600' : r.total.rating === 'Amber' ? 'text-amber-600' : 'text-rose-600'}>
        {pct(r.total.pct)} · {r.total.rating}</span>
    : <span className="text-navy-300">nothing uploaded</span>) },
  completion: { head: 'Progress', cell: (r) => (
    <span className="flex flex-wrap gap-1">
      <span className={`chip ${r.has_kra_sheet ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-400'}`}>KRA</span>
      <span className={`chip ${r.self_done ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-400'}`}>self</span>
      <span className={`chip ${r.manager_done ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-400'}`}>manager</span>
    </span>) },
  competency: { head: 'Assessment', cell: (r) => (
    <span>
      <span className="text-navy-500">self {r.self_status || '—'} · manager {r.manager_status || '—'}</span>
      {r.below_required > 0 && <span className="chip bg-amber-50 text-amber-700 ml-1">{r.below_required} below required</span>}
    </span>) },
  ninebox:    { head: '9-box cell', cell: (r, e) => e.nine_box_cell || <span className="text-navy-300">unplaced</span> },
};
