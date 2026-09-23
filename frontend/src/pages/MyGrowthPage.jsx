import { useEffect, useState } from 'react';
import { Plus, Trash2, Send, CheckCircle2, RotateCcw } from 'lucide-react';
import { api, phaseLabel, phaseColor, Bullets } from '../utils/api';
import AiDraftPanel, { SuggestionList } from './AiDraftPanel';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';

const STATUS_COLOR = {
  draft: 'bg-slate-100 text-navy-600',
  submitted: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  returned: 'bg-rose-100 text-rose-700',
};

export default function MyGrowthPage() {
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <PageHead title="My Growth" hue="leaf"
        sub="Your target achievements for the year, and the role you are aiming at." />
      <div className="grid lg:grid-cols-2 gap-4">
        <DevelopmentPlanCard />
        <CareerPathCard />
      </div>
    </div>
  );
}

// SPLIT OUT on 23 Sep, the same fault as the Mid-Year one: the manager's
// list of their reports' growth plans was rendering at the bottom of the
// employee's OWN growth page, so "My Growth" showed other people. My
// Performance is about me; a list of my reports is a Manager page.
//
// Nothing about the review itself changed — same list, same expand, same
// approve/return, same endpoints.
export function TeamGrowthPage() {
  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHead title="Team Target Achievements" hue="lagoon"
        sub="Approve or return the growth plans your reports have submitted." />
      <TeamDevelopmentPlans standalone />
    </div>
  );
}

// ---------------- Target achievements for the year (BR-2.1/2.2/2.3) --------
// Displayed as "Target achievements for the year". The stored shape stays
// development_plans / development_goals and every route keeps its path —
// the annual review, the manager queue, the completion report and the
// phase-change notification all reference it, and renaming those for a
// wording change would be breaking for no user-visible gain.
function DevelopmentPlanCard() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => api('/pms/my/development-plan').then(setData).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (err) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className="card p-4"><p className="text-sm text-navy-400">Loading…</p></div>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  // The server decides this now and says so on the response — it holds both
  // halves of the rule (the phase AND whether the plan was returned), and
  // the page used to guess with only the status, offering an editor the API
  // then refused. Older builds do not send the flag, hence the fallback.
  const editable = data.editable !== undefined
    ? data.editable
    : data.plan.status === 'draft' || data.plan.status === 'returned';
  const reopened = editable && data.editable_via === 'returned';
  const openedByKraSubmit = editable && data.editable_via === 'kra_submitted';
  // Two different things land on 'returned', and attributing the wrong one
  // to a manager is worse than saying nothing: a plan reopened because HR
  // changed somebody's designation was not a manager's judgement on their
  // development goals. reopened_reason is a stored column rather than a
  // guess at the comment text (migration 039), matching the KRA sheet.
  const byRoleChange = data.plan.reopened_reason === 'profile_change';
  const byHr = data.plan.reopened_reason === 'hr_reopen';
  // The fourth reason, and the one the client reported missing: the plan was
  // reopened because the KRAs UNDER it changed. Distinct from
  // 'profile_change' on purpose — that fires when HR edits somebody's job,
  // this fires later, when the employee actually resubmits a different set
  // of KRAs, which is the moment their goals stop matching. See
  // server/modules/performance/kra-goal-sync.js.
  const byKraChange = data.plan.reopened_reason === 'kra_changed';

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p className="font-bold text-sm flex-1">Target achievements for the year</p>
        <span className={`chip ${STATUS_COLOR[data.plan.status]}`}>
          {data.plan.status !== 'returned' ? data.plan.status
            : byRoleChange ? 'reopened — role changed'
            : byKraChange ? 'reopened — KRAs changed'
            : byHr ? 'reopened by HR'
            : 'returned by manager'}
        </span>
      </div>
      {data.plan.status === 'returned' && data.plan.manager_comment && (
        <p className="text-xs bg-rose-50 text-rose-700 rounded-lg p-2">
          <b>{byRoleChange ? 'Reopened after a change to your role:'
            : byKraChange    ? 'Reopened because your KRAs changed:'
            : byHr           ? 'Reopened by HR:'
            : 'Returned by your manager:'}</b>
          {' '}{data.plan.manager_comment}
        </p>
      )}
      {openedByKraSubmit && (
        <p className="text-xs bg-teal-50 text-teal-700 rounded-lg p-2">
          Your KRAs are with your manager, so this is <b>open now</b>.
        </p>
      )}
      {!editable && data.shut_because === 'kra_not_submitted' && (
        <p className="text-xs bg-amber-50 text-amber-700 rounded-lg p-2">
          Submit your KRAs to your manager first. <b>This opens the moment you do</b> — you do
          not have to wait for HR to move the cycle on.
        </p>
      )}
      {reopened && (
        <p className="text-xs bg-amber-50 text-amber-700 rounded-lg p-2">
          {byRoleChange
            ? <>Your role changed, so this plan is <b>open for edits</b> again even though the
                cycle has moved on to {phaseLabel(data.cycle.phase)}. Review the goals and your
                career aspiration against the job you now hold, then submit again.</>
            : byKraChange
            ? <>Your KRAs changed, so this plan is <b>open for edits</b> again even though the
                cycle has moved on to {phaseLabel(data.cycle.phase)}. The goals marked below no
                longer serve a KRA on your sheet — point them at your current KRAs, then submit
                again.</>
            : byHr
            ? <>HR reopened this plan, so it is <b>open for edits</b> even though the cycle has
                moved on to {phaseLabel(data.cycle.phase)}. Make the changes they asked for, then
                submit it again.</>
            : <>Your manager returned this plan, so it is <b>open for edits</b> even though the
                cycle has moved on to {phaseLabel(data.cycle.phase)}. Edit and submit it again.</>}
        </p>
      )}
      <GoalList goals={data.goals} editable={editable} onSaved={load} kras={data.kras || []} />
      {editable && (
        <button className="btn-pri" disabled={!data.goals.length} onClick={async () => {
          try { await api('/pms/my/development-plan/submit', { method: 'POST' }); load(); }
          catch (e) { setErr(e.message); }
        }}><Send size={13} className="inline mr-1" />Submit for approval</button>
      )}
    </div>
  );
}

// Is there anything to show? A field the model was told to leave empty
// rather than pad legitimately comes back as [] — and `[].length && …`
// would render a bare "0" in JSX, so the check is explicit.
const hasAny = (v) => (Array.isArray(v) ? v.filter(Boolean).length > 0 : !!(v && String(v).trim()));

// Suggested goals, grouped by the KRA each one serves, preserving the
// order the model returned (it is told to weight its attention by KRA
// weight, so that order carries meaning and must not be sorted away).
function groupBySrvKra(goals) {
  const out = [];
  const byKra = new Map();
  for (const g of (Array.isArray(goals) ? goals : [])) {
    const kra = (g.serves_kra || '').trim() || 'Not tied to a KRA';
    if (!byKra.has(kra)) { byKra.set(kra, []); out.push(kra); }
    byKra.get(kra).push(g);
  }
  return out.map((kra) => [kra, byKra.get(kra)]);
}

// AI development-plan suggestions, drawn from the employee's own approved
// KRAs. Lives inside GoalList because that is where setGoals is — a
// suggestion is only useful if it can be dropped straight into the editor,
// and lifting the panel out would mean plumbing a callback back down for
// no gain.
function DevPlanAiPanel({ onAdd }) {
  // Ticked, and already-added. Two maps, not one: a row that has been
  // added must stop being tickable (a second tick would add the same goal
  // twice), and clearing the ticks after an add is what makes the count
  // on the button mean "still to add".
  const [sel, setSel] = useState({});
  const [added, setAdded] = useState({});

  // Keyed by KRA + title + position. Not by index alone: the list is
  // grouped for display, so an index is an index into a group.
  const itemsOf = (d) => (d.suggested_goals || []).map((g, i) => {
    const key = `${g.serves_kra || ''}|${g.title || ''}|${i}`;
    return {
      key,
      group: (g.serves_kra || '').trim() || 'Not tied to a KRA',
      title: g.title,
      teaser: Array.isArray(g.why) ? g.why[0] : g.why,
      meta: g.suggested_timeline || null,
      added: !!added[key],
      goal: g,
      detail: (
        <div className="space-y-1">
          <Bullets items={g.why} />
          {hasAny(g.how_to_measure) && (
            <div className="text-navy-500">
              <p className="font-semibold">Evidence of progress</p>
              <Bullets items={g.how_to_measure} />
            </div>
          )}
          {added[key] && (
            <button className="text-[11px] text-navy-400 hover:text-navy-600"
              onClick={() => { setAdded((p) => { const n = { ...p }; delete n[key]; return n; }); onAdd(g, { undo: true }); }}>
              Undo — take it back out of the plan
            </button>
          )}
        </div>
      ),
    };
  });

  return (
    <AiDraftPanel
      accent="teal"
      title="+ Suggest goals from my KRAs"
      description="Reads the KRAs you are accountable for this cycle and proposes development goals that build the capability each one needs."
      idleLabel="Suggest goals"
      againLabel="Suggest again"
      modalTitle="Suggested goals from your KRAs"
      run={async () => {
        setSel({}); setAdded({});
        const r = await api('/agentic/devplan-suggest', { method: 'POST' });
        return r.draft;
      }}
      summary={(d) => {
        const n = (d.suggested_goals || []).length;
        const kras = new Set((d.suggested_goals || []).map((g) => g.serves_kra).filter(Boolean)).size;
        return `${n} suggestion${n === 1 ? '' : 's'}${kras ? ` across ${kras} KRA${kras === 1 ? '' : 's'}` : ''}`;
      }}
      footer={(d) => {
        const items = itemsOf(d);
        const picked = items.filter((it) => sel[it.key] && !it.added);
        const addedCount = items.filter((it) => it.added).length;
        return (
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-pri" disabled={!picked.length} onClick={() => {
              picked.forEach((it) => onAdd(it.goal));
              setAdded((p) => ({ ...p, ...Object.fromEntries(picked.map((it) => [it.key, true])) }));
              setSel({});
            }}>
              {picked.length ? `Add ${picked.length} selected goal${picked.length === 1 ? '' : 's'}` : 'Add selected goals'}
            </button>
            <span className="text-navy-500">
              {addedCount
                ? `${addedCount} in your plan below — set a target date on each, then Save goals.`
                : 'Tick the ones you want. They land in the editor behind this window.'}
            </span>
          </div>
        );
      }}
    >
      {(d) => (
        <div className="space-y-2">
          <SuggestionList
            items={itemsOf(d)}
            selected={sel}
            onToggle={(k) => setSel((p) => ({ ...p, [k]: !p[k] }))}
            // Requested directly. Replaces the whole selection rather than
            // merging into it, so "Clear selection" is the same control
            // going the other way and cannot leave a stale tick behind.
            onSelectAll={(keys) => setSel(Object.fromEntries(keys.map((k) => [k, true])))}
            emptyNote="No goals suggested — there may be no approved KRAs to read yet."
          />
          {(d.uncovered_kras || []).length > 0 && <p className="text-amber-700">KRAs with no development goal yet: {d.uncovered_kras.join(' · ')}</p>}
          {(d.already_covered || []).length > 0 && <p className="text-navy-400">Already covered: {d.already_covered.join(' · ')}</p>}
          {(d.gaps || []).length > 0 && <p className="text-navy-400">Input gaps: {d.gaps.join(' · ')}</p>}
        </div>
      )}
    </AiDraftPanel>
  );
}

function GoalList({ goals: initial, editable, onSaved, kras = [] }) {
  const [goals, setGoals] = useState(initial);
  const [err, setErr] = useState(null);
  useEffect(() => { setGoals(initial); }, [initial]);

  const update = (i, field, value) => setGoals(gs => gs.map((g, j) => j === i ? { ...g, [field]: value } : g));
  // <input type="date"> accepts yyyy-mm-dd and nothing else. The column
  // comes back as a full ISO timestamp, which the control rejects silently
  // — the field rendered empty and the next save wrote that emptiness back.
  const dateValue = (v) => (v ? String(v).slice(0, 10) : '');
  const remove = (i) => setGoals(gs => gs.filter((_, j) => j !== i));
  const add = () => setGoals(gs => [...gs, { title: '', description: '', target_date: '', progress_pct: 0, kra_id: null, serves_kra: null }]);

  // Which KRA titles are on the sheet RIGHT NOW. Hoisted out of the
  // read-only branch because the editable view needs it just as much: a
  // plan reopened because the KRAs changed opens straight into the editor,
  // and it was the one view that showed no sign of which goals were the
  // problem — so the employee was invited to fix something unmarked.
  //
  // Matching is on the title, not kra_id: a null id is the normal state for
  // every goal written before the id-preserving save landed (see
  // migration 041), so treating null as stale would flag almost everything.
  const onSheetTitles = new Set((kras || []).map((k) => String(k.title || '').trim().toLowerCase()));
  // An empty sheet means "nothing to compare against", not "all stale".
  const isStaleServes = (name) => {
    const n = String(name || '').trim().toLowerCase();
    return !!n && onSheetTitles.size > 0 && !onSheetTitles.has(n);
  };

  const saveAll = async () => {
    setErr(null);
    // Checked here as well as on the server so the employee is told which
    // goals need a date without a round trip. The server check is the one
    // that actually enforces it — this is only to answer faster.
    const titled = goals.filter(g => (g.title || '').trim());
    const undated = titled.filter(g => !(g.target_date || '').trim());
    if (undated.length) {
      setErr(`Add a target date to ${undated.length === 1 ? 'this goal' : `these ${undated.length} goals`} before saving: ${undated.map(g => g.title.trim()).join(', ')}`);
      return;
    }
    if (!titled.length) { setErr('Add at least one goal with a title.'); return; }
    try { await api('/pms/my/development-plan/goals', { method: 'PUT', body: JSON.stringify({ goals }) }); onSaved(); }
    catch (e) { setErr(e.message); }
  };
  const setProgress = async (goalId, pct) => {
    try { await api(`/pms/my/development-plan/goals/${goalId}/progress`, { method: 'PUT', body: JSON.stringify({ progress_pct: pct }) }); onSaved(); }
    catch (e) { setErr(e.message); }
  };

  if (!editable) {
    // Grouped by the KRA each goal serves — the same grouping the
    // suggestion popup uses, now that the link survives being saved (035).
    // Goals with no KRA collect at the end under their own heading rather
    // than being hidden; "not tied to a KRA" is a legitimate answer.
    const groups = [];
    for (const g of goals) {
      const name = (g.serves_kra || '').trim() || 'Not tied to a KRA';
      let grp = groups.find((x) => x.name === name);
      if (!grp) { grp = { name, goals: [] }; groups.push(grp); }
      grp.goals.push(g);
    }
    groups.sort((a, b) => (a.name === 'Not tied to a KRA') - (b.name === 'Not tied to a KRA'));
    // A goal can name a KRA that is no longer on the sheet — after a role
    // change the employee refills My KRAs, and the goals keep the previous
    // role's KRA TITLE as a text snapshot. Printing that heading as if it
    // were live is how a plan describing the old job gets resubmitted
    // without anyone noticing. Found on the client's instance: five goals
    // still headed by KRAs that had been replaced.
    // 'Not tied to a KRA' is this view's own heading for goals with no
    // serves_kra at all, so it must be excluded before asking whether the
    // name is on the sheet — it never is.
    const isStale = (name) => name !== 'Not tied to a KRA' && isStaleServes(name);
    const staleCount = groups.filter((g) => isStale(g.name)).reduce((n, g) => n + g.goals.length, 0);
    return (
      <div className="space-y-2">
        {!goals.length && <p className="text-xs text-navy-400">No development goals recorded.</p>}
        {staleCount > 0 && (
          <p className="text-xs bg-amber-50 text-amber-800 rounded-lg p-2">
            <b>{staleCount} goal{staleCount === 1 ? '' : 's'} below still serve{staleCount === 1 ? 's' : ''} a KRA
            that is no longer on your sheet.</b> Your KRAs changed after these were written. This plan
            reopens by itself the next time your KRAs are submitted — or ask HR to reopen it now if
            you want to fix them sooner.
          </p>
        )}
        {groups.map(grp => (
          <div key={grp.name} className="space-y-2">
            <p className={`text-[10.5px] font-semibold tracking-[0.08em] uppercase pt-1 ${isStale(grp.name) ? 'text-amber-700' : 'text-teal-700'}`}>
              {grp.name === 'Not tied to a KRA'
                ? grp.name
                : <>Serves · {grp.name}{isStale(grp.name) && ' · no longer on your KRA sheet'}</>}
            </p>
            {grp.goals.map(g => (
          <div key={g.id} className="text-xs bg-navy-50 rounded-lg p-2 space-y-1">
            {/* The target date was always saved and returned; this view just
                never drew it, while the manager's view of the same goals did
                — so the person who set the date was the one who could not
                see it. Same "Target: <date>" format as that view. */}
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold flex-1">{g.title}</p>
              {g.target_date
                ? <span className="text-navy-400 shrink-0">Target: {new Date(g.target_date).toLocaleDateString()}</span>
                : <span className="text-amber-600 shrink-0">No target date</span>}
            </div>
            {g.description && <p className="text-navy-500">{g.description}</p>}
            <ProgressBar value={g.progress_pct} onChange={(v) => setProgress(g.id, v)} />
          </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  // The suggestion's timeline is prose the model chose ("by end of Q3",
  // "within 6 months"), not a date. It is carried into the description so
  // it is not lost, and deliberately NOT parsed into target_date: turning
  // vague wording into a hard deadline would invent precision the model
  // never gave and silently commit the employee to a date nobody picked.
  // The date field is left empty and required, so it is a conscious choice.
  // why/how_to_measure are bullet ARRAYS now. This is the path that
  // matters most: the goal's description is written to
  // pms.development_goals, so an array interpolated into a template string
  // would land in the database as comma-run-on text (or "[object Object]"
  // for anything nested). Bullets are flattened to "• " lines, which is
  // what the textarea below shows and what a reader expects. A plain
  // string still works — see Bullets() for why that case is kept alive.
  const asLines = (v, prefix = '• ') => (Array.isArray(v)
    ? v.filter(Boolean).map((x) => `${prefix}${String(x).trim()}`).join('\n')
    : (v ? String(v).trim() : ''));
  // Undo removes the goal this suggestion added, and only that one: the
  // LAST unsaved row whose title still matches, so undoing does not touch
  // a saved goal that happens to share a name, nor an edit made in
  // between. Unsaved is the test that matters — a row with an id came from
  // the server, not from the popup.
  const addSuggested = (g, opts = {}) => {
    if (opts.undo) {
      setGoals((gs) => {
        for (let i = gs.length - 1; i >= 0; i -= 1) {
          if (!gs[i].id && (gs[i].title || '') === (g.title || '')) return gs.filter((_, j) => j !== i);
        }
        return gs;
      });
      return;
    }
    // The KRA the suggestion named is matched back to one of the
    // employee's own KRAs by title, so the saved goal carries the real id
    // rather than a string. No match keeps the title anyway — see 035.
    const named = String(g.serves_kra || '').trim();
    const hit = kras.find((k) => String(k.title || '').trim().toLowerCase() === named.toLowerCase());
    setGoals((gs) => [...gs, {
      kra_id: hit ? hit.id : null,
      serves_kra: named || null,
      title: g.title || '',
      description: [
        asLines(g.why),
        hasAny(g.how_to_measure) ? `Evidence of progress:\n${asLines(g.how_to_measure)}` : null,
        g.suggested_timeline ? `Suggested timeline: ${g.suggested_timeline} — set a target date above.` : null,
      ].filter(Boolean).join('\n\n'),
      target_date: '', progress_pct: 0,
    }]);
  };

  return (
    <div className="space-y-3">
      <DevPlanAiPanel onAdd={addSuggested} />
      <p className="text-[11px] text-navy-400">Added suggestions arrive as editable goals — set a <b>target date</b> on each, then press <b>Save goals</b>, then submit for approval.</p>
      {goals.map((g, i) => (
        <div key={g.id || i} className="border border-navy-100 rounded-xl p-3.5 space-y-3 bg-white">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <label className="lbl">Goal title</label>
              <input className="inp w-full font-medium" placeholder="e.g. Cloud Architecture Certification"
                value={g.title} onChange={e => update(i, 'title', e.target.value)} />
            </div>
            <button className="btn-sec !p-1.5 mt-6 shrink-0" onClick={() => remove(i)} title="Remove goal"><Trash2 size={13} /></button>
          </div>
          <div className="max-w-[200px]">
            <label className="lbl">Target date <span className="text-rose-600">*</span></label>
            <input className={`inp w-full ${!dateValue(g.target_date) ? '!border-rose-300 !bg-rose-50/50' : ''}`}
              type="date" required value={dateValue(g.target_date)} onChange={e => update(i, 'target_date', e.target.value)} />
            {!dateValue(g.target_date) && <p className="text-[11px] text-rose-600 mt-1">Required before this goal can be saved.</p>}
          </div>
          <div className="max-w-[420px]">
            <label className="lbl">Serves KRA</label>
            <select className="inp w-full" value={g.kra_id || ''}
              onChange={e => {
                const id = e.target.value || null;
                const k = kras.find((x) => String(x.id) === String(id));
                setGoals(gs => gs.map((x, j) => j === i ? { ...x, kra_id: id, serves_kra: k ? k.title : null } : x));
              }}>
              {/* "Not tied to a KRA" is a real answer, not a placeholder: a
                  language course or a certification often serves the person
                  rather than one objective. */}
              <option value="">Not tied to a KRA</option>
              {kras.map((k) => <option key={k.id} value={k.id}>{k.title}</option>)}
            </select>
            {/* The goal named a KRA that has since left the sheet, so the
                select above has fallen back to "Not tied to a KRA" and the
                only record of what it used to serve is the frozen title.
                Printing it here is what makes the reopen banner's "the goals
                marked below" true, and what lets the employee re-point the
                goal instead of guessing why it is unset. */}
            {isStaleServes(g.serves_kra) && (
              <p className="text-[11px] text-amber-700 mt-1">
                Previously served <b>{g.serves_kra}</b>, which is no longer on your KRA sheet.
                Pick the KRA it serves now.
              </p>
            )}
            {!kras.length && <p className="text-[11px] text-navy-400 mt-1">No approved KRAs on this cycle yet — goals can still be written.</p>}
          </div>
          <div>
            <label className="lbl">Description (optional)</label>
            <textarea className="inp w-full" rows={4} placeholder="Add detail — what you'll do, resources you'll use, milestones along the way. Paste as much as you need."
              value={g.description || ''} onChange={e => update(i, 'description', e.target.value)} />
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button className="btn-sec" onClick={add}><Plus size={13} className="inline mr-1" />Add goal</button>
        <button className="btn-pri" onClick={saveAll}>Save goals</button>
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

function ProgressBar({ value, onChange, readOnly }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-navy-100 rounded-full overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${value}%` }} />
      </div>
      {readOnly ? (
        <span className="text-xs font-medium text-navy-500 w-10 text-right">{value}%</span>
      ) : (
        <>
          <input className="inp w-16 !py-0.5 text-right" type="number" min="0" max="100" value={value}
            onChange={e => onChange(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
          <span className="text-[10px] text-navy-400">%</span>
        </>
      )}
    </div>
  );
}

// The eligibility verdict for the role the employee is aiming at.
//
// FOUR OUTCOMES, not two, and "cannot_assess" is a real one: with no
// years and no skills typed in, the honest answer is that nobody can
// say — printing "not ready" for an unanswered form would be a judgement
// the input does not support.
//
// Everything here is ADVISORY. It is built from what the employee typed
// about themselves and from the competencies HR listed on the
// transition; it decides nothing, and no rating reads it.
const VERDICT = {
  ready:         { label: 'Looks ready',            cls: 'bg-leaf-50 text-leaf-600 border-leaf-500' },
  nearly:        { label: 'Nearly there',           cls: 'bg-amber2-50 text-amber2-600 border-amber2-500' },
  not_yet:       { label: 'Not yet',                cls: 'bg-rose-50 text-rose-700 border-rose-500' },
  cannot_assess: { label: 'Not enough to go on',    cls: 'bg-navy-50 text-navy-500 border-navy-300' },
};

function Readiness({ r }) {
  const v = VERDICT[r.verdict] || VERDICT.cannot_assess;
  const List = ({ title, items, tone }) => (
    (items || []).length > 0 && (
      <div>
        <p className={`text-[10px] font-bold uppercase tracking-wide ${tone}`}>{title}</p>
        <ul className="list-disc pl-4">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      </div>
    )
  );
  return (
    <div className={`rounded-lg border-l-4 p-3 space-y-2 ${v.cls}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-extrabold uppercase tracking-wide">{v.label}</span>
        {r.summary && <span className="text-xs font-normal text-navy-700">{r.summary}</span>}
      </div>
      {r.benchmark && (
        <p className="text-xs text-navy-600"><b>Benchmark:</b> {r.benchmark}</p>
      )}
      <div className="grid sm:grid-cols-2 gap-3 text-xs text-navy-600">
        <List title="You appear to have" items={r.have} tone="text-leaf-600" />
        <List title="Gaps to close" items={r.gaps} tone="text-amber2-600" />
      </div>
      <List title="Next steps" items={r.next_steps} tone="text-navy-500" />
      <p className="text-[10.5px] text-navy-400">
        Advisory only, and built partly from what you typed about yourself. It decides nothing and
        no rating reads it — discuss it with your manager.
      </p>
    </div>
  );
}

// ---------------- Aspiring Career (BR-3.1/3.2) ------------------------------
// Displayed as "Aspiring Career"; the table, API fields and route all still
// say career_path/people.career_paths. Renaming only the label was
// deliberate — the stored shape is referenced by the annual review, the
// team overview and the HR pathing matrix, and churning those for a
// wording change would be a breaking change for no user-visible gain.
// AI aspiring-career suggestions. Constrained server-side to the
// transitions HR configured from the employee's current role, so anything
// it proposes is a role the select below will actually accept.
function CareerAiPanel({ onUse }) {
  // Single choice, not a basket: the form holds ONE target role, so a
  // second pick replaces the first rather than adding to it.
  const [pickKey, setPickKey] = useState(null);
  const [used, setUsed] = useState(null);

  const itemsOf = (d) => (d.aspirations || []).map((a, i) => ({
    key: `${a.target_role || ''}|${i}`,
    title: a.target_role,
    teaser: a.fit,
    meta: a.typical_time || null,
    added: used === a.target_role,
    role: a,
    detail: (
      <div className="space-y-1">
        {a.fit && <p>{a.fit}</p>}
        {(a.competencies_to_build || []).length > 0 && (
          <div><p className="text-navy-500 font-semibold">Competencies to build</p>
            <ul className="list-disc pl-4">{a.competencies_to_build.map((c, n) => <li key={n}>{c}</li>)}</ul></div>
        )}
        {(a.first_steps || []).length > 0 && (
          <div><p className="text-navy-500 font-semibold">Start this cycle</p>
            <ul className="list-disc pl-4">{a.first_steps.map((c, n) => <li key={n}>{c}</li>)}</ul></div>
        )}
        {(a.suggested_milestones || []).length > 0 && (
          <div><p className="text-navy-500 font-semibold">Milestones to track</p>
            <ul className="list-disc pl-4">{a.suggested_milestones.map((m, n) => (
              <li key={n}>{m.title}{m.description && <span className="text-navy-400"> — {m.description}</span>}</li>
            ))}</ul></div>
        )}
      </div>
    ),
  }));

  return (
    <AiDraftPanel
      accent="indigo"
      title="+ Where could I aim next?"
      description="Reads your designation and department against the career paths HR has configured, and suggests what a one-to-two year aspiration could look like."
      idleLabel="Suggest a path"
      againLabel="Suggest again"
      modalTitle="Possible next roles"
      run={async () => { setUsed(null); const r = await api('/agentic/career-suggest', { method: 'POST' }); return r.draft; }}
      summary={(d) => {
        if (d.no_path_configured) return 'No career path configured from your current role';
        const n = (d.aspirations || []).length;
        return `${n} possible next role${n === 1 ? '' : 's'}`;
      }}
      footer={(d) => {
        const items = itemsOf(d);
        const pick = items.find((it) => it.key === pickKey);
        return (
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-pri" disabled={!pick || pick.added}
              onClick={() => { onUse(pick.role); setUsed(pick.role.target_role); setPickKey(null); }}>
              Use this one
            </button>
            <span className="text-navy-500">
              {used ? `“${used}” is filled in below — edit it, then save.` : 'Pick one; it fills in the form behind this window.'}
            </span>
          </div>
        );
      }}
    >
      {(d) => (
        <div className="space-y-2">
          {d.no_path_configured && <p className="text-amber-700">No career path is configured from your current role yet — HR needs to define one in the Career Pathing Matrix.</p>}
          {/* THE READINESS READ, from the two questions on the form.
              Asked for on 23 Sep: benchmark, competencies, and whether
              they are eligible. It leads, because it is the question the
              employee actually came with — and the verdict is stated
              plainly rather than buried in a paragraph. */}
          {d.readiness && <Readiness r={d.readiness} />}
          <SuggestionList
            items={itemsOf(d)}
            selected={pickKey ? { [pickKey]: true } : {}}
            onToggle={(k) => setPickKey((p) => (p === k ? null : k))}
            single
            emptyNote="No roles suggested — HR may not have configured a path from your role."
          />
          {(d.notes || []).length > 0 && <p className="text-navy-400">{d.notes.join(' · ')}</p>}
        </div>
      )}
    </AiDraftPanel>
  );
}

// Why the target-role list is empty. Deterministic and shown above the AI
// panel: an empty list has several causes and only one of them is "HR has
// not set this up". Saying "nothing is configured" when a transition
// exists but was excluded on level sent people looking for a row that was
// already there.
function CareerPathGap({ d }) {
  if (!d || d.reason === 'ok') return null;

  if (d.reason === 'level_mismatch') {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs space-y-1.5">
        <p className="font-bold text-amber-800">A career path exists for your role, but it does not match your level</p>
        <p className="text-navy-600">
          The matrix has {d.excluded_by_level.length === 1 ? 'a transition' : `${d.excluded_by_level.length} transitions`} from
          <b> {d.designation}</b>, but {d.excluded_by_level.length === 1 ? 'it is' : 'they are'} restricted to a level that
          does not match your role band {d.role_band ? <>(<b>{d.role_band}</b>)</> : <>(<b>not set on your record</b>)</>}.
        </p>
        <ul className="list-disc pl-4 text-navy-500">
          {d.excluded_by_level.map((t, i) => (
            <li key={i}>→ {t.to_role} — requires level <b>{t.requires_level}</b></li>
          ))}
        </ul>
        <p className="text-navy-600">
          Ask HR to either clear the level on that transition (blank means <i>any level</i>) or correct your role band.
        </p>
      </div>
    );
  }
  if (d.reason === 'all_inactive') {
    return <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
      <p className="font-bold text-amber-800">The career path from your role is deactivated</p>
      <p className="text-navy-600">{d.inactive} transition{d.inactive === 1 ? ' is' : 's are'} configured from <b>{d.designation}</b> but switched off. Ask HR to reactivate.</p>
    </div>;
  }
  if (d.reason === 'no_designation') {
    return <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
      <p className="font-bold text-amber-800">Your designation is not set</p>
      <p className="text-navy-600">Career paths are matched on designation, so nothing can be suggested until HR completes your record.</p>
    </div>;
  }
  return <div className="bg-navy-50 border border-navy-100 rounded-xl p-3 text-xs">
    <p className="font-bold text-navy-700">No career path configured yet</p>
    <p className="text-navy-500">Nothing has been defined from <b>{d.designation}</b> in the Career Pathing Matrix. Ask HR to add one.</p>
  </div>;
}

function CareerPathCard() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ target_role: '', target_timeline: '', plan: '',
    years_experience: '', skills_interests: '' });
  const [milestones, setMilestones] = useState([]);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const load = () => api('/people/career/my-path').then(r => {
    setData(r);
    setForm({ target_role: r.path?.target_role || '', target_timeline: r.path?.target_timeline || '',
      plan: r.path?.plan || '',
      years_experience: r.path?.years_experience ?? '',
      skills_interests: r.path?.skills_interests || '' });
    setMilestones((r.milestones || []).map(m => ({ ...m, target_date: m.target_date ? String(m.target_date).slice(0, 10) : '' })));
  }).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  // The path is saved FIRST: milestones hang off it, so on the very first
  // save there is no row for them to attach to until this lands.
  const save = async () => {
    setErr(null); setSaved(false);
    if (!form.target_role.trim()) { setErr('A target role is required.'); return; }
    const missingDate = milestones.findIndex(m => m.title.trim() && !m.target_date);
    if (missingDate >= 0) { setErr(`Milestone ${missingDate + 1} needs a target date.`); return; }
    try {
      await api('/people/career/my-path', { method: 'PUT', body: JSON.stringify(form) });
      await api('/people/career/my-milestones', {
        method: 'PUT',
        body: JSON.stringify({ milestones: milestones.filter(m => m.title.trim()) }),
      });
      setSaved(true); load();
    } catch (e) { setErr(e.message); }
  };

  // Progress is NOT phase-gated — it happens all year, and a gate would
  // mean marking something done months after you did it.
  const setProgress = async (id, pct) => {
    try { const r = await api(`/people/career/my-milestones/${id}/progress`, { method: 'PUT', body: JSON.stringify({ progress_pct: pct }) });
      setData(d => ({ ...d, progress_pct: r.progress_pct }));
      setMilestones(ms => ms.map(m => (m.id === id ? { ...m, progress_pct: pct } : m)));
    } catch (e) { setErr(e.message); }
  };

  if (err && !data) return <div className="card p-4"><p className="text-sm text-rose-600">{err}</p></div>;
  if (!data) return <div className="card p-4"><p className="text-sm text-navy-400">Loading…</p></div>;

  // Fix guide item #6 follow-up: Career Path now opens alongside
  // Development Plan once HR locks KRA and advances to Growth Planning,
  // per the explicit request — previously this card had no phase gate at
  // all and was always editable.
  const editable = data.editable;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <p className="font-bold text-sm flex-1">Aspiring Career</p>
        {data.cycle_phase && <span className={`chip ${phaseColor(data.cycle_phase)}`}>{phaseLabel(data.cycle_phase)}</span>}
      </div>
      {/* WHERE YOU ARE, before where you want to go. Read from the
          employee master, never typed — a designation somebody types is
          a designation that stops matching the Career Pathing Matrix.
          Asked for on 23 Sep. */}
      {data.current && (
        <div className="bg-navy-50 rounded-lg px-3 py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-navy-400">Current role</span>
          <b className="text-navy-900">{data.current.designation || 'not set on your record'}</b>
          {data.current.department && <span className="text-navy-500">· {data.current.department}</span>}
          {data.current.role_band && <span className="chip bg-white text-navy-500">{data.current.role_band}</span>}
        </div>
      )}
      <CareerPathGap d={data.path_diagnostics} />
      {editable && <CareerAiPanel onUse={(a) => {
        setForm((fm) => ({
          target_role: a.target_role || fm.target_role,
          target_timeline: a.typical_time || fm.target_timeline,
          plan: [a.fit, (a.competencies_to_build || []).length ? `Competencies to build:\n- ${a.competencies_to_build.join('\n- ')}` : null,
                 (a.first_steps || []).length ? `First steps:\n- ${a.first_steps.join('\n- ')}` : null].filter(Boolean).join('\n\n'),
        }));
        // Suggested milestones land as editable drafts with no date —
        // a date is required to save, so the employee has to commit to
        // one rather than accept whatever the model would have guessed.
        if ((a.suggested_milestones || []).length) {
          setMilestones((ms) => [...ms, ...a.suggested_milestones.map((m) => ({
            title: m.title, description: m.description || '', target_date: '', progress_pct: 0,
          }))]);
        }
      }} />}
      {editable && <p className="text-[11px] text-navy-400">Unsaved until you press <b>Save</b>.</p>}
      <div>
        <label className="lbl">Target role</label>
        {data.eligible_target_roles.length ? (
          <select className="inp" value={form.target_role} disabled={!editable} onChange={e => setForm(f => ({ ...f, target_role: e.target.value }))}>
            <option value="">—</option>
            {data.eligible_target_roles.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : (
          <input className="inp" value={form.target_role} disabled={!editable} onChange={e => setForm(f => ({ ...f, target_role: e.target.value }))} placeholder="e.g. Staff Engineer" />
        )}
        {data.eligible_target_roles.length > 0 && <p className="text-[11px] text-navy-400 mt-1">Limited to transitions HR has configured from your current role in the Career Pathing Matrix.</p>}
      </div>
      <div>
        <label className="lbl">Expected timeline</label>
        <input className="inp" value={form.target_timeline} disabled={!editable} onChange={e => setForm(f => ({ ...f, target_timeline: e.target.value }))} placeholder="e.g. 12-18 months" />
      </div>
      {/* THE TWO QUESTIONS, asked on 23 Sep so the readiness read has
          something to work from. Both are self-reported and the AI is
          told to treat them as claims, not facts. Total experience is
          NOT tenure here: someone who joined last year may have fifteen
          years behind them, so it cannot be derived and has to be
          asked. */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="lbl">Total years of experience</label>
          <input className="inp" type="number" min="0" max="60" step="0.5" disabled={!editable}
            value={form.years_experience}
            onChange={e => setForm(f => ({ ...f, years_experience: e.target.value }))}
            placeholder="e.g. 7.5" />
          <p className="text-[11px] text-navy-400 mt-1">
            Your whole career, not just time here.
          </p>
        </div>
        <div>
          <label className="lbl">Your skill sets and interests</label>
          <textarea className="inp" rows={3} disabled={!editable}
            value={form.skills_interests}
            onChange={e => setForm(f => ({ ...f, skills_interests: e.target.value }))}
            placeholder="What you are good at, and what you want to do more of" />
        </div>
      </div>
      <div>
        <label className="lbl">Growth plan</label>
        <textarea className="inp" rows={4} value={form.plan} disabled={!editable} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))} placeholder="How you plan to get there" />
      </div>

      {/* Milestones are what make this a plan rather than an aspiration:
          the steps towards the role, each with a date and a progress
          figure. Progress stays editable outside Growth Planning, because
          progress happens all year. */}
      <div className="space-y-2">
        <div className="flex items-baseline gap-2">
          <label className="lbl mb-0 flex-1">Milestones towards this role</label>
          {data.progress_pct != null && <span className="text-[11px] font-semibold text-teal-700">{data.progress_pct}% overall</span>}
        </div>
        {!milestones.length && <p className="text-[11px] text-navy-400">No milestones yet — add the steps you'll take, so progress is something you can point at.</p>}
        {milestones.map((m, i) => (
          <div key={m.id || `new-${i}`} className="border border-navy-100 rounded-lg p-2 space-y-1">
            <div className="flex gap-2">
              {/* min-w and an explicit flex-basis on the date, because .inp
                  carries w-full and is declared after Tailwind's utilities
                  layer — so a bare w-40 loses to it and the date input grows
                  until the flex-1 title collapses to nothing. Same fix the
                  increment-matrix rows already use. */}
              <input className="inp flex-1 min-w-[180px]" placeholder="Milestone *" value={m.title || ''} disabled={!editable}
                onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
              <input className="inp basis-40 grow-0 shrink-0" type="date" value={m.target_date || ''} disabled={!editable}
                onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, target_date: e.target.value } : x)))} />
              {editable && <button className="text-rose-500" onClick={() => setMilestones(ms => ms.filter((_, j) => j !== i))}><Trash2 size={15} /></button>}
            </div>
            <input className="inp text-xs" placeholder="What done looks like" value={m.description || ''} disabled={!editable}
              onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            {m.id && (
              <div className="flex items-center gap-2">
                <input type="range" min="0" max="100" step="5" value={m.progress_pct ?? 0} className="flex-1"
                  onChange={e => setMilestones(ms => ms.map((x, j) => (j === i ? { ...x, progress_pct: Number(e.target.value) } : x)))}
                  onMouseUp={e => setProgress(m.id, Number(e.target.value))}
                  onTouchEnd={e => setProgress(m.id, Number(e.target.value))} />
                <span className="text-[11px] w-10 text-right font-medium">{m.progress_pct ?? 0}%</span>
              </div>
            )}
          </div>
        ))}
        {editable && (
          <button className="btn-sec !py-1 !text-[11px]"
            onClick={() => setMilestones(ms => [...ms, { title: '', description: '', target_date: '', progress_pct: 0 }])}>
            <Plus size={12} className="inline mr-1" />Add milestone
          </button>
        )}
        {!editable && milestones.length > 0 && <p className="text-[11px] text-navy-400">Milestone text is editable once your KRAs are submitted — progress can be updated any time.</p>}
      </div>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {editable ? (
        <>
          <button className="btn-pri" onClick={save}>Save</button>
          {saved && <span className="text-[11px] text-emerald-600 font-medium ml-2">Saved ✓</span>}
        </>
      ) : (
        <p className="text-xs text-navy-400">
          {data.shut_because === 'kra_not_submitted'
            ? <>Submit your KRAs to your manager and this opens straight away.</>
            : <>Aspiring Career editing opens once you submit your KRAs for this cycle.</>}
        </p>
      )}
    </div>
  );
}

// ---------------- Manager view — approve/return reports' plans --------------
// Not part of the BRD's Fig. 5 (that's the employee's own view), but a
// Development Plan stuck at "submitted" with no way to decide it is not a
// usable feature — this closes that loop. Silently hidden for anyone
// without pms_team_eval (the request 403s and the section just doesn't render).
//
// Rebuilt per direct feedback: the manager previously saw only a goal
// count + avg progress with no way to actually read what the employee
// wrote, and "Return with comment" used a native prompt() dialog (an
// ugly browser popup, not part of the page). Now mirrors
// TeamKraSheetsPage.jsx's pattern: expand a report to see every goal in
// full, with the comment box inline on the page itself.
function TeamDevelopmentPlans({ standalone = false }) {
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [q, setQ] = useState('');
  const load = () => api('/pms/team/development-plans').then(setData).catch(() => setData({ cycle: null, plans: [] }));
  useEffect(() => { load(); }, []);

  // As a whole page an empty list has to SAY it is empty; as a trailing
  // block on somebody else's page, returning null was right.
  if (!data) return standalone ? <p className="text-sm text-navy-400">Loading…</p> : null;
  if (!data.plans?.length) {
    return standalone
      ? <div className="card p-8 text-center text-sm text-navy-400">
          No direct reports have submitted a growth plan yet.
        </div>
      : null;
  }

  const shown = data.plans.filter((p) => matches(q, p.employee_name, p.status));

  return (
    <div className="space-y-2">
      {!standalone && <p className="font-bold text-sm">Team target achievements</p>}
      <SearchBox value={q} onChange={setQ} placeholder="Search your team by name or status…"
        shown={shown.length} total={data.plans.length} />
      {shown.map(p => (
        <div key={p.id} className="card overflow-hidden">
          <button className="w-full flex items-center justify-between px-4 py-3 text-left" onClick={() => setOpenId(v => v === p.id ? null : p.id)}>
            <span className="text-sm font-semibold flex-1">{p.employee_name}</span>
            <span className="text-xs text-navy-400 mr-2">{p.goal_count} goals · {p.avg_progress}% avg</span>
            <span className={`chip ${STATUS_COLOR[p.status]}`}>{p.status}</span>
          </button>
          {openId === p.id && <TeamPlanDetail plan={p} reload={load} />}
        </div>
      ))}
    </div>
  );
}

function TeamPlanDetail({ plan, reload }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/pms/team/development-plans/${plan.id}/goals`).then(setDetail).catch(e => setErr(e.message));
  }, [plan.id]);

  const decide = async (decision) => {
    if (decision === 'returned' && !comment.trim()) { setErr('A return needs a comment — the employee must know why.'); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/pms/team/development-plans/${plan.id}/decide`, { method: 'POST', body: JSON.stringify({ decision, comment: comment.trim() || null }) });
      reload();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const canDecide = plan.status === 'submitted';

  return (
    <div className="border-t border-navy-100 p-4 space-y-3">
      {plan.manager_comment && (
        <div className="bg-navy-50 border border-navy-100 rounded-lg p-3 text-xs">
          <p className="font-bold text-navy-500 uppercase text-[10px]">Your last comment</p>
          <p>{plan.manager_comment}</p>
        </div>
      )}
      {!detail && !err && <p className="text-xs text-navy-400">Loading goals…</p>}
      {detail && (
        <div className="space-y-2">
          {!detail.goals.length && <p className="text-xs text-navy-400">No goals added yet.</p>}
          {detail.goals.map(g => (
            <div key={g.id} className="bg-navy-50 rounded-lg p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold flex-1">{g.title}</p>
                {g.target_date && <span className="text-navy-400">Target: {new Date(g.target_date).toLocaleDateString()}</span>}
              </div>
              {g.description && <p className="text-navy-600">{g.description}</p>}
              <ProgressBar value={g.progress_pct} onChange={() => {}} readOnly />
            </div>
          ))}
        </div>
      )}
      {canDecide && (
        <div className="space-y-2">
          <textarea className="inp" rows={2} placeholder="Comment (required if returning)" value={comment} onChange={e => setComment(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <button className="btn-pri" disabled={busy} onClick={() => decide('approved')}><CheckCircle2 size={13} className="inline mr-1" />Approve</button>
            <button className="btn-sec" disabled={busy} onClick={() => decide('returned')}><RotateCcw size={13} className="inline mr-1" />Return for edits</button>
          </div>
        </div>
      )}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}
