import { useEffect, useState } from 'react';
import { Sparkles, SlidersHorizontal, Download } from 'lucide-react';
import { api } from '../utils/api';
import { AiModal } from './AiDraftPanel';
import PageHead from '../PageHead';
import Grade from '../grade';
import SearchBox, { matches } from '../SearchBox';
import BellCurveChart from './BellCurveChart';
import { KittyPanel, BracketFilter, AllocationRow, Section, short } from './CalibrationKitty';

const NINE_BOX = ['low-low', 'low-mid', 'low-high', 'mid-low', 'mid-mid', 'mid-high', 'high-low', 'high-mid', 'high-high'];

export default function CalibrationPage() {
  const [q, setQ] = useState('');
  // A SEARCH PER SECTION, since 29 Sep when both became collapsible.
  // One shared box filtered both tables, and moving it inside the
  // Ratings panel would have left the allocation grid filtered by a
  // query nobody could see once that panel was folded away. Two boxes,
  // each inside the table it filters, cannot do that.
  const [qa, setQa] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // ---- the kitty (29 Sep) ------------------------------------------
  // Fetched SEPARATELY, and a 403 here is not an error on this page:
  // money is gated on pms_compensation while the rest of calibration is
  // pms_admin, so a user with one and not the other must still get the
  // ratings screen rather than a red box. `noComp` records which it was.
  const [kitty, setKitty] = useState(null);
  const [noComp, setNoComp] = useState(false);
  const [bracket, setBracket] = useState('all');

  const load = () => api('/pms/calibration').then(setData).catch(e => setErr(e.message));
  const loadKitty = (b = bracket) => api(`/pms/calibration/kitty?bracket=${b}`)
    .then((r) => { setKitty(r); setNoComp(false); })
    .catch((e) => { if (/pms_compensation/.test(e.message)) setNoComp(true); else setErr(e.message); });
  useEffect(() => { load(); }, []);
  useEffect(() => { loadKitty(bracket); }, [bracket]);

  const askBrief = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/agentic/calibration-brief', { method: 'POST' }); setBrief(r.draft); setBriefOpen(true); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  if (err && !data) return <p className="text-sm text-rose-600">{err}</p>;
  if (!data) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!data.cycle) return <div className="card p-8 text-center text-sm text-navy-400">No active cycle.</div>;

  const dist = data.distribution || {};
  const targets = data.cycle.bell_curve || {};

  // Filtered here rather than on the server: calibration is one

  // cycle's population, already loaded to draw the distribution

  // above, so a round trip per keystroke would buy nothing.

  const rowsShown = (data && data.rows ? data.rows : [])

    .filter(r => matches(q, r.name, r.department, r.adjustment_reason));

  // The allocation grid's own filter, on its own query. Same reasoning
  // as above: the rows are already loaded to compute the panel, so a
  // round trip per keystroke would buy nothing.
  const allocShown = (kitty && kitty.lines ? kitty.lines : [])
    .filter(l => matches(qa, l.name, l.department, l.designation, l.emp_code));

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Calibration" hue="amber">
        <span className="chip bg-purple-100 text-purple-700">{data.cycle.name}</span>
        <button className="btn-sec" disabled={busy} onClick={askBrief}><Sparkles size={13} className="inline mr-1 text-amber-500" />{busy ? 'Drafting…' : 'Session brief (agent)'}</button>
      </PageHead>
      {err && <p className="text-xs text-rose-600">{err}</p>}
      {/* The brief opens over the page rather than pushing the
          distribution and the rating table down — those are what the
          session is actually run against, and the brief is read once. */}
      {brief && !briefOpen && (
        <button className="text-[11px] font-semibold text-navy-600 hover:underline" onClick={() => setBriefOpen(true)}>
          Reopen the session brief
        </button>
      )}
      {brief && briefOpen && (
        <AiModal title="Calibration session brief" onClose={() => setBriefOpen(false)}>
          <p className="text-sm font-semibold">{brief.headline}</p>
          {(brief.deviations || []).length > 0 && (
            <div><p className="font-semibold text-navy-500">Deviations</p>
              <ul className="list-disc pl-4">{brief.deviations.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
          )}
          {(brief.discussion_points || []).length > 0 && (
            <div><p className="font-semibold text-navy-500">Discuss</p>
              <ul className="list-disc pl-4">{brief.discussion_points.map((d, i) => <li key={i}>{d}</li>)}</ul></div>
          )}
          {brief.outstanding && <p className="text-amber-700">{brief.outstanding}</p>}
        </AiModal>
      )}
      {/* THE BELL CURVE, always on the page (7 Oct): "bell curve is
          missing on this page, please bring back the bell curve
          distribution and should be displayed in graph as per percentage
          range." It had been shown only while the kitty was absent, on the
          reasoning that the kitty's grade table carried the same counts —
          but the kitty is set on almost every cycle, so in practice the
          distribution vanished. It is the picture a calibration session
          is run against, so it is not optional. */}
      <div className="card p-4">
        <p className="lbl">Distribution vs bell-curve targets</p>
        <BellCurveChart distribution={dist} targets={targets} scale={data.cycle.rating_scale || []} />
      </div>

      {noComp && (
        <p className="text-[11.5px] text-navy-500 bg-navy-50 rounded-lg px-3 py-2">
          The kitty and budget panel needs the <b>pms_compensation</b> permission, which is granted
          separately from the rest of HR so that salary can be withheld without withholding this page.
        </p>
      )}

      {kitty && !noComp && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <BracketFilter value={bracket} onChange={setBracket} threshold={kitty.bracket_threshold} />
            <span className="text-[11px] text-navy-400">
              {kitty.counts.employees} of {kitty.counts.of_total} shown
            </span>
          </div>
          <KittyPanel view={kitty} onSaved={() => loadKitty()} onError={setErr} />
        </>
      )}
      {/* Collapsible since 29 Sep, like the two money sections: three
          full-width blocks down one scroll was more page than anybody
          needed at once. */}
      <Section id="ratings" title="Ratings & adjustments"
        summary={`${rowsShown.length} ${rowsShown.length === 1 ? 'person' : 'people'}`}>
      <div className="mb-3">
        <SearchBox value={q} onChange={setQ} placeholder="Search by employee, department or adjustment reason…"
          shown={rowsShown.length} total={(data && data.rows ? data.rows : []).length} />
      </div>
      <div className="overflow-x-auto">
        {/* table-fixed + explicit widths on the header row: with auto
            layout, the browser infers each column's width from ALL rows
            (including the wide colSpan=8 adjustment-reason row below),
            which could shift column boundaries in ways not visible just
            from reading the code. Fixed layout makes widths deterministic
            from these header cells alone — every other row, including
            that spanning one, has to respect them. */}
        <table className="w-full text-xs table-fixed">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr>
              <th className="text-left px-3 py-2 w-[16%]">Employee</th>
              <th className="text-left px-3 py-2 w-[10%]">Dept</th>
              <th className="text-right px-3 py-2 w-[8%]">Mgr</th>
              <th className="text-right px-3 py-2 w-[12%]">HOD</th>
              <th className="text-right px-3 py-2 w-[12%]">Final Rating</th>
              {/* CONTEXT, NOT AN INPUT. The header says so, because a
                  column sitting next to Final Rating will be read as
                  feeding it unless it says otherwise. */}
              <th className="text-left px-3 py-2 w-[14%]">Timesheet <span className="normal-case font-normal">(context)</span></th>
              <th className="text-left px-3 py-2 w-[14%]">9-box</th>
              <th className="text-left px-3 py-2 w-[22%]">Adjust Rating</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {rowsShown.map(r => <CalRow key={r.employee_id} r={r} reload={load} scale={data.cycle.rating_scale}
              ts={(data.timesheet || {})[r.employee_id]} />)}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-navy-400">Every adjustment requires a reason — it is the permanent answer to "why did my rating change".</p>
      {/* Verbatim from the server, so the screen cannot soften it. */}
      {data.timesheet_note && (
        <p className="text-[11px] text-navy-500 mt-1"><b>Timesheet:</b> {data.timesheet_note}</p>
      )}
      </Section>

      {/* ---- the allocation grid (29 Sep) ----------------------------
          Below the rating table rather than merged into it: the rating
          conversation and the money conversation happen in that order,
          and a single table carrying both would be twenty columns wide
          before anybody could read either. */}
      {kitty && !noComp && (
        <Section id="allocation" title="Increment allocation"
          summary={`${allocShown.length} ${allocShown.length === 1 ? 'person' : 'people'} · ${short(kitty.total_spend)} allocated`}
          actions={(
            <a className="btn-sec !py-1" href={`/api/v1/pms/calibration/export?bracket=${bracket}&token=${encodeURIComponent(localStorage.getItem('apms_token') || '')}`}>
              <Download size={12} className="inline mr-1" />Export to Excel
            </a>
          )}>
          <div className="mb-3">
            <SearchBox value={qa} onChange={setQa} placeholder="Search by employee, code, designation or department…"
              shown={allocShown.length} total={kitty.lines.length} />
          </div>
          <div className="overflow-x-auto">
          {kitty.counts.ctc_missing > 0 && kitty.counts.ctc_missing === kitty.counts.employees && (
            // The state the client instance is actually in today: 1,427
            // people and no salary on record for any of them. An empty
            // state that says so beats a grid of dashes and zeros.
            <p className="px-3 pb-3 text-[11.5px] text-amber-800">
              No CTC is on record for anybody here, so every figure below is blank rather than zero.
              Upload compensation on the Increment Simulation page and these fill in.
            </p>
          )}
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr>
                <th className="text-left px-2 py-2">Employee</th>
                <th className="text-left px-2 py-2">Dept / Delivery head</th>
                <th className="text-left px-2 py-2">Grade</th>
                <th className="text-right px-2 py-2">Current CTC</th>
                <th className="text-left px-2 py-2">Status</th>
                <th className="text-right px-2 py-2">Std %</th>
                <th className="text-right px-2 py-2">Mkt %</th>
                <th className="text-right px-2 py-2">Promo %</th>
                <th className="text-right px-2 py-2">Reten %</th>
                <th className="text-right px-2 py-2">Total %</th>
                <th className="text-right px-2 py-2">Revised CTC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {allocShown.map(l => (
                <AllocationRow key={l.employee_id} line={l} bracket={bracket}
                  currency={kitty.currency}
                  onSaved={(r) => setKitty(k => ({ ...k, ...r }))}
                  onError={setErr} />
              ))}
            </tbody>
          </table>
          </div>
          <p className="pt-3 text-[11px] text-navy-400">
            Open a row to set a market correction, a promotion or a retention offer — each needs its
            reason, the same way a rating adjustment does. <b>*</b> marks a standard hike overridden
            from the band.
          </p>
        </Section>
      )}
    </div>
  );
}

function CalRow({ r, reload, scale, ts }) {
  const [to, setTo] = useState('');
  const [box, setBox] = useState(r.nine_box_cell || '');
  const [err, setErr] = useState(null);
  const adjust = async () => {
    const reason = prompt(`Adjust ${r.name} from ${r.proposed} to ${to}. Reason (required):`);
    if (!reason || !reason.trim()) return;
    try {
      await api('/pms/calibration/adjust', { method: 'POST', body: JSON.stringify({ employee_id: r.employee_id, from_rating: r.proposed, to_rating: Number(to), reason }) });
      setTo(''); reload();
    } catch (e) { setErr(e.message); }
  };
  const saveBox = async (v) => {
    setBox(v);
    try { await api('/pms/calibration/top-talent', { method: 'POST', body: JSON.stringify({ employee_id: r.employee_id, nine_box_cell: v || null }) }); }
    catch (e) { setErr(e.message); }
  };
  // Requested: the adjustment reason typed into the prompt was saved but
  // never shown again anywhere on this page. A badge next to Proposed
  // makes it visible AT A GLANCE that a number differs from the raw
  // manager/DH inputs, and the reason itself is shown directly below the
  // row — not hidden behind a hover or another click, since the whole
  // point raised was that this information was missing from view.
  const preAdjustment = r.hod_rating ?? r.manager_rating;
  const wasAdjusted = r.adjustment_reason && preAdjustment != null && r.proposed != null && Number(r.proposed) !== Number(preAdjustment);

  return (
    <>
      <tr className={wasAdjusted ? 'bg-amber-50/40' : ''}>
        <td className="px-3 py-2 font-semibold">{r.name}</td>
        <td className="px-3 py-2">{r.department || '—'}</td>
        <td className="px-3 py-2 text-right font-mono"><Grade value={r.manager_rating} scale={scale} /></td>
        <td className="px-3 py-2 text-right font-mono"><Grade value={r.hod_rating} scale={scale} /></td>
        <td className="px-3 py-2 text-right font-mono font-bold"><Grade value={r.proposed} scale={scale} /></td>
        {/* THE TIMESHEET ROLLUP. Deliberately not a grade and not a
            number in the same typeface as the ratings beside it: it is
            a statement about how much evidence there is, which is all
            this can honestly support while most logged hours are
            unplaced. */}
        <td className="px-3 py-2">
          {!ts ? <span className="text-[10.5px] text-navy-300">no closed month</span> : (
            <>
              <div className="text-[10.5px] text-navy-600">{ts.label}</div>
              <div className="text-[10px] text-navy-400 mt-0.5">
                {ts.hours}h · {ts.months} of {ts.periods_in_cycle || '?'} months
                {ts.weighted_coverage_pct != null && <> · {ts.weighted_coverage_pct}% KRA coverage</>}
              </div>
              {/* An overridden month is named here, because by the time
                  this reaches calibration the override IS the number. */}
              {!!ts.overrides && (
                <div className="text-[10px] text-amber-700 mt-0.5">
                  {ts.overrides} month{ts.overrides === 1 ? '' : 's'} overridden by a manager
                </div>
              )}
            </>
          )}
        </td>
        <td className="px-3 py-2">
          <select className="inp !py-1 !text-[11px] w-auto" value={box} onChange={e => saveBox(e.target.value)}>
            <option value="">—</option>{NINE_BOX.map(b => <option key={b}>{b}</option>)}
          </select>
          {/* The manager's own read on potential, recorded with their
              evaluation (migration 043). Shown as the starting point for
              this conversation, not as the answer: calibration still sets
              the cell, and the two are kept apart so "why did this change"
              stays answerable. */}
          {r.manager_potential && (
            <div className="text-[10px] text-navy-400 mt-1">
              manager: <b className="text-violet-700">{r.manager_potential}</b> potential
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1">
            <input className="inp w-14 !py-1 text-right" type="number" step="0.5" min="1" max="5" value={to} onChange={e => setTo(e.target.value)} />
            <button className="btn-sec !py-1" disabled={!to} onClick={adjust}><SlidersHorizontal size={12} /></button>
          </span>
          {err && <p className="text-[10px] text-rose-600">{err}</p>}
        </td>
      </tr>
      {/* Simplified per direct request: badge removed from Final Rating,
          and this row now shows just "adjusted X -> Y" instead of the
          reason/adjusted-by/date inline. That detail isn't thrown away —
          it's on the title attribute, so it's still reachable on hover
          rather than gone from the page entirely. */}
      {wasAdjusted && (
        <tr className="bg-amber-50/40">
          {/* Eight columns since the Timesheet one was added (phase 4).
              A stale colSpan here leaves the reason row narrower than
              the table and pushes an empty cell onto the end. */}
          <td colSpan={8} className="px-3 pb-2 -mt-1">
            <p className="text-[11px] text-amber-800" title={`${r.adjustment_reason} — ${r.adjusted_by}${r.adjusted_at ? `, ${new Date(r.adjusted_at).toLocaleDateString()}` : ''}`}>
              adjusted <b>{preAdjustment} → {r.proposed}</b>
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
