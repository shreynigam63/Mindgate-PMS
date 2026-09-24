import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { Plus, Trash2, X, SlidersHorizontal } from 'lucide-react';

// "Competency Framework" — the Competency Master sheet of the client's
// workbook, as a page HR maintains.
//
// Two things live here and they are different:
//
//   the DEFAULT required level, one number per competency, which is
//   what the workbook ships with; and
//
//   JOB-SPECIFIC levels, because the workbook's own Required Level
//   column says "Role-specific requirement to be confirmed by
//   manager/HR" — one number for all 1,398 people would be the wrong
//   answer written confidently. Scoped designation-first with an
//   optional department, the same rule the KRA library uses, so HR does
//   not learn a second scoping rule.
//
// A competency anybody has been rated on is RETIRED, never deleted:
// deleting would cascade away ratings a decision was made on.

export default function CompetencyFrameworkPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [levelFor, setLevelFor] = useState(null);

  const load = () => api('/pms/competencies/framework')
    .then((r) => { setD(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const all = d.competencies || [];
  const shown = all.filter((c) => matches(q, c.category, c.name, c.description));
  const levelsFor = (id) => (d.role_levels || []).filter((l) => l.competency_id === id);

  const setLevel = async (c, patch) => {
    setMsg(null);
    try { await api(`/pms/competencies/framework/${c.id}`, { method: 'PUT', body: JSON.stringify(patch) }); await load(); }
    catch (e) { setErr(e.message); }
  };

  const remove = async (c) => {
    setMsg(null); setErr(null);
    try {
      const r = await api(`/pms/competencies/framework/${c.id}`, { method: 'DELETE' });
      setMsg(r.message || `Removed “${c.name}”.`);
      await load();
    } catch (e) { setErr(e.message); }
  };

  // Grouped by NAME, not by adjacency. The first cut merged only
  // CONSECUTIVE rows of the same category, so the moment two
  // categories' sort_order ranges overlapped the page rendered the
  // same heading twice and React warned about duplicate keys.
  const cats = [];
  {
    const byName = new Map();
    for (const c of shown) {
      if (!byName.has(c.category)) {
        const group = { name: c.category, rows: [] };
        byName.set(c.category, group);
        cats.push(group);
      }
      byName.get(c.category).rows.push(c);
    }
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Competency Framework" hue="violet"
        sub="What the organisation expects, by competency and by job. Employees and managers rate against this.">
        <span className="chip bg-white/20 text-white">{all.filter((c) => c.active).length} active</span>
        <button className="btn-sec" onClick={() => setAdding(true)}>
          <Plus size={13} className="inline mr-1" />Add competency
        </button>
      </PageHead>

      {msg && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">{msg}</p>}

      <div className="card p-3 text-[11.5px] text-navy-500 space-y-1">
        <p><b>Default level</b> is what the organisation expects of everyone for that competency.</p>
        <p>
          <b>Job levels</b> override it for one designation — with a department to narrow it
          further. A department-specific level beats a blank one, exactly like the KRA library.
        </p>
        <p>
          <b>Managers only</b> means the competency is asked only of people who have reports, so
          an individual contributor is never asked to rate their Delegation.
        </p>
        <p className="text-navy-400">
          The level is snapshotted onto an assessment when it is created, so changing it here
          never rewrites a gap somebody has already been measured against.
        </p>
      </div>

      <SearchBox value={q} onChange={setQ} placeholder="Search by category, competency or description…"
        shown={shown.length} total={all.length} />

      {cats.map((cat) => (
        <div key={cat.name} className="card overflow-x-auto">
          <p className="lbl px-3 pt-3">{cat.name}</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                <th className="px-3 py-2">Competency</th>
                <th className="px-3 py-2">Default level</th>
                <th className="px-3 py-2">Job levels</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {cat.rows.map((c) => (
                <tr key={c.id} className={`border-b border-navy-50 ${c.active ? '' : 'opacity-50'}`}>
                  <td className="px-3 py-2">
                    <span className="font-semibold text-navy-900">{c.name}</span>
                    {!c.active && <span className="chip bg-navy-50 text-navy-500 ml-2">retired</span>}
                    {c.description && <span className="block text-[10.5px] text-navy-400">{c.description}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <select className="inp !py-1 !px-2 text-xs w-auto" value={c.default_required_level}
                      onChange={(e) => setLevel(c, { default_required_level: Number(e.target.value) })}>
                      {(d.scale || []).map((s) => <option key={s.level} value={s.level}>{s.level} — {s.label}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    {levelsFor(c.id).length
                      ? levelsFor(c.id).map((l, i) => (
                          <span key={i} className="chip bg-violet-100 text-violet-700 mr-1 mb-1 inline-block">
                            {l.designation}{l.department ? ` · ${l.department}` : ''} → {l.required_level}
                          </span>
                        ))
                      : <span className="text-navy-300">default everywhere</span>}
                    <button className="btn-sec !py-0.5 !px-2 ml-1" onClick={() => setLevelFor(c)}>
                      <SlidersHorizontal size={11} className="inline" />
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-navy-500">
                      <input type="checkbox" checked={c.managers_only}
                        onChange={(e) => setLevel(c, { managers_only: e.target.checked })} />
                      managers only
                    </label>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button className="btn-sec !py-1 !text-rose-600 !border-rose-200" onClick={() => remove(c)}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {adding && <AddCompetency scale={d.scale} categories={[...new Set(all.map((c) => c.category))]}
        onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {levelFor && <JobLevels competency={levelFor} scale={d.scale} headcount={d.headcount || []}
        levels={levelsFor(levelFor.id)} onClose={() => setLevelFor(null)}
        onDone={() => { load(); }} />}
    </div>
  );
}

function AddCompetency({ scale, categories, onClose, onDone }) {
  const [f, setF] = useState({ category: categories[0] || '', name: '', description: '',
    default_required_level: 4, managers_only: false });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api('/pms/competencies/framework', { method: 'POST', body: JSON.stringify(f) }); onDone(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <Modal title="Add a competency" onClose={onClose}>
      <label className="lbl">Category</label>
      <input className="inp" list="comp-cats" value={f.category}
        onChange={(e) => setF({ ...f, category: e.target.value })} />
      <datalist id="comp-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <label className="lbl mt-3">Competency</label>
      <input className="inp" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <label className="lbl mt-3">Description</label>
      <textarea className="inp" rows={2} value={f.description}
        onChange={(e) => setF({ ...f, description: e.target.value })} />
      <label className="lbl mt-3">Default required level</label>
      <select className="inp" value={f.default_required_level}
        onChange={(e) => setF({ ...f, default_required_level: Number(e.target.value) })}>
        {(scale || []).map((s) => <option key={s.level} value={s.level}>{s.level} — {s.label}</option>)}
      </select>
      <label className="flex items-center gap-2 text-xs text-navy-600 mt-3">
        <input type="checkbox" checked={f.managers_only}
          onChange={(e) => setF({ ...f, managers_only: e.target.checked })} />
        Only ask this of people who have reports
      </label>
      {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
      <div className="flex gap-2 mt-4">
        <button className="btn-pri" disabled={busy || !f.name.trim() || !f.category.trim()} onClick={save}>Add</button>
        <button className="btn-sec" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function JobLevels({ competency, scale, headcount, levels, onClose, onDone }) {
  const [f, setF] = useState({ designation: '', department: '', required_level: 4 });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const designations = [...new Set(headcount.map((h) => h.designation))].sort();
  const departments = [...new Set(headcount.map((h) => h.department).filter(Boolean))].sort();
  // How many people a level would actually cover, so HR can see whether
  // they are levelling one person or two hundred.
  const covers = headcount
    .filter((h) => h.designation === f.designation && (!f.department || h.department === f.department))
    .reduce((a, h) => a + h.n, 0);

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/pms/competencies/framework/${competency.id}/level`, { method: 'POST', body: JSON.stringify(f) });
      setF({ designation: '', department: '', required_level: 4 });
      onDone();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const drop = async (l) => {
    try { await api(`/pms/competencies/framework/${competency.id}/level/${l.id}`, { method: 'DELETE' }); onDone(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <Modal title={`Job levels — ${competency.name}`} onClose={onClose}>
      <p className="text-[11.5px] text-navy-500 mb-3">
        Default is <b>{competency.default_required_level}</b> for everyone. Anything set here
        overrides it for that job; leave Department blank to cover the designation everywhere.
      </p>
      {levels.length > 0 && (
        <div className="divide-y divide-navy-50 mb-3">
          {levels.map((l) => (
            <div key={l.id || `${l.designation}-${l.department}`} className="py-1.5 flex items-center gap-2 text-xs">
              <span className="font-semibold">{l.designation}</span>
              <span className="text-navy-400">{l.department || 'every department'}</span>
              <span className="chip bg-violet-100 text-violet-700 ml-auto">level {l.required_level}</span>
              {l.id && (
                <button className="btn-sec !py-0.5 !px-1.5 !text-rose-600 !border-rose-200" onClick={() => drop(l)}>
                  <Trash2 size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <label className="lbl">Designation</label>
      <input className="inp" list="cl-desigs" value={f.designation}
        onChange={(e) => setF({ ...f, designation: e.target.value })} />
      <datalist id="cl-desigs">{designations.map((x) => <option key={x} value={x} />)}</datalist>
      <label className="lbl mt-3">Department (optional)</label>
      <input className="inp" list="cl-depts" value={f.department}
        onChange={(e) => setF({ ...f, department: e.target.value })} />
      <datalist id="cl-depts">{departments.map((x) => <option key={x} value={x} />)}</datalist>
      <label className="lbl mt-3">Required level</label>
      <select className="inp" value={f.required_level}
        onChange={(e) => setF({ ...f, required_level: Number(e.target.value) })}>
        {(scale || []).map((s) => <option key={s.level} value={s.level}>{s.level} — {s.label}</option>)}
      </select>
      {f.designation && (
        <p className="text-[11px] text-navy-400 mt-2">
          Covers <b className="text-navy-700">{covers}</b> {covers === 1 ? 'person' : 'people'} on the employee master.
        </p>
      )}
      {err && <p className="text-xs text-rose-600 mt-2">{err}</p>}
      <div className="flex gap-2 mt-4">
        <button className="btn-pri" disabled={busy || !f.designation.trim()} onClick={add}>Set level</button>
        <button className="btn-sec" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 bg-navy-900/40 flex items-start justify-center p-4 z-50 overflow-y-auto">
      <div className="card p-5 w-full max-w-lg my-8">
        <div className="flex items-center justify-between mb-3">
          <p className="font-bold text-sm">{title}</p>
          <button onClick={onClose} className="text-navy-400 hover:text-navy-700"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
