import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, CheckCircle2, Clock, Sparkles } from 'lucide-react';
import { api, Bullets } from '../utils/api';
import { AiModal } from './AiDraftPanel';
import MeetingPanel from './MeetingPanel';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import MomTab from './MomTab';
import LongText, { Req } from '../LongText';

// Two tabs on one page (14 Oct): the connects log as it was, and the MoM
// tab — daily connects, their minutes and action items (MomTab.jsx). The
// tab is in the address (?tab=mom) so a notification can open it.
export default function ConnectsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'mom' ? 'mom' : 'connects';
  const pick = (k) => setParams(k === 'mom' ? { tab: 'mom' } : {});
  const tabs = (
    <div className="tabbar">
      {[['connects', 'Connects'], ['mom', 'MoM']].map(([k, label]) => (
        <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => pick(k)}>{label}</button>
      ))}
    </div>
  );
  return tab === 'mom' ? <MomTab tabs={tabs} /> : <ConnectsLog tabs={tabs} />;
}

// SELF → CONNECTS (15 Oct): your own connects, and the ones others had
// with you to sign off. Your reports' connects are on Team Connects, in the
// Manager tab.
// Everything a connect row shows can be searched for (16 Oct, Def-021:
// the HR person, who logged it and the date found nothing): names, the
// date as shown and as written in other ways, and the sign-off state.
function searchable(cn, me) {
  const d = cn.held_at ? new Date(cn.held_at) : null;
  const dates = d && !Number.isNaN(d.getTime()) ? [
    d.toLocaleDateString(), d.toISOString().slice(0, 10),
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
    d.toLocaleDateString('en-GB'),
  ] : [];
  const loggedBy = !cn.logged_by_id ? null
    : cn.logged_by_id === cn.employee_id ? cn.employee_name
      : cn.logged_by_id === cn.manager_id ? cn.manager_name
        : cn.logged_by_id === cn.hr_id ? cn.hr_name : null;
  return [cn.employee_name, cn.manager_name, cn.hr_name, cn.hr_name && 'hr', loggedBy, me && cn.logged_by_id === me.id && 'you',
    cn.topic, cn.notes, cn.discussion_notes, cn.achievements, cn.blockers, cn.feedback,
    ...(cn.linked_kras || []).map((k) => k.title), ...dates,
    cn.signed_off ? 'signed off' : 'pending sign-off'];
}

function ConnectsLog({ tabs }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [me, setMe] = useState(null);
  const load = () => api('/pms/connects?view=self').then(r => setData(r.connects)).catch(e => setErr(e.message));
  useEffect(() => {
    load();
    api('/me').then(r => setMe(r.user)).catch(() => setMe(null));
  }, []);

  if (err || !data) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto">
        {tabs}
        {err ? <p className="text-sm text-rose-600">{err}</p> : <p className="text-sm text-navy-400">Loading…</p>}
      </div>
    );
  }

  // Waiting on YOU: connects others had with you that you have not signed off.
  const pendingCount = data.filter(cn => cn.can_sign_off).length;
  const shown = (data || []).filter((cn) => matches(q, ...searchable(cn, me)));
  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <PageHead title="Connects" hue="azure">
        {pendingCount > 0 && <span className="chip bg-amber-100 text-amber-700">{pendingCount} awaiting your sign-off</span>}
        <button className="btn-pri" onClick={() => setShowNew(v => !v)}><Plus size={13} className="inline mr-1" />Log a connect</button>
      </PageHead>
      {tabs}
      {showNew && <NewConnectForm me={me} mode="self" onSaved={() => { setShowNew(false); load(); }} />}
      {me && data.some((cn) => cn.employee_id === me.id) && <TrainingPanel employeeId={me.id} label="Training ideas from my connects" />}
      {!data.length && <div className="card p-8 text-center text-sm text-navy-400">No connects logged yet.</div>}
      <SearchBox value={q} onChange={setQ} placeholder="Search by person, HR, topic, notes or date…"
        shown={shown.length} total={data.length} />
      <div className="space-y-2">
        {shown.map(cn => <ConnectRow key={cn.id} cn={cn} me={me} reload={load} />)}
      </div>
    </div>
  );
}

// TEAM CONNECTS (15 Oct) — in the Manager, HOD, HRBP and HR tabs. The
// connects of the people that tab looks after (the server's team-scope.js):
// a manager's direct reports, a Delivery Head's whole reporting line, an
// HRBP's remit, everyone for HR. Managers log a connect with a report here.
const SCOPE_SUB = {
  manager: 'Connects of your direct reports',
  hod: 'Connects of everyone reporting to you, through their managers',
  hrbp: 'Connects of the employees in your remit',
  hr: 'Connects across the company',
};
// The MoM tab sits here too for managers (their team's daily connects) and
// HR (every team's, with Team settings and the daily report) — 15 Oct.
const MOM_SCOPES = ['manager', 'hr'];
export function TeamConnectsPage({ scope = 'manager' }) {
  const [params, setParams] = useSearchParams();
  const withMom = MOM_SCOPES.includes(scope);
  const tab = withMom && params.get('tab') === 'mom' ? 'mom' : 'connects';
  const tabs = withMom ? (
    <div className="tabbar">
      {[['connects', 'Connects'], ['mom', 'MoM']].map(([k, label]) => (
        <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setParams(k === 'mom' ? { tab: 'mom' } : {})}>{label}</button>
      ))}
    </div>
  ) : null;
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [me, setMe] = useState(null);
  const [person, setPerson] = useState('');
  const [teamInfo, setTeamInfo] = useState(null);
  const load = () => api(`/pms/connects?view=team&scope=${scope}`).then(r => { setData(r.connects); setTeamInfo(r.team || null); }).catch(e => setErr(e.message));
  useEffect(() => {
    setData(null); setErr(null); setPerson('');
    load();
    api('/me').then(r => setMe(r.user)).catch(() => setMe(null));
  }, [scope]);

  if (tab === 'mom') return <MomTab tabs={tabs} title="Team Connects" hue="lagoon" />;
  if (err || !data) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto">
        {tabs}
        {err ? <p className="text-sm text-rose-600">{err}</p> : <p className="text-sm text-navy-400">Loading…</p>}
      </div>
    );
  }

  // Everyone in the team, connects or not; for HR's company-wide page, the
  // people who have connects (a list of the whole company is no filter).
  const withConnects = new Set(data.map((cn) => cn.employee_id));
  const people = (teamInfo && !teamInfo.all ? teamInfo.people.map((p) => [p.id, p.name])
    : [...new Map(data.map((cn) => [cn.employee_id, cn.employee_name])).entries()]).sort((a, b) => a[1].localeCompare(b[1]));
  const teamSize = teamInfo ? teamInfo.size : people.length;
  // A connect with someone in the team (15 Oct): a manager with a report,
  // a Delivery Head with anyone on their reporting line, HR with anyone.
  const canLog = ['manager', 'hod', 'hr'].includes(scope) && (scope === 'hr' || teamSize > 0);
  const pendingCount = data.filter(cn => cn.can_sign_off).length;
  const shown = data.filter((cn) => (!person || cn.employee_id === person)
    && matches(q, ...searchable(cn, me)));
  const personName = person ? (people.find(([id]) => id === person) || [])[1] : null;
  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <PageHead title="Team Connects" hue="lagoon" sub={SCOPE_SUB[scope]}>
        {pendingCount > 0 && <span className="chip bg-amber-100 text-amber-700">{pendingCount} awaiting your sign-off</span>}
        {canLog && (
          <button className="btn-pri" onClick={() => setShowNew(v => !v)}><Plus size={13} className="inline mr-1" />Log a connect</button>
        )}
      </PageHead>
      {tabs}
      {showNew && <NewConnectForm me={me} mode="team" anyone={scope === 'hr'} team={teamInfo && !teamInfo.all ? teamInfo.people : null}
        onSaved={() => { setShowNew(false); load(); }} />}
      <div className="flex flex-wrap items-center gap-2">
        <label className="lbl mb-0">Person</label>
        <select className="inp w-auto" value={person} onChange={(e) => setPerson(e.target.value)} disabled={!people.length}>
          <option value="">{teamInfo && teamInfo.all ? `Everyone — ${teamSize} employees` : `Everyone in your team (${teamSize})`}</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}{withConnects.has(id) ? '' : ' — no connects yet'}</option>)}
        </select>
      </div>
      {person && withConnects.has(person) && <TrainingPanel key={person} employeeId={person} label={`Training suggestions for ${personName}`} />}
      {!person && data.length > 0 && <p className="text-[11px] text-navy-400">Pick a person for AI training suggestions from their connects.</p>}
      {teamInfo && teamInfo.empty_reason ? (
        <div className="card p-8 text-center text-sm text-navy-500">{teamInfo.empty_reason}</div>
      ) : person && !withConnects.has(person) ? (
        <div className="card p-8 text-center text-sm text-navy-400">No connects logged for {personName} yet.</div>
      ) : !data.length && (
        <div className="card p-8 text-center text-sm text-navy-400">
          {teamSize ? `None of the ${teamSize} ${teamSize === 1 ? 'person' : 'people'} in your team has a connect logged yet.` : 'No connects logged for your team yet.'}
        </div>
      )}
      <SearchBox value={q} onChange={setQ} placeholder="Search by person, HR, topic, notes or date…" shown={shown.length} total={data.length} />
      <div className="space-y-2">
        {shown.map(cn => <ConnectRow key={cn.id} cn={cn} me={me} reload={load} anyMeeting={scope === 'hr'} />)}
      </div>
    </div>
  );
}

// AI training suggestions from one person's connects (15 Oct).
const TRAINING_TYPE = { course: 'Course', certification: 'Certification', workshop: 'Workshop', mentoring: 'Mentoring', on_the_job: 'On the job' };
const PRIORITY_CHIP = { high: 'bg-rose-100 text-rose-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-navy-50 text-navy-600' };
function TrainingPanel({ employeeId, label }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ask = async () => {
    setBusy(true); setErr(null);
    try { setD(await api('/pms/connects/training-suggestions', { method: 'POST', body: JSON.stringify({ employee_id: employeeId }) })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="card p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-navy-800 flex-1">{label}</p>
        <button className="btn-sec" disabled={busy} onClick={ask}>
          <Sparkles size={12} className="inline mr-1 text-amber-500" />{busy ? 'Thinking…' : d ? 'Refresh' : 'Suggest training'}
        </button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {d && (
        <div className="space-y-2">
          <span className="chip bg-amber-100 text-amber-700">AI DRAFT — from {d.connects_used} connect{d.connects_used === 1 ? '' : 's'}; discuss before acting on it</span>
          {d.themes.length > 0 && <p className="text-xs text-navy-500">Needs seen: {d.themes.join(' · ')}</p>}
          {!d.trainings.length && <p className="text-xs text-navy-400">The connects show no training need yet.</p>}
          {d.trainings.map((t, i) => (
            <div key={i} className="border border-navy-50 rounded-xl px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-navy-800 flex-1 min-w-[10rem]">{t.title}</span>
                <span className="chip bg-violet-50 text-violet-700">{TRAINING_TYPE[t.type] || t.type}</span>
                <span className={`chip ${PRIORITY_CHIP[t.priority]}`}>{t.priority}</span>
              </div>
              {t.why && <p className="text-xs text-navy-600 mt-0.5">{t.why}</p>}
              {t.from.length > 0 && <p className="text-[11px] text-navy-400">From the connects of {t.from.join(', ')}</p>}
            </div>
          ))}
          {d.notes.length > 0 && <p className="text-[11px] text-navy-400">{d.notes.join(' · ')}</p>}
        </div>
      )}
    </div>
  );
}

function NewConnectForm({ me, team, mode = 'self', anyone = false, onSaved }) {
  const [employeeId, setEmployeeId] = useState('');
  const [heldAt, setHeldAt] = useState(new Date().toISOString().slice(0, 10));
  const [durationMin, setDurationMin] = useState('30');
  const [topic, setTopic] = useState('');
  const [discussionNotes, setDiscussionNotes] = useState('');
  // Achievements/Blockers/Feedback are no longer typed (15 Oct: "should be
  // categorized automatically based on topic and what was discussed and no
  // manual intervention needed"): the AI sorts the discussion after save.
  // The wording comes from HR, not from this file. Asked for: "Make the
  // quarterly connect/discussion forms fully editable for HR admins to
  // update questions." Falls back to the shipped wording if the fetch
  // fails — a form with no labels is worse than a form with the old ones.
  const [questions, setQuestions] = useState(null);
  useEffect(() => {
    api('/pms/connects/questions').then((r) => setQuestions(r.questions || [])).catch(() => setQuestions([]));
  }, []);
  const ask = (key, fallbackLabel, fallbackHint) => {
    const q = (questions || []).find((x) => x.key === key);
    if (q && q.active === false) return null;
    return { label: q ? q.label : fallbackLabel, hint: q ? (q.hint || '') : fallbackHint };
  };
  const [kraOptions, setKraOptions] = useState([]);
  const [kraIds, setKraIds] = useState([]);
  // "Connect Cadence / Progress this cycle / Next due" header, per the
  // reference screenshot — meaningful once an employee is picked, since
  // it's cadence tracking FOR that specific report. Calculated from the
  // Date field entered per connect (held_at) — see connect-reminders.js's
  // computeCadenceProgress.
  const [cadence, setCadence] = useState(null);
  const [err, setErr] = useState(null);
  // CONNECT WITH ANYONE (7 Oct): "connects can be with anyone so allow all
  // employees to select option to connect with anyone with option as 'do
  // you need HR as part of this connect'". Your own connect names who it
  // was with — your manager by default, anyone in the company if not.
  // They sign it off. The HR question is asked on every connect.
  const [people, setPeople] = useState(null);
  const [withId, setWithId] = useState('');
  const [needHr, setNeedHr] = useState(null);
  const [hrId, setHrId] = useState('');
  useEffect(() => {
    api('/pms/connects/people').then((r) => {
      setPeople(r);
      setWithId((v) => v || r.my_manager_id || '');
      setHrId((v) => v || r.suggested_hr_id || '');
    }).catch(() => setPeople({ people: [], hr: [] }));
  }, []);

  // Previously "Select report" only ever listed direct reports (from
  // GET /team/evaluations, itself pms_team_eval-gated) — an employee with
  // no reports of their own saw an empty dropdown and could never
  // actually select anyone, hence "Employee and date required" with no
  // way to fix it. "Myself" is now always the first option, so anyone can
  // log their own 1-on-1; direct reports (if any) follow. With no reports
  // at all, self is selected automatically rather than making someone
  // choose from a list of one.
  useEffect(() => {
    if (!me) return;
    if (mode === 'self') setEmployeeId(me.id);
  }, [me, mode]);

  useEffect(() => {
    setKraIds([]); setCadence(null);
    if (!employeeId) { setKraOptions([]); return; }
    api(`/pms/connects/kra-options/${employeeId}`).then(r => setKraOptions(r.kras || [])).catch(() => setKraOptions([]));
    api(`/pms/connects/cadence/${employeeId}`).then(setCadence).catch(() => setCadence(null));
  }, [employeeId]);

  const toggleKra = (id) => setKraIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

  const save = async () => {
    setErr(null);
    if (!employeeId || !heldAt) { setErr('Employee and date are required.'); return; }
    if (!discussionNotes.trim()) { setErr('Write what was discussed — the AI sorts it into achievements, blockers and feedback.'); return; }
    const isSelf = me && employeeId === me.id;
    if (isSelf && !withId) { setErr('Pick who the connect was with.'); return; }
    if (needHr === null) { setErr('Answer "Do you need HR as part of this connect?"'); return; }
    if (needHr && !hrId) { setErr('Pick who from HR should be part of it.'); return; }
    try {
      await api('/pms/connects', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: employeeId, held_at: heldAt, duration_min: durationMin || null, topic, discussion_notes: discussionNotes,
          kra_ids: kraIds,
          ...(isSelf ? { with_id: withId } : {}),
          include_hr: !!needHr, ...(needHr ? { hr_id: hrId } : {}),
        }),
      });
      onSaved();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="grid sm:grid-cols-3 gap-2">
        <div>
          <label className="lbl">{mode === 'self' ? 'Whose connect' : 'Team member'}</label>
          {mode === 'self' ? (
            <p className="inp bg-navy-50 text-navy-500">Myself{me ? ` (${me.name})` : ''}</p>
          ) : (
            <PersonPicker value={employeeId} onChange={setEmployeeId}
              people={anyone ? ((people && people.people) || []) : (team || []).map((t) => ({ id: t.id || t.employee_id, name: t.name, designation: t.designation, department: t.department }))} />
          )}
        </div>
        <div>
          <label className="lbl">Date<Req /></label>
          <input className="inp" type="date" value={heldAt} onChange={e => setHeldAt(e.target.value)} />
        </div>
        <div>
          <label className="lbl">Duration (min)</label>
          <input className="inp" type="number" min="0" step="5" value={durationMin} onChange={e => setDurationMin(e.target.value)} />
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        <div>
          <label className="lbl">Connect with</label>
          {me && employeeId === me.id ? (
            <PersonPicker people={(people && people.people) || []} value={withId} onChange={setWithId}
              hint={people && withId && withId === people.my_manager_id ? 'your manager' : null} />
          ) : (
            <p className="inp bg-navy-50 text-navy-500">{employeeId ? `You (${me ? me.name : ''})` : '—'}</p>
          )}
          <p className="text-[11px] text-navy-400 mt-0.5">Anyone in the company. They sign the connect off.</p>
        </div>
        <div>
          <label className="lbl">Do you need HR as part of this connect?</label>
          <div className="flex gap-1.5">
            {[[true, 'Yes'], [false, 'No']].map(([v, label]) => (
              <button key={label} type="button" onClick={() => setNeedHr(v)}
                className={`chip px-3 py-1.5 ${needHr === v ? 'bg-navy-700 text-white' : 'bg-white text-navy-600 border border-navy-100'}`}>{label}</button>
            ))}
          </div>
          {needHr && (
            <select className="inp mt-1.5" value={hrId} onChange={(e) => setHrId(e.target.value)}>
              <option value="">Select HR…</option>
              {((people && people.hr) || []).map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · {h.designation || (h.role === 'hrbp' ? 'HRBP' : 'HR')}{h.id === people.suggested_hr_id ? ' — suggested' : ''}
                </option>
              ))}
            </select>
          )}
          {needHr && people && !(people.hr || []).length && (
            <p className="text-[11px] text-amber-700 mt-1">Nobody is in HR yet — no one holds an HR role or has an HR department or designation in the employee master.</p>
          )}
        </div>
      </div>
      {ask('topic', 'Topic', 'e.g. Mid-quarter check-in') && (
        <div>
          <label className="lbl">{ask('topic', 'Topic', '').label} (optional)</label>
          <input maxLength={150} className="inp" value={topic} onChange={e => setTopic(e.target.value)}
            placeholder={ask('topic', 'Topic', 'e.g. Mid-quarter check-in').hint} />
        </div>
      )}
      {employeeId && cadence && (
        <div className="grid sm:grid-cols-3 gap-2 bg-navy-50 rounded-xl p-3 text-xs">
          <div>
            <p className="lbl mb-0.5">Connect Cadence</p>
            <p className="font-semibold text-navy-700">Quarterly</p>
            <p className="text-navy-400">Every {cadence.cadence_days} days · {cadence.expected_total} expected this cycle</p>
          </div>
          <div>
            <p className="lbl mb-0.5">Progress this cycle</p>
            {/* Fixed: "X of Y expected so far" read as broken ("3 of 1
                expected so far") whenever someone was AHEAD of pace, since
                that phrasing only reads naturally when logged <= expected.
                The underlying numbers were always correct — this was a
                display-only gap. Recast as a 3-way status instead of the
                previous on-track/behind binary, since "on track" was
                understating being significantly ahead. */}
            {(() => {
              const { logged_count: logged, expected_so_far: expected } = cadence;
              const status = logged > expected ? 'ahead' : logged === expected ? 'on_track' : 'behind';
              const color = status === 'behind' ? 'text-amber-700' : 'text-emerald-700';
              const label = status === 'ahead' ? 'Ahead of pace' : status === 'on_track' ? 'On track' : 'Behind';
              return (
                <>
                  <p className={`font-semibold ${color}`}>{logged} logged · {expected} expected by now</p>
                  <p className="text-navy-400">{label}</p>
                </>
              );
            })()}
          </div>
          <div>
            <p className="lbl mb-0.5">Next due</p>
            <p className="font-semibold text-navy-700">{new Date(cadence.next_due).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}</p>
          </div>
        </div>
      )}
      {employeeId && kraOptions.length > 0 && (
        <div>
          <label className="lbl">Link to KRA(s)</label>
          <div className="flex flex-wrap gap-1.5">
            {kraOptions.map(k => (
              <button key={k.id} type="button"
                className={`chip ${kraIds.includes(k.id) ? 'bg-brand-500 text-white' : 'bg-navy-50 text-navy-600'}`}
                onClick={() => toggleKra(k.id)}>{k.title}</button>
            ))}
          </div>
        </div>
      )}
      <div>
        <label className="lbl">What was discussed?</label>
        <LongText className="inp" rows={6} placeholder="Everything that came up — what went well, what is stuck, the feedback given"
          value={discussionNotes} onChange={e => setDiscussionNotes(e.target.value)} />
        <p className="text-[11px] text-navy-400 mt-0.5"><Sparkles size={11} className="inline mr-1 text-violet-500" />After you save, AI sorts this into Achievements, Blockers and Feedback — nothing to fill in by hand.</p>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <button className="btn-pri" onClick={save}>Save connect</button>
    </div>
  );
}

function ConnectRow({ cn, me, reload, anyMeeting = false }) {
  const [insight, setInsight] = useState(null);
  const [insightOpen, setInsightOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Requested with a reference screenshot: "AI auto-tag KRAs" — suggests
  // which of the employee's KRAs this connect relates to, from its own
  // achievements/blockers/feedback/discussion text, instead of only ever
  // picking KRAs manually at creation time (the only way this worked
  // before). Never auto-saves — shows a suggestion the manager reviews
  // and applies, same "draft, human decides" pattern as every other AI
  // feature here.
  const [tagging, setTagging] = useState(false);
  const [editingKras, setEditingKras] = useState(false);
  const [kraOptions, setKraOptions] = useState(null);
  const [selectedKraIds, setSelectedKraIds] = useState([]);
  const [tagReasoning, setTagReasoning] = useState(null);

  const signOff = async () => {
    setErr(null);
    try { await api(`/pms/connects/${cn.id}/sign-off`, { method: 'POST' }); reload(); }
    catch (e) { setErr(e.message); }
  };
  // The AI sorts the discussion just after the save; look again until done.
  const sorting = cn.ai_status === 'pending' || cn.ai_status === 'working';
  useEffect(() => { if (!sorting) return undefined; const h = setTimeout(reload, 4000); return () => clearTimeout(h); }, [sorting, cn.id]);
  const [resorting, setResorting] = useState(false);
  const resort = async () => {
    setResorting(true); setErr(null);
    try { await api(`/pms/connects/${cn.id}/categorise`, { method: 'POST' }); } catch (e) { setErr(e.message); }
    setResorting(false); reload();
  };
  const askInsights = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/agentic/connect-insights', { method: 'POST', body: JSON.stringify({ employee_id: cn.employee_id }) }); setInsight(r); setInsightOpen(true); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const startEditingKras = async () => {
    setErr(null); setEditingKras(true); setTagReasoning(null);
    setSelectedKraIds((cn.kra_ids || []).slice());
    if (!kraOptions) {
      try { const r = await api(`/pms/connects/kra-options/${cn.employee_id}`); setKraOptions(r.kras || []); }
      catch (e) { setErr(e.message); }
    }
  };
  const autoTag = async () => {
    setTagging(true); setErr(null);
    try {
      const r = await api('/agentic/connect-autotag', { method: 'POST', body: JSON.stringify({ connect_id: cn.id }) });
      if (!kraOptions) setKraOptions(r.kras);
      setSelectedKraIds(r.suggested_kra_ids);
      setTagReasoning(r.reasoning);
      setEditingKras(true);
    } catch (e) { setErr(e.message); }
    setTagging(false);
  };
  const toggleSelectedKra = (id) => setSelectedKraIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const saveKras = async () => {
    setErr(null);
    try { await api(`/pms/connects/${cn.id}`, { method: 'PUT', body: JSON.stringify({ kra_ids: selectedKraIds }) }); setEditingKras(false); reload(); }
    catch (e) { setErr(e.message); }
  };

  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{cn.employee_name} <span className="text-navy-400 font-normal">with {cn.manager_name}</span></p>
          <p className="text-xs text-navy-400">
            {new Date(cn.held_at).toLocaleDateString()}
            {cn.duration_min != null && ` · ${cn.duration_min} min`}
            {cn.topic && ` · ${cn.topic}`}
            {cn.hr_name && ` · HR: ${cn.hr_name}`}
            {me && cn.logged_by_id && ` · logged by ${cn.logged_by_id === me.id ? 'you' : (cn.logged_by_id === cn.employee_id ? cn.employee_name : cn.manager_name)}`}
          </p>
        </div>
        <span className={`chip flex items-center gap-1 ${cn.signed_off ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
          {cn.signed_off ? <CheckCircle2 size={12} /> : <Clock size={12} />}{cn.signed_off ? 'Signed off' : 'Pending sign-off'}
        </span>
      </div>
      {cn.discussion_notes && <p className="text-xs text-navy-500 italic">"{cn.discussion_notes}"</p>}
      {sorting && <p className="text-[11px] text-violet-600"><Sparkles size={11} className="inline mr-1" />Sorting into achievements, blockers and feedback…</p>}
      {cn.ai_status === 'failed' && (
        <p className="text-[11px] text-rose-600">{cn.ai_error || 'The AI could not sort this connect.'}{' '}
          {(!me || me.id === cn.manager_id || me.id === cn.employee_id) && <button type="button" className="underline" disabled={resorting} onClick={resort}>{resorting ? 'Trying…' : 'Try again'}</button>}
        </p>
      )}
      <div className="grid sm:grid-cols-3 gap-2 text-xs text-navy-600">
        {[['Achievements', cn.achievements, 'text-emerald-700'], ['Blockers', cn.blockers, 'text-amber-700'], ['Feedback', cn.feedback, 'text-blue-700']]
          .filter(([, v]) => v).map(([label, v, hue]) => (
            <div key={label}><b className={hue}>{label}</b><p className="whitespace-pre-line">{v}</p></div>
          ))}
      </div>
      {cn.ai_status === 'done' && <span className="chip bg-violet-50 text-violet-700 self-start">Sorted by AI from the discussion</span>}
      {!cn.achievements && !cn.blockers && !cn.feedback && cn.notes && <p className="text-xs text-navy-600">{cn.notes}</p>}
      <div className="border-t border-navy-100 pt-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold text-navy-400 uppercase tracking-wide">
            Linked KRAs {!editingKras && !(cn.linked_kras || []).length && <span className="normal-case font-normal italic text-navy-300">— no KRAs linked</span>}
          </p>
          {/* Widened per a direct follow-up: an employee can now auto-tag
              and edit KRA links on a connect that's about THEM, not just
              the manager — Sign off below stays manager-only on purpose,
              that's specifically the manager's approval step. */}
          {!cn.signed_off && (!me || me.id === cn.manager_id || me.id === cn.employee_id) && !editingKras && (
            <button className="chip bg-violet-50 text-violet-700 flex items-center gap-1" disabled={tagging} onClick={autoTag}>
              <Sparkles size={11} />{tagging ? 'Thinking…' : 'AI auto-tag KRAs'}
            </button>
          )}
        </div>
        {!editingKras && (cn.linked_kras || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {cn.linked_kras.map(k => <span key={k.id} className="chip bg-navy-50 text-navy-600">{k.title}</span>)}
            {!cn.signed_off && (!me || me.id === cn.manager_id || me.id === cn.employee_id) && (
              <button className="text-[11px] text-navy-400 underline" onClick={startEditingKras}>edit</button>
            )}
          </div>
        )}
        {editingKras && (
          <div className="space-y-1.5">
            {/* One short bullet per suggested KRA now, naming it, instead
                of a single sentence covering all of them. An array printed
                as {tagReasoning} would have run the bullets together with
                no separators, which is why this goes through Bullets(). */}
            <div className="text-[11px] text-violet-600 italic"><Bullets items={tagReasoning} /></div>
            {!kraOptions && <p className="text-xs text-navy-400">Loading KRAs…</p>}
            {kraOptions && !kraOptions.length && <p className="text-xs text-navy-400">This employee has no KRAs this cycle.</p>}
            <div className="flex flex-wrap gap-1.5">
              {(kraOptions || []).map(k => (
                <button key={k.id} type="button"
                  className={`chip ${selectedKraIds.includes(k.id) ? 'bg-brand-500 text-white' : 'bg-navy-50 text-navy-600'}`}
                  onClick={() => toggleSelectedKra(k.id)}>{k.title}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <button className="btn-sec !py-1" onClick={() => setEditingKras(false)}>Cancel</button>
              <button className="btn-pri !py-1" onClick={saveKras}>Save</button>
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-2">
        {cn.can_sign_off && <button className="btn-sec" onClick={signOff}>Sign off</button>}
        <button className="btn-sec" disabled={busy} onClick={askInsights}><Sparkles size={12} className="inline mr-1 text-amber-500" />{busy ? 'Thinking…' : 'AI insights'}</button>
      </div>
      {/* A connect row is a compact thing in a list of connect rows. The
          read across recent connects opens over the list instead of
          expanding one row to several screens. */}
      {insight && !insightOpen && (
        <button className="text-[11px] font-semibold text-indigo-600 hover:underline self-start" onClick={() => setInsightOpen(true)}>
          Reopen AI insights{insight.status ? ` — ${insight.status}` : ''}
        </button>
      )}
      {insight && insightOpen && (
        <AiModal title="What the recent connects show" onClose={() => setInsightOpen(false)}
          footer={<button className="btn-sec" disabled={busy} onClick={askInsights}>{busy ? 'Thinking…' : 'Refresh'}</button>}>
          <AiInsightsPanel insight={insight} />
        </AiModal>
      )}
      {/* The meetings on record are for the two people and the employee's
          own manager (and HR) — not for a Delivery Head or HRBP further up. */}
      {(anyMeeting || (me && (me.id === cn.employee_id || me.id === cn.manager_id || cn.my_report))) && (
        <MeetingPanel employeeId={cn.employee_id} context="connect" refId={cn.id}
          title="Meeting for this connect" />
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

// Matches a reference screenshot's layout precisely: a status badge next
// to the "AI Insights" label, an italic one-line verdict on the
// employee's progress/performance, and two columns (Themes / Suggested
// Follow-ups) rather than a flat list.
const INSIGHT_STATUS_COLOR = {
  'On Track': 'bg-emerald-100 text-emerald-700',
  Excelling: 'bg-emerald-100 text-emerald-700',
  Concerned: 'bg-amber-100 text-amber-700',
  'At Risk': 'bg-rose-100 text-rose-700',
};
// Themes grouped by related_kra, in the order the model returned them —
// it is told to derive themes from the connects in the input, so that
// order reflects the notes rather than anything worth re-sorting.
function groupThemes(themes) {
  const order = [];
  const byKra = new Map();
  for (const t of (Array.isArray(themes) ? themes : [])) {
    const kra = (t.related_kra || '').trim() || 'Not linked to a KRA';
    if (!byKra.has(kra)) { byKra.set(kra, []); order.push(kra); }
    byKra.get(kra).push(t);
  }
  return order.map((kra) => [kra, byKra.get(kra)]);
}

function AiInsightsPanel({ insight }) {
  return (
    <div className="space-y-3">
      {/* The header and the refresh button belong to the modal now, so
          this renders the content only — it is no longer a card. */}
      {insight.status && <span className={`chip ${INSIGHT_STATUS_COLOR[insight.status] || 'bg-navy-50 text-navy-600'}`}>{insight.status}</span>}
      {insight.headline && <p className="italic text-navy-700">"{insight.headline}"</p>}
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <p className="font-bold text-indigo-700 text-[11px] uppercase tracking-wide mb-1">Themes</p>
          {/* Grouped under the KRA each theme is linked to, so this reads
              the same way as every other bulleted draft. related_kra is
              the model's own tag; themes it could not tie to a KRA sit
              under "Not linked to a KRA" rather than being hidden. Real
              list markup instead of a "• " prefix inside a paragraph. */}
          {groupThemes(insight.themes).map(([kra, themes]) => (
            <div key={kra} className="mb-1.5">
              <p className="text-amber-600">{kra}</p>
              <ul className="list-disc pl-4">
                {themes.map((t, i) => <li key={i}><b>{t.name}</b>{t.summary ? `: ${t.summary}` : ''}</li>)}
              </ul>
            </div>
          ))}
          {!(insight.themes || []).length && <p className="text-navy-400">No recurring themes yet.</p>}
        </div>
        <div>
          <p className="font-bold text-indigo-700 text-[11px] uppercase tracking-wide mb-1">Suggested Follow-ups</p>
          <Bullets items={insight.suggested_followups} />
          {!(insight.suggested_followups || []).length && <p className="text-navy-400">Nothing specific suggested yet.</p>}
        </div>
      </div>
    </div>
  );
}

// A name search over everyone, since "anyone" at Mindgate is over a
// thousand people and a plain dropdown of them is unusable.
function PersonPicker({ people, value, onChange, hint }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const picked = people.find((p) => p.id === value);
  const list = people.filter((p) => matches(q, p.name, p.designation, p.department)).slice(0, 8);
  return (
    <div className="relative">
      <input maxLength={150} className="inp" value={open ? q : (picked ? `${picked.name}${hint ? ` (${hint})` : ''}` : '')}
        placeholder="Search by name, designation or department…"
        onFocus={() => { setOpen(true); setQ(''); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value)} />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-navy-100 rounded-lg shadow-lg max-h-60 overflow-auto">
          {!list.length && <p className="text-xs text-navy-400 p-2">Nobody matches.</p>}
          {list.map((p) => (
            <button key={p.id} type="button" className="w-full text-left px-2 py-1.5 text-xs hover:bg-navy-50"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(p.id); setOpen(false); }}>
              <b>{p.name}</b> <span className="text-navy-400">· {p.designation || '—'} · {p.department || '—'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
