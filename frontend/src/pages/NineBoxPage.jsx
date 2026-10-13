import { useEffect, useMemo, useState } from 'react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import Grade from '../grade';
import { Info, Download, ArrowUp, ArrowDown, Minus, MoveHorizontal, Sparkles, Star, PenLine, CheckCircle2, X } from 'lucide-react';

// The 9-box, to the client's build specification (13 Oct).
//
// One page, three views, each its own menu entry and its own permission:
//   company      HR and Super Admin — the whole company     /admin/nine-box
//   departments  a Delivery Head — the departments they head /hod/nine-box
//   team         a manager — their direct reports           /team/nine-box
// Nobody is shown their own box, in any view.
//
// The grid is the spec's standard layout: Performance runs left to right
// and Potential bottom to top, each box written (Performance, Potential),
// so (0,0) Underperformer is bottom-left and (2,2) Top Performer top-right.

const dl = (path) => `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(localStorage.getItem('apms_token') || '')}`;

const BAND = ['Low', 'Medium', 'High'];
const ROWS = [2, 1, 0]; // potential, top to bottom
const COLS = [0, 1, 2]; // performance, left to right
const TONE = {
  '2,2': 'bg-leaf-50 border-leaf-500/50', '1,2': 'bg-leaf-50 border-leaf-500/25', '2,1': 'bg-leaf-50 border-leaf-500/25',
  '1,1': 'bg-navy-50 border-navy-100', '2,0': 'bg-navy-50 border-navy-100', '1,0': 'bg-navy-50 border-navy-100',
  '0,2': 'bg-amber2-50 border-amber2-500/30', '0,1': 'bg-amber2-50 border-amber2-500/30', '0,0': 'bg-rose-50 border-rose-200',
};
const VIEW = {
  company: { sub: 'The whole company. You are not shown on your own grid.', hue: 'violet' },
  departments: { sub: 'The departments you head. You are not shown on your own grid.', hue: 'leaf' },
  team: { sub: 'Your direct reports. Their box is for you and HR — it is never shown to them.', hue: 'lagoon' },
};
const TABS = [['grid', 'Grid'], ['movement', 'Movement'], ['reports', 'Reports'], ['actions', 'Actions']];
const SOURCE = { adjustment: 'calibration adjustment', hod: 'Delivery Head rating', manager: 'manager rating' };

// The tab sticks per view. Wrapped: localStorage throws in a private
// window, and the page must still open.
const remembered = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key, v) => { try { localStorage.setItem(key, v); } catch { /* not kept */ } };

const fmt = (n) => (n == null ? '—' : Number(n).toFixed(2).replace(/0$/, ''));
const NO_FILTERS = { department: '', location: '', manager_id: '', grade: '' };

export function Move({ m }) {
  if (!m) return null;
  const map = {
    up: [ArrowUp, 'text-emerald-600', 'Up'], down: [ArrowDown, 'text-rose-600', 'Down'],
    same: [Minus, 'text-navy-400', 'Same box'], across: [MoveHorizontal, 'text-navy-500', 'Moved across'],
    new: [Sparkles, 'text-violet-600', 'First placement'],
  };
  const [Icon, cls, label] = map[m] || [];
  if (!Icon) return null;
  return <span className={`inline-flex items-center gap-0.5 ${cls}`} title={label}><Icon size={12} /><span className="sr-only">{label}</span></span>;
}

export default function NineBoxPage({ view = 'company' }) {
  const [cycleId, setCycleId] = useState('');
  const [filters, setFilters] = useState(NO_FILTERS);
  const [tab, setTabState] = useState(() => remembered(`ninebox.tab.${view}`, 'grid'));
  const setTab = (t) => { setTabState(t); remember(`ninebox.tab.${view}`, t); };
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null); // a box key, or 'none' for not placed
  const [q, setQ] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams({ view });
    if (cycleId) p.set('cycle_id', cycleId);
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    return p.toString();
  }, [view, cycleId, filters]);

  // Only the answer to the LATEST request is shown: a slow answer to an
  // earlier filter must not land on top of the one the controls show.
  // A failed load keeps the last good grid and its controls on screen,
  // so the user can pick another cycle or clear a filter.
  useEffect(() => {
    let live = true;
    setErr(null);
    api(`/pms/nine-box?${query}`)
      .then((d) => { if (!live) return; setData(d); if (!cycleId && d.cycle) setCycleId(d.cycle.id); })
      .catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [query]);

  const v = VIEW[view] || VIEW.company;
  const setFilter = (k, val) => { setFilters((f) => ({ ...f, [k]: val })); setOpen(null); };
  const anyFilter = Object.values(filters).some(Boolean);

  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <PageHead title="9-Box Grid" hue={v.hue} sub={v.sub}>
        {data && <a className="btn-sec" href={dl(`/pms/nine-box/export.xlsx?${query}`)}><Download size={13} className="inline mr-1" />Export to Excel</a>}
      </PageHead>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      {!data && !err && <p className="text-sm text-navy-400">Loading…</p>}
      {data && (
        <>
          <div className="card p-3 space-y-2">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-navy-500">Cycle
                {/* A new cycle starts unfiltered: a department or manager
                    from the last one may not exist in it, and a filter the
                    dropdown cannot show is a filter nobody can see. */}
                <select className="inp !py-1 !text-xs mt-0.5" value={cycleId} onChange={(e) => { setCycleId(e.target.value); setFilters(NO_FILTERS); setOpen(null); }}>
                  {data.cycles.map((c) => <option key={c.id} value={c.id}>{c.name}{c.published ? ' · published' : ''}</option>)}
                </select>
              </label>
              <Pick label="Department" value={filters.department} onChange={(x) => setFilter('department', x)} options={data.filters.departments} />
              <Pick label="Location" value={filters.location} onChange={(x) => setFilter('location', x)} options={data.filters.locations} />
              {view !== 'team' && (
                <Pick label="Manager" value={filters.manager_id} onChange={(x) => setFilter('manager_id', x)}
                  options={data.filters.managers.map((m) => [m.manager_id, m.name])} />
              )}
              <Pick label="Grade" value={filters.grade} onChange={(x) => setFilter('grade', x)} options={data.filters.grades} />
              {anyFilter && <button className="text-[11px] text-navy-500 hover:underline pb-1.5" onClick={() => { setFilters(NO_FILTERS); setOpen(null); }}>Clear filters</button>}
            </div>
            <p className="text-[11px] text-navy-500 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`chip ${data.status === 'published' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>
                {data.status === 'published' ? 'Published' : 'Provisional — worked out live until publish'}
              </span>
              <span>{data.settings.band_text}</span>
              <span>Potential: {data.settings.competency_weight}% competencies, {100 - data.settings.competency_weight}% the manager's four questions</span>
            </p>
          </div>

          {data.note && <div className="card p-3 text-xs text-amber-800 flex gap-2"><Info size={14} className="shrink-0 mt-0.5" />{data.note}</div>}

          <div className="flex flex-wrap gap-1">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${tab === k ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600 hover:bg-navy-100'}`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'grid' && (
            <GridTab data={data} view={view} open={open} setOpen={(k) => { setOpen(k); setQ(''); }} q={q} setQ={setQ} />
          )}
          {tab === 'movement' && <MovementTab query={query} view={view} />}
          {tab === 'reports' && <ReportsTab query={query} view={view} />}
          {tab === 'actions' && <ActionsTab query={query} view={view} />}
        </>
      )}
    </div>
  );
}

function Pick({ label, value, onChange, options }) {
  const opts = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  return (
    <label className="text-[11px] text-navy-500">{label}
      <select className="inp !py-1 !text-xs mt-0.5 max-w-[11rem]" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {opts.map(([val, text]) => <option key={val} value={val}>{text}</option>)}
      </select>
    </label>
  );
}

function GridTab({ data, view, open, setOpen, q, setQ }) {
  const t = data.totals;
  const list = open === 'none' ? data.not_placed.people : open ? data.boxes[open].people : [];
  const shown = list.filter((p) => matches(q, p.name, p.department, p.manager_name, p.grade));
  return (
    <div className="space-y-3">
      <div className="card p-3 sm:p-4">
        <div className="flex gap-2">
          <div className="flex items-center">
            <span className="text-[10px] uppercase tracking-wide text-navy-400 [writing-mode:vertical-rl] rotate-180">Potential →</span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1 sm:gap-2">
              {ROWS.map((pot) => (
                <Row key={pot} pot={pot} data={data} open={open} setOpen={setOpen} />
              ))}
              <span />
              {COLS.map((perf) => <span key={perf} className="text-center text-[10px] text-navy-400">{BAND[perf]}</span>)}
            </div>
            <p className="text-center text-[10px] uppercase tracking-wide text-navy-400 mt-1">Performance →</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-navy-600">
          <span><b>{t.placed}</b> placed</span>
          <button className={`underline-offset-2 ${t.not_placed ? 'hover:underline' : ''}`} disabled={!t.not_placed}
            onClick={() => setOpen(open === 'none' ? null : 'none')}>
            <b>{t.not_placed}</b> not placed
          </button>
          <span className="text-navy-400">= <b>{t.in_view}</b> in this view</span>
        </div>
      </div>

      {open && (
        <div className="card p-3 sm:p-4 space-y-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {open === 'none' ? (
                <>
                  <p className="text-sm font-bold">Not placed</p>
                  <p className="text-[11.5px] text-navy-500">People with a submitted evaluation this cycle who are not on the grid, and why. Anyone below the Low limit here still gets a PIP at publish.</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold">{data.boxes[open].name} <span className="text-navy-400 font-normal">({open}) · {data.boxes[open].count}</span></p>
                  <p className="text-[11.5px] text-navy-500">{data.boxes[open].meaning}</p>
                  <p className="text-[11.5px] text-navy-700 mt-1"><b>Action at publish:</b> {data.boxes[open].action}</p>
                </>
              )}
            </div>
            <button className="text-navy-400 hover:text-navy-600" onClick={() => setOpen(null)} aria-label="Close"><X size={16} /></button>
          </div>
          {list.length > 6 && <SearchBox value={q} onChange={setQ} placeholder="Find a person…" shown={shown.length} total={list.length} />}
          <PeopleTable people={shown} view={view} notPlaced={open === 'none'} scale={data.cycle.rating_scale} />
        </div>
      )}
    </div>
  );
}

function Row({ pot, data, open, setOpen }) {
  return (
    <>
      <span className="text-[10px] text-navy-400 self-center text-right pr-0.5 sm:pr-1">
        <span className="sm:hidden">{['Low', 'Med', 'High'][pot]}</span><span className="hidden sm:inline">{BAND[pot]}</span>
      </span>
      {COLS.map((perf) => {
        const k = `${perf},${pot}`;
        const b = data.boxes[k];
        return (
          <button key={k} onClick={() => setOpen(open === k ? null : k)}
            className={`min-w-0 text-left rounded-xl border p-1.5 sm:p-3 min-h-[76px] transition ${TONE[k]} ${open === k ? 'ring-2 ring-navy-600' : 'hover:ring-1 hover:ring-navy-300'}`}>
            <span className="block text-[10px] text-navy-400">({k})</span>
            <span className="block text-[10.5px] sm:text-xs font-semibold text-navy-800 leading-tight break-words hyphens-auto" lang="en">{b.name}</span>
            <span className="block mt-1 text-lg sm:text-xl font-bold text-navy-900 leading-none">{b.count}</span>
            <span className="block text-[10px] text-navy-500">{b.pct}%</span>
          </button>
        );
      })}
    </>
  );
}

function Scores({ p, scale }) {
  return (
    <>
      <td className="px-2 py-1.5 whitespace-nowrap" title={p.performance_source ? `From the ${SOURCE[p.performance_source]}` : ''}>
        <Grade value={p.performance_score} scale={scale} /> <span className="text-navy-400">· {p.perf_band == null ? '—' : BAND[p.perf_band]}</span>
        {p.overridden?.performance && <Overridden o={p.overridden.performance} />}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap"
        title={`Competencies ${fmt(p.competency_score)} · questions ${fmt(p.questions_score)}`}>
        {fmt(p.potential_score)} <span className="text-navy-400">· {p.pot_band == null ? '—' : BAND[p.pot_band]}</span>
        {p.potential_partial && <span className="ml-1 text-[10px] text-amber-700" title="Only one half of potential was available">one half</span>}
        {p.overridden?.potential && <Overridden o={p.overridden.potential} />}
      </td>
    </>
  );
}

function Overridden({ o }) {
  const said = o.reason ? `HR override to ${BAND[o.band]}: ${o.reason}${o.by ? ` — ${o.by}` : ''}` : `HR override to ${BAND[o.band]}`;
  return <span className="ml-1 inline-flex items-center text-violet-600" title={said}><PenLine size={11} /><span className="sr-only">{said}</span></span>;
}

function PeopleTable({ people, view, notPlaced, scale }) {
  if (!people.length) return <p className="text-xs text-navy-400">Nobody here.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
          <tr>
            <th className="text-left px-2 py-1.5">Name</th>
            <th className="text-left px-2 py-1.5">Department</th>
            {view !== 'team' && <th className="text-left px-2 py-1.5">Manager</th>}
            <th className="text-left px-2 py-1.5">Grade</th>
            <th className="text-left px-2 py-1.5">Performance</th>
            <th className="text-left px-2 py-1.5">Potential</th>
            {notPlaced ? <th className="text-left px-2 py-1.5">Why not placed</th> : <th className="text-left px-2 py-1.5">Previous box</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-100">
          {people.map((p) => (
            <tr key={p.employee_id}>
              <td className="px-2 py-1.5 font-semibold whitespace-nowrap">
                {p.name}
                {p.super50 && <span className="ml-1 inline-flex text-amber-500" title="On the Super 50 watchlist"><Star size={11} fill="currentColor" /></span>}
              </td>
              <td className="px-2 py-1.5">{p.department || '—'}</td>
              {view !== 'team' && <td className="px-2 py-1.5">{p.manager_name || '—'}</td>}
              <td className="px-2 py-1.5">{p.grade || '—'}</td>
              <Scores p={p} scale={scale} />
              {notPlaced ? <td className="px-2 py-1.5 text-navy-600">{p.not_placed_text}</td> : (
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {p.prev_box_key ? <>({p.prev_box_key}) </> : <span className="text-navy-400">— </span>}<Move m={p.movement} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useTab(path) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setErr(null);
    api(path).then((x) => { if (live) setD(x); }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [path, n]);
  return [d, err, () => setN((x) => x + 1)];
}

const MOVES = [['all', 'Everyone'], ['up', 'Moved up'], ['down', 'Moved down'], ['across', 'Moved across'], ['same', 'Same box'], ['new', 'First placement']];

function MovementTab({ query, view }) {
  const [d, err] = useTab(`/pms/nine-box/movement?${query}`);
  const [only, setOnly] = useState('all');
  const [q, setQ] = useState('');
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  const rows = d.people.filter((p) => (only === 'all' || p.current_movement === only) && matches(q, p.name, p.department, p.manager_name));
  return (
    <div className="card p-3 sm:p-4 space-y-3">
      <p className="text-[11.5px] text-navy-500">Each person's box over the last {d.cycles.length === 1 ? 'cycle' : `${d.cycles.length} annual cycles`}, oldest first. Up and down are by the two bands added together; a move along the same diagonal is "across".</p>
      <div className="flex flex-wrap gap-1">
        {MOVES.map(([k, label]) => (
          <button key={k} onClick={() => setOnly(k)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium ${only === k ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600 hover:bg-navy-100'}`}>
            {label}{k !== 'all' && d.counts[k] != null ? ` · ${d.counts[k]}` : ''}
          </button>
        ))}
      </div>
      <SearchBox value={q} onChange={setQ} placeholder="Find a person…" shown={rows.length} total={d.people.length} />
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
            <tr>
              <th className="text-left px-2 py-1.5">Name</th>
              <th className="text-left px-2 py-1.5">Department</th>
              {d.cycles.map((c) => <th key={c.id} className="text-left px-2 py-1.5">{c.name}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-100">
            {rows.map((p) => (
              <tr key={p.employee_id}>
                <td className="px-2 py-1.5 font-semibold whitespace-nowrap">
                  {p.name}{p.super50 && <span className="ml-1 inline-flex text-amber-500" title="On the Super 50 watchlist"><Star size={11} fill="currentColor" /></span>}
                </td>
                <td className="px-2 py-1.5">{p.department || '—'}</td>
                {p.boxes.map((b, i) => (
                  <td key={i} className="px-2 py-1.5 whitespace-nowrap">
                    {i > 0 && <span className="mr-1"><Move m={p.steps[i - 1]} /></span>}
                    {!b ? <span className="text-navy-300">not on record</span>
                      : b.box_key ? <span>{b.box_name} <span className="text-navy-400">({b.box_key})</span></span>
                        : <span className="text-navy-400">Not placed</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="text-xs text-navy-400">Nobody matches.</p>}
    </div>
  );
}

function ReportsTab({ query, view }) {
  const [d, err] = useTab(`/pms/nine-box/reports?${query}`);
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  const keys = d.distribution.map((x) => x.key);
  const names = Object.fromEntries(d.distribution.map((x) => [x.key, x.name]));
  return (
    <div className="space-y-3">
      <div className="card p-3 sm:p-4 space-y-2">
        <p className="text-sm font-bold">Distribution against the last cycle</p>
        <p className="text-[11.5px] text-navy-500">{d.previous_cycle ? `Compared with ${d.previous_cycle.name}, over the same view and filters.` : 'No earlier annual cycle has a published 9-box yet, so there is nothing to compare with.'}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr>
                <th className="text-left px-2 py-1.5">Box</th>
                <th className="text-right px-2 py-1.5">This cycle</th>
                <th className="text-right px-2 py-1.5">%</th>
                <th className="text-right px-2 py-1.5">Last cycle</th>
                <th className="text-right px-2 py-1.5">%</th>
                <th className="text-right px-2 py-1.5">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {d.distribution.map((x) => (
                <tr key={x.key}>
                  <td className="px-2 py-1.5">{x.name} <span className="text-navy-400">({x.key})</span></td>
                  <td className="px-2 py-1.5 text-right font-semibold">{x.count}</td>
                  <td className="px-2 py-1.5 text-right">{x.pct}%</td>
                  <td className="px-2 py-1.5 text-right">{x.prev_count ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right">{x.prev_pct == null ? '—' : `${x.prev_pct}%`}</td>
                  <td className={`px-2 py-1.5 text-right ${x.delta > 0 ? 'text-emerald-700' : x.delta < 0 ? 'text-rose-600' : 'text-navy-400'}`}>
                    {x.delta == null ? '—' : x.delta > 0 ? `+${x.delta}` : x.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-3 sm:p-4 space-y-2">
        <p className="text-sm font-bold">Grid by department</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-navy-50 text-[10px] uppercase tracking-wide text-navy-500">
              <tr>
                <th className="text-left px-2 py-1.5">Department</th>
                {keys.map((k) => <th key={k} className="text-right px-2 py-1.5" title={names[k]}>({k})</th>)}
                <th className="text-right px-2 py-1.5">Not placed</th>
                <th className="text-right px-2 py-1.5">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy-100">
              {d.by_department.map((g) => (
                <tr key={g.department}>
                  <td className="px-2 py-1.5 font-semibold">{g.department}</td>
                  {keys.map((k) => <td key={k} className={`px-2 py-1.5 text-right ${g.boxes[k] ? '' : 'text-navy-300'}`}>{g.boxes[k]}</td>)}
                  <td className="px-2 py-1.5 text-right">{g.not_placed}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{g.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10.5px] text-navy-400">{keys.map((k) => `(${k}) ${names[k]}`).join(' · ')}</p>
      </div>

      <div className="card p-3 sm:p-4 space-y-2">
        <p className="text-sm font-bold">Succession pool</p>
        <p className="text-[11.5px] text-navy-500">Top Performers (2,2) are ready now and join the succession pool for their department at publish. High Potential (1,2) and High Performer (2,1) are shown as ready in 1–2 years.</p>
        {!d.succession.length && <p className="text-xs text-navy-400">Nobody in these boxes in this view.</p>}
        {d.succession.map((g) => (
          <div key={g.department} className="border-t border-navy-100 pt-2">
            <p className="text-xs font-semibold text-navy-700">{g.department}</p>
            <div className="grid sm:grid-cols-2 gap-2 mt-1 text-xs">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-emerald-700">Ready now · {g.ready_now.length}</p>
                {g.ready_now.map((p) => <SuccessionLine key={p.employee_id} p={p} />)}
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-navy-500">Ready in 1–2 years · {g.ready_1_2_years.length}</p>
                {g.ready_1_2_years.map((p) => <SuccessionLine key={p.employee_id} p={p} />)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SuccessionLine({ p }) {
  return (
    <p className="py-0.5">
      {p.name} <span className="text-navy-400">· {p.box_name}{p.manager_name ? ` · ${p.manager_name}` : ''}</span>
      {p.super50 && <span className="ml-1 inline-flex text-amber-500" title="On the Super 50 watchlist"><Star size={11} fill="currentColor" /></span>}
    </p>
  );
}

function ActionsTab({ query, view }) {
  const [d, err, reload] = useTab(`/pms/nine-box/actions?${query}`);
  const [closing, setClosing] = useState(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState(null);
  const [only, setOnly] = useState('open');
  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  const save = async (a, status) => {
    setMsg(null);
    try {
      await api(`/pms/nine-box/actions/${a.id}`, { method: 'PUT', body: JSON.stringify({ status, note }) });
      setClosing(null); setNote(''); reload();
    } catch (e) { setMsg(e.message); }
  };
  const rows = d.actions.filter((a) => only === 'all' || a.status === only);
  return (
    <div className="card p-3 sm:p-4 space-y-3">
      <p className="text-[11.5px] text-navy-500">What publish created for each box — a development plan, coaching, a PIP, a retention review, an escalation — and who it is with. Close one with a note of what was done.</p>
      <div className="flex flex-wrap gap-1">
        {[['open', `Open · ${d.open}`], ['done', 'Done'], ['all', 'All']].map(([k, label]) => (
          <button key={k} onClick={() => setOnly(k)}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-medium ${only === k ? 'bg-navy-700 text-white' : 'bg-navy-50 text-navy-600 hover:bg-navy-100'}`}>{label}</button>
        ))}
      </div>
      {msg && <p className="text-xs text-rose-600">{msg}</p>}
      {!d.actions.length && <p className="text-xs text-navy-400">No actions yet. They are created when the cycle's ratings are published.</p>}
      <div className="divide-y divide-navy-100">
        {rows.map((a) => (
          <div key={a.id} className="py-2 text-xs space-y-1">
            <div className="flex flex-wrap items-start gap-2">
              <div className="flex-1 min-w-[12rem]">
                <p className="font-semibold">{a.name} <span className="text-navy-400 font-normal">· {a.box_name ? `${a.box_name} (${a.box_key})` : a.kind}</span></p>
                <p className="text-navy-700">{a.title}</p>
                <p className="text-[10.5px] text-navy-400">
                  {a.assignee_name ? `With ${a.assignee_name}` : 'With HR'}{a.due_date ? ` · due ${a.due_date}` : ''}
                  {a.status === 'done' && ` · done by ${a.closed_by}${a.close_note ? ` — ${a.close_note}` : ''}`}
                  {a.status === 'superseded' && ' · replaced at a later publish'}
                </p>
              </div>
              {a.can_close && a.status === 'open' && closing !== a.id && (
                <button className="btn-sec !py-1" onClick={() => { setClosing(a.id); setNote(''); }}><CheckCircle2 size={12} className="inline mr-1" />Mark done</button>
              )}
              {a.can_close && a.status === 'done' && <button className="text-[11px] text-navy-500 hover:underline" onClick={() => save(a, 'open')}>Reopen</button>}
            </div>
            {closing === a.id && (
              <div className="flex flex-wrap gap-2 items-center">
                <input className="inp !py-1 !text-xs flex-1 min-w-[12rem]" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done (required)" />
                <button className="btn-pri !py-1" disabled={!note.trim()} onClick={() => save(a, 'done')}>Save</button>
                <button className="btn-sec !py-1" onClick={() => setClosing(null)}>Cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
