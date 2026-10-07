// HR tab → Timesheet.
//
// Asked for on 25 Sep: "under 'HR' tab dashboard for all employees
// should be available." Same dashboard as the Manager tab, across the
// whole company, with a department filter and a search — and one thing
// the Manager page does not need: the settings that decide what Green
// means, which are tenant-wide and belong to HR.
//
// COVERAGE IS STATED BEFORE THE RATINGS, the same rule the Competency
// Dashboard follows. On day one 1,398 people have uploaded nothing;
// counting them as Red would make the headline meaningless and send HR
// after a problem that is really "the feature is new".
import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import TimesheetDashboard from '../TimesheetDashboard';
import TimesheetTabs from '../TimesheetTabs';
import TimesheetKra from '../TimesheetKra';
import KraRatingSettings from '../KraRatingSettings';
import { TimesheetRoster } from './TeamTimesheetPage';
import SearchBox from '../SearchBox';
import {
  Users, CheckCircle2, AlertTriangle, XCircle, Clock, ChevronLeft, SlidersHorizontal, Save,
  Link2Off, Target, ClipboardList, Lock, FileSearch,
} from 'lucide-react';
import Kpi from '../Kpi';

// ---- closing a period, and the year-end rollup (phase 4) --------------
//
// PREVIEW FIRST, ALWAYS. Closing writes the numbers that reach
// calibration, and it is the one action in this feature that would be
// genuinely awkward to undo. The server defaults dry_run to true; this
// screen makes that visible by refusing to offer Close until a preview
// has been run, and dropping the preview the moment the period changes.
//
// The same safety rail as the KRA keyword bulk editor, for the same
// reason.
function ClosePeriod({ windows, onClosed }) {
  const [win, setWin] = useState('');
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  const chosen = (windows || []).find((w) => w.from === win) || null;
  const pick = (v) => { setWin(v); setPrev(null); setErr(null); setDone(null); };

  const run = async (dry) => {
    if (!chosen) return;
    setBusy(true); setErr(null);
    try {
      const r = await api('/pms/timesheet/kra/close', {
        method: 'POST',
        body: JSON.stringify({ from: chosen.from, to: chosen.to, dry_run: dry }),
      });
      if (dry) { setPrev(r); setDone(null); }
      else { setPrev(null); setDone(r); onClosed(); }
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  return (
    <div className="card p-4 space-y-2">
      <p className="lbl"><Lock size={12} className="inline mr-1" />Close a period</p>
      <p className="text-[11px] text-navy-500">
        Closing settles everybody who logged time in that period: the numbers are snapshotted with
        the configuration that produced them and <b>stop moving</b>, which is what makes them safe
        to carry into calibration. A period that is not over yet cannot be closed.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="inp !text-xs !w-auto" value={win} onChange={(e) => pick(e.target.value)}>
          <option value="">— pick a period —</option>
          {(windows || []).map((w) => (
            <option key={w.from} value={w.from}>{w.from} – {w.to} · {w.hours}h</option>
          ))}
        </select>
        <button className="btn-sec !py-1 !text-xs" disabled={!chosen || busy} onClick={() => run(true)}>
          <FileSearch size={12} className="inline mr-1" />Preview
        </button>
        {/* Dead until a preview has run, and it says which. */}
        {prev ? (
          <button className="btn-pri !py-1 !text-xs" disabled={busy} onClick={() => run(false)}>
            {/* N PEOPLE, ONE PERIOD. The first version read "Close 3
                months", which describes something this button has never
                done — a close settles one period for everybody who
                logged time in it. */}
            <Lock size={12} className="inline mr-1" />
            Close for {prev.would_close} {prev.would_close === 1 ? 'person' : 'people'}
          </button>
        ) : (
          <button className="btn-pri !py-1 !text-xs" disabled title="Run a preview first">Preview first</button>
        )}
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}
      {done && (
        <p className="text-[11.5px] text-teal-700">
          Settled {done.closed} {done.closed === 1 ? 'person' : 'people'} for {done.window.from} – {done.window.to}.
          {!!(done.skipped || []).length && <> {done.skipped.length} skipped.</>}
        </p>
      )}

      {prev && (
        <div className="rounded-lg border border-navy-100 p-3 space-y-2">
          <p className="text-[11.5px] font-semibold text-navy-900">
            {prev.would_close} {prev.would_close === 1 ? 'person' : 'people'} would be settled for{' '}
            {chosen && `${chosen.from} – ${chosen.to}`} · nothing saved yet
            {!!(prev.skipped || []).length && (
              <span className="font-normal text-navy-500"> · {prev.skipped.length} already closed</span>
            )}
          </p>
          {!prev.would_close && (
            <p className="text-[11px] text-navy-400">
              Nobody logged time in that period, or every one of them is already closed.
            </p>
          )}
          {!!prev.would_close && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                    <th className="px-2 py-1">Employee</th>
                    <th className="px-2 py-1 text-right">Hours</th>
                    <th className="px-2 py-1 text-right">Placed</th>
                    <th className="px-2 py-1 text-right">Coverage</th>
                    <th className="px-2 py-1 text-right">Compliance</th>
                    <th className="px-2 py-1 text-right">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {prev.rows.map((r) => (
                    <tr key={r.employee.id} className="border-b border-navy-50">
                      <td className="px-2 py-1">{r.employee.name}
                        <span className="block text-[10px] text-navy-400">{r.employee.department || '—'}</span></td>
                      <td className="px-2 py-1 text-right">{r.hours}</td>
                      <td className={`px-2 py-1 text-right ${r.mapped_pct < 50 ? 'text-rose-600' : ''}`}>{r.mapped_pct}%</td>
                      <td className="px-2 py-1 text-right">{r.coverage_pct == null ? '—' : `${r.coverage_pct}%`}</td>
                      <td className="px-2 py-1 text-right">{r.compliance_pct == null ? '—' : `${r.compliance_pct}%`}</td>
                      <td className="px-2 py-1 text-right">
                        {r.score == null
                          ? <span className="text-navy-300">no score · {r.withheld} reason{r.withheld === 1 ? '' : 's'}</span>
                          : <b>{r.grade || r.score}</b>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The year-end view, from the settled months. Read-only: the numbers
// come from snapshots and the only way to change one is to override the
// month it came from, which is done on that person's own page.
function Rollup({ reloadKey }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { setD(null); api('/pms/timesheet/kra/rollup').then(setD).catch((e) => setErr(e.message)); }, [reloadKey]);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return null;
  const people = (d.people || []).filter((p) => {
    if (!q.trim()) return true;
    const x = q.trim().toLowerCase();
    return [p.employee.name, p.employee.emp_code, p.employee.department]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(x));
  });
  if (!(d.people || []).length) {
    return (
      <div className="card p-4">
        <p className="lbl mb-1">Year-end rollup</p>
        <p className="text-[11.5px] text-navy-400">
          Nothing is settled for this cycle yet. Close a period above and it appears here.
        </p>
      </div>
    );
  }
  const t = d.totals || {};
  return (
    <div className="card p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="lbl">Year-end rollup · {d.cycle && d.cycle.name}</p>
        <SearchBox value={q} onChange={setQ} placeholder="Search a person"
          shown={people.length} total={d.people.length} />
      </div>
      <p className="text-[11px] text-navy-500">
        {t.periods_closed} of {d.periods_in_cycle} periods closed · {t.hours}h settled ·{' '}
        <b>{t.readable}</b> of {t.people} thick enough to read
        {!!t.overrides && <> · {t.overrides} month{t.overrides === 1 ? '' : 's'} overridden</>}.
        Percentages are weighted by the hours behind them, not averaged across months.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
              <th className="px-2 py-1.5">Employee</th>
              <th className="px-2 py-1.5">Department</th>
              <th className="px-2 py-1.5 text-right">Months</th>
              <th className="px-2 py-1.5 text-right">Hours</th>
              <th className="px-2 py-1.5 text-right">Placed</th>
              <th className="px-2 py-1.5 text-right">Coverage</th>
              <th className="px-2 py-1.5">Reads as</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.employee.id} className="border-b border-navy-50">
                <td className="px-2 py-1.5 font-semibold">{p.employee.name}</td>
                <td className="px-2 py-1.5 text-navy-500">{p.employee.department || '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  {p.rollup.months}
                  <span className="text-[10px] text-navy-400"> / {p.rollup.periods_in_cycle}</span>
                </td>
                <td className="px-2 py-1.5 text-right">{p.rollup.hours}</td>
                <td className={`px-2 py-1.5 text-right ${p.rollup.mapped_pct != null && p.rollup.mapped_pct < 50 ? 'text-rose-600' : ''}`}>
                  {p.rollup.mapped_pct == null ? '—' : `${p.rollup.mapped_pct}%`}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {p.rollup.weighted_coverage_pct == null ? '—' : `${p.rollup.weighted_coverage_pct}%`}
                </td>
                <td className="px-2 py-1.5 text-[10.5px] text-navy-600">
                  {p.rollup.label}
                  {!!p.rollup.overrides && (
                    <span className="block text-[10px] text-amber-700">
                      {p.rollup.overrides} overridden
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-navy-400">
        This is context for a calibration conversation. It does not feed the proposed rating, the
        distribution or the increment kitty.
      </p>
    </div>
  );
}

// The mapping backlog.
//
// READ FROM ONE AGGREGATE QUERY, not from a report per person. The
// manager roster builds a full report for each reportee, which is right
// for six people and would be several thousand queries for the client's
// 1,427. HR's question at this stage is not "what is everyone's score",
// it is "how much of the logged work has been placed, and who still
// needs a mapping session".
function Backlog({ onOpen }) {
  const [b, setB] = useState(null);
  // Bumped when a period is closed, so the backlog and the rollup both
  // re-read rather than showing what was true a moment ago.
  const [closedAt, setClosedAt] = useState(0);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  // Same period control as the per-person view, for the same reason: a
  // timesheet is uploaded after the month it covers, so the calendar's
  // current cycle is empty for most of its length.
  const [win, setWin] = useState(null);
  useEffect(() => {
    setB(null);
    api(`/pms/timesheet/kra/backlog${win ? `?from=${win.from}&to=${win.to}` : ''}`)
      .then(setB).catch((e) => setErr(e.message));
  }, [win && win.from, closedAt]);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!b) return <p className="text-sm text-navy-400">Loading…</p>;
  const t = b.totals;
  const Period = () => (!(b.windows || []).length ? null : (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-navy-400">Period</span>
      <select className="inp !text-xs !w-auto" value={b.window.from}
        onChange={(e) => {
          const w = (b.windows || []).find((x) => x.from === e.target.value);
          if (w) setWin({ from: w.from, to: w.to });
        }}>
        {!(b.windows || []).some((w) => w.from === b.window.from) && (
          <option value={b.window.from}>{b.window.from} – {b.window.to} · nothing logged</option>
        )}
        {(b.windows || []).map((w) => (
          <option key={w.from} value={w.from}>{w.from} – {w.to} · {w.hours}h</option>
        ))}
      </select>
    </div>
  ));
  if (!t.people) {
    return (
      <div className="space-y-3">
        <Period />
        <ClosePeriod windows={b.windows} onClosed={() => setClosedAt((n) => n + 1)} />
        <Rollup reloadKey={closedAt} />
        <div className="card p-8 text-center text-sm text-navy-400">
          Nobody logged time in {b.window.from} – {b.window.to}
          {(b.windows || []).length ? '. Pick a period above that has logs.' : ', so there is nothing to map yet.'}
        </div>
      </div>
    );
  }
  const rows = b.people.filter((r) => {
    if (!q.trim()) return true;
    const x = q.trim().toLowerCase();
    return [r.employee.name, r.employee.emp_code, r.employee.department, r.employee.designation]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(x));
  });
  return (
    <div className="space-y-4">
      <Period />
      <ClosePeriod windows={b.windows} onClosed={() => setClosedAt((n) => n + 1)} />
      <Rollup reloadKey={closedAt} />
      <div className="kpirow">
        <Stat icon={Target} hue="violet" n={`${t.mapped_pct}%`} label="Hours placed"
          sub={`${t.mapped_hours} of ${t.hours} logged`} />
        <Stat icon={Link2Off} hue="amber" n={t.unmapped_items} label="Items unplaced"
          sub={`of ${t.items} logged in this window`} />
        <Stat icon={ClipboardList} hue="lagoon" n={t.needing_mapping} label="Need a mapping session"
          sub={`of ${t.people} who logged time`} />
        <Stat icon={AlertTriangle} hue="red" n={t.without_kras} label="No KRAs"
          sub="logged time with nothing to credit it to" />
      </div>

      {/* The cap on this whole feature, stated rather than implied. */}
      {!!t.without_kras && (
        <p className="card p-3 text-[11.5px] text-navy-600 border-l-4 border-rose-400">
          <b>{t.without_kras}</b> {t.without_kras === 1 ? 'person has' : 'people have'} logged time but
          {t.without_kras === 1 ? ' has' : ' have'} no KRAs on their sheet for this cycle. Their hours cannot
          be placed against anything until they do — that is a KRA problem, not a mapping one.
        </p>
      )}

      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <p className="lbl">Who needs a mapping session</p>
          <SearchBox value={q} onChange={setQ} placeholder="Search a person"
            shown={rows.length} total={b.people.length} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                <th className="px-3 py-2">Employee</th>
                <th className="px-3 py-2">Department</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Unplaced</th>
                <th className="px-3 py-2">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.employee.id} onClick={() => onOpen(r.employee)}
                  className="border-b border-navy-50 cursor-pointer hover:bg-navy-50/60">
                  <td className="px-3 py-2">
                    <span className="font-semibold text-navy-900">{r.employee.name}</span>
                    <span className="block text-navy-400">{r.employee.designation || '—'}</span>
                  </td>
                  <td className="px-3 py-2 text-navy-500">{r.employee.department || '—'}</td>
                  <td className="px-3 py-2 text-right">{r.hours}</td>
                  <td className="px-3 py-2 text-right">{r.items}</td>
                  <td className={`px-3 py-2 text-right ${r.unmapped_items ? 'text-rose-600 font-semibold' : 'text-navy-400'}`}>
                    {r.unmapped_items}
                  </td>
                  <td className="px-3 py-2">
                    {!r.has_kras
                      ? <span className="chip bg-rose-50 text-rose-600 !text-[10px]">no KRAs</span>
                      : r.unmapped_items
                        ? <span className="chip bg-amber-100 text-amber-700 !text-[10px]">{r.unmapped_items} to place</span>
                        : <span className="chip bg-teal-100 text-teal-700 !text-[10px]">fully placed</span>}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan="6" className="px-3 py-8 text-center text-navy-400">Nobody matches that search.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// The main Dashboard's card (../Kpi.jsx) — the old white stat tile was
// replaced on 7 Oct so every dashboard reads the same.
function Stat(props) {
  return <Kpi {...props} />;
}

function Settings({ settings, onSaved }) {
  const [s, setS] = useState({
    cycle_start_day: settings.cycle_start_day,
    green_pct: settings.green_pct,
    amber_pct: settings.amber_pct,
    holidays: (settings.holidays || []).join(', '),
  });
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null); setMsg(null);
    try {
      const r = await api('/pms/timesheet/settings', { method: 'PUT', body: JSON.stringify(s) });
      setMsg('Saved.'); onSaved(r.settings);
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="card p-4 space-y-2">
      <p className="lbl"><SlidersHorizontal size={12} className="inline mr-1" />What Green means</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[11px] text-navy-500">Cycle starts on day
          <input type="number" min="1" max="28" className="inp !py-1 !px-2 w-20 mt-0.5"
            value={s.cycle_start_day}
            onChange={(e) => setS({ ...s, cycle_start_day: Number(e.target.value) })} />
        </label>
        <label className="text-[11px] text-navy-500">Green at or above (%)
          <input type="number" min="0" max="100" className="inp !py-1 !px-2 w-20 mt-0.5"
            value={s.green_pct} onChange={(e) => setS({ ...s, green_pct: Number(e.target.value) })} />
        </label>
        <label className="text-[11px] text-navy-500">Amber at or above (%)
          <input type="number" min="0" max="100" className="inp !py-1 !px-2 w-20 mt-0.5"
            value={s.amber_pct} onChange={(e) => setS({ ...s, amber_pct: Number(e.target.value) })} />
        </label>
        <label className="text-[11px] text-navy-500 flex-1 min-w-[260px]">Holidays — YYYY-MM-DD, comma separated
          <input className="inp !py-1 !px-2 mt-0.5" value={s.holidays}
            placeholder="2026-10-02, 2026-11-01"
            onChange={(e) => setS({ ...s, holidays: e.target.value })} />
        </label>
        <button className="btn-pri" onClick={save}><Save size={13} className="inline mr-1" />Save</button>
      </div>
      <p className="text-[11px] text-navy-400">
        These apply to every timesheet report in the product — the employee's own page and the
        manager's list read the same thresholds, so nobody sees a different rating from anybody
        else. A holiday is not counted as a working day, and a log on one is reported separately
        rather than being counted towards compliance.
      </p>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
    </div>
  );
}

export default function HrTimesheetPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [report, setReport] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState('compliance');

  const load = () => api(`/pms/timesheet/all${dept ? `?department=${encodeURIComponent(dept)}` : ''}`)
    .then(setD).catch((e) => setErr(e.message));
  useEffect(() => { setD(null); load(); }, [dept]);
  useEffect(() => {
    if (!open) { setReport(null); return; }
    setReport(null);
    api(`/pms/timesheet/employee/${open.id}`).then(setReport).catch((e) => setErr(e.message));
  }, [open]);

  if (err && !d) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  if (open) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <PageHead title={open.name} hue="violet"
          sub={[open.designation, open.department].filter(Boolean).join(' · ')}>
          <button className="btn-sec" onClick={() => setOpen(null)}>
            <ChevronLeft size={13} className="inline mr-1" />Back to everyone
          </button>
        </PageHead>
        <TimesheetTabs value={view} onChange={setView} />
        {view === 'kra'
          ? <TimesheetKra employeeId={open.id} canMap />
          : report ? <TimesheetDashboard report={report} /> : <p className="text-sm text-navy-400">Loading…</p>}
      </div>
    );
  }

  const t = d.totals || {};
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <PageHead title="Timesheet Dashboard" hue="violet"
        sub="Timesheet compliance across the organisation.">
        <select className="inp !py-1 !px-2 text-xs w-auto !text-navy-800" value={dept}
          onChange={(e) => setDept(e.target.value)}>
          <option value="">Every department</option>
          {(d.departments || []).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <button className="btn-sec" onClick={() => setShowSettings((v) => !v)}>
          <SlidersHorizontal size={13} className="inline mr-1" />{showSettings ? 'Hide settings' : 'Settings'}
        </button>
      </PageHead>

      {showSettings && <Settings settings={d.settings} onSaved={() => load()} />}
      {showSettings && <KraRatingSettings />}

      <TimesheetTabs value={view} onChange={setView} />
      {view === 'kra' ? <Backlog onOpen={setOpen} /> : <>
      <div className="kpirow">
        <Stat icon={Users} hue="violet" n={t.employees ?? 0} label="Employees in scope"
          sub={`${t.with_data ?? 0} have uploaded`} />
        <Stat icon={CheckCircle2} hue="leaf" n={t.green ?? 0} label="Green" />
        <Stat icon={AlertTriangle} hue="amber" n={t.amber ?? 0} label="Amber" />
        <Stat icon={XCircle} hue="red" n={t.red ?? 0} label="Red" />
        <Stat icon={Clock} hue="navy" n={t.hours ?? 0} label="Hours logged" sub="across everyone" />
      </div>

      {!!t.no_data && (
        <p className="card p-3 text-[11.5px] text-navy-600 border-l-4 border-amber2-500">
          <b>Read the ratings against the coverage.</b> {t.no_data} of {t.employees} people
          {dept ? ` in ${dept}` : ''} have uploaded nothing yet, so they carry no rating at all —
          they are not Red. Green, Amber and Red above describe the {t.with_data} who have.
        </p>
      )}

      <TimesheetRoster rows={d.employees || []} onOpen={setOpen} q={q} setQ={setQ} showDepartment />
      </>}
    </div>
  );
}
