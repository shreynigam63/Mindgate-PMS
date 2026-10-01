import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Target, ClipboardList, Users, Landmark, Sparkles, BarChart3, HeartHandshake, Star, LogOut, Upload, User, ShieldAlert, Award, Grid3x3, TrendingUp, Clock, MessageCircle, FileText, UserCog, History, LayoutDashboard, GitBranch, Calculator, ShieldCheck, Library, SlidersHorizontal, CheckCircle2, Home, Gauge, Layers, CalendarClock, Lock, KeyRound, MapPin } from 'lucide-react';
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
import EngagementInsightsPage from './pages/EngagementInsightsPage';
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
import TeamDashboardPage from './pages/TeamDashboardPage';
import TeamOverviewPage from './pages/TeamOverviewPage';
import PIPPage from './pages/PIPPage';
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
    { to: '/home', label: 'Home', icon: Home },
    { to: '/my/kras', label: 'My KRAs', icon: Target },
    { to: '/my/growth', label: 'My Growth', icon: TrendingUp },
    // Asked for on 22 Sep: Quarterly Connects sits between My Growth and
    // Mid-Year Review. It belongs here rather than under Team because the
    // page is TWO-SIDED — GET /pms/connects returns rows where the caller
    // is the employee OR the manager — and because it follows the year as
    // people live it: set your KRAs, plan your growth, have your quarterly
    // conversations, then review at the halfway point.
    //
    // The ROUTE stays /team/connects. It is in bookmarks and in links
    // inside notifications already sent; only the menu position moves.
    { to: '/team/connects', label: 'Quarterly Connects', icon: MessageCircle },
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
  // whose every item is filtered out is dropped (see TopNav).
  { group: 'Delivery Head', hue: 'leaf', icon: Landmark, items: [
    { to: '/hod', label: 'Delivery Head Review', icon: Landmark },
  ]},
  // HRBP — HR for a slice of the company rather than all of it. Between
  // Delivery Head and HR because that is the order of widening scope:
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
  { group: 'HRBP', hue: 'amber', icon: MapPin, items: [
    { to: '/hrbp/approvals', label: 'All Approvals', icon: CheckCircle2 },
    { to: '/hrbp/cycles', label: 'Cycles', icon: BarChart3 },
    { to: '/hrbp/directory', label: 'Employees', icon: Upload },
    { to: '/hrbp/department-heads', label: 'Department Heads', icon: UserCog },
    { to: '/hrbp/career-transitions', label: 'Career Pathing Matrix', icon: GitBranch },
    { to: '/hrbp/kra-overview', label: 'KRA Overview', icon: ClipboardList },
    { to: '/hrbp/kra-library', label: 'KRA Library', icon: Library },
    { to: '/hrbp/competencies', label: 'Competency Framework', icon: Layers },
    { to: '/hrbp/competency-dashboard', label: 'Competency Dashboard', icon: Gauge },
    { to: '/hrbp/timesheet', label: 'Timesheet', icon: CalendarClock },
    { to: '/hrbp/completion-report', label: 'PMS Completion Report', icon: FileText },
    { to: '/hrbp/calibration', label: 'Calibration', icon: Sparkles },
    { to: '/hrbp/nine-box', label: '9-Box Grid', icon: Grid3x3 },
    { to: '/hrbp/closure-letters', label: 'Closure Letters', icon: FileText },
    { to: '/hrbp/increments', label: 'Increment Simulation', icon: Calculator },
    { to: '/hrbp/watchlist', label: 'Super 50', icon: Award },
    { to: '/hrbp/engagement', label: 'Engagement Surveys', icon: HeartHandshake },
    { to: '/hrbp/engagement-insights', label: 'New Hire Insights', icon: HeartHandshake },
    { to: '/hrbp/settings', label: 'Settings', icon: SlidersHorizontal },
  ]},
  { group: 'HR', hue: 'violet', icon: ShieldCheck, items: [
    { to: '/admin/approvals', label: 'All Approvals', icon: CheckCircle2 },
    { to: '/admin/cycles', label: 'Cycles', icon: BarChart3 },
    { to: '/admin/directory', label: 'Employees', icon: Upload },
    { to: '/admin/department-heads', label: 'Department Heads', icon: UserCog },
    { to: '/admin/hrbp', label: 'HR Business Partners', icon: MapPin },
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

function TopNav({ user, gates, onChangePassword }) {
  const { pathname } = useLocation();
  const nav = useNavigate();
  // If a whole group ends up empty after filtering, drop the tab too: an
  // empty "HR Admin" tab with nothing behind it is just confusing.
  const groups = NAV
    .map(g => ({ ...g, items: g.items.filter(it => mayOpen(user, it.to)) }))
    .filter(g => g.items.length > 0);

  // Which tab is open follows the page you are on, not a click you made —
  // a link from a notification has to land on the right tab too.
  const here = groups.find(g => g.items.some(it => pathname === it.to || pathname.startsWith(it.to + '/')))
    || groups[0];

  return (
    <header className="glass rounded-none">
      <div className="px-4 lg:px-6 py-3 flex items-center justify-between gap-3">
        <h1 className="text-sm lg:text-base font-bold flex items-center gap-2 text-navy-900">
          <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-navy-700 to-brand-500 flex items-center justify-center shadow-card shrink-0">
            <Sparkles size={13} className="text-white" />
          </span>
          Performance Management System
        </h1>
        <div className="flex items-center gap-2 shrink-0">
          <NotificationBell />
          <span className="hidden sm:inline text-xs text-navy-500">{user.name} · {user.role}</span>
          {/* Icon only on a phone. With the word beside it this row grew
              past 390px and pushed the whole page sideways — caught by
              the KRA table's phone test, which measures document scroll
              width rather than looking at this header at all. */}
          <button className="btn-sec !px-2 sm:!px-3" onClick={onChangePassword}
            title="Change your password" aria-label="Change your password">
            <KeyRound size={12} className="inline sm:mr-1" />
            <span className="hidden sm:inline">Password</span>
          </button>
          <button className="btn-sec" onClick={signOut}><LogOut size={12} className="inline mr-1" />Sign out</button>
        </div>
      </div>

      {/* Role tabs. Clicking one opens its first page: a tab is a place to
          go, not just a filter, and landing on nothing would be a dead end.
          EVERY tab carries its group's colour, not only the open one: the
          first cut left the three closed tabs plain white, so the row read
          as one coloured tab and three disabled ones. Closed tabs are
          tinted and open tabs are fully saturated, which says "here" and
          "there" without saying "off". */}
      <div className="px-4 lg:px-6 flex gap-1.5 overflow-x-auto">
        {groups.map(g => (
          <button key={g.group} type="button" onClick={() => nav(g.items[0].to)}
            className={`roletab roletab-${g === here ? 'on' : 'off'}-${g.hue} ${g === here ? 'roletab-on' : ''}`}>
            <g.icon size={14} />
            {g.group}
            <span className={`navcount ${g === here ? 'navcount-on' : `navcount-${g.hue}`}`}>{g.items.length}</span>
          </button>
        ))}
      </div>

      {/* The open tab's pages. HR Admin has fifteen — 2286px of them at
          1440px wide — so this WRAPS rather than scrolling sideways. A
          scrolling row silently hid eight of HR's pages off the right edge
          with no cue they existed, which would have been worse than the
          sidebar this replaced, on exactly the axis the sidebar was good
          at. Wrapping costs one extra row, and only for HR. */}
      <nav className="subnav px-4 lg:px-6 flex flex-wrap gap-x-1">
        {here && here.items.map(it => (gateClosed(it, gates) ? (
          <span key={it.to} className="subnav-item opacity-40 cursor-not-allowed select-none"
            title={it.gateHint} aria-disabled="true">
            <span className={`navico navico-${here.hue}`}><it.icon size={13} /></span>{it.label}
            <Lock size={11} className="ml-1 shrink-0" />
          </span>
        ) : (
          <NavLink key={it.to} to={it.to}
            className={({ isActive }) => `subnav-item ${isActive ? `subnav-on subnav-on-${here.hue}` : ''}`}>
            <span className={`navico navico-${here.hue}`}><it.icon size={13} /></span>{it.label}
          </NavLink>
        )))}
      </nav>
    </header>
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
    <main className="flex-1 min-w-0 p-4 lg:p-6 max-w-[1500px] w-full mx-auto">
      {blocked ? <NoAccess /> : (
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<HomePage />} />
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
              {/* One component for all seven: they differ only in which
                  endpoint they read, and seven near-identical files would
                  drift the way the Timesheet tabs once did. */}
              {/* HR's own pages, opened by an HRBP. The server narrows
                  what comes back; these routes only decide what opens. */}
              <Route path="/hrbp/approvals" element={<ApprovalsPage />} />
              <Route path="/hrbp/cycles" element={<CycleAdminPage />} />
              <Route path="/hrbp/directory" element={<DirectoryPage />} />
              <Route path="/hrbp/department-heads" element={<DepartmentHeadsPage />} />
              <Route path="/hrbp/career-transitions" element={<CareerTransitionsPage />} />
              <Route path="/hrbp/kra-overview" element={<KraOrgOverviewPage />} />
              <Route path="/hrbp/kra-library" element={<KraLibraryPage />} />
              <Route path="/hrbp/competencies" element={<CompetencyFrameworkPage />} />
              <Route path="/hrbp/competency-dashboard" element={<CompetencyDashboardPage />} />
              <Route path="/hrbp/timesheet" element={<HrTimesheetPage />} />
              <Route path="/hrbp/completion-report" element={<CompletionReportPage />} />
              <Route path="/hrbp/calibration" element={<CalibrationPage />} />
              <Route path="/hrbp/nine-box" element={<NineBoxPage />} />
              <Route path="/hrbp/closure-letters" element={<ClosureLettersPage />} />
              <Route path="/hrbp/increments" element={<IncrementSimulationPage />} />
              <Route path="/hrbp/watchlist" element={<WatchlistPage />} />
              <Route path="/hrbp/engagement" element={<EngagementAdminPage />} />
              <Route path="/hrbp/engagement-insights" element={<EngagementInsightsPage />} />
              <Route path="/hrbp/settings" element={<SettingsPage />} />
              <Route path="/team/dashboard" element={<TeamDashboardPage />} />
              <Route path="/team/overview" element={<TeamOverviewPage />} />
              <Route path="/team/kra-sheets" element={<TeamKraSheetsPage />} />
              <Route path="/team/eval" element={<TeamEvalPage user={user} />} />
              <Route path="/team/connects" element={<ConnectsPage />} />
              <Route path="/hod" element={<HodQueuePage />} />
              <Route path="/pip" element={<PIPPage />} />
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
      <div className="min-h-screen flex flex-col">
        <TopNav user={user} gates={gates} onChangePassword={() => setChanging(true)} />
        <Main user={user} />
      </div>
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
