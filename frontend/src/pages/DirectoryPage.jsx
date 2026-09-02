import { useEffect, useState, useMemo, Fragment } from 'react';
import { Settings2, Trash2, Search, ArrowUpDown, ArrowUp, ArrowDown, X } from 'lucide-react';
import { api, API_BASE } from '../utils/api';

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
      <h2 className="text-lg font-bold">Employees</h2>
      <div className="card p-4 space-y-2">
        <p className="lbl">Bulk import — CSV or Excel (.xlsx), synced from your HRMS, dry run first</p>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-sec" href={`${API_BASE}/employees/import-template.csv?token=${localStorage.getItem('apms_token')}`}>Download template</a>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={e => { setFile(e.target.files[0]); setReport(null); }} className="text-xs" />
          <button className="btn-sec" disabled={!file} onClick={() => send(false)}>Validate</button>
          <button className="btn-pri" disabled={!file || !(report && report.ok && !report.committed)} onClick={() => send(true)}>Commit load</button>
        </div>
        <p className="text-[11px] text-navy-400">Legacy .xls files aren't supported — save as .xlsx first (File → Save As → Excel Workbook). The template includes one example row — delete it before uploading your real data.</p>
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {report && (
          <div className="text-xs space-y-1">
            <p className="font-semibold">{report.committed ? 'LOADED' : report.ok ? 'VALID — commit to load' : 'REJECTED'}
              {report.summary && ` · ${report.summary.total} rows · ${report.summary.errors} errors · ${report.summary.warnings} warnings`}</p>
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
                      <td className="px-3 py-2 font-semibold">{r.name}</td><td className="px-3 py-2">{r.email}</td>
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

