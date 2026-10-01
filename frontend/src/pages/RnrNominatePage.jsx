import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import { Award, AlertTriangle, Users, Check, Info } from 'lucide-react';

// Raising an RnR nomination.
//
// THE ONE UX RULE THE BRIEF IS EMPHATIC ABOUT: "do not show the entire
// employee population and ask the manager to manually determine
// eligibility." So the award comes first and the count comes with it —
// "Rising Star · 18 eligible" — and choosing one lists only the people
// who qualify.
//
// The people who DO NOT qualify are listed too, underneath, each with the
// reason. That is not decoration: a manager who expected somebody to be
// on the list and cannot see them will go and ask HR, which is the manual
// process this replaces. The reason has to be on the screen where the
// question is asked.

const money = (p) => (p == null ? null : `₹${(Number(p) / 100).toLocaleString('en-IN')}`);

export default function RnrNominatePage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [award, setAward] = useState(null);
  const [list, setList] = useState(null);
  const [picked, setPicked] = useState(null);
  const [form, setForm] = useState({ achievement: '', business_impact: '', justification: '', comments: '' });
  const [team, setTeam] = useState({ team_name: '', team_members: '', project: '', quantified_impact: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [showBlocked, setShowBlocked] = useState(false);

  useEffect(() => { api('/people/rnr/nominate/options').then(setD).catch((e) => setErr(e.message)); }, []);

  const pickAward = async (a) => {
    setAward(a); setList(null); setPicked(null); setDone(null); setErr(null);
    if (a.is_team) return;
    try {
      setList(await api(`/people/rnr/nominate/eligible?cycle_id=${d.cycle.id}&award_id=${a.id}`));
    } catch (e) { setErr(e.message); }
  };

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api('/people/rnr/nominations', { method: 'POST', body: JSON.stringify({
        cycle_id: d.cycle.id, award_id: award.id,
        employee_id: picked ? picked.employee.id : null, ...form, ...(award.is_team ? team : {}),
      }) });
      setDone(r); setPicked(null);
      setForm({ achievement: '', business_impact: '', justification: '', comments: '' });
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (err && !d) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  if (!d.cycle) return (
    <div className="space-y-3 max-w-4xl mx-auto">
      <PageHead title="Nominate for an award" hue="amber" sub="Rewards & Recognition." />
      <div className="card p-8 text-center text-sm text-navy-500">
        No RnR cycle is open. HR opens one on <b>RnR Administration</b>, which is also what fixes the
        award quota for the cycle.
      </div>
    </div>
  );

  return (
    <div className="space-y-3 max-w-5xl mx-auto">
      <PageHead title="Nominate for an award" hue="amber"
        sub={<>{d.cycle.name} · nominations close {String(d.cycle.nominations_close).slice(0, 10)}</>} />

      {done && (
        <div className="card p-3 text-xs border-l-4 border-leaf-500">
          Submitted. It is now <b>{done.status_label}</b>. You will be told when it moves.
        </div>
      )}

      {/* STEP 1 — the award, with how many people it can actually reach. */}
      <div className="card p-4 space-y-2">
        <p className="lbl mb-0">1 · Which award?</p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {d.options.map((a) => (
            <button key={a.id} onClick={() => pickAward(a)}
              className={`text-left rounded-xl border p-3 transition ${award && award.id === a.id
                ? 'border-amber-500 bg-amber-50' : 'border-navy-100 bg-white hover:border-navy-200'}`}>
              <span className="flex items-center gap-1.5">
                <Award size={13} className="text-amber-600 shrink-0" />
                <span className="font-semibold text-sm">{a.name}</span>
              </span>
              <span className="block text-[10.5px] text-navy-400 mt-0.5">{a.level} level</span>
              {a.is_team
                ? <span className="chip bg-navy-50 text-navy-500 mt-1.5">a team, not one person</span>
                : <span className={`chip mt-1.5 ${a.eligible_count ? 'bg-leaf-50 text-leaf-600' : 'bg-navy-50 text-navy-400'}`}>
                    {a.eligible_count} eligible
                  </span>}
              {a.criteria && <span className="block text-[10.5px] text-navy-500 mt-1.5">{a.criteria}</span>}
            </button>
          ))}
        </div>
        {!d.options.length && <p className="text-xs text-navy-400">No awards are configured for a {d.cycle.kind} cycle.</p>}
      </div>

      {/* STEP 2 — only the people who qualify. */}
      {award && !award.is_team && list && (
        <div className="card p-4 space-y-2">
          <p className="lbl mb-0">2 · Who, of the {list.eligible.length} eligible</p>
          {!list.eligible.length && (
            <p className="text-xs text-navy-500">
              Nobody on your team qualifies for {award.name}. The reasons are below — most often it is
              a band or an experience figure the HRMS import has not filled in yet.
            </p>
          )}
          <div className="grid sm:grid-cols-2 gap-2">
            {list.eligible.map((x) => (
              <button key={x.employee.id} onClick={() => setPicked(x)}
                className={`text-left rounded-xl border p-3 text-xs transition ${picked && picked.employee.id === x.employee.id
                  ? 'border-amber-500 bg-amber-50' : 'border-navy-100 bg-white hover:border-navy-200'}`}>
                <span className="font-semibold text-sm block">{x.employee.name}</span>
                <span className="text-navy-400">{x.employee.designation || '—'} · {x.employee.department || '—'}</span>
                <span className="block mt-1 text-navy-500">
                  Band {x.facts.band} · {x.facts.total_experience_years ?? '—'} yrs experience ·
                  {' '}{Math.floor((x.facts.tenure_months || 0) / 12)}y {(x.facts.tenure_months || 0) % 12}m here
                </span>
              </button>
            ))}
          </div>

          {/* The ones who do not qualify, and why — on the same screen. */}
          {list.blocked.length > 0 && (
            <div className="pt-1">
              <button className="text-[11px] text-navy-500 underline" onClick={() => setShowBlocked((v) => !v)}>
                {showBlocked ? 'Hide' : 'Show'} the {list.blocked.length} who do not qualify, and why
              </button>
              {showBlocked && (
                <div className="mt-2 space-y-1.5">
                  {list.blocked.map((x) => (
                    <div key={x.employee.id} className="rounded-lg bg-navy-50 px-3 py-2 text-[11px]">
                      <b className="text-navy-700">{x.employee.name}</b>
                      <ul className="list-disc pl-4 text-navy-500 mt-0.5">
                        {x.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* STEP 3 — the case for it. */}
      {award && (picked || award.is_team) && (
        <div className="card p-4 space-y-3">
          <p className="lbl mb-0">
            3 · The case for {award.is_team ? 'this team' : picked.employee.name}
          </p>
          {award.is_team && (
            <div className="grid sm:grid-cols-2 gap-3">
              {[['team_name', 'Team name'], ['project', 'Project'], ['team_members', 'Team members'],
                ['quantified_impact', 'Quantified impact — cost, revenue or productivity']].map(([k, label]) => (
                <div key={k}>
                  <label className="text-[11.5px] text-navy-500 block mb-1">{label}</label>
                  <input className="inp" value={team[k]} onChange={(e) => setTeam((p) => ({ ...p, [k]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
          {[['achievement', 'What did they achieve?'],
            ['business_impact', 'What was the business impact?'],
            ['justification', 'Why this award, for this person? *'],
            ['comments', 'Anything else the approvers should know']].map(([k, label]) => (
            <div key={k}>
              <label className="text-[11.5px] text-navy-500 block mb-1">{label}</label>
              <textarea className="inp" rows={2} value={form[k]}
                onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
          <p className="text-[11px] text-navy-400 flex items-start gap-1">
            <Info size={11} className="mt-0.5 shrink-0" />
            It goes to the HOD, then the HRBP, then HR. Each of them decides on the
            justification, so it is worth writing.
          </p>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <button className="btn-pri" disabled={busy} onClick={submit}>
            <Check size={13} className="inline mr-1" />{busy ? 'Submitting…' : 'Submit nomination'}
          </button>
        </div>
      )}

      {err && !award && <p className="text-xs text-rose-600">{err}</p>}
      <p className="text-[11px] text-navy-400 flex items-center gap-1">
        <Users size={11} />Eligibility is worked out from the employee master — date of joining, band,
        experience and status. Nobody can change it on this screen.
      </p>
    </div>
  );
}
