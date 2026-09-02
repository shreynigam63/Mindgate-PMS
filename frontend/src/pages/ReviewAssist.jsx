import { useState } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import { api, DraftBadge, KraBullets } from '../utils/api';

// "AI assist" for a review the EMPLOYEE is about to write — the mid-year
// review and the annual self-appraisal both use this one component,
// because the request was the same for both and two copies would drift.
//
// It is not a draft of the review. It is the EVIDENCE: what the one-on-one
// connects, the year's target achievements and the Aspiring Career plan
// already say, laid out per KRA as achievements, blockers and gaps. The
// draft button (separate, next to it) writes prose; this fills in what
// the prose should be about.
//
// The evidence counts are shown deliberately. When the answer is thin it
// is almost always because the record is thin — two connects logged and no
// goal progress marked — and saying so turns "the AI is useless" into
// "there is nothing to read yet", which is actionable.
export default function ReviewAssist({ stage, label }) {
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setOut(await api('/agentic/review-assist', { method: 'POST', body: JSON.stringify({ stage }) })); }
    catch (e) { setErr(e.message); setOut(null); }
    setBusy(false);
  };

  const c = out && out.evidence_counts;
  const d = (out && out.draft) || null;

  return (
    <div className="space-y-2">
      <div className="bg-gradient-to-r from-teal-50 to-sky-50 border border-teal-100 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-teal-700">✦ AI assist — what your own record shows</p>
          <p className="text-[11px] text-navy-500">
            Reads your 1-on-1 connects, your target achievements for the year and any Aspiring Career progress,
            then lays out achievements, blockers and gaps against each KRA — so you write your {label} from
            evidence rather than from memory.
          </p>
        </div>
        <button className="btn-pri !bg-teal-700" disabled={busy} onClick={run}>
          {out ? <RefreshCw size={13} className="inline mr-1" /> : <Sparkles size={13} className="inline mr-1" />}
          {busy ? 'Reading your record…' : out ? 'Refresh' : 'Analyse my record'}
        </button>
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}

      {out && (
        <div className="bg-navy-800 text-slate-100 rounded-lg p-3 text-xs space-y-2">
          <DraftBadge />
          <p className="text-navy-300">
            Read {c.kras} KRA{c.kras === 1 ? '' : 's'} · {c.connects} connect{c.connects === 1 ? '' : 's'} ·{' '}
            {c.goals} target achievement{c.goals === 1 ? '' : 's'} ({c.goals_achieved} complete) ·{' '}
            Aspiring Career {c.aspiring_career_set ? 'set' : 'not set'}
          </p>
          <KraBullets byKra={d.by_kra} crossCutting={d.cross_cutting}
            sections={[['achievements', 'Achievements'], ['blockers', 'Blockers'], ['gaps', 'Gaps']]} />
          {(d.career_progress || []).length > 0 && (
            <div><p className="font-semibold">Towards your aspired role</p>
              <ul className="list-disc pl-4">{d.career_progress.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
          )}
          {(d.sources_missing || []).length > 0 && (
            <p className="text-amber-300">Nothing on record for: {d.sources_missing.join(' · ')}</p>
          )}
        </div>
      )}
    </div>
  );
}
