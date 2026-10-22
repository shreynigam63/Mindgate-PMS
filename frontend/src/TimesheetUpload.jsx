// HR → Timesheet → Upload (22 Oct).
//
// "Timesheet will be updated only by HR/Super Admin and not by employee
// ... for HR provide option to upload per person and bulk as well." So
// the upload left Self → Timesheet and lives here, in two modes:
//
//   Bulk        every row in the file loads against the person it names —
//               one project export carries the whole team;
//   One person  pick the employee; only their rows load, and every other
//               row in the file is listed back, not loaded.
//
// The server decides who may upload (timesheet.js mayUpload); this panel
// is only drawn when /timesheet/all says can_upload. Dry run, then load —
// the same two steps as every importer in this product.
//
// `person` fixes the mode to one person (the panel on a person's own
// timesheet); `people` is the roster the picker searches.
import { useState } from 'react';
import { api, API_BASE } from './utils/api';
import { matches } from './SearchBox';
import { Upload, FileSpreadsheet, Info, Download, Users, User } from 'lucide-react';

export default function TimesheetUpload({ people = [], person = null, onLoaded }) {
  const [mode, setMode] = useState(person ? 'one' : 'bulk');
  const [who, setWho] = useState(person);
  const [q, setQ] = useState('');
  const [file, setFile] = useState(null);
  // Bumped after an upload so the file box empties (Def-020: the old file
  // name stayed, and the next click re-sent it).
  const [inputKey, setInputKey] = useState(0);
  const [up, setUp] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const forOne = mode === 'one';
  const target = forOne ? who : null;
  const reset = () => { setUp(null); setErr(null); };
  const query = (commit) => [commit && 'commit=1', target && `employee_id=${target.id}`].filter(Boolean).join('&');

  const send = async (commit) => {
    setErr(null); setBusy(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const qs = query(commit);
      const r = await api(`/pms/timesheet/upload${qs ? `?${qs}` : ''}`, { method: 'POST', body: fd });
      setUp(r);
      if (commit) { setFile(null); setInputKey((k) => k + 1); if (onLoaded) onLoaded(r); }
    } catch (e) {
      setErr(e.message);
      setUp(e.data && (e.data.errors || e.data.skipped) ? e.data : null);
    } finally { setBusy(false); }
  };

  const tplQs = [`token=${localStorage.getItem('apms_token')}`, target && `employee_id=${target.id}`].filter(Boolean).join('&');
  const hits = q.trim().length >= 2
    ? people.filter((p) => matches(q, p.name, p.email, p.emp_code, p.department)).slice(0, 8) : [];
  const ready = !!file && (!forOne || !!who);

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="lbl mb-0 flex-1">{person ? `Upload timesheet for ${person.name}` : 'Upload timesheets'}</p>
        {!person && (
          <div className="flex gap-1">
            <button type="button" onClick={() => { setMode('bulk'); reset(); }}
              className={`chip px-3 py-1.5 ${mode === 'bulk' ? 'bg-navy-700 text-white' : 'bg-white text-navy-500 border border-navy-100'}`}>
              <Users size={11} className="inline mr-1" />Bulk — everyone in the file
            </button>
            <button type="button" onClick={() => { setMode('one'); reset(); }}
              className={`chip px-3 py-1.5 ${mode === 'one' ? 'bg-navy-700 text-white' : 'bg-white text-navy-500 border border-navy-100'}`}>
              <User size={11} className="inline mr-1" />One person
            </button>
          </div>
        )}
      </div>

      {forOne && !person && (
        <div className="space-y-1">
          {who ? (
            <p className="text-xs text-navy-700">
              For <b>{who.name}</b> <span className="text-navy-400">{who.email}</span>{' '}
              <button type="button" className="text-brand-600 underline ml-1" onClick={() => { setWho(null); setQ(''); reset(); }}>change</button>
            </p>
          ) : (
            <>
              <input className="inp !py-1.5 text-xs" placeholder="Find the employee — name, email, code or department…"
                value={q} onChange={(e) => setQ(e.target.value)} />
              {!!hits.length && (
                <div className="flex flex-wrap gap-1">
                  {hits.map((p) => (
                    <button key={p.id} type="button" className="chip bg-navy-50 text-navy-700 hover:bg-navy-100"
                      onClick={() => { setWho(p); setQ(''); reset(); }}>
                      {p.name}{p.department ? ` · ${p.department}` : ''}
                    </button>
                  ))}
                </div>
              )}
              {q.trim().length >= 2 && !hits.length && <p className="text-[11px] text-navy-400">Nobody matches “{q}”.</p>}
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input key={inputKey} type="file" accept=".csv,.xlsx,.xls" className="text-xs"
          onChange={(e) => { setFile(e.target.files[0]); reset(); }} />
        <button className="btn-sec" disabled={!ready || busy} onClick={() => send(false)}>
          <FileSpreadsheet size={13} className="inline mr-1" />Check the file
        </button>
        <button className="btn-pri" disabled={!ready || busy || !(up && up.loadable && !up.committed)}
          onClick={() => send(true)}>
          <Upload size={13} className="inline mr-1" />Upload
        </button>
        {/* The Zoho export's own layout (8 Oct), so a sheet filled in by
            hand uploads exactly like an export. For one person, its
            instructions name that person's Log owner and Owner Mail Id. */}
        <a className="btn-sec sm:ml-auto" title="The upload's layout, to fill in by hand"
          href={`${API_BASE}/pms/timesheet/template.xlsx?${tplQs}`}>
          <Download size={13} className="inline mr-1" />Download template (.xlsx)
        </a>
      </div>
      <p className="text-[11px] text-navy-400">
        Upload the Zoho Sprints export as it comes — the sheet's own header row is found, wherever it
        sits — or the template filled in by hand.{' '}
        {forOne
          ? <><b>Only {target ? `${target.name}'s` : 'the chosen person’s'} rows are loaded</b>; every other row in the file is listed back and left alone.</>
          : <><b>Every row loads against the person it names</b> (by Owner Mail Id, else by Log owner).</>}
        {' '}Uploading again replaces only the days the new file has logs for, person by person, and
        leaves every other day untouched. Employees see their own report on Self → Timesheet.
      </p>

      {err && <p className="text-xs text-rose-600">{err}</p>}
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
          {!!(up.employees || []).length && (
            <p className="text-navy-600">
              {up.committed ? 'Loaded for' : 'Will load for'}{' '}
              <b>{up.employees.length} {up.employees.length === 1 ? 'person' : 'people'}</b>:{' '}
              {up.employees.slice(0, 10).map((e) => e.name).join(', ')}
              {up.employees.length > 10 && ` and ${up.employees.length - 10} more`}
            </p>
          )}
          {up.committed && up.replaced > 0 && (
            <p className="text-navy-600">{up.replaced} log{up.replaced === 1 ? '' : 's'} already stored for those days {up.replaced === 1 ? 'was' : 'were'} replaced. Other days were not touched.</p>
          )}
          {!up.committed && up.replaces_stored > 0 && (
            <p className="text-amber-700">Uploading will replace {up.replaces_stored} log{up.replaces_stored === 1 ? '' : 's'} already stored for the days in this file. Other days stay as they are.</p>
          )}
          {up.meta && (up.meta.project_name || up.meta.team_name) && (
            <p className="text-navy-400">{[up.meta.team_name, up.meta.project_name, up.meta.exported_on].filter(Boolean).join(' · ')}</p>
          )}
          {!!up.skipped_total && (
            <div>
              <p className="text-navy-600"><Info size={11} className="inline mr-1" />
                <b>{up.skipped_total}</b> row{up.skipped_total === 1 ? ' belongs to someone else and was' : 's belong to other people and were'}
                {' '}not loaded — this upload is for {up.for_employee ? up.for_employee.name : 'one person'} only.
                Use <b>Bulk</b> to load everyone in the file.</p>
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
  );
}
