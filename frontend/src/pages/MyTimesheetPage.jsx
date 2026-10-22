// Self tab → Timesheet.
//
// Asked for on 25 Sep: "only upload option and their own report should
// be available for employees". Since 22 Oct the upload is HR's alone
// ("Timesheet will be updated only by HR/Super Admin and not by
// employee"), so this page is the employee's own report and nothing else:
// /pms/timesheet/me only ever returns the caller's own logs, and the
// server refuses an upload from anyone but HR or Super Admin.
import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import TimesheetDashboard, { RatingChip } from '../TimesheetDashboard';
import TimesheetTabs from '../TimesheetTabs';
import TimesheetKra from '../TimesheetKra';

export default function MyTimesheetPage() {
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const [view, setView] = useState('compliance');

  useEffect(() => { api('/pms/timesheet/me').then(setReport).catch((e) => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Timesheet" hue="navy"
        sub="Your timesheet is uploaded by HR. This is how your own compliance reads.">
        {report && report.total && !report.total.no_data && <RatingChip rating={report.total.rating} />}
      </PageHead>

      {!report ? <p className="text-sm text-navy-400">Loading…</p>
        : report.total && report.total.no_data ? (
          <div className="card p-8 text-center text-sm text-navy-400">
            Nothing uploaded for you yet. HR uploads timesheets; your report appears here as soon as
            yours is loaded.
          </div>
        ) : (
          <>
            {report.last_upload && (
              <p className="text-[11px] text-navy-400">
                Last upload: {report.last_upload.source_file || 'a file'}
                {report.last_upload.project_name && ` · ${report.last_upload.project_name}`}
                {' '}· {new Date(report.last_upload.created_at).toLocaleString()}
              </p>
            )}
            <TimesheetTabs value={view} onChange={setView} />
            {view === 'compliance'
              ? <TimesheetDashboard report={report} />
              /* Read-only: canMap is false and there is no path that
                 sets it true here. An employee mapping their own hours
                 would be self-marking, and the server refuses it too. */
              : <TimesheetKra canMap={false} />}
          </>
        )}
    </div>
  );
}
