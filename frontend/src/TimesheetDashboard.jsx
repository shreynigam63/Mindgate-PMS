// The timesheet compliance dashboard, shared by all three tabs.
//
// This is the client's own dashboard (attached 25 Sep as an HTML file)
// rebuilt as a component: the same maths, the same five tiles, the same
// bar-per-cycle chart, the same calendar and the same log table — in
// this app's palette and reading its numbers from the server instead of
// from a copy of the export baked into the page.
//
// THE NUMBERS ARE NOT COMPUTED HERE. Filled %, the rating and the day
// states all arrive from /pms/timesheet/*, which runs timesheet-rules.js.
// The house rule is that deterministic numbers are computed once, in one
// place; a second implementation in the browser is how a dashboard and
// an export come to disagree.
import { useState } from 'react';
import {
  CalendarCheck, CalendarX, Clock, Gauge, CheckCircle2, XCircle, AlertTriangle,
} from 'lucide-react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const d = (iso) => { const [y, m, day] = String(iso).split('-').map(Number); return new Date(y, m - 1, day); };
export const fmtDate = (iso) => { const x = d(iso); return `${String(x.getDate()).padStart(2, '0')} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`; };
const fmtShort = (iso) => { const x = d(iso); return `${String(x.getDate()).padStart(2, '0')} ${MONTHS[x.getMonth()]}`; };
export const cycleLabel = (c) => `${fmtShort(c.start)} – ${fmtDate(c.end)}`;

export const RATING_CHIP = {
  Green: 'bg-emerald-100 text-emerald-700',
  Amber: 'bg-amber-100 text-amber-700',
  Red: 'bg-rose-100 text-rose-700',
};
const RATING_BAR = { Green: '#10b981', Amber: '#f59e0b', Red: '#e11d48' };

export function RatingChip({ rating, children }) {
  const Icon = rating === 'Green' ? CheckCircle2 : rating === 'Amber' ? AlertTriangle : XCircle;
  return (
    <span className={`chip ${RATING_CHIP[rating] || 'bg-navy-50 text-navy-500'}`}>
      <Icon size={11} className="inline mr-1 -mt-px" />{children || rating}
    </span>
  );
}

function Stat({ icon: Icon, hue, n, label, sub }) {
  return (
    <div className="stat">
      <span className={`stat-i si-${hue}`}><Icon size={22} /></span>
      <span className="stat-t">
        <span className="stat-l">{label}</span>
        <span className="stat-n">{n}</span>
        {sub && <span className="block text-[10.5px] text-navy-400 mt-0.5">{sub}</span>}
      </span>
    </div>
  );
}

// Filled % per cycle. An SVG rather than a chart library: seven bars, two
// threshold lines, and nothing here is worth 40kB of dependency.
function CycleChart({ cycles, green, amber, selected, onSelect }) {
  const W = 880; const H = 230; const m = { l: 40, r: 14, t: 16, b: 42 };
  const iw = W - m.l - m.r; const ih = H - m.t - m.b;
  const n = cycles.length || 1;
  const bw = Math.min(58, (iw / n) * 0.5);
  const y = (v) => m.t + ih - (v / 100) * ih;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label="Filled percentage per cycle">
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="#e6ebf2" />
          <text x={m.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#8ea0b8">{v}%</text>
        </g>
      ))}
      {[[green, `Green ${green}%`], [amber, `Amber ${amber}%`]].map(([v, t]) => (
        <g key={t}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="#64748b" strokeDasharray="4 4" />
          <text x={W - m.r} y={y(v) - 4} textAnchor="end" fontSize="10" fill="#64748b">{t}</text>
        </g>
      ))}
      {cycles.map((c, i) => {
        const cx = m.l + (iw / n) * (i + 0.5);
        const top = y(c.pct);
        return (
          <g key={c.start} onClick={() => onSelect(i)} style={{ cursor: 'pointer' }}>
            <rect x={m.l + (iw / n) * i} y={m.t} width={iw / n} height={ih} fill="transparent" />
            <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(0, m.t + ih - top)} rx="3"
              fill={RATING_BAR[c.rating]} fillOpacity={c.in_progress ? 0.55 : 1}
              stroke={selected === i ? '#0f2647' : 'none'} strokeWidth="2" />
            <text x={cx} y={top - 5} textAnchor="middle" fontSize="11" fontWeight="600" fill="#0f2647">{Math.round(c.pct)}%</text>
            <text x={cx} y={H - m.b + 15} textAnchor="middle" fontSize="10" fill="#5b6b82">{fmtShort(c.start)} – {fmtShort(c.end)}</text>
            <text x={cx} y={H - m.b + 28} textAnchor="middle" fontSize="9" fill="#8ea0b8">
              {d(c.end).getFullYear()}{c.in_progress ? ' · in progress' : ''}
            </text>
          </g>
        );
      })}
      <line x1={m.l} x2={W - m.r} y1={m.t + ih} y2={m.t + ih} stroke="#c7d2e0" />
    </svg>
  );
}

const DAY_STYLE = {
  filled: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  missing: 'bg-rose-50 border-rose-200 text-rose-800',
  weekend: 'bg-navy-50 border-navy-100 text-navy-400',
  holiday: 'bg-navy-50 border-navy-100 text-navy-400',
  extra: 'bg-sky-50 border-sky-200 text-sky-800',
  future: 'bg-white border-navy-100 text-navy-300',
};
const DAY_LABEL = {
  filled: 'Filled', missing: 'Missing', weekend: 'Weekend', holiday: 'Holiday',
  extra: 'Weekend / holiday log', future: 'Upcoming',
};

function Calendar({ cycle, selectedDay, onDay }) {
  // Monday-first, so the weekend sits at the end of the row where people
  // expect it. The lead is how many blanks come before the 1st.
  const lead = (d(cycle.start).getDay() + 6) % 7;
  return (
    <div className="grid grid-cols-7 gap-1">
      {DOW.map((x) => <div key={x} className="text-[10px] uppercase text-navy-400 text-center py-1">{x}</div>)}
      {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
      {cycle.days.map((day) => (
        <button key={day.date} type="button"
          onClick={() => onDay(selectedDay === day.date ? null : day.date)}
          title={`${fmtDate(day.date)} — ${DAY_LABEL[day.state]}${day.logs ? `, ${day.hours} h` : ''}`}
          className={`border rounded-md p-1.5 text-left ${DAY_STYLE[day.state]} ${selectedDay === day.date ? 'ring-2 ring-navy-700' : ''}`}>
          <div className="text-[11px] font-semibold">{d(day.date).getDate()}
            <span className="font-normal text-navy-400"> {MONTHS[d(day.date).getMonth()]}</span></div>
          <div className="text-[9.5px] leading-tight">
            {day.state === 'missing' ? '✕ ' : (day.state === 'filled' || day.state === 'extra') ? '✓ ' : ''}
            {DAY_LABEL[day.state]}
          </div>
          {!!day.logs && <div className="text-[9.5px] font-semibold">{day.hours} h · {day.logs} log{day.logs > 1 ? 's' : ''}</div>}
        </button>
      ))}
    </div>
  );
}

export default function TimesheetDashboard({ report, compact }) {
  const [openCycle, setOpenCycle] = useState(null);
  const [day, setDay] = useState(null);
  const cycles = report.cycles || [];
  const t = report.total || {};
  const s = report.settings || {};

  if (!cycles.length) {
    return (
      <div className="card p-8 text-center text-sm text-navy-400">
        Nothing uploaded yet for {report.employee ? report.employee.name : 'this person'}.
      </div>
    );
  }
  // Default to the most recent cycle THAT HAS SOMETHING IN IT. Defaulting
  // to the last one opens on the cycle in progress, which early in a
  // cycle is empty — so the first thing anybody saw was "No logs in this
  // cycle", which reads as the feature being broken rather than as the
  // month having just started.
  const lastWithData = cycles.map((c, i) => [c, i]).filter(([c]) => c.filled || c.extra).pop();
  const sel = openCycle == null ? (lastWithData ? lastWithData[1] : cycles.length - 1) : openCycle;
  const c = cycles[sel];
  const missing = c.days.filter((x) => x.state === 'missing');
  const logs = (report.entries || [])
    .filter((e) => e.log_date >= c.start && e.log_date <= c.end)
    .filter((e) => !day || e.log_date === day)
    .sort((a, b) => (a.log_date < b.log_date ? -1 : 1));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat icon={Gauge} hue="navy" n={`${t.pct}%`} label="Overall filled"
          sub={t.rating} />
        <Stat icon={CalendarCheck} hue="lagoon" n={t.filled} label="Days filled"
          sub={`of ${t.work} working days`} />
        <Stat icon={CalendarX} hue="red" n={t.missing} label="Days missing"
          sub="weekdays with no log" />
        <Stat icon={Clock} hue="leaf" n={t.hours} label="Hours logged"
          sub={t.filled ? `${(t.hours / t.filled).toFixed(1)} h per filled day` : '—'} />
        <Stat icon={CheckCircle2} hue="violet" n={cycles.length} label="Cycles"
          sub={`start day ${s.cycle_start_day}`} />
      </div>

      <p className="text-[11px] text-navy-400">
        A cycle runs from the {s.cycle_start_day}
        {['th', 'st', 'nd', 'rd'][(s.cycle_start_day % 10 > 3 || [11, 12, 13].includes(s.cycle_start_day)) ? 0 : s.cycle_start_day % 10]} to
        the day before the next. Working days are Monday–Friday minus the holidays HR has set
        ({(s.holidays || []).length} set). A day counts as filled when it carries at least one log.
        {' '}<b className="text-emerald-700">Green ≥ {s.green_pct}%</b>,{' '}
        <b className="text-amber-700">Amber ≥ {s.amber_pct}%</b>,{' '}
        <b className="text-rose-700">Red below {s.amber_pct}%</b>.
      </p>

      {!compact && (
        <div className="card p-4">
          <p className="lbl mb-2">Monthly compliance by cycle — click a bar for the detail</p>
          <CycleChart cycles={cycles} green={s.green_pct} amber={s.amber_pct}
            selected={sel} onSelect={(i) => { setOpenCycle(i); setDay(null); }} />
        </div>
      )}

      <div className="card p-4">
        <p className="lbl mb-2">Cycle summary</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                <th className="px-3 py-2">Cycle</th>
                <th className="px-3 py-2">Working days</th>
                <th className="px-3 py-2">Filled</th>
                <th className="px-3 py-2">Missing</th>
                <th className="px-3 py-2" title="Logs on a weekend or a holiday — not counted as working days">Weekend / holiday</th>
                <th className="px-3 py-2">Hours</th>
                <th className="px-3 py-2">Filled %</th>
                <th className="px-3 py-2">Rating</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((x, i) => (
                <tr key={x.start} onClick={() => { setOpenCycle(i); setDay(null); }}
                  className={`border-b border-navy-50 cursor-pointer hover:bg-navy-50/60 ${i === sel ? 'bg-navy-50' : ''}`}>
                  <td className="px-3 py-2 font-semibold text-navy-900">
                    {cycleLabel(x)}
                    {x.in_progress && <span className="chip bg-navy-50 text-navy-500 ml-1">in progress</span>}
                  </td>
                  <td className="px-3 py-2">{x.work}</td>
                  <td className="px-3 py-2">{x.filled}</td>
                  <td className={`px-3 py-2 ${x.missing ? 'text-rose-600 font-semibold' : ''}`}>{x.missing}</td>
                  <td className="px-3 py-2 text-navy-400">{x.extra}</td>
                  <td className="px-3 py-2">{x.hours}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded bg-navy-100 min-w-[60px]">
                        <div className="h-1.5 rounded" style={{ width: `${x.pct}%`, background: RATING_BAR[x.rating] }} />
                      </div>
                      <span className="w-10 text-right">{x.pct}%</span>
                    </div>
                  </td>
                  <td className="px-3 py-2"><RatingChip rating={x.rating} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="lbl">Detailed log · {cycleLabel(c)}</p>
          <RatingChip rating={c.rating} />
          <span className="chip bg-navy-50 text-navy-500">{c.filled} of {c.work} days · {c.hours} h</span>
        </div>
        <Calendar cycle={c} selectedDay={day} onDay={setDay} />
        <div>
          <p className="lbl mb-1">Missing days</p>
          {missing.length ? (
            <div className="flex flex-wrap gap-1">
              {missing.map((x) => (
                <span key={x.date} className="chip bg-rose-100 text-rose-700">✕ {fmtDate(x.date)}</span>
              ))}
            </div>
          ) : <p className="text-xs text-emerald-700">None — every working day in this cycle has a log.</p>}
        </div>
        <div>
          <p className="lbl mb-1">
            Log entries {day ? `· ${fmtDate(day)}` : '(every day in the cycle)'}
            {day && <button className="ml-2 text-[11px] underline text-navy-500" onClick={() => setDay(null)}>show the whole cycle</button>}
          </p>
          <div className="overflow-x-auto max-h-[420px]">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                  <th className="px-3 py-2">Date</th><th className="px-3 py-2">Hours</th>
                  <th className="px-3 py-2">Item</th><th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Approval</th>
                </tr>
              </thead>
              <tbody>
                {logs.length ? logs.map((e, i) => (
                  <tr key={`${e.log_date}-${e.item_id}-${i}`} className="border-b border-navy-50 align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(e.log_date)}</td>
                    <td className="px-3 py-2">{e.hours}</td>
                    <td className="px-3 py-2">
                      <b>{e.item_id}</b><br />{e.item_name}
                      <span className="block text-navy-400">{[e.item_type, e.sprint].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="px-3 py-2 text-navy-600">{e.description || '—'}</td>
                    <td className="px-3 py-2">
                      {e.approval_status || '—'}
                      {e.approved_by && <span className="block text-navy-400">{e.approved_by}</span>}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan="5" className="px-3 py-6 text-center text-navy-400">
                    {day ? 'No log on this day.' : 'No logs in this cycle.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
