import { useEffect, useState } from 'react';
import { Plus, Search, X, Trash2, Save } from 'lucide-react';
import { api } from '../utils/api';

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

  const load = () => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (showInactive) params.set('show_inactive', 'true');
    api(`/people/career/transitions?${params}`).then(r => setRows(r.transitions)).catch(e => setErr(e.message));
  };
  useEffect(() => { load(); }, [q, showInactive]);
  const [roleBands, setRoleBands] = useState([]);
  useEffect(() => { api('/people/designations').then(r => setDesignations(r.designations)).catch(() => setDesignations([])); }, []);
  useEffect(() => { api('/people/role-bands').then(r => setRoleBands(r.role_bands)).catch(() => setRoleBands([])); }, []);

  const remove = async (t) => {
    if (!confirm(`Remove the transition ${t.from_role} → ${t.to_role}?`)) return;
    try { await api(`/people/career/transitions/${t.id}`, { method: 'DELETE' }); load(); }
    catch (e) { setErr(e.message); }
  };
  const toggleActive = async (t) => {
    try { await api(`/people/career/transitions/${t.id}`, { method: 'PUT', body: JSON.stringify({ active: !t.active }) }); load(); }
    catch (e) { setErr(e.message); }
  };

  if (err && !rows) return <p className="text-sm text-rose-600">{err}</p>;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">Career Pathing Matrix</h2>
          <p className="text-xs text-navy-400 max-w-xl">
            Define valid role-to-role transitions. Career paths are checked against this matrix (BR-3.2 / CR-11).
            Minimum and typical time-in-role are shown for reference only — not yet enforced, since role start dates aren't tracked.
          </p>
        </div>
        <button className="btn-pri" onClick={() => { setEditing(null); setShowForm(true); }}><Plus size={13} className="inline mr-1" />Add transition</button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-navy-300" />
          <input className="inp pl-8" value={q} onChange={e => setQ(e.target.value)} placeholder="Search role / level…" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-navy-500">
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />Show inactive
        </label>
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}
      {!rows && <p className="text-sm text-navy-400">Loading…</p>}
      {rows && !rows.length && <div className="card p-8 text-center text-sm text-navy-400">No transitions defined yet. Click "Add transition" to seed the matrix.</div>}
      {rows && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map(t => (
            <div key={t.id} className={`card p-4 ${!t.active ? 'opacity-50' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">
                    {t.from_role}{t.from_level && <span className="text-navy-400 font-normal"> · {t.from_level}</span>}
                    <span className="text-navy-300 mx-2">→</span>
                    {t.to_role}{t.to_level && <span className="text-navy-400 font-normal"> · {t.to_level}</span>}
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

      {showForm && <TransitionForm designations={designations} roleBands={roleBands} initial={editing} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />}
    </div>
  );
}

function TransitionForm({ designations, roleBands, initial, onClose, onSaved }) {
  const [f, setF] = useState({
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
