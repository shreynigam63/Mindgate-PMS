import { useEffect, useState, useMemo, Fragment } from 'react';
import { Settings2, Trash2, Search, ArrowUpDown, ArrowUp, ArrowDown, X } from 'lucide-react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';

const ROLES = ['employee', 'manager', 'hod', 'hr', 'admin'];

// Which employee field each sortable column reads. Keys here are also
// the internal identifiers used in sort state — they're never shown to
// the user, so column header labels can change without touching this.
const SORT_FIELDS = {
  emp_code: 'emp_code',
  name: 'name',
  email: 'email',
  department: 'department',
  manager_email: 'manager_email',
  status: 'status',
  role: 'role',
};

// The KRA auto-assign half of the import report.
//
// Reads both vocabularies deliberately: the dry run reports what the commit
// WOULD do, the commit reports what it DID, and HR reads the same block in
// both places rather than learning a second layout on the second click.
//
// Three things are worth a chip, and they are not the same thing:
//   - people who got KRAs                       (the feature worked)
//   - people whose designation has no shelf     (HR must publish one)
//   - shelves whose weights do not total 100    (those people cannot submit)
// The last one is the quiet failure: the KRAs arrive and look fine, and the
// employee only discovers the problem when the submit button refuses them.
function ImportKraAssign({ report }) {
  const done = !!report.committed;
  const assigned = report.kras_to_auto_assign || report.kras_auto_assigned || [];
  const skipped = report.kras_not_auto_assigned || [];
  const noShelf = report.kras_with_no_shelf
    || skipped.filter((x) => x.reason === 'no_shelf_for_designation');
  // Everything else the assign declined to do — an existing sheet with KRAs
  // already on it, no open cycle, an error. Never hidden: a new hire with an
  // empty sheet looks identical whether the rule skipped them on purpose or
  // the code broke.
  const otherSkips = skipped.filter((x) => x.reason !== 'no_shelf_for_designation');
  const badWeights = assigned.filter((x) => x.weights_ok === false);
  if (!assigned.length && !noShelf.length && !otherSkips.length) return null;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1.5">
        {assigned.length > 0 && (
          <span className="chip bg-lagoon-50 text-lagoon-700">
            {assigned.length} new hire{assigned.length === 1 ? '' : 's'} {done ? 'given' : 'will get'} KRAs from the library
          </span>)}
        {noShelf.length > 0 && (
          <span className="chip bg-amber-100 text-amber-700">
            {noShelf.length} {done ? 'got no KRAs' : 'will get none'} — no library shelf for their designation
          </span>)}
        {badWeights.length > 0 && (
          <span className="chip bg-amber-100 text-amber-700">
            {badWeights.length} shelf weight{badWeights.length === 1 ? '' : 's'} do not total 100% — they cannot submit until fixed
          </span>)}
        {otherSkips.length > 0 && (
          <span className="chip bg-navy-50 text-navy-600">{otherSkips.length} skipped</span>)}
      </div>
      {!!noShelf.length && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-amber-700 font-semibold">
            Designations with no KRA library shelf — publish one, then re-import or assign by hand
          </summary>
          <div className="pt-1 space-y-0.5">
            {noShelf.map((p, i) => (
              <p key={`${p.email}-${i}`} className="text-navy-500">
                <b>{p.designation || 'no designation'}</b>
                {p.department ? ` · ${p.department}` : ''} — {p.email}
              </p>
            ))}
          </div>
        </details>
      )}
      {!!badWeights.length && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-amber-700 font-semibold">
            Shelves whose weights do not total 100% — fix them in the KRA Library
          </summary>
          <div className="pt-1 space-y-0.5">
            {badWeights.map((p, i) => (
              <p key={`${p.email}-w${i}`} className="text-navy-500">
                <b>{p.designation}</b>{p.department ? ` · ${p.department}` : ''} — {p.kras} KRAs totalling {p.weight_total}%
              </p>
            ))}
          </div>
        </details>
      )}
      {!!otherSkips.length && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-navy-500 font-semibold">Why the rest were skipped</summary>
          <div className="pt-1 space-y-0.5">
            {otherSkips.map((p, i) => (
              <p key={`${p.email}-s${i}`} className="text-navy-500">{p.email} — {p.reason}{p.error ? `: ${p.error}` : ''}</p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export default function DirectoryPage() {
  const [rows, setRows] = useState(null);
  const [report, setReport] = useState(null);
  const [file, setFile] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState('');
  // Default sort matches the server's own ORDER BY name — the same
  // ordering people currently see, just now explicitly a starting state
  // that they can change rather than an unchangeable server-side choice.
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState('asc'); // 'asc' | 'desc'

  const load = () => api('/employees').then(r => setRows(r.employees)).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  // Filter + sort in ONE memoised pass so unrelated re-renders (opening
  // a Manage panel, typing in the setup form) don't re-run this. The
  // filter is intentionally forgiving — a single query string matched
  // against the fields a user could plausibly remember (name, email,
  // employee id, department, manager email), case-insensitive — rather
  // than making the user pick which column to search first.
  const displayedRows = useMemo(() => {
    if (!rows) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter(r =>
          (r.name || '').toLowerCase().includes(q) ||
          (r.email || '').toLowerCase().includes(q) ||
          (r.emp_code || '').toLowerCase().includes(q) ||
          (r.department || '').toLowerCase().includes(q) ||
          (r.manager_email || '').toLowerCase().includes(q))
      : rows;

    const field = SORT_FIELDS[sortKey];
    const sorted = [...filtered].sort((a, b) => {
      const av = (a[field] || '').toString().toLowerCase();
      const bv = (b[field] || '').toString().toLowerCase();
      // Rows with an empty value for this field sort AFTER rows with a
      // value in ascending order — putting blanks at the end regardless
      // of direction feels less jarring than mixing them in via the
      // usual "" < "a" comparison, and matches most spreadsheet UIs.
      if (av === '' && bv !== '') return 1;
      if (bv === '' && av !== '') return -1;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [rows, query, sortKey, sortDir]);

  // Click a column header to sort by it. Clicking the SAME column
  // toggles ascending <-> descending; clicking a DIFFERENT column
  // switches to it and resets to ascending — the same pattern as every
  // spreadsheet and admin table people have used before.
  const clickHeader = (key) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  const SortIcon = ({ column }) => {
    if (sortKey !== column) return <ArrowUpDown size={10} className="inline ml-1 opacity-30" />;
    return sortDir === 'asc'
      ? <ArrowUp size={10} className="inline ml-1 text-brand-500" />
      : <ArrowDown size={10} className="inline ml-1 text-brand-500" />;
  };

  const send = async (commit) => {
    setErr(null);
    const fd = new FormData(); fd.append('file', file);
    try { setReport(await api(`/employees/import${commit ? '?commit=1' : ''}`, { method: 'POST', body: fd })); if (commit) load(); }
    catch (e) { setErr(e.message); setReport(e.data && e.data.errors ? e.data : null); }
  };

  // Row-level Delete — a single native confirm() dialog is the friction
  // here, not a typed-name confirmation. The backend delete route is
  // itself transaction-wrapped and audit-logged (see core/employees.js's
  // DELETE handler), so the safety net for "did I really mean to do
  // this" lives at the human-decision moment, not by adding
  // finger-gymnastics on top.
  const quickDelete = async (r) => {
    setErr(null);
    const msg = `Permanently delete ${r.name} (${r.email})?\n\nIf they managed anyone, those reports' own KRAs and appraisals are preserved — only the specific manager-side review records that literally require a manager reference will be removed with them. This cannot be undone.`;
    if (!window.confirm(msg)) return;
    try { await api(`/employees/${r.id}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <PageHead title="Employees" hue="navy" />
      <div className="card p-4 space-y-2">
        <p className="lbl">Bulk import — CSV or Excel (.xlsx), synced from your HRMS, dry run first</p>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-sec" href={`${API_BASE}/employees/import-template.xlsx?token=${localStorage.getItem('apms_token')}`}>Download template (.xlsx)</a>
          <a className="btn-sec" href={`${API_BASE}/employees/import-template.csv?token=${localStorage.getItem('apms_token')}`}>.csv</a>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={e => { setFile(e.target.files[0]); setReport(null); }} className="text-xs" />
          <button className="btn-sec" disabled={!file} onClick={() => send(false)}>Validate</button>
          <button className="btn-pri" disabled={!file || !(report && report.ok && !report.committed)} onClick={() => send(true)}>Commit load</button>
        </div>
        <p className="text-[11px] text-navy-400">
          <b>Your HRMS export can be uploaded as it comes</b> — its own column names (Employee Code, Full Name,
          Office Email, Reporting Manager, HOD) are recognised, and columns the PMS doesn't use are ignored.
          Reporting Manager and HOD are matched on the full name as spelt in this same file.
          Legacy .xls isn't supported — save as .xlsx first (File → Save As → Excel Workbook).
          The template includes one example row — delete it before uploading your real data.
        </p>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {report && (
          <div className="text-xs space-y-1">
            <p className="font-semibold">{report.committed ? 'LOADED' : report.ok ? 'VALID — commit to load' : 'REJECTED'}
              {report.summary && ` · ${report.summary.total} rows · ${report.summary.errors} errors · ${report.summary.warnings} warnings`}</p>
            {/* The headline facts, above the per-row detail. On a real HRMS
                export the detail runs to a hundred lines, and "1,336 managers
                matched, 33 people have no email" is what HR actually needs to
                read before deciding whether to commit. */}
            {report.summary && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {report.summary.managers_resolved_by_name > 0 && (
                  <span className="chip bg-navy-50 text-navy-600">{report.summary.managers_resolved_by_name} reporting lines matched by name</span>)}
                {report.summary.department_heads > 0 && (
                  <span className="chip bg-leaf-50 text-leaf-600">{report.summary.department_heads} department head{report.summary.department_heads === 1 ? '' : 's'} set from the HOD column</span>)}
                {report.summary.department_heads_need_a_choice > 0 && (
                  <span className="chip bg-amber-100 text-amber-700">{report.summary.department_heads_need_a_choice} department{report.summary.department_heads_need_a_choice === 1 ? '' : 's'} need a head chosen</span>)}
                {report.summary.placeholder_emails > 0 && (
                  <span className="chip bg-amber-100 text-amber-700">{report.summary.placeholder_emails} with no email — cannot sign in</span>)}
              </div>
            )}
            {!!(report.department_heads_need_a_choice || []).length && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-amber-700 font-semibold">
                  Departments whose rows name more than one HOD — pick the head on Department Heads
                </summary>
                <div className="pt-1 space-y-0.5">
                  {report.department_heads_need_a_choice.map((d) => (
                    <p key={d.department} className="text-navy-500">
                      <b>{d.department}</b>: {d.candidates.map((c) => `${c.name} (${c.employees})`).join(', ')}
                    </p>
                  ))}
                </div>
              </details>
            )}
            {!!(report.placeholder_emails || []).length && (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-amber-700 font-semibold">
                  {report.placeholder_emails.length} employees have no email on record — give them one in the HRMS
                </summary>
                <div className="pt-1 space-y-0.5">
                  {report.placeholder_emails.map((p) => (
                    <p key={p.email} className="text-navy-500">line {p.line}: <b>{p.name}</b> ({p.emp_code || 'no code'})</p>
                  ))}
                </div>
              </details>
            )}
            {/* New hires are given their KRAs from the library shelf for
                their department and designation. Reported on BOTH passes
                under the same block: the dry run says what the commit
                would do (kras_to_auto_assign), the commit says what it
                did (kras_auto_assigned). HR should learn that a
                designation has no shelf BEFORE those people are in the
                system with empty sheets, which is the whole point of
                showing it on the validate pass too. */}
            <ImportKraAssign report={report} />
            {(report.errors || []).map((e, i) => <p key={i} className="text-rose-600">line {e.line}: {e.error}</p>)}
            {(report.warnings || []).map((w, i) => <p key={i} className="text-amber-700">line {w.line}: {w.warning}</p>)}
          </div>
        )}
      </div>
      {!rows ? <p className="text-sm text-navy-400">Loading…</p> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              {/* Icon and clear-button are positioned relative to this wrapper,
                 not the input itself, so the input can keep its normal .inp
                 styling and just take extra padding for the icons. The !pl-10
                 / !pr-9 use ! to override .inp's own px-3.5 without needing
                 layer/specificity fussing — an overlap between the icon and
                 the placeholder was exactly what a prior compact version got
                 wrong. */}
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-400 pointer-events-none" />
              <input
                type="text"
                className="inp w-80 !pl-10 !pr-9"
                placeholder="Search employees…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }}
                title="Search across name, email, employee ID, department, and manager's email"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-navy-400 hover:text-navy-700 p-1 rounded-lg hover:bg-navy-50 transition-colors"
                  aria-label="Clear search"
                  title="Clear search (Esc)"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <p className="text-xs text-navy-500">
              <span className="font-semibold text-navy-700">{displayedRows.length}</span>
              <span className="text-navy-400"> of {rows.length} {rows.length === 1 ? 'employee' : 'employees'}</span>
              {query && <span className="text-brand-500 font-semibold"> · filtered</span>}
            </p>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
                <tr>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('emp_code')}>Employee ID<SortIcon column="emp_code" /></th>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('name')}>Name<SortIcon column="name" /></th>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('email')}>Email<SortIcon column="email" /></th>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('department')}>Department<SortIcon column="department" /></th>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('manager_email')}>Manager's Email<SortIcon column="manager_email" /></th>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('status')}>Status<SortIcon column="status" /></th>
                  <th className="text-left px-3 py-2">Login</th>
                  <th className="text-left px-3 py-2 cursor-pointer hover:bg-navy-100 select-none" onClick={() => clickHeader('role')}>Role<SortIcon column="role" /></th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-100">
                {displayedRows.length === 0 ? (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-navy-400">
                    {query ? `No employees match "${query}".` : 'No employees yet.'}
                  </td></tr>
                ) : displayedRows.map(r => (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="px-3 py-2 font-mono text-navy-500">{r.emp_code || '—'}</td>
                      <td className="px-3 py-2 font-semibold">{r.name}</td>
                      <td className="px-3 py-2">
                        {r.email_is_placeholder
                          ? <span className="chip bg-amber-100 text-amber-700" title={`Placeholder: ${r.email}`}>no email on record</span>
                          : r.email}
                      </td>
                      <td className="px-3 py-2">{r.department || '—'}</td>
                      <td className="px-3 py-2">{r.manager_email || '—'}</td><td className="px-3 py-2">{r.status}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`chip ${r.has_login ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-500'}`}>{r.has_login ? 'Active' : 'None yet'}</span>
                      </td>
                      <td className="px-3 py-2 capitalize">{r.role}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button className="btn-sec !py-1 mr-1" onClick={() => setOpenId(v => v === r.id ? null : r.id)}>
                          <Settings2 size={12} className="inline mr-1" />Manage
                        </button>
                        <button
                          className="btn !py-1 text-white bg-rose-600 hover:bg-rose-700"
                          onClick={() => quickDelete(r)}
                          title={`Delete ${r.name}`}
                        >
                          <Trash2 size={12} className="inline mr-1" />Delete
                        </button>
                      </td>
                    </tr>
                    {openId === r.id && (
                      <tr><td colSpan={9} className="px-3 pb-3 bg-navy-50/50"><EmployeePanel employee={r} onDone={() => { setOpenId(null); load(); }} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function EmployeePanel({ employee, onDone }) {
  // ---- Profile edit (name/department/designation/role_band/manager/DOJ/status) ----
  const [name, setName] = useState(employee.name || '');
  const [department, setDepartment] = useState(employee.department || '');
  const [designation, setDesignation] = useState(employee.designation || '');
  const [roleBand, setRoleBand] = useState(employee.role_band || '');
  const [managerEmail, setManagerEmail] = useState(employee.manager_email || '');
  const [doj, setDoj] = useState(employee.date_of_joining ? employee.date_of_joining.slice(0, 10) : '');
  const [status, setStatus] = useState(employee.status || 'active');
  const [profileErr, setProfileErr] = useState(null);
  const [profileMsg, setProfileMsg] = useState(null);

  const saveProfile = async () => {
    setProfileErr(null); setProfileMsg(null);
    try {
      await api(`/employees/${employee.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name, department, designation, role_band: roleBand, manager_email: managerEmail, date_of_joining: doj, status }),
      });
      setProfileMsg('Profile updated.'); onDone();
    } catch (e) { setProfileErr(e.message); }
  };

  // ---- Access (password + role) ----
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(employee.role);
  const [accessErr, setAccessErr] = useState(null);
  const [accessMsg, setAccessMsg] = useState(null);

  const setLogin = async () => {
    setAccessErr(null); setAccessMsg(null);
    if (password.length < 8) { setAccessErr('Password must be at least 8 characters.'); return; }
    try { await api(`/employees/${employee.id}/credentials`, { method: 'POST', body: JSON.stringify({ password }) }); setAccessMsg('Login set.'); setPassword(''); }
    catch (e) { setAccessErr(e.message); }
  };
  const saveRole = async () => {
    setAccessErr(null); setAccessMsg(null);
    try { await api(`/employees/${employee.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }); setAccessMsg('Role updated.'); onDone(); }
    catch (e) { setAccessErr(e.message); }
  };

  return (
    <div className="p-3 space-y-4 text-xs">
      <div className="space-y-2">
        <p className="lbl">Edit profile</p>
        <p className="text-[11px] text-navy-400 -mt-1">Email itself can't be changed here — it's tied to their login. Re-import via file if it genuinely needs to change.</p>
        <div className="grid sm:grid-cols-3 gap-2">
          <div><label className="lbl">Name</label><input className="inp" value={name} onChange={e => setName(e.target.value)} /></div>
          <div><label className="lbl">Department</label><input className="inp" value={department} onChange={e => setDepartment(e.target.value)} /></div>
          <div><label className="lbl">Designation</label><input className="inp" value={designation} onChange={e => setDesignation(e.target.value)} /></div>
          <div><label className="lbl">Role band</label><input className="inp" value={roleBand} onChange={e => setRoleBand(e.target.value)} /></div>
          <div><label className="lbl">Manager's email</label><input className="inp" value={managerEmail} onChange={e => setManagerEmail(e.target.value)} placeholder="leave blank for none" /></div>
          <div><label className="lbl">Date of joining</label><input className="inp" type="date" value={doj} onChange={e => setDoj(e.target.value)} /></div>
          <div>
            <label className="lbl">Status</label>
            <select className="inp" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="active">active</option>
              <option value="inactive">inactive</option>
            </select>
          </div>
        </div>
        <button className="btn-pri" onClick={saveProfile}>Save profile</button>
        {profileErr && <p className="text-rose-600">{profileErr}</p>}
        {profileMsg && <p className="text-leaf-600">{profileMsg}</p>}
      </div>

      <div className="space-y-2 pt-3 border-t border-navy-100">
        <p className="lbl">Access</p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="lbl">Set login password for {employee.email}</label>
            <input className="inp w-56" type="password" placeholder="min 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          <button className="btn-pri" onClick={setLogin}>Set password</button>
          <p className="text-[11px] text-navy-400 max-w-xs">Chosen by you on their behalf — no company SSO is wired up yet, so this is the only way to give someone a real login right now.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="lbl">Role</label>
            <select className="inp w-40" value={role} onChange={e => setRole(e.target.value)}>
              {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button className="btn-sec" onClick={saveRole}>Save role</button>
        </div>
        {role === 'hod' && (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5 max-w-md">
            The "hod" role only grants access to the Delivery Head Review screen — it does not by itself say WHICH department they review.
            Assign them as a department's head in the "Department Heads" panel above the employee list, or their queue will show nothing.
          </p>
        )}
        {accessErr && <p className="text-rose-600">{accessErr}</p>}
        {accessMsg && <p className="text-leaf-600">{accessMsg}</p>}
      </div>
    </div>
  );
}

