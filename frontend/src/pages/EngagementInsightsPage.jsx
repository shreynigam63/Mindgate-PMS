// New Hire Insights — phase 5, 25 Sep.
//
// Sections 22 to 25 of Mindgate's specification: the red-flag engine,
// the onboarding-failure dashboard, the 30/60/90 trend, and survey
// data read against PMS data.
//
// Section 24's own framing is the design brief: HR does not need
// "employee scored 82%". They need which dimension is weakest, which
// blocker keeps coming up, and whose name is on the red list this
// morning — each with an action and an owner attached, because a
// colour with nothing behind it is where most HR dashboards stop.
//
// NO LISTENING AGENT, excluded by Mindgate. Nothing here drafts or
// infers: every number is arithmetic over stored answers, and every
// flag can be traced to the rule and the threshold that produced it.
import { useEffect, useState } from 'react';
import { AlertTriangle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { api } from '../utils/api';
import PageHead from '../PageHead';

const DIM_LABEL = {
  onboarding: 'Onboarding', role_clarity: 'Role clarity', manager_support: 'Manager support',
  team_integration: 'Team integration', culture: 'Culture', productivity: 'Productivity readiness',
  training: 'Training', career: 'Career clarity', retention: 'Retention intent',
  recognition: 'Recognition', workload: 'Workload', capability: 'Capability',
  manager_assessment: 'Manager assessment',
};
const label = (d) => DIM_LABEL[d] || d;

// Under 50 is where a 1-5 answer of 3 or less sits, which is the point
// the rules themselves start firing. Kept in one place so the bar and
// the number can never disagree about what "poor" means.
const tone = (score) => (score == null ? 'bg-navy-200'
  : score < 50 ? 'bg-rose-500' : score < 70 ? 'bg-amber-400' : 'bg-leaf-500');

function Bar({ score }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 rounded-full bg-navy-50 overflow-hidden">
        <div className={`h-full rounded-full ${tone(score)}`} style={{ width: `${score ?? 0}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right tabular-nums text-navy-600">
        {score == null ? '—' : score.toFixed(0)}
      </span>
    </div>
  );
}

const Arrow = ({ dir }) => (dir === 'up' ? <TrendingUp size={13} className="text-leaf-600" />
  : dir === 'down' ? <TrendingDown size={13} className="text-rose-600" />
  : dir === 'flat' ? <Minus size={13} className="text-navy-300" /> : null);

export default function EngagementInsightsPage() {
  const [index, setIndex] = useState(null);
  const [flags, setFlags] = useState(null);
  const [outcomes, setOutcomes] = useState(null);
  const [err, setErr] = useState(null);
  const [person, setPerson] = useState(null);

  useEffect(() => {
    Promise.all([
      api('/engagement/insights/new-hire'),
      api('/engagement/insights/flags'),
      api('/engagement/insights/outcomes'),
    ]).then(([i, f, o]) => { setIndex(i); setFlags(f); setOutcomes(o); })
      .catch((e) => setErr(e.message));
  }, []);

  const openPerson = async (id) => {
    setPerson({ loading: true });
    try { setPerson(await api(`/engagement/insights/employee/${id}`)); }
    catch (e) { setPerson({ error: e.message }); }
  };

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!index || !flags) return <p className="text-sm text-navy-400">Reading the answers…</p>;

  const nobody = index.people === 0;
  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="New Hire Insights" hue="leaf"
        sub="What the lifecycle surveys are saying: who needs attention, which part of onboarding is weakest, and what happened next." />

      {/* Nothing to read is said once, plainly, rather than as a page
          of zeroes that looks like a catastrophe. */}
      {nobody && (
        <div className="card p-6 text-center text-sm text-navy-500">
          <p className="font-semibold">No lifecycle survey has been answered yet.</p>
          <p className="mt-1 text-[12px]">
            Release a Day 1, Week 1, 30, 60 or 90 survey from the library on Engagement Surveys.
            Everything on this page is built from those answers — nothing is estimated.
          </p>
        </div>
      )}

      {!nobody && (
        <>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="card p-4">
              <p className="lbl">New hire experience index</p>
              <p className="text-3xl font-bold mt-1">{index.overall ?? '—'}<span className="text-base text-navy-300">/100</span></p>
              <p className="text-[11px] text-navy-400 mt-1">
                the mean of the dimensions below, across {index.people} {index.people === 1 ? 'person' : 'people'} who answered
              </p>
            </div>
            <div className="card p-4">
              <p className="lbl">Needs HR now</p>
              <p className="text-3xl font-bold mt-1 text-rose-600">{flags.counts.red}</p>
              <p className="text-[11px] text-navy-400 mt-1">red flags, from {flags.rules} rules you can edit</p>
            </div>
            <div className="card p-4">
              <p className="lbl">Needs a manager</p>
              <p className="text-3xl font-bold mt-1 text-amber-600">{flags.counts.amber}</p>
              <p className="text-[11px] text-navy-400 mt-1">amber — follow-up, not intervention</p>
            </div>
          </div>

          <div className="card p-4">
            <p className="lbl">Where onboarding is weakest</p>
            <p className="text-[11px] text-navy-400 mb-2">
              Weakest first, because this list is to act on. Each is the mean of every answer
              tagged to that dimension, put on one 0–100 scale so a 1–5 and a 0–10 question can
              be read together.
            </p>
            <div className="space-y-1.5">
              {index.dimensions.map((d) => (
                <div key={d.dimension} className="flex items-center gap-3 text-[11.5px]">
                  <span className="w-40 shrink-0 text-navy-600">{label(d.dimension)}</span>
                  <Bar score={d.score} />
                  <span className="w-16 shrink-0 text-navy-400">{d.n} answer{d.n === 1 ? '' : 's'}</span>
                </div>
              ))}
            </div>
          </div>

          {index.blockers.length > 0 && (
            <div className="card p-4">
              <p className="lbl">What people said is blocking them</p>
              <p className="text-[11px] text-navy-400 mb-2">
                Counted from the blocker question, biggest first. This is the half of the page that
                says what to fix. &ldquo;No significant blocker&rdquo; is not counted — it would be
                the top answer every time and mean nothing.
              </p>
              <div className="space-y-1.5">
                {index.blockers.map((b) => (
                  <div key={b.blocker} className="flex items-center gap-3 text-[11.5px]">
                    <span className="w-52 shrink-0 text-navy-600">{b.blocker}</span>
                    <div className="flex-1 h-2 rounded-full bg-navy-50 overflow-hidden">
                      <div className="h-full rounded-full bg-lagoon-500" style={{ width: `${b.pct}%` }} />
                    </div>
                    <span className="w-20 shrink-0 text-right text-navy-500 tabular-nums">{b.count} · {b.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* THE RED/AMBER LIST. Section 22, with section 20's chain
          attached: each flag names the action, the owner and the
          follow-up, so it can be handed to somebody. */}
      <div className="card p-4">
        <p className="lbl">Who needs attention</p>
        {!flags.people.length && (
          <p className="text-[12px] text-navy-400 mt-1">
            Nobody is flagged. Everyone who answered is inside every threshold.
          </p>
        )}
        <div className="space-y-2 mt-1">
          {flags.people.map((p) => (
            <details key={p.employee_id} className="card p-3">
              <summary className="cursor-pointer text-sm font-semibold flex flex-wrap items-center gap-2">
                <span className={`chip ${p.severity === 'red' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                  <AlertTriangle size={11} className="inline mr-1" />{p.severity}
                </span>
                {p.name}
                {p.designation && <span className="text-navy-400 font-normal">· {p.designation}</span>}
                {p.manager && <span className="text-[11px] text-navy-400 font-normal">manager: {p.manager}</span>}
                <span className="text-[11px] text-navy-400 font-normal">
                  {p.flags.length} issue{p.flags.length === 1 ? '' : 's'}
                  {p.raised > p.flags.length && ` · ${p.raised} answers`}
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                {/* One row per RULE. Before grouping, somebody who rated
                    seven role-clarity questions at 1 produced seven
                    identical rows with the same action — fifty-one for
                    one person, which is the noise this page exists to
                    cut through. */}
                {p.flags.map((f, n) => (
                  <div key={n} className="text-[11.5px] border-l-2 pl-2 border-navy-100">
                    <p className="font-semibold text-navy-700">
                      {f.label}
                      {f.count > 1 && <span className="chip bg-navy-50 text-navy-500 ml-1.5">×{f.count}</span>}
                    </p>
                    <p className="text-navy-600">
                      <b>Do:</b> {f.action} &nbsp;·&nbsp; <b>Owner:</b> {f.owner} &nbsp;·&nbsp;
                      <b>Follow up in:</b> {f.follow_up_days} days
                    </p>
                    <ul className="text-navy-400 mt-0.5">
                      {f.examples.map((x, i) => (
                        <li key={i}>answered {String(x.value)} to &ldquo;{x.prompt}&rdquo;</li>
                      ))}
                      {f.count > f.examples.length && <li>…and {f.count - f.examples.length} more like it</li>}
                    </ul>
                  </div>
                ))}
                <button className="btn-sec !py-1 !text-[11px]" onClick={() => openPerson(p.employee_id)}>
                  See their 30/60/90 trend
                </button>
              </div>
            </details>
          ))}
        </div>
      </div>

      {/* ONE PERSON'S TREND. Section 23: "much more useful to HR than
          simply saying employee scored 82%." */}
      {person && (
        <div className="card p-4">
          {person.loading && <p className="text-sm text-navy-400">Loading…</p>}
          {person.error && <p className="text-sm text-rose-600">{person.error}</p>}
          {person.employee && (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <p className="text-sm font-bold flex-1">{person.employee.name} — across their milestones</p>
                <button className="btn-sec !py-1 !text-[11px]" onClick={() => setPerson(null)}>close</button>
              </div>
              {!person.points.length && <p className="text-[12px] text-navy-400">They have not answered anything yet.</p>}
              {person.points.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="text-[11.5px] w-full">
                    <thead>
                      <tr className="text-navy-400 text-left">
                        <th className="py-1 pr-3 font-medium">Dimension</th>
                        {person.points.map((pt, i) => (
                          <th key={i} className="py-1 px-2 font-medium whitespace-nowrap">{pt.label}</th>
                        ))}
                        <th className="py-1 pl-2 font-medium">Trend</th>
                      </tr>
                    </thead>
                    <tbody>
                      {person.rows.map((r) => (
                        <tr key={r.dimension} className="border-t border-navy-50">
                          <td className="py-1 pr-3 text-navy-600">{label(r.dimension)}</td>
                          {r.series.map((v, i) => (
                            <td key={i} className="py-1 px-2 tabular-nums">
                              {v == null ? <span className="text-navy-300">not asked</span> : v.toFixed(0)}
                            </td>
                          ))}
                          <td className="py-1 pl-2"><Arrow dir={r.direction} /></td>
                        </tr>
                      ))}
                      <tr className="border-t border-navy-100 font-semibold">
                        <td className="py-1 pr-3">Overall</td>
                        {person.points.map((pt, i) => (
                          <td key={i} className="py-1 px-2 tabular-nums">{pt.overall == null ? '—' : pt.overall.toFixed(0)}</td>
                        ))}
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* SECTION 25: survey data against PMS data. */}
      {outcomes && (
        <div className="card p-4">
          <p className="lbl">What happened next</p>
          <p className="text-[11px] text-navy-400 mb-2">
            Everyone who answered a lifecycle survey, banded by their own score, against what the
            employee master says about them now. Counts rather than a correlation coefficient:
            with a few dozen people a coefficient invites a confidence nobody has earned, while
            &ldquo;of the {outcomes.bands?.[0]?.n ?? 0} who scored low, {outcomes.bands?.[0]?.left ?? 0} have
            left&rdquo; is a sentence you can check against the names.
          </p>
          <table className="text-[11.5px] w-full">
            <thead>
              <tr className="text-navy-400 text-left">
                <th className="py-1 pr-3 font-medium">Band</th>
                <th className="py-1 px-2 font-medium">People</th>
                <th className="py-1 px-2 font-medium">Since left</th>
                <th className="py-1 px-2 font-medium">Attrition</th>
                <th className="py-1 pl-2 font-medium">Appraisal ratings</th>
              </tr>
            </thead>
            <tbody>
              {(outcomes.bands || []).map((b) => (
                <tr key={b.key} className="border-t border-navy-50">
                  <td className="py-1 pr-3 text-navy-600">{b.label}</td>
                  <td className="py-1 px-2 tabular-nums">{b.n}</td>
                  <td className="py-1 px-2 tabular-nums">{b.left}</td>
                  <td className="py-1 px-2 tabular-nums">{b.attrition_pct == null ? <span className="text-navy-300">no data</span> : `${b.attrition_pct}%`}</td>
                  <td className="py-1 pl-2">
                    {Object.keys(b.ratings || {}).length
                      ? Object.entries(b.ratings).map(([k, v]) => `${k}: ${v}`).join(', ')
                      : <span className="text-navy-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* The honest version of an empty column. */}
          {!outcomes.has_ratings && (
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded-md px-2.5 py-1.5 mt-2">
              <b>No appraisal ratings on file yet</b>, so the performance half of this cannot be
              computed — that column is empty because the data does not exist, not because there is
              no relationship. Attrition is real and shown. Run an appraisal cycle, or load prior-year
              ratings, and the rest fills in.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
