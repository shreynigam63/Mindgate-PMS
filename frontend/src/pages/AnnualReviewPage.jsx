import { useEffect, useState } from 'react';
import { Target, ClipboardList, TrendingUp, Star, Award } from 'lucide-react';
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
            <div className="flex gap-4 mt-1">
              <span>Self: <b>{k.self?.self_rating ?? '—'}</b> {k.self?.narrative && <span className="text-navy-500">— {k.self.narrative}</span>}</span>
              <span>Manager: <b>{k.manager?.rating ?? '—'}</b> {k.manager?.comment && <span className="text-navy-500">— {k.manager.comment}</span>}</span>
            </div>
          </div>
        ))}
      </Section>

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

      <Section icon={Star} title="7-Parameter Weighted Rating">
        <div className="grid sm:grid-cols-2 gap-1.5 text-xs mb-2">
          {data.parameter_scores.parameters.map(p => (
            <div key={p.id} className="flex justify-between bg-navy-50 rounded px-2 py-1">
              <span>{p.name} <span className="text-navy-400">({p.weight_pct}%)</span></span>
              <span className="font-mono">{data.parameter_scores.scores[p.id] ?? '—'}</span>
            </div>
          ))}
        </div>
        <p className="text-sm">
          <span className="font-semibold">Weighted overall: </span>
          <span className={data.parameter_scores.complete ? 'text-emerald-700 font-bold' : 'text-navy-400'}>{data.parameter_scores.weighted_rating ?? '—'}</span>
          {!data.parameter_scores.complete && <span className="text-[11px] text-navy-400"> (manager scoring in progress)</span>}
        </p>
      </Section>

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
