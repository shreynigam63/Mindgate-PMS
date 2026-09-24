import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import RatingPicker, { ScaleLegend, LevelChip } from '../CompetencyScale';
import { Save, Send, CheckCircle2, Info, ChevronDown, ChevronRight } from 'lucide-react';

// "My Competencies" — the employee half of the competency mapping
// system the client asked for on 24 Sep, built from the Employee Form
// sheet of their own workbook.
//
// The workbook's shape is kept deliberately: role understanding first,
// then the competency blocks by category, then the learning and career
// questions. Somebody who has filled the spreadsheet in recognises this
// page, which is the whole point of working from their template rather
// than inventing a form.
//
// LEADERSHIP is absent for somebody with no reports — the server does
// not send it. A form that asks an individual contributor to rate their
// Delegation teaches them that the form is not about them.

const ROLE_QUESTIONS = [
  ['top_responsibilities', 'What are the top 5 responsibilities you currently handle?'],
  ['critical_outcomes', 'What are the 3 most critical outcomes expected from your role?'],
  ['strongest_areas', 'Which responsibilities are your strongest areas?'],
  ['challenging_areas', 'Which responsibilities do you find most challenging?'],
];
const CAREER_QUESTIONS = [
  ['develop_next', 'Top 3 competencies you want to develop in the next 12 months'],
  ['preferred_methods', 'Preferred development methods (training / project / mentoring / coaching / certification / rotation)'],
  ['aspiration_2_3_years', 'Where would you like to see yourself in the next 2–3 years?'],
  ['next_role_competencies', 'What competencies do you need to develop for your next role?'],
  ['internal_mobility', 'Are you interested in internal mobility? If yes, which areas?'],
  ['support_needed', 'What support do you need from your manager / organisation?'],
];

export default function MyCompetenciesPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  // Edits live here until saved, so a slow network cannot make the page
  // forget what somebody typed.
  const [draft, setDraft] = useState({});
  const [text, setText] = useState({});
  // Which competency block is expanded. Starts closed and is opened at
  // the first unfinished block once the data arrives, so somebody
  // returning to a part-filled form lands where they stopped.
  const [open, setOpen] = useState(null);

  const load = () => api('/pms/competencies/me')
    .then((r) => {
      setD(r); setDraft({}); setText({}); setErr(null);
      const first = (r.rows || []).find((x) => x.self_rating == null) || (r.rows || [])[0];
      setOpen((cur) => cur || (first ? first.category : null));
    })
    .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!d.cycle) return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="My Competencies" hue="navy" />
      <div className="card p-8 text-center text-sm text-navy-400">No cycle is open.</div>
    </div>
  );

  const rows = d.rows || [];
  const editable = d.editable;
  const val = (r) => (draft[r.competency_id]?.rating !== undefined
    ? draft[r.competency_id].rating : r.self_rating);
  const evi = (r) => (draft[r.competency_id]?.evidence !== undefined
    ? draft[r.competency_id].evidence : (r.self_evidence || ''));
  const setEntry = (id, patch) => setDraft((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const field = (k) => (text[k] !== undefined ? text[k] : (d.assessment?.[k] || ''));

  const rated = rows.filter((r) => val(r) != null).length;
  const dirty = Object.keys(draft).length > 0 || Object.keys(text).length > 0;

  const body = () => {
    const entries = {};
    for (const [id, v] of Object.entries(draft)) {
      entries[id] = { rating: v.rating !== undefined ? v.rating : null,
                      evidence: v.evidence !== undefined ? v.evidence : null };
    }
    return { entries, ...text };
  };

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try { await api('/pms/competencies/me', { method: 'PUT', body: JSON.stringify(body()) }); await load(); setMsg('Saved.'); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const submit = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      if (dirty) await api('/pms/competencies/me', { method: 'PUT', body: JSON.stringify(body()) });
      await api('/pms/competencies/me/submit', { method: 'POST' });
      await load();
      setMsg('Submitted to your manager.');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Grouped in the workbook's own category order, which the server
  // preserves through sort_order.
  // Grouped by NAME, not by adjacency. The first cut merged only
  // CONSECUTIVE rows of the same category, so the moment two
  // categories' sort_order ranges overlapped the page rendered the
  // same heading twice and React warned about duplicate keys.
  const categories = [];
  {
    const byName = new Map();
    for (const r of rows) {
      if (!byName.has(r.category)) {
        const group = { name: r.category, rows: [] };
        byName.set(r.category, group);
        categories.push(group);
      }
      byName.get(r.category).rows.push(r);
    }
  }

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="My Competencies" hue="navy"
        sub="Rate yourself against what your role needs, with an example for each.">
        <span className="chip bg-white/20 text-white">{d.cycle.name}</span>
        <span className={`chip ${rated === rows.length ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {rated} / {rows.length} rated
        </span>
      </PageHead>

      {!editable && (
        <p className="card p-3 text-xs text-emerald-700 bg-emerald-50 border-l-4 border-emerald-500 flex items-center gap-2">
          <CheckCircle2 size={14} />
          Submitted{d.assessment?.self_submitted_at ? ` on ${new Date(d.assessment.self_submitted_at).toLocaleDateString()}` : ''}.
          Your manager assesses you separately — ask HR if something needs to change.
        </p>
      )}
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}

      <div className="card p-4 space-y-1">
        <p className="lbl">You</p>
        <p className="text-sm font-bold">{d.employee?.name}</p>
        <p className="text-[11.5px] text-navy-400">
          {d.employee?.designation || '—'} · {d.employee?.department || '—'}
          {d.employee?.manager_name ? ` · reports to ${d.employee.manager_name}` : ''}
        </p>
      </div>

      <div className="card p-4 space-y-3">
        <p className="lbl">Role understanding</p>
        {ROLE_QUESTIONS.map(([k, q]) => (
          <div key={k}>
            <label className="text-[11.5px] text-navy-500 block mb-1">{q}</label>
            <textarea className="inp" rows={2} disabled={!editable} value={field(k)}
              onChange={(e) => setText((p) => ({ ...p, [k]: e.target.value }))} />
          </div>
        ))}
      </div>

      <div className="card p-3 text-[11.5px] text-navy-500 flex gap-2">
        <Info size={14} className="shrink-0 mt-0.5 text-navy-400" />
        <span>
          <b>needs N</b> beside a competency is the level your role is expected to reach.
          Rate what is true today — your manager rates you independently, and the two views
          are compared rather than averaged.
        </span>
      </div>

      {/* COLLAPSIBLE, and open on the first unfinished one. Forty
          competencies with an evidence box each is an eight-thousand
          pixel page, and a form somebody has to scroll for a minute to
          find their place in is a form they abandon. The header carries
          the count, so a collapsed block still says whether it is done. */}
      {categories.map((cat) => {
        const catRated = cat.rows.filter((r) => val(r) != null).length;
        const isOpen = open === cat.name;
        return (
          <div key={cat.name} className="card overflow-hidden">
            <button type="button" onClick={() => setOpen(isOpen ? null : cat.name)}
              className="w-full p-4 flex flex-wrap items-center gap-2 text-left hover:bg-navy-50">
              {isOpen ? <ChevronDown size={14} className="text-navy-400" />
                      : <ChevronRight size={14} className="text-navy-400" />}
              <span className="text-sm font-bold text-navy-900">{cat.name}</span>
              <span className={`chip ml-auto ${catRated === cat.rows.length
                ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                {catRated} / {cat.rows.length} rated
              </span>
            </button>
            {isOpen && (
              <div className="border-t border-navy-100 p-4 space-y-3">
                <ScaleLegend scale={d.scale} />
                <div className="divide-y divide-navy-50">
                  {cat.rows.map((r) => (
                    <div key={r.competency_id} className="py-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-navy-900">{r.name}</span>
                        <RatingPicker scale={d.scale} value={val(r)} required={r.required_level}
                          disabled={!editable}
                          onChange={(lvl) => setEntry(r.competency_id, { rating: lvl })} />
                      </div>
                      <textarea className="inp !py-2 text-[12.5px]" rows={2} disabled={!editable}
                        placeholder="Evidence / example — what you actually did"
                        value={evi(r)}
                        onChange={(e) => setEntry(r.competency_id, { evidence: e.target.value })} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="card p-4 space-y-3">
        <p className="lbl">Learning, career & development</p>
        {CAREER_QUESTIONS.map(([k, q]) => (
          <div key={k}>
            <label className="text-[11.5px] text-navy-500 block mb-1">{q}</label>
            <textarea className="inp" rows={2} disabled={!editable} value={field(k)}
              onChange={(e) => setText((p) => ({ ...p, [k]: e.target.value }))} />
          </div>
        ))}
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-sec" disabled={busy || !dirty} onClick={save}>
            <Save size={13} className="inline mr-1" />Save draft
          </button>
          <button className="btn-pri" disabled={busy} onClick={submit}>
            <Send size={13} className="inline mr-1" />Submit to my manager
          </button>
          <span className="text-[11px] text-navy-400">
            {rated < rows.length
              ? `All ${rows.length} competencies must be rated before you can submit — ${rows.length - rated} left.`
              : 'Submitting locks your ratings.'}
          </span>
        </div>
      )}

      {/* Once the manager has submitted, the employee sees where they
          stand. Hidden until then, because a half-finished assessment
          shown as a result is a result that changes under them. */}
      {d.assessment?.manager_status === 'submitted' && (
        <div className="card p-4 space-y-2">
          <p className="lbl">Your manager's assessment</p>
          <div className="divide-y divide-navy-50">
            {rows.map((r) => (
              <div key={r.competency_id} className="py-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-navy-900 min-w-[220px]">{r.name}</span>
                <span className="text-navy-400">you</span>
                <LevelChip scale={d.scale} level={r.self_rating} />
                <span className="text-navy-400">manager</span>
                <LevelChip scale={d.scale} level={r.manager_rating} required={r.required_level} />
                {r.manager_comment && <span className="text-navy-500 basis-full">{r.manager_comment}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
