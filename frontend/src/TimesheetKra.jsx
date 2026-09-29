// Timesheet → KRA coverage, shared by all three Timesheet tabs.
//
// Phase 3 of the Zoho timesheet rating engine. The same component
// serves Self, Manager and HR; what changes is whether the mapping
// controls are shown, because an EMPLOYEE READS EVERY NUMBER ABOUT
// THEMSELVES AND ASSERTS NONE OF THEM. Mapping an item moves hours
// between objectives and excluding one takes them out of the
// denominator, so self-service there would be self-marking.
//
// THE NUMBERS ARE NOT COMPUTED HERE. Everything arrives from
// /pms/timesheet/kra/*, which runs timesheet-kra-match.js and
// timesheet-kra-score.js. Same house rule as the compliance dashboard
// beside it: a second implementation in the browser is how a screen and
// an export come to disagree.
//
// WHAT THIS SCREEN IS FOR, and it is not a rating. Phase 2 ships as
// coverage reporting with automatic scoring off, so the most important
// thing on the page is usually the panel explaining what is NOT being
// said and why. Those sentences come from the server verbatim; this
// file must never summarise them into "insufficient data".
import { useEffect, useMemo, useState } from 'react';
import { api } from './utils/api';
import {
  Link2, Link2Off, HelpCircle, Ban, Target, AlertTriangle, Save, Info, Sparkles,
} from 'lucide-react';

// One vocabulary for how an item came to be placed, used by the chip,
// the legend and the grouping, so they cannot drift apart.
export const HOW = {
  mapped:    { label: 'Mapped',      chip: 'bg-teal-100 text-teal-700',     icon: Link2,
               help: 'A manager said this item belongs to that KRA.' },
  keyword:   { label: 'By keyword',  chip: 'bg-lagoon-50 text-lagoon-700',  icon: Sparkles,
               help: 'Placed because the KRA’s own keywords appear in the item text.' },
  ambiguous: { label: 'Ambiguous',   chip: 'bg-amber-100 text-amber-700',   icon: HelpCircle,
               help: 'Two or more KRAs matched, so the hours were given to neither. Map it to settle it.' },
  excluded:  { label: 'Not KRA work', chip: 'bg-navy-100 text-navy-500',    icon: Ban,
               help: 'Deliberately excluded. These hours are left out of the coverage figure.' },
  unmapped:  { label: 'Unplaced',    chip: 'bg-rose-50 text-rose-600',      icon: Link2Off,
               help: 'Nobody has said which KRA this serves yet.' },
};

const pct = (v) => (v == null ? '—' : `${v}%`);
const hrs = (v) => `${Number(v || 0)}h`;

function Num({ label, value, sub, tone }) {
  return (
    <div className="card p-3">
      <p className="text-[10px] uppercase tracking-wide text-navy-400">{label}</p>
      <p className={`text-2xl font-semibold ${tone || 'text-navy-900'}`}>{value}</p>
      {sub && <p className="text-[10.5px] text-navy-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// Effort against the weight the sheet already agreed. Two bars rather
// than one number, because "you spent 57% of your time on a 10% KRA" is
// the conversation this screen exists to start, and a single percentage
// hides which way the gap runs.
function ShareBar({ share, target }) {
  const w = (v) => `${Math.min(100, Math.max(0, Number(v) || 0))}%`;
  return (
    <div className="space-y-0.5 min-w-[120px]">
      <div className="h-1.5 rounded bg-navy-50 overflow-hidden">
        <div className="h-full bg-lagoon-500" style={{ width: w(share) }} />
      </div>
      <div className="h-1.5 rounded bg-navy-50 overflow-hidden">
        <div className="h-full bg-navy-300" style={{ width: w(target) }} />
      </div>
    </div>
  );
}

export default function TimesheetKra({ employeeId, canMap, onSaved }) {
  const [d, setD] = useState(null);
  // Which cycle is on screen. Null means "let the server choose", which
  // it does by picking the latest cycle that actually has logs.
  const [win, setWin] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // Pending edits, keyed by item. Collected and sent as ONE bulk call so
  // the whole session lands or none of it does — a half-applied mapping
  // leaves a coverage figure matching neither what was on screen nor
  // what was pressed.
  const [draft, setDraft] = useState({});
  const [saveErr, setSaveErr] = useState(null);

  const base = employeeId ? `/pms/timesheet/kra/employee/${employeeId}` : '/pms/timesheet/kra/me';
  const path = win ? `${base}?from=${win.from}&to=${win.to}` : base;
  const load = () => {
    setD(null);
    api(path).then((r) => { setD(r); setDraft({}); }).catch((e) => setErr(e.message));
  };
  useEffect(load, [employeeId, win && win.from]);

  const kras = useMemo(() => (d ? d.by_kra : []), [d]);
  const pending = Object.keys(draft).length;

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const s = d.summary;
  const t = d.totals;

  const setItem = (key, patch) => setDraft((x) => {
    const next = { ...x };
    if (patch === null) delete next[key];
    else next[key] = { ...(next[key] || {}), ...patch };
    return next;
  });

  const save = async () => {
    setSaveErr(null); setBusy(true);
    try {
      const mappings = Object.entries(draft).map(([item_key, v]) => ({
        item_key,
        item_label: v.item_label,
        decision: v.decision,
        kra_id: v.decision === 'kra' ? v.kra_id : undefined,
        note: v.note || undefined,
      }));
      await api(`/pms/timesheet/kra/employee/${employeeId}/map/bulk`,
        { method: 'POST', body: JSON.stringify({ mappings }) });
      load();
      if (onSaved) onSaved();
    } catch (e) { setSaveErr(e.message); } finally { setBusy(false); }
  };

  // Nothing uploaded is not a bad month. Said plainly rather than shown
  // as a row of zeroes, which reads as a failing score.
  if (!d.has_entries) {
    return (
      <div className="space-y-3">
        {/* The picker is repeated here on purpose: an empty month with
            no way to reach a month that has data is a dead end, and
            this is the state a reader hits most often. */}
        {!!(d.windows || []).length && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-navy-400">Period</span>
            <select className="inp !text-xs !w-auto" value={d.window.from}
              onChange={(e) => {
                const w = (d.windows || []).find((x) => x.from === e.target.value);
                if (w) setWin({ from: w.from, to: w.to });
              }}>
              <option value={d.window.from}>{d.window.from} – {d.window.to} · nothing logged</option>
              {(d.windows || []).map((w) => (
                <option key={w.from} value={w.from}>{w.from} – {w.to} · {w.hours}h</option>
              ))}
            </select>
          </div>
        )}
        <div className="card p-8 text-center text-sm text-navy-400">
          No timesheet logged in {d.window.from} – {d.window.to}.
          {(d.windows || []).length
            ? ' Pick a period above that has logs.'
            : ' Coverage appears here as soon as an export covering this period is uploaded.'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* WHICH MONTH. A timesheet is uploaded after the period it
          covers, so the calendar's current cycle is empty for most of
          its length; the server lands on the latest cycle with logs and
          this offers the rest. */}
      {(d.windows || []).length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-navy-400">Period</span>
          <select className="inp !text-xs !w-auto" value={`${d.window.from}`}
            onChange={(e) => {
              const w = (d.windows || []).find((x) => x.from === e.target.value);
              if (w) setWin({ from: w.from, to: w.to });
            }}>
            {(d.windows || []).map((w) => (
              <option key={w.from} value={w.from}>
                {w.from} – {w.to} · {w.hours}h
              </option>
            ))}
          </select>
        </div>
      )}

      {/* WHAT IS NOT BEING SAID, AND WHY — first, not last. With
          automatic scoring off this is the most important thing on the
          page, and burying it under four green numbers is how somebody
          comes to believe a rating already moves from this screen. */}
      {!!(s.withheld || []).length && (
        <div className="card p-3 border-l-4 border-amber2-500 space-y-1">
          <p className="text-[11px] font-semibold text-navy-900">
            <Info size={12} className="inline mr-1 -mt-px" />No rating is produced from this screen
          </p>
          <ul className="list-disc ml-5 text-[11.5px] text-navy-600 space-y-0.5">
            {s.withheld.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Num label="Hours placed" value={pct(t.mapped_pct)}
          tone={t.mapped_pct >= 80 ? 'text-emerald-600' : t.mapped_pct >= 40 ? 'text-amber-600' : 'text-rose-600'}
          sub={`${hrs(t.attributed)} of ${hrs(t.considered)} considered`} />
        <Num label="KRA coverage" value={pct(s.weighted_coverage_pct)}
          sub="of the sheet by weight, not by count" />
        <Num label="Effort alignment" value={pct(s.alignment_pct)}
          sub="how closely effort matched the weights" />
        <Num label="Timesheet compliance" value={pct(s.compliance_pct)}
          sub={`${d.window.from} – ${d.window.to}`} />
      </div>

      {/* The KRAs. */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <p className="lbl">Where the hours went</p>
          <span className="text-[10px] text-navy-400">
            <span className="inline-block w-3 h-1.5 rounded bg-lagoon-500 align-middle mr-1" />share of placed hours
            <span className="inline-block w-3 h-1.5 rounded bg-navy-300 align-middle ml-3 mr-1" />KRA weight
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                <th className="px-3 py-2">KRA</th>
                <th className="px-3 py-2 text-right">Weight</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2 text-right">Share</th>
                <th className="px-3 py-2 w-40">Effort vs weight</th>
              </tr>
            </thead>
            <tbody>
              {kras.map((k) => (
                <tr key={k.kra_id} className="border-b border-navy-50">
                  <td className="px-3 py-2">
                    <span className="font-semibold text-navy-900">{k.title}</span>
                    {/* An exclusion is stated with its reason, never a
                        silent hole in the denominator. */}
                    {!k.scorable && (
                      <span className="block text-[10px] text-navy-400 mt-0.5">
                        <Ban size={10} className="inline mr-1" />
                        not measured from timesheets{k.untracked_reason ? ` — ${k.untracked_reason}` : ''}
                      </span>
                    )}
                    {k.scorable && !k.hours && (
                      <span className="block text-[10px] text-amber-600 mt-0.5">
                        <AlertTriangle size={10} className="inline mr-1" />no logged work against this
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-navy-500">{k.weight}%</td>
                  <td className="px-3 py-2 text-right font-semibold">{k.hours || '—'}</td>
                  <td className="px-3 py-2 text-right">{k.hours ? `${k.share_pct}%` : '—'}</td>
                  <td className="px-3 py-2">
                    {k.scorable ? <ShareBar share={k.share_pct} target={k.weight} /> : null}
                  </td>
                </tr>
              ))}
              {!kras.length && (
                <tr><td colSpan="5" className="px-3 py-8 text-center text-navy-400">
                  No KRAs on this person's sheet for the current cycle.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* The items. */}
      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="lbl">What was logged{canMap ? ' — and which KRA it serves' : ''}</p>
          <span className="text-[10.5px] text-navy-400">
            {t.items} item{t.items === 1 ? '' : 's'} · {hrs(t.logged)} logged
            {!!t.excluded && ` · ${hrs(t.excluded)} excluded`}
          </span>
        </div>

        {!canMap && (
          <p className="text-[11px] text-navy-500">
            Your manager decides which KRA each item serves. Everything below is what they have
            recorded, and you see exactly the numbers they do.
          </p>
        )}

        <div className="space-y-2">
          {d.items.map((it) => {
            const dr = draft[it.item_key];
            // The chip follows the DRAFT once there is one. Showing the
            // saved state beside a dropdown that already says something
            // else makes the screen look like it disagrees with itself.
            const how = dr ? (dr.decision === 'excluded' ? 'excluded' : 'mapped') : it.how;
            const h = HOW[how] || HOW.unmapped;
            const Icon = h.icon;
            const decided = dr ? dr.decision : (it.how === 'mapped' ? 'kra' : it.how === 'excluded' ? 'excluded' : '');
            const chosenKra = dr && dr.decision === 'kra' ? dr.kra_id : it.kra_id || '';
            return (
              <div key={it.item_key} className={`rounded-lg border p-2.5 ${dr ? 'border-lagoon-300 bg-lagoon-50/40' : 'border-navy-100'}`}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="font-semibold text-xs text-navy-900 flex-1 min-w-0">
                    {it.item_label}
                    {it.item_id && <span className="ml-2 text-[10px] font-normal text-navy-400">{it.item_id}</span>}
                  </span>
                  <span className="text-xs font-semibold">{hrs(it.hours)}</span>
                  <span className="text-[10px] text-navy-400">{it.logs} log{it.logs === 1 ? '' : 's'}</span>
                  <span className={`chip ${h.chip} !text-[10px]`}>
                    <Icon size={10} className="inline mr-1" />{h.label}{dr ? ' · unsaved' : ''}
                  </span>
                </div>

                {it.kra_title && !dr && (
                  <p className="text-[10.5px] text-navy-500 mt-1">
                    <Target size={10} className="inline mr-1" />{it.kra_title}
                    {!!(it.matched_keywords || []).length &&
                      <span className="text-navy-400"> · matched {it.matched_keywords.join(', ')}</span>}
                  </p>
                )}
                {/* Why the engine refused to choose, shown rather than
                    hidden — it is the fastest way to see that two KRAs
                    carry overlapping keywords. */}
                {it.how === 'ambiguous' && (
                  <p className="text-[10.5px] text-amber-700 mt-1">
                    Matched {it.candidates.map((c) => c.kra_title).join(' and ')} — given to neither.
                  </p>
                )}
                {it.how === 'excluded' && it.note && (
                  <p className="text-[10.5px] text-navy-400 mt-1">{it.note}</p>
                )}
                {it.stale_mapping && (
                  <p className="text-[10.5px] text-amber-700 mt-1">
                    The KRA this was mapped to is no longer on the sheet, so the mapping was ignored.
                  </p>
                )}

                {/* NO SHEET, NO DROPDOWN. Offering "pick the KRA this
                    serves" over an empty list is how a manager concludes
                    the product is broken; the real fix is a KRA sheet,
                    and this says so instead of miming a control that
                    cannot work. */}
                {canMap && !kras.length && (
                  <p className="text-[10.5px] text-navy-500 mt-2">
                    There is nothing to map this to — this person has no KRAs on their sheet for the
                    current cycle. Their objectives have to exist before their hours can be placed
                    against them.
                  </p>
                )}
                {canMap && !!kras.length && (
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <select className="inp !text-xs !w-auto" value={decided === 'excluded' ? '__ex' : chosenKra}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return setItem(it.item_key, null);
                        if (v === '__ex') return setItem(it.item_key, { decision: 'excluded', kra_id: null, item_label: it.item_label, note: '' });
                        setItem(it.item_key, { decision: 'kra', kra_id: v, item_label: it.item_label, note: '' });
                      }}>
                      <option value="">— pick the KRA this serves —</option>
                      {/* A KRA somebody has declared NOT measurable from
                          timesheets is not offered as a destination for
                          timesheet hours. Offering it contradicts the
                          declaration, and hours parked there count
                          towards nobody's coverage — visible in the
                          shares and invisible in the coverage figure.
                          Un-mark the KRA first if that is really meant. */}
                      {kras.filter((k) => k.scorable || k.kra_id === it.kra_id)
                        .map((k) => (
                          <option key={k.kra_id} value={k.kra_id}>
                            {k.title}{k.scorable ? '' : ' (not measured from timesheets)'}
                          </option>
                        ))}
                      <option value="__ex">Not KRA work</option>
                    </select>
                    {/* The reason is required by the server too; asking
                        for it here as well means the manager is not told
                        off by a 422 after typing everything else. */}
                    {dr && dr.decision === 'excluded' && (
                      <input className="inp !text-xs flex-1 min-w-[220px]" value={dr.note || ''}
                        placeholder="Why is this not KRA work? (required)"
                        onChange={(e) => setItem(it.item_key, { note: e.target.value })} />
                    )}
                    {dr && <button className="text-[11px] text-navy-400 hover:text-navy-700"
                      onClick={() => setItem(it.item_key, null)}>undo</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {canMap && !!kras.length && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button className="btn-pri !text-xs" disabled={!pending || busy} onClick={save}>
              <Save size={12} className="inline mr-1" />
              {pending ? `Save ${pending} mapping${pending === 1 ? '' : 's'}` : 'Nothing to save'}
            </button>
            {!!pending && <button className="btn-sec !text-xs" disabled={busy} onClick={() => setDraft({})}>Discard</button>}
            <span className="text-[10.5px] text-navy-400">
              Saved together — if one is refused, none of them is written.
            </span>
          </div>
        )}
        {saveErr && <p className="text-xs text-rose-600">{saveErr}</p>}
      </div>

      {/* The value-add scan, with its evidence. Self-declared and
          gameable, so the defence is to show the text that triggered it
          rather than only the count. */}
      {!!(d.value_add.hits || []).length && (
        <div className="card p-4">
          <p className="lbl mb-1">Value-add mentions</p>
          <p className="text-[11px] text-navy-500 mb-2">
            Words from the org-wide list found in what was logged. <b>Read them, do not count them</b> —
            the text is written by the person being measured.
          </p>
          <div className="space-y-1">
            {d.value_add.hits.map((v) => (
              <div key={v.keyword} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="chip bg-lagoon-50 text-lagoon-700 !text-[10px]">{v.keyword}</span>
                <span className="text-navy-500">{hrs(v.hours)} · {v.logs} log{v.logs === 1 ? '' : 's'}</span>
                <span className="text-[10.5px] text-navy-400 flex-1 min-w-0 truncate">{v.examples.join(' · ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
