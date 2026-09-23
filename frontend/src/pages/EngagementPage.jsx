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
            <div key={i.id} className="p-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold flex-1">{i.title}</span>
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
          {open.length} still open. Your answers go to HR in aggregate.
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
        {data.admin && <button className="btn-pri" onClick={() => setBuilding(true)}>
          <Plus size={13} className="inline mr-1" />New survey</button>}
      </PageHead>
      {building && <SurveyBuilder onClose={() => setBuilding(false)}
        onCreated={() => { setBuilding(false); load(); }} />}

      <div className="card divide-y divide-navy-100">
        {data.surveys.map(s => (
          <div key={s.id} className="p-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold flex-1">{s.title}</span>
            <span className={`chip ${s.status === 'open' ? 'bg-emerald-100 text-emerald-700' : 'bg-navy-50 text-navy-600'}`}>{s.status}</span>
            <span className="text-xs text-navy-400">{s.completed}/{s.invited} completed</span>
            {data.admin && s.status === 'draft' && <button className="btn-sec" onClick={() => openSurvey(s)}><Play size={12} className="inline mr-1" />Open</button>}
            {data.admin && s.status === 'open' && <button className="btn-sec" onClick={async () => { await api(`/engagement/surveys/${s.id}/close`, { method: 'POST' }); load(); }}><Square size={12} className="inline mr-1" />Close</button>}
            {data.admin && <button className="btn-sec" onClick={() => viewResults(s)}>Results</button>}
          </div>
        ))}
        {!data.surveys.length && <p className="p-6 text-center text-sm text-navy-400">No surveys yet.</p>}
      </div>

      {results && (
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold flex-1">{results.survey.title} — results</p>
            <span className="chip bg-navy-50 text-navy-600">participation {results.participation.rate}%</span>
            <button className="btn-sec" disabled={busy} onClick={() => askThemes(results.survey.id)}>
              <Sparkles size={13} className="inline mr-1 text-amber-500" />{busy ? 'Theming…' : 'Theme verbatims (agent)'}</button>
          </div>
          {results.questions.map(q => (
            <div key={q.id} className="text-xs border-t border-navy-100 pt-2">
              <p className="font-semibold">{q.prompt}</p>
              {q.qtype === 'text'
                ? <p className="text-navy-500">{(q.verbatims || []).length} text answers (themed via the agent — individual verbatims stay in the data)</p>
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
  { v: 'scale', label: '1–5 scale',  hint: 'Rated one to five. The default, and what the averages are built from.' },
  { v: 'enps',  label: 'eNPS 0–10',  hint: 'The "how likely are you to recommend" question. Scored as eNPS.' },
  { v: 'text',  label: 'Open text',  hint: 'Free text. Read as themes by the agent; individual answers stay in the data.' },
];

function SurveyBuilder({ onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [qs, setQs] = useState([{ qtype: 'scale', prompt: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const set = (i, k, v) => setQs((rows) => rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (i, d) => setQs((rows) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return rows;
    const out = [...rows];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  });

  const filled = qs.filter((q) => q.prompt.trim());
  const save = async () => {
    setErr(null);
    if (!title.trim()) { setErr('Give the survey a title.'); return; }
    if (!filled.length) { setErr('A survey needs at least one question.'); return; }
    setBusy(true);
    try {
      await api('/engagement/surveys', { method: 'POST', body: JSON.stringify({
        title: title.trim(),
        questions: filled.map((q) => ({
          qtype: q.qtype, prompt: q.prompt.trim(),
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
          </div>
        ))}

        <button className="btn-sec" onClick={() => setQs((rows) => [...rows, { qtype: 'scale', prompt: '' }])}>
          <Plus size={13} className="inline mr-1" />Add question
        </button>

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
    try { await api(`/engagement/surveys/${survey.id}/respond`, { method: 'POST', body: JSON.stringify({ answers, attribute }) }); done(); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <h2 className="text-lg font-bold">{survey.title}</h2>
      {survey.anonymity_default && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">This survey is anonymous. Your name is never stored with your answers{survey.allow_attribution_optin ? ' unless you opt in below' : ''}.</p>}
      {qs.map(q => (
        <div key={q.id} className="card p-3">
          <p className="text-sm font-semibold mb-2">{q.prompt}{q.required && ' *'}</p>
          {q.qtype === 'text'
            ? <textarea className="inp" rows={3} onChange={e => setAnswers(a => ({ ...a, [q.id]: { text: e.target.value } }))} />
            : (
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
