import { useEffect, useState } from 'react';
import { Target, ClipboardList, TrendingUp, Star, Award, Clock } from 'lucide-react';
import { api } from '../utils/api';

export default function AnnualReviewPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/my/annual-review').then(setData).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active annual cycle.</div>;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">Annual Review</h2>
        <span className="chip bg-purple-100 text-purple-700">{data.cycle.name}</span>
        {data.super50?.flag && <span className="chip bg-amber-100 text-amber-700"><Award size={11} className="inline mr-1" />Super 50</span>}
      </div>
      <p className="text-xs text-navy-400">Consolidates your KRA outcomes, target achievement progress, and Aspiring Career status for the year — brings together what's already recorded elsewhere into one view.</p>

      <Section icon={Target} title="KRA Outcomes">
        {!data.kra.outcomes.length && <Empty text="No KRAs recorded for this cycle." />}
        {data.kra.outcomes.map(k => (
          <div key={k.id} className="border-b border-navy-100 last:border-0 py-2 text-xs">
            <p className="font-semibold">{k.title} <span className="text-navy-400 font-normal">({k.weight}%)</span></p>
            <div className="flex flex-wrap gap-4 mt-1">
              {/* Mid-year first — it is the earlier reading, and "3 at
                  mid-year, 5 now" is the shape of the year. Shown next to
                  the others, never blended into them. */}
              {k.midyear && (k.midyear.self || k.midyear.manager) && (
                <span className="text-navy-500">Mid-year: self <b>{k.midyear.self?.rating ?? '—'}</b> · manager <b>{k.midyear.manager?.rating ?? '—'}</b></span>
              )}
              <span>Self: <b>{k.self?.self_rating ?? '—'}</b> {k.self?.narrative && <span className="text-navy-500">— {k.self.narrative}</span>}</span>
              <span>Manager: <b>{k.manager?.rating ?? '—'}</b> {k.manager?.comment && <span className="text-navy-500">— {k.manager.comment}</span>}</span>
            </div>
          </div>
        ))}
      </Section>

      {data.midyear && (
        <Section icon={Clock} title="Mid-Year checkpoint">
          <p className="text-xs">
            Self <b>{data.midyear.self_overall ?? '—'}</b> ({data.midyear.self_status}) · Manager <b>{data.midyear.manager_overall ?? '—'}</b> ({data.midyear.manager_status})
          </p>
          <p className="text-[11px] text-navy-400 mt-1">
            The halfway reading, per KRA above. It is a reference point for the conversation, not an input to the final rating.
          </p>
        </Section>
      )}

      <Section icon={ClipboardList} title="Target achievements for the year — progress">
        {!data.development_plan.plan ? <Empty text="No target achievements set for this cycle." /> : (
          <>
            <p className="text-xs mb-2">Status: <span className="font-semibold">{data.development_plan.plan.status}</span> · Average progress: <span className="font-semibold">{data.development_plan.avg_progress}%</span></p>
            {data.development_plan.goals.map((g, i) => (
              <div key={i} className="text-xs py-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold flex-1">{g.title}</p>
                  {g.target_date && <span className="text-navy-400 shrink-0">Target: {new Date(g.target_date).toLocaleDateString()}</span>}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <div className="flex-1 h-1.5 bg-navy-100 rounded-full overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${g.progress_pct}%` }} /></div>
                  <span className="text-navy-400 w-8 text-right">{g.progress_pct}%</span>
                </div>
              </div>
            ))}
          </>
        )}
      </Section>

      <Section icon={TrendingUp} title="Aspiring Career">
        {!data.career_path ? <Empty text="No aspiring career set." /> : (
          <p className="text-xs"><b>Target:</b> {data.career_path.target_role}{data.career_path.plan && <> — {data.career_path.plan}</>}</p>
        )}
      </Section>

      {/* REMOVED — the 7-Parameter Weighted Rating block.
          It showed the MANAGER's per-parameter scores, live, to the person
          being scored: GET /my/annual-review has no publish gate, so from
          manager_eval onwards an employee could watch their own scoring
          appear, before calibration had a chance to adjust it. Everywhere
          else the employee waits for publish — My Rating reads
          employee_performance_history, which only has rows once HR
          publishes.
          It was also never asked for. This page exists for the BRD line
          quoted in buildAnnualReviewSummary — "consolidates KRA outcomes,
          development plan progress, and career path status" — and the
          parameters are not among those three; adding them was a judgement
          call of mine.
          The manager, HOD and HR still see the same scoring on Team
          Evaluation, where it is theirs to set. */}

      {data.rating_history.length > 0 && (
        <Section icon={Star} title="Rating History">
          {data.rating_history.map(h => (
            <div key={h.cycle_id} className="flex justify-between text-xs py-1 border-b border-navy-100 last:border-0">
              <span>{h.cycle_name} ({h.fiscal_year})</span>
              <span className="font-mono">{h.final_rating} · {h.rating_label}</span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ icon: Icon, title, children }) {
  return (
    <div className="card p-4">
      <p className="font-bold text-sm mb-2 flex items-center gap-1.5"><Icon size={14} className="text-navy-400" />{title}</p>
      {children}
    </div>
  );
}
function Empty({ text }) {
  return <p className="text-xs text-navy-400">{text}</p>;
}
