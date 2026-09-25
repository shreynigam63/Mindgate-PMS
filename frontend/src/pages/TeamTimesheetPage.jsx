// Manager tab → Timesheet.
//
// Asked for on 25 Sep: "dashboard attached in second HTML file should be
// available under 'manager' tab for reportees reporting to particular
// Manager." So: the manager's own direct reports, the roster first and
// the full dashboard for whoever they pick.
//
// DIRECT REPORTS ONLY, and the scope is enforced on the server — both on
// the roster (/timesheet/team reads manager_id = the caller) and on the
// detail (/timesheet/employee/:id refuses anybody who is not the
// caller's report). A page that filters a full list in the browser is
// not access control.
import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox from '../SearchBox';
import TimesheetDashboard, { RatingChip } from '../TimesheetDashboard';
import { Users, CheckCircle2, AlertTriangle, XCircle, ChevronLeft } from 'lucide-react';

function Stat({ icon: Icon, hue, n, label, sub }) {
  return (
    <div className="stat">
      <span className={`stat-i si-${hue}`}><Icon size={22} /></span>
      <span className="stat-t">
        <span className="stat-l">{label}</span>
        <span className="stat-n">{n}</span>
        {sub && <span className="block text-[10.5px] text-navy-400 mt-0.5">{sub}</span>}
      </span>
    </div>
  );
}

export function TimesheetRoster({ rows, onOpen, q, setQ, showDepartment }) {
  const shown = rows.filter((r) => {
    if (!q.trim()) return true;
    const t = q.trim().toLowerCase();
    const e = r.employee;
    return [e.name, e.email, e.emp_code, e.designation, e.department]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(t));
  });
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="lbl">Timesheet compliance</p>
        <SearchBox value={q} onChange={setQ} placeholder="Search a person"
          shown={shown.length} total={rows.length} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
              <th className="px-3 py-2">Employee</th>
              {showDepartment && <th className="px-3 py-2">Department</th>}
              <th className="px-3 py-2">Current cycle</th>
              <th className="px-3 py-2">Filled</th>
              <th className="px-3 py-2">Missing</th>
              <th className="px-3 py-2">Hours</th>
              <th className="px-3 py-2">Overall</th>
              <th className="px-3 py-2">Rating</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const cc = r.current_cycle;
              return (
                <tr key={r.employee.id} onClick={() => onOpen(r.employee)}
                  className="border-b border-navy-50 cursor-pointer hover:bg-navy-50/60">
                  <td className="px-3 py-2">
                    <span className="font-semibold text-navy-900">{r.employee.name}</span>
                    <span className="block text-navy-400">{r.employee.designation || r.employee.email}</span>
                  </td>
                  {showDepartment && <td className="px-3 py-2 text-navy-500">{r.employee.department || '—'}</td>}
                  {/* Six columns follow the name (and the department one,
                      when it is shown), so the colSpan is 6 either way. */}
                  {!r.has_data ? (
                    <td className="px-3 py-2 text-navy-400" colSpan="6">
                      <span className="chip bg-navy-50 text-navy-500">nothing uploaded yet</span>
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-navy-500">
                        {cc ? `${cc.filled} / ${cc.work} days` : '—'}
                        {cc && cc.in_progress && <span className="block text-[10px] text-navy-400">in progress</span>}
                      </td>
                      <td className="px-3 py-2">{r.logged_days} / {r.working_days}</td>
                      <td className={`px-3 py-2 ${r.missing ? 'text-rose-600 font-semibold' : ''}`}>{r.missing}</td>
                      <td className="px-3 py-2">{r.hours}</td>
                      <td className="px-3 py-2 font-semibold">{r.pct}%</td>
                      <td className="px-3 py-2"><RatingChip rating={r.rating} /></td>
                    </>
                  )}
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={showDepartment ? 8 : 7} className="px-3 py-8 text-center text-navy-400">
                {rows.length ? 'Nobody matches that search.' : 'Nobody reports to you in the employee master.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function TeamTimesheetPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [report, setReport] = useState(null);

  useEffect(() => { api('/pms/timesheet/team').then(setD).catch((e) => setErr(e.message)); }, []);
  useEffect(() => {
    if (!open) { setReport(null); return; }
    setReport(null);
    api(`/pms/timesheet/employee/${open.id}`).then(setReport).catch((e) => setErr(e.message));
  }, [open]);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const rows = d.team || [];
  const withData = rows.filter((r) => r.has_data);

  if (open) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <PageHead title={open.name} hue="lagoon"
          sub={[open.designation, open.department].filter(Boolean).join(' · ')}>
          <button className="btn-sec" onClick={() => setOpen(null)}>
            <ChevronLeft size={13} className="inline mr-1" />Back to the team
          </button>
        </PageHead>
        {report ? <TimesheetDashboard report={report} /> : <p className="text-sm text-navy-400">Loading…</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Team Timesheet" hue="lagoon"
        sub="Timesheet compliance for the people who report to you. Click anyone for their full record." />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon={Users} hue="lagoon" n={rows.length} label="Your reportees"
          sub={`${withData.length} have uploaded`} />
        <Stat icon={CheckCircle2} hue="leaf" n={withData.filter((r) => r.rating === 'Green').length} label="Green" />
        <Stat icon={AlertTriangle} hue="amber" n={withData.filter((r) => r.rating === 'Amber').length} label="Amber" />
        <Stat icon={XCircle} hue="red" n={withData.filter((r) => r.rating === 'Red').length} label="Red" />
      </div>
      {rows.length > withData.length && (
        <p className="card p-3 text-[11.5px] text-navy-600 border-l-4 border-amber2-500">
          <b>{rows.length - withData.length}</b> of your {rows.length} reportees have uploaded nothing yet,
          so they carry no rating. They are not Red — there is simply no data about them.
        </p>
      )}
      <TimesheetRoster rows={rows} onOpen={setOpen} q={q} setQ={setQ} />
    </div>
  );
}
