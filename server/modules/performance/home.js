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
const { nextAppraisalFor, eligibilityStatement, appraisalYearOf, monthName } = require('./eligibility');

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
         LEFT JOIN pms.manager_evaluations me ON me.tenant_id=$1 AND me.cycle_id=$2 AND me.employee_id=e.id
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

  // WHO THIS CYCLE COVERS, and when this person's own next appraisal
  // is. Asked for on 24 Sep — point 7 pointed at the cycle card in a
  // screenshot, and point 5 ("suggestion of next appraisal") is the
  // same rule read from the other end: your next appraisal is the
  // first one whose joining cut-off you are on the right side of.
  const dojRow = await one(`SELECT date_of_joining FROM core.employees WHERE id=$1 AND tenant_id=$2`,
    [user.id, t]);
  const year = appraisalYearOf(c.fiscal_year, c.created_at);
  const statement = eligibilityStatement(year);
  const mine = nextAppraisalFor(dojRow && dojRow.date_of_joining);

  return {
    cycle: { id: c.id, name: c.name, phase: c.phase, cycle_type: c.cycle_type, fiscal_year: c.fiscal_year },
    eligibility: {
      appraisal_year: year,
      cutoff: statement.cutoff,
      line_in: statement.line_in,
      line_out: statement.line_out,
      // This person's own answer, so the card can say "yours is July
      // 2028" rather than making them work it out from the rule.
      mine: {
        date_of_joining: dojRow ? dojRow.date_of_joining : null,
        ...mine,
        label: mine.eligible_from
          ? `${monthName(mine.eligible_from.month)} ${mine.eligible_from.year}`
          : null,
        in_this_cycle: !!(mine.eligible_from && mine.eligible_from.year === year),
      },
    },
    me: { kra, midyear, appraisal, published, goals, connects, requested },
    team, admin,
    action: nextAction({ phase: c.phase, kra, midyear, appraisal, team, requested,
                         teamPending: team ? team.kra_pending : 0 }),
  };
}


// ---------------------------------------------------------------------------
// THE MANAGER DASHBOARD.
//
// Asked for on 24 Sep: "build a dashboard under 'Manager tab' same like
// one in 'self tab' for manager view regarding tracking of his
// reportees." Same shape as home() — a stat strip, one thing to do next,
// a desk of what is outstanding, links on — but every number is about the
// people who report to this person rather than about them.
//
// MY REPORTS ONLY, for everyone, with no widening switch. That is the
// other half of the same day's instruction ("remove 'all employees'
// option from all tabs"): the Manager tab is now one manager's team, and
// a dashboard that quietly counted the whole company for an admin would
// put the tab straight back where it was. Whole-company numbers live on
// the HR tab, where they already did.
//
// Read-only. The gate is pms_team_eval, the same permission every other
// Manager-tab page carries, checked by the route.
function teamAction({ phase, s }) {
  if (s.kra_pending > 0)
    return { kind: 'kra_pending', tone: 'urgent',
             title: `${s.kra_pending} KRA ${s.kra_pending === 1 ? 'sheet is' : 'sheets are'} waiting on you`,
             detail: 'Your reports have submitted and cannot start until you approve or return.',
             cta: 'Review team KRAs', to: '/team/kra-sheets' };
  if (phase === 'mid_year_review' && s.midyear_pending > 0)
    return { kind: 'midyear_pending', tone: 'urgent',
             title: `${s.midyear_pending} mid-year ${s.midyear_pending === 1 ? 'review' : 'reviews'} to sign off`,
             detail: 'Record where each report stands at the halfway point.',
             cta: 'Open Team Mid-Year', to: '/team/midyear' };
  if (phase === 'manager_eval' && s.evals_pending > 0)
    return { kind: 'evals_pending', tone: 'urgent',
             title: `${s.evals_pending} ${s.evals_pending === 1 ? 'evaluation' : 'evaluations'} to write`,
             detail: 'Rate each report against their KRAs and submit.',
             cta: 'Evaluate my team', to: '/team/eval' };
  if (s.growth_pending > 0)
    return { kind: 'growth_pending', tone: 'todo',
             title: `${s.growth_pending} target ${s.growth_pending === 1 ? 'achievement plan needs' : 'achievement plans need'} a decision`,
             detail: 'Submitted by your reports and not yet approved or returned.',
             cta: 'Open Team Target Achievements', to: '/team/growth' };
  if (s.kra_not_submitted > 0)
    return { kind: 'chase_kras', tone: 'todo',
             title: `${s.kra_not_submitted} of your reports ${s.kra_not_submitted === 1 ? 'has' : 'have'} not submitted KRAs`,
             detail: 'Nothing is blocked on you — they have not sent theirs yet.',
             cta: 'See who', to: '/team/overview' };
  if (s.no_connect > 0)
    return { kind: 'connects', tone: 'todo',
             title: `${s.no_connect} of your reports ${s.no_connect === 1 ? 'has' : 'have'} no connect logged`,
             detail: 'A quarterly 1-on-1 has never been recorded for them.',
             cta: 'Open Quarterly Connects', to: '/team/connects' };
  return { kind: 'clear', tone: 'clear', title: 'Nothing is waiting on you',
           detail: 'Every submission from your team has been decided.',
           cta: null, to: null };
}

async function teamHome(user) {
  const t = user.tenant_id;
  const c = await activeCycle(t);
  if (!c) {
    return { cycle: null, reports: 0, stats: null, pending: [], roster: [],
      action: { kind: 'no_cycle', tone: 'clear', title: 'No cycle is open',
                detail: 'HR opens a cycle before your team can set KRAs.', cta: null, to: null } };
  }
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] || null;
  const mc = await activeCycleForMidyear(t);

  // One row per report, with every status this page counts, so that the
  // strip, the desk and the roster can never disagree with each other —
  // they are three readings of the same result set, not three queries.
  const roster = (await db.query(
    `SELECT e.id AS employee_id, e.name, e.department, e.designation,
            coalesce(s.status, 'not_started')   AS kra_status,
            (SELECT count(*)::int FROM pms.kras k WHERE k.sheet_id = s.id) AS kra_count,
            coalesce(p.status, 'not_started')   AS growth_status,
            coalesce(a.status, 'not_started')   AS self_status,
            coalesce(me.status, 'not_started')  AS eval_status,
            coalesce(mid.self_status, 'not_started')    AS midyear_self_status,
            coalesce(mid.manager_status, 'not_started') AS midyear_manager_status,
            (SELECT count(*)::int FROM pms.connects k2
              WHERE k2.tenant_id=$1 AND k2.employee_id=e.id) AS connects
       FROM core.employees e
       LEFT JOIN pms.kra_sheets s          ON s.tenant_id=$1 AND s.cycle_id=$2 AND s.employee_id=e.id
       LEFT JOIN pms.development_plans p   ON p.tenant_id=$1 AND p.cycle_id=$2 AND p.employee_id=e.id
       LEFT JOIN pms.self_appraisals a     ON a.tenant_id=$1 AND a.cycle_id=$2 AND a.employee_id=e.id
       LEFT JOIN pms.manager_evaluations me ON me.cycle_id=$2 AND me.employee_id=e.id
       LEFT JOIN pms.midyear_checkins mid  ON mid.tenant_id=$1 AND mid.cycle_id=$3 AND mid.employee_id=e.id
      WHERE e.tenant_id=$1 AND e.status='active' AND e.manager_id=$4
      ORDER BY e.name`,
    [t, c.id, mc ? mc.id : c.id, user.id])).rows;

  const n = (f) => roster.filter(f).length;
  const stats = {
    reports: roster.length,
    kra_approved: n((r) => r.kra_status === 'approved'),
    kra_pending: n((r) => r.kra_status === 'submitted'),
    kra_returned: n((r) => r.kra_status === 'returned'),
    kra_not_submitted: n((r) => ['not_started', 'draft'].includes(r.kra_status)),
    growth_pending: n((r) => r.growth_status === 'submitted'),
    // A self-appraisal that has already been evaluated is not pending —
    // the same exclusion home() uses, so "waiting on my manager" on an
    // employee's dashboard and "waiting on me" here stay one number.
    appraisal_pending: n((r) => r.self_status === 'submitted' && r.eval_status !== 'submitted'),
    evals_done: n((r) => r.eval_status === 'submitted'),
    evals_pending: n((r) => r.eval_status !== 'submitted'),
    midyear_signed: n((r) => r.midyear_manager_status === 'submitted'),
    midyear_pending: n((r) => r.midyear_manager_status !== 'submitted'),
    no_connect: n((r) => !r.connects),
    connects: roster.reduce((a, r) => a + r.connects, 0),
  };
  stats.pending_total = stats.kra_pending + stats.growth_pending + stats.appraisal_pending;

  const open = await one(
    `SELECT count(*)::int AS open_actions
       FROM pms.connect_action_items a
       JOIN pms.connects k ON k.id = a.connect_id
       JOIN core.employees e ON e.id = k.employee_id
      WHERE k.tenant_id=$1 AND NOT a.done AND e.manager_id=$2 AND e.status='active'`,
    [t, user.id]);
  stats.open_actions = open ? open.open_actions : 0;

  // NAMED, not counted. "3 pending" tells a manager nothing they can act
  // on; "Priya's KRA sheet, waiting 6 days" tells them what to open. This
  // is the mirror image of the "Requested to manager" list on the
  // employee's own dashboard — one row in the database, read from the
  // other end, with the same status tests so the two can never disagree.
  const pending = (await db.query(
    `SELECT 'kra_sheet' AS kind, 'KRA sheet' AS label, e.name, e.id AS employee_id,
            s.submitted_at AS since, '/team/kra-sheets' AS "to"
       FROM pms.kra_sheets s JOIN core.employees e ON e.id = s.employee_id
      WHERE s.tenant_id=$1 AND s.cycle_id=$2 AND s.status='submitted'
        AND e.status='active' AND e.manager_id=$3
      UNION ALL
     SELECT 'growth_plan', 'Target achievements', e.name, e.id, p.submitted_at, '/team/growth'
       FROM pms.development_plans p JOIN core.employees e ON e.id = p.employee_id
      WHERE p.tenant_id=$1 AND p.cycle_id=$2 AND p.status='submitted'
        AND e.status='active' AND e.manager_id=$3
      UNION ALL
     SELECT 'self_appraisal', 'Annual Review', e.name, e.id, a.submitted_at, '/team/eval'
       FROM pms.self_appraisals a JOIN core.employees e ON e.id = a.employee_id
      WHERE a.tenant_id=$1 AND a.cycle_id=$2 AND a.status='submitted'
        AND e.status='active' AND e.manager_id=$3
        AND NOT EXISTS (SELECT 1 FROM pms.manager_evaluations me
                         WHERE me.cycle_id=$2 AND me.employee_id=e.id AND me.status='submitted')
      ORDER BY since NULLS LAST`, [t, c.id, user.id])).rows;

  return {
    cycle: { id: c.id, name: c.name, phase: c.phase, cycle_type: c.cycle_type, fiscal_year: c.fiscal_year },
    reports: roster.length, stats, pending, roster,
    action: teamAction({ phase: c.phase, s: stats }),
  };
}

module.exports = { home, nextAction, teamHome };
