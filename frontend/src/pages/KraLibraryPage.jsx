import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Library, Pencil, Save, X } from 'lucide-react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';

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

  // "" = every published shelf. "__none" = only the department-blank
  // fallbacks. Anything else asks the server what people in THAT
  // department are offered, title by title.
  const [dept, setDept] = useState('');
  // The second half of the cascade. Empty means "every title in this
  // department"; a value narrows the view to one. Reset whenever the
  // department changes, since a title rarely exists in both.
  const [desig, setDesig] = useState('');

  // The department is part of the request now, not just a client-side
  // filter: the server answers "what will people in this department see?",
  // which needs the employee master and cannot be derived from the shelf
  // list alone.
  const load = (d = dept) => api(`/pms/hr/kra-library${d && d !== '__none' ? `?department=${encodeURIComponent(d)}` : ''}`)
    .then(setData).catch((e) => setErr(e.message));
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

  // Only the two list-shaped choices filter the published shelves. A real
  // department switches the card to the server's department view instead,
  // because filtering this list by department was the bug: with no
  // department shelves published, every shelf is a fallback, so every
  // department showed the identical 267 rows and the filter looked dead.
  const shown = (data.shelves || []).filter((x) => (dept === '__none' ? !x.department : true));
  const view = data.department_view;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="KRA Library" hue="teal"
        sub={<>
        Suggested KRAs published per designation. Employees pick from their own role's shelf
        when writing their KRAs — everything they add stays fully editable.
        </>} />

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
          Columns: <b>Department</b>, Designation, Parameters, KRA (S.M.A.R.T GOALS), KPIs
          (Measuring Metrics &amp; Data Source), Suggested Weightage, Comments. Every worksheet is
          read, so a multi-tab role workbook publishes in one go.
          {' '}<b>Department is optional</b> and behaves like Designation: written once it carries
          down the rows beneath it, and a new Designation clears it. Blank on a designation's
          first row publishes a company-wide shelf everyone with that title sees; naming one
          publishes a shelf only that department sees.
          {' '}<b>A shelf does not need to total 100</b> — it is a menu, and employees pick a
          hundred points' worth from it. Publishing <b>replaces</b> the shelf for each department
          and designation in the file and leaves every other shelf untouched.
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
              onChange={(e) => { setDept(e.target.value); setDesig(''); setOpenShelf(null); load(e.target.value); }}>
              <option value="">All departments</option>
              <option value="__none">Fallback shelves only</option>
              {(data.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          {/* The cascade. Without a department chosen this would be 267
              options — the designation bottleneck itself. Choosing one
              first cuts it to the titles that department actually employs,
              which for Development is 42 and for most is far fewer. */}
          {!!(data.department_view || []).length && (
            <div>
              <label className="lbl" htmlFor="desig-filter">Designation</label>
              <select id="desig-filter" className="inp !py-1 !text-xs" value={desig}
                onChange={(e) => setDesig(e.target.value)}>
                <option value="">All {data.department_view.length} titles in {data.department}</option>
                {data.department_view.map((r) => (
                  <option key={r.designation} value={r.designation}>
                    {r.designation} · {r.employees} {r.employees === 1 ? 'person' : 'people'}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {view && (
          <div className="p-3 space-y-2">
            <p className="text-[11px] text-navy-500">
              What people in <b>{data.department}</b> are offered today — one row per job title
              that department actually employs.
            </p>
            {!view.length && (
              <p className="text-sm text-navy-400 py-4 text-center">
                No active employees are recorded in {data.department}.
              </p>
            )}
            {view.filter((r) => !desig || r.designation === desig).map((r) => (
              <div key={r.designation} className="flex flex-wrap items-center gap-2 text-sm border-t border-navy-50 pt-2">
                <span className="font-semibold min-w-0 flex-1 truncate">{r.designation}</span>
                <span className="chip bg-navy-50 text-navy-500">{r.employees} employee{r.employees === 1 ? '' : 's'}</span>
                {/* The whole point of this view: which shelf lands on those
                    people's screens, and whether anybody wrote it for them. */}
                {r.source === 'own' && <span className="chip bg-teal-100 text-teal-700">{r.kras} KRAs · own shelf</span>}
                {r.source === 'fallback' && <span className="chip bg-navy-50 text-navy-600">{r.kras} KRAs · company-wide</span>}
                {r.source === 'none' && <span className="chip bg-amber-100 text-amber-700">no shelf at all</span>}
                {r.source !== 'none' && (
                  <button className="text-[11px] text-navy-500 hover:text-navy-700"
                    onClick={() => setOpenShelf(openShelf === r.designation ? null : r.designation)}>
                    {openShelf === r.designation ? 'Hide KRAs' : 'View KRAs'}
                  </button>
                )}
                {openShelf === r.designation && (
                  <div className="w-full">
                    {/* The shelf these people are actually served: their own
                        department's if it has one, otherwise the fallback. */}
                    <ShelfDetail designation={r.designation}
                      department={r.source === 'own' ? data.department : null}
                      onChanged={() => load(dept)} />
                  </div>
                )}
              </div>
            ))}
            {!!view.length && (
              <p className="text-[11px] text-navy-400 pt-1">
                <b>{view.filter((r) => r.source === 'own').length}</b> of {view.length} titles have a
                shelf written for {data.department};{' '}
                <b>{view.filter((r) => r.source === 'fallback').length}</b> fall back to the
                company-wide one;{' '}
                <b>{view.filter((r) => r.source === 'none').length}</b> have none at all.
                Upload a file with a <b>Department</b> column to give this department its own.
              </p>
            )}
          </div>
        )}
        {!view && !data.shelves.length && (
          <p className="p-6 text-center text-sm text-navy-400">
            Nothing published yet. Upload a file above to create the first shelf.
          </p>
        )}
        {!view && shown.map((s) => {
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
            {openShelf === key && <ShelfDetail designation={s.designation} department={s.department}
              onChanged={() => load(dept)} />}
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

// The expanded shelf — and, since 17 Sep, where HR fixes it.
//
// Asked for directly: "KRAs and weightage should be editable for HR and
// admin login under KRA library." Before this the only way to correct a
// typo in a published KRA was to re-upload the entire designation, which
// nobody does for one word — so the typo stayed on every employee's
// shelf.
//
// One row at a time, saved on its own. Two people tidying different KRAs
// on the same shelf cannot overwrite each other, and a row edit cannot
// delete the rows it did not send.
function ShelfDetail({ designation, department, onChanged }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(null);   // the row id being edited
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const load = () => {
    setRows(null);
    api(`/pms/hr/kra-library/${encodeURIComponent(designation)}?department=${encodeURIComponent(department || '')}`)
      .then((r) => setRows(r.entries)).catch((e) => setErr(e.message));
  };
  useEffect(load, [designation, department]);

  const open = (r) => {
    setErr(null);
    setEditing(r.id);
    setDraft({
      title: r.title || '', category: r.category || '',
      suggested_weight: r.suggested_weight == null ? '' : String(Number(r.suggested_weight)),
      measures: r.measures || '', description: r.description || '',
    });
  };
  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const save = async (id) => {
    setErr(null); setBusy(true);
    try {
      const r = await api(`/pms/hr/kra-library/entry/${id}`, { method: 'PUT', body: JSON.stringify(draft) });
      setRows((rs) => rs.map((x) => (x.id === id ? r.entry : x)));
      setEditing(null);
      // The chips above this panel count KRAs and total the weights, so
      // they go stale the moment a weight changes here.
      if (onChanged) onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Remove "${r.title}" from the ${designation} shelf?\n\n`
      + 'KRAs already copied onto people\'s sheets are not affected.')) return;
    setErr(null); setBusy(true);
    try {
      await api(`/pms/hr/kra-library/entry/${r.id}`, { method: 'DELETE' });
      setRows((rs) => rs.filter((x) => x.id !== r.id));
      if (onChanged) onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (err && !rows) return <p className="px-4 pb-3 text-xs text-rose-600">{err}</p>;
  if (!rows) return <p className="px-4 pb-3 text-xs text-navy-400">Loading…</p>;

  const total = rows.reduce((n, r) => n + (Number(r.suggested_weight) || 0), 0);

  return (
    <div className="bg-navy-50 px-4 py-3 space-y-1.5">
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {rows.map((r) => (
        <div key={r.id} className="bg-white rounded-lg p-2.5 text-xs space-y-1">
          {editing === r.id ? (
            <div className="space-y-1.5">
              <input className="inp !text-xs" value={draft.title} onChange={set('title')}
                placeholder="KRA (S.M.A.R.T goal) *" />
              <div className="flex flex-wrap items-center gap-2">
                <input className="inp !text-xs !w-44" value={draft.category} onChange={set('category')}
                  placeholder="Parameter" />
                <div className="flex items-center gap-1">
                  <input className="inp !text-xs !w-24 text-right" type="number" min="0" max="100" step="0.01"
                    value={draft.suggested_weight} onChange={set('suggested_weight')} placeholder="wt" />
                  <span className="text-navy-400">%</span>
                </div>
                {/* Blank is a real answer, not a zero — the shelf is a
                    menu and some KRAs carry no suggested weight. */}
                <span className="text-[11px] text-navy-400">blank = no suggested weight</span>
              </div>
              <textarea className="inp !text-xs" rows={2} value={draft.measures} onChange={set('measures')}
                placeholder="KPIs / measures" />
              <textarea className="inp !text-xs" rows={2} value={draft.description} onChange={set('description')}
                placeholder="Comments (optional)" />
              <div className="flex items-center gap-2">
                <button className="btn-pri !py-1 !text-xs" disabled={busy} onClick={() => save(r.id)}>
                  <Save size={12} className="inline mr-1" />Save
                </button>
                <button className="btn-sec !py-1 !text-xs" disabled={busy} onClick={() => setEditing(null)}>
                  <X size={12} className="inline mr-1" />Cancel
                </button>
                <button className="text-[11px] text-rose-500 hover:text-rose-700 ml-auto"
                  disabled={busy} onClick={() => remove(r)}>
                  <Trash2 size={12} className="inline mr-1" />Remove from shelf
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold flex-1">{r.title}</p>
                {r.category && <span className="chip bg-lagoon-50 text-lagoon-700 shrink-0">{r.category}</span>}
                <span className="text-navy-500 font-medium shrink-0">{r.suggested_weight == null ? '—' : `${Number(r.suggested_weight)}%`}</span>
                <button className="text-navy-400 hover:text-navy-700 shrink-0" title="Edit this KRA"
                  onClick={() => open(r)}><Pencil size={12} /></button>
              </div>
              {r.measures && <p className="text-navy-400 whitespace-pre-line"><b>Measures:</b> {r.measures}</p>}
              {r.description && <p className="text-navy-500">{r.description}</p>}
            </>
          )}
        </div>
      ))}
      <p className="text-[11px] text-navy-400 pt-1">
        <Library size={11} className="inline mr-1" />
        {rows.length} KRA{rows.length === 1 ? '' : 's'} · {Math.round(total * 100) / 100}% on the shelf.
        Edit a line with the pencil, or re-upload the designation to replace the whole shelf.
        {' '}<b>Employees who have already picked from this shelf keep what they added</b> — those
        are copies, and editing here changes only what the next person is offered.
      </p>
    </div>
  );
}
