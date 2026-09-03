// Reminder engine — the DB half. The calendar half is pure and lives in
// reminder-schedule.js, so "when does this fire" is unit-tested directly
// and this file only has to answer "who is it about and did they already
// get it", which is what needs a database.
//
// Five rules, all requested together:
//   1. quarterly_connect  employee + manager, 1st Monday of the month
//                         after each quarter ends
//   2. midyear_self       employee, 1st of September then 15/20/25/last Fri
//   3. midyear_manager    manager, 1st Monday of September then the same
//   4. midyear_chase      manager, every weekday from 3 days after the
//                         employee signs until the manager finalises
//   5. annual_*           the same three shapes again, in March, against
//                         the annual self-appraisal
//
// CATCH-UP, NOT A CLOCK. The api sleeps on the free plan, so a scheduled
// morning can pass with nothing running. Every run therefore replays the
// window rather than asking "is today the day" — see migration 026 for
// why the ledger's unique key is what makes replaying safe.
//
// ONE BELL PER CATCH-UP. A replay that finds four missed occurrences logs
// all four (so they never fire again) but rings once, for the most recent.
// Four identical notifications arriving in the same second is not four
// reminders, it is one reminder and three pieces of noise.
//
// PHASE-GATED, AND DELIBERATELY NOT LOGGED WHEN CLOSED. A reminder to fill
// in a mid-year review is useless while the cycle has not reached
// mid_year_review — the employee would open the page and find it locked.
// Those occurrences are left UNLOGGED so that when HR does open the phase,
// the catch-up fires them then. Late, which the client accepted; never
// skipped, which they did not.

const db = require('../../core/db');
const logger = require('../../core/logger');
const { notify } = require('../../core/notifications');
const pm = require('./phase-machine');
const sched = require('./reminder-schedule');

// The engine looks back over the current April–March year and the one
// before it. Two years, because a quarter that ends in March is reminded
// about in April — the next fiscal year — so a single-year window would
// drop that reminder on the year boundary every single year.
function windowFiscalYears(today) {
  const fy = sched.fiscalYearOf(today);
  return [fy - 1, fy];
}

// Rows already sent for a rule, as a Set of "occurrence|recipient|about".
async function sentKeys(tenantId, rule, from) {
  const r = await db.query(
    `SELECT to_char(occurrence,'YYYY-MM-DD') AS occurrence, recipient_id, about_employee_id
       FROM pms.reminder_log WHERE tenant_id=$1 AND rule=$2 AND occurrence >= $3`,
    [tenantId, rule, sched.iso(from)]);
  return new Set(r.rows.map((x) => `${x.occurrence}|${x.recipient_id}|${x.about_employee_id}`));
}

async function recordSent(tenantId, rule, occurrence, recipientId, aboutId, cycleId) {
  await db.query(
    `INSERT INTO pms.reminder_log (tenant_id, rule, occurrence, recipient_id, about_employee_id, cycle_id)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [tenantId, rule, sched.iso(occurrence), recipientId, aboutId, cycleId || null]);
}

// The shared shape of every calendar rule: given the dates it fires on and
// the people it is currently pending for, ring once for the newest missed
// occurrence and log every one of them.
//
// `pending` is a list of { recipientId, aboutId, title, body, link }.
async function fireCalendarRule({ tenantId, rule, dates, today, from, cycleId, pending }) {
  const due = sched.occurrencesDue(dates, today, from);
  if (!due.length || !pending.length) return 0;
  const already = await sentKeys(tenantId, rule, from);

  let rung = 0;
  for (const p of pending) {
    const missed = due.filter((occ) => !already.has(`${sched.iso(occ)}|${p.recipientId}|${p.aboutId}`));
    if (!missed.length) continue;
    await notify(tenantId, p.recipientId, rule, p.title, p.body || null, p.link || '/pms');
    for (const occ of missed) await recordSent(tenantId, rule, occ, p.recipientId, p.aboutId, cycleId);
    rung++;
  }
  return rung;
}

// ---------------------------------------------------------------------------
// Rule 1 — quarterly connect
// ---------------------------------------------------------------------------
// Skips a pair who already held a connect during the quarter the reminder
// is about: the reminder exists to prompt a conversation, and telling two
// people to have a conversation they already had is how a notification
// bell stops being read.
async function quarterlyConnectPending(tenantId, occurrence) {
  // The quarter being reminded about is the three months ending in the
  // month before the reminder fires.
  const end = new Date(Date.UTC(occurrence.getUTCFullYear(), occurrence.getUTCMonth(), 1));
  const start = new Date(Date.UTC(occurrence.getUTCFullYear(), occurrence.getUTCMonth() - 3, 1));
  const rows = (await db.query(
    `SELECT e.id, e.name, e.manager_id, m.name AS manager_name
       FROM core.employees e
       JOIN core.employees m ON m.id = e.manager_id AND m.tenant_id = e.tenant_id
      WHERE e.tenant_id=$1 AND e.status='active' AND m.status='active'
        AND NOT EXISTS (
          SELECT 1 FROM pms.connects c
           WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id
             AND c.held_at >= $2 AND c.held_at < $3)`,
    [tenantId, sched.iso(start), sched.iso(end)])).rows;
  return rows;
}

async function runQuarterlyConnect(tenantId, today, from) {
  const dates = windowFiscalYears(today).flatMap((fy) => sched.quarterlyConnectDates(fy));
  const due = sched.occurrencesDue(dates, today, from);
  if (!due.length) return 0;
  // Whether a connect happened is a fact about a specific quarter, so
  // eligibility is resolved per occurrence rather than once for the run.
  const latest = due[due.length - 1];
  const pairs = await quarterlyConnectPending(tenantId, latest);
  const pending = [];
  for (const e of pairs) {
    pending.push({
      recipientId: e.id, aboutId: e.id,
      title: 'Your quarterly one-on-one connect is due',
      body: `Book time with ${e.manager_name} for the quarter just ended.`,
      link: '/pms/connects',
    });
    pending.push({
      recipientId: e.manager_id, aboutId: e.id,
      title: `Quarterly one-on-one connect due with ${e.name}`,
      body: 'For the quarter just ended.',
      link: '/pms/connects',
    });
  }
  return fireCalendarRule({ tenantId, rule: 'quarterly_connect', dates, today, from, pending });
}

// ---------------------------------------------------------------------------
// Rules 2/3 and their annual twins — "you have not filled this in yet"
// ---------------------------------------------------------------------------
// Mid-year and annual differ only in which table records the submission,
// which month they run in, and which phase has to be open — so they share
// one implementation rather than two that drift apart.
const REVIEW_KINDS = {
  midyear: {
    selfRule: 'midyear_self',
    managerRule: 'midyear_manager',
    selfDates: sched.midYearEmployeeDates,
    managerDates: sched.midYearManagerDates,
    selfPhaseAction: 'midyear_self_submit',
    managerPhaseAction: 'midyear_manager_submit',
    label: 'Mid-Year Review',
    selfLink: '/pms/midyear-review',
    managerLink: '/pms/team/midyear-review',
    pendingSql: `SELECT e.id, e.name, e.manager_id
                   FROM core.employees e
                   LEFT JOIN pms.midyear_checkins mc
                     ON mc.employee_id = e.id AND mc.cycle_id = $2
                  WHERE e.tenant_id = $1 AND e.status = 'active'
                    AND COALESCE(mc.self_status, 'not_started') <> 'submitted'`,
  },
  annual: {
    selfRule: 'annual_self',
    managerRule: 'annual_manager',
    selfDates: sched.annualEmployeeDates,
    managerDates: sched.annualManagerDates,
    selfPhaseAction: 'self_submit',
    managerPhaseAction: 'manager_submit',
    label: 'annual self-appraisal',
    selfLink: '/pms/self-appraisal',
    managerLink: '/pms/team',
    pendingSql: `SELECT e.id, e.name, e.manager_id
                   FROM core.employees e
                   LEFT JOIN pms.self_appraisals sa
                     ON sa.employee_id = e.id AND sa.cycle_id = $2
                  WHERE e.tenant_id = $1 AND e.status = 'active'
                    AND COALESCE(sa.status, 'not_started') <> 'submitted'`,
  },
};

async function runReviewReminders(tenantId, cycle, today, from, kindName) {
  const k = REVIEW_KINDS[kindName];
  const pendingRows = (await db.query(k.pendingSql, [tenantId, cycle.id])).rows;
  if (!pendingRows.length) return { self: 0, manager: 0 };

  let self = 0;
  if (pm.phaseAllows(cycle.phase, k.selfPhaseAction)) {
    self = await fireCalendarRule({
      tenantId, rule: k.selfRule, today, from, cycleId: cycle.id,
      dates: windowFiscalYears(today).flatMap((fy) => k.selfDates(fy)),
      pending: pendingRows.map((e) => ({
        recipientId: e.id, aboutId: e.id,
        title: `Your ${k.label} is not filled in yet`,
        body: 'Complete and sign it so your manager can review.',
        link: k.selfLink,
      })),
    });
  }

  // The manager gets ONE reminder naming how many reportees are
  // outstanding, not one per reportee. A manager of nine opening nine
  // identical bells learns nothing they could not read off one.
  const byManager = new Map();
  for (const e of pendingRows) {
    if (!e.manager_id) continue;
    if (!byManager.has(e.manager_id)) byManager.set(e.manager_id, []);
    byManager.get(e.manager_id).push(e.name);
  }
  // Gated on the EMPLOYEE's phase action, not the manager's: this reminder
  // says "your reportees have not submitted", which is only true while
  // they still could.
  let manager = 0;
  if (byManager.size && pm.phaseAllows(cycle.phase, k.selfPhaseAction)) {
    manager = await fireCalendarRule({
      tenantId, rule: k.managerRule, today, from, cycleId: cycle.id,
      dates: windowFiscalYears(today).flatMap((fy) => k.managerDates(fy)),
      pending: [...byManager].map(([managerId, names]) => ({
        recipientId: managerId, aboutId: managerId,
        title: names.length === 1
          ? `${names[0]}'s ${k.label} is still pending`
          : `${names.length} of your reportees have not submitted their ${k.label}`,
        body: names.join(', '),
        link: k.managerLink,
      })),
    });
  }
  return { self, manager };
}

// ---------------------------------------------------------------------------
// Rule 4 and its annual twin — chasing the manager after a submission
// ---------------------------------------------------------------------------
// "If the manager doesn't finalise within 3 days, remind every day except
// Saturday and Sunday." The 3 days are calendar days from the employee's
// signature (the client said 3 days, not 3 working days); the reminders
// themselves skip the weekend.
//
// The manager here is resolved LIVE from core.employees rather than from
// the snapshot on the review row. The same snapshot bug already bit the
// KRA flow: an employee whose manager changed mid-cycle had submissions
// chased at the person who no longer manages them, while the person who
// actually has to act heard nothing.
const CHASE_KINDS = {
  midyear: {
    rule: 'midyear_chase',
    label: 'Mid-Year Review',
    link: '/pms/team/midyear-review',
    phaseAction: 'midyear_manager_submit',
    sql: `SELECT mc.employee_id, mc.self_submitted_at, e.name, e.manager_id
            FROM pms.midyear_checkins mc
            JOIN core.employees e ON e.id = mc.employee_id AND e.tenant_id = mc.tenant_id
           WHERE mc.tenant_id = $1 AND mc.cycle_id = $2
             AND mc.self_status = 'submitted' AND mc.self_submitted_at IS NOT NULL
             AND mc.manager_status <> 'submitted'
             AND e.status = 'active' AND e.manager_id IS NOT NULL`,
  },
  annual: {
    rule: 'annual_chase',
    label: 'annual appraisal',
    link: '/pms/team',
    phaseAction: 'manager_submit',
    sql: `SELECT sa.employee_id, sa.submitted_at AS self_submitted_at, e.name, e.manager_id
            FROM pms.self_appraisals sa
            JOIN core.employees e ON e.id = sa.employee_id AND e.tenant_id = sa.tenant_id
            LEFT JOIN pms.manager_evaluations me
              ON me.cycle_id = sa.cycle_id AND me.employee_id = sa.employee_id
           WHERE sa.tenant_id = $1 AND sa.cycle_id = $2
             AND sa.status = 'submitted' AND sa.submitted_at IS NOT NULL
             AND COALESCE(me.status, 'pending') <> 'submitted'
             AND e.status = 'active' AND e.manager_id IS NOT NULL`,
  },
};

async function runChase(tenantId, cycle, today, kindName) {
  const k = CHASE_KINDS[kindName];
  // Nothing to chase while the manager cannot act on it anyway.
  if (!pm.phaseAllows(cycle.phase, k.phaseAction)) return 0;
  const rows = (await db.query(k.sql, [tenantId, cycle.id])).rows;
  if (!rows.length) return 0;

  // A month is a generous floor for "how far back could an unfinalised
  // submission be": it keeps the ledger lookup bounded without risking a
  // real outstanding review falling out of the window.
  const floor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const already = await sentKeys(tenantId, k.rule, floor);

  let rung = 0;
  for (const r of rows) {
    const due = sched.chaseDatesSince(new Date(r.self_submitted_at), today).filter((x) => x >= floor);
    const missed = due.filter((occ) => !already.has(`${sched.iso(occ)}|${r.manager_id}|${r.employee_id}`));
    if (!missed.length) continue;
    await notify(tenantId, r.manager_id, k.rule,
      `${r.name}'s ${k.label} is waiting on you`,
      'Signed by them more than 3 days ago and not yet finalised.', k.link);
    for (const occ of missed) await recordSent(tenantId, k.rule, occ, r.manager_id, r.employee_id, cycle.id);
    rung++;
  }
  return rung;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------
// `now` is injectable so the whole engine can be tested on a fixed date
// rather than only ever on whatever today happens to be.
async function runReminders(tenantId, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const cycle = (await db.query(
    `SELECT id, phase, opens_at FROM pms.cycles
      WHERE tenant_id=$1 AND phase NOT IN ('closed','cancelled')
      ORDER BY created_at DESC LIMIT 1`, [tenantId])).rows[0] || null;

  // The replay floor. Without one, a first run in March would fire every
  // reminder scheduled since April at once. The cycle's own start is the
  // honest boundary when it has one; otherwise the start of the previous
  // April–March year, which is the widest window any rule above reaches.
  const fyFloor = new Date(Date.UTC(sched.fiscalYearOf(today) - 1, sched.FY_START_MONTH, 1));
  const from = cycle && cycle.opens_at && new Date(cycle.opens_at) > fyFloor
    ? new Date(cycle.opens_at) : fyFloor;

  const counts = { quarterly_connect: 0, midyear_self: 0, midyear_manager: 0, midyear_chase: 0, annual_self: 0, annual_manager: 0, annual_chase: 0 };
  counts.quarterly_connect = await runQuarterlyConnect(tenantId, today, from);

  if (cycle) {
    const mid = await runReviewReminders(tenantId, cycle, today, from, 'midyear');
    counts.midyear_self = mid.self; counts.midyear_manager = mid.manager;
    counts.midyear_chase = await runChase(tenantId, cycle, today, 'midyear');

    const ann = await runReviewReminders(tenantId, cycle, today, from, 'annual');
    counts.annual_self = ann.self; counts.annual_manager = ann.manager;
    counts.annual_chase = await runChase(tenantId, cycle, today, 'annual');
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total) logger.info('reminders sent', counts);
  return { total, ...counts };
}

module.exports = { runReminders, runQuarterlyConnect, runReviewReminders, runChase, windowFiscalYears };
