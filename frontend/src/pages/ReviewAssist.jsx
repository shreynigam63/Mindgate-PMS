import { api, KraBullets } from '../utils/api';
import AiDraftPanel from './AiDraftPanel';

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
// "there is nothing to read yet", which is actionable. They are in the
// popup AND in the one-line summary on the page, because that count is the
// bit worth seeing without opening anything.
//
// This is the longest answer of any panel in the app — three lists per
// KRA — which is why it opens over the page rather than down it.
export default function ReviewAssist({ stage, label }) {
  const counts = (out) => out && out.evidence_counts;

  return (
    <AiDraftPanel
      accent="sky"
      title="✦ AI assist — what your own record shows"
      description={`Reads your 1-on-1 connects, your target achievements for the year and any Aspiring Career progress, then lays out achievements, blockers and gaps against each KRA — so you write your ${label} from evidence rather than from memory.`}
      idleLabel="Analyse my record"
      busyLabel="Reading your record…"
      againLabel="Refresh"
      modalTitle="What your own record shows"
      run={() => api('/agentic/review-assist', { method: 'POST', body: JSON.stringify({ stage }) })}
      summary={(out) => {
        const c = counts(out);
        if (!c) return 'Evidence ready';
        return `${c.kras} KRA${c.kras === 1 ? '' : 's'} · ${c.connects} connect${c.connects === 1 ? '' : 's'} · ${c.goals} target achievement${c.goals === 1 ? '' : 's'} read`;
      }}
    >
      {(out) => {
        const c = counts(out);
        const d = out.draft || {};
        return (
          <div className="space-y-3">
            <p className="text-navy-400">
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
              <p className="text-amber-700">Nothing on record for: {d.sources_missing.join(' · ')}</p>
            )}
          </div>
        );
      }}
    </AiDraftPanel>
  );
}
