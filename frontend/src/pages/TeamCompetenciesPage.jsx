import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import RatingPicker, { ScaleLegend, LevelChip } from '../CompetencyScale';
import { Save, Send, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2 } from 'lucide-react';

// "Team Competencies" — the manager half, from the Manager Assessment
// sheet of the client's workbook.
//
// Their instructions say the manager assesses "independently of the
// employee's self-rating", and their own sheet nonetheless carries an
// Employee Rating column. Both are honoured: the manager's rating is
// entered on its own control and never prefilled from the employee's,
// but the employee's answer is visible while writing, because that is
// what the sheet does and because hiding it would make the divergence
// list below a surprise rather than a conversation.
//
// My reports only, like every other Manager-tab page since 24 Sep.

export default function TeamCompetenciesPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [q, setQ] = useState('');

  const load = () => api('/pms/competencies/team')
    .then((r) => { setData(r); setErr(null); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Team Competencies" hue="lagoon" />
      <div className="card p-8 text-center text-sm text-navy-400">No cycle is open.</div>
    </div>
  );

  const team = data.team || [];
  const shown = team.filter((t) => matches(q, t.name, t.designation, t.department));
  const done = team.filter((t) => t.manager_status === 'submitted').length;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Team Competencies" hue="lagoon"
        sub="Assess each report against what their role needs, and see where your view differs from theirs.">
        <span className="chip bg-white/20 text-white">{data.cycle.name}</span>
        <span className={`chip ${done === team.length && team.length ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {done} / {team.length} submitted
        </span>
      </PageHead>

      {!team.length && (
        <div className="card p-8 text-center text-sm text-navy-400">
          No direct reports found, so there is nobody to assess.
        </div>
      )}
      {!!team.length && (
        <SearchBox value={q} onChange={setQ} placeholder="Search your team by name, designation or department…"
          shown={shown.length} total={team.length} />
      )}

      <div className="space-y-2">
        {shown.map((t) => (
          <Report key={t.employee_id} row={t} open={openId === t.employee_id}
            onToggle={() => setOpenId(openId === t.employee_id ? null : t.employee_id)}
            onSaved={load} />
        ))}
      </div>
    </div>
  );
}

function Report({ row, open, onToggle, onSaved }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({});
  const [summary, setSummary] = useState(undefined);

  useEffect(() => {
    if (!open) return;
    setD(null); setErr(null); setDraft({}); setSummary(undefined);
    api(`/pms/competencies/team/${row.employee_id}`).then(setD).catch((e) => setErr(e.message));
  }, [open, row.employee_id]);

  const pct = row.competencies ? Math.round((row.manager_rated / row.competencies) * 100) : 0;

  return (
    <div className="card overflow-hidden">
      <button type="button" onClick={onToggle}
        className="w-full p-3 flex flex-wrap items-center gap-2 text-left hover:bg-navy-50">
        {open ? <ChevronDown size={14} className="text-navy-400" /> : <ChevronRight size={14} className="text-navy-400" />}
        <span className="font-semibold text-sm text-navy-900">{row.name}</span>
        <span className="text-[11px] text-navy-400">{row.designation || '—'} · {row.department || '—'}</span>
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <span className={`chip ${row.self_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-500'}`}>
            self: {(row.self_status || 'not started').replace('_', ' ')}
          </span>
          <span className={`chip ${row.manager_status === 'submitted' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
            you: {(row.manager_status || 'not started').replace('_', ' ')}{row.competencies ? ` · ${pct}%` : ''}
          </span>
          {row.below_required > 0 && (
            <span className="chip bg-rose-100 text-rose-700">{row.below_required} below required</span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-navy-100 p-4 space-y-4">
          {err && <p className="text-xs text-rose-600">{err}</p>}
          {!d && !err && <p className="text-xs text-navy-400">Loading…</p>}
          {d && <Detail d={d} draft={draft} setDraft={setDraft} busy={busy} setBusy={setBusy}
            setErr={setErr} summary={summary} setSummary={setSummary}
            employeeId={row.employee_id}
            reload={() => api(`/pms/competencies/team/${row.employee_id}`).then(setD)}
            onSaved={onSaved} />}
        </div>
      )}
    </div>
  );
}

function Detail({ d, draft, setDraft, busy, setBusy, setErr, summary, setSummary, employeeId, reload, onSaved }) {
  const [note, setNote] = useState(undefined);
  const rows = d.rows || [];
  const editable = d.editable;
  const val = (r) => (draft[r.competency_id]?.rating !== undefined ? draft[r.competency_id].rating : r.manager_rating);
  const cmt = (r) => (draft[r.competency_id]?.comment !== undefined ? draft[r.competency_id].comment : (r.manager_comment || ''));
  const setEntry = (id, patch) => setDraft((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const rated = rows.filter((r) => val(r) != null).length;

  const body = () => {
    const entries = {};
    for (const [id, v] of Object.entries(draft)) {
      entries[id] = { rating: v.rating !== undefined ? v.rating : null,
                      comment: v.comment !== undefined ? v.comment : null };
    }
    return { entries, ...(note !== undefined ? { manager_summary: note } : {}) };
  };

  const save = async (thenSubmit) => {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/pms/competencies/team/${employeeId}`, { method: 'PUT', body: JSON.stringify(body()) });
      setSummary(r.summary);
      if (thenSubmit) await api(`/pms/competencies/team/${employeeId}/submit`, { method: 'POST' });
      setDraft({}); setNote(undefined);
      await reload(); onSaved();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Grouped by NAME, not by adjacency. The first cut merged only
  // CONSECUTIVE rows of the same category, so the moment two
  // categories' sort_order ranges overlapped the page rendered the
  // same heading twice and React warned about duplicate keys.
  const cats = [];
  {
    const byName = new Map();
    for (const r of rows) {
      if (!byName.has(r.category)) {
        const group = { name: r.category, rows: [] };
        byName.set(r.category, group);
        cats.push(group);
      }
      byName.get(r.category).rows.push(r);
    }
  }

  const s = summary !== undefined ? summary : d.summary;
  const div = d.divergences || [];

  return (
    <>
      {!editable && (
        <p className="text-xs text-emerald-700 bg-emerald-50 border-l-4 border-emerald-500 p-2 flex items-center gap-2">
          <CheckCircle2 size={14} /> Submitted — ask HR to reopen if something has to change.
        </p>
      )}
      {d.assessment?.self_status !== 'submitted' && (
        <p className="text-xs text-amber-700 bg-amber-50 border-l-4 border-amber2-500 p-2">
          {d.employee.name} has not submitted their self-assessment yet. You can still complete
          yours — the workbook has the manager assess independently.
        </p>
      )}

      {/* Where the two views differ by two levels or more. One level is
          calibration noise; two is a disagreement about the job, and it
          is the conversation this whole exercise exists to start. */}
      {div.length > 0 && (
        <div className="card p-3 border-l-4 border-amber2-500 space-y-1.5">
          <p className="text-xs font-bold text-navy-900 flex items-center gap-1.5">
            <AlertTriangle size={13} className="text-amber2-600" />
            {div.length} {div.length === 1 ? 'competency where you and' : 'competencies where you and'} {d.employee.name} see it differently
          </p>
          {div.map((x) => (
            <p key={x.competency_id} className="text-[11.5px] text-navy-500">
              <b className="text-navy-900">{x.name}</b> — they said {x.self}, you said {x.manager}
              {x.direction === 'employee_rates_higher' ? ' (they rate themselves higher)' : ' (you rate them higher)'}
            </p>
          ))}
        </div>
      )}

      {cats.map((cat) => (
        <div key={cat.name} className="space-y-2">
          <p className="lbl">{cat.name}</p>
          <ScaleLegend scale={d.scale} />
          <div className="divide-y divide-navy-50">
            {cat.rows.map((r) => (
              <div key={r.competency_id} className="py-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-navy-900">{r.name}</span>
                  <RatingPicker scale={d.scale} value={val(r)} required={r.required_level}
                    disabled={!editable}
                    onChange={(lvl) => setEntry(r.competency_id, { rating: lvl })} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <span className="text-navy-400">their rating</span>
                  <LevelChip scale={d.scale} level={r.self_rating} />
                  {r.self_evidence && <span className="text-navy-500 basis-full italic">“{r.self_evidence}”</span>}
                </div>
                <textarea className="inp !py-2 text-[12.5px]" rows={2} disabled={!editable}
                  placeholder="Your evidence / comment"
                  value={cmt(r)} onChange={(e) => setEntry(r.competency_id, { comment: e.target.value })} />
              </div>
            ))}
          </div>
        </div>
      ))}

      {s && (
        <div className="card p-3 space-y-1">
          <p className="lbl">Where {d.employee.name} stands</p>
          {s.categories.map((c) => (
            <p key={c.category} className="text-[11.5px] text-navy-500 flex flex-wrap items-center gap-2">
              <span className="min-w-[250px] font-semibold text-navy-700">{c.category}</span>
              <span>you {c.avg_manager ?? '—'} · needs {c.avg_required ?? '—'}</span>
              {c.priority && (
                <span className={`chip ${c.priority === 'High' ? 'bg-rose-100 text-rose-700'
                  : c.priority === 'Medium' ? 'bg-amber-100 text-amber-700'
                  : c.priority === 'Low' ? 'bg-sky-100 text-sky-700' : 'bg-emerald-100 text-emerald-700'}`}>
                  {c.priority}
                </span>
              )}
            </p>
          ))}
        </div>
      )}

      <div>
        <label className="lbl">Overall comment</label>
        <textarea className="inp" rows={2} disabled={!editable}
          value={note !== undefined ? note : (d.assessment?.manager_summary || '')}
          onChange={(e) => setNote(e.target.value)} />
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-sec" disabled={busy} onClick={() => save(false)}>
            <Save size={13} className="inline mr-1" />Save
          </button>
          <button className="btn-pri" disabled={busy} onClick={() => save(true)}>
            <Send size={13} className="inline mr-1" />Submit assessment
          </button>
          <span className="text-[11px] text-navy-400">
            {rated < rows.length ? `${rows.length - rated} of ${rows.length} still to rate` : 'Submitting locks your ratings.'}
          </span>
        </div>
      )}
    </>
  );
}
