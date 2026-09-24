import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import { Info, GitCompareArrows } from 'lucide-react';

const PERF = ['high', 'mid', 'low']; // rows, top to bottom
const POT = ['low', 'mid', 'high'];  // columns, left to right
const LEVELS = [
  { value: 'org', label: 'Organisation' },
  { value: 'department', label: 'Department' },
  { value: 'manager', label: 'Reporting line' },
];

// The two ways the grid can be filled, and they are not the same kind
// of thing — which is the whole reason both are offered rather than one
// quietly replacing the other.
const SOURCES = [
  { value: 'calibrated', label: 'Calibrated',
    sub: 'What HR agreed on the Calibration screen. A decision made by people.' },
  { value: 'derived', label: 'From competency mapping',
    sub: 'Computed: performance from the annual rating, potential from the forward-looking competencies.' },
];

// The conventional names. A grid of "high-mid" labels is a grid nobody
// reads out loud in a calibration meeting.
const CELL_NAME = {
  'high-high': 'Star', 'high-mid': 'High performer', 'high-low': 'Trusted professional',
  'mid-high': 'High potential', 'mid-mid': 'Core player', 'mid-low': 'Effective',
  'low-high': 'Enigma', 'low-mid': 'Inconsistent', 'low-low': 'Risk',
};
const CELL_TONE = {
  'high-high': 'bg-leaf-50 border-leaf-500/40', 'high-mid': 'bg-leaf-50 border-leaf-500/25',
  'mid-high': 'bg-leaf-50 border-leaf-500/25', 'mid-mid': 'bg-navy-50 border-navy-100',
  'high-low': 'bg-navy-50 border-navy-100', 'low-high': 'bg-amber2-50 border-amber2-500/30',
  'mid-low': 'bg-navy-50 border-navy-100', 'low-mid': 'bg-amber2-50 border-amber2-500/30',
  'low-low': 'bg-rose-50 border-rose-200',
};

export default function NineBoxPage() {
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('org');
  const [source, setSource] = useState('calibrated');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setData(null); setErr(null);
    api(`/pms/nine-box?level=${level}&source=${source}`).then(setData).catch((e) => setErr(e.message));
  }, [level, source]);

  const c = data?.coverage;
  const src = SOURCES.find((s) => s.value === source);

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="9-Box Grid" hue="leaf"
        sub="Performance against potential. Visible to HR and Delivery Head." />

      <div className="flex flex-wrap gap-1">
        {SOURCES.map((s) => (
          <button key={s.value} onClick={() => setSource(s.value)} title={s.sub}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${source === s.value
              ? 'bg-leaf-500 text-white' : 'bg-navy-50 text-navy-600 hover:bg-navy-100'}`}>
            {s.label}
          </button>
        ))}
      </div>
      <p className="text-[11.5px] text-navy-500 -mt-2">{src.sub}</p>

      <div className="flex gap-1">
        {LEVELS.map((l) => (
          <button key={l.value} onClick={() => setLevel(l.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${level === l.value
              ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600 hover:bg-navy-100'}`}>
            {l.label}
          </button>
        ))}
      </div>

      {/* What the grid is standing on. An average or a distribution
          without its denominator is the commonest way a dashboard
          misleads, and an empty grid has three possible causes that
          need three different fixes. */}
      {c && (
        <div className="card p-3 text-[11.5px] text-navy-600 space-y-1">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span><b>{c.employees}</b> active employees</span>
            <span><b>{c.with_final_rating}</b> with a published annual rating</span>
            <span><b>{c.with_manager_competencies}</b> with manager competency ratings</span>
            <span><b>{source === 'derived' ? c.derived : c.calibrated}</b> placed on this grid</span>
          </p>
          {source === 'derived' && c.differs > 0 && (
            <p className="flex items-center gap-1.5 text-amber2-600">
              <GitCompareArrows size={13} />
              <b>{c.differs}</b> {c.differs === 1 ? 'person sits' : 'people sit'} in a different box
              here than HR calibrated them into — marked below.
            </p>
          )}
        </div>
      )}

      {source === 'derived' && data?.bands && (
        <div className="card p-3 text-[11px] text-navy-500 flex gap-2">
          <Info size={14} className="shrink-0 mt-0.5 text-navy-400" />
          <span>
            <b>Performance</b> is the published annual rating banded across its own scale
            ({data.bands.performance.map((b) => `${b.band} = ${b.label.toLowerCase()}`).join(', ')}).{' '}
            <b>Potential</b> is the average gap between the manager's competency ratings and
            what the role requires, over the <b>forward-looking</b> categories only — Leadership
            and Digital &amp; Future Skills. Functional competencies are deliberately excluded:
            they describe the job somebody already does, which is performance, and counting them
            twice would flatten the grid onto a diagonal. Nothing here overwrites a calibrated
            cell.
          </span>
        </div>
      )}

      <SearchBox value={q} onChange={setQ} placeholder="Find a person on the grid…" />
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!err && !data && <p className="text-sm text-navy-400">Loading…</p>}
      {data && !data.groups.length && (
        <div className="card p-8 text-center text-sm text-navy-400">
          {source === 'calibrated'
            ? <>Nobody has a 9-box cell recorded yet for {data.cycle?.name || 'the active cycle'} — enter them on the Calibration screen, or switch to <b>From competency mapping</b> above.</>
            : <>Nothing can be placed yet for {data.cycle?.name || 'the active cycle'}.
               A placement needs <b>both</b> a published annual rating
               ({c?.with_final_rating || 0} so far) and manager competency ratings
               ({c?.with_manager_competencies || 0} so far).</>}
        </div>
      )}
      {data && data.groups.map((g) => <Grid key={g.key} group={g} q={q} source={source} />)}
    </div>
  );
}

// A search here highlights rather than removes: the whole point of the
// grid is the shape of the distribution, and dropping the people who do
// not match would redraw it into something misleading.
function Grid({ group, q, source }) {
  return (
    <div className="card p-4">
      <p className="font-semibold text-sm mb-2">
        {group.key} <span className="text-navy-400 font-normal">· {group.total} placed</span>
      </p>
      <div className="flex">
        {/* Axis labels, because "high-mid" in a corner is not an axis. */}
        <div className="flex flex-col justify-around pr-2 text-[9px] uppercase tracking-wide text-navy-400 font-semibold">
          {PERF.map((p) => <span key={p} className="h-[64px] flex items-center">{p}</span>)}
        </div>
        <div className="flex-1">
          <div className="grid grid-cols-3 gap-1 text-xs">
            {PERF.map((perf) => POT.map((pot) => {
              const key = `${perf}-${pot}`;
              const people = group.cells[key] || [];
              return (
                <div key={key} className={`border rounded-lg p-2 min-h-[64px] ${CELL_TONE[key] || 'bg-navy-50 border-navy-100'}`}>
                  <p className="text-[9px] uppercase tracking-wide text-navy-400 mb-1">
                    {CELL_NAME[key]} <span className="text-navy-300">· {people.length}</span>
                  </p>
                  {people.map((p) => {
                    const hit = q.trim() && matches(q, p.name);
                    return (
                      <p key={p.id} title={source === 'derived' ? p.why : undefined}
                        className={`text-[11px] ${hit
                          ? 'font-bold text-white bg-brand-500 rounded px-1 -mx-0.5'
                          : q.trim() ? 'font-medium text-navy-300' : 'font-medium'}`}>
                        {p.name}
                        {p.differs && (
                          <span className="ml-1 text-[9px] font-bold text-amber2-600"
                            title={`HR calibrated this person into "${p.calibrated_cell}"`}>≠</span>
                        )}
                      </p>
                    );
                  })}
                </div>
              );
            }))}
          </div>
          <div className="grid grid-cols-3 gap-1 mt-1 text-[9px] uppercase tracking-wide text-navy-400 font-semibold text-center">
            {POT.map((p) => <span key={p}>{p} potential</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}
