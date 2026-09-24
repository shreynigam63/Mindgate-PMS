import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import PageHead from '../PageHead';
import SearchBox, { matches } from '../SearchBox';
import {
  Users, Target, TrendingUp, Clock, ClipboardList, MessageCircle, Hourglass,
  Inbox, ArrowRight, LayoutDashboard, ListChecks, FileWarning,
  UserCheck, BarChart3,
} from 'lucide-react';

// The Manager tab's landing page.
//
// Asked for on 24 Sep: "build a dashboard under 'Manager tab' same like
// one in 'self tab' for manager view regarding tracking of his
// reportees." So it is deliberately the SAME page, one scope out — the
// stat strip, the one action band, the desk of outstanding things, then
// the links — reusing HomePage's own classes rather than inventing a
// second visual language for the same idea.
//
// Two things it does NOT do:
//
//   * It never widens to the whole company, for anybody, including a
//     super admin. That is the other half of the same day's instruction
//     ("remove 'all employees' option from all tabs"), and a dashboard
//     that quietly counted everyone for an admin would put the Manager
//     tab straight back where it was. Company-wide numbers are on the HR
//     tab, where they already were.
//
//   * It does not repeat Team Overview's per-reportee grid of every
//     phase. What it adds is the part a grid cannot answer at a glance:
//     WHO is waiting on you and HOW LONG they have been waiting.
//
// Every number is a real count from the roster the server returns. There
// is no filler tile, for the same reason the self dashboard has none: a
// number nobody can trace is worse than no number.

const TONE = {
  urgent: 'from-brand-600 to-brand-500',
  todo:   'from-amber2-600 to-amber2-500',
  clear:  'from-leaf-600 to-leaf-500',
};

const PHASE_LABEL = {
  draft: 'Draft', kra_open: 'KRA Setting', mid_year_review: 'Mid-Year Review',
  self_appraisal: 'Self-Appraisal', manager_eval: 'Manager Evaluation',
  hod_eval: 'Delivery Head Review', calibration: 'Calibration',
  publish: 'Publishing', closed: 'Closed',
};

// Days, because an approval four hours old is not late and one nine days
// old is. Same helper, same wording as the employee's own dashboard.
const waited = (iso) => {
  if (!iso) return 'just now';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'waiting 1 day' : `waiting ${d} days`;
};

function Stat({ icon: Icon, hue, n, label, to }) {
  const body = (
    <>
      <span className={`stat-i si-${hue}`}><Icon size={22} /></span>
      <span className="stat-t">
        <span className="stat-l">{label}</span>
        <span className="stat-n">{n}</span>
      </span>
    </>
  );
  return to ? <NavLink to={to} className="stat hover:shadow-glass">{body}</NavLink>
            : <div className="stat">{body}</div>;
}

function Desk({ icon: Icon, hue, n, label, to }) {
  return (
    <NavLink to={to} className={`deskt dk-${hue}`}>
      <span className="deskt-i"><Icon size={24} /></span>
      <span className="deskt-b">
        <span className="deskt-l">{label}</span>
        <span className="deskt-n">{String(n).padStart(2, '0')}</span>
        <span className="deskt-r" />
      </span>
    </NavLink>
  );
}

function Tile({ to, icon: Icon, title, sub, hue = 'lagoon' }) {
  return (
    <NavLink to={to} className="card p-3.5 flex items-center gap-3 transition-shadow hover:shadow-glass">
      <span className={`navico navico-${hue} w-9 h-9 shrink-0`}><Icon size={16} /></span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-navy-900">{title}</span>
        <span className="block text-[11.5px] text-navy-400 leading-snug">{sub}</span>
      </span>
    </NavLink>
  );
}

function SecHead({ icon: Icon, hue, title, sub }) {
  return (
    <div className="sechead">
      <span className={`sechead-i si-${hue}`}><Icon size={18} /></span>
      <span className="min-w-0">
        <span className="sechead-t">{title}</span>
        <span className="sechead-s">{sub}</span>
      </span>
    </div>
  );
}

// One reportee's line in the roster strip. Four dots, one per stage, so a
// manager can see at a glance where somebody is stuck without opening
// five pages. Green = done, amber = with me, grey = not started yet.
// 'open' is an OUTLINE, not a pale fill. As a light grey disc it was
// invisible against the row, so a person who had started nothing looked
// like a person with two stages missing from the row entirely.
const DOT = { done: 'bg-leaf-500', mine: 'bg-amber2-500', back: 'bg-rose-500',
              open: 'bg-white border border-navy-300' };
function Dot({ state, title }) {
  return <span title={title} className={`inline-block w-2.5 h-2.5 rounded-full ${DOT[state]}`} />;
}
// A sheet or a plan the employee sends up: approved is finished,
// submitted is sitting with this manager, returned is back with them.
const sentDot = (s) => (s === 'approved' ? 'done' : s === 'submitted' ? 'mine' : s === 'returned' ? 'back' : 'open');
// Something this manager writes themselves: there is no approver above
// them for it, so submitted IS done.
const mineDot = (s) => (s === 'submitted' ? 'done' : s === 'in_progress' ? 'mine' : 'open');

export default function TeamDashboardPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { api('/pms/team/home').then(setD).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const { cycle, stats, pending = [], roster = [], action } = d;
  const phase = cycle ? cycle.phase : null;

  // Two different empty states, because they need two different answers.
  // A manager with nobody under them gets told where reporting lines are
  // set; a manager whose company has no open cycle gets told that, and
  // not a console of zeroes that reads like a data loss.
  if (!cycle || !d.reports) {
    return (
      <div className="space-y-4 max-w-5xl mx-auto">
        <PageHead title="Manager Dashboard" hue="lagoon"
          sub="Everything your reports owe, and everything they are waiting on you for." />
        <div className="card p-8 text-center text-sm text-navy-400">
          {!cycle
            ? 'No cycle is open. HR opens a cycle before your team can set KRAs.'
            : 'No direct reports found, so there is nothing to track here yet. Employees are linked to their manager in the employee master.'}
        </div>
      </div>
    );
  }

  const desk = [];
  if (stats.kra_pending > 0)
    desk.push({ key: 'kra', icon: Target, hue: 'amber', n: stats.kra_pending, label: 'KRA sheets to decide', to: '/team/kra-sheets' });
  if (stats.growth_pending > 0)
    desk.push({ key: 'gro', icon: TrendingUp, hue: 'leaf', n: stats.growth_pending, label: 'Target plans to decide', to: '/team/growth' });
  if (stats.appraisal_pending > 0)
    desk.push({ key: 'sa', icon: ClipboardList, hue: 'violet', n: stats.appraisal_pending, label: 'Annual reviews to evaluate', to: '/team/eval' });
  if (phase === 'mid_year_review' && stats.midyear_pending > 0)
    desk.push({ key: 'mid', icon: Clock, hue: 'lagoon', n: stats.midyear_pending, label: 'Mid-year sign-offs due', to: '/team/midyear' });
  if (stats.kra_returned > 0)
    desk.push({ key: 'ret', icon: FileWarning, hue: 'red', n: stats.kra_returned, label: 'KRA sheets returned', to: '/team/kra-sheets' });
  if (stats.kra_not_submitted > 0)
    desk.push({ key: 'ns', icon: Hourglass, hue: 'navy', n: stats.kra_not_submitted, label: 'KRAs not submitted yet', to: '/team/overview' });
  if (stats.no_connect > 0)
    desk.push({ key: 'nc', icon: MessageCircle, hue: 'azure', n: stats.no_connect, label: 'No connect logged yet', to: '/team/connects' });
  if (stats.open_actions > 0)
    desk.push({ key: 'oa', icon: ListChecks, hue: 'lagoon', n: stats.open_actions, label: 'Connect actions open', to: '/team/connects' });

  const shown = roster.filter(r => matches(q, r.name, r.department, r.designation));

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* No cycle chip in the band: the cycle card directly below already
          names it, and the two side by side read as two cycles. */}
      <PageHead title="Manager Dashboard" hue="lagoon"
        sub="Everything your reports owe, and everything they are waiting on you for." />

      {cycle && (
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <span className="navico navico-lagoon w-9 h-9"><BarChart3 size={16} /></span>
          <div className="min-w-0">
            <p className="text-sm font-bold">{cycle.name}</p>
            <p className="text-[11.5px] text-navy-400">
              {cycle.fiscal_year} · {cycle.cycle_type === 'midyear' ? 'Mid-Year' : 'Annual'}
            </p>
          </div>
          <span className="chip bg-amber2-50 text-amber2-600 ml-auto">{PHASE_LABEL[phase] || phase}</span>
        </div>
      )}

      {/* Progress through the cycle, left to right, exactly the order a
          report moves through it. Each is "how many of my people are
          past this point", so the row reads as one sentence. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat icon={Users} hue="navy" to="/team/overview" n={stats.reports} label="My reports" />
        <Stat icon={Target} hue="lagoon" to="/team/kra-sheets"
          n={`${stats.kra_approved}/${stats.reports}`} label="KRAs approved" />
        <Stat icon={Clock} hue="amber" to="/team/midyear"
          n={`${stats.midyear_signed}/${stats.reports}`} label="Mid-year signed" />
        <Stat icon={ClipboardList} hue="violet" to="/team/eval"
          n={`${stats.evals_done}/${stats.reports}`} label="Evaluations done" />
        <Stat icon={MessageCircle} hue="azure" to="/team/connects"
          n={stats.connects} label="Connects logged" />
        <Stat icon={Hourglass} hue="red" to="/team/kra-sheets"
          n={stats.pending_total} label="Waiting on me" />
      </div>

      <div className={`hero bg-gradient-to-r ${TONE[action.tone] || TONE.clear} block`}>
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold uppercase tracking-widest opacity-80">
            {action.tone === 'clear' ? 'Your team is up to date' : 'Action needed'}
          </p>
          <p className="text-lg font-bold mt-0.5">{action.title}</p>
          <p className="hero-sub">{action.detail}</p>
          {action.cta && (
            <NavLink to={action.to}
              className="inline-flex items-center gap-1.5 mt-3 bg-white text-navy-900 font-bold text-xs px-4 py-2 rounded-xl">
              {action.cta} <ArrowRight size={13} />
            </NavLink>
          )}
        </div>
      </div>

      {desk.length > 0 && (
        <div>
          <SecHead icon={Inbox} hue="red" title="My desk"
            sub={`${desk.length} ${desk.length === 1 ? 'thing is' : 'things are'} outstanding across your team`} />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* key pulled OUT of the spread: React warns when a "key"
                rides in with the rest of the props, and the warning is
                only visible in the console. */}
            {desk.map(({ key, ...x }) => <Desk key={key} {...x} />)}
          </div>
        </div>
      )}

      {/* NAMED, not counted. "3 pending" tells a manager nothing they can
          act on; "Priya — KRA sheet — waiting 6 days" tells them what to
          open. This is the mirror of "Requested to manager" on the
          employee's own dashboard: one row in the database, read from
          the other end. */}
      {pending.length > 0 && (
        <div>
          <SecHead icon={Hourglass} hue="amber" title="Waiting on you"
            sub={`${pending.length} ${pending.length === 1 ? 'submission needs' : 'submissions need'} a decision from you`} />
          <div className="card divide-y divide-navy-50">
            {pending.map((p, i) => (
              <NavLink key={i} to={p.to} className="p-3 flex flex-wrap items-center gap-2 text-sm hover:bg-navy-50">
                <b className="text-navy-900">{p.name}</b>
                <span className="chip bg-lagoon-50 text-lagoon-700">{p.label}</span>
                <span className="ml-auto text-[11.5px] text-navy-400">{waited(p.since)}</span>
                <ArrowRight size={13} className="text-navy-300" />
              </NavLink>
            ))}
          </div>
        </div>
      )}

      {/* The roster. Four dots per person — KRA, target achievements,
          mid-year, evaluation — so "where is everyone" is one glance
          rather than five pages. Team Overview still carries the full
          grid with every status spelled out; this is the summary. */}
      <div>
        <SecHead icon={UserCheck} hue="lagoon" title="My reports"
          sub="KRA · target achievements · mid-year · evaluation" />
        <div className="card overflow-x-auto">
          <SearchBox value={q} onChange={setQ} placeholder="Search your team by name, department or designation…"
            shown={shown.length} total={roster.length} />
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-navy-400 uppercase text-[10px] border-b border-navy-100">
                <th className="px-3 py-2">Employee</th>
                <th className="px-3 py-2">Designation</th>
                <th className="px-3 py-2">KRAs</th>
                <th className="px-3 py-2">Progress</th>
                <th className="px-3 py-2">Connects</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.employee_id} className="border-b border-navy-50">
                  <td className="px-3 py-2">
                    <span className="font-semibold text-navy-900">{r.name}</span>
                    <span className="block text-[10.5px] text-navy-400">{r.department || '—'}</span>
                  </td>
                  <td className="px-3 py-2 text-navy-500">{r.designation || '—'}</td>
                  <td className="px-3 py-2 text-navy-500">
                    {r.kra_count} · {String(r.kra_status).replace('_', ' ')}
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-1.5">
                      <Dot state={sentDot(r.kra_status)} title={`KRA sheet: ${r.kra_status.replace('_', ' ')}`} />
                      <Dot state={sentDot(r.growth_status)} title={`Target achievements: ${r.growth_status.replace('_', ' ')}`} />
                      <Dot state={mineDot(r.midyear_manager_status)} title={`Mid-year sign-off: ${r.midyear_manager_status.replace('_', ' ')}`} />
                      <Dot state={mineDot(r.eval_status)} title={`Manager evaluation: ${r.eval_status.replace('_', ' ')}`} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-navy-500">{r.connects}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!shown.length && <p className="p-6 text-center text-sm text-navy-400">Nobody matches that search.</p>}
        </div>
        <p className="text-[11px] text-navy-400 mt-2 flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5"><Dot state="done" /> done</span>
          <span className="flex items-center gap-1.5"><Dot state="mine" /> with you</span>
          <span className="flex items-center gap-1.5"><Dot state="back" /> returned</span>
          <span className="flex items-center gap-1.5"><Dot state="open" /> not started</span>
        </p>
      </div>

      <div>
        <SecHead icon={LayoutDashboard} hue="lagoon" title="Manager pages"
          sub="Everything on this tab, with where your team stands on each" />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Tile to="/team/overview" icon={LayoutDashboard} title="Team Overview"
            sub={`${stats.reports} ${stats.reports === 1 ? 'person' : 'people'} · every phase at a glance`} />
          <Tile to="/team/kra-sheets" icon={Target} title="Team KRA Sheets"
            sub={stats.kra_pending ? `${stats.kra_pending} awaiting you · ${stats.kra_approved} approved`
                                   : `${stats.kra_approved} approved · nothing pending`} />
          <Tile to="/team/growth" icon={TrendingUp} title="Team Target Achievements"
            sub={stats.growth_pending ? `${stats.growth_pending} awaiting a decision` : 'Nothing pending'} />
          <Tile to="/team/midyear" icon={Clock} title="Team Mid-Year"
            sub={`${stats.midyear_signed} of ${stats.reports} signed off`} />
          <Tile to="/team/eval" icon={ClipboardList} title="Team Evaluation"
            sub={`${stats.evals_done} of ${stats.reports} submitted`} />
          <Tile to="/team/connects" icon={MessageCircle} title="Quarterly Connects"
            sub={`${stats.connects} logged · ${stats.open_actions} actions open`} />
        </div>
      </div>
    </div>
  );
}
