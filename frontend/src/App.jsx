import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Target, ClipboardList, Users, Landmark, Sparkles, BarChart3, HeartHandshake, Star, LogOut, Upload, User, ShieldAlert, Award, Grid3x3, TrendingUp, Clock, MessageCircle, FileText, UserCog, History, LayoutDashboard, GitBranch, Calculator, ShieldCheck, Library, SlidersHorizontal, CheckCircle2, Home } from 'lucide-react';
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
import PeopleHubPage from './pages/PeopleHubPage';
import DirectoryPage from './pages/DirectoryPage';
import DepartmentHeadsPage from './pages/DepartmentHeadsPage';
import CompletionReportPage from './pages/CompletionReportPage';
import CareerTransitionsPage from './pages/CareerTransitionsPage';
import HistoryPage from './pages/HistoryPage';
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
    { to: '/my/rating', label: 'My Rating', icon: Star },
    { to: '/my/history', label: 'Past Cycles', icon: History },
    // MOVED OUT OF THE TEAM GROUP on 23 Sep, asked for directly: an
    // employee should not see a Team tab at all. This page was the only
    // thing left in it for them, because it is deliberately public — it
    // is row-scoped in the handler, so an employee sees their OWN plan
    // and a manager sees their reports'. Gating it would have taken an
    // employee's own improvement plan away from them to tidy a tab, so
    // it moved instead. A manager still reaches their reports' plans
    // here; the page itself is unchanged.
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
    { to: '/hod', label: 'Delivery Head Review', icon: Landmark },
  ]},
  { group: 'HR', hue: 'violet', icon: ShieldCheck, items: [
    { to: '/admin/approvals', label: 'All Approvals', icon: CheckCircle2 },
    { to: '/admin/cycles', label: 'Cycles', icon: BarChart3 },
    { to: '/admin/directory', label: 'Employees', icon: Upload },
    { to: '/admin/department-heads', label: 'Department Heads', icon: UserCog },
    { to: '/admin/career-transitions', label: 'Career Pathing Matrix', icon: GitBranch },
    { to: '/admin/kra-overview', label: 'KRA Overview', icon: ClipboardList },
    // Next to KRA Overview because the two are easily confused and the
    // difference matters: Overview assigns KRAs to named people, this
    // publishes a shelf per job title that employees pick from.
    { to: '/admin/kra-library', label: 'KRA Library', icon: Library },
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

function TopNav({ user }) {
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
        {here && here.items.map(it => (
          <NavLink key={it.to} to={it.to}
            className={({ isActive }) => `subnav-item ${isActive ? `subnav-on subnav-on-${here.hue}` : ''}`}>
            <span className={`navico navico-${here.hue}`}><it.icon size={13} /></span>{it.label}
          </NavLink>
        ))}
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
              <Route path="/people" element={<PeopleHubPage user={user} />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
      )}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);

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
  if (!checked) return null;
  if (!user) return <Login onUser={loadMe} />;
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <TopNav user={user} />
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
      {err && <p className="text-xs text-brand-600">{err}</p>}
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
      {err && <p className="text-xs text-brand-600">{err}</p>}
      <button className="btn-pri" onClick={go}>Sign in</button>
      <p className="text-[11px] text-navy-400">Production instances sign in with your organisation's identity provider.</p>
    </div>
  );
}
