import { useEffect, useState } from 'react';
import { api, API_BASE } from '../utils/api';
import PageHead from '../PageHead';
import { ScaleLegend } from '../CompetencyScale';
import {
  Users, Gauge, AlertTriangle, TrendingDown, Download, ClipboardCheck, Layers,
} from 'lucide-react';

// The HR Dashboard sheet of the client's workbook — "complete
// competency of the organization".
//
// COVERAGE IS STATED FIRST AND LOUDEST, because every average below it
// is meaningless without it. "Average 3.8" over four people out of
// 1,398 is not a company figure, and a dashboard that shows the number
// without the denominator is lying by omission. That is also why an
// unrated category reads "—" and not "0.0": no data and a score of zero
// are different facts.
//
// Self-ratings are shown but never averaged into a company number. An
// optimistic self-assessment must not be able to move an
// organisation-level figure.

const dl = (path) => `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${localStorage.getItem('apms_token')}`;

const PRIORITY = {
  High: 'bg-rose-100 text-rose-700',
  Medium: 'bg-amber-100 text-amber-700',
  Low: 'bg-sky-100 text-sky-700',
  Met: 'bg-emerald-100 text-emerald-700',
};

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

const num = (v) => (v == null ? '—' : v.toFixed(2));
const gap = (v) => (v == null ? '—' : (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)));

export default function CompetencyDashboardPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [dept, setDept] = useState('');

  useEffect(() => {
    setD(null);
    api(`/pms/competencies/dashboard${dept ? `?department=${encodeURIComponent(dept)}` : ''}`)
      .then(setD).catch((e) => setErr(e.message));
  }, [dept]);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;
  if (!d.cycle) return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Competency Dashboard" hue="violet" />
      <div className="card p-8 text-center text-sm text-navy-400">No cycle is open.</div>
    </div>
  );

  const c = d.coverage || {};
  const o = d.overall || {};
  // "Weakest" means short of the bar. The server returns the twelve
  // lowest gaps whatever they are, so once an organisation is meeting
  // its levels the bottom of that list is competencies at gap 0.00 —
  // not a weakness, and listing it under that heading would send HR
  // after a problem that does not exist.
  const weakest = (d.weakest || []).filter((w) => w.avg_gap < 0);
  const pct = c.employees ? Math.round((c.manager_submitted / c.employees) * 100) : 0;

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <PageHead title="Competency Dashboard" hue="violet"
        sub="Where the organisation stands against what its roles require.">
        {/* Explicit dark text: this sits inside the hero band, which sets
            colour:white on everything under it, so .inp alone rendered
            white text on the input's own white background. */}
        <select className="inp !py-1 !px-2 text-xs w-auto !text-navy-800" value={dept}
          onChange={(e) => setDept(e.target.value)}>
          <option value="">Every department</option>
          {(d.department_list || []).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <span className="chip bg-white/20 text-white">{d.cycle.name}</span>
        <a className="btn-sec" href={dl(`/pms/competencies/dashboard/gaps.xlsx${dept ? `?department=${encodeURIComponent(dept)}` : ''}`)}>
          <Download size={13} className="inline mr-1" />Gap list (.xlsx)
        </a>
      </PageHead>

      {/* Coverage before averages, always. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat icon={Users} hue="navy" n={c.employees ?? 0} label="Employees in scope" />
        <Stat icon={ClipboardCheck} hue="lagoon" n={`${c.self_submitted ?? 0}`}
          label="Self-assessments in" sub={`of ${c.employees ?? 0}`} />
        <Stat icon={Gauge} hue="violet" n={`${c.manager_submitted ?? 0}`}
          label="Manager assessments in" sub={`${pct}% of the organisation`} />
        <Stat icon={AlertTriangle} hue="red" n={o.below_required ?? 0} label="Ratings below required" />
      </div>

      {pct < 100 && (
        <p className="card p-3 text-[11.5px] text-navy-600 border-l-4 border-amber2-500">
          <b>Read the averages against the coverage above.</b> {c.manager_submitted ?? 0} of{' '}
          {c.employees ?? 0} {dept ? `people in ${dept}` : 'employees'} have a completed manager
          assessment, so every figure on this page describes those people and not the whole
          {dept ? ' department' : ' company'} yet.
        </p>
      )}

      <div className="card p-4">
        <p className="lbl mb-2">Overall competency summary</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2" title="Manager ratings received, out of competency-by-person rows">Ratings in</th>
                <th className="px-3 py-2">Avg. self</th>
                <th className="px-3 py-2">Avg. manager</th>
                <th className="px-3 py-2">Avg. required</th>
                <th className="px-3 py-2">Avg. gap</th>
                <th className="px-3 py-2">Below required</th>
                <th className="px-3 py-2">Priority</th>
              </tr>
            </thead>
            <tbody>
              {(d.categories || []).map((x) => (
                <tr key={x.category} className="border-b border-navy-50">
                  <td className="px-3 py-2 font-semibold text-navy-900">{x.category}</td>
                  <td className="px-3 py-2 text-navy-400">{x.rated} / {x.competencies}</td>
                  <td className="px-3 py-2">{num(x.avg_self)}</td>
                  <td className="px-3 py-2 font-semibold">{num(x.avg_manager)}</td>
                  <td className="px-3 py-2 text-navy-400">{num(x.avg_required)}</td>
                  <td className={`px-3 py-2 font-semibold ${x.avg_gap != null && x.avg_gap < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                    {gap(x.avg_gap)}
                  </td>
                  <td className="px-3 py-2">{x.below_required}</td>
                  <td className="px-3 py-2">
                    {x.priority ? <span className={`chip ${PRIORITY[x.priority]}`}>{x.priority}</span>
                      : <span className="text-navy-300">no data</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!(d.categories || []).length && (
          <p className="p-6 text-center text-sm text-navy-400">
            Nobody has been assessed yet, so there is nothing to average.
          </p>
        )}
        <p className="text-[11px] text-navy-400 mt-3">
          Priority is set from the average gap: <b>High</b> at a full level below what the roles
          require, <b>Medium</b> at half a level or three or more people short, <b>Low</b> for
          anything still negative, <b>Met</b> otherwise.
        </p>
      </div>

      {!!weakest.length && (
        <div className="card p-4">
          <p className="lbl mb-1 flex items-center gap-1.5"><TrendingDown size={13} /> Weakest competencies</p>
          <p className="text-[11.5px] text-navy-400 mb-2">
            Sized by the number of PEOPLE below the required level — the figure that sizes a
            training programme.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                  <th className="px-3 py-2">Competency</th><th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Rated</th><th className="px-3 py-2">Below</th>
                  <th className="px-3 py-2">Avg. gap</th>
                </tr>
              </thead>
              <tbody>
                {weakest.map((w) => (
                  <tr key={w.competency_id} className="border-b border-navy-50">
                    <td className="px-3 py-2 font-semibold text-navy-900">{w.name}</td>
                    <td className="px-3 py-2 text-navy-400">{w.category}</td>
                    <td className="px-3 py-2">{w.rated}</td>
                    <td className="px-3 py-2">
                      <span className="chip bg-rose-100 text-rose-700">{w.below} · {w.pct_below}%</span>
                    </td>
                    <td className="px-3 py-2 font-semibold text-rose-600">{gap(w.avg_gap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!dept && !!(d.departments || []).length && (
        <div className="card p-4">
          <p className="lbl mb-1 flex items-center gap-1.5"><Layers size={13} /> By department</p>
          <p className="text-[11.5px] text-navy-400 mb-2">Widest gap first.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                  <th className="px-3 py-2">Department</th><th className="px-3 py-2">Assessed</th>
                  <th className="px-3 py-2">Avg. manager</th><th className="px-3 py-2">Avg. required</th>
                  <th className="px-3 py-2">Avg. gap</th><th className="px-3 py-2">Below required</th>
                </tr>
              </thead>
              <tbody>
                {d.departments.map((x) => (
                  <tr key={x.department} className="border-b border-navy-50">
                    <td className="px-3 py-2 font-semibold text-navy-900">{x.department}</td>
                    <td className="px-3 py-2 text-navy-400">{x.people}</td>
                    <td className="px-3 py-2">{num(x.avg_manager)}</td>
                    <td className="px-3 py-2 text-navy-400">{num(x.avg_required)}</td>
                    <td className={`px-3 py-2 font-semibold ${x.avg_gap != null && x.avg_gap < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {gap(x.avg_gap)}
                    </td>
                    <td className="px-3 py-2">{x.below_required}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card p-3">
        <p className="lbl mb-1">Rating scale</p>
        <ScaleLegend scale={d.scale} />
      </div>
    </div>
  );
}
