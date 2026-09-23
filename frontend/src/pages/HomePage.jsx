import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../utils/api';
import {
  Target, TrendingUp, MessageCircle, Clock, ClipboardList, Award, Star, History,
  LayoutDashboard, Users, CheckCircle2, Library, BarChart3, ArrowRight, Lock,
} from 'lucide-react';

// The landing screen.
//
// Signing in used to drop you onto My KRAs whatever the cycle was doing and
// whatever you owed. This leads with the one thing waiting on you and
// offers everything else as links, so the product answers "what now?"
// before it answers "where is X?".
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

function Section({ label, children }) {
  return (
    <div className="space-y-2">
      <p className="lbl mb-0">{label}</p>
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

      <Section label="My performance">
        <Tile to="/my/kras" icon={Target} title="My KRAs" hue="navy"
          sub={me.kra ? `${me.kra.kra_count} KRAs · ${me.kra.total_weight}% · ${kraStatus}` : 'Not started'} />
        <Tile to="/my/growth" icon={TrendingUp} title="My Growth" hue="leaf"
          sub="Target achievements and aspiring career" />
        <Tile to="/team/connects" icon={MessageCircle} title="Quarterly Connects" hue="navy"
          sub="Your 1-on-1 log with your manager" />
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
        <Section label={team.scope === 'all_employees' ? 'My team · every employee' : 'My team'}>
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
        <Section label="Cycle administration">
          <Tile to="/admin/approvals" icon={CheckCircle2} title="All Approvals" hue="violet"
            sub="Every pending decision in the company" />
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
          the person who can fix them is reading this page. */}
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
