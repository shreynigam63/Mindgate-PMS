import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { LevelChip, ScaleLegend } from '../CompetencyScale';

// The HOD's Team Competencies — asked for on 7 Oct: "HOD tab should have
// complete team competencies tab for all employees that too department
// wise dropdown."
//
// Every employee in the departments this person heads (all departments
// for HR), not only their direct reports, with a department dropdown.
// Read-only: the rating is the manager's to give, on Team Competencies;
// this is where the HOD sees where each person and department stands.
const fmt = (v) => (v == null ? '—' : Number(v).toFixed(2));
const gapTone = (g) => (g == null ? 'text-navy-400' : g < -0.5 ? 'text-rose-600' : g < 0 ? 'text-amber-600' : 'text-emerald-700');

export default function HodCompetenciesPage() {
  const [department, setDepartment] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    setData(null); setErr(null);
    api(`/pms/competencies/hod${department ? `?department=${encodeURIComponent(department)}` : ''}`)
      .then(setData).catch((e) => setErr(e.message));
  }, [department]);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;

  const team = data.team || [];
  const shown = team.filter((t) => matches(q, t.name, t.designation, t.department, t.manager_name));
  const done = team.filter((t) => t.manager_status === 'submitted').length;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Team Competencies" hue="lagoon"
        sub="Every employee in your departments — where each person stands against what their role needs.">
        {data.cycle && <span className="chip bg-white/20 text-white">{data.cycle.name}</span>}
        {!!team.length && (
          <span className={`chip ${done === team.length ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
            {done} / {team.length} assessed by their manager
          </span>
        )}
      </PageHead>

      <div className="flex flex-wrap items-center gap-2">
        <label className="lbl mb-0">Department</label>
        <select className="inp w-auto" value={department} onChange={(e) => { setDepartment(e.target.value); setOpenId(null); }}>
          <option value="">All my departments ({(data.departments || []).length})</option>
          {(data.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {data.note && <div className="card p-4 text-sm text-amber-700 bg-amber-50">{data.note}</div>}
      {!data.cycle && <div className="card p-8 text-center text-sm text-navy-400">No cycle is open.</div>}

      {(data.department_summary || []).length > 0 && (
        <div className="card p-3 overflow-x-auto">
          <p className="lbl">By department</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400">
                <th className="py-1 pr-2">Department</th><th className="py-1 pr-2 text-right">People</th>
                <th className="py-1 pr-2 text-right">Assessed</th><th className="py-1 pr-2 text-right">Avg level</th>
                <th className="py-1 pr-2 text-right">Needs</th><th className="py-1 pr-2 text-right">Gap</th>
                <th className="py-1 text-right">Below required</th>
              </tr>
            </thead>
            <tbody>
              {data.department_summary.map((d) => (
                <tr key={d.department} className="border-t border-navy-50">
                  <td className="py-1 pr-2 font-semibold text-navy-800">
                    <button className="hover:underline" onClick={() => setDepartment(d.department)}>{d.department}</button>
                  </td>
                  <td className="py-1 pr-2 text-right">{d.people}</td>
                  <td className="py-1 pr-2 text-right">{d.manager_submitted}</td>
                  <td className="py-1 pr-2 text-right">{fmt(d.avg_manager)}</td>
                  <td className="py-1 pr-2 text-right">{fmt(d.avg_required)}</td>
                  <td className={`py-1 pr-2 text-right font-semibold ${gapTone(d.avg_gap)}`}>{fmt(d.avg_gap)}</td>
                  <td className="py-1 text-right">{d.below_required ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.summary && (data.summary.categories || []).length > 0 && (
        <div className="card p-3 space-y-1">
          <p className="lbl">By competency area{department ? ` — ${department}` : ''}</p>
          {data.summary.categories.map((c) => (
            <p key={c.category} className="text-[11.5px] text-navy-500 flex flex-wrap items-center gap-2">
              <span className="min-w-[250px] font-semibold text-navy-700">{c.category}</span>
              <span>level {fmt(c.avg_manager)} · needs {fmt(c.avg_required)}</span>
              <span className={gapTone(c.avg_gap)}>gap {fmt(c.avg_gap)}</span>
              {c.below_required > 0 && <span className="chip bg-rose-100 text-rose-700">{c.below_required} below</span>}
            </p>
          ))}
        </div>
      )}

      {!!team.length && (
        <SearchBox value={q} onChange={setQ} placeholder="Search by name, designation, department or manager…"
          shown={shown.length} total={team.length} />
      )}
      {data.cycle && !team.length && !data.note && (
        <div className="card p-8 text-center text-sm text-navy-400">No active employees in this department.</div>
      )}

      <div className="space-y-2">
        {shown.map((t) => (
          <Person key={t.employee_id} row={t} scale={data.scale} open={openId === t.employee_id}
            onToggle={() => setOpenId(openId === t.employee_id ? null : t.employee_id)} />
        ))}
      </div>
    </div>
  );
}

function Person({ row, scale, open, onToggle }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!open) return;
    setD(null); setErr(null);
    api(`/pms/competencies/hod/${row.employee_id}`).then(setD).catch((e) => setErr(e.message));
  }, [open, row.employee_id]);
  const status = (v) => (v || 'not started').replace('_', ' ');
  return (
    <div className="card overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full p-3 flex flex-wrap items-center gap-2 text-left hover:bg-navy-50">
        {open ? <ChevronDown size={14} className="text-navy-400" /> : <ChevronRight size={14} className="text-navy-400" />}
        <span className="font-semibold text-sm text-navy-900">{row.name}</span>
        <span className="text-[11px] text-navy-400">{row.designation || '—'} · {row.department || '—'} · manager {row.manager_name || '—'}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className={`chip ${row.self_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-500'}`}>self: {status(row.self_status)}</span>
          <span className={`chip ${row.manager_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>manager: {status(row.manager_status)}</span>
          {row.avg_gap != null && <span className={`chip bg-white border border-navy-100 ${gapTone(Number(row.avg_gap))}`}>gap {fmt(row.avg_gap)}</span>}
          {row.below_required > 0 && <span className="chip bg-rose-100 text-rose-700">{row.below_required} below required</span>}
        </span>
      </button>
      {open && (
        <div className="border-t border-navy-100 p-4 space-y-3">
          {err && <p className="text-xs text-rose-600">{err}</p>}
          {!d && !err && <p className="text-xs text-navy-400">Loading…</p>}
          {d && !(d.rows || []).length && <p className="text-xs text-navy-400">No competency assessment started for this cycle yet.</p>}
          {d && (d.rows || []).length > 0 && <Detail d={d} scale={d.scale || scale} />}
        </div>
      )}
    </div>
  );
}

function Detail({ d, scale }) {
  const cats = [];
  const byName = new Map();
  for (const r of d.rows) {
    if (!byName.has(r.category)) { const g = { name: r.category, rows: [] }; byName.set(r.category, g); cats.push(g); }
    byName.get(r.category).rows.push(r);
  }
  const div = d.divergences || [];
  return (
    <>
      <ScaleLegend scale={scale} />
      {div.length > 0 && (
        <p className="text-[11.5px] text-amber-700 bg-amber-50 rounded-lg p-2 flex items-center gap-1.5">
          <AlertTriangle size={13} /> {div.length} {div.length === 1 ? 'competency' : 'competencies'} where the employee and manager differ by two levels or more.
        </p>
      )}
      {cats.map((c) => (
        <div key={c.name}>
          <p className="lbl">{c.name}</p>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-navy-400"><th className="py-1">Competency</th><th className="py-1">Required</th><th className="py-1">Self</th><th className="py-1">Manager</th></tr></thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.competency_id} className="border-t border-navy-50 align-top">
                  <td className="py-1.5 pr-2 font-semibold text-navy-800">{r.name}{r.manager_comment && <span className="block font-normal text-navy-500">{r.manager_comment}</span>}</td>
                  <td className="py-1.5 pr-2"><LevelChip scale={scale} level={r.required_level} /></td>
                  <td className="py-1.5 pr-2"><LevelChip scale={scale} level={r.self_rating} /></td>
                  <td className="py-1.5"><LevelChip scale={scale} level={r.manager_rating} required={r.required_level} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {d.assessment?.manager_summary && <p className="text-xs bg-navy-50 rounded-lg p-2"><b>Manager's comment:</b> {d.assessment.manager_summary}</p>}
    </>
  );
}
