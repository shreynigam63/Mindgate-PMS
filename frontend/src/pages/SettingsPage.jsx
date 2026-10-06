import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import EmailSettings from '../EmailSettings';

// HR Admin → Settings.
//
// core.admin_settings has existed since migration 001 and has had no
// screen — one key was set by hand and read by the mail code. This page is
// that missing screen, starting with the setting the KRA Library needs.
//
// Each setting says what it changes and what happens to existing data,
// because a switch that silently alters what 1,400 people see is not
// self-explanatory from its name.
const COPY = {
  kra_library_scope: {
    title: 'KRA Library scope',
    blurb: 'Which shelf of suggested KRAs an employee is offered when they open the picker on My KRAs.',
    options: {
      designation: {
        label: 'By designation',
        detail: 'One shelf per job title, company-wide. Everyone holding a title sees the same KRAs.',
      },
      'department+designation': {
        label: 'By department + designation',
        detail: 'An employee sees the shelf published for their own department and title. If none exists, they fall back to the company-wide shelf for that title — so nothing has to be re-uploaded.',
      },
    },
  },
  // Super 50, split into its three parts so each can be argued with
  // separately. Asked for on 24 Sep: "ratings will be derived from last
  // three annual reviews and ratings should be A or A+ with current
  // year ratings as A+" — which is the default of all three below.
  super50_window: {
    title: 'Super 50 — how many annual reviews count',
    blurb: 'The rule looks at this many of the most recent annual reviews. Somebody with fewer on record is "not enough history" rather than a fail, and is listed separately on the Super 50 page.',
    options: {
      2: { label: '2 years', detail: 'A shorter window. More people qualify, and a single strong year counts for more.' },
      3: { label: '3 years', detail: 'The rule as asked for — a sustained run rather than one good year.' },
      4: { label: '4 years' }, 5: { label: '5 years' },
    },
  },
  super50_min_grade: {
    title: 'Super 50 — lowest grade allowed in the window',
    blurb: 'Every review inside the window must be at least this grade. One year below it takes somebody off the list.',
    options: {
      'A+': { label: 'A+', detail: 'Only an unbroken run of the top grade.' },
      A: { label: 'A', detail: 'A or A+ throughout — the rule as asked for.' },
      'B+': { label: 'B+' }, B: { label: 'B' }, C: { label: 'C', detail: 'No floor in practice.' },
    },
  },
  super50_latest_grade: {
    title: 'Super 50 — grade required this year',
    blurb: 'The most recent annual review must be exactly this grade. This is what makes the list current standing rather than a past reputation.',
    options: {
      'A+': { label: 'A+', detail: 'The rule as asked for.' },
      A: { label: 'A' }, 'B+': { label: 'B+' }, B: { label: 'B' }, C: { label: 'C' },
    },
  },
};


// THE CONNECT FORM'S QUESTIONS, edited here.
//
// Asked for: "Make the quarterly connect/discussion forms fully editable
// for HR admins to update questions." The wording used to live in
// ConnectsPage.jsx, so rewording a 1:1 form meant a release — the exact
// thing the house rule about labels in tables exists to prevent.
//
// What is editable is the QUESTION, not the storage: each row writes to a
// column that already exists on the connect record. Switching one off
// removes the box from the form. Adding a sixth needs somewhere to put
// its answer, so that stays a change to the product — the page says so
// rather than leaving somebody hunting for an Add button.
function ConnectQuestions() {
  const [qs, setQs] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => api('/pms/connects/questions')
    .then((r) => setQs(r.questions || [])).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const edit = (key, patch) => setQs((p) => p.map((q) => (q.key === key ? { ...q, ...patch } : q)));
  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api('/pms/connects/questions', { method: 'PUT', body: JSON.stringify({ questions: qs }) });
      setQs(r.questions); setMsg('Saved. Every connect form uses this wording from now on.');
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (!qs) return null;
  return (
    <div className="card p-4 space-y-3">
      <p className="lbl mb-0">Quarterly connect form</p>
      <p className="text-[11.5px] text-navy-400">
        The questions managers answer when they log a connect. Reword them, reorder them, or switch
        one off. A new box would need somewhere to store its answer, so that is a product change
        rather than a setting.
      </p>
      <div className="space-y-2">
        {qs.map((q) => (
          <div key={q.key} className={`rounded-xl border p-3 space-y-2 ${q.active ? 'border-navy-100' : 'border-navy-100 bg-navy-50/60'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip bg-navy-50 text-navy-500">{q.key}</span>
              <input className="inp !text-xs flex-1 !w-auto" value={q.label}
                onChange={(e) => edit(q.key, { label: e.target.value })} placeholder="The question" />
              <label className="text-[11px] text-navy-500 flex items-center gap-1">
                <input type="checkbox" checked={q.active !== false}
                  onChange={(e) => edit(q.key, { active: e.target.checked })} />
                on the form
              </label>
            </div>
            <input className="inp !text-[11px]" value={q.hint || ''}
              onChange={(e) => edit(q.key, { hint: e.target.value })}
              placeholder="The grey hint under it (optional)" />
          </div>
        ))}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {msg && <p className="text-xs text-leaf-600">{msg}</p>}
      <button className="btn-pri" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save questions'}</button>
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);

  const load = () => api('/pms/hr/settings').then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const set = async (key, value) => {
    setErr(null);
    try {
      await api(`/pms/hr/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });
      setSaved(key);
      setTimeout(() => setSaved(null), 2500);
      load();
    } catch (e) { setErr(e.message); }
  };

  if (err) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className="card p-4"><p className="text-sm text-navy-400">Loading…</p></div>;

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHead title="Settings" hue="navy"
        sub={<>
        Tenant-wide configuration. Changes take effect immediately for everyone.
        </>} />

      <EmailSettings />

      <ConnectQuestions />

      {Object.entries(data.settings).map(([key, s]) => {
        const copy = COPY[key] || { title: key, blurb: '', options: {} };
        return (
          <div key={key} className="card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <p className="font-bold text-sm flex-1">{copy.title}</p>
              {saved === key && (
                <span className="chip bg-emerald-100 text-emerald-700">
                  <Check size={11} className="inline mr-1" />Saved
                </span>
              )}
            </div>
            {copy.blurb && <p className="text-xs text-navy-500">{copy.blurb}</p>}
            <div className="space-y-2">
              {s.values.map((v) => {
                const o = copy.options[v] || { label: v, detail: '' };
                const on = s.value === v;
                return (
                  <button key={v} onClick={() => set(key, v)}
                    className={`w-full text-left rounded-xl border p-3 transition ${on
                      ? 'border-navy-500 bg-navy-50'
                      : 'border-navy-100 bg-white hover:border-navy-200'}`}>
                    <span className="flex items-center gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-[3px] shrink-0 ${on
                        ? 'border-navy-600 bg-white' : 'border-navy-200 bg-white'}`} />
                      <span className="font-semibold text-sm">{o.label}</span>
                      {v === s.default && <span className="chip bg-navy-50 text-navy-500">default</span>}
                    </span>
                    {o.detail && <span className="block text-[11px] text-navy-500 mt-1 pl-5.5">{o.detail}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
