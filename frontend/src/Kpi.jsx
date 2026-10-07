import { NavLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

// The main Dashboard's attention card, shared.
//
// Moved out of HomePage on 7 Oct, asked for directly: "please update all
// old UI to new UI". The stat strips on the Competency Dashboard and the
// three timesheet dashboards were the last of the old design — a white
// tile with a coloured icon square — and each page carried its own copy
// of it. They now draw this one card, so a change to the look lands on
// every dashboard at once instead of drifting page by page.
//
// hue names what the number MEANS (red = a problem, amber = attention,
// leaf = done, violet / navy / azure / lagoon = neutral counts), and maps
// onto the five pastel tones the reference uses.
const KPI_HUE = { red: 'red', amber: 'amber', leaf: 'green', green: 'green', violet: 'violet', navy: 'blue', azure: 'blue', lagoon: 'blue', blue: 'blue' };
const fmt = (n) => (typeof n === 'number' ? (n < 10 && n >= 0 ? String(n).padStart(2, '0') : n.toLocaleString('en-IN')) : n);

export default function Kpi({ icon: Icon, hue, n, label, sub, to, hint, muted }) {
  const body = (
    <>
      <span className="kpi-i"><Icon size={20} /></span>
      <span className="min-w-0 flex-1">
        <span className="kpi-n">{fmt(n)}</span>
        <span className="kpi-l">{label}</span>
        {sub && <span className="block text-[11px] text-navy-500 mt-0.5 leading-tight">{sub}</span>}
      </span>
      {to && <ChevronRight size={17} className="text-navy-700 shrink-0" />}
    </>
  );
  const cls = `kpi kpi-${KPI_HUE[hue] || 'blue'}${muted ? ' opacity-80' : ''}`;
  return to ? <NavLink to={to} className={cls} title={hint}>{body}</NavLink>
            : <div className={cls} title={hint}>{body}</div>;
}
