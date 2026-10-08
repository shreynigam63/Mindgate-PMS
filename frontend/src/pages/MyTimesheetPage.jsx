// Self tab → Timesheet.
//
// Asked for on 25 Sep: "only upload option and their own report should
// be available for employees and upload option should be available in
// 'self' tab." So this page is exactly two things — an upload and your
// own report. There is no list of colleagues on it and no way to reach
// one: /pms/timesheet/me only ever returns the caller's own logs, and
// the upload loads the caller's own rows and reports the rest.
import { useEffect, useState } from 'react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import TimesheetDashboard, { RatingChip } from '../TimesheetDashboard';
import TimesheetTabs from '../TimesheetTabs';
import TimesheetKra from '../TimesheetKra';
import { Upload, FileSpreadsheet, Info, Download } from 'lucide-react';

export default function MyTimesheetPage() {
  const [report, setReport] = useState(null);
  const [err, setErr] = useState(null);
  const [file, setFile] = useState(null);
  const [up, setUp] = useState(null);
  const [upErr, setUpErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('compliance');

  const load = () => api('/pms/timesheet/me').then(setReport).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Dry run, then commit — the same two steps as every other importer in
  // this product, so nobody has to learn a second upload.
  const send = async (commit) => {
    setUpErr(null); setBusy(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api(`/pms/timesheet/upload${commit ? '?commit=1' : ''}`, { method: 'POST', body: fd });
      setUp(r);
      if (commit) { load(); setFile(null); }
    } catch (e) {
      setUpErr(e.message);
      setUp(e.data && (e.data.errors || e.data.skipped) ? e.data : null);
    } finally { setBusy(false); }
  };

  if (err) return <p className="text-sm text-rose-600">{err}</p>;

  // WHOSE ROWS DID THAT UPLOAD ACTUALLY LOAD. An admin may upload anyone's
  // export — the row-level scope rule is bypassed for pms_admin — and the
  // rows then belong to the person named in the file, not to the uploader.
  // This page reads only the signed-in user's own logs, so it would sit
  // there saying "Nothing uploaded yet" directly underneath "73 loaded",
  // which reads as a failure and is how this was reported as a bug.
  const landedOnOthers = (up && up.committed ? (up.employees || []) : [])
    .filter((e) => !(report && report.employee && e.id === report.employee.id));

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Timesheet" hue="navy"
        sub="Upload your timesheet export and see how your own compliance reads.">
        {report && report.total && !report.total.no_data && <RatingChip rating={report.total.rating} />}
      </PageHead>

      <div className="card p-4 space-y-2">
        <p className="lbl">Upload your export</p>
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" accept=".csv,.xlsx,.xls" className="text-xs"
            onChange={(e) => { setFile(e.target.files[0]); setUp(null); setUpErr(null); }} />
          <button className="btn-sec" disabled={!file || busy} onClick={() => send(false)}>
            <FileSpreadsheet size={13} className="inline mr-1" />Check the file
          </button>
          <button className="btn-pri" disabled={!file || busy || !(up && up.loadable && !up.committed)}
            onClick={() => send(true)}>
            <Upload size={13} className="inline mr-1" />Upload
          </button>
          {/* The template is the Zoho export's own layout (8 Oct), so a
              sheet filled in by hand uploads exactly like an export. */}
          <a className="btn-sec sm:ml-auto" title="The upload's layout, to fill in by hand"
            href={`${API_BASE}/pms/timesheet/template.xlsx?token=${localStorage.getItem('apms_token')}`}>
            <Download size={13} className="inline mr-1" />Download template (.xlsx)
          </a>
        </div>
        <p className="text-[11px] text-navy-400">
          Export your timesheet from Zoho Sprints and upload the file as it comes — the sheet's own
          header row is found, wherever it sits. No export to hand? <b>Download the template</b>: it
          has the export's layout, with the columns to fill shaded and explained. <b>Only your own rows are loaded.</b> A project
          export usually carries the whole team; everybody else's rows are listed back to you and
          left alone. Uploading again replaces the days the new file covers and leaves every other
          day untouched, so re-uploading the same export changes nothing.
        </p>

        {upErr && <p className="text-xs text-rose-600">{upErr}</p>}
        {up && (
          <div className="rounded-lg border border-navy-100 p-3 text-xs space-y-2">
            <p className="font-semibold text-navy-900">
              {up.committed ? 'Uploaded.' : 'Checked — nothing saved yet.'}{' '}
              <span className="font-normal text-navy-600">
                {up.total_rows} row{up.total_rows === 1 ? '' : 's'} read,
                {' '}<b>{up.loadable}</b> {up.committed ? 'loaded' : 'ready to load'}
                {up.hours != null && !!up.loadable && <> · <b>{up.hours}</b> hours</>}
                {up.first_log_date && <> · {up.first_log_date} to {up.last_log_date}</>}
              </span>
            </p>
            {up.meta && (up.meta.project_name || up.meta.team_name) && (
              <p className="text-navy-400">{[up.meta.team_name, up.meta.project_name, up.meta.exported_on].filter(Boolean).join(' · ')}</p>
            )}
            {!!landedOnOthers.length && (
              <div className="rounded border border-lagoon-100 bg-lagoon-50/60 p-2">
                <p className="text-navy-700"><Info size={11} className="inline mr-1" />
                  Those {up.loadable} row{up.loadable === 1 ? '' : 's'} belong to{' '}
                  <b>{landedOnOthers.map((e) => e.name).join(', ')}</b>, not to you.
                  This page shows your own logs only, so it stays empty.
                </p>
                <p className="text-navy-500 mt-0.5">
                  Open their record under <b>HR → Timesheet</b>, or <b>Manager → Timesheet</b> if they report to you.
                </p>
              </div>
            )}
            {!!up.skipped_total && (
              <div>
                <p className="text-navy-600"><Info size={11} className="inline mr-1" />
                  <b>{up.skipped_total}</b> row{up.skipped_total === 1 ? '' : 's'} belong to other people and
                  were not loaded. Their own upload covers them.</p>
                <div className="flex flex-wrap gap-1 mt-1">
                  {[...new Set(up.skipped.map((x) => x.owner))].slice(0, 12).map((o) => (
                    <span key={o} className="chip bg-navy-50 text-navy-500">{o}</span>
                  ))}
                </div>
              </div>
            )}
            {!!(up.errors || []).length && (
              <div>
                <p className="text-rose-700 font-semibold">{up.errors.length} row{up.errors.length === 1 ? '' : 's'} could not be read</p>
                <ul className="list-disc ml-5 text-rose-700">
                  {up.errors.slice(0, 8).map((e, i) => <li key={i}>Row {e.line}: {e.error}</li>)}
                </ul>
                {up.errors.length > 8 && <p className="text-navy-400">…and {up.errors.length - 8} more.</p>}
              </div>
            )}
          </div>
        )}
      </div>

      {!report ? <p className="text-sm text-navy-400">Loading…</p>
        : report.total && report.total.no_data ? (
          <div className="card p-8 text-center text-sm text-navy-400">
            {landedOnOthers.length ? (
              <>
                You have no logs of your own. The file you just uploaded belongs to{' '}
                <b className="text-navy-700">{landedOnOthers.map((e) => e.name).join(', ')}</b> —
                open their record under <b className="text-navy-700">HR → Timesheet</b> to read it.
              </>
            ) : 'Nothing uploaded yet. Your report appears here as soon as you upload an export.'}
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
