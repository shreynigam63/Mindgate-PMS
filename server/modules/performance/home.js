// The landing screen's data, in one request.
//
// Until now signing in dropped you straight onto My KRAs, whatever the
// cycle was doing and whatever you owed. This answers the two questions a
// person actually opens the product with — "what do I owe right now" and
// "where is everything else" — so the page can lead with the first and
// offer the second as links.
//
// One endpoint rather than six: the home screen would otherwise fan out to
// My KRAs, mid-year, self-appraisal, the team lists and the admin counters
// just to render a row of subtitles.
//
// Everything here is READ-ONLY and scoped by what the caller may see: the
// team block is omitted entirely for someone with no reports, and the
// admin block for anyone without pms_admin. A count is not harmless — "14
// KRAs approved" tells you the size of the company.
const db = require('../../core/db');
const { hasPermission } = require('../../core/permissions');
const pm = require('./phase-machine');
const { activeCycle, activeCycleForMidyear } = require('./active-cycle');

// What this person owes, right now, in priority order. The FIRST match is
// what the banner says — a list of five things you might do is a list
// nobody reads.
//
// Order is deliberate: your own overdue work outranks work you owe others,
// because nobody else can do yours.
//
// A MISSING row means not started, never "nothing to do". The first cut
// read `kra && kra.status === 'draft'`, which told a brand-new employee
// with no pms.kra_sheets row at all that nothing was waiting on them —
// exactly the person who most needs to be told to start. Same for the
// mid-year and self-appraisal rows, which are also created on first save.
function nextAction({ phase, kra, midyear, appraisal, teamPending, team, requested }) {
  if (kra && (kra.status === 'returned'))
    return { kind: 'kra_returned', title: 'Your KRA sheet was returned',
             detail: kra.manager_comment || 'Your manager asked for changes.',
             cta: 'Open my KRAs', to: '/my/kras', tone: 'urgent' };
  if (pm.phaseAllows(phase, 'kra_edit') && ['draft', 'not_started'].includes((kra && kra.status) || 'not_started'))
    return { kind: 'kra_due', title: 'Your KRAs are not submitted yet',
             detail: 'Draft them and send them to your manager.',
             cta: 'Open my KRAs', to: '/my/kras', tone: 'urgent' };
  if (phase === 'mid_year_review' && (!midyear || midyear.self_status !== 'submitted'))
    return { kind: 'midyear_due', title: 'Mid-year review is due',
             detail: 'Record where you are against each KRA at the halfway point.',
             cta: 'Start my mid-year', to: '/my/midyear', tone: 'urgent' };
  if (phase === 'self_appraisal' && (!appraisal || appraisal.status !== 'submitted'))
    return { kind: 'appraisal_due', title: 'Self-appraisal is due',
             detail: 'Rate yourself against each KRA and say what the year looked like.',
             cta: 'Start my self-appraisal', to: '/my/self-appraisal', tone: 'urgent' };
  // Evaluation season: the KRA queue is empty by now (sheets are approved),
  // so teamPending below would say "nothing is waiting on you" to a manager
  // who owes an assessment for every one of their reports.
  if (phase === 'manager_eval' && team && team.evals_done < team.reports) {
    const left = team.reports - team.evals_done;
    return { kind: 'evals_due', title: `${left} ${left === 1 ? 'evaluation' : 'evaluations'} to write`,
             detail: 'Rate each report against their KRAs and submit.',
             cta: 'Evaluate my team', to: '/team/eval', tone: 'urgent' };
  }
  if (team && team.pending_requests && team.pending_requests.total > 0 && !(teamPending > 0)) {
    const n = team.pending_requests.total;
    return { kind: 'requests_pending', title: `${n} ${n === 1 ? 'request is' : 'requests are'} waiting on you`,
             detail: 'Submissions from your team that need an approve, a return or an evaluation.',
             cta: 'Open All Approvals', to: '/admin/approvals', tone: 'todo' };
  }
  if (teamPending > 0)
    return { kind: 'team_pending', title: `${teamPending} ${teamPending === 1 ? 'person is' : 'people are'} waiting on you`,
             detail: 'KRA sheets submitted by your reports need an approve or a return.',
             cta: 'Review team KRAs', to: '/team/kra-sheets', tone: 'todo' };
  // "Nothing is waiting on you" printed directly above three outstanding
  // submissions reads like a contradiction, even though both are true:
  // nothing is waiting on THEM, and those are waiting on somebody else.
  // The detail line says which, so the two agree on the page.
  const out = (requested || []).length;
  return { kind: 'clear', title: 'Nothing is waiting on you',
           detail: out
             ? `${out} ${out === 1 ? 'submission is' : 'submissions are'} with your manager — nothing is blocked on you.`
             : 'Everything assigned to you for this cycle is done.',
           cta: null, to: null, tone: 'clear' };
}

async function home(user) {
  const t = user.tenant_id;
  const c = await activeCycle(t);
  if (!c) return { cycle: null, action: { kind: 'no_cycle', title: 'No cycle is open',
    detail: 'HR opens a cycle before KRAs can be set.', cta: null, to: null, tone: 'clear' } };

  const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;

  const kra = await one(
    `SELECT s.status, s.manager_comment, s.reopened_reason,
            (SELECT count(*)::int FROM pms.kras k WHERE k.sheet_id = s.id) AS kra_count,
            (SELECT coalesce(sum(k.weight),0)::int FROM pms.kras k WHERE k.sheet_id = s.id) AS total_weight
       FROM pms.kra_sheets s WHERE s.tenant_id=$1 AND s.cycle_id=$2 AND s.employee_id=$3`,
    [t, c.id, user.id]);

  // Mid-year hangs off its own cycle resolver — see active-cycle.js for why
  // the annual cycle is not always the one the mid-year belongs to.
  const mc = await activeCycleForMidyear(t);
  const midyear = mc ? await one(
    `SELECT self_status, manager_status FROM pms.midyear_checkins
      WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [t, mc.id, user.id]) : null;

  const appraisal = await one(
    `SELECT status FROM pms.self_appraisals WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`,
    [t, c.id, user.id]);

  const published = await one(
    `SELECT final_rating, rating_label FROM pms.employee_performance_history
      WHERE tenant_id=$1 AND cycle_id=$2 AND employee_id=$3`, [t, c.id, user.id]);

  // The numbers behind the stat strip. All about THIS person, so no
  // permission gate is needed — but they are still tenant-scoped, because
  // every query in this file is.
  const goals = await one(
    `SELECT p.status,
            (SELECT count(*)::int FROM pms.development_goals g WHERE g.plan_id = p.id) AS total,
            (SELECT count(*)::int FROM pms.development_goals g
              WHERE g.plan_id = p.id AND coalesce(g.progress_pct,0) >= 100) AS done
       FROM pms.development_plans p
      WHERE p.tenant_id=$1 AND p.cycle_id=$2 AND p.employee_id=$3`, [t, c.id, user.id]);

  // Connects are NOT scoped to the cycle: pms.connects has no cycle_id, and
  // this tenant's cycle has no opens_at/closes_at to filter held_at against.
  // Counting them all and labelling them "logged" is the honest version;
  // inventing a window would put a wrong number on the dashboard.
  const connects = await one(
    `SELECT count(*)::int AS logged,
            max(held_at) AS last_held,
            (SELECT count(*)::int FROM pms.connect_action_items a
               JOIN pms.connects c2 ON c2.id = a.connect_id
              WHERE c2.tenant_id=$1 AND c2.employee_id=$2 AND NOT a.done) AS open_actions
       FROM pms.connects WHERE tenant_id=$1 AND employee_id=$2`, [t, user.id]);

  // WHAT THIS PERSON HAS ASKED SOMEBODY ELSE FOR.
  //
  // Asked for on 23 Sep: "all requests initiated should be visible on
  // dashboard of everyone — 'requested to manager' in employees
  // dashboard, 'pending requests' in manager and above dashboard."
  //
  // Same underlying fact told from both ends: a submission is one row
  // that is a REQUEST to the person it waits on and a SENT REQUEST to the
  // person who made it. Both sides read it from here so the two counts
  // can never disagree.
  const requested = (await db.query(
    `SELECT 'kra_sheet' AS kind, 'KRA sheet' AS label, s.submitted_at AS since,
            m.name AS waiting_on
       FROM pms.kra_sheets s
       LEFT JOIN core.employees m ON m.id = s.manager_id
      WHERE s.tenant_id=$1 AND s.cycle_id=$2 AND s.employee_id=$3 AND s.status='submitted'
      UNION ALL
     SELECT 'growth_plan', 'Growth plan', p.submitted_at, m.name
       FROM pms.development_plans p
       LEFT JOIN core.employees m ON m.id = p.manager_id
      WHERE p.tenant_id=$1 AND p.cycle_id=$2 AND p.employee_id=$3 AND p.status='submitted'
      UNION ALL
     SELECT 'self_appraisal', 'Self-appraisal', a.submitted_at, m.name
       FROM pms.self_appraisals a
       LEFT JOIN core.employees e ON e.id = a.employee_id
       LEFT JOIN core.employees m ON m.id = e.manager_id
      WHERE a.tenant_id=$1 AND a.cycle_id=$2 AND a.employee_id=$3 AND a.status='submitted'
        -- The SAME exclusion the manager's pending count uses. Without it
        -- the employee was told their self-appraisal was still waiting on
        -- their manager after the manager had already evaluated it, while
        -- the manager's own dashboard correctly showed nothing pending.
        -- Two readings of one row that disagreed.
        AND NOT EXISTS (SELECT 1 FROM pms.manager_evaluations me
                         WHERE me.cycle_id=$2 AND me.employee_id=a.employee_id AND me.status='submitted')
      ORDER BY since NULLS LAST`, [t, c.id, user.id])).rows;

  // The team block, only for someone who actually has reports — a manager
  // by title with nobody under them should not be shown an empty console.
  let team = null;
  if (await hasPermission(user, 'pms_team_eval')) {
    const wide = await hasPermission(user, 'pms_admin');
    const scope = wide ? '' : 'AND e.manager_id = $3';
    const params = wide ? [t, c.id] : [t, c.id, user.id];
    const r = await one(
      `SELECT count(*)::int AS reports,
              count(*) FILTER (WHERE s.status='submitted')::int AS kra_pending,
              count(*) FILTER (WHERE s.status='approved')::int  AS kra_approved,
              count(*) FILTER (WHERE me.status='submitted')::int AS evals_done
         FROM core.employees e
         LEFT JOIN pms.kra_sheets s ON s.cycle_id=$2 AND s.employee_id=e.id
         LEFT JOIN pms.manager_evaluations me ON me.cycle_id=$2 AND me.employee_id=e.id
        WHERE e.tenant_id=$1 AND e.status='active' ${scope}`, params);
    if (r && r.reports > 0) {
      // Reports nobody has had a single 1-on-1 with. A count of connects
      // held says nothing; a count of people MISSED is the actionable half.
      const miss = await one(
        `SELECT count(*)::int AS no_connect FROM core.employees e
          WHERE e.tenant_id=$1 AND e.status='active' ${wide ? '' : 'AND e.manager_id = $2'}
            AND NOT EXISTS (SELECT 1 FROM pms.connects k
                             WHERE k.tenant_id=$1 AND k.employee_id=e.id)`,
        wide ? [t] : [t, user.id]);
      // The other end of `requested`: everything submitted by the people
      // this person is responsible for and still undecided. Counted with
      // the SAME status tests, so "3 requested" on three employees'
      // dashboards is "3 pending" on their manager's.
      const pend = await one(
        `SELECT
           (SELECT count(*)::int FROM pms.kra_sheets s JOIN core.employees e ON e.id=s.employee_id
             WHERE s.tenant_id=$1 AND s.cycle_id=$2 AND s.status='submitted' AND e.status='active' ${wide ? '' : 'AND e.manager_id=$3'}) AS kra,
           (SELECT count(*)::int FROM pms.development_plans p JOIN core.employees e ON e.id=p.employee_id
             WHERE p.tenant_id=$1 AND p.cycle_id=$2 AND p.status='submitted' AND e.status='active' ${wide ? '' : 'AND e.manager_id=$3'}) AS growth,
           (SELECT count(*)::int FROM pms.self_appraisals a JOIN core.employees e ON e.id=a.employee_id
             WHERE a.tenant_id=$1 AND a.cycle_id=$2 AND a.status='submitted' AND e.status='active' ${wide ? '' : 'AND e.manager_id=$3'}
               AND NOT EXISTS (SELECT 1 FROM pms.manager_evaluations me
                                WHERE me.cycle_id=$2 AND me.employee_id=e.id AND me.status='submitted')) AS appraisal`,
        wide ? [t, c.id] : [t, c.id, user.id]);
      const pending = pend || { kra: 0, growth: 0, appraisal: 0 };
      team = { ...r, no_connect: miss ? miss.no_connect : 0,
               pending_requests: { ...pending, total: pending.kra + pending.growth + pending.appraisal },
               scope: wide ? 'all_employees' : 'my_reports' };
    }
  }

  // The admin block. Counts across the whole company, so pms_admin only.
  let admin = null;
  if (await hasPermission(user, 'pms_admin')) {
    admin = await one(
      `SELECT (SELECT count(*)::int FROM core.employees WHERE tenant_id=$1 AND status='active') AS employees,
              (SELECT count(*)::int FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND status='approved') AS kra_approved,
              (SELECT count(*)::int FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2) AS kra_sheets,
              (SELECT count(*)::int FROM pms.kra_sheets WHERE tenant_id=$1 AND cycle_id=$2 AND status='submitted') AS kra_awaiting,
              (SELECT count(*)::int FROM pms.manager_evaluations WHERE tenant_id=$1 AND cycle_id=$2 AND status='submitted') AS evals_submitted,
              (SELECT count(*)::int FROM core.employees e WHERE e.tenant_id=$1 AND e.status='active'
                 AND e.manager_id IS NULL) AS no_manager`,
      [t, c.id]);
  }

  return {
    cycle: { id: c.id, name: c.name, phase: c.phase, cycle_type: c.cycle_type, fiscal_year: c.fiscal_year },
    me: { kra, midyear, appraisal, published, goals, connects, requested },
    team, admin,
    action: nextAction({ phase: c.phase, kra, midyear, appraisal, team, requested,
                         teamPending: team ? team.kra_pending : 0 }),
  };
}

module.exports = { home, nextAction };
