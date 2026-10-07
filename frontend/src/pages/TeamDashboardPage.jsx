import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import Summit from '../Summit';
import { Kpi, QuickActions, TeamPanel, greeting, waited } from './HomePage';
import {
  Target, TrendingUp, Clock, ClipboardList, MessageCircle, Hourglass,
  ArrowRight, ListChecks, FileWarning, PenLine, CircleCheckBig, Users, ShieldAlert,
  LayoutDashboard, Briefcase, CalendarDays,
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
//
// REBUILT ON 7 OCT on the main Dashboard's own parts, asked for with a
// screenshot: "old UI of manager dashboard which needs to be changed to new
// UI as per main dashboard". The greeting band, the pastel attention cards,
// Quick Actions and the tabbed My Team table are imported from HomePage —
// the same components, not copies — so the two pages cannot drift apart
// again. What stays the Manager Dashboard's own is its scope (your reports
// only, never the company) and the named "Waiting on you" list.

const PHASE_LABEL = {
  draft: 'Draft', kra_open: 'KRA Setting', mid_year_review: 'Mid-Year Review',
  self_appraisal: 'Self-Appraisal', manager_eval: 'Manager Evaluation',
  hod_eval: 'HOD Review', calibration: 'Calibration',
  publish: 'Publishing', closed: 'Closed',
};

// The manager's four shortcuts, in the order the work runs.
const QA_MANAGER = [
  { to: '/team/eval', label: 'Evaluate My Team', icon: PenLine, bg: '#fdecef', fg: '#e0435f' },
  { to: '/team/connects', label: 'Log Connect', icon: Users, bg: '#e9f1ff', fg: '#2563eb' },
  { to: '/team/kra-sheets', label: 'Review KRA Approvals', icon: CircleCheckBig, bg: '#e7f7ee', fg: '#1f9d5c' },
  { to: '/team/overview', label: 'Team Overview', icon: LayoutDashboard, bg: '#f1ecfd', fg: '#7c4dde' },
  { to: '/team/midyear', label: 'Team Mid-Year', icon: Clock, bg: '#fff1dc', fg: '#e7860d' },
  { to: '/team/pip', label: 'Improvement Plans', icon: ShieldAlert, bg: '#fdecef', fg: '#e0435f' },
];

export default function TeamDashboardPage({ user }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/team/home').then(setD).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const { cycle, stats, pending = [], action } = d;
  const phase = cycle ? cycle.phase : null;

  const first = String(user && user.name ? user.name : '').split(/\s+/)[0] || 'there';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // Two different empty states, because they need two different answers —
  // drawn in the same greeting band and panels as the full page, so a
  // manager with nobody under them yet does not land on the old design
  // (seen on 7 Oct: a super admin with no direct reports got the old
  // band and a bare card).
  if (!cycle || !d.reports) {
    return (
      <div className="space-y-3">
        <div className="greet">
          <Summit className="greet-art" />
          <div className="relative z-[1] min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-medium text-navy-800">
              <Briefcase size={18} className="text-brand-600" /> Manager Dashboard · {greeting()}
            </p>
            <h1 className="text-[24px] font-extrabold leading-tight" style={{ color: '#13235a' }}>{first} <span aria-hidden="true">👋</span></h1>
            <p className="text-[13px] text-navy-600">
              {cycle ? <>{cycle.name} · <b>{PHASE_LABEL[phase] || phase}</b></> : 'No cycle is open'}
            </p>
            <p className="mt-1.5 text-[12.5px] flex flex-wrap items-center gap-2">
              <span className="pill pill-blue">{!cycle ? 'No cycle' : 'No direct reports'}</span>
              <span className="text-navy-700">{!cycle ? 'Nothing to track until HR opens a cycle.' : 'Nobody reports to you yet.'}</span>
            </p>
          </div>
          <p className="greet-quote">“Great managers<br />create great journeys”</p>
          <span className="greet-date"><CalendarDays size={14} />{today}</span>
        </div>

        <div className="panel">
          <div className="panel-h">
            <Users size={17} className="text-brand-600" />
            <span className="panel-t">{!cycle ? 'No cycle is open' : 'No direct reports found'}</span>
          </div>
          <p className="text-[13px] text-navy-600">
            {!cycle
              ? 'HR opens a cycle before your team can set KRAs. This dashboard fills in as soon as it does.'
              : 'This dashboard tracks the people who report to you. Employees are linked to their manager in the employee master (HR → Employees, the Manager column); once someone reports to you, their KRAs, reviews and connects appear here.'}
          </p>
        </div>

        <QuickActions user={user} items={QA_MANAGER} />
      </div>
    );
  }

  // What is OUTSTANDING across the team, in the order it blocks people. A
  // card exists only when its count does — the main Dashboard's rule.
  const desk = [];
  if (stats.kra_pending > 0)
    desk.push({ key: 'kra', icon: Target, hue: 'violet', n: stats.kra_pending, label: 'KRA sheets to decide', to: '/team/kra-sheets' });
  if (stats.growth_pending > 0)
    desk.push({ key: 'gro', icon: TrendingUp, hue: 'leaf', n: stats.growth_pending, label: 'Target plans to decide', to: '/team/growth' });
  if (stats.appraisal_pending > 0)
    desk.push({ key: 'sa', icon: ClipboardList, hue: 'red', n: stats.appraisal_pending, label: 'Annual reviews to evaluate', to: '/team/eval' });
  if (phase === 'mid_year_review' && stats.midyear_pending > 0)
    desk.push({ key: 'mid', icon: Clock, hue: 'azure', n: stats.midyear_pending, label: 'Mid-year sign-offs due', to: '/team/midyear' });
  if (stats.kra_returned > 0)
    desk.push({ key: 'ret', icon: FileWarning, hue: 'red', n: stats.kra_returned, label: 'KRA sheets returned', to: '/team/kra-sheets' });
  if (stats.kra_not_submitted > 0)
    desk.push({ key: 'ns', icon: Hourglass, hue: 'navy', n: stats.kra_not_submitted, label: 'KRAs not submitted yet', to: '/team/overview' });
  if (stats.no_connect > 0)
    desk.push({ key: 'nc', icon: MessageCircle, hue: 'amber', n: stats.no_connect, label: 'No Connect Logged Yet', to: '/team/connects' });
  if (stats.open_actions > 0)
    desk.push({ key: 'oa', icon: ListChecks, hue: 'amber', n: stats.open_actions, label: 'Connect actions open', to: '/team/connects' });
  // Fewer than four outstanding: the row is completed with where the team
  // stands — real numbers, never zero-padding to look busy.
  const progress = [
    { key: 'pk', icon: Target, hue: 'navy', n: `${stats.kra_approved}/${stats.reports}`, label: 'KRAs approved', to: '/team/kra-sheets' },
    { key: 'pe', icon: ClipboardList, hue: 'violet', n: `${stats.evals_done}/${stats.reports}`, label: 'Evaluations done', to: '/team/eval' },
    { key: 'pm', icon: Clock, hue: 'azure', n: `${stats.midyear_signed}/${stats.reports}`, label: 'Mid-year signed', to: '/team/midyear' },
    { key: 'pc', icon: MessageCircle, hue: 'leaf', n: stats.connects, label: 'Connects logged', to: '/team/connects' },
  ];
  const cards = [...desk, ...progress.slice(0, Math.max(0, 4 - desk.length))];
  return (
    <div className="space-y-3">
      <div className="greet">
        <Summit className="greet-art" />
        <div className="relative z-[1] min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-medium text-navy-800">
            <Briefcase size={18} className="text-brand-600" /> Manager Dashboard · {greeting()}
          </p>
          <h1 className="text-[24px] font-extrabold leading-tight" style={{ color: '#13235a' }}>{first} <span aria-hidden="true">👋</span></h1>
          <p className="text-[13px] text-navy-600">
            {stats.reports} {stats.reports === 1 ? 'report' : 'reports'} · {cycle.name} · <b>{PHASE_LABEL[phase] || phase}</b>
          </p>
          {action && action.tone !== 'clear' ? (
            <p className="mt-1.5 text-[12.5px] flex flex-wrap items-center gap-2">
              <span className="pill pill-red">Action needed</span>
              <b className="text-navy-900">{action.title}</b>
              {action.cta && <NavLink to={action.to} className="inline-flex items-center gap-1 font-semibold text-brand-600">{action.cta} <ArrowRight size={13} /></NavLink>}
            </p>
          ) : (
            <p className="mt-1.5 text-[12.5px] flex flex-wrap items-center gap-2">
              <span className="pill pill-green">Up to date</span>
              <span className="text-navy-700">{action ? action.title : 'Nothing is waiting on you'}</span>
            </p>
          )}
        </div>
        <p className="greet-quote">“Great managers<br />create great journeys”</p>
        <span className="greet-date"><CalendarDays size={14} />
          {today}</span>
      </div>

      <div className="kpirow">
        {cards.map(({ key, ...x }) => <Kpi key={key} {...x} />)}
      </div>

      <QuickActions user={user} items={QA_MANAGER} />

      {/* NAMED, not counted. "3 pending" tells a manager nothing they can
          act on; "Priya — KRA sheet — waiting 6 days" tells them what to
          open. The mirror of "Requested to manager" on the employee's
          own dashboard: one row in the database, read from the other end. */}
      {pending.length > 0 && (
        <div className="panel">
          <div className="panel-h">
            <Hourglass size={17} className="text-amber2-600" />
            <span className="panel-t">Waiting on you</span>
            <span className="text-[12px] text-navy-400">
              {pending.length} {pending.length === 1 ? 'submission needs' : 'submissions need'} a decision from you
            </span>
          </div>
          <div className="divide-y divide-[#eef1f6]">
            {pending.map((p, i) => (
              <NavLink key={i} to={p.to} className="py-2 flex flex-wrap items-center gap-2 text-[13px] hover:bg-navy-50 rounded-lg px-1">
                <b className="text-navy-900">{p.name}</b>
                <span className="pill pill-blue">{p.label}</span>
                <span className="ml-auto text-[12px] text-navy-400 inline-flex items-center gap-1"><Hourglass size={12} />{waited(p.since)}</span>
                <ArrowRight size={13} className="text-navy-300" />
              </NavLink>
            ))}
          </div>
        </div>
      )}

      {/* The main Dashboard's My Team table: counts, tabs, search, a
          department filter, one row per report. Your reports only. */}
      <TeamPanel />
    </div>
  );
}
