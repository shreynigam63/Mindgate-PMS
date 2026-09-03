import { useEffect, useState } from 'react';
import { Plus, Sparkles, Play, Square } from 'lucide-react';
import { api } from '../utils/api';
import { AiModal } from './AiDraftPanel';

export default function EngagementPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [taking, setTaking] = useState(null);
  const [results, setResults] = useState(null);
  const [themes, setThemes] = useState(null);
  const [themesOpen, setThemesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => Promise.all([api('/engagement/surveys'), api('/engagement/my/invitations')])
    .then(([s, i]) => setData({ ...s, invitations: i.invitations })).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (taking) return <TakeSurvey survey={taking} done={() => { setTaking(null); load(); }} />;

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
  const createSurvey = async () => {
    const title = prompt('Survey title'); if (!title) return;
    const qs = [];
    let q; while ((q = prompt(`Question ${qs.length + 1} (blank to finish). Prefix "enps:" for the eNPS question, "text:" for open text.`))) {
      if (q.startsWith('enps:')) qs.push({ qtype: 'enps', prompt: q.slice(5).trim() });
      else if (q.startsWith('text:')) qs.push({ qtype: 'text', prompt: q.slice(5).trim(), required: false });
      else qs.push({ qtype: 'scale', prompt: q.trim() });
    }
    if (!qs.length) return alert('A survey needs at least one question.');
    try { await api('/engagement/surveys', { method: 'POST', body: JSON.stringify({ title, questions: qs }) }); load(); }
    catch (e) { alert(e.message); }
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Engagement</h2>
        {data.admin && <button className="btn-pri" onClick={createSurvey}><Plus size={13} className="inline mr-1" />New survey</button>}
      </div>

      {data.invitations.length > 0 && (
        <div className="card p-4">
          <p className="lbl">Your open surveys</p>
          {data.invitations.map(i => (
            <div key={i.id} className="flex items-center justify-between py-1.5">
              <span className="text-sm">{i.title} <span className="chip bg-navy-50 text-navy-500 ml-1">{i.survey_type}</span>
                {i.anonymity_default && <span className="chip bg-emerald-100 text-emerald-700 ml-1">anonymous</span>}</span>
              {i.completed_at ? <span className="text-xs text-emerald-600">completed ✓</span>
                : <button className="btn-pri" onClick={() => setTaking(i)}>Take</button>}
            </div>
          ))}
        </div>
      )}

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
