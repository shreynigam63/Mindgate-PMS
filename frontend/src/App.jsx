import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { Target, ClipboardList, Users, Landmark, Sparkles, BarChart3, HeartHandshake, Star, LogOut, Upload, User, ShieldAlert, Award, Grid3x3, TrendingUp, Heart, Clock, MessageCircle, FileText, UserCog, History, LayoutDashboard, GitBranch, Calculator, ShieldCheck } from 'lucide-react';
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
import AnnualReviewPage from './pages/AnnualReviewPage';
import PulseCheckPage from './pages/PulseCheckPage';
import MidYearReviewPage from './pages/MidYearReviewPage';
import ConnectsPage from './pages/ConnectsPage';
import ClosureLettersPage from './pages/ClosureLettersPage';
import IncrementSimulationPage from './pages/IncrementSimulationPage';
import ParameterAnalysisPage from './pages/ParameterAnalysisPage';

const NAV = [
  { group: 'My Performance', items: [
    { to: '/my/kras', label: 'My KRAs', icon: Target },
    { to: '/my/growth', label: 'My Growth', icon: TrendingUp },
    { to: '/my/midyear', label: 'Mid-Year Review', icon: Clock },
    { to: '/my/self-appraisal', label: 'Self-Appraisal', icon: ClipboardList },
    { to: '/my/annual-review', label: 'Annual Review', icon: Award },
    { to: '/my/rating', label: 'My Rating', icon: Star },
    { to: '/my/history', label: 'Past Cycles', icon: History },
    { to: '/my/pulse-check', label: 'Pulse Check', icon: Heart },
  ]},
  { group: 'Team', items: [
    { to: '/team/overview', label: 'Team Overview', icon: LayoutDashboard },
    { to: '/team/kra-sheets', label: 'Team KRA Sheets', icon: ClipboardList },
    { to: '/team/connects', label: 'Quarterly Connects', icon: MessageCircle },
    { to: '/team/eval', label: 'Team Evaluation', icon: Users },
    { to: '/hod', label: 'Delivery Head Review', icon: Landmark },
    { to: '/pip', label: 'Improvement Plans', icon: ShieldAlert },
  ]},
  { group: 'HR Admin', items: [
    { to: '/admin/cycles', label: 'Cycles', icon: BarChart3 },
    { to: '/admin/directory', label: 'Employees', icon: Upload, roles: ['admin', 'hr'] },
    { to: '/admin/department-heads', label: 'Department Heads', icon: UserCog, roles: ['admin', 'hr'] },
    { to: '/admin/career-transitions', label: 'Career Pathing Matrix', icon: GitBranch, roles: ['admin', 'hr'] },
    { to: '/admin/kra-overview', label: 'KRA Overview', icon: ClipboardList },
    { to: '/admin/completion-report', label: 'PMS Completion Report', icon: FileText, roles: ['admin', 'hr'] },
    { to: '/admin/calibration', label: 'Calibration', icon: Sparkles },
    { to: '/admin/nine-box', label: '9-Box Grid', icon: Grid3x3 },
    { to: '/admin/closure-letters', label: 'Closure Letters', icon: FileText },
    // Salary sits behind its own permission, so this link is HR/admin only
    // — a manager must never see it, let alone open it.
    { to: '/admin/increments', label: 'Increment Simulation', icon: Calculator, roles: ['admin', 'hr'] },
    // A confidential assessment the employee and their manager never see —
    // HR and admin only, both in the nav and on the server.
    { to: '/admin/parameter-analysis', label: 'Review Analysis (HR)', icon: ShieldCheck, roles: ['admin', 'hr'] },
    { to: '/admin/watchlist', label: 'Super 50', icon: Award },
  ]},
  { group: 'Engagement & People', items: [
    { to: '/engagement', label: 'Engagement', icon: HeartHandshake },
    { to: '/people', label: 'People Hub', icon: User },
  ]},
];

export default function App() {
  const [user, setUser] = useState(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const t = localStorage.getItem('apms_token');
    if (!t) { setChecked(true); return; }
    api('/me').then(r => setUser(r.user)).catch(() => localStorage.removeItem('apms_token')).finally(() => setChecked(true));
  }, []);
  if (!checked) return null;
  if (!user) return <Login onUser={setUser} />;
  return (
    <BrowserRouter>
      <div className="min-h-screen lg:flex">
        <aside className="glass lg:w-60 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto rounded-none lg:rounded-r-2xl">
          <div className="px-4 py-4 flex items-center justify-between">
            <h1 className="text-base font-bold flex items-center gap-2 text-navy-900">
              <span className="w-7 h-7 rounded-lg bg-gradient-to-br from-navy-700 to-brand-500 flex items-center justify-center shadow-card shrink-0">
                <Sparkles size={13} className="text-white" />
              </span>
              Agentic PMS
            </h1>
            <div className="flex items-center gap-1">
              <NotificationBell />
              <button className="lg:hidden btn-sec" onClick={() => { localStorage.removeItem('apms_token'); location.href = '/'; }}><LogOut size={12} /></button>
            </div>
          </div>
          <nav className="px-2 pb-4 flex lg:block overflow-x-auto gap-1">
            {NAV.map(g => {
              // A nav item's `roles` array is opt-in — items without one stay
              // visible to everyone (the current behaviour for every item
              // other than the ones explicitly locked down). Items whose
              // `roles` list doesn't include the current user's role get
              // filtered out here. If a whole group ends up empty after
              // filtering, drop the group heading too — showing an empty
              // "HR Admin" band with nothing under it would just be visually
              // confusing.
              const visibleItems = g.items.filter(it => !it.roles || it.roles.includes(user.role));
              if (visibleItems.length === 0) return null;
              return (
                <div key={g.group} className="lg:mb-3 flex lg:block gap-1">
                  <p className="hidden lg:block px-2 text-[10px] font-bold text-navy-400 uppercase tracking-wide mb-1">{g.group}</p>
                  {visibleItems.map(it => (
                    <NavLink key={it.to} to={it.to}
                      className={({ isActive }) => `flex items-center gap-2 px-3 py-2 rounded-xl text-sm whitespace-nowrap transition-colors ${isActive ? 'bg-brand-500 text-white shadow-card' : 'text-navy-600 hover:bg-white/70'}`}>
                      <it.icon size={14} />{it.label}
                    </NavLink>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="hidden lg:block px-4 py-3 border-t border-navy-100/60 text-xs text-navy-500">
            {user.name} · {user.role}
            <button className="block mt-1 text-brand-600 font-semibold" onClick={() => { localStorage.removeItem('apms_token'); location.href = '/'; }}>Sign out</button>
          </div>
        </aside>
        <main className="flex-1 min-w-0 p-4 lg:p-6">
          <Routes>
            <Route path="/" element={<Navigate to="/my/kras" replace />} />
            <Route path="/my/kras" element={<MyKRASheetPage />} />
            <Route path="/admin/increments" element={<IncrementSimulationPage />} />
            <Route path="/admin/parameter-analysis" element={<ParameterAnalysisPage />} />
            <Route path="/my/self-appraisal" element={<SelfAppraisalPage />} />
            <Route path="/my/rating" element={<MyRatingPage />} />
            <Route path="/my/midyear" element={<MidYearReviewPage />} />
            <Route path="/my/growth" element={<MyGrowthPage />} />
            <Route path="/my/annual-review" element={<AnnualReviewPage />} />
            <Route path="/my/history" element={<HistoryPage />} />
            <Route path="/my/pulse-check" element={<PulseCheckPage />} />
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
            <Route path="/admin/closure-letters" element={<ClosureLettersPage />} />
            <Route path="/admin/watchlist" element={<WatchlistPage />} />
            <Route path="/admin/nine-box" element={<NineBoxPage />} />
            <Route path="/engagement" element={<EngagementPage />} />
            <Route path="/people" element={<PeopleHubPage user={user} />} />
            <Route path="*" element={<Navigate to="/my/kras" replace />} />
          </Routes>
        </main>
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
