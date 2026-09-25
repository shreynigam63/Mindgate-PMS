import { useEffect, useState } from 'react';
import { Plus, Sparkles, Play, Square, Trash2 } from 'lucide-react';
import { api } from '../utils/api';
import { AiModal } from './AiDraftPanel';
import PageHead from '../PageHead';

// SPLIT IN TWO on 23 Sep. Asked for: "Engagement tab should be under HR
// tab and not my performance."
//
// The page was doing two unrelated jobs behind one route: HR creates
// surveys and reads results, and every employee responds to them. Moving
// the whole thing to HR would have taken survey-taking away from 1,398
// people, so the two jobs became two pages:
//
//   /engagement        — MY SURVEYS. Self tab. Respond to what is open.
//   /admin/engagement  — ENGAGEMENT.  HR tab. Create, open, close, read.
//
// Same endpoints, same anonymity guarantees; only the route each half
// lives at changed.
export default function MySurveysPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [taking, setTaking] = useState(null);
  const load = () => api('/engagement/my/invitations')
    .then((i) => setData(i.invitations || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (taking) return <TakeSurvey survey={taking} done={() => { setTaking(null); load(); }} />;

  const open = data.filter((i) => !i.completed_at);
  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <PageHead title="My Surveys" hue="leaf"
        sub="Engagement surveys HR has sent you. Anonymous ones never store your name against your answers." />
      {!data.length && (
        <div className="card p-8 text-center text-sm text-navy-400">
          No surveys have been sent to you.
        </div>
      )}
      {data.length > 0 && (
        <div className="card divide-y divide-navy-50">
          {data.map((i) => (
            <div key={`${i.id}-${i.subject_employee_id || 'self'}`} className="p-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold flex-1">
                {i.title}
                {/* A manager holds one of these per reportee, all with
                    the same title. Without the name they are four
                    identical rows and there is no way to tell which
                    one has been done. */}
                {i.subject_name && (
                  <span className="chip bg-lagoon-50 text-lagoon-700 ml-2">
                    about {i.subject_name}{i.subject_designation ? ` · ${i.subject_designation}` : ''}
                  </span>
                )}
              </span>
              <span className="chip bg-navy-50 text-navy-500">{i.survey_type}</span>
              {i.anonymity_default && <span className="chip bg-emerald-100 text-emerald-700">anonymous</span>}
              {i.completed_at
                ? <span className="text-xs text-emerald-600">completed ✓</span>
                : <button className="btn-pri" onClick={() => setTaking(i)}>Take</button>}
            </div>
          ))}
        </div>
      )}
      {open.length > 0 && (
        <p className="text-[11px] text-navy-400">
          {open.length} still open.
          {/* "in aggregate" is true of an anonymous pulse and a lie
              about an assessment, where HR reads exactly what this
              manager said about this person. Said separately rather
              than averaged into one reassuring sentence. */}
          {open.some((i) => !i.subject_name) && ' Answers to the anonymous ones go to HR in aggregate.'}
          {open.some((i) => i.subject_name) && ' The ones naming a colleague are assessments: HR sees your answers against their name and yours.'}
        </p>
      )}
    </div>
  );
}

export function EngagementAdminPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [results, setResults] = useState(null);
  const [themes, setThemes] = useState(null);
  const [themesOpen, setThemesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const [library, setLibrary] = useState(false);
  const [madeFrom, setMadeFrom] = useState(null);
  const [sweep, setSweep] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const load = () => api('/engagement/surveys').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;

  const openSurvey = async (s) => {
    try { const r = await api(`/engagement/surveys/${s.id}/open`, { method: 'POST' }); alert(`Opened — ${r.invited} invited.`); load(); }
    catch (e) { alert(e.message); }
  };
  const viewResults = async (s) => {
    setThemes(null);
    try { setResults(await api(`/engagement/surveys/${s.id}/results`)); }
    catch (e) { alert(e.message); }
  };
  const askThemes = async (surveyId) => {
    setBusy(true);
    try { const r = await api('/agentic/engagement-themes', { method: 'POST', body: JSON.stringify({ survey_id: surveyId }) }); setThemes(r.draft); setThemesOpen(true); }
    catch (e) { alert(e.message); }
    setBusy(false);
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Engagement" hue="leaf"
        sub="Create surveys, open them to the company, and read the results.">
        {data.admin && <>
          <button className="btn-pri" onClick={() => setLibrary(true)}>
            <Plus size={13} className="inline mr-1" />New from library</button>
          <button className="btn-sec" onClick={() => setBuilding(true)}>Blank survey</button>
        </>}
      </PageHead>
      {library && <SurveyLibrary
        onClose={() => setLibrary(false)}
        onBlank={() => { setLibrary(false); setBuilding(true); }}
        onUsed={(r) => { setLibrary(false); setMadeFrom(r); load(); }} />}
      {building && <SurveyBuilder onClose={() => setBuilding(false)}
        onCreated={() => { setBuilding(false); load(); }} />}
      {/* Says what just happened, because a template lands as a draft
          in a list rather than opening anything, and silence there
          reads as nothing having worked. */}
      {madeFrom && (
        <p className="card p-3 text-xs text-navy-600 bg-leaf-50 border-l-4 border-leaf-500">
          <b>{madeFrom.survey.title}</b> created as a draft with {madeFrom.questions} questions
          {madeFrom.survey.trigger_type === 'tenure'
            ? <> — a lifecycle survey for day {madeFrom.survey.trigger_day}–{madeFrom.survey.trigger_day + madeFrom.survey.trigger_window_days}</>
            : null}.
          {' '}Check who it goes to, then press <b>Open</b> to release it.
          <button className="ml-2 underline" onClick={() => setMadeFrom(null)}>dismiss</button>
        </p>
      )}

      <div className="card divide-y divide-navy-100">
        {data.surveys.map(s => (
          <div key={s.id} className="p-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold flex-1">
              {s.title}
              {/* A standing survey behaves differently from a one-off
                  and has to look different, or HR cannot tell why one
                  keeps gaining respondents after it was released. */}
              {s.trigger_type === 'tenure' && (
                <span className="chip bg-lagoon-50 text-lagoon-700 ml-2">
                  standing · day {s.trigger_day}–{s.trigger_day + s.trigger_window_days}
                </span>
              )}
            </span>
            <span className={`chip ${s.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-600'}`}>{s.status}</span>
            <span className="text-xs text-navy-400">{s.completed}/{s.invited} completed</span>
            {data.admin && s.status === 'draft' && <button className="btn-sec" onClick={() => openSurvey(s)}><Play size={12} className="inline mr-1" />Open</button>}
            {data.admin && s.status === 'open' && <button className="btn-sec" onClick={async () => { await api(`/engagement/surveys/${s.id}/close`, { method: 'POST' }); load(); }}><Square size={12} className="inline mr-1" />Close</button>}
            {data.admin && <button className="btn-sec" onClick={() => viewResults(s)}>Results</button>}
          </div>
        ))}
        {!data.surveys.length && <p className="p-6 text-center text-sm text-navy-400">No surveys yet.</p>}
      </div>

      {/* Lifecycle surveys are swept nightly. This runs the same sweep
          on demand, which is the only way to see a standing survey do
          its job without waiting a day. */}
      {data.admin && data.surveys.some((s) => s.trigger_type === 'tenure' && s.status === 'open') && (
        <div className="card p-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-navy-500 flex-1">
            Lifecycle surveys are checked automatically once a day — each new joiner is invited as
            they reach their milestone. You can run that check now.
          </span>
          {sweep && (
            <span className={sweep.invited ? 'text-emerald-700 font-semibold' : 'text-navy-400'}>
              {sweep.invited ? `${sweep.invited} newly invited` : 'nobody new today'}
            </span>
          )}
          <button className="btn-sec !py-1" disabled={sweeping} onClick={async () => {
            setSweeping(true);
            try { setSweep(await api('/engagement/surveys/sweep', { method: 'POST' })); load(); }
            catch (e) { setSweep({ invited: 0, error: e.message }); }
            setSweeping(false);
          }}>{sweeping ? 'Checking…' : 'Check for new joiners now'}</button>
        </div>
      )}

      {results && (
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold flex-1">{results.survey.title} — results</p>
            <span className="chip bg-navy-50 text-navy-600">participation {results.participation.rate}%</span>
            <button className="btn-sec" disabled={busy} onClick={() => askThemes(results.survey.id)}>
              <Sparkles size={13} className="inline mr-1 text-amber-500" />{busy ? 'Theming…' : 'Theme verbatims (agent)'}</button>
          </div>
          {/* THE PER-PERSON SCORECARD. On a manager assessment the
              cohort average is the least useful number in the file —
              the point is what each manager said about each of their
              new joiners. Weakest first, because that is the row HR
              has to act on. */}
          {results.subjects && (
            <div className="mb-3">
              <p className="lbl">Each employee, as their manager rated them — weakest first</p>
              {!results.subjects.length && (
                <p className="text-xs text-navy-400 mt-1">No manager has answered yet.</p>
              )}
              <div className="space-y-2 mt-1">
                {results.subjects.map((p) => (
                  <details key={p.employee_id} className="card p-3">
                    <summary className="cursor-pointer text-sm font-semibold flex flex-wrap items-center gap-2">
                      <span className={`chip ${p.average != null && p.average < 3 ? 'bg-rose-100 text-rose-700' : 'bg-navy-50 text-navy-600'}`}>
                        {p.average == null ? '—' : p.average.toFixed(1)}
                      </span>
                      {p.name}
                      {p.designation && <span className="text-navy-400 font-normal">· {p.designation}</span>}
                      <span className="text-[11px] text-navy-400 font-normal">rated by {p.manager}</span>
                    </summary>
                    <div className="mt-2 space-y-1">
                      {p.answers.map((a, n) => (
                        <div key={n} className="flex flex-wrap gap-2 text-[11.5px]">
                          <span className="text-navy-500 flex-1 min-w-[200px]">{a.prompt}</span>
                          <span className="font-semibold text-navy-700">{String(a.value)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}

          {results.questions.map(q => (
            <div key={q.id} className="text-xs border-t border-navy-100 pt-2">
              <p className="font-semibold">{q.prompt}</p>
              {q.qtype === 'text'
                ? <p className="text-navy-500">{(q.verbatims || []).length} text answers (themed via the agent — individual verbatims stay in the data)</p>
                : q.tally
                  // Counted per option, biggest first. This used to
                  // print "n=0 · avg" for a choice question while the
                  // answers sat unread in the table — which hit the
                  // most useful question in a 30-day survey, the one
                  // naming what is blocking somebody.
                  ? (
                    <div className="mt-1 space-y-1">
                      <p className="text-navy-500 text-[11px]">{q.n} answered</p>
                      {q.tally.map((t) => (
                        <div key={t.option} className="flex items-center gap-2">
                          <div className="w-44 shrink-0 text-navy-600 truncate" title={t.option}>{t.option}</div>
                          <div className="flex-1 h-2 rounded-full bg-navy-50 overflow-hidden">
                            <div className="h-full rounded-full bg-leaf-500" style={{ width: `${t.pct}%` }} />
                          </div>
                          <div className="w-16 shrink-0 text-right text-navy-500 tabular-nums">{t.count} · {t.pct}%</div>
                        </div>
                      ))}
                    </div>
                  )
                  : <p className="text-navy-600">n={q.n} · avg {q.average}{q.enps !== undefined && <> · <b>eNPS {q.enps}</b></>}</p>}
            </div>
          ))}
          {/* Themes open over the page. The question-by-question numbers
              above are what the results card is for; the themes are a read
              of the free text and should not push them off screen. */}
          {themes && !themesOpen && (
            <button className="text-[11px] font-semibold text-navy-600 hover:underline self-start" onClick={() => setThemesOpen(true)}>
              Reopen the {(themes.themes || []).length} theme{(themes.themes || []).length === 1 ? '' : 's'}
            </button>
          )}
          {themes && themesOpen && (
            <AiModal title={`Themes — ${results.survey.title}`} onClose={() => setThemesOpen(false)}>
              {(themes.themes || []).map((t, i) => (
                <div key={i} className="border border-navy-100 rounded-lg p-3 bg-navy-50/60 space-y-1">
                  <p className="font-bold">{t.name} <span className="text-navy-400 font-normal">({t.prevalence})</span></p>
                  <p>{t.summary}</p>
                  {t.representative_quote && <p className="text-navy-400 italic">"{t.representative_quote}"</p>}
                </div>
              ))}
              {!(themes.themes || []).length && <p className="text-navy-400">No themes came back — there may be too few text answers to read.</p>}
            </AiModal>
          )}
        </div>
      )}
    </div>
  );
}



// THE SURVEY LIBRARY (phase 3, 25 Sep). "I would create a Survey
// Library" — so HR picks "Day 30 Connect" rather than typing twenty
// questions, and so the rule Mindgate stated themselves survives
// contact with practice:
//
//   "don't ask the same questions at 30/60/90 ... the employee's
//    questions should evolve with tenure"
//
// Typed by hand, five milestones become five copies of whatever was
// written first. The library is what makes the progression real.
//
// Using one creates a DRAFT. Nothing is released here — the survey
// lands on the list and still has to be opened, so somebody reads the
// twenty questions before 1,400 people do.
function SurveyLibrary({ onClose, onUsed, onBlank }) {
  const [tpls, setTpls] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    api('/engagement/templates').then((r) => setTpls(r.templates)).catch((e) => setErr(e.message));
  }, []);

  const use = async (t) => {
    setBusy(t.key); setErr(null);
    try { onUsed(await api(`/engagement/templates/${t.key}/use`, { method: 'POST', body: '{}' })); }
    catch (e) { setErr(e.message); setBusy(null); }
  };

  const cats = [...new Set((tpls || []).map((t) => t.category))];
  return (
    <AiModal wide badge={false} title="Start from the survey library" onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-navy-500 flex-1">
            Using one creates a <b>draft</b> you can edit — nothing goes out until you press Open.
          </span>
          <button className="btn-sec !py-1.5" onClick={onClose}>Cancel</button>
          <button className="btn-sec !py-1.5" onClick={onBlank}>Start from blank instead</button>
        </div>
      }>
      <div className="space-y-4">
        {err && <p className="text-xs text-rose-600">{err}</p>}
        {!tpls && <p className="text-sm text-navy-400">Loading the library…</p>}
        {tpls && !tpls.length && <p className="text-sm text-navy-400">The library is empty.</p>}
        {cats.map((cat) => (
          <div key={cat}>
            <p className="lbl">{cat}</p>
            <div className="space-y-2 mt-1">
              {tpls.filter((t) => t.category === cat).map((t) => (
                <div key={t.key} className="card p-3 flex flex-wrap items-start gap-3">
                  <div className="flex-1 min-w-[260px]">
                    <p className="text-sm font-semibold flex flex-wrap items-center gap-2">
                      {t.title}
                      {t.trigger_type === 'tenure' && (
                        <span className="chip bg-lagoon-50 text-lagoon-700">
                          day {t.trigger_day}–{t.trigger_day + t.trigger_window_days}
                        </span>
                      )}
                      <span className={`chip ${t.anonymity_default ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-500'}`}>
                        {t.anonymity_default ? 'anonymous' : 'attributed'}
                      </span>
                      <span className="chip bg-navy-50 text-navy-500">{t.question_count} questions</span>
                      {t.used > 0 && <span className="chip bg-navy-50 text-navy-400">used {t.used}×</span>}
                    </p>
                    {t.description && <p className="text-[11.5px] text-navy-500 mt-0.5">{t.description}</p>}
                    {/* A template that cannot be released on this
                        tenant's data says so, rather than letting HR
                        release something that reaches nobody. */}
                    {t.blocked_reason && (
                      <p className="text-[11px] text-amber-700 bg-amber-50 rounded-md px-2 py-1.5 mt-1.5">
                        <b>Not automatic yet.</b> {t.blocked_reason}
                      </p>
                    )}
                  </div>
                  <button className="btn-pri !py-1.5 shrink-0" disabled={busy === t.key} onClick={() => use(t)}>
                    {busy === t.key ? 'Creating…' : 'Use this'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </AiModal>
  );
}

// THE SURVEY BUILDER, replacing a chain of browser prompt() boxes.
//
// The old flow asked for a title in one dialog, then asked for questions
// one at a time in a loop, and the only way to say what KIND a question
// was was to type "enps:" or "text:" as a prefix. You could not see what
// you had written, could not go back, could not reorder, and a stray
// Cancel threw the lot away. It also cannot be styled, and on the
// client's own screenshot it renders as "pms.agentichumans.in says".
//
// This is the same three fields, on one form, visible at once.
const QTYPES = [
  { v: 'scale',  label: '1–5 scale',  hint: 'Rated one to five. The default, and what the averages are built from.' },
  { v: 'enps',   label: 'eNPS 0–10',  hint: 'The "how likely are you to recommend" question. Scored as eNPS.' },
  { v: 'choice', label: 'Pick one',   hint: 'One option from a list. Counted per option — this is the shape for "what is blocking you?".', opts: true },
  { v: 'multi',  label: 'Pick any',   hint: 'Any number of options. Counted per option, so the percentages can add up to more than 100.', opts: true },
  { v: 'text',   label: 'Open text',  hint: 'Free text. Read as themes by the agent; individual answers stay in the data.' },
];
const needsOptions = (t) => (QTYPES.find((x) => x.v === t) || {}).opts === true;

// A checkbox list of the values that actually exist on the employee
// master. Hoisted to module scope ON PURPOSE: a component declared
// inside its parent is a new component type on every render, so React
// remounts it on each keystroke and any input inside loses focus after
// one character. That bug has already been paid for once on the
// employee Add form.
function PickList({ label, options, chosen, onChange, hint }) {
  if (!options || !options.length) return null;
  const toggle = (v) => onChange(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]);
  return (
    <div>
      <p className="lbl">{label}{chosen.length ? ` · ${chosen.length} selected` : ''}</p>
      {hint && <p className="text-[10px] text-navy-400 mb-1">{hint}</p>}
      <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto p-1.5 rounded-lg border border-navy-100 bg-white">
        {options.map((o) => {
          const v = typeof o === 'string' ? o : o.id;
          const text = typeof o === 'string' ? o : o.name;
          return (
            <button key={v} type="button" onClick={() => toggle(v)}
              className={`chip ${chosen.includes(v) ? 'bg-leaf-500 text-white' : 'bg-navy-50 text-navy-500'}`}>{text}</button>
          );
        })}
      </div>
    </div>
  );
}

function SurveyBuilder({ onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [qs, setQs] = useState([{ qtype: 'scale', prompt: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // --- audience + trigger, added 25 Sep -----------------------------
  // "which will be pushed to all employees who are fitting in that
  // employees categories". Until now this screen sent every survey to
  // the whole company: it did not expose the audience field at all.
  const [opts, setOpts] = useState(null);           // what the master actually holds
  const [rule, setRule] = useState({ departments: [], designations: [], role_bands: [], manager_ids: [] });
  const [trigger, setTrigger] = useState('manual'); // manual | tenure
  const [kind, setKind] = useState('self');         // self | manager_about_reportee
  const [day, setDay] = useState(30);
  const [win, setWin] = useState(7);
  const [anon, setAnon] = useState(true);
  const [preview, setPreview] = useState(null);

  useEffect(() => { api('/engagement/audience/options').then(setOpts).catch(() => setOpts(null)); }, []);

  // The live count. Debounced, and re-run on every change to the rule
  // or the milestone, so the number on screen is the number the release
  // will write to — both go through the same resolver on the server.
  useEffect(() => {
    let dead = false;
    const t = setTimeout(() => {
      api('/engagement/audience/preview', { method: 'POST', body: JSON.stringify({
        audience_rule: rule, trigger_type: trigger, audience_kind: kind,
        ...(trigger === 'tenure' ? { trigger_day: Number(day), trigger_window_days: Number(win) } : {}),
      }) }).then((r) => { if (!dead) setPreview(r); })
        .catch((e) => { if (!dead) setPreview({ error: e.message }); });
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [rule, trigger, day, win, kind]);

  const setRuleKey = (k) => (v) => setRule((r) => ({ ...r, [k]: v }));
  const set = (i, k, v) => setQs((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (i, d) => setQs((rows) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return rows;
    const out = [...rows];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  });

  const filled = qs.filter((q) => q.prompt.trim());
  const optionsOf = (q) => String(q.optionText || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    setErr(null);
    if (!title.trim()) { setErr('Give the survey a title.'); return; }
    if (!filled.length) { setErr('A survey needs at least one question.'); return; }
    // Caught here as well as on the server, because the server's
    // refusal arrives after the whole form has been posted and names
    // only the first bad question.
    const short = filled.find((q) => needsOptions(q.qtype) && optionsOf(q).length < 2);
    if (short) { setErr(`"${short.prompt.trim().slice(0, 50)}" is a ${short.qtype === 'multi' ? 'pick-any' : 'pick-one'} question, so it needs at least two options — one per line.`); return; }
    setBusy(true);
    try {
      await api('/engagement/surveys', { method: 'POST', body: JSON.stringify({
        title: title.trim(),
        audience_rule: rule,
        audience_kind: kind,
        trigger_type: trigger,
        ...(trigger === 'tenure' ? { trigger_day: Number(day), trigger_window_days: Number(win) } : {}),
        anonymity_default: kind === 'manager_about_reportee' ? false : anon,
        allow_attribution_optin: anon,
        questions: filled.map((q) => ({
          qtype: q.qtype, prompt: q.prompt.trim(),
          ...(needsOptions(q.qtype) ? { options: optionsOf(q) } : {}),
          ...(q.qtype === 'text' ? { required: false } : {}),
        })),
      }) });
      onCreated();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <AiModal wide badge={false} title="New survey" onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-navy-500">
            {/* Counts the questions that actually HAVE text, since blank
                ones are dropped on save — so this line and the survey
                that gets created agree. "0 questions" next to a visible
                empty Question 1 would otherwise read as a bug rather
                than as the prompt to type something that it is. */}
            {filled.length
              ? <>{filled.length} question{filled.length === 1 ? '' : 's'} · saved as a <b>draft</b></>
              : <>Nothing written yet — type a question to enable <b>Create survey</b></>}
          </span>
          <button className="btn-sec !py-1.5" onClick={onClose}>Cancel</button>
          {/* Genuinely disabled, because the line to its left says it is.
              save() still validates — the button is a courtesy, not the
              guard, and a survey with no questions is refused either
              way. */}
          <button className="btn-pri !py-1.5" disabled={busy || !filled.length} onClick={save}>
            {busy ? 'Creating…' : 'Create survey'}
          </button>
        </div>
      }>
      <div className="space-y-3">
        <div>
          <label className="lbl">Survey title</label>
          <input className="inp" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Employee Satisfaction — H1 FY26-27" />
        </div>

        {qs.map((q, i) => (
          <div key={i} className="card p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-navy-400">Question {i + 1}</span>
              <span className="ml-auto flex items-center gap-1">
                <button className="text-navy-300 hover:text-navy-700 disabled:opacity-30"
                  disabled={i === 0} title="Move up" onClick={() => move(i, -1)}>↑</button>
                <button className="text-navy-300 hover:text-navy-700 disabled:opacity-30"
                  disabled={i === qs.length - 1} title="Move down" onClick={() => move(i, 1)}>↓</button>
                <button className="text-rose-500 hover:text-rose-700 disabled:opacity-30 ml-1"
                  disabled={qs.length === 1} title="Remove"
                  onClick={() => setQs((rows) => rows.filter((_, j) => j !== i))}>
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
            <input className="inp" value={q.prompt} onChange={(e) => set(i, 'prompt', e.target.value)}
              placeholder="What do you want to ask?" />
            <div className="flex flex-wrap gap-1.5">
              {QTYPES.map((t) => (
                <button key={t.v} type="button" title={t.hint}
                  className={`chip ${q.qtype === t.v ? 'bg-leaf-500 text-white' : 'bg-navy-50 text-navy-500'}`}
                  onClick={() => set(i, 'qtype', t.v)}>{t.label}</button>
              ))}
            </div>
            <p className="text-[11px] text-navy-400">{(QTYPES.find((t) => t.v === q.qtype) || {}).hint}</p>
            {needsOptions(q.qtype) && (
              <div>
                <label className="lbl">Options — one per line</label>
                <textarea className="inp" rows={4} value={q.optionText || ''}
                  onChange={(e) => set(i, 'optionText', e.target.value)}
                  placeholder={'Lack of training\nLack of system access\nDependency on others\nNo significant blocker'} />
                <p className="text-[10px] text-navy-400 mt-1">
                  {optionsOf(q).length} option{optionsOf(q).length === 1 ? '' : 's'} — at least two are needed,
                  and the results are counted per option.
                </p>
              </div>
            )}
          </div>
        ))}

        <button className="btn-sec" onClick={() => setQs((rows) => [...rows, { qtype: 'scale', prompt: '' }])}>
          <Plus size={13} className="inline mr-1" />Add question
        </button>

        {/* WHO IT GOES TO. This whole panel is new on 25 Sep: the form
            used to send every survey to the entire company because it
            never asked. */}
        <div className="card p-3 space-y-3 border-l-4 border-leaf-500">
          <p className="lbl">Who gets this survey</p>

          {/* WHO ANSWERS. Asked for on 25 Sep: "you should also survey
              the manager ... if you only ask employees, your PMS will
              capture perception, but not the manager's assessment."
              On a manager survey the picks below choose who is
              ASSESSED, and each of their managers is invited. */}
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setKind('self')}
              className={`chip ${kind === 'self' ? 'bg-lagoon-500 text-white' : 'bg-navy-50 text-navy-500'}`}>
              Employees answer about themselves
            </button>
            <button type="button" onClick={() => setKind('manager_about_reportee')}
              className={`chip ${kind === 'manager_about_reportee' ? 'bg-lagoon-500 text-white' : 'bg-navy-50 text-navy-500'}`}>
              Managers answer about each reportee
            </button>
          </div>
          {kind === 'manager_about_reportee' && (
            <p className="text-[11px] text-lagoon-800 bg-lagoon-50 rounded-md px-2.5 py-1.5">
              The choices below pick the people being <b>assessed</b>. Each one&rsquo;s reporting manager
              gets their own copy naming them, so a manager with four new joiners answers four times.
              An assessment is <b>always attributed</b> — it records what a named manager said about a
              named person — so the anonymity option does not apply.
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setTrigger('manual')}
              className={`chip ${trigger === 'manual' ? 'bg-leaf-500 text-white' : 'bg-navy-50 text-navy-500'}`}>
              Send once
            </button>
            <button type="button" onClick={() => setTrigger('tenure')}
              className={`chip ${trigger === 'tenure' ? 'bg-leaf-500 text-white' : 'bg-navy-50 text-navy-500'}`}>
              Lifecycle — send on a milestone after joining
            </button>
          </div>

          {trigger === 'tenure' && (
            <div className="space-y-2 bg-leaf-50 rounded-lg p-2.5">
              <div className="flex flex-wrap gap-1.5">
                {(opts?.milestones || []).map((m) => (
                  <button key={m.key} type="button"
                    onClick={() => { setDay(m.day); setWin(m.window); }}
                    className={`chip ${Number(day) === m.day ? 'bg-navy-700 text-white' : 'bg-white text-navy-600 border border-navy-100'}`}>
                    {m.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="lbl">Days after joining</label>
                  <input className="inp !w-24" type="number" min="0" value={day}
                    onChange={(e) => setDay(e.target.value)} />
                </div>
                <div>
                  <label className="lbl">Catch-up window (days)</label>
                  <input className="inp !w-24" type="number" min="1" max="90" value={win}
                    onChange={(e) => setWin(e.target.value)} />
                </div>
              </div>
              {/* The window is not a nicety. Almost nobody is sitting on
                  exactly day 30 on any given morning, and an employee
                  crosses it once — so an exact-day match would miss most
                  of a cohort and a missed sweep would lose a day's
                  intake for good. */}
              <p className="text-[11px] text-navy-600">
                Goes out to anyone who joined <b>{day}</b> to <b>{Number(day) + Number(win)}</b> days ago.
                This survey <b>stays open</b> and picks up each new joiner as they reach that point —
                you press Open once. The window is what stops anyone being missed whose exact day fell
                between two nightly checks.
              </p>
            </div>
          )}

          {opts && (
            <div className="grid sm:grid-cols-2 gap-3">
              <PickList label="Department" options={opts.departments}
                chosen={rule.departments} onChange={setRuleKey('departments')} />
              <PickList label="Designation" options={opts.designations}
                chosen={rule.designations} onChange={setRuleKey('designations')} />
              <PickList label="Role band" options={opts.role_bands}
                chosen={rule.role_bands} onChange={setRuleKey('role_bands')} />
              <PickList label="Reporting manager" options={opts.managers}
                chosen={rule.manager_ids} onChange={setRuleKey('manager_ids')} />
            </div>
          )}
          <p className="text-[10px] text-navy-400">
            Pick nothing in a box and it places no restriction. Choices inside one box are
            <b> any of</b>; across boxes they are <b>all of</b>. Every value is read off the
            employee master, so a rule cannot name a department nobody is in.
          </p>

          {/* The live count, from the same resolver the release uses —
              so what HR reads here and who the system writes to cannot
              disagree. */}
          {preview && !preview.error && (
            <div className="text-xs rounded-lg px-3 py-2 bg-navy-50 text-navy-700">
              Right now this reaches <b>{preview.count}</b> employee{preview.count === 1 ? '' : 's'} — {preview.description}.
              {preview.sample?.length > 0 && (
                <span className="text-navy-500"> e.g. {preview.sample.slice(0, 4).join(', ')}
                  {preview.count > 4 ? ` and ${preview.count - 4} more` : ''}.</span>
              )}
              {preview.kind === 'manager_about_reportee' && (
                <span className="block mt-1">
                  {preview.managers || 0} manager{preview.managers === 1 ? '' : 's'} would be asked,
                  one copy per person they are assessing.
                </span>
              )}
              {preview.no_manager > 0 && (
                <span className="block mt-1 text-amber-700">
                  {preview.no_manager} {preview.no_manager === 1 ? 'person has' : 'people have'} no
                  reporting manager on the master, so nobody can be asked about them.
                </span>
              )}
              {preview.manager_inactive > 0 && (
                <span className="block mt-1 text-amber-700">
                  {preview.manager_inactive} more {preview.manager_inactive === 1 ? 'has' : 'have'} a
                  manager who is no longer active.
                </span>
              )}
              {preview.no_joining_date > 0 && (
                <span className="block mt-1 text-amber-700">
                  {preview.no_joining_date} active employee{preview.no_joining_date === 1 ? ' has' : 's have'} no
                  date of joining on the master, so {preview.no_joining_date === 1 ? 'they cannot' : 'they cannot'} be
                  placed on a milestone and {preview.no_joining_date === 1 ? 'is' : 'are'} not included.
                </span>
              )}
              {preview.count === 0 && (
                <span className="block mt-1 text-rose-600">Nobody matches this today. Opening it would invite no one.</span>
              )}
            </div>
          )}
          {preview?.error && <p className="text-xs text-rose-600">{preview.error}</p>}

          {kind === 'self' && (
            <label className="flex items-center gap-2 text-xs text-navy-600">
              <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />
              Anonymous — answers are never stored against a name
            </label>
          )}
          {kind === 'self' && !anon && (
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded-md px-2 py-1.5">
              Attributed. Every answer is stored against the person who gave it, and the form tells
              them so before they start. Use this for new-hire and manager surveys where HR has to
              act on an individual; keep pulse and annual surveys anonymous.
            </p>
          )}
        </div>

        {err && <p className="text-xs text-rose-600">{err}</p>}
        <p className="text-[11px] text-navy-400">
          Created as a <b>draft</b> — nobody is invited until you press <b>Open</b> on it. Blank
          questions are dropped rather than saved empty.
        </p>
      </div>
    </AiModal>
  );
}

function TakeSurvey({ survey, done }) {
  const [qs, setQs] = useState(null);
  const [answers, setAnswers] = useState({});
  const [attribute, setAttribute] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { api(`/engagement/surveys/${survey.id}/questions`).then(r => setQs(r.questions)).catch(e => setErr(e.message)); }, [survey.id]);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!qs) return <p className="text-sm text-navy-400">Loading…</p>;
  const submit = async () => {
    setErr(null);
    try {
      await api(`/engagement/surveys/${survey.id}/respond`, { method: 'POST', body: JSON.stringify({
        answers, attribute,
        // Which reportee this is about. The server matches the
        // invitation on (survey, me, subject), so this is also what
        // stops a manager assessing somebody who is not theirs.
        ...(survey.subject_employee_id ? { subject_employee_id: survey.subject_employee_id } : {}),
      }) });
      done();
    }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <h2 className="text-lg font-bold">{survey.title}</h2>
      {survey.subject_name && (
        <p className="text-sm text-lagoon-800 bg-lagoon-50 border border-lagoon-200 rounded-lg p-2.5">
          You are assessing <b>{survey.subject_name}</b>
          {survey.subject_designation ? `, ${survey.subject_designation}` : ''}. Your answers are
          recorded against their name and yours — this is an assessment, not an anonymous survey.
        </p>
      )}
      {survey.anonymity_default && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">This survey is anonymous. Your name is never stored with your answers{survey.allow_attribution_optin ? ' unless you opt in below' : ''}.</p>}
      {qs.map(q => (
        <div key={q.id} className="card p-3">
          <p className="text-sm font-semibold mb-2">{q.prompt}{q.required && ' *'}</p>
          {q.qtype === 'text' && (
            <textarea className="inp" rows={3} onChange={e => setAnswers(a => ({ ...a, [q.id]: { text: e.target.value } }))} />
          )}
          {/* Pick one. Until 25 Sep a choice question fell through to
              the branch below and rendered as a 1-5 scale: the options
              HR wrote were never shown to anybody, and the results
              reported n=0 while the answers sat in the table. */}
          {q.qtype === 'choice' && (
            <div className="space-y-1.5">
              {(q.options || []).map((opt) => (
                <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name={`q-${q.id}`} value={opt}
                    checked={answers[q.id]?.text === opt}
                    onChange={() => setAnswers(a => ({ ...a, [q.id]: { text: opt } }))} />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          )}
          {/* Pick any that apply. */}
          {q.qtype === 'multi' && (
            <div className="space-y-1.5">
              {(q.options || []).map((opt) => {
                const picked = answers[q.id]?.list || [];
                return (
                  <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={picked.includes(opt)}
                      onChange={(e) => setAnswers(a => {
                        const cur = a[q.id]?.list || [];
                        const list = e.target.checked ? [...cur, opt] : cur.filter((x) => x !== opt);
                        return { ...a, [q.id]: { list } };
                      })} />
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>
          )}
          {!['text', 'choice', 'multi'].includes(q.qtype) && (
            <div className="flex gap-1.5 flex-wrap">
              {(q.qtype === 'enps' ? [...Array(11).keys()] : [1, 2, 3, 4, 5]).map(n => (
                <button key={n} onClick={() => setAnswers(a => ({ ...a, [q.id]: { num: n } }))}
                  className={`w-9 h-9 rounded-lg text-sm font-semibold border ${answers[q.id]?.num === n ? 'bg-navy-700 text-white border-navy-600' : 'bg-white border-navy-100 hover:bg-navy-50'}`}>{n}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      {survey.anonymity_default && survey.allow_attribution_optin && (
        <label className="flex items-center gap-2 text-xs text-navy-600">
          <input type="checkbox" checked={attribute} onChange={e => setAttribute(e.target.checked)} />
          Attach my name to my answers (optional)
        </label>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-pri" onClick={submit}>Submit</button>
        <button className="btn-sec" onClick={done}>Cancel</button>
      </div>
    </div>
  );
}
