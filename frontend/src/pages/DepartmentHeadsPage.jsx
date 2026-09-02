import { useEffect, useState } from 'react';
import { api } from '../utils/api';

// Moved to its own HR Admin tab, per a direct request — was previously a
// panel embedded inside the Employees page. Giving someone the "hod"
// role only grants access to the Delivery Head Review screen; this is
// what actually scopes which department's evaluations they see
// (core.department_heads), and nothing in this app had a UI for it
// before an earlier round's fix.
export default function DepartmentHeadsPage() {
  const [employees, setEmployees] = useState(null);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = () => api('/employees/department-heads').then(r => setData(r.departments)).catch(e => setErr(e.message));
  useEffect(() => {
    load();
    api('/employees').then(r => setEmployees(r.employees)).catch(() => setEmployees([]));
  }, []);

  const setHead = async (department, employeeId) => {
    setErr(null); setMsg(null);
    try {
      await api(`/employees/department-heads/${encodeURIComponent(department)}`, { method: 'PUT', body: JSON.stringify({ employee_id: employeeId || null }) });
      setMsg(`Updated ${department}.`); load();
    } catch (e) { setErr(e.message); }
  };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div>
        <h2 className="text-lg font-bold">Department Heads</h2>
        <p className="text-xs text-navy-400">Who each department's Delivery Head Review queue belongs to. Giving someone the "hod" role only grants access to the screen; this is what actually scopes which department's evaluations they see.</p>
      </div>
      {!data.length && <div className="card p-8 text-center text-sm text-navy-400">No departments found — add employees with a department set first.</div>}
      <div className="card p-4">
        <div className="grid sm:grid-cols-2 gap-2">
          {data.map(d => (
            <div key={d.department} className="flex items-center justify-between gap-2 bg-navy-50 rounded-lg px-3 py-2">
              <span className="text-xs font-semibold">{d.department}</span>
              <select className="inp !py-1 w-48" value={d.head ? d.head.employee_id : ''} onChange={e => setHead(d.department, e.target.value)}>
                <option value="">— no head assigned —</option>
                {(employees || []).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
    </div>
  );
}
