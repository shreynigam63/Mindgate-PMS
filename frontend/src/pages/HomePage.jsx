import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import {
  Target, TrendingUp, MessageCircle, Clock, ClipboardList, Award, Star, History,
  LayoutDashboard, Users, CheckCircle2, Library, BarChart3, ArrowRight, Lock,
  Percent, ListChecks, UserX, FileWarning, Inbox, ShieldCheck,
} from 'lucide-react';

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

const TONE = {
  urgent: 'from-brand-600 to-brand-500',
  todo:   'from-amber2-600 to-amber2-500',
  clear:  'from-leaf-600 to-leaf-500',
};

// A stat card: one number, one label, one saturated icon square.
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

// A desk tile: a solid colour block carrying one count. Only rendered for
// things that are genuinely OUTSTANDING, so an empty desk means an empty
// desk — the row is not padded out with zeroes to look busy.
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

function Tile({ to, icon: Icon, title, sub, hue = 'navy', locked }) {
  const body = (
    <>
      <span className={`navico navico-${hue} w-9 h-9 shrink-0`}><Icon size={16} /></span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-navy-900">{title}</span>
        <span className="block text-[11.5px] text-navy-400 leading-snug">{sub}</span>
      </span>
      {locked && <Lock size={12} className="ml-auto shrink-0 text-navy-300" />}
    </>
  );
  const cls = 'card p-3.5 flex items-center gap-3 transition-shadow';
  return locked
    ? <div className={`${cls} opacity-60`} title={sub}>{body}</div>
    : <NavLink to={to} className={`${cls} hover:shadow-glass`}>{body}</NavLink>;
}

// A block heading: a filled icon badge, a real title, and a line of
// context under it. The reference leads every block this way and it is
// what gives the page its rhythm — a small grey caption does not.
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

function Section({ icon, hue, title, sub, children }) {
  return (
    <div>
      <SecHead icon={icon} hue={hue} title={title} sub={sub} />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">{children}</div>
    </div>
  );
}

const PHASE_LABEL = {
  draft: 'Draft', kra_open: 'KRA Setting', mid_year_review: 'Mid-Year Review',
  self_appraisal: 'Self-Appraisal', manager_eval: 'Manager Evaluation',
  hod_eval: 'Delivery Head Review', calibration: 'Calibration',
  publish: 'Publishing', closed: 'Closed',
};

export default function HomePage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api('/pms/home').then(setD).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-sm text-rose-600">{err}</p>;
  if (!d) return <p className="text-sm text-navy-400">Loading…</p>;

  const { cycle, me = {}, team, admin, action } = d;
  const phase = cycle ? cycle.phase : null;
  const kraStatus = me.kra ? me.kra.status : 'not started';
  const evalOpen = phase === 'manager_eval' || phase === 'hod_eval';
  const goals = me.goals || {};
  const connects = me.connects || {};

  // What is OUTSTANDING, in the order it blocks people. Built as a list so
  // a tile only exists when its count does — see Desk above.
  const desk = [];
  if (me.kra && me.kra.status === 'returned')
    desk.push({ key: 'ret', icon: FileWarning, hue: 'rose', n: 1, label: 'KRA returned to you', to: '/my/kras' });
  else if (!me.kra || ['draft', 'not_started'].includes(me.kra.status))
    desk.push({ key: 'kra', icon: Target, hue: 'navy', n: 1, label: 'KRA sheet to submit', to: '/my/kras' });
  if (phase === 'mid_year_review' && (!me.midyear || me.midyear.self_status !== 'submitted'))
    desk.push({ key: 'mid', icon: Clock, hue: 'lagoon', n: 1, label: 'Mid-year pending', to: '/my/midyear' });
  if (phase === 'self_appraisal' && (!me.appraisal || me.appraisal.status !== 'submitted'))
    desk.push({ key: 'sa', icon: ClipboardList, hue: 'violet', n: 1, label: 'Self-appraisal pending', to: '/my/self-appraisal' });
  if (connects.open_actions > 0)
    desk.push({ key: 'act', icon: ListChecks, hue: 'pink', n: connects.open_actions, label: 'Connect actions open', to: '/team/connects' });
  if (team && team.kra_pending > 0)
    desk.push({ key: 'tk', icon: Users, hue: 'amber', n: team.kra_pending, label: 'KRA approvals pending', to: '/team/kra-sheets' });
  if (team && evalOpen && team.reports > team.evals_done)
    desk.push({ key: 'te', icon: ClipboardList, hue: 'rose', n: team.reports - team.evals_done, label: 'Evaluations to write', to: '/team/eval' });
  if (team && team.no_connect > 0)
    desk.push({ key: 'tc', icon: MessageCircle, hue: 'leaf', n: team.no_connect, label: 'No connect logged yet', to: '/team/connects' });
  if (admin && admin.no_manager > 0)
    desk.push({ key: 'nm', icon: UserX, hue: 'rose', n: admin.no_manager, label: 'Employees with no manager', to: '/admin/directory' });

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {cycle && (
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <span className="navico navico-navy w-9 h-9"><BarChart3 size={16} /></span>
          <div className="min-w-0">
            <p className="text-sm font-bold">{cycle.name}</p>
            <p className="text-[11.5px] text-navy-400">
              {cycle.fiscal_year} · {cycle.cycle_type === 'midyear' ? 'Mid-Year' : 'Annual'}
            </p>
          </div>
          <span className="chip bg-amber2-50 text-amber2-600 ml-auto">{PHASE_LABEL[phase] || phase}</span>
        </div>
      )}

      {/* The stat strip. Your own numbers first, then your team's, then the
          company's — the same order of widening scope the rest of the page
          uses, so the row does not change meaning halfway across. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat icon={Target} hue="lagoon" to="/my/kras"
          n={me.kra ? me.kra.kra_count : 0} label="My KRAs" />
        <Stat icon={Percent} hue="amber" to="/my/kras"
          n={`${me.kra ? me.kra.total_weight : 0}%`} label="Total weight" />
        <Stat icon={TrendingUp} hue="leaf" to="/my/growth"
          n={goals.total || 0} label="Goals" />
        <Stat icon={MessageCircle} hue="pink" to="/team/connects"
          n={connects.logged || 0} label="Connects" />
        {/* Someone with no reports gets their open action items here
            instead. The first cut put "Mid-year done" in this slot, which
            rendered a yes/no as the number 0 sitting in a row of counts —
            unreadable. Every card in this strip is a count of things. */}
        {team
          ? <Stat icon={Users} hue="navy" to="/team/overview" n={team.reports}
              label={team.scope === 'all_employees' ? 'Employees' : 'My reports'} />
          : <Stat icon={ListChecks} hue="navy" to="/team/connects"
              n={connects.open_actions || 0} label="Open actions" />}
        <Stat icon={Star} hue="violet" to="/my/rating"
          n={me.published ? me.published.final_rating : '—'} label="My rating" />
      </div>

      {/* The one thing waiting on this person. A list of five things you
          might do is a list nobody reads, so the server picks one. */}
      <div className={`hero bg-gradient-to-r ${TONE[action.tone] || TONE.clear} block`}>
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold uppercase tracking-widest opacity-80">
            {action.tone === 'clear' ? 'You are up to date' : 'Action needed'}
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
          <SecHead icon={Inbox} hue="rose" title="My desk"
            sub={`${desk.length} ${desk.length === 1 ? 'thing is' : 'things are'} outstanding`} />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {desk.map(x => <Desk key={x.key} {...x} />)}
          </div>
        </div>
      )}

      <Section icon={Target} hue="lagoon" title="My performance"
        sub="Your KRAs, growth, reviews and rating">
        <Tile to="/my/kras" icon={Target} title="My KRAs" hue="navy"
          sub={me.kra ? `${me.kra.kra_count} KRAs · ${me.kra.total_weight}% · ${kraStatus}` : 'Not started'} />
        <Tile to="/my/growth" icon={TrendingUp} title="My Growth" hue="leaf"
          sub={goals.total ? `${goals.done} of ${goals.total} goals complete · ${goals.status}` : 'Target achievements and aspiring career'} />
        <Tile to="/team/connects" icon={MessageCircle} title="Quarterly Connects" hue="navy"
          sub={connects.logged ? `${connects.logged} logged · ${connects.open_actions || 0} actions open` : 'Your 1-on-1 log with your manager'} />
        <Tile to="/my/midyear" icon={Clock} title="Mid-Year Review" hue="navy"
          sub={me.midyear ? `Self: ${me.midyear.self_status.replace('_', ' ')} · manager: ${me.midyear.manager_status.replace('_', ' ')}` : 'Not started'} />
        <Tile to="/my/self-appraisal" icon={ClipboardList} title="Annual Review" hue="navy"
          sub={me.appraisal ? `Self-appraisal · ${me.appraisal.status.replace('_', ' ')}` : 'Not started'} />
        <Tile to="/my/rating" icon={Star} title="My Rating" hue="violet"
          sub={me.published ? `${me.published.final_rating} · ${me.published.rating_label || 'published'}` : 'Published after calibration'} />
        <Tile to="/my/annual-review" icon={Award} title="Final Rating" hue="navy" sub="Consolidated view" />
        <Tile to="/my/history" icon={History} title="Past Cycles" hue="navy" sub="Previous ratings and trail" />
      </Section>

      {team && (
        <Section icon={Users} hue="navy"
          title={team.scope === 'all_employees' ? 'My team · every employee' : 'My team'}
          sub={`${team.reports} ${team.reports === 1 ? 'person' : 'people'} · ${team.kra_approved} KRA sheets approved`}>
          <Tile to="/team/overview" icon={LayoutDashboard} title="Team Overview" hue="lagoon"
            sub={`${team.reports} ${team.reports === 1 ? 'person' : 'people'} · all phases at a glance`} />
          <Tile to="/team/kra-sheets" icon={Users} title="Team KRA approvals" hue="lagoon"
            sub={team.kra_pending
              ? `${team.kra_pending} awaiting you · ${team.kra_approved} approved`
              : `${team.kra_approved} approved · nothing pending`} />
          <Tile to="/team/eval" icon={ClipboardList} title="Evaluate my team" hue="lagoon"
            locked={!evalOpen}
            sub={evalOpen
              ? `${team.evals_done} of ${team.reports} submitted`
              : `Opens at manager evaluation · cycle is ${PHASE_LABEL[phase] || phase}`} />
        </Section>
      )}

      {admin && (
        <Section icon={ShieldCheck} hue="violet" title="Cycle administration"
          sub={`${admin.employees} active employees · ${admin.kra_sheets} sheets in this cycle`}>
          <Tile to="/admin/approvals" icon={CheckCircle2} title="All Approvals" hue="violet"
            sub={admin.kra_awaiting ? `${admin.kra_awaiting} KRA sheets awaiting a decision` : 'Every pending decision in the company'} />
          <Tile to="/admin/kra-overview" icon={ClipboardList} title="KRA Overview" hue="violet"
            sub={`${admin.kra_approved} of ${admin.kra_sheets} sheets approved`} />
          <Tile to="/admin/kra-library" icon={Library} title="KRA Library" hue="violet"
            sub="Shelves published per designation" />
          <Tile to="/admin/cycles" icon={BarChart3} title="Cycles" hue="violet"
            sub={`${admin.evals_submitted} evaluations submitted`} />
          <Tile to="/admin/directory" icon={Users} title="Employees" hue="violet"
            sub={`${admin.employees} active`} />
          <Tile to="/admin/completion-report" icon={LayoutDashboard} title="Completion Report" hue="violet"
            sub="Who is done, who is not" />
        </Section>
      )}

      {/* Stated, not hidden: these block real people from finishing, and
          the person who can fix them is reading this page. Also a desk
          tile above — this line carries the WHY, which a tile cannot. */}
      {admin && admin.no_manager > 0 && (
        <div className="card p-3 text-xs text-navy-500 border-l-4 border-brand-500">
          <b className="text-brand-600">{admin.no_manager}</b> active {admin.no_manager === 1 ? 'employee has' : 'employees have'} no
          reporting manager, so their KRAs cannot be approved by anyone.{' '}
          <NavLink to="/admin/directory" className="font-semibold text-brand-600">Fix in Employees →</NavLink>
        </div>
      )}
    </div>
  );
}
