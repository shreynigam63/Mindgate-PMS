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

  // "" = every shelf, "__none" = only the department-blank fallbacks,
  // anything else = that department's shelves plus the fallbacks they
  // sit behind, because seeing one without the other tells HR half the
  // story about what an employee in that department will be offered.
  const [dept, setDept] = useState('');
  const clearShelf = async (designation, department) => {
    const where = department ? `"${designation}" in ${department}` : `"${designation}" (all departments)`;
    if (!window.confirm(`Remove every library KRA for ${where}?\n\nKRAs already copied onto people's sheets are not affected.`)) return;
    setErr(null);
    try { await api(`/pms/hr/kra-library/${encodeURIComponent(designation)}?department=${encodeURIComponent(department || '')}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
  };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;

  const token = localStorage.getItem('apms_token');

  const shown = (data.shelves || []).filter((x) => (
    dept === '' ? true
      : dept === '__none' ? !x.department
      : (x.department || '') === dept || !x.department));

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

      {data.scope === 'designation' && !!(data.ambiguous || []).length && (
        <div className="card p-4 space-y-1 border-amber-200 bg-amber-50/60">
          <p className="lbl mb-0 text-amber-800">Department matching is switched off</p>
          <p className="text-[11px] text-amber-700">
            {data.ambiguous.length} job title{data.ambiguous.length === 1 ? '' : 's'} exist in more than
            one department — {data.ambiguous.reduce((n, a) => n + a.employees, 0)} employees — so those
            people all see one shelf. Turn on <b>department + designation</b> in HR Admin → Settings to
            give each department its own.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {data.ambiguous.slice(0, 8).map((a) => (
              <span key={a.designation} className="chip bg-white text-amber-800">
                {a.designation} · {a.departments} depts · {a.employees}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card divide-y divide-navy-50">
        <div className="p-3 flex flex-wrap items-end gap-3">
          <div>
            <p className="lbl mb-0">Published shelves</p>
          </div>
          {/* Sourced from the departments people actually hold on their
              employee records, so there is no list to keep up to date. */}
          <div className="ml-auto">
            <label className="lbl" htmlFor="dept-filter">Department</label>
            <select id="dept-filter" className="inp !py-1 !text-xs" value={dept}
              onChange={(e) => { setDept(e.target.value); setOpenShelf(null); }}>
              <option value="">All departments</option>
              <option value="__none">Fallback shelves only</option>
              {(data.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>
        {!data.shelves.length && (
          <p className="p-6 text-center text-sm text-navy-400">
            Nothing published yet. Upload a file above to create the first shelf.
          </p>
        )}
        {shown.map((s) => {
          const key = `${s.department || ''}|${s.designation}`;
          return (
          <div key={key}>
            <div className="p-3 flex flex-wrap items-center gap-3 text-sm">
              <button className="flex items-center gap-1.5 font-semibold min-w-0 flex-1 text-left"
                onClick={() => setOpenShelf(openShelf === key ? null : key)}>
                {openShelf === key ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="truncate">{s.designation}</span>
                {/* Which shelf this is. A blank department is not missing
                    data — it is the fallback used wherever no department
                    shelf has been published for the title. */}
                {s.department
                  ? <span className="chip bg-teal-100 text-teal-700 shrink-0">{s.department}</span>
                  : <span className="chip bg-navy-50 text-navy-500 shrink-0">all departments</span>}
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
                onClick={() => clearShelf(s.designation, s.department)}><Trash2 size={14} /></button>
            </div>
            {openShelf === key && <ShelfDetail designation={s.designation} department={s.department} />}
          </div>
          );
        })}
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

function ShelfDetail({ designation, department }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setRows(null);
    api(`/pms/hr/kra-library/${encodeURIComponent(designation)}?department=${encodeURIComponent(department || '')}`)
      .then((r) => setRows(r.entries)).catch((e) => setErr(e.message));
  }, [designation, department]);

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
