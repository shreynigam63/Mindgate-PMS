import { useEffect, useState } from 'react';
import { Target, Award, ChevronRight } from 'lucide-react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import Grade from '../grade';

export default function AnnualReviewPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/my/annual-review').then(setData).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active annual cycle.</div>;

  // Every rating on this page is read off the cycle's own scale. Read
  // once here rather than at each <Grade>, so a new one added below
  // cannot quietly fall back to the default ladder.
  const scale = data.cycle.rating_scale;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Final Rating" hue="teal">
        <span className="chip bg-purple-100 text-purple-700">{data.cycle.name}</span>
        {data.super50?.flag && <span className="chip bg-amber-100 text-amber-700"><Award size={11} className="inline mr-1" />Super 50</span>}
      </PageHead>
      <p className="text-xs text-navy-400">
        Your final rating is the annual review, taken through each step in turn: your own rating, then your
        manager's, the HOD's, and HR's calibration. The last one recorded is the rating that is published.
      </p>
      {/* Said once, at the top, rather than only beside each blank. The
          manager's number is not final until the HOD review and
          calibration have been through it, and seeing a draft you later
          "lose" is worse than waiting. */}
      {data.manager_ratings_withheld && (
        <p className="text-xs bg-navy-50 text-navy-600 rounded-lg p-2">
          <b>Your manager's, HOD's and HR's ratings are not shown yet.</b> They can still change until HR
          publishes the cycle; everything appears here, and on <b>My Rating</b>, once it is published.
        </p>
      )}

      <RatingChain chain={data.rating_chain} scale={scale} />

      <Section icon={Target} title="Annual review — by KRA">
        {!data.kra.outcomes.length && <Empty text="No KRAs recorded for this cycle." />}
        {data.kra.outcomes.map(k => (
          <div key={k.id} className="border-b border-navy-100 last:border-0 py-2 text-xs">
            <p className="font-semibold">{k.title} <span className="text-navy-400 font-normal">({Number(k.weight)}%)</span></p>
            {k.measures && <p className="text-navy-400">KPI: {k.measures}</p>}
            <div className="flex flex-wrap gap-4 mt-1">
              <span>Self: <b><Grade value={k.self?.self_rating} scale={scale} /></b> {k.self?.narrative && <span className="text-navy-500">— {k.self.narrative}</span>}</span>
              {/* Withheld, not missing. An em-dash with no explanation
                  reads as "your manager has not rated this yet", which is
                  a different and usually untrue statement. */}
              {data.manager_ratings_withheld
                ? <span className="text-navy-400">Manager: <i>not shared until published</i></span>
                : <span>Manager: <b><Grade value={k.manager?.rating} scale={scale} /></b> {k.manager?.comment && <span className="text-navy-500">— {k.manager.comment}</span>}</span>}
            </div>
          </div>
        ))}
      </Section>

      {/* REMOVED on 7 Oct — Mid-Year checkpoint, Target achievements and
          Aspiring Career: "Final rating will consist only of annual review
          rating followed by Manager, HOD and HR." They are still on their
          own pages (Mid-Year Review, My Growth); they were never inputs to
          the rating, and on this page they read as if they were.
          The 7-Parameter Weighted Rating was removed earlier, for showing
          the manager's live scoring before publish. Rating History lives
          on Past Cycles. */}
    </div>
  );
}

const STEP_STATUS = { submitted: 'submitted', in_progress: 'in progress', pending: 'pending', not_started: 'not started' };

// The four steps, left to right, then the result. Each shows what that
// person recorded; nothing is averaged between them.
function RatingChain({ chain, scale }) {
  if (!chain) return null;
  const steps = [
    { key: 'self', label: 'Annual review (you)', step: chain.self },
    { key: 'manager', label: 'Manager', step: chain.manager },
    { key: 'hod', label: 'HOD', step: chain.hod },
    { key: 'hr', label: 'HR (calibration)', step: chain.hr },
  ];
  const cell = ({ key, step }) => {
    if (!step) return <span className="text-navy-300">—</span>;
    if (step.withheld) return <i className="text-navy-400">not shared until published</i>;
    if (key === 'hr') {
      return step.adjusted
        ? <><b className="text-base"><Grade value={step.rating} scale={scale} /></b>{step.reason && <span className="block text-[11px] text-navy-500">{step.reason}</span>}</>
        : <span className="text-navy-500">No change</span>;
    }
    return step.rating != null
      ? <b className="text-base"><Grade value={step.rating} scale={scale} /></b>
      : <span className="text-navy-400">{STEP_STATUS[step.status] || step.status || 'pending'}</span>;
  };
  return (
    <div className="card p-4">
      <p className="font-bold text-sm mb-3 flex items-center gap-1.5"><Award size={14} className="text-navy-400" />Final Rating</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-stretch">
        {steps.map((s, i) => (
          <div key={s.key} className="relative bg-navy-50 rounded-xl p-3 text-xs">
            <p className="text-[10px] uppercase font-bold text-navy-400">{i + 1}. {s.label}</p>
            <div className="mt-1">{cell(s)}</div>
            {s.key === 'hod' && s.step && !s.step.withheld && s.step.comment && (
              <p className="text-[11px] text-navy-500 mt-1">{s.step.comment}</p>
            )}
            {i < steps.length - 1 && <ChevronRight size={14} className="hidden sm:block absolute -right-2.5 top-1/2 -translate-y-1/2 text-navy-300" />}
          </div>
        ))}
        <div className="rounded-xl p-3 text-xs bg-teal-50 border border-teal-100">
          <p className="text-[10px] uppercase font-bold text-teal-700">Final</p>
          <div className="mt-1">
            {chain.final?.withheld
              ? <i className="text-navy-400">after publish</i>
              : chain.final?.rating != null
                ? <><b className="text-lg"><Grade value={chain.final.rating} scale={scale} /></b>
                    <span className="block text-[11px] text-navy-500">{chain.final.published ? `published${chain.final.label ? ` · ${chain.final.label}` : ''}` : 'not yet published'}</span></>
                : <span className="text-navy-400">pending</span>}
          </div>
        </div>
      </div>
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
