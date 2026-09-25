import { useEffect, useState } from 'react';
import { Plus, Search, X, Trash2, Save, Download } from 'lucide-react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';

// CR-11 (phase 1 of 2) — a richer transition matrix on top of the simpler
// Career Framework band/level list, per a follow-up conversation with
// reference screenshots of a "New transition" form. Min/typical
// time-in-role are stored and shown, but deliberately NOT enforced —
// nothing in this app tracks when an employee moved into their CURRENT
// role (only date_of_joining, which is company tenure), so there's no
// reliable data to gate against yet. That's a separate follow-up once
// role-start-date tracking exists.
export default function CareerTransitionsPage() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [designations, setDesignations] = useState([]);
  // Bulk upload. Deliberately the same three controls in the same order
  // as the KRA Library screen — HR has learnt that shape once.
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [upErr, setUpErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (showInactive) params.set('show_inactive', 'true');
    api(`/people/career/transitions?${params}`)
      .then((r) => { setRows(r.transitions); setMaster(r.master || null); setPicked(new Set()); })
      .catch(e => setErr(e.message));
  };
  useEffect(() => { load(); }, [q, showInactive]);
  const [roleBands, setRoleBands] = useState([]);
  // What a suggested draft would be built from right now, so the page
  // can say out loud that it follows the employee list.
  const [master, setMaster] = useState(null);
  // Ticked rows, by id. Cleared on every load: a selection that
  // survives a reload can delete a row the user is no longer looking at.
  const [picked, setPicked] = useState(new Set());
  useEffect(() => { api('/people/designations').then(r => setDesignations(r.designations)).catch(() => setDesignations([])); }, []);
  useEffect(() => { api('/people/role-bands').then(r => setRoleBands(r.role_bands)).catch(() => setRoleBands([])); }, []);
  const [departments, setDepartments] = useState([]);
  useEffect(() => { api('/people/departments').then(r => setDepartments(r.departments)).catch(() => setDepartments([])); }, []);

  // Validate writes nothing; Publish is the same request with ?commit=1.
  // The two-step is the point: a career matrix decides which moves the
  // product will accept, so HR sees the verdict on every row before any
  // of it lands.
  const send = async (commit) => {
    setUpErr(null); setBusy(true);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api(`/people/career/transitions/upload${commit ? '?commit=1' : ''}`, { method: 'POST', body: fd });
      setReport(r);
      if (commit && r.committed) { setFile(null); load(); }
    } catch (e) { setUpErr(e.message); setReport(e.data && e.data.errors ? e.data : null); }
    finally { setBusy(false); }
  };

  const remove = async (t) => {
    if (!confirm(`Remove the transition ${t.from_role} → ${t.to_role}?`)) return;
    try { await api(`/people/career/transitions/${t.id}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
  };
  // Bulk delete. Asked for on 25 Sep: "there is not delete option for
  // deleting multiple files." Two shapes, one route — the ticked rows,
  // or the whole matrix behind a typed confirmation.
  const removePicked = async () => {
    const ids = [...picked];
    if (!ids.length) return;
    if (!confirm(`Remove ${ids.length} transition${ids.length === 1 ? '' : 's'}?\n\nThis cannot be undone. Employees' own career paths are not affected — this is the matrix of allowed moves.`)) return;
    setErr(null);
    try { await api('/people/career/transitions', { method: 'DELETE', body: JSON.stringify({ ids }) }); load(); }
    catch (e) { setErr(e.message); }
  };
  const clearAll = async () => {
    const n = (rows || []).length;
    // A typed word, not an OK button. Clearing the matrix is the one
    // action on this page that cannot be undone by re-uploading the
    // same sheet, because HR's edits to it are not stored anywhere else.
    const typed = prompt(`This removes ALL ${n} transitions from the matrix.\n\nType DELETE to confirm.`);
    if (typed !== 'DELETE') return;
    setErr(null);
    try { await api('/people/career/transitions', { method: 'DELETE', body: JSON.stringify({ confirm_count: n }) }); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleActive = async (t) => {
    try { await api(`/people/career/transitions/${t.id}`, { method: 'PUT', body: JSON.stringify({ active: !t.active }) }); load(); }
    catch (e) { setErr(e.message); }
  };

  if (err && !rows) return <p className="text-sm text-rose-600">{err}</p>;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHead title="Career Pathing Matrix" hue="leaf"
          sub={<>
          Define valid role-to-role transitions. Career paths are checked against this matrix (BR-3.2 / CR-11).
          Minimum and typical time-in-role are shown for reference only — not yet enforced, since role start dates aren't tracked.
          </>} />
        <button className="btn-pri" onClick={() => { setEditing(null); setShowForm(true); }}><Plus size={13} className="inline mr-1" />Add transition</button>
      </div>

      {/* The filled first draft, asked for on 24 Sep: "please find template
          of career pathing matrix and fill the same as per department and
          designation". It is built from the employee master on each click
          rather than stored, so it never goes stale, and it comes out as
          the importer's own sheet so it goes straight back in below. */}
      <div className="card p-4 space-y-2 border-l-4 border-leaf-500">
        <p className="lbl">Start from a suggested matrix</p>
        <p className="text-[11.5px] text-navy-500">
          Built from the <b>departments and designations on your employee master right now</b> — every row
          names a department, and each department is laddered from the titles that department actually
          employs. The senior form of each role where one exists, the standard rung otherwise. It is a{' '}
          <b>draft to edit</b>, not a decision: nothing is saved until you upload it below and publish.
          Rows whose Notes start with <b>PLEASE CHECK</b> are the ones to look at first.
        </p>
        {/* The live-derivation guarantee, on screen. Asked for on 25 Sep:
            "if we update employee list in PMS, then suggested matrix
            should also be updated as per new designations." It always
            was — the sheet is generated per download and never stored —
            but nothing on the page said so. */}
        {master && (
          <p className="text-[11.5px] text-navy-600 bg-leaf-50 rounded-md px-2.5 py-1.5">
            Right now that is <b>{master.employees}</b> active employee{master.employees === 1 ? '' : 's'},{' '}
            <b>{master.departments}</b> department{master.departments === 1 ? '' : 's'} and{' '}
            <b>{master.designations}</b> designation{master.designations === 1 ? '' : 's'}. Change the employee
            list and download again — the draft is rebuilt on every click, never stored.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-pri" href={`${API_BASE}/people/career/transitions/suggested.xlsx?token=${localStorage.getItem('apms_token')}`}>
            <Download size={13} className="inline mr-1" />Download suggested matrix (.xlsx)
          </a>
          <a className="btn-sec" href={`${API_BASE}/people/career/transitions/suggested.csv?token=${localStorage.getItem('apms_token')}`}>.csv</a>
        </div>
      </div>

      <div className="card p-4 space-y-2">
        <p className="lbl">Upload transitions — one row per step, dry run first</p>
        <div className="flex flex-wrap items-center gap-2">
          <a className="btn-sec" href={`${API_BASE}/people/career/transitions/template.xlsx?token=${localStorage.getItem('apms_token')}`}>Blank template (.xlsx)</a>
          <a className="btn-sec" href={`${API_BASE}/people/career/transitions/template.csv?token=${localStorage.getItem('apms_token')}`}>.csv</a>
          <input type="file" accept=".xlsx,.csv" className="text-xs"
            onChange={(e) => { setFile(e.target.files[0] || null); setReport(null); setUpErr(null); }} />
          <button className="btn-sec" disabled={!file || busy} onClick={() => send(false)}>Validate</button>
          <button className="btn-pri" disabled={!file || busy || !(report && report.ok && !report.committed)}
            title={!report ? 'Validate first' : ''} onClick={() => send(true)}>Publish</button>
        </div>
        <p className="text-[11px] text-navy-400">
          Columns: Department, From Role, From Level, To Role, To Level, Expected Level Change,
          Min Time In Current Role (Months), Typical Time In Current Role (Months), Required
          Competencies, Notes. Only <b>From Role</b> and <b>To Role</b> are required; blank From
          Level means any level. <b>Blank Department means every department</b>; fill it in and
          the rung applies only there, and beats a company-wide rung for the same move. Required Competencies go one per line, or separated by a semicolon.
          {' '}<b>Re-uploading a transition that already exists updates it</b> rather than adding a
          second copy, so a corrected file can be uploaded again safely. A role nobody holds yet is
          allowed and only warned about — that is what a career path is for.
        </p>
        {upErr && <p className="text-xs text-rose-600">{upErr}</p>}
        {report && (
          <div className="text-xs space-y-1">
            <p className="font-semibold">
              {report.committed ? 'PUBLISHED' : report.ok ? 'VALID — publish to go live' : 'REJECTED'}
              {report.summary && ` · ${report.summary.total_rows} transitions · ${report.summary.create} new · ${report.summary.update} updated · ${report.summary.errors} errors · ${report.summary.warnings} warnings`}
            </p>
            {(report.errors || []).map((e, i) => <p key={i} className="text-rose-600">row {e.line}: {e.error}</p>)}
            {(report.warnings || []).map((w, i) => <p key={i} className="text-amber-700">row {w.line}: {w.warning}</p>)}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-300" />
          <input className="inp pl-8" value={q} onChange={e => setQ(e.target.value)} placeholder="Search department / role / level…" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-navy-500">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />Show inactive
        </label>
      </div>

      {/* The bulk controls. "Select all" ticks only what is SHOWN, so a
          search narrows what can be deleted in one go — deleting rows
          the user is not looking at is the accident this avoids. */}
      {rows && rows.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-navy-600">
            <input type="checkbox"
              checked={picked.size > 0 && rows.every((t) => picked.has(t.id))}
              ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !rows.every((t) => picked.has(t.id)); }}
              onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((t) => t.id)) : new Set())} />
            Select all {q.trim() ? 'shown' : ''} ({rows.length})
          </label>
          <span className="text-navy-400">{picked.size} selected</span>
          <button className="btn-sec !py-1 !text-rose-600 !border-rose-200" disabled={!picked.size} onClick={removePicked}>
            <Trash2 size={12} className="inline mr-1" />Delete selected
          </button>
          <span className="flex-1" />
          <button className="btn-sec !py-1 !text-rose-600 !border-rose-200" onClick={clearAll}>
            Clear the whole matrix ({rows.length})
          </button>
        </div>
      )}

      {err && <p className="text-xs text-rose-600">{err}</p>}
      {!rows && <p className="text-sm text-navy-400">Loading…</p>}
      {rows && !rows.length && <div className="card p-8 text-center text-sm text-navy-400">No transitions defined yet. Upload a file above, or click "Add transition" to seed the matrix one at a time.</div>}
      {rows && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(t => (
            <div key={t.id} className={`card p-4 ${!t.active ? 'opacity-50' : ''} ${picked.has(t.id) ? 'ring-1 ring-rose-300' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                {/* items-start, or the flex row stretches and the box
                    lands halfway down a tall card. */}
                <div className="flex items-start gap-3">
                  <input type="checkbox" className="mt-1 shrink-0" checked={picked.has(t.id)}
                    onChange={() => toggle(t.id)} aria-label={`Select ${t.from_role} to ${t.to_role}`} />
                  <div>
                  <p className="text-sm font-semibold flex flex-wrap items-center gap-2">
                    {/* Which ladder this rung is on. A company-wide rung
                        is labelled too — "no chip" would be ambiguous
                        with "chip not loaded". */}
                    <span className={`chip ${t.department ? 'bg-lagoon-50 text-lagoon-700' : 'bg-navy-50 text-navy-500'}`}>
                      {t.department || 'Every department'}
                    </span>
                    <span>
                    {t.from_role}{t.from_level && <span className="text-navy-400 font-normal"> · {t.from_level}</span>}
                    <span className="text-navy-300 mx-2">→</span>
                    {t.to_role}{t.to_level && <span className="text-navy-400 font-normal"> · {t.to_level}</span>}
                    </span>
                  </p>
                  <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-navy-400">
                    {t.expected_level_change != null && <span>Level change: +{t.expected_level_change}</span>}
                    {t.min_time_months != null && <span>Min {t.min_time_months} mo in role (advisory)</span>}
                    {t.typical_time_months != null && <span>Typical {t.typical_time_months} mo (ETA)</span>}
                    {!t.active && <span className="text-rose-500 font-semibold">Inactive</span>}
                  </div>
                  {t.required_competencies?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {t.required_competencies.map((c, i) => <span key={i} className="chip bg-navy-50 text-navy-600">{c}</span>)}
                    </div>
                  )}
                  {t.notes && <p className="text-xs text-navy-500 mt-1.5 italic">{t.notes}</p>}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button className="btn-sec !py-1" onClick={() => { setEditing(t); setShowForm(true); }}>Edit</button>
                  <button className="btn-sec !py-1" onClick={() => toggleActive(t)}>{t.active ? 'Deactivate' : 'Reactivate'}</button>
                  <button className="btn-sec !py-1 !text-rose-600 !border-rose-200" onClick={() => remove(t)}><Trash2 size={12} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && <TransitionForm designations={designations} roleBands={roleBands} departments={departments} initial={editing} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />}
    </div>
  );
}

function TransitionForm({ designations, roleBands, departments, initial, onClose, onSaved }) {
  const [f, setF] = useState({
    department: initial?.department || '',
    from_role: initial?.from_role || '', from_level: initial?.from_level || '',
    to_role: initial?.to_role || '', to_level: initial?.to_level || '',
    expected_level_change: initial?.expected_level_change ?? 1,
    min_time_months: initial?.min_time_months ?? '', typical_time_months: initial?.typical_time_months ?? '',
    required_competencies: (initial?.required_competencies || []).join('\n'),
    notes: initial?.notes || '',
  });
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  // How many active employees this from_role/from_level pair actually
  // matches. A transition that matches nobody is the failure this form
  // used to make easy and invisible — it now shows up before saving.
  const [match, setMatch] = useState(null);

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  useEffect(() => {
    if (!f.from_role) { setMatch(null); return; }
    let cancelled = false;
    const p = new URLSearchParams({ from_role: f.from_role });
    if (f.from_level) p.set('from_level', f.from_level);
    api(`/people/career/match-count?${p}`)
      .then(r => { if (!cancelled) setMatch(r.count); })
      .catch(() => { if (!cancelled) setMatch(null); });
    return () => { cancelled = true; };
  }, [f.from_role, f.from_level]);

  const save = async () => {
    setErr(null);
    if (!f.from_role || !f.to_role) { setErr('From Role and To Role are both required.'); return; }
    setSaving(true);
    try {
      const body = {
        department: f.department || null,
        from_role: f.from_role, from_level: f.from_level || null,
        to_role: f.to_role, to_level: f.to_level || null,
        expected_level_change: f.expected_level_change === '' ? null : Number(f.expected_level_change),
        min_time_months: f.min_time_months === '' ? null : Number(f.min_time_months),
        typical_time_months: f.typical_time_months === '' ? null : Number(f.typical_time_months),
        required_competencies: f.required_competencies, notes: f.notes || null,
      };
      if (initial) await api(`/people/career/transitions/${initial.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/people/career/transitions', { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (e) { setErr(e.message); }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-900/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-navy-100">
          <p className="text-base font-bold">{initial ? 'Edit transition' : 'New transition'}</p>
          <button className="text-navy-400 hover:text-navy-600" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Department scopes everything below it, so it sits above
              rather than beside From Role. Blank is a real answer and the
              common one — it must not read as an unfilled field. */}
          <div>
            <label className="lbl">Department</label>
            <select className="inp" value={f.department} onChange={set('department')}>
              <option value="">— Every department —</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
              {f.department && !departments.includes(f.department) && (
                <option value={f.department}>{f.department} (nobody is in this department)</option>
              )}
            </select>
            <p className="text-[10px] text-navy-400 mt-1">
              Leave blank and this rung applies company-wide. Pick one and it applies only there —
              and it <b>wins over</b> a company-wide rung describing the same move, so a department
              can override the ladder without anyone editing the shared one.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="lbl">From Role *</label>
              <select className="inp" value={f.from_role} onChange={set('from_role')}>
                <option value="">— Select a designation —</option>
                {designations.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <p className="text-[10px] text-navy-400 mt-1">Sourced from employee records — exact match guaranteed.</p>
            </div>
            <div>
              <label className="lbl">From Level</label>
              {/* A dropdown of role bands that actually exist, for the same
                  reason From Role is one: this was a free-text box compared
                  exactly against employee.role_band, so a typo or a level
                  nobody holds produced a transition matching nobody, with
                  no way to see why. */}
              <select className="inp" value={f.from_level} onChange={set('from_level')}>
                <option value="">— Any level —</option>
                {roleBands.map(b => <option key={b} value={b}>{b}</option>)}
                {f.from_level && !roleBands.includes(f.from_level) && (
                  <option value={f.from_level}>{f.from_level} (not used by any employee)</option>
                )}
              </select>
              <p className="text-[10px] text-navy-400 mt-1">
                {roleBands.length ? 'Sourced from employee role bands. "Any level" is usually what you want.'
                                  : 'No role bands are set on any employee — leave this as "Any level".'}
              </p>
            </div>
          </div>
          {f.from_role && (
            <p className={`text-xs rounded-lg px-3 py-2 ${match === 0
              ? 'bg-rose-50 border border-rose-200 text-rose-700'
              : 'bg-emerald-50 border border-emerald-100 text-emerald-800'}`}>
              {match === null ? 'Checking who this applies to…'
                : match === 0
                  ? <>This matches <b>no employees</b>. {f.from_level
                      ? <>No active employee is a <b>{f.from_role}</b> at level <b>{f.from_level}</b> — set the level to “Any level”, or check their role band.</>
                      : <>No active employee has the designation <b>{f.from_role}</b>.</>} Saving it is allowed, but nobody will see this path.</>
                  : <>Applies to <b>{match}</b> active employee{match === 1 ? '' : 's'}.</>}
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="lbl">To Role *</label>
              <select className="inp" value={f.to_role} onChange={set('to_role')}>
                <option value="">— Select a designation —</option>
                {designations.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <p className="text-[10px] text-navy-400 mt-1">Sourced from employee records — exact match guaranteed.</p>
            </div>
            <div>
              <label className="lbl">To Level</label>
              <input className="inp" value={f.to_level} onChange={set('to_level')} placeholder="e.g. L2, Senior" />
            </div>
          </div>
          <div>
            <label className="lbl">Expected Level Change</label>
            <input className="inp" type="number" value={f.expected_level_change} onChange={set('expected_level_change')} />
            <p className="text-[10px] text-navy-400 mt-1">Usually +1 for next-level; +2 for skip.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="lbl">Min Time in Current Role (months)</label>
              <input className="inp" type="number" value={f.min_time_months} onChange={set('min_time_months')} placeholder="12" />
              <p className="text-[10px] text-navy-400 mt-1">Shown for reference — not yet enforced (see page note above).</p>
            </div>
            <div>
              <label className="lbl">Typical Time in Current Role (months)</label>
              <input className="inp" type="number" value={f.typical_time_months} onChange={set('typical_time_months')} placeholder="Optional" />
              <p className="text-[10px] text-navy-400 mt-1">Used for ETA display only.</p>
            </div>
          </div>
          <div>
            <label className="lbl">Required Competencies (one per line)</label>
            <textarea className="inp" rows={3} value={f.required_competencies} onChange={set('required_competencies')}
              placeholder={'System design fundamentals\nIndependent feature ownership\nMentoring 1 junior'} />
          </div>
          <div>
            <label className="lbl">Notes (optional)</label>
            <textarea className="inp" rows={2} value={f.notes} onChange={set('notes')} placeholder="Any context about this transition" />
          </div>
          {err && <p className="text-xs text-rose-600">{err}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-navy-100">
          <button className="btn-sec" onClick={onClose}>Cancel</button>
          <button className="btn-pri" disabled={saving} onClick={save}><Save size={13} className="inline mr-1" />{saving ? 'Saving…' : (initial ? 'Save' : 'Create')}</button>
        </div>
      </div>
    </div>
  );
}
