import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import { grade } from '../grade';
import {
  Target, TrendingUp, MessageCircle, Clock, ClipboardList, Star, Users, CheckCircle2, BarChart3,
  ArrowRight, ListChecks, UserX, FileWarning, Send, Hourglass, HeartHandshake,
  ChevronRight, Check, FileText, MessageSquareText, PenLine, CircleCheckBig, Sun,
  CalendarDays, Minus, AlertCircle, Search,
} from 'lucide-react';
import Summit from '../Summit';
import MyOnboardingEmails from './MyOnboardingEmails';
import { SHOW_FIRST_WEEK_JOURNEY } from '../features';

// The landing screen.
//
// Signing in used to drop you onto My KRAs whatever the cycle was doing and
// whatever you owed. This leads with the one thing waiting on you and
// offers everything else as links, so the product answers "what now?"
// before it answers "where is X?".
//
// Laid out to a reference the client sent (their Humanware HRMS
// dashboard): a strip of stat cards, then solid colour blocks for what is
// pending, then the quick links. Every number on it is a real count from
// the database — there is no filler tile. A dashboard that shows a number
// nobody can trace is worse than one that shows nothing, because people
// make decisions off it.
//
// Tiles are NOT hidden when their phase has not arrived — they say when
// they open. A tile that vanishes makes people ask whether they have lost
// access; a tile that says "opens at manager evaluation" answers the
// question they were about to send an email about.
//
// TIGHTENED ON 1 OCT. The client sent the whole page scrolled out and
// said it reads as gaps: "details are too large, can we make it more
// crisp and compact". Nothing was REMOVED to achieve that — every count,
// reason and link on the page is still here, which matters because the
// no-filler rule above cuts both ways: if a number was worth showing
// yesterday, hiding it today to win vertical space is the same dishonesty
// in the other direction. What shrank is the chrome: icon badges, type
// scale, padding and the space between blocks, which is where the page
// was actually spending its height. Sizes live in app.css (.stat, .deskt,
// .sechead) because this page and the manager dashboard share them, and
// two dashboards drifting apart is how the product starts looking like
// two products.

// REBUILT ON 6 OCT to the reference the client sent with "current UI
// seems bit dull for working, please build exact UI as shown": a greeting
// band, four pastel attention cards, then surveys / cycle status / quick
// actions side by side, then the team table. The rules above still hold —
// every number is a real count and nothing is padded with filler — so
// where the picture shows a figure this product does not have (a "% of
// the cycle complete"), the card shows the figure it does have instead
// (which step of the cycle this is), rather than inventing one.

// The four colours of the reference's attention cards, by what the card
// means rather than by position.
const KPI_HUE = { red: 'red', amber: 'amber', leaf: 'green', violet: 'violet', navy: 'blue', azure: 'blue', lagoon: 'blue' };
const fmt = (n) => (typeof n === 'number' ? (n < 10 && n >= 0 ? String(n).padStart(2, '0') : n.toLocaleString('en-IN')) : n);

export function Kpi({ icon: Icon, hue, n, label, to, hint }) {
  const body = (
    <>
      <span className="kpi-i"><Icon size={20} /></span>
      <span className="min-w-0 flex-1">
        <span className="kpi-n">{fmt(n)}</span>
        <span className="kpi-l">{label}</span>
      </span>
      {to && <ChevronRight size={17} className="text-navy-700 shrink-0" />}
    </>
  );
  const cls = `kpi kpi-${KPI_HUE[hue] || 'blue'}`;
  return to ? <NavLink to={to} className={cls} title={hint}>{body}</NavLink>
            : <div className={`${cls} opacity-80`} title={hint}>{body}</div>;
}

export const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning,' : h < 17 ? 'Good afternoon,' : 'Good evening,';
};

// Four shortcuts, chosen by what this person can actually open, in the
// order the reference uses for a manager. Each is filtered through the
// same page list the sidebar uses, so a shortcut can never lead to
// "this page is not part of your access".
const QA_ALL = [
  { to: '/team/eval', label: 'Evaluate My Team', icon: PenLine, bg: '#fdecef', fg: '#e0435f' },
  { to: '/team/connects', label: 'Log Connect', icon: Users, bg: '#e9f1ff', fg: '#2563eb' },
  { to: '/team/kra-sheets', label: 'Review KRA Approvals', icon: CircleCheckBig, bg: '#e7f7ee', fg: '#1f9d5c' },
  { to: '/team/dashboard', label: 'View Reports', icon: BarChart3, bg: '#f1ecfd', fg: '#7c4dde' },
  { to: '/admin/approvals', label: 'All Approvals', icon: CheckCircle2, bg: '#e7f7ee', fg: '#1f9d5c' },
  { to: '/admin/completion-report', label: 'Completion Report', icon: BarChart3, bg: '#f1ecfd', fg: '#7c4dde' },
  { to: '/my/kras', label: 'My KRAs', icon: Target, bg: '#fdecef', fg: '#e0435f' },
  { to: '/my/self-appraisal', label: 'Annual Review', icon: ClipboardList, bg: '#e7f7ee', fg: '#1f9d5c' },
  { to: '/engagement', label: 'My Surveys', icon: HeartHandshake, bg: '#f1ecfd', fg: '#7c4dde' },
];
// `items` lets the Manager Dashboard offer its own four from the same
// component, so the two dashboards cannot drift apart in look.
export function QuickActions({ user, items }) {
  const may = (to) => !user || !user.pages || user.pages.includes(to);
  const list = (items || QA_ALL).filter((q) => may(q.to)).slice(0, 4);
  return (
    <div className="panel">
      <div className="panel-h"><span className="panel-t">Quick Actions</span></div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {list.map(({ to, label, icon: Icon, bg, fg }) => (
          <NavLink key={to} to={to} className="qa" style={{ background: bg }}>
            <Icon size={19} style={{ color: fg }} className="shrink-0" />
            <span className="qa-t">{label}</span>
            <ChevronRight size={15} className="text-navy-600 shrink-0" />
          </NavLink>
        ))}
      </div>
    </div>
  );
}

// The reference's My Team block: four counts, tabs that narrow the list,
// a department filter, and one row per person. Read from the same
// /pms/team/overview the Team Overview page uses — one query, two views.
const OK = (s) => ['approved', 'submitted', 'completed', 'locked', 'acknowledged', 'published'].includes(s);
const WIP = (s) => ['draft', 'in_progress', 'returned', 'pending_approval', 'submitted_for_approval'].includes(s);
function Tick({ ok, warn }) {
  if (ok) return <span className="tick tick-ok"><Check size={13} strokeWidth={3} /></span>;
  if (warn) return <span className="tick tick-warn"><AlertCircle size={13} strokeWidth={3} /></span>;
  return <span className="tick tick-no"><Minus size={13} strokeWidth={3} /></span>;
}
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const evalPill = (s) => (s === 'submitted' || s === 'completed' ? ['Complete', 'pill-green']
  : s === 'draft' ? ['In progress', 'pill-amber'] : ['Pending', 'pill-red']);

export function TeamPanel() {
  const [ov, setOv] = useState(null);
  const [tab, setTab] = useState('all');
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(8);
  useEffect(() => { api('/pms/team/overview').then(setOv).catch(() => setOv({ rows: [] })); }, []);
  const rows = (ov && ov.rows) || [];
  const depts = [...new Set(rows.map((r) => r.department).filter(Boolean))].sort();
  const TABS = [
    ['all', 'Team Overview', () => true],
    ['kra', 'KRA Approvals', (r) => r.kra_status === 'submitted'],
    ['eval', 'Evaluation Status', (r) => r.self_appraisal_status === 'submitted' && !OK(r.manager_eval_status)],
    ['connects', 'Connects', (r) => !r.connects_this_cycle],
  ];
  const keep = TABS.find(([k]) => k === tab)[2];
  const list = rows.filter(keep).filter((r) => !dept || r.department === dept)
    .filter((r) => !q || String(r.name).toLowerCase().includes(q.toLowerCase()));
  const approved = rows.filter((r) => r.kra_status === 'approved').length;
  const noConnect = rows.filter((r) => !r.connects_this_cycle).length;
  const evDone = rows.filter((r) => OK(r.manager_eval_status)).length;
  const evPct = rows.length ? Math.round((evDone / rows.length) * 100) : 0;
  const wide = ov && ov.scope === 'all_employees';
  return (
    <div className="panel !p-0">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 px-4 pt-3">
        <span className="text-[16px] font-bold text-navy-900 pb-2">My Team</span>
        <div className="tabbar flex-1 border-b-0">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setShown(8); }}>{label}</button>
          ))}
        </div>
        <NavLink to="/team/overview" className="panel-link pb-2.5">View full team <ArrowRight size={15} /></NavLink>
      </div>
      <div className="border-t border-navy-100" />
      <div className="px-4 py-3 flex flex-wrap items-center gap-x-8 gap-y-2">
        {[
          [Users, '#e6efff', '#2563eb', rows.length, wide ? 'Total Employees' : 'Total Reports'],
          [CheckCircle2, '#e7f7ee', '#1f9d5c', approved, 'KRA Sheets Approved'],
          [MessageCircle, '#fff1dc', '#e7860d', noConnect, 'Connects Pending'],
        ].map(([Icon, bg, fg, n, l]) => (
          <div key={l} className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: bg, color: fg }}><Icon size={17} /></span>
            <span><span className="block text-[16px] font-bold text-navy-900 leading-none">{n.toLocaleString('en-IN')}</span>
              <span className="block text-[12.5px] text-navy-500 mt-1">{l}</span></span>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-full" style={{ background: `conic-gradient(#2563eb 0 ${evPct * 0.6}%, #f59e0b 0 ${evPct}%, #e8ecf3 0)`,
            WebkitMask: 'radial-gradient(circle 10px, transparent 98%, #000 100%)', mask: 'radial-gradient(circle 10px, transparent 98%, #000 100%)' }} />
          <span><span className="block text-[16px] font-bold text-navy-900 leading-none">{evPct}%</span>
            <span className="block text-[12.5px] text-navy-500 mt-1">Evaluation Completion</span></span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <label className="flex items-center gap-2 h-10 px-3 rounded-xl border border-navy-100 bg-white">
            <Search size={14} className="text-navy-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name"
              className="text-[13px] outline-none w-32 bg-transparent" />
          </label>
          <select value={dept} onChange={(e) => setDept(e.target.value)}
            className="h-10 px-3 rounded-xl border border-navy-100 bg-white text-[13px] text-navy-700 min-w-[170px]">
            <option value="">All Departments</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      </div>
      <div className="px-4 pb-3 overflow-x-auto">
        {!ov ? <p className="text-sm text-navy-400 py-4">Loading your team…</p>
          : !list.length ? <p className="text-sm text-navy-500 py-4">{rows.length ? 'Nobody matches this view.' : 'No one reports to you in the current cycle.'}</p>
          : (
          <table className="tbl">
            <thead><tr>
              <th>Employee</th><th>Department</th><th className="text-center">KRA</th><th className="text-center">Growth Plan</th>
              <th className="text-center">Annual Review</th><th className="text-center">Connects</th><th>Evaluation</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {list.slice(0, shown).map((r) => {
                const [ev, evc] = evalPill(r.manager_eval_status);
                return (
                  <tr key={r.employee_id}>
                    <td><span className="flex items-center gap-2.5"><span className="ini">{initials(r.name)}</span>
                      <span className="font-medium text-navy-900">{r.name}</span></span></td>
                    <td className="text-navy-500">{r.department || '—'}</td>
                    <td className="text-center"><Tick ok={r.kra_status === 'approved'} warn={WIP(r.kra_status) || r.kra_status === 'submitted'} /></td>
                    <td className="text-center"><Tick ok={OK(r.devplan_status)} warn={WIP(r.devplan_status)} /></td>
                    <td className="text-center"><Tick ok={OK(r.self_appraisal_status)} warn={WIP(r.self_appraisal_status)} /></td>
                    <td className="text-center">{r.connects_this_cycle
                      ? <span className="pill pill-blue">{r.connects_this_cycle}</span> : <Tick />}</td>
                    <td><span className={`pill ${evc}`}>{ev}</span></td>
                    <td><NavLink to="/team/overview" className="inline-flex px-3 py-1 rounded-lg border border-navy-100 text-brand-600 font-semibold text-[12px] hover:bg-brand-50">View</NavLink></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {list.length > shown && (
          <button type="button" className="mt-3 text-[13px] font-semibold text-brand-600" onClick={() => setShown((n) => n + 20)}>
            Show more — {list.length - shown} not shown
          </button>
        )}
      </div>
    </div>
  );
}

// How long a request has been sitting. Days, because an approval four
// hours old is not late and one nine days old is.
export const waited = (iso) => {
  if (!iso) return 'just now';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'waiting 1 day' : `waiting ${d} days`;
};

export default function HomePage({ user }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/home').then(setD).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const { cycle, me = {}, team, admin, action } = d;
  const phase = cycle ? cycle.phase : null;
  const evalOpen = phase === 'manager_eval' || phase === 'hod_eval';
  const goals = me.goals || {};
  const connects = me.connects || {};
  // MY RATING IS CLOSED UNTIL SOMETHING IS PUBLISHED (27 Sep).
  const hasRating = (me.published_count || 0) > 0;
  const requested = me.requested || [];
  const pending = (team && team.pending_requests) || null;
  const queueLink = team && team.scope === 'all_employees' ? '/admin/approvals' : '/team/kra-sheets';

  // What is OUTSTANDING, in the order it blocks people. A card exists only
  // when its count does.
  const desk = [];
  if (team && evalOpen && team.reports > team.evals_done)
    desk.push({ key: 'te', icon: FileText, hue: 'red', n: team.reports - team.evals_done, label: 'Evaluations to write', to: '/team/eval' });
  if (team && team.no_connect > 0)
    desk.push({ key: 'tc', icon: MessageSquareText, hue: 'amber', n: team.no_connect, label: 'No Connect Logged Yet', to: '/team/connects' });
  if (admin && admin.no_manager > 0)
    desk.push({ key: 'nm', icon: UserX, hue: 'leaf', n: admin.no_manager, label: 'Employees with No Manager', to: '/admin/directory' });
  // Every kind of submission waiting on this person, in one figure.
  if (pending && pending.total > 0)
    desk.push({ key: 'req', icon: BarChart3, hue: 'violet', n: pending.total,
      label: pending.total === pending.kra ? 'KRA Approvals Pending' : 'Approvals Pending', to: queueLink });
  if (me.kra && me.kra.status === 'returned')
    desk.push({ key: 'ret', icon: FileWarning, hue: 'red', n: 1, label: 'KRA returned to you', to: '/my/kras' });
  else if (!me.kra || ['draft', 'not_started'].includes(me.kra.status))
    desk.push({ key: 'kra', icon: Target, hue: 'navy', n: 1, label: 'KRA sheet to submit', to: '/my/kras' });
  if (phase === 'mid_year_review' && (!me.midyear || me.midyear.self_status !== 'submitted'))
    desk.push({ key: 'mid', icon: Clock, hue: 'azure', n: 1, label: 'Mid-year pending', to: '/my/midyear' });
  if (phase === 'self_appraisal' && (!me.appraisal || me.appraisal.status !== 'submitted'))
    desk.push({ key: 'sa', icon: ClipboardList, hue: 'violet', n: 1, label: 'Annual review pending', to: '/my/self-appraisal' });
  if (connects.open_actions > 0)
    desk.push({ key: 'act', icon: ListChecks, hue: 'amber', n: connects.open_actions, label: 'Connect actions open', to: '/team/connects' });
  // Fewer than four things outstanding: the row is completed with this
  // person's own counts — real numbers, never zero-padding to look busy.
  const own = [
    { key: 'mk', icon: Target, hue: 'navy', n: me.kra ? me.kra.kra_count : 0, label: `My KRAs · ${me.kra ? me.kra.total_weight : 0}% weight`, to: '/my/kras' },
    { key: 'mc', icon: MessageCircle, hue: 'leaf', n: connects.logged || 0, label: 'Connects logged', to: '/team/connects' },
    { key: 'mg', icon: TrendingUp, hue: 'amber', n: goals.total || 0, label: 'Growth goals', to: '/my/growth' },
    { key: 'mr', icon: Star, hue: 'violet', n: me.published ? grade(me.published.final_rating) : '—', label: 'My rating',
      to: hasRating ? '/my/rating' : undefined, hint: hasRating ? 'Your published ratings' : 'Opens once HR publishes your appraisal' },
  ];
  const cards = [...desk, ...own.slice(0, Math.max(0, 4 - desk.length))];
  const first = String(user && user.name ? user.name : '').split(/\s+/)[0] || 'there';

  return (
    <div className="space-y-3">
      <div className="greet">
        <Summit className="greet-art" />
        <div className="relative z-[1] min-w-0">
          <p className="flex items-center gap-2 text-[14px] font-medium text-navy-800">
            <Sun size={20} className="text-amber-400" /> {greeting()}
          </p>
          <h1 className="text-[24px] font-extrabold leading-tight" style={{ color: '#13235a' }}>{first} <span aria-hidden="true">👋</span></h1>
          <p className="text-[13px] text-navy-600">Here’s what needs your attention today.</p>
          {/* The one thing waiting on this person — the server picks it. */}
          {action && action.tone !== 'clear' && (
            <p className="mt-1.5 text-[12.5px] flex flex-wrap items-center gap-2">
              <span className="pill pill-red">Action needed</span>
              <b className="text-navy-900">{action.title}</b>
              {action.cta && <NavLink to={action.to} className="inline-flex items-center gap-1 font-semibold text-brand-600">{action.cta} <ArrowRight size={13} /></NavLink>}
            </p>
          )}
        </div>
        <p className="greet-quote">{team ? <>“Great managers<br />create great journeys”</> : <>“Every great journey<br />starts with a clear goal”</>}</p>
        <span className="greet-date"><CalendarDays size={14} />
          {new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>

      <div className="kpirow">
        {cards.map(({ key, ...x }) => <Kpi key={key} {...x} />)}
      </div>

      {/* SURVEYS AND THE CYCLE STEPPER WERE HERE, beside Quick Actions.
          Removed on 6 Oct, asked for directly: "please remove these two
          tabs from homepage", with Quick Actions extended "in single line
          to look better". A survey still reaches the person through My
          Surveys and its notification; the cycle's phase is on Cycles and
          on every page that it opens or shuts. */}
      <QuickActions user={user} />

      {/* The First-Week Journey emails this person sends from their own
          Gmail, when they are a SPOC for one. Nothing otherwise. */}
      {SHOW_FIRST_WEEK_JOURNEY && <MyOnboardingEmails user={user} />}

      {/* WHAT THIS PERSON HAS ASKED FOR AND IS WAITING ON — listed, so they
          know exactly who to chase. */}
      {requested.length > 0 && (
        <div className="panel">
          <div className="panel-h">
            <Send size={17} className="text-brand-600" />
            <span className="panel-t">Requested to manager</span>
            <span className="text-[12px] text-navy-400">
              {requested.length} {requested.length === 1 ? 'submission is' : 'submissions are'} waiting on someone else
            </span>
          </div>
          <div className="divide-y divide-[#eef1f6]">
            {requested.map((r, i) => (
              <div key={i} className="py-2 flex flex-wrap items-center gap-2 text-[13px]">
                <span className="pill pill-blue">{r.label}</span>
                <span className="text-navy-500">with <b className="text-navy-900">{r.waiting_on || 'no manager set'}</b></span>
                <span className="ml-auto text-[12px] text-navy-400 inline-flex items-center gap-1"><Hourglass size={12} />{waited(r.since)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* "My performance" was removed on 5 Oct: every one of its tiles is
          in the menu already. Its status moved up into the cards. */}

      {team && <TeamPanel team={team} />}
    </div>
  );
}
