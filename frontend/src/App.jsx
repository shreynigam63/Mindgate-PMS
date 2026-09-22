import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { Target, ClipboardList, Users, Landmark, Sparkles, BarChart3, HeartHandshake, Star, LogOut, Upload, User, ShieldAlert, Award, Grid3x3, TrendingUp, Clock, MessageCircle, FileText, UserCog, History, LayoutDashboard, GitBranch, Calculator, ShieldCheck, Library, SlidersHorizontal, ChevronDown, CheckCircle2 } from 'lucide-react';
import { api } from './utils/api';
import MyKRASheetPage from './pages/MyKRASheetPage';
import SelfAppraisalPage from './pages/SelfAppraisalPage';
import TeamEvalPage from './pages/TeamEvalPage';
import TeamKraSheetsPage from './pages/TeamKraSheetsPage';
import HodQueuePage from './pages/HodQueuePage';
import CycleAdminPage from './pages/CycleAdminPage';
import CalibrationPage from './pages/CalibrationPage';
import MyRatingPage from './pages/MyRatingPage';
import EngagementPage from './pages/EngagementPage';
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
import MyGrowthPage from './pages/MyGrowthPage';
import KraOrgOverviewPage from './pages/KraOrgOverviewPage';
import KraLibraryPage from './pages/KraLibraryPage';
import AnnualReviewPage from './pages/AnnualReviewPage';
import MidYearReviewPage from './pages/MidYearReviewPage';
import ConnectsPage from './pages/ConnectsPage';
import ClosureLettersPage from './pages/ClosureLettersPage';
import IncrementSimulationPage from './pages/IncrementSimulationPage';
import ParameterAnalysisPage from './pages/ParameterAnalysisPage';
import SettingsPage from './pages/SettingsPage';
import ApprovalsPage from './pages/ApprovalsPage';

const NAV = [
  { group: 'My Performance', hue: 'navy', items: [
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
  ]},
  { group: 'Team', hue: 'lagoon', items: [
    { to: '/team/overview', label: 'Team Overview', icon: LayoutDashboard },
    { to: '/team/kra-sheets', label: 'Team KRA Sheets', icon: ClipboardList },
    { to: '/team/eval', label: 'Team Evaluation', icon: Users },
    { to: '/hod', label: 'Delivery Head Review', icon: Landmark },
    { to: '/pip', label: 'Improvement Plans', icon: ShieldAlert },
  ]},
  { group: 'HR Admin', hue: 'violet', items: [
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
    // A confidential assessment the employee and their manager never see —
    // HR and admin only, both in the nav and on the server.
    { to: '/admin/parameter-analysis', label: 'Review Analysis (HR)', icon: ShieldCheck },
    { to: '/admin/watchlist', label: 'Super 50', icon: Award },
    // Tenant-wide configuration. Last in the group because it is set once
    // and then left alone, unlike everything above it.
    { to: '/admin/settings', label: 'Settings', icon: SlidersHorizontal },
  ]},
  { group: 'Engagement & People', hue: 'leaf', items: [
    { to: '/engagement', label: 'Engagement', icon: HeartHandshake },
    { to: '/people', label: 'People Hub', icon: User },
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

function SideNav({ user }) {
  const { pathname } = useLocation();
  // If a whole group ends up empty after filtering, drop the group heading
  // too: an empty "HR Admin" band with nothing under it is just confusing.
  const groups = NAV
    .map(g => ({ ...g, items: g.items.filter(it => mayOpen(user, it.to)) }))
    .filter(g => g.items.length > 0);

  // 29 items is too long a list to hold open. Only the group you are working
  // in starts open; the rest fold away behind their heading, with a count so
  // you can see what is in there without opening it.
  const here = groups.find(g => g.items.some(it => pathname.startsWith(it.to)));
  const [opened, setOpened] = useState({});
  // The active group is always open — nothing may strand you on a page whose
  // own menu entry is hidden.
  const isOpen = g => g.group === here?.group || !!opened[g.group];

  return (
    <aside className="glass lg:w-60 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto rounded-none lg:rounded-r-2xl">
      <div className="px-4 py-4 flex items-start justify-between gap-2">
        <h1 className="text-sm font-bold flex items-center gap-2 text-navy-900 leading-tight">
          <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-navy-700 to-brand-500 flex items-center justify-center shadow-card shrink-0">
            <Sparkles size={13} className="text-white" />
          </span>
          Performance Management System
        </h1>
        <div className="flex items-center gap-1 shrink-0">
          <NotificationBell />
          <button className="lg:hidden btn-sec" onClick={signOut}><LogOut size={12} /></button>
        </div>
      </div>
      <nav className="px-2 pb-4 flex lg:block overflow-x-auto gap-1">
        {groups.map(g => {
          const open = isOpen(g);
          return (
            <div key={g.group} className="lg:mb-3 flex lg:block gap-1">
              {/* Hidden on small screens, where the nav is a single scrolling
                  row and there is nothing to collapse. */}
              <button type="button" className="navgrp hidden lg:flex"
                onClick={() => setOpened(o => ({ ...o, [g.group]: !open }))}>
                {g.group}
                <span className="navcount">{g.items.length}</span>
                <ChevronDown size={11} className={`navchev ${open ? '' : 'navchev-shut'}`} />
              </button>
              <div className={`flex lg:block gap-1 ${open ? '' : 'lg:hidden'}`}>
                {g.items.map(it => (
                  <NavLink key={it.to} to={it.to}
                    className={({ isActive }) => `flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-xl text-sm whitespace-nowrap transition-colors ${isActive ? `navon navon-${g.hue} text-white shadow-card` : 'text-navy-600 hover:bg-white/70'}`}>
                    <span className={`navico navico-${g.hue}`}><it.icon size={13} /></span>{it.label}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="hidden lg:block px-4 py-3 border-t border-navy-100/60 text-xs text-navy-500">
        {user.name} · {user.role}
        <button className="block mt-1 text-brand-600 font-semibold" onClick={signOut}>Sign out</button>
      </div>
    </aside>
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
      <NavLink to="/my/kras" className="btn-pri inline-block mt-4">Back to My KRAs</NavLink>
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
    <main className="flex-1 min-w-0 p-4 lg:p-6">
      {blocked ? <NoAccess /> : (
            <Routes>
              <Route path="/" element={<Navigate to="/my/kras" replace />} />
              <Route path="/my/kras" element={<MyKRASheetPage />} />
              <Route path="/admin/increments" element={<IncrementSimulationPage />} />
              <Route path="/admin/parameter-analysis" element={<ParameterAnalysisPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
              <Route path="/admin/approvals" element={<ApprovalsPage />} />
              <Route path="/my/self-appraisal" element={<SelfAppraisalPage />} />
              <Route path="/my/rating" element={<MyRatingPage />} />
              <Route path="/my/midyear" element={<MidYearReviewPage />} />
              <Route path="/my/growth" element={<MyGrowthPage />} />
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
              <Route path="/engagement" element={<EngagementPage />} />
              <Route path="/people" element={<PeopleHubPage user={user} />} />
              <Route path="*" element={<Navigate to="/my/kras" replace />} />
            </Routes>
      )}
    </main>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const t = localStorage.getItem('apms_token');
    if (!t) { setChecked(true); return; }
    api('/me')
      .then(r => setUser({ ...r.user, pages: r.pages }))
      .catch(() => localStorage.removeItem('apms_token'))
      .finally(() => setChecked(true));
  }, []);
  if (!checked) return null;
  if (!user) return <Login onUser={setUser} />;
  return (
    <BrowserRouter>
      <div className="min-h-screen lg:flex">
        <SideNav user={user} />
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
        localStorage.setItem('apms_token', r.token); onUser(r.user);
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
      localStorage.setItem('apms_token', r.token); onUser(r.user);
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
