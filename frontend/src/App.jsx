import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Target, ClipboardList, Users, Landmark, Sparkles, BarChart3, HeartHandshake, Star, LogOut, Upload, User, ShieldAlert, Award, Grid3x3, TrendingUp, Clock, MessageCircle, FileText, UserCog, History, LayoutDashboard, GitBranch, Calculator, ShieldCheck, Library, SlidersHorizontal, CheckCircle2, Home, Gauge, Layers, CalendarClock, Lock, KeyRound, MapPin, Search, HelpCircle, ChevronDown, Menu, RefreshCw } from 'lucide-react';
import { api } from './utils/api';
import MyKRASheetPage from './pages/MyKRASheetPage';
import SelfAppraisalPage from './pages/SelfAppraisalPage';
import TeamEvalPage from './pages/TeamEvalPage';
import TeamKraSheetsPage from './pages/TeamKraSheetsPage';
import HodQueuePage from './pages/HodQueuePage';
import CycleAdminPage from './pages/CycleAdminPage';
import CalibrationPage from './pages/CalibrationPage';
import MyRatingPage from './pages/MyRatingPage';
import MySurveysPage, { EngagementAdminPage } from './pages/EngagementPage';
import EngagementInsightsPage, { HrOpsOnboardingPage } from './pages/EngagementInsightsPage';
import { SHOW_FIRST_WEEK_JOURNEY } from './features';
import PeopleHubPage from './pages/PeopleHubPage';
import DirectoryPage from './pages/DirectoryPage';
import DepartmentHeadsPage from './pages/DepartmentHeadsPage';
import CompletionReportPage from './pages/CompletionReportPage';
import CareerTransitionsPage from './pages/CareerTransitionsPage';
import HistoryPage from './pages/HistoryPage';
import MyCompetenciesPage from './pages/MyCompetenciesPage';
import TeamCompetenciesPage from './pages/TeamCompetenciesPage';
import CompetencyFrameworkPage from './pages/CompetencyFrameworkPage';
import CompetencyDashboardPage from './pages/CompetencyDashboardPage';
import MyTimesheetPage from './pages/MyTimesheetPage';
import TeamTimesheetPage from './pages/TeamTimesheetPage';
import HrTimesheetPage from './pages/HrTimesheetPage';
import HrbpAdminPage from './pages/HrbpAdminPage';
import RnrNominatePage from './pages/RnrNominatePage';
import RnrApprovalsPage from './pages/RnrApprovalsPage';
import RnrAdminPage from './pages/RnrAdminPage';
import RnrDashboardPage from './pages/RnrDashboardPage';
import TeamDashboardPage from './pages/TeamDashboardPage';
import TeamOverviewPage from './pages/TeamOverviewPage';
import PIPPage from './pages/PIPPage';
import HodCompetenciesPage from './pages/HodCompetenciesPage';
import WatchlistPage from './pages/WatchlistPage';
import NotificationBell from './pages/NotificationBell';
import NineBoxPage from './pages/NineBoxPage';
import MyGrowthPage, { TeamGrowthPage } from './pages/MyGrowthPage';
import KraOrgOverviewPage from './pages/KraOrgOverviewPage';
import KraLibraryPage from './pages/KraLibraryPage';
import AnnualReviewPage from './pages/AnnualReviewPage';
import MidYearReviewPage, { TeamMidYearPage } from './pages/MidYearReviewPage';
import ConnectsPage from './pages/ConnectsPage';
import ClosureLettersPage from './pages/ClosureLettersPage';
import IncrementSimulationPage from './pages/IncrementSimulationPage';
import SettingsPage from './pages/SettingsPage';
import ApprovalsPage from './pages/ApprovalsPage';
import HomePage from './pages/HomePage';
import Summit from './Summit';

// THE THREE ROLE TABS, named on 23 Sep to match the reference: SELF for
// everyone, + MANAGER for people with reports, + HR for HR and super
// admin. The names say whose data the tab is about, which is the rule
// that decides where a page goes — and the rule the Mid-Year split came
// from: a list of other people is never Self.
//
// Engagement and People Hub folded into Self rather than keeping a fourth
// tab: taking a survey and reading the noticeboard are things you do as
// yourself, and the reference shows three tabs.
//
// WHICH TABS YOU SEE is still decided by core.page_permission, not by
// this list — a group whose pages you may not open disappears. The names
// here only describe the grouping.
const NAV = [
  { group: 'Self', hue: 'navy', icon: User, items: [
    { to: '/home', label: 'Dashboard', icon: Home },
    { to: '/my/kras', label: 'My KRAs', icon: Target },
    { to: '/my/growth', label: 'My Growth', icon: TrendingUp },
    // Asked for on 22 Sep: Connects sits between My Growth and
    // Mid-Year Review. It belongs here rather than under Team because the
    // page is TWO-SIDED — GET /pms/connects returns rows where the caller
    // is the employee OR the manager — and because it follows the year as
    // people live it: set your KRAs, plan your growth, have your quarterly
    // conversations, then review at the halfway point.
    //
    // The ROUTE stays /team/connects. It is in bookmarks and in links
    // inside notifications already sent; only the menu position moves.
    { to: '/team/connects', label: 'Connects', icon: MessageCircle },
    { to: '/my/midyear', label: 'Mid-Year Review', icon: Clock },
    // RENAMED on request, as a pair. What was 'Self-Appraisal' is now
    // 'Annual Review', and what was 'Annual Review' is now 'Final Rating'
    // (it presents consolidated ratings). These two MUST move together —
    // renaming either alone puts two 'Annual Review' entries in this menu.
    // The ROUTES are unchanged: /my/self-appraisal and /my/annual-review
    // are in people's bookmarks and in links inside notifications already
    // sent. Only the labels move.
    { to: '/my/self-appraisal', label: 'Annual Review', icon: ClipboardList },
    { to: '/my/annual-review', label: 'Final Rating', icon: Award },
    // CLOSED UNTIL A RATING IS PUBLISHED, asked for on 27 Sep: "my rating
    // option should be visible to employee only when appraisal is
    // published or it can be unclickable until appraisal is published."
    // Unclickable is the one this product already does everywhere else —
    // see HomePage.jsx's header. `gate` names a runtime fact, NOT a
    // permission: core.page_permission still decides who may open this
    // page at all, and it is open to everyone because it is your own
    // rating. What this adds is "there is nothing behind it yet".
    { to: '/my/rating', label: 'My Rating', icon: Star, gate: 'rating',
      gateHint: 'Your rating appears here once HR publishes your appraisal' },
    { to: '/my/history', label: 'Past Cycles', icon: History },
    // MOVED OUT OF THE TEAM GROUP on 23 Sep, asked for directly: an
    // employee should not see a Team tab at all. This page was the only
    // thing left in it for them, because it is deliberately public — it
    // is row-scoped in the handler, so an employee sees their OWN plan
    // and a manager sees their reports'. Gating it would have taken an
    // employee's own improvement plan away from them to tidy a tab, so
    // it moved instead. A manager still reaches their reports' plans
    // here; the page itself is unchanged.
    // Competency mapping, added 24 Sep from the client's own workbook.
    // Next to Improvement Plan because both are about capability rather
    // than this year's targets.
    { to: '/my/competencies', label: 'My Competencies', icon: Gauge },
    // Timesheet, added 25 Sep. Deliberately just an upload and the
    // employee's own report: "only upload option and their own report
    // should be available for employees". The same label appears in
    // the Manager and HR groups over a different scope, which is what
    // was asked for — one tab named Timesheet on all three.
    { to: '/my/timesheet', label: 'Timesheet', icon: CalendarClock },
    { to: '/pip', label: 'Improvement Plan', icon: ShieldAlert },
    // ENGAGEMENT WAS SPLIT on 23 Sep, asked for directly: "Engagement tab
    // should be under HR tab and not my performance". The half that is
    // genuinely yours stays — the surveys you have been invited to and
    // the one you are filling in. Running surveys (writing them, opening
    // and closing them, reading results and themes) moved to HR, where
    // the person who does that work already lives. Splitting rather than
    // moving wholesale is the difference between an employee still being
    // able to answer a survey and being unable to.
    { to: '/engagement', label: 'My Surveys', icon: HeartHandshake },
    { to: '/people', label: 'People Hub', icon: User },
  ]},
  { group: 'Manager', hue: 'lagoon', icon: Users, items: [
    // Added 24 Sep on request: the Manager tab's own landing page, the
    // same thing /home is for a person's own work. First in the group
    // because it is where a manager now starts, and because it links on
    // to everything below it.
    { to: '/team/dashboard', label: 'Manager Dashboard', icon: Gauge },
    // Moved down on 6 Oct, asked for directly: "manager dashboard should
    // be first instead of nominate for RnR". Opening the Manager section
    // lands on its first page, so the dashboard is now where it starts.
    { to: '/rnr/nominate', label: 'Nominate for RnR', icon: Award },
    { to: '/team/overview', label: 'Team Overview', icon: LayoutDashboard },
    { to: '/team/kra-sheets', label: 'Team KRA Sheets', icon: ClipboardList },
    // Split out of /my/growth on 23 Sep for the same reason the Mid-Year
    // split happened: "my growth still shows team target achievement …
    // which should ideally be under Manager tab". A list of other
    // people's plans is never Self, whatever page it grew up on.
    { to: '/team/growth', label: 'Team Target Achievements', icon: TrendingUp },
    // Split out of /my/midyear — see TeamMidYearPage for why.
    { to: '/team/midyear', label: 'Team Mid-Year', icon: Clock },
    { to: '/team/eval', label: 'Team Evaluation', icon: Users },
    { to: '/team/competencies', label: 'Team Competencies', icon: Gauge },
    // Opened by the manager from here or from Team Evaluation (7 Oct).
    { to: '/team/pip', label: 'Improvement Plans', icon: ShieldAlert },
    { to: '/team/timesheet', label: 'Timesheet', icon: CalendarClock },
  ]},
  // DELIVERY HEAD IS ITS OWN TAB from 24 Sep, asked for directly:
  // "There should be separate HOD tab next to 3 roles of employee,
  // manager and HR and remove the same from manager tab."
  //
  // It was the odd one out in the Manager group: everything else there
  // is a manager acting on their own reports, while this is a
  // department head acting on a whole department, behind a different
  // permission (pms_hod, not pms_team_eval). A manager without
  // pms_hod never saw it anyway — the group filter dropped it — so
  // this changes nothing for them, and gives the people who DO hold
  // it a tab of their own instead of one entry at the end of somebody
  // else's.
  //
  // The tab disappears for anyone without pms_hod, because a group
  // whose every item is filtered out is dropped (see visibleGroups).
  { group: 'HOD', hue: 'leaf', icon: Landmark, items: [
    { to: '/hod', label: 'HOD Review', icon: Landmark },
    // Every employee in the HOD's departments, by department (7 Oct).
    { to: '/hod/competencies', label: 'Team Competencies', icon: Gauge },
    { to: '/rnr/approvals/delivery-head', label: 'RnR Approvals', icon: Award },
  ]},
  // HRBP — HR for a slice of the company rather than all of it. Between
  // HOD and HR because that is the order of widening scope:
  // your reports, your department, your locations, everybody.
  //
  // The same operational pages HR has, minus three that cannot be scoped
  // and should not be held: Increment Simulation (salary), Settings
  // (tenant-wide) and the KRA Library (publishes shelves org-wide).
  // EVERY HR TAB, on parallel routes. Asked for after the first cut
  // shipped: "HRBP should have all tabs available in HR but with
  // conditions we have mentioned". The pages are HR's own components —
  // the rows they show are narrowed to the partner's remit by
  // hrbp-gateway.js on the server, so there is one page to maintain
  // rather than two that drift. The six marked read-only below apply to
  // the whole company and cannot be scoped, so an HRBP reads them and
  // the server refuses the write.
  // TRIMMED ON 7 OCT, asked for directly: Cycles, HOD, Career Pathing
  // Matrix, Settings, Super 50, Engagement Surveys, 9-Box Grid, Closure
  // Letters and Increment Simulation "needs to be removed" from the HRBP
  // tab. They stay with HR. The routes went with the menu entries and the
  // page rows with both (migration 085), so a typed URL cannot reach what
  // the menu no longer offers.
  { group: 'HRBP', hue: 'amber', icon: MapPin, items: [
    { to: '/hrbp/approvals', label: 'All Approvals', icon: CheckCircle2 },
    { to: '/hrbp/rnr-approvals', label: 'RnR Approvals', icon: Award },
    { to: '/hrbp/directory', label: 'Employees', icon: Upload },
    { to: '/hrbp/kra-overview', label: 'KRA Overview', icon: ClipboardList },
    { to: '/hrbp/kra-library', label: 'KRA Library', icon: Library },
    { to: '/hrbp/competencies', label: 'Competency Framework', icon: Layers },
    { to: '/hrbp/competency-dashboard', label: 'Competency Dashboard', icon: Gauge },
    { to: '/hrbp/timesheet', label: 'Timesheet', icon: CalendarClock },
    { to: '/hrbp/completion-report', label: 'PMS Completion Report', icon: FileText },
    { to: '/hrbp/calibration', label: 'Calibration', icon: Sparkles },
    { to: '/hrbp/engagement-insights', label: 'New Hire Insights', icon: HeartHandshake },
  ]},
  { group: 'HR', hue: 'violet', icon: ShieldCheck, items: [
    { to: '/admin/approvals', label: 'All Approvals', icon: CheckCircle2 },
    { to: '/admin/cycles', label: 'Cycles', icon: BarChart3 },
    { to: '/admin/directory', label: 'Employees', icon: Upload },
    { to: '/admin/department-heads', label: 'HOD', icon: UserCog },
    { to: '/admin/hrbp', label: 'HR Business Partners', icon: MapPin },
    { to: '/rnr/approvals/hr', label: 'RnR Final Approval', icon: Award },
    { to: '/admin/rnr', label: 'RnR Administration', icon: Award },
    { to: '/admin/career-transitions', label: 'Career Pathing Matrix', icon: GitBranch },
    { to: '/admin/kra-overview', label: 'KRA Overview', icon: ClipboardList },
    // Next to KRA Overview because the two are easily confused and the
    // difference matters: Overview assigns KRAs to named people, this
    // publishes a shelf per job title that employees pick from.
    { to: '/admin/kra-library', label: 'KRA Library', icon: Library },
    { to: '/admin/competencies', label: 'Competency Framework', icon: Layers },
    { to: '/admin/competency-dashboard', label: 'Competency Dashboard', icon: Gauge },
    { to: '/admin/timesheet', label: 'Timesheet', icon: CalendarClock },
    { to: '/admin/completion-report', label: 'PMS Completion Report', icon: FileText },
    { to: '/admin/calibration', label: 'Calibration', icon: Sparkles },
    { to: '/admin/nine-box', label: '9-Box Grid', icon: Grid3x3 },
    { to: '/admin/closure-letters', label: 'Closure Letters', icon: FileText },
    // Salary sits behind its own permission, so this link is HR/admin only
    // — a manager must never see it, let alone open it.
    { to: '/admin/increments', label: 'Increment Simulation', icon: Calculator },
    // 'Review Analysis (HR)' — the AI read of an annual review meeting
    // against the 7 organisational parameters — was REMOVED from the menu
    // on 23 Sep with the rest of the 7-parameter UI. Its page component,
    // its /agentic/parameter-analysis routes and every analysis already
    // stored are untouched; only the way in is gone.
    { to: '/admin/watchlist', label: 'Super 50', icon: Award },
    // The admin half of Engagement — see the Self group for the split.
    { to: '/admin/engagement', label: 'Engagement Surveys', icon: HeartHandshake },
    { to: '/admin/engagement-insights', label: 'New Hire Insights', icon: HeartHandshake },
    // Tenant-wide configuration. Last in the group because it is set once
    // and then left alone, unlike everything above it.
    { to: '/admin/settings', label: 'Settings', icon: SlidersHorizontal },
  ]},
  // HR OPS — the team that keeps the First-Week Journey's ticks (asked
  // for on 7 Oct: the checkbox is "managed by HR Ops team and accessible
  // to HRBP and HRs"). HR and HRBP already reach the same tracker under
  // New Hire Insights, so the entry is hidden for anyone who can open
  // either of those — one way in per person.
  { group: 'HR Ops', hue: 'lagoon', icon: CalendarClock, items: [
    { to: '/hrops/onboarding', label: 'First-Week Journey', icon: CheckCircle2,
      hideIf: ['/admin/engagement-insights', '/hrbp/engagement-insights'] },
  ]},

];

const signOut = () => { localStorage.removeItem('apms_token'); location.href = '/'; };

// What this person may open, from core.page_permission via /me. One row
// there drives BOTH the sidebar and the direct-URL guard below, so a hidden
// menu item and a typed URL can never disagree.
//
// `pages == null` means the tenant has no page rows — unconfigured, not "no
// access" — and the menu falls back to showing everything, which is what it
// did before this existed. The API enforces its own permissions either way,
// so an unfiltered menu is a tidiness problem, never an access one.
const mayOpen = (user, route) => !user.pages || user.pages.includes(route);

// A menu entry whose page exists and is permitted, but has nothing behind
// it yet. It stays in the row, greyed and unclickable, and says on hover
// what will open it. `gates[x] === false` is the only closed state:
// undefined means the answer has not come back (or the call failed), and
// an unanswered gate leaves the entry working — a UI gate that fails shut
// would hide a rating somebody actually has, and there is nothing behind
// it to protect, since the page shows only your own data and the API
// guards itself.
const gateClosed = (item, gates) => !!item.gate && gates[item.gate] === false;

// THE SHELL, rebuilt on 6 Oct to the reference the client sent ("current
// UI seems bit dull for working, please build exact UI as shown"): a
// white top bar carrying the product's name, a search box, the bell, help
// and the person; a dark navy sidebar down the left; the page on a light
// canvas to the right.
//
// ONE DELIBERATE DIFFERENCE FROM THE PICTURE. The reference lists
// features down the sidebar (My Team, Evaluations, Connects, KRA, …).
// This product's menu is grouped by ROLE — Self, Manager, HOD, HRBP, HR —
// which the client asked for on 23 and 24 Sep, and which is what decides
// whose data a page shows. Flattening it into features would put "my
// KRAs" and "the whole company's KRAs" next to each other under one
// word. So the sidebar keeps the role groups as its sections, styled
// the way the reference styles its items, and opens the group you are
// in. Everything else on the reference is built as drawn.
//
// WHICH GROUPS YOU SEE is still decided by core.page_permission (mayOpen),
// exactly as the tabs were — a group whose pages you may not open is
// not drawn.

const visibleGroups = (user) => NAV
  .map(g => ({ ...g, items: g.items.filter(it => mayOpen(user, it.to)
    // The First-Week Journey is hidden on screen (features.js); its page
    // and data stay, and the HR Ops entry comes back with the switch.
    && (SHOW_FIRST_WEEK_JOURNEY || it.to !== '/hrops/onboarding')
    && !(it.hideIf && user.pages && it.hideIf.some(r => user.pages.includes(r)))) }))
  .filter(g => g.items.length > 0);

const groupOf = (groups, pathname) =>
  groups.find(g => g.items.some(it => it.to !== '/home' && (pathname === it.to || pathname.startsWith(it.to + '/'))));

// THE PRODUCT'S NAME, not the client's. The reference drew a Mindgate
// logo here with "People Management System" beside it; on 6 Oct the
// client asked for it to read "Performance Management System and not
// Mindgate". One name, so the separate subtitle went with the logo.
// The four coloured dots of the reference stay as a small mark — they
// were the drawing's, not a trademark — and a phone shows "PMS", because
// the full name and the bell, help and account icons do not fit 390px.
function Wordmark() {
  return (
    <span className="wordmark" aria-label="Performance Management System">
      <span className="wordmark-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span className="hidden sm:inline">Performance Management System</span>
      <span className="sm:hidden">PMS</span>
    </span>
  );
}

// Search the pages this person can open. A page search rather than an
// employee search on purpose: it works for every role, it cannot show
// anybody a name they may not see, and "where is Calibration?" is the
// question the old 22-item HR row was worst at answering.
function NavSearch({ groups }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const hits = q.trim().length < 2 ? [] : groups.flatMap(g => g.items.map(it => ({ ...it, group: g.group })))
    .filter(it => `${it.label} ${it.group}`.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 8);
  const go = (to) => { setQ(''); setOpen(false); nav(to); };
  return (
    <div className="topsearch" onBlur={() => setTimeout(() => setOpen(false), 150)}>
      <Search size={16} className="text-navy-400 shrink-0" />
      <input value={q} placeholder="Search for a page — KRA, evaluation, connects…"
        aria-label="Search pages"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && hits[0]) go(hits[0].to); if (e.key === 'Escape') setOpen(false); }} />
      {open && hits.length > 0 && (
        <div className="topsearch-pop">
          {hits.map(h => (
            <button key={h.to} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => go(h.to)}>
              <h.icon size={14} className="text-brand-600 shrink-0" />
              <span className="flex-1 text-left">{h.label}</span>
              <span className="text-[11px] text-navy-400">{h.group}</span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim().length >= 2 && hits.length === 0 && (
        <div className="topsearch-pop"><p className="px-3 py-2 text-xs text-navy-400">No page you can open matches “{q}”.</p></div>
      )}
    </div>
  );
}

// Click-away popover, for the help and person menus.
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  return { open, setOpen, ref };
}

const ROLE_LABEL = { admin: 'Super Admin', hr: 'HR', hod: 'HOD', manager: 'Manager', employee: 'Employee', hrbp: 'HRBP' };

function Topbar({ user, groups, onChangePassword, onMenu }) {
  const help = usePopover();
  const me = usePopover();
  const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <button type="button" className="lg:hidden p-1.5 -ml-1 rounded-lg hover:bg-navy-50" onClick={onMenu} aria-label="Open menu">
          <Menu size={20} />
        </button>
        <NavLink to="/home" className="flex items-center"><Wordmark /></NavLink>
      </div>
      <div className="flex-1 min-w-0 hidden md:flex justify-center px-4"><NavSearch groups={groups} /></div>
      <div className="flex items-center gap-1 sm:gap-2 shrink-0 ml-auto">
        <span className="topicon"><NotificationBell /></span>
        <div className="relative" ref={help.ref}>
          <button type="button" className="topicon" onClick={() => help.setOpen(v => !v)} aria-label="Help">
            <HelpCircle size={20} />
          </button>
          {help.open && (
            <div className="menu-pop w-72 p-3 text-[12.5px] text-navy-600 space-y-2">
              <p className="font-bold text-navy-900">Finding your way</p>
              <p>The menu on the left is grouped by role — <b>Self</b> is your own work, <b>Manager</b> your reports, then <b>HOD</b>, <b>HRBP</b> and <b>HR</b> as the scope widens. You only see the groups you hold.</p>
              <p>Search at the top finds any page you can open. Stuck on access? HR can grant a page per role without a release.</p>
              <p className="text-[11px] text-navy-400">Build {typeof __APP_BUILD__ !== 'undefined' && __APP_BUILD__ ? __APP_BUILD__ : 'local'}</p>
            </div>
          )}
        </div>
        <div className="relative" ref={me.ref}>
          <button type="button" className="flex items-center gap-2.5 pl-1 pr-1.5 py-1 rounded-xl hover:bg-navy-50"
            onClick={() => me.setOpen(v => !v)} aria-label="Your account">
            <span className="avatar">{initial}</span>
            <span className="hidden sm:block text-left leading-tight">
              <span className="block text-[13px] font-bold text-navy-900">{user.name}</span>
              <span className="block text-[11.5px] text-navy-400">{ROLE_LABEL[user.role] || user.role}</span>
            </span>
            <ChevronDown size={16} className="text-navy-500 hidden sm:block" />
          </button>
          {me.open && (
            <div className="menu-pop w-56 py-1.5">
              <p className="px-3 py-1.5 text-[11.5px] text-navy-400 truncate">{user.email}</p>
              <button type="button" className="menu-item" onClick={() => { me.setOpen(false); onChangePassword(); }}>
                <KeyRound size={14} /> Change password
              </button>
              <button type="button" className="menu-item" onClick={signOut}><LogOut size={14} /> Sign out</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function Sidebar({ user, groups, gates, mobileOpen, onClose }) {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const here = groupOf(groups, pathname);
  // Which groups are expanded. The one you are in always is — a link from
  // a notification has to land with its group open — and others open on
  // a click. Expanding a group also opens its first page, as the tabs
  // did: a group is a place to go, not just a heading.
  const [openGroups, setOpenGroups] = useState(() => new Set(here ? [here.group] : []));
  useEffect(() => { if (here) setOpenGroups(s => (s.has(here.group) ? s : new Set([...s, here.group]))); }, [here && here.group]);
  useEffect(() => { onClose(); }, [pathname]);
  const dash = mayOpen(user, '/home');
  const toggle = (g) => {
    const isOpen = openGroups.has(g.group);
    setOpenGroups(s => { const n = new Set(s); if (isOpen) n.delete(g.group); else n.add(g.group); return n; });
    if (!isOpen && here !== g) nav(g.items.filter(it => it.to !== '/home')[0].to);
  };
  return (
    <>
      {mobileOpen && <div className="fixed inset-0 bg-navy-900/40 z-30 lg:hidden" onClick={onClose} />}
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1 sidebar-scroll">
          {dash && (
            <NavLink to="/home" className={({ isActive }) => `side-item side-top ${isActive ? 'side-on' : ''}`}>
              <Home size={18} /> Dashboard
            </NavLink>
          )}
          {groups.map(g => {
            const items = g.items.filter(it => it.to !== '/home');
            if (!items.length) return null;
            const isOpen = openGroups.has(g.group);
            return (
              <div key={g.group}>
                <button type="button" onClick={() => toggle(g)} aria-expanded={isOpen}
                  className={`side-item side-top side-group ${here === g ? 'side-group-here' : ''}`}>
                  <g.icon size={18} />
                  <span className="flex-1 text-left">{g.group}</span>
                  <span className="side-count">{items.length}</span>
                  <ChevronDown size={15} className={`transition-transform ${isOpen ? '' : '-rotate-90'} opacity-70`} />
                </button>
                {isOpen && (
                  <nav className={`subnav side-sub ${here === g ? '' : 'side-sub-peek'}`} aria-label={g.group}>
                    {items.map(it => (gateClosed(it, gates) ? (
                      <span key={it.to} className="subnav-item side-item side-leaf opacity-40 cursor-not-allowed select-none"
                        title={it.gateHint} aria-disabled="true">
                        <it.icon size={15} />{it.label}<Lock size={11} className="ml-auto shrink-0" />
                      </span>
                    ) : (
                      <NavLink key={it.to} to={it.to}
                        // Exact match when another menu entry lives under
                        // this one's path (/hod and /hod/competencies), so
                        // both are not lit at once.
                        end={groups.some((gg) => gg.items.some((o) => o.to.startsWith(`${it.to}/`)))}
                        className={({ isActive }) => `subnav-item side-item side-leaf ${isActive ? 'side-on subnav-on' : ''}`}>
                        <it.icon size={15} /><span className="truncate">{it.label}</span>
                      </NavLink>
                    )))}
                  </nav>
                )}
              </div>
            );
          })}
        </div>
        <div className="side-card">
          <p>“People<br />Processes<br />Progress<br />Together”</p>
          <Summit className="side-card-art" />
        </div>
      </aside>
    </>
  );
}

// "I DEPLOYED AND NOTHING CHANGED." A single-page app never reloads
// itself: a tab opened before a deploy keeps running the old screens for
// as long as it stays open, however healthy the deploy was. This asks the
// API which commit it is running and, if the bundle in this tab was built
// from a different one, says so with a one-click reload. Silent when
// either side does not know its build (a local dev server, a copied
// tree) — a banner that guesses would cry wolf.
function BuildWatch() {
  const mine = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : null;
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!mine) return undefined;
    const check = () => fetch('/api/v1/health').then(r => r.json()).then(r => setLive(r.build || null)).catch(() => {});
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    const onFocus = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onFocus); };
  }, [mine]);
  if (!mine || !live || live === mine) return null;
  return (
    <div className="buildbar" role="status">
      <RefreshCw size={14} />
      A newer version of PMS has been deployed ({live}). This tab is still on {mine}.
      <button type="button" onClick={() => location.reload()}>Reload now</button>
    </div>
  );
}

// The direct-URL guard. Hiding a menu item is tidiness; this is what
// answers someone who pastes a link to a page they may not open. It reads
// the SAME list as the sidebar, so the two cannot drift apart.
//
// A path with no page row — the "/" redirect, or a page added to the router
// before it is registered in core.page_permission — is allowed through and
// left to the API, which guards itself.
function NoAccess() {
  return (
    <div className="card p-8 text-center max-w-lg mx-auto">
      <p className="text-lg font-bold">This page is not part of your access</p>
      <p className="text-sm text-navy-400 mt-2">
        If you need it, ask HR to grant it — access is set per role, so they can
        change it without a release.
      </p>
      <NavLink to="/home" className="btn-pri inline-block mt-4">Back to Home</NavLink>
    </div>
  );
}

function Main({ user }) {
  const { pathname } = useLocation();
  // Longest match, so /admin/kra-library is not answered by /admin/kra.
  const known = NAV.flatMap(g => g.items.map(it => it.to))
    .filter(to => pathname === to || pathname.startsWith(to + '/'))
    .sort((a, b) => b.length - a.length)[0];
  const blocked = known && !mayOpen(user, known);
  return (
    <main className="flex-1 min-w-0 p-4 lg:p-6 w-full">
      <div className="max-w-[1500px] mx-auto">
      {blocked ? <NoAccess /> : (
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<HomePage user={user} />} />
              <Route path="/my/kras" element={<MyKRASheetPage />} />
              <Route path="/admin/increments" element={<IncrementSimulationPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
              <Route path="/admin/approvals" element={<ApprovalsPage />} />
              <Route path="/my/self-appraisal" element={<SelfAppraisalPage />} />
              <Route path="/my/rating" element={<MyRatingPage />} />
              <Route path="/my/midyear" element={<MidYearReviewPage />} />
              <Route path="/team/midyear" element={<TeamMidYearPage />} />
              <Route path="/my/growth" element={<MyGrowthPage />} />
              <Route path="/team/growth" element={<TeamGrowthPage />} />
              <Route path="/my/annual-review" element={<AnnualReviewPage />} />
              <Route path="/my/history" element={<HistoryPage />} />
              <Route path="/my/competencies" element={<MyCompetenciesPage />} />
              <Route path="/team/competencies" element={<TeamCompetenciesPage />} />
              <Route path="/admin/competencies" element={<CompetencyFrameworkPage />} />
              <Route path="/admin/competency-dashboard" element={<CompetencyDashboardPage />} />
              <Route path="/my/timesheet" element={<MyTimesheetPage />} />
              <Route path="/team/timesheet" element={<TeamTimesheetPage />} />
              <Route path="/admin/timesheet" element={<HrTimesheetPage />} />
              <Route path="/admin/hrbp" element={<HrbpAdminPage />} />
              {/* Rewards & Recognition. The approval queue is one component
                  for all three stages — they differ only in which status
                  they read, and three copies is three places a rule moves. */}
              <Route path="/rnr/dashboard" element={<RnrDashboardPage />} />
              <Route path="/rnr/nominate" element={<RnrNominatePage />} />
              <Route path="/rnr/my-nominations" element={<RnrDashboardPage />} />
              <Route path="/rnr/approvals/delivery-head" element={<RnrApprovalsPage />} />
              <Route path="/hrbp/rnr-approvals" element={<RnrApprovalsPage />} />
              <Route path="/rnr/approvals/hr" element={<RnrApprovalsPage />} />
              <Route path="/admin/rnr" element={<RnrAdminPage />} />
              {/* One component for all seven: they differ only in which
                  endpoint they read, and seven near-identical files would
                  drift the way the Timesheet tabs once did. */}
              {/* HR's own pages, opened by an HRBP. The server narrows
                  what comes back; these routes only decide what opens. */}
              <Route path="/hrbp/approvals" element={<ApprovalsPage />} />
              <Route path="/hrbp/directory" element={<DirectoryPage />} />
              <Route path="/hrbp/kra-overview" element={<KraOrgOverviewPage />} />
              <Route path="/hrbp/kra-library" element={<KraLibraryPage />} />
              <Route path="/hrbp/competencies" element={<CompetencyFrameworkPage />} />
              <Route path="/hrbp/competency-dashboard" element={<CompetencyDashboardPage />} />
              <Route path="/hrbp/timesheet" element={<HrTimesheetPage />} />
              <Route path="/hrbp/completion-report" element={<CompletionReportPage />} />
              <Route path="/hrbp/calibration" element={<CalibrationPage />} />
              <Route path="/hrbp/engagement-insights" element={<EngagementInsightsPage />} />
              <Route path="/hrops/onboarding" element={<HrOpsOnboardingPage />} />
              <Route path="/team/dashboard" element={<TeamDashboardPage user={user} />} />
              <Route path="/team/overview" element={<TeamOverviewPage />} />
              <Route path="/team/kra-sheets" element={<TeamKraSheetsPage />} />
              <Route path="/team/eval" element={<TeamEvalPage user={user} />} />
              <Route path="/team/connects" element={<ConnectsPage />} />
              <Route path="/hod" element={<HodQueuePage />} />
              <Route path="/hod/competencies" element={<HodCompetenciesPage />} />
              <Route path="/pip" element={<PIPPage />} />
              <Route path="/team/pip" element={<PIPPage manager />} />
              <Route path="/admin/cycles" element={<CycleAdminPage />} />
              <Route path="/admin/calibration" element={<CalibrationPage />} />
              <Route path="/admin/directory" element={<RequireRole user={user} roles={['admin', 'hr']}><DirectoryPage /></RequireRole>} />
              <Route path="/admin/completion-report" element={<RequireRole user={user} roles={['admin', 'hr']}><CompletionReportPage /></RequireRole>} />
              <Route path="/admin/career-transitions" element={<RequireRole user={user} roles={['admin', 'hr']}><CareerTransitionsPage /></RequireRole>} />
              <Route path="/admin/department-heads" element={<RequireRole user={user} roles={['admin', 'hr']}><DepartmentHeadsPage /></RequireRole>} />
              <Route path="/admin/kra-overview" element={<KraOrgOverviewPage />} />
              <Route path="/admin/kra-library" element={<RequireRole user={user} roles={['admin', 'hr']}><KraLibraryPage /></RequireRole>} />
              <Route path="/admin/closure-letters" element={<ClosureLettersPage />} />
              <Route path="/admin/watchlist" element={<WatchlistPage />} />
              <Route path="/admin/nine-box" element={<NineBoxPage />} />
              <Route path="/engagement" element={<MySurveysPage />} />
              <Route path="/admin/engagement" element={<EngagementAdminPage />} />
              <Route path="/admin/engagement-insights" element={<EngagementInsightsPage />} />
              <Route path="/people" element={<PeopleHubPage user={user} />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
      )}
      </div>
    </main>
  );
}


// SETTING YOUR OWN PASSWORD. Two jobs, one screen.
//
// Asked for on 27 Sep: "during login everyone should get change password
// option during first login", and compulsory on the client's own answer.
// The password HR issues follows a published pattern — first name and
// @123 — so it is a one-use password by design, and this is where it
// stops being usable.
//
// `forced` is the first-login case: there is no way past it, because the
// API refuses every other route until the change is made (see
// OPEN_WHILE_LOCKED in core/auth.js). Signing out is left available, so
// somebody who opened the wrong account is not trapped.
//
// The same screen, unforced, is reachable later from the header — added
// with it rather than after, because a product where a password can be
// changed only once, at first sign-in, is a product with no way to
// change a password.
function ChangePassword({ forced, email, onDone, onCancel }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setErr(null);
    if (next.length < 8) { setErr('Your new password must be at least 8 characters.'); return; }
    if (next !== confirm) { setErr('The two new passwords do not match.'); return; }
    setBusy(true);
    try {
      const r = await api('/auth/password', {
        method: 'POST', body: JSON.stringify({ current_password: current, new_password: next }),
      });
      // The old token still says a change is owed and would keep this
      // person locked out of the app they just unlocked.
      if (r.token) localStorage.setItem('apms_token', r.token);
      await onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="max-w-sm mx-auto mt-[10vh] flex flex-col gap-3 glass rounded-2xl p-6">
      <h1 className="text-lg font-bold flex items-center gap-2 text-navy-900">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-navy-700 to-brand-500 flex items-center justify-center shadow-card shrink-0">
          <KeyRound size={14} className="text-white" />
        </span>
        {forced ? 'Choose your own password' : 'Change your password'}
      </h1>
      <p className="text-xs text-navy-500">
        {forced
          ? `The password you signed in with was set for you by HR, and other people can work it out. Choose your own to carry on${email ? ` — you are signed in as ${email}` : ''}.`
          : 'Enter your current password, then the one you want instead.'}
      </p>
      <input className="inp" type="password" autoComplete="current-password"
        placeholder={forced ? 'The password HR gave you' : 'Current password'}
        value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className="inp" type="password" autoComplete="new-password"
        placeholder="New password (at least 8 characters)"
        value={next} onChange={(e) => setNext(e.target.value)} />
      <input className="inp" type="password" autoComplete="new-password"
        placeholder="New password again" value={confirm}
        onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <button className="btn-pri" disabled={busy} onClick={go}>
        {busy ? 'Saving…' : 'Save my password'}
      </button>
      {forced
        ? <button className="btn-sec !text-xs" onClick={signOut}>Sign out instead</button>
        : <button className="btn-sec !text-xs" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

function Shell({ user, gates, onChangePassword }) {
  const groups = visibleGroups(user);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="min-h-screen flex flex-col">
      <Topbar user={user} groups={groups} onChangePassword={onChangePassword} onMenu={() => setMobileOpen(true)} />
      <BuildWatch />
      <div className="flex flex-1 min-h-0">
        <Sidebar user={user} groups={groups} gates={gates} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
        <Main user={user} />
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);
  // Runtime facts the menu needs that are not permissions. One so far:
  // whether this person has any published rating. Fetched once, after
  // sign-in — it changes when HR publishes a cycle, which is not something
  // that happens while somebody watches the menu, and the Home page reads
  // the same figure fresh on every visit.
  const [gates, setGates] = useState({});
  const [changing, setChanging] = useState(false);

  // THE ONLY WAY A USER OBJECT IS BUILT, on a cold load and after a fresh
  // sign-in alike.
  //
  // It used to be two ways, and the second one was wrong: sign-in stored
  // `r.user` straight off the login response, which carries no `pages`
  // field. mayOpen() reads a missing `pages` as "this tenant has not
  // configured page permissions, so show everything" — the deliberate
  // unconfigured-tenant fallback — so for the whole of that first session
  // EVERY tab was shown to EVERY role. An employee signing in saw HR
  // Admin. It corrected itself on the next page refresh, which is what
  // kept it hidden: reloading was the first thing anybody did.
  //
  // /me is the only thing that knows what this person may open, so login
  // now goes through it too. Nothing is rendered until it answers.
  const loadMe = () => api('/me')
    .then((r) => { setUser({ ...r.user, pages: r.pages }); return r; })
    .catch((e) => { localStorage.removeItem('apms_token'); throw e; });

  useEffect(() => {
    const t = localStorage.getItem('apms_token');
    if (!t) { setChecked(true); return; }
    loadMe().catch(() => {}).finally(() => setChecked(true));
  }, []);

  // Deliberately NOT awaited with /me: the menu renders while this is in
  // flight, and an unanswered gate leaves its entry working. See
  // gateClosed() for why that is the safe direction here.
  useEffect(() => {
    if (!user) return;
    api('/pms/my/rating/status')
      .then(r => setGates(g => ({ ...g, rating: !!r.has_published })))
      .catch(() => setGates(g => ({ ...g, rating: true })));
  }, [user && user.id]);
  if (!checked) return null;
  if (!user) return <Login onUser={loadMe} />;
  // Before the router, not inside it: there is no route to reach while a
  // password change is owed, and the API would refuse anything the page
  // asked for anyway.
  if (user.must_change_password) {
    return <ChangePassword forced email={user.email} onDone={loadMe} />;
  }
  if (changing) {
    return <ChangePassword email={user.email}
      onDone={async () => { setChanging(false); await loadMe(); }}
      onCancel={() => setChanging(false)} />;
  }
  return (
    <BrowserRouter>
      <Shell user={user} gates={gates} onChangePassword={() => setChanging(true)} />
    </BrowserRouter>
  );
}

// Automatically checks whether this deployment has any account at all
// (GET /setup/status, unauthenticated — see core/setup.js) and shows a
// friendly first-time setup form instead of a plain login box when it
// doesn't. Once an account exists, /setup/status permanently reports
// false and everyone just sees the normal login form below — this is
// not a standing "create account" screen, only a one-time first-run one.
// Route-level role gate. Same allowed-roles model as the sidebar (opt-in
// via a `roles` prop), so if the user URL-hops directly to /admin/directory
// as a plain employee/manager, they get a friendly message rather than the
// page loading, immediately failing on the 403 from GET /employees, and
// looking broken. Not a security control on its own — that lives in the
// API (see core/employees.js's `GET /` handler) — but the frontend equivalent
// of it, so the two layers stay consistent.
function RequireRole({ user, roles, children }) {
  if (roles.includes(user.role)) return children;
  return (
    <div className="max-w-md mx-auto mt-16 text-center card p-6">
      <h2 className="text-base font-bold text-navy-800 mb-2">Not available for your role</h2>
      <p className="text-sm text-navy-500">
        This page is only available to HR and admin roles. If you think you should have access, ask your admin to update your role from the Employees page.
      </p>
    </div>
  );
}

function Login({ onUser }) {
  const [needsSetup, setNeedsSetup] = useState(null); // null = still checking
  useEffect(() => { api('/setup/status').then(r => setNeedsSetup(r.bootstrap_available)).catch(() => setNeedsSetup(false)); }, []);
  if (needsSetup === null) return null;
  return needsSetup ? <FirstTimeSetup onUser={onUser} /> : <SignIn onUser={onUser} />;
}

function FirstTimeSetup({ onUser }) {
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const go = async () => {
    setErr(null);
    if (!name.trim() || !email.trim() || !password) { setErr('All fields are required.'); return; }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await api('/setup/bootstrap-admin', { method: 'POST', body: JSON.stringify({ name, email, password }) });
      try {
        const r = await api('/auth/dev-login', { method: 'POST', body: JSON.stringify({ email, password }) });
        localStorage.setItem('apms_token', r.token);
        await onUser();
      } catch {
        setErr('Account created — but automatic sign-in is unavailable on this deployment yet (ask whoever manages it to set AUTH_DEV to true), then reload this page and sign in with the email/password you just chose.');
        setBusy(false);
      }
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="max-w-sm mx-auto mt-[10vh] flex flex-col gap-3 glass rounded-2xl p-6">
      <h1 className="text-lg font-bold flex items-center gap-2 text-navy-900">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-navy-700 to-brand-500 flex items-center justify-center shadow-card shrink-0">
          <Sparkles size={14} className="text-white" />
        </span>
        Agentic PMS — First-Time Setup
      </h1>
      <p className="text-xs text-navy-500">No account exists yet on this deployment. Create the first admin account below — this screen only appears once.</p>
      <input className="inp" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
      <input className="inp" placeholder="Your email" value={email} onChange={e => setEmail(e.target.value)} />
      <input className="inp" type="password" placeholder="Choose a password (min 8 characters)" value={password} onChange={e => setPassword(e.target.value)} />
      <input className="inp" type="password" placeholder="Confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <button className="btn-pri" disabled={busy} onClick={go}>{busy ? 'Creating account…' : 'Create admin account & sign in'}</button>
    </div>
  );
}

function SignIn({ onUser }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState(null);
  const go = async () => {
    setErr(null);
    try {
      const r = await api('/auth/dev-login', { method: 'POST', body: JSON.stringify({ email, password }) });
      localStorage.setItem('apms_token', r.token);
      await onUser();
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="max-w-xs mx-auto mt-[14vh] flex flex-col gap-3 glass rounded-2xl p-6">
      <h1 className="text-lg font-bold flex items-center gap-2 text-navy-900">
        <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-navy-700 to-brand-500 flex items-center justify-center shadow-card shrink-0">
          <Sparkles size={14} className="text-white" />
        </span>
        Agentic PMS
      </h1>
      <input className="inp" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} />
      <input className="inp" type="password" placeholder="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && go()} />
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <button className="btn-pri" onClick={go}>Sign in</button>
      <p className="text-[11px] text-navy-400">Production instances sign in with your organisation's identity provider.</p>
    </div>
  );
}
