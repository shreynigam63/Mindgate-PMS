import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2, Library, Pencil, Save, X, Plus, AlertTriangle } from 'lucide-react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import KraTable from '../KraTable';
// The SAME grouping the employee's own KRA sheet uses. Asked for on
// 23 Sep: on this page every KRA carried its parameter as a chip on its
// own row, so a shelf with six "Project / Process" KRAs printed that
// label six times and the shelf read as a flat list. The client's own
// sheet (and the sheet this library was built from) groups the rows
// under the parameter, with the weight for the group — so this page now
// does too. Two implementations of one grouping would drift apart, so
// there is only the one.
import { groupByCategory, NO_CATEGORY } from './MyKRASheetPage';

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
  const [q, setQ] = useState('');
  const [panel, setPanel] = useState(null);   // 'add' | 'clear' | null
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
  // This search goes to the SERVER, unlike every other list in the
  // product: the library is 2,155 rows on the live tenant, and shipping
  // all of them to filter in the browser is the wrong trade at that size.
  // Debounced, so a round trip does not fire on every keystroke.
  const load = (d = dept, query = q) => {
    const p = new URLSearchParams();
    if (d && d !== '__none') p.set('department', d);
    if (query && query.trim()) p.set('q', query.trim());
    const qs = p.toString();
    return api(`/pms/hr/kra-library${qs ? `?${qs}` : ''}`).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const t = setTimeout(() => load(dept, q), 300);
    return () => clearTimeout(t);
  }, [q]);

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
  // Which of the two library-wide panels is open, if either. One at a
  // time: they are opposite actions and seeing both expanded at once
  // invites pressing the wrong one.
  const view = data.department_view;
  // Every designation the tenant knows about — the ones with a shelf and
  // the ones without. Typing a new one is allowed; this is a suggestion
  // list, not a constraint, because a shelf for a brand-new title is a
  // perfectly ordinary thing to want.
  const allDesignations = [...new Set([
    ...(data.shelves || []).map((x) => x.designation),
    ...(data.uncovered || []).map((x) => x.designation),
  ])].filter(Boolean).sort();

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
        {/* THE TWO WHOLE-LIBRARY ACTIONS, side by side.
            Add sits beside Clear because that is where it was asked for
            on 24 Sep — "Add option should be on left or right side of
            clear KRA option" — and because the pair reads as what it is:
            the two things you do to the library other than upload a file.
            CLEARING is the counterpart to the uploader's one real gap. An
            upload replaces only the shelves PRESENT in the file, which is
            the right default — two people can publish two departments
            without treading on each other — but it also means a smaller
            re-upload leaves every shelf the new file does not mention
            still standing and still being offered. This is the way to
            start from nothing, and it is deliberately not one click. */}
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-sec" onClick={() => { setPanel(panel === 'add' ? null : 'add'); }}>
            <Plus size={13} className="inline mr-1" />Add a KRA
          </button>
          {data.total_kras > 0 && (
            <button className="btn-sec !text-rose-600 !border-rose-200 hover:!bg-rose-50"
              onClick={() => { setPanel(panel === 'clear' ? null : 'clear'); }}>
              <Trash2 size={13} className="inline mr-1" />Clear the library ({data.total_kras} KRAs)
            </button>
          )}
        </div>
        {/* The panel opens BELOW the pair rather than in place of one of
            them: a full-width form between the two buttons pushed Clear
            onto its own row, and a control that moves when you press its
            neighbour is how people click the wrong thing. */}
        {panel === 'add' && (
          <AddKra departments={data.departments || []} designations={allDesignations}
            onDone={load} onClose={() => setPanel(null)} />
        )}
        {panel === 'clear' && data.total_kras > 0 && (
          <ClearLibrary total={data.total_kras} onDone={load} onClose={() => setPanel(null)} />
        )}
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

      <SearchBox value={q} onChange={setQ} placeholder="Search shelves by designation, department or KRA text…"
        shown={(data.shelves || []).length} total={data.total_shelves} />
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
  const [adding, setAdding] = useState(false);
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

  const startAdd = () => {
    setErr(null); setEditing(null); setAdding(true);
    setDraft({ title: '', category: '', suggested_weight: '', measures: '', description: '' });
  };

  const add = async () => {
    setErr(null); setBusy(true);
    try {
      // department is whatever shelf this panel is showing — a blank one
      // is the company-wide shelf, and the server stores that as NULL.
      const r = await api('/pms/hr/kra-library/entry', {
        method: 'POST',
        body: JSON.stringify({ ...draft, designation, department: department || null }),
      });
      setRows((rs) => [...rs, r.entry]);
      setAdding(false);
      if (onChanged) onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

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
  // groupByCategory reads `weight`; the library's column is
  // suggested_weight, so it is mapped in rather than the grouping being
  // taught a second field name.
  const groups = groupByCategory(rows.map((r) => ({ ...r, weight: r.suggested_weight })));

  return (
    <div className="bg-navy-50 px-4 py-3">
      {err && <p className="text-xs text-rose-600 mb-2">{err}</p>}
      {/* One table, the parameter merged across its KRAs — the shape of
          the sheet HR already works from. See KraTable.jsx. */}
      <KraTable
        groups={groups}
        kpiHeaderNote="(measuring metrics & data source)"
        totalLabel={`Total on the shelf — ${rows.length} KRA${rows.length === 1 ? '' : 's'}`}
        total={total}
        totalOk={Math.abs(total - 100) < 0.01}
        renderKra={({ k: r }) => (editing === r.id
          ? <input className="inp !text-xs" value={draft.title} onChange={set('title')} placeholder="KRA (S.M.A.R.T goal) *" />
          : <span>{r.title}</span>)}
        renderKpi={({ k: r }) => (editing === r.id ? (
          <div className="space-y-1.5">
            <textarea className="inp !text-xs" rows={2} value={draft.measures} onChange={set('measures')}
              placeholder="KPIs — measuring metrics & data source" />
            <textarea className="inp !text-xs" rows={2} value={draft.description} onChange={set('description')}
              placeholder="Comments (optional)" />
            <input className="inp !text-xs !w-44" value={draft.category} onChange={set('category')} placeholder="Parameter" />
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
            <span className="whitespace-pre-line">{r.measures || <i className="text-navy-300">no KPI recorded</i>}</span>
            {r.description && <div className="text-navy-400 mt-1">{r.description}</div>}
          </>
        ))}
        renderWeight={({ k: r }) => (editing === r.id ? (
          <div className="flex items-center justify-end gap-1">
            <input className="inp !text-xs !w-20 text-right" type="number" min="0" max="100" step="0.01"
              value={draft.suggested_weight} onChange={set('suggested_weight')} placeholder="wt" />
            <span className="text-navy-400 font-normal">%</span>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            {/* Blank is a real answer, not a zero — the shelf is a menu
                and some KRAs carry no suggested weight. */}
            <span>{r.suggested_weight == null ? '—' : `${Number(r.suggested_weight)}%`}</span>
            <button className="text-navy-300 hover:text-navy-700" title="Edit this KRA"
              onClick={() => open(r)}><Pencil size={12} /></button>
            {/* Delete sat inside the edit panel, so removing one line meant
                opening the editor for it first and reading past a Save
                button to find it. Asked for on 24 Sep as its own option;
                it is one now, on the row, next to the pencil. */}
            <button className="text-navy-300 hover:text-rose-600" title="Remove this KRA from the shelf"
              disabled={busy} onClick={() => remove(r)}><Trash2 size={12} /></button>
          </div>
        ))}
        // bodyFooter goes straight into <tbody>, so it has to BE a row.
        // Passing a bare <td> renders and looks right, and React logs a
        // validateDOMNesting warning a screenshot will never show you —
        // caught here by failing the browser check on console errors.
        bodyFooter={adding ? (
          <tr className="kt-add kt-last">
          <td colSpan={4} className="p-3 bg-white">
            <div className="grid sm:grid-cols-2 gap-2">
              <input className="inp !text-xs" autoFocus value={draft.title} onChange={set('title')}
                placeholder="KRA (S.M.A.R.T goal) *" />
              <input className="inp !text-xs" value={draft.category} onChange={set('category')}
                placeholder="Parameter — e.g. Financial" />
              <textarea className="inp !text-xs" rows={2} value={draft.measures} onChange={set('measures')}
                placeholder="KPIs — measuring metrics & data source" />
              <textarea className="inp !text-xs" rows={2} value={draft.description} onChange={set('description')}
                placeholder="Comments (optional)" />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[11px] text-navy-400">Suggested weightage</span>
              <input className="inp !text-xs !w-24 text-right" type="number" min="0" max="100" step="0.01"
                value={draft.suggested_weight} onChange={set('suggested_weight')} placeholder="blank = none" />
              <button className="btn-pri !py-1 !text-xs" disabled={busy || !draft.title.trim()} onClick={add}>
                <Save size={12} className="inline mr-1" />Add to shelf
              </button>
              <button className="btn-sec !py-1 !text-xs" disabled={busy} onClick={() => setAdding(false)}>
                <X size={12} className="inline mr-1" />Cancel
              </button>
            </div>
            <p className="text-[10.5px] text-navy-400 mt-1.5">
              Blank weightage is stored as “none”, not as 0% — a shelf is a menu and not every line
              carries a suggestion.
            </p>
          </td>
          </tr>
        ) : (
          <tr className="kt-add kt-last">
            {/* kt-param-add, not kt-param: this cell is the control that
                adds a KRA, not a parameter group. Anything counting the
                groups on this table would otherwise count it as one. */}
            <td colSpan={4} className="kt-param-add p-2">
              <button className="kt-addbtn" onClick={startAdd}>
                <Plus size={12} className="inline mr-1" />Add a KRA to this shelf
              </button>
            </td>
          </tr>
        )}
        legend={<>
          <Library size={11} className="inline mr-1" />
          A shelf is a <b>menu</b>, not an instruction — it may deliberately total more than 100,
          and the employee picks what applies with their manager. Edit a line with the pencil, or
          re-upload the designation to replace the whole shelf.
          {' '}<b>Employees who have already picked from this shelf keep what they added</b> — those
          are copies, and editing here changes only what the next person is offered.
        </>}
      />
    </div>
  );
}

// "Clear the library" — two gates, because this is the most destructive
// button on the HR tab and it acts on 2,155 rows on the live tenant.
//
//   the typed word   is intent: you cannot do this by mis-clicking.
//   confirm_count    is correctness: the server refuses unless the number
//                    still matches, so if a colleague published a shelf
//                    while this panel was open, the delete stops instead
//                    of quietly taking their work with it.
//
// It says out loud what it does NOT touch, because that is the question
// anybody sensible asks before pressing it: KRAs already on people's
// sheets are copies and are unaffected. Clearing the library loses the
// menu, not the orders.
function ClearLibrary({ total, onDone, onClose }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  const go = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api('/pms/hr/kra-library', {
        method: 'DELETE', body: JSON.stringify({ confirm_count: total }),
      });
      setDone(r.removed);
      setTyped('');
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (done != null) {
    return (
      <p className="text-xs text-leaf-600 font-semibold">
        Library cleared — {done} KRA{done === 1 ? '' : 's'} removed. Upload a file above to publish
        the new shelves.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 space-y-2">
      <p className="text-xs text-rose-800 flex items-start gap-2">
        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
        <span>
          This removes <b>all {total} KRAs</b> from every shelf, for every department and
          designation. Employees will be offered nothing until you publish again.
          {' '}<b>KRAs already on people&rsquo;s sheets are not affected</b> — those are copies.
          This cannot be undone from the app.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-rose-800">Type <b>DELETE</b> to confirm:</span>
        <input className="inp !text-xs !w-32" value={typed} autoFocus
          onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" />
        <button className="btn-pri !bg-rose-600 !py-1.5" disabled={busy || typed !== 'DELETE'} onClick={go}>
          {busy ? 'Clearing…' : `Clear all ${total}`}
        </button>
        <button className="btn-sec !py-1.5" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {err && <p className="text-xs text-rose-700 font-semibold">{err}</p>}
    </div>
  );
}

// "Add a KRA" at the page level, beside "Clear the library".
//
// Asked for on 24 Sep: "Add option should be on left or right side of
// clear KRA option." There is also a quick-add at the foot of each open
// shelf, which is the faster path when you are already looking at one —
// it knows the designation. This is the other direction: start from
// nothing, name the shelf, and it is created if it does not exist.
//
// Designation and Department are DATALISTS, not dropdowns. Suggesting
// what already exists stops the commonest way a shelf goes missing — a
// second spelling of a title nobody notices, so "AVP - Delivery Manager"
// and "AVP-Delivery Manager" become two shelves and half the people see
// neither. Typing a new one is still allowed, because publishing a shelf
// for a brand-new title is an ordinary thing to want.
function AddKra({ departments, designations, onDone, onClose }) {
  const blank = { designation: '', department: '', category: '', title: '',
                  measures: '', description: '', suggested_weight: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  const save = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await api('/pms/hr/kra-library/entry', {
        method: 'POST', body: JSON.stringify({ ...f, department: f.department || null }),
      });
      setDone(`Added to ${r.entry.designation}${r.entry.department ? ` · ${r.entry.department}` : ''}.`);
      // Keep the shelf, clear the KRA: adding three lines to one shelf is
      // the common case, and retyping the designation each time is the
      // kind of friction that sends people back to the spreadsheet.
      setF((v) => ({ ...blank, designation: v.designation, department: v.department }));
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-xl border border-lagoon-100 bg-lagoon-50/50 p-3 space-y-2">
      <p className="lbl mb-0">Add one KRA to a shelf</p>
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <input className="inp !text-xs" list="kl-designations" value={f.designation}
            onChange={set('designation')} placeholder="Designation * — e.g. Sales Manager" />
          <datalist id="kl-designations">
            {designations.map((d) => <option key={d} value={d} />)}
          </datalist>
        </div>
        <div>
          <input className="inp !text-xs" list="kl-departments" value={f.department}
            onChange={set('department')} placeholder="Department — blank = every department" />
          <datalist id="kl-departments">
            {departments.map((d) => <option key={d} value={d} />)}
          </datalist>
        </div>
        <input className="inp !text-xs" value={f.title} onChange={set('title')}
          placeholder="KRA (S.M.A.R.T goal) *" />
        <input className="inp !text-xs" value={f.category} onChange={set('category')}
          placeholder="Parameter — e.g. Financial" />
        <textarea className="inp !text-xs" rows={2} value={f.measures} onChange={set('measures')}
          placeholder="KPIs — measuring metrics & data source" />
        <textarea className="inp !text-xs" rows={2} value={f.description} onChange={set('description')}
          placeholder="Comments (optional)" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-navy-500">Suggested weightage</span>
        <input className="inp !text-xs !w-24 text-right" type="number" min="0" max="100" step="0.01"
          value={f.suggested_weight} onChange={set('suggested_weight')} placeholder="blank = none" />
        <button className="btn-pri !py-1.5" disabled={busy || !f.title.trim() || !f.designation.trim()}
          onClick={save}>{busy ? 'Adding…' : 'Add to the library'}</button>
        <button className="btn-sec !py-1.5" disabled={busy} onClick={onClose}>Close</button>
      </div>
      <p className="text-[10.5px] text-navy-400">
        A blank Department publishes to the company-wide shelf everyone with that title sees.
        Blank weightage is stored as “none”, not 0% — a shelf is a menu and not every line carries
        a suggestion. Naming a designation that has no shelf yet creates one.
      </p>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {done && <p className="text-xs text-leaf-600 font-semibold">{done} Add another, or Close.</p>}
    </div>
  );
}
