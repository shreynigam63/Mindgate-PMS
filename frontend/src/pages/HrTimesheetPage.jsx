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
import { TimesheetRoster } from './TeamTimesheetPage';
import {
  Users, CheckCircle2, AlertTriangle, XCircle, Clock, ChevronLeft, SlidersHorizontal, Save,
} from 'lucide-react';

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
        {report ? <TimesheetDashboard report={report} /> : <p className="text-sm text-navy-400">Loading…</p>}
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

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
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
    </div>
  );
}
