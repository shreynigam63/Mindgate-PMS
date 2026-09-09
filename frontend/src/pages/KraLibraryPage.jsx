import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Library } from 'lucide-react';
import { api, API_BASE } from '../utils/api';

// KRA Library — HR publishes a shelf of suggested KRAs per designation,
// and employees pick from their own role's shelf when writing their KRAs.
//
// SEPARATE FROM THE BULK UPLOAD ON KRA OVERVIEW, and the difference is the
// whole point:
//
//   Bulk upload  — keyed on employee_email. "These KRAs, on this person's
//                  sheet, now." Assignment. Scales with headcount.
//   This page    — keyed on designation. "These KRAs are available to
//                  anyone with this job title." A menu. Scales with roles,
//                  and survives into next year's cycle.
//
// Both exist because each does something the other cannot.
export default function KraLibraryPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [upErr, setUpErr] = useState(null);
  const [openShelf, setOpenShelf] = useState(null);

  const load = () => api('/pms/hr/kra-library').then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Dry run first, then commit — the same two-step the employee importer
  // uses, so HR sees what a file will do before it does it.
  const send = async (commit) => {
    setUpErr(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api(`/pms/hr/kra-library/upload${commit ? '?commit=1' : ''}`, { method: 'POST', body: fd });
      setReport(r);
      if (commit) { load(); setOpenShelf(null); }
    } catch (e) { setUpErr(e.message); setReport(e.data && e.data.errors ? e.data : null); }
  };

  const clearShelf = async (designation) => {
    if (!window.confirm(`Remove every library KRA for "${designation}"?\n\nKRAs already copied onto people's sheets are not affected.`)) return;
    setErr(null);
    try { await api(`/pms/hr/kra-library/${encodeURIComponent(designation)}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
  };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;

  const token = localStorage.getItem('apms_token');

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">KRA Library</h2>
        <p className="text-xs text-navy-400">
          Suggested KRAs published per designation. Employees pick from their own role's shelf
          when writing their KRAs — everything they add stays fully editable.
        </p>
      </div>

      <div className="card p-4 space-y-2">
        <p className="lbl">Publish a shelf — one row per KRA, keyed on Designation, dry run first</p>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-sec" href={`${API_BASE}/pms/hr/kra-library/template.xlsx?token=${token}`}>Download template (.xlsx)</a>
          <a className="btn-sec" href={`${API_BASE}/pms/hr/kra-library/template.csv?token=${token}`}>.csv</a>
          <input type="file" accept=".csv,.xlsx,.xls" className="text-xs"
            onChange={(e) => { setFile(e.target.files[0]); setReport(null); }} />
          <button className="btn-sec" disabled={!file} onClick={() => send(false)}>Validate</button>
          <button className="btn-pri" disabled={!file || !(report && report.ok && !report.committed)} onClick={() => send(true)}>Publish</button>
        </div>
        <p className="text-[11px] text-navy-400">
          Columns: Designation, Parameters, KRA (S.M.A.R.T GOALS), KPIs (Measuring Metrics &amp; Data
          Source), Suggested Weightage, Comments. Every worksheet is read, so a multi-tab role
          workbook publishes in one go.
          {' '}<b>A shelf does not need to total 100</b> — it is a menu, and employees pick a
          hundred points' worth from it. Publishing <b>replaces</b> the shelf for each designation
          in the file and leaves every other designation untouched.
        </p>
        {upErr && <p className="text-xs text-rose-600">{upErr}</p>}
        {report && (
          <div className="text-xs space-y-1">
            <p className="font-semibold">
              {report.committed ? 'PUBLISHED' : report.ok ? 'VALID — publish to go live' : 'REJECTED'}
              {report.summary && ` · ${report.summary.total_rows} KRAs · ${report.summary.designations} designation${report.summary.designations === 1 ? '' : 's'} · ${report.summary.errors} errors · ${report.summary.warnings} warnings`}
            </p>
            {(report.errors || []).map((e, i) => <p key={i} className="text-rose-600">{e.sheet ? `${e.sheet} ` : ''}row {e.line}: {e.error}</p>)}
            {(report.warnings || []).map((w, i) => <p key={i} className="text-amber-700">{w.sheet ? `${w.sheet} ` : ''}row {w.line}: {w.warning}</p>)}
          </div>
        )}
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}

      <div className="card divide-y divide-navy-50">
        <div className="p-3">
          <p className="lbl mb-0">Published shelves</p>
        </div>
        {!data.shelves.length && (
          <p className="p-6 text-center text-sm text-navy-400">
            Nothing published yet. Upload a file above to create the first shelf.
          </p>
        )}
        {data.shelves.map((s) => (
          <div key={s.designation}>
            <div className="p-3 flex flex-wrap items-center gap-3 text-sm">
              <button className="flex items-center gap-1.5 font-semibold min-w-0 flex-1 text-left"
                onClick={() => setOpenShelf(openShelf === s.designation ? null : s.designation)}>
                {openShelf === s.designation ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="truncate">{s.designation}</span>
              </button>
              <span className="chip bg-navy-50 text-navy-600">{s.kras} KRA{s.kras === 1 ? '' : 's'}</span>
              <span className="chip bg-navy-50 text-navy-500">{Math.round(s.total_weight * 100) / 100}% on the shelf</span>
              {/* The number that decides whether this shelf is doing
                  anything. Zero means it is published and unreachable —
                  almost always a designation spelled differently here than
                  on the employee records. */}
              <span className={`chip ${s.employees ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {s.employees} employee{s.employees === 1 ? '' : 's'}
              </span>
              <button className="text-rose-500" title={`Remove the ${s.designation} shelf`}
                onClick={() => clearShelf(s.designation)}><Trash2 size={14} /></button>
            </div>
            {openShelf === s.designation && <ShelfDetail designation={s.designation} />}
          </div>
        ))}
      </div>

      {/* The actionable half of this screen. A list of what IS published
          tells HR what they have done; this tells them what is left. */}
      {!!data.uncovered.length && (
        <div className="card p-4 space-y-2">
          <p className="lbl mb-0">Designations with no shelf yet</p>
          <p className="text-[11px] text-navy-400">
            People holding these titles see no library and write their KRAs from scratch. Ordered
            by how many employees that affects.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {data.uncovered.map((u) => (
              <span key={u.designation} className="chip bg-navy-50 text-navy-600">
                {u.designation} · {u.employees}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShelfDetail({ designation }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setRows(null);
    api(`/pms/hr/kra-library/${encodeURIComponent(designation)}`)
      .then((r) => setRows(r.entries)).catch((e) => setErr(e.message));
  }, [designation]);

  if (err) return <p className="px-4 pb-3 text-xs text-rose-600">{err}</p>;
  if (!rows) return <p className="px-4 pb-3 text-xs text-navy-400">Loading…</p>;

  return (
    <div className="bg-navy-50 px-4 py-3 space-y-1.5">
      {rows.map((r) => (
        <div key={r.id} className="bg-white rounded-lg p-2.5 text-xs space-y-1">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold flex-1">{r.title}</p>
            {r.category && <span className="chip bg-lagoon-50 text-lagoon-700 shrink-0">{r.category}</span>}
            <span className="text-navy-500 font-medium shrink-0">{r.suggested_weight == null ? '—' : `${Number(r.suggested_weight)}%`}</span>
          </div>
          {r.measures && <p className="text-navy-400 whitespace-pre-line"><b>Measures:</b> {r.measures}</p>}
          {r.description && <p className="text-navy-500">{r.description}</p>}
        </div>
      ))}
      <p className="text-[11px] text-navy-400 pt-1">
        <Library size={11} className="inline mr-1" />
        Re-upload this designation to change the shelf. Employees who have already picked from it
        keep what they added — those are copies.
      </p>
    </div>
  );
}
