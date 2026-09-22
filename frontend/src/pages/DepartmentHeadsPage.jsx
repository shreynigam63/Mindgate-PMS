import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import PageHead from '../PageHead';

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
  const [newDept, setNewDept] = useState('');
  const [busy, setBusy] = useState(false);

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

  const addDept = async () => {
    const name = newDept.trim();
    if (!name) return;
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await api('/employees/departments', { method: 'POST', body: JSON.stringify({ name }) });
      setNewDept('');
      setMsg(r.note ? `Added ${r.department} — ${r.note}.` : `Added ${r.department}.`);
      load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // A department with people in it is not removable, and the button is
  // disabled rather than hidden — HR needs to see WHY, and the count is the
  // number they have to act on. The server refuses it too; this is the
  // explanation, not the guard.
  const removeDept = async (d) => {
    if (!window.confirm(`Remove "${d.department}" from the list?\n\n`
      + (d.head ? `Its Delivery Head assignment (${d.head.name}) is cleared too.\n\n` : '')
      + 'No employee record is changed.')) return;
    setErr(null); setMsg(null); setBusy(true);
    try {
      await api(`/employees/departments/${encodeURIComponent(d.department)}`, { method: 'DELETE' });
      setMsg(`Removed ${d.department}.`); load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Department Heads" hue="navy"
        sub={<>
        Who each department's Delivery Head Review queue belongs to. Giving someone the "hod" role only grants access to the screen; this is what actually scopes which department's evaluations they see.
        </>} />
      <div className="card p-3">
        <p className="lbl mb-1">Add a department</p>
        <div className="flex flex-wrap items-center gap-2">
          <input className="inp !py-1 !text-xs !w-64 shrink-0" value={newDept} placeholder="e.g. Cloud Ops"
            onChange={e => setNewDept(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addDept(); }} />
          <button className="btn-pri !py-1 !text-xs" disabled={busy || !newDept.trim()} onClick={addDept}>
            <Plus size={12} className="inline mr-1" />Add
          </button>
          <span className="text-[11px] text-navy-400">
            Added here it can be given a Delivery Head before anyone is in it. It does
            <b> not</b> restrict what the HRMS import may send — employee departments stay free text.
          </span>
        </div>
      </div>

      {!data.length && <div className="card p-8 text-center text-sm text-navy-400">No departments yet — add one above, or import employees with a department set.</div>}
      {data.length > 0 && (
      <div className="card p-4">
        <div className="grid sm:grid-cols-2 gap-2">
          {data.map(d => (
            // STACKED, not side by side. The name gets the card's full
            // width on its own line; the head dropdown and the bin share the
            // line below it. Putting the name BESIDE a fixed-width select
            // inside this two-column grid truncated it — "Core Banking
            // Application" is 24 characters and there were eight names
            // reading "Accou...", "Applic...", "Devel..." on the live page,
            // which is exactly the department you need to identify before
            // assigning it a Delivery Head. The count also wrapped to its
            // own line in the squeeze.
            <div key={d.department} className="bg-navy-50 rounded-lg px-3 py-2 space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xs font-semibold">{d.department}</p>
                <p className="text-[11px] text-navy-400 shrink-0 whitespace-nowrap">
                  {d.employees} employee{d.employees === 1 ? '' : 's'}
                  {!d.in_use && ' · none yet'}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {/* flex-1 + min-w-0 so the select takes the remaining width
                    and shrinks rather than pushing the bin off the card. */}
                <select className="inp !py-1 flex-1 min-w-0" value={d.head ? d.head.employee_id : ''} onChange={e => setHead(d.department, e.target.value)}>
                  <option value="">— no head assigned —</option>
                  {(employees || []).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
                <button
                  className={`p-1 rounded shrink-0 ${d.removable ? 'text-rose-500 hover:text-rose-700' : 'text-navy-300 cursor-not-allowed'}`}
                  disabled={busy || !d.removable}
                  title={d.removable
                    ? 'Remove this department'
                    : `${d.employees} active employee${d.employees === 1 ? ' is' : 's are'} still in it — move them first`}
                  onClick={() => removeDept(d)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-navy-400 pt-2">
          A department can only be removed once nobody is in it — otherwise those employees
          would be left pointing at something no longer on the list. Removing one clears its
          Delivery Head assignment and changes no employee record.
        </p>
      </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
    </div>
  );
}
