// Timesheet -> KRA: the mapping a human maintains, and the monthly read.
//
// Phase 2 of the Zoho timesheet rating engine. The maths is in two pure
// modules beside this one (timesheet-kra-match, timesheet-kra-score);
// this file is the wiring, the permissions and the audit trail.
//
// PHASE 2 REPORTS COVERAGE. It does not rate anybody and it writes
// nothing into any appraisal. The score and the letter grade exist in
// the engine, are computed from HR-editable weights, and stay null
// until somebody turns auto_score on AND enough hours are mapped for a
// number to mean anything. Both gates are described on screen in
// sentences rather than being silent.
//
// WHY EVERY WRITE IS A MANAGER'S OR HR'S, NEVER THE EMPLOYEE'S. Saying
// "this item belongs to that KRA" moves hours between objectives, and
// "this item is not KRA work" removes them from the denominator
// entirely. Either would be self-marking if the employee could do it.
// They can read every number about themselves — that transparency is
// the point — but the assertion is the manager's, with a note, audited.
const express = require('express');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { hasPermission } = require('../../core/permissions');
const { compliance } = require('./timesheet-rules');
const match = require('./timesheet-kra-match');
const score = require('./timesheet-kra-score');
const { activeCycle } = require('./active-cycle');
const rollupRules = require('./timesheet-rollup');
const { ensureScoringSettings, DEFAULT_SCORING } = require('../../migrations/065-timesheet-kra-map');
const { ensureValueAddKeywords } = require('../../migrations/064-kra-keywords');

const router = express.Router();
const T = (req) => req.user.tenant_id;

const audit = (req, action, employeeId, details) => db.query(
  `INSERT INTO pms.audit_log (tenant_id, actor_email, action, employee_id, details)
   VALUES ($1,$2,$3,$4,$5)`,
  [T(req), req.user.email, action, employeeId || null, details ? JSON.stringify(details) : null])
  .catch((e) => logger.warn('timesheet-kra audit failed', { error: e.message }));

// ---------------------------------------------------------------------------
// Who may look, and who may assert.

// Reading is self, your manager, or HR. The same rule as the rest of the
// Timesheet tab.
async function canRead(req, target) {
  if (target.id === req.user.id) return true;
  if (target.manager_id === req.user.id) return true;
  return hasPermission(req.user, 'pms_admin');
}
// Writing is your manager or HR. Never yourself — see the header.
async function canWrite(req, target) {
  if (target.manager_id === req.user.id) return true;
  return hasPermission(req.user, 'pms_admin');
}

const EMP = `e.id, e.emp_code, e.name, e.email, e.department, e.designation, e.manager_id`;

async function employeeOr404(req, res, id) {
  const row = (await db.query(
    `SELECT ${EMP} FROM core.employees e WHERE e.tenant_id=$1 AND e.id=$2`, [T(req), id])).rows[0];
  if (!row) { res.status(404).json({ error: 'employee not found' }); return null; }
  return row;
}

// The scoring configuration, with the seeded defaults underneath.
// ensureScoringSettings is called here as well as in the migration
// because core.tenants is empty while migrations run on a fresh
// database — the trap that cost 056 a boot loop and 063 a silent no-op.
async function scoringFor(tenantId) {
  await ensureScoringSettings(db, tenantId);
  // 064's list too. It was only ensured on the KRA-library keyword
  // routes, so a tenant whose HR had never opened that screen read an
  // empty value-add list here and the scan silently found nothing —
  // the same core.tenants trap, one route further along. Caught by the
  // HTTP test, which had never touched that screen.
  await ensureValueAddKeywords(db, tenantId);
  const row = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [tenantId])).rows[0];
  const v = (row && row.value) || {};
  return {
    scoring: { ...DEFAULT_SCORING, ...(v.scoring || {}) },
    value_add_keywords: Array.isArray(v.value_add_keywords) ? v.value_add_keywords : [],
  };
}

// ---------------------------------------------------------------------------
// The window.
//
// Defaults to the CURRENT compliance cycle rather than a calendar month,
// because the cycle start day is configurable (21st here) and reporting
// a KRA split over 1–30 September against a compliance figure for 21 Aug
// – 20 Sep would be two different months on one screen.
function windowFor(q, settings, asOf) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : null;
  if (from && to) return { from, to, source: 'explicit' };
  const { cycleOf, key } = require('./timesheet-rules');
  const base = asOf ? new Date(`${asOf}T00:00:00`) : new Date();
  const c = cycleOf(base, Number(settings.cycle_start_day) || 21);
  return { from: key(c.start), to: key(c.end), source: 'current-cycle' };
}

// Which cycles this person actually logged anything in, newest first.
//
// THE DEFAULT WINDOW IS THE LATEST CYCLE WITH DATA, not the calendar's
// current one. A timesheet is uploaded after the month it covers, so
// the current cycle is empty for most of its length — the first version
// of this screen defaulted to it and greeted a manager reviewing
// September with "no timesheet logged in 21 Sep – 20 Oct". Worse, there
// was no way from that screen to reach the month they had come to look
// at.
// employeeId null means the whole tenant, which is what the HR backlog
// needs. Shared rather than written twice: the first version only gave
// the per-person view this fallback, so HR's own screen still opened on
// an empty current cycle and announced "nothing to map yet" over 1,302
// logged hours.
async function cyclesWithData(tenantId, employeeId, startDay) {
  const { cycleOf, key } = require('./timesheet-rules');
  const rows = (await db.query(
    `SELECT to_char(log_date,'YYYY-MM-DD') AS d, count(*)::int n, round(sum(hours)::numeric,2) h
       FROM pms.timesheet_entries
      WHERE tenant_id=$1 ${employeeId ? 'AND employee_id=$2' : ''}
      GROUP BY 1 ORDER BY 1`, employeeId ? [tenantId, employeeId] : [tenantId])).rows;
  const by = new Map();
  for (const r of rows) {
    const [y, m, dd] = r.d.split('-').map(Number);
    const c = cycleOf(new Date(y, m - 1, dd), startDay);
    const k = key(c.start);
    if (!by.has(k)) by.set(k, { from: k, to: key(c.end), logs: 0, hours: 0 });
    const x = by.get(k);
    x.logs += r.n;
    x.hours = Math.round((x.hours + Number(r.h)) * 100) / 100;
  }
  return [...by.values()].sort((a, b) => (a.from < b.from ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Keywords a KRA has not been given, taken from the shelf it came from.
//
// WHY THIS EXISTS, and it is a correction to phase 1. 064's header says
// an employee's KRA inherits the shelf's keywords "when one is picked".
// It does not: there are three separate paths that write pms.kras (the
// sheet save, the bulk sheet import and the new-hire auto-assign) and
// none of them carries the column. Measured on a live database: 9 of 18
// library rows carry keywords, 0 of 7 KRAs do. So the keyword half of
// the engine would have matched nothing for everybody, forever, and the
// only visible symptom would have been coverage that never moved.
//
// INHERITED AT READ TIME rather than backfilled by copying, for three
// reasons: it works for the 89 sheets and 2,360 shelf rows already on
// the client instance with no migration; HR editing a shelf is
// immediately reflected instead of needing every sheet rewritten; and
// nothing is scored from keywords yet, so 064's worry — that editing a
// shelf would rewrite what last month was scored against — cannot bite.
// When a KRA carries its own keywords they win, so a future per-KRA
// edit overrides the shelf rather than being overwritten by it.
//
// Matched on designation + title, which is the only key the two tables
// share. A department-specific shelf row beats a company-wide one, the
// same precedence the library itself uses.
async function inheritFromShelf(tenantId, target, kras) {
  const need = kras.filter((k) => !(k.keywords || []).length);
  if (!need.length || !target.designation) return;
  const shelf = (await db.query(
    `SELECT title, keywords, department, timesheet_tracked, timesheet_untracked_reason
       FROM pms.kra_library
      WHERE tenant_id=$1 AND lower(btrim(designation))=lower(btrim($2))`,
    [tenantId, target.designation])).rows;
  if (!shelf.length) return;
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const byTitle = new Map();
  for (const r of shelf) {
    const key = norm(r.title);
    const prev = byTitle.get(key);
    // A row naming this person's department beats a company-wide one.
    const better = !prev || (r.department && norm(r.department) === norm(target.department));
    if (better) byTitle.set(key, r);
  }
  for (const k of need) {
    const r = byTitle.get(norm(k.title));
    if (!r) continue;
    if ((r.keywords || []).length) {
      k.keywords = r.keywords;
      k.keywords_from_shelf = true;
    }
    // The tracked flag inherits too, but only while the KRA still holds
    // the default: an explicit decision on the KRA is never overridden
    // by the shelf.
    if (k.timesheet_tracked !== false && r.timesheet_tracked === false) {
      k.timesheet_tracked = false;
      k.timesheet_untracked_reason = r.timesheet_untracked_reason;
      k.tracked_from_shelf = true;
    }
  }
}

// Working days from `from` to `to` inclusive: weekdays not on the
// timesheet holiday list — the same days compliance counts as owed.
function workingDays(from, to, holidays = []) {
  if (!from || !to || to < from) return 0;
  const hol = new Set(holidays || []);
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86400000) {
    const d = new Date(t); const w = d.getUTCDay();
    if (w !== 0 && w !== 6 && !hol.has(d.toISOString().slice(0, 10))) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// The monthly read: one person, one window.

async function reportFor(req, target, q) {
  const { settingsFor } = require('./timesheet');
  const settings = await settingsFor(T(req));
  const cfg = await scoringFor(T(req));
  const startDay = Number(settings.cycle_start_day) || 21;
  const windows = await cyclesWithData(T(req), target.id, startDay);
  const win = pickWindow(windowFor(q || {}, settings, q && q.as_of), windows);

  const cycle = await activeCycle(T(req));
  const kras = cycle ? (await db.query(
    `SELECT k.id, k.title, k.weight, k.keywords, k.timesheet_tracked, k.timesheet_untracked_reason
       FROM pms.kras k JOIN pms.kra_sheets s ON s.id = k.sheet_id
      WHERE s.tenant_id=$1 AND s.employee_id=$2 AND s.cycle_id=$3
      ORDER BY k.sort_order, k.title`, [T(req), target.id, cycle.id])).rows : [];
  await inheritFromShelf(T(req), target, kras);

  const entries = (await db.query(
    `SELECT to_char(log_date,'YYYY-MM-DD') AS log_date, hours, item_id, item_name,
            item_type, sprint, description
       FROM pms.timesheet_entries
      WHERE tenant_id=$1 AND employee_id=$2 AND log_date >= $3::date AND log_date <= $4::date
      ORDER BY log_date, item_id`, [T(req), target.id, win.from, win.to])).rows
    .map((r) => ({ ...r, hours: Number(r.hours) }));

  const map = cycle ? (await db.query(
    `SELECT item_key, item_label, decision, kra_id, note, mapped_by_email, updated_at
       FROM pms.timesheet_kra_map
      WHERE tenant_id=$1 AND employee_id=$2 AND cycle_id=$3`, [T(req), target.id, cycle.id])).rows : [];

  const att = match.attribute(entries, kras, map);
  const va = match.valueAdd(entries, cfg.value_add_keywords);

  // The compliance figure for THIS window, not the person's all-time
  // number: the two components of any eventual score have to describe
  // the same month or the score describes neither.
  //
  // THE CYCLE IS PICKED BY MATCHING THE WINDOW, and falling back to the
  // AGGREGATE rather than to the last cycle. The first version took
  // `cycles[last]` when nothing matched, which for any window not
  // starting exactly on a cycle boundary meant the newest cycle —
  // usually one still in progress with no logs in it yet. Asked for
  // 1 May to 30 Sep it reported 0% compliance for somebody at 82.8%.
  // A wrong number that looks like a real one is worse than no number.
  const comp = compliance(entries, settings, win.to);
  const cyc = comp.cycles.find((c) => c.start === win.from) || null;
  const agg = cyc || comp.total;
  // Null rather than 0 when there are no logs, and also when the window
  // contains no working days at all: somebody who uploaded nothing has
  // not scored zero, and 0/0 is not 0%.
  const compliancePct = entries.length && agg && agg.work > 0 ? agg.pct : null;

  const sum = score.summarise(att, va, compliancePct, cfg.scoring);
  // One rating per KRA from the same attribution — see kraRatings.
  // Required hours run to today at the latest: the unfinished part of a
  // month in progress cannot have been worked yet.
  const today = new Date().toISOString().slice(0, 10);
  const kraRating = score.kraRatings(att, cfg.scoring, {
    working_days: workingDays(win.from, win.to < today ? win.to : today, settings.holidays),
  });

  return {
    employee: target,
    window: win,
    // Every cycle this person has logs in, so the screen can offer them
    // rather than stranding a reader on one month.
    windows,
    cycle: cycle ? { id: cycle.id, name: cycle.name, phase: cycle.phase } : null,
    has_kras: kras.length > 0,
    has_entries: entries.length > 0,
    items: att.items,
    by_kra: att.by_kra,
    unscorable: att.unscorable,
    uncovered: att.uncovered,
    totals: att.totals,
    value_add: va,
    compliance: cyc || comp.total,
    compliance_is_cycle: !!cyc,
    summary: sum,
    kra_ratings: kraRating,
    scoring: cfg.scoring,
  };
}

router.get('/me', async (req, res) => {
  try {
    const me = await employeeOr404(req, res, req.user.id);
    if (!me) return;
    res.json(await reportFor(req, me, req.query));
  } catch (e) {
    logger.error('timesheet-kra me', { error: e.message });
    res.status(500).json({ error: 'Could not build your KRA timesheet view' });
  }
});

// THE CYCLE'S PER-KRA TIMESHEET RATING, for the people who rate: the
// manager on Team Evaluation and the HOD on HOD Review. Over the whole
// appraisal cycle so far (opens_at to today), not one month — a KRA
// rating in an appraisal is about the year, and a single month would
// mark down a KRA whose work happened in another quarter.
//
// Evidence only: nothing here writes into an evaluation. See
// timesheet-kra-score.js kraRatings.
router.get('/ratings/:id', async (req, res) => {
  try {
    const target = await employeeOr404(req, res, req.params.id);
    if (!target) return;
    let ok = await canRead(req, target);
    if (!ok && await hasPermission(req.user, 'pms_hod')) {
      // The HOD of this person's department rates them too.
      ok = (await db.query(
        `SELECT 1 FROM core.department_heads dh JOIN core.employees e
            ON e.tenant_id = dh.tenant_id AND e.department = dh.department
          WHERE dh.tenant_id=$1 AND dh.employee_id=$2 AND e.id=$3`,
        [T(req), req.user.id, target.id])).rows.length > 0;
    }
    if (!ok) return res.status(403).json({ error: 'You can only see the timesheet rating of someone you review' });
    const cycle = await activeCycle(T(req));
    const today = new Date().toISOString().slice(0, 10);
    // to_char, not a Date: a date column read as a JS Date sits at local
    // midnight, and toISOString on a box east of UTC moves it a day back.
    // THE PERIOD THE UPLOADS COVER, inside the cycle: from the first day
    // logged to the last. Required hours are counted over this span, so
    // a month nobody has uploaded yet is not counted as hours not worked.
    const opens = cycle ? ((await db.query(
      `SELECT to_char(opens_at,'YYYY-MM-DD') d FROM pms.cycles WHERE tenant_id=$1 AND id=$2`,
      [T(req), cycle.id])).rows[0] || {}).d || null : null;
    const span = (await db.query(
      `SELECT to_char(min(log_date),'YYYY-MM-DD') lo, to_char(max(log_date),'YYYY-MM-DD') hi
         FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2 AND ($3::date IS NULL OR log_date >= $3::date)`,
      [T(req), target.id, opens])).rows[0] || {};
    const from = span.lo || opens || today;
    const to = span.hi || today;
    const r = await reportFor(req, target, { from, to: to < from ? from : to });
    res.json({ employee_id: target.id, cycle: r.cycle, window: r.window, has_entries: r.has_entries,
      totals: r.totals, kra_ratings: r.kra_ratings });
  } catch (e) {
    logger.error('timesheet-kra ratings', { error: e.message });
    res.status(500).json({ error: 'Could not build the timesheet rating' });
  }
});

router.get('/employee/:id', async (req, res) => {
  try {
    const target = await employeeOr404(req, res, req.params.id);
    if (!target) return;
    if (!(await canRead(req, target))) {
      return res.status(403).json({ error: 'You can only open the timesheet of someone who reports to you' });
    }
    res.json(await reportFor(req, target, req.query));
  } catch (e) {
    logger.error('timesheet-kra employee', { error: e.message });
    res.status(500).json({ error: 'Could not build the KRA timesheet view' });
  }
});

// The manager's roster: one line per reportee, headline numbers only.
// Enough to see who needs a mapping session, without loading six
// full reports.
router.get('/team', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) {
      return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    }
    const people = (await db.query(
      `SELECT ${EMP} FROM core.employees e
        WHERE e.tenant_id=$1 AND e.manager_id=$2 AND e.status='active' ORDER BY e.name`,
      [T(req), req.user.id])).rows;
    const out = [];
    for (const p of people) {
      const r = await reportFor(req, p, req.query);
      out.push({
        employee: p,
        has_kras: r.has_kras,
        has_entries: r.has_entries,
        totals: r.totals,
        mapped_pct: r.summary.mapped_pct,
        weighted_coverage_pct: r.summary.weighted_coverage_pct,
        alignment_pct: r.summary.alignment_pct,
        compliance_pct: r.summary.compliance_pct,
        score: r.summary.score,
        grade: r.summary.grade,
        withheld: r.summary.withheld,
        unmapped_items: r.items.filter((i) => i.how === 'unmapped' || i.how === 'ambiguous').length,
      });
    }
    res.json({ team: out });
  } catch (e) {
    logger.error('timesheet-kra team', { error: e.message });
    res.status(500).json({ error: 'Could not build the team view' });
  }
});

// Only when the caller did not name a window: land on the latest cycle
// that has logs, rather than on an empty current month.
function pickWindow(win, windows) {
  if (win.source !== 'current-cycle') return win;
  if (!windows.length || windows.some((w) => w.from === win.from)) return win;
  return { ...windows[0], source: 'latest-with-data' };
}

// ---------------------------------------------------------------------------
// Where the whole company stands. HR only.
//
// COMPUTED IN SQL, NOT BY BUILDING A REPORT PER PERSON. The manager
// roster above calls reportFor once per reportee, which is fine for six
// people and would be about six thousand queries for the client's
// 1,427. This answers the only question HR actually has at this stage —
// how much of the logged work has been placed, and who still needs a
// mapping session — as four aggregates.
router.get('/backlog', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { settingsFor } = require('./timesheet');
    const settings = await settingsFor(T(req));
    const startDay = Number(settings.cycle_start_day) || 21;
    const windows = await cyclesWithData(T(req), null, startDay);
    const win = pickWindow(windowFor(req.query || {}, settings, req.query && req.query.as_of), windows);
    const cycle = await activeCycle(T(req));

    // One row per (person, item) in the window, left-joined to their
    // mapping. Deliberately NOT filtered to people with a KRA sheet:
    // "logged work, nobody to credit it to" is the finding, not a row
    // to hide.
    const rows = (await db.query(
      `WITH items AS (
         SELECT t.employee_id,
                lower(coalesce(nullif(btrim(t.item_id),''), btrim(t.item_name))) AS item_key,
                sum(t.hours) AS hours
           FROM pms.timesheet_entries t
          WHERE t.tenant_id=$1 AND t.log_date >= $2::date AND t.log_date <= $3::date
          GROUP BY 1,2)
       SELECT e.id, e.name, e.emp_code, e.department, e.designation,
              count(*) AS items,
              count(m.id) FILTER (WHERE m.decision='kra') AS mapped_items,
              count(m.id) FILTER (WHERE m.decision='excluded') AS excluded_items,
              round(sum(i.hours)::numeric, 2) AS hours,
              round(sum(i.hours) FILTER (WHERE m.decision='kra')::numeric, 2) AS mapped_hours,
              -- KRAs, NOT A SHEET ROW. Two of the three demo employees
              -- carry a sheet whose status is 'approved' or 'returned'
              -- with zero KRAs on it, so testing for the sheet reported
              -- "0 people without a sheet" on the HR screen while the
              -- per-person screen next to it said "this person has no
              -- KRAs for this cycle". Both were true and they read as a
              -- contradiction. For this feature an empty sheet is the
              -- same as no sheet: there is nothing to credit hours to.
              EXISTS (SELECT 1 FROM pms.kra_sheets s JOIN pms.kras k ON k.sheet_id = s.id
                       WHERE s.tenant_id=$1 AND s.employee_id=e.id AND s.cycle_id=$4) AS has_kras
         FROM items i
         JOIN core.employees e ON e.id = i.employee_id
         LEFT JOIN pms.timesheet_kra_map m
                ON m.tenant_id=$1 AND m.employee_id=i.employee_id
               AND m.cycle_id=$4 AND m.item_key=i.item_key
        GROUP BY e.id, e.name, e.emp_code, e.department, e.designation
        ORDER BY (count(*) - count(m.id)) DESC, e.name`,
      [T(req), win.from, win.to, cycle ? cycle.id : null])).rows
      .map((r) => ({
        employee: { id: r.id, name: r.name, emp_code: r.emp_code, department: r.department, designation: r.designation },
        has_kras: r.has_kras,
        items: Number(r.items),
        mapped_items: Number(r.mapped_items),
        excluded_items: Number(r.excluded_items),
        unmapped_items: Number(r.items) - Number(r.mapped_items) - Number(r.excluded_items),
        hours: Number(r.hours),
        mapped_hours: Number(r.mapped_hours || 0),
      }));

    const sum = (f) => rows.reduce((t, r) => t + f(r), 0);
    const hours = sum((r) => r.hours);
    const mapped = sum((r) => r.mapped_hours);
    res.json({
      window: win,
      windows,
      cycle: cycle ? { id: cycle.id, name: cycle.name } : null,
      people: rows,
      totals: {
        people: rows.length,
        // The cap on this entire feature, stated rather than implied.
        without_kras: rows.filter((r) => !r.has_kras).length,
        needing_mapping: rows.filter((r) => r.unmapped_items > 0).length,
        items: sum((r) => r.items),
        unmapped_items: sum((r) => r.unmapped_items),
        hours: Math.round(hours * 100) / 100,
        mapped_hours: Math.round(mapped * 100) / 100,
        mapped_pct: hours > 0 ? Math.round((mapped / hours) * 1000) / 10 : 0,
      },
    });
  } catch (e) {
    logger.error('timesheet-kra backlog', { error: e.message });
    res.status(500).json({ error: 'Could not build the mapping backlog' });
  }
});

// ---------------------------------------------------------------------------
// The mapping itself.

// A sentence, or null.
function validateMapping(b) {
  const key = String(b.item_key == null ? '' : b.item_key).trim();
  if (!key) return 'Which work item? item_key is required.';
  if (key.length > 200) return 'That item key is too long to be one.';
  if (b.decision === 'excluded') {
    // A mandatory reason, because excluding hours takes them out of the
    // denominator. Without one, "not KRA work" becomes the quiet way to
    // make any month look fully mapped.
    if (!String(b.note || '').trim()) {
      return 'Say why this item is not KRA work — excluded hours are left out of the coverage figure.';
    }
    if (b.kra_id) return 'An excluded item cannot also be mapped to a KRA.';
    return null;
  }
  if (b.decision !== 'kra') return `Unknown decision "${b.decision}" — use kra or excluded.`;
  if (!b.kra_id) return 'Pick the KRA this item belongs to.';
  return null;
}

// `q` is the pool by default and a transaction client inside a bulk
// write — without threading it through, the bulk path's ROLLBACK would
// roll back nothing, because every statement would have run on a
// different connection.
async function writeMapping(req, target, cycleId, b, client = null) {
  const q = client || db;
  const key = String(b.item_key).trim().toLowerCase();
  if (b.decision === 'kra') {
    // The KRA must be on THIS person's sheet for THIS cycle. Without
    // this check a manager could map a reportee's hours onto somebody
    // else's objective by passing its id.
    const ok = (await q.query(
      `SELECT 1 FROM pms.kras k JOIN pms.kra_sheets s ON s.id=k.sheet_id
        WHERE k.id=$1 AND s.tenant_id=$2 AND s.employee_id=$3 AND s.cycle_id=$4`,
      [b.kra_id, T(req), target.id, cycleId])).rows[0];
    if (!ok) return { error: 'That KRA is not on this person\'s sheet for the current cycle.' };
  }
  const row = (await q.query(
    `INSERT INTO pms.timesheet_kra_map
       (tenant_id, employee_id, cycle_id, item_key, item_label, decision, kra_id, note, mapped_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, employee_id, cycle_id, item_key) DO UPDATE
       SET item_label=EXCLUDED.item_label, decision=EXCLUDED.decision, kra_id=EXCLUDED.kra_id,
           note=EXCLUDED.note, mapped_by_email=EXCLUDED.mapped_by_email, updated_at=now()
     RETURNING *`,
    [T(req), target.id, cycleId, key, b.item_label || null, b.decision,
     b.decision === 'kra' ? b.kra_id : null, b.note || null, req.user.email])).rows[0];
  return { row };
}

router.put('/employee/:id/map', async (req, res) => {
  try {
    const target = await employeeOr404(req, res, req.params.id);
    if (!target) return;
    if (!(await canWrite(req, target))) {
      return res.status(403).json({ error: 'Only this person\'s manager or HR can map their work items' });
    }
    const cycle = await activeCycle(T(req));
    if (!cycle) return res.status(422).json({ error: 'There is no active performance cycle to map against.' });
    const b = req.body || {};
    const bad = validateMapping(b);
    if (bad) return res.status(422).json({ error: bad });
    const { error, row } = await writeMapping(req, target, cycle.id, b);
    if (error) return res.status(422).json({ error });
    await audit(req, 'TIMESHEET_KRA_MAPPED', target.id, {
      item_key: row.item_key, item_label: row.item_label,
      decision: row.decision, kra_id: row.kra_id, note: row.note, cycle_id: cycle.id,
    });
    res.json({ ok: true, mapping: row });
  } catch (e) {
    logger.error('timesheet-kra map', { error: e.message });
    res.status(500).json({ error: 'Could not save the mapping' });
  }
});

// Several at once — the realistic shape of the work, because a month
// arrives as a handful of items and mapping them one request at a time
// is a screen nobody will finish.
//
// TRANSACTIONAL: either every mapping in the call lands or none does.
// A half-applied batch would leave a coverage figure that matches
// neither what the manager saw nor what they pressed.
router.post('/employee/:id/map/bulk', async (req, res) => {
  try {
    const target = await employeeOr404(req, res, req.params.id);
    if (!target) return;
    if (!(await canWrite(req, target))) {
      return res.status(403).json({ error: 'Only this person\'s manager or HR can map their work items' });
    }
    const cycle = await activeCycle(T(req));
    if (!cycle) return res.status(422).json({ error: 'There is no active performance cycle to map against.' });
    const list = Array.isArray((req.body || {}).mappings) ? req.body.mappings : [];
    if (!list.length) return res.status(422).json({ error: 'Nothing to map.' });
    // Validated BEFORE anything is written, so a bad row at position
    // nine does not leave rows one to eight applied.
    for (let i = 0; i < list.length; i++) {
      const bad = validateMapping(list[i]);
      if (bad) return res.status(422).json({ error: `Item ${i + 1}: ${bad}` });
    }
    // The KRA-belongs-to-this-sheet check runs inside writeMapping, and
    // it can still refuse mid-batch, so the whole batch is one
    // transaction: a half-applied mapping would leave a coverage figure
    // matching neither what the manager saw nor what they pressed.
    const done = [];
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const b of list) {
        const { error, row } = await writeMapping(req, target, cycle.id, b, client);
        if (error) { await client.query('ROLLBACK'); return res.status(422).json({ error }); }
        done.push(row);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    await audit(req, 'TIMESHEET_KRA_MAPPED_BULK', target.id, {
      count: done.length, cycle_id: cycle.id,
      items: done.map((r) => ({ item_key: r.item_key, decision: r.decision, kra_id: r.kra_id })),
    });
    res.json({ ok: true, saved: done.length, mappings: done });
  } catch (e) {
    logger.error('timesheet-kra bulk map', { error: e.message });
    res.status(500).json({ error: 'Could not save the mappings' });
  }
});

router.delete('/employee/:id/map/:itemKey', async (req, res) => {
  try {
    const target = await employeeOr404(req, res, req.params.id);
    if (!target) return;
    if (!(await canWrite(req, target))) {
      return res.status(403).json({ error: 'Only this person\'s manager or HR can map their work items' });
    }
    const cycle = await activeCycle(T(req));
    if (!cycle) return res.status(422).json({ error: 'There is no active performance cycle.' });
    const gone = (await db.query(
      `DELETE FROM pms.timesheet_kra_map
        WHERE tenant_id=$1 AND employee_id=$2 AND cycle_id=$3 AND item_key=$4 RETURNING *`,
      [T(req), target.id, cycle.id, String(req.params.itemKey).toLowerCase()])).rows[0];
    if (!gone) return res.status(404).json({ error: 'No mapping for that item' });
    await audit(req, 'TIMESHEET_KRA_UNMAPPED', target.id, {
      item_key: gone.item_key, was: { decision: gone.decision, kra_id: gone.kra_id, note: gone.note },
    });
    res.json({ ok: true });
  } catch (e) {
    logger.error('timesheet-kra unmap', { error: e.message });
    res.status(500).json({ error: 'Could not remove the mapping' });
  }
});

// ---------------------------------------------------------------------------
// "This KRA is not measurable from a timesheet."
//
// The opt-out that keeps weighted coverage honest. Default is tracked;
// turning it off needs a reason, because it removes that KRA's weight
// from the denominator for good.
router.put('/kra/:kraId/tracked', async (req, res) => {
  try {
    const k = (await db.query(
      `SELECT k.id, k.title, k.timesheet_tracked, s.employee_id
         FROM pms.kras k JOIN pms.kra_sheets s ON s.id=k.sheet_id
        WHERE k.id=$1 AND s.tenant_id=$2`, [req.params.kraId, T(req)])).rows[0];
    if (!k) return res.status(404).json({ error: 'KRA not found' });
    const target = await employeeOr404(req, res, k.employee_id);
    if (!target) return;
    if (!(await canWrite(req, target))) {
      return res.status(403).json({ error: 'Only this person\'s manager or HR can change this' });
    }
    const tracked = (req.body || {}).tracked !== false;
    const reason = String((req.body || {}).reason || '').trim();
    if (!tracked && !reason) {
      return res.status(422).json({ error: 'Say why this KRA cannot be measured from timesheets — its weight is dropped from the coverage figure.' });
    }
    const row = (await db.query(
      `UPDATE pms.kras SET timesheet_tracked=$2, timesheet_untracked_reason=$3
        WHERE id=$1 RETURNING id, title, timesheet_tracked, timesheet_untracked_reason`,
      [k.id, tracked, tracked ? null : reason])).rows[0];
    await audit(req, 'TIMESHEET_KRA_TRACKED_SET', target.id, {
      kra_id: k.id, title: k.title, was: k.timesheet_tracked, now: tracked, reason: tracked ? null : reason,
    });
    res.json({ ok: true, kra: row });
  } catch (e) {
    logger.error('timesheet-kra tracked', { error: e.message });
    res.status(500).json({ error: 'Could not save that' });
  }
});

// ---------------------------------------------------------------------------
// The scoring configuration. HR only.

router.get('/scoring', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    res.json(await scoringFor(T(req)));
  } catch (e) {
    logger.error('timesheet-kra scoring get', { error: e.message });
    res.status(500).json({ error: 'Could not load the scoring settings' });
  }
});

router.put('/scoring', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const cur = await scoringFor(T(req));
    const b = req.body || {};
    const next = {
      ...cur.scoring,
      ...b,
      // Kept unless the caller names it. The rating-settings screen saves
      // only the bands, hours per day and minimum mapped %; reading a
      // missing auto_score as false would switch the overall score off
      // for the whole tenant as a side effect of editing a band.
      auto_score: b.auto_score === undefined ? cur.scoring.auto_score === true : b.auto_score === true,
      weight_coverage: Number(b.weight_coverage == null ? cur.scoring.weight_coverage : b.weight_coverage),
      weight_compliance: Number(b.weight_compliance == null ? cur.scoring.weight_compliance : b.weight_compliance),
      weight_value_add: Number(b.weight_value_add == null ? cur.scoring.weight_value_add : b.weight_value_add),
      min_mapped_pct: Number(b.min_mapped_pct == null ? cur.scoring.min_mapped_pct : b.min_mapped_pct),
      bands: b.bands === undefined ? cur.scoring.bands : b.bands,
    };
    const bad = score.validateScoring(next);
    if (bad) return res.status(422).json({ error: bad });

    // MERGED, not replaced. The blob also holds the compliance
    // thresholds, the holidays and 064's value-add words, and writing
    // only this object over it would silently delete them — exactly the
    // defect this phase found in PUT /timesheet/settings.
    const row = (await db.query(
      `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [T(req)])).rows[0];
    const value = { ...((row && row.value) || {}), scoring: next };
    await db.query(
      `INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'timesheet',$2::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [T(req), JSON.stringify(value)]);
    // Turning automatic scoring on is the single most consequential
    // switch in this feature, so it is called out in the audit rather
    // than buried in a settings diff.
    await audit(req, next.auto_score !== cur.scoring.auto_score
      ? (next.auto_score ? 'TIMESHEET_AUTO_SCORE_ENABLED' : 'TIMESHEET_AUTO_SCORE_DISABLED')
      : 'TIMESHEET_SCORING_CHANGED', null, { was: cur.scoring, now: next });
    res.json({ ok: true, scoring: next });
  } catch (e) {
    logger.error('timesheet-kra scoring put', { error: e.message });
    res.status(500).json({ error: 'Could not save the scoring settings' });
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — closing a month, overriding one, and the year-end rollup.

// How many periods a cycle contains, so the rollup can say what
// fraction of the year it speaks for.
//
// PERIODS THAT OVERLAP THE CYCLE, not whole months in it. A fiscal year
// of 1 Apr - 31 Mar against a cycle start day of 21 genuinely touches
// THIRTEEN periods: 21 Mar - 20 Apr at one end and 21 Mar - 20 Apr at
// the other. Counting twelve would leave a closed month sitting outside
// its own denominator, and coverage above 100%. Thirteen reads oddly
// for a twelve-month year, which is a real consequence of a start day
// that does not align with the fiscal year, and saying so beats
// rounding it away.
function periodsInCycle(cycle, startDay) {
  const { cycleOf, key } = require('./timesheet-rules');
  if (!cycle || !cycle.opens_at || !cycle.closes_at) return 12;
  const a = new Date(cycle.opens_at);
  const b = new Date(cycle.closes_at);
  if (!(a < b)) return 12;
  let n = 0;
  let c = cycleOf(a, startDay);
  for (let guard = 0; c.start <= b && guard < 60; guard++) {
    n += 1;
    c = cycleOf(new Date(c.end.getFullYear(), c.end.getMonth(), c.end.getDate() + 1), startDay);
  }
  return n || 12;
}

const numOrNull = (v) => (v == null ? null : Number(v));

// One snapshot row from a live report.
function snapshotOf(r) {
  return {
    hours_logged: r.totals.logged,
    hours_considered: r.totals.considered,
    hours_attributed: r.totals.attributed,
    hours_excluded: r.totals.excluded,
    items: r.totals.items,
    mapped_pct: r.totals.mapped_pct,
    weighted_coverage_pct: r.summary.weighted_coverage_pct,
    alignment_pct: r.summary.alignment_pct,
    value_add_pct: r.summary.value_add_pct,
    compliance_pct: r.summary.compliance_pct,
    score: r.summary.score,
    grade: r.summary.grade,
    withheld: r.summary.withheld,
    scoring: r.scoring,
    by_kra: r.by_kra,
  };
}

// POST /timesheet/kra/close — settle a period for everybody who logged
// time in it.
//
// DRY RUN FIRST, ALWAYS, the same discipline as the keyword bulk edit:
// this writes the numbers that will reach calibration, and a close that
// cannot be inspected beforehand is the one thing in this feature that
// would be genuinely hard to undo.
//
// A PERIOD THAT IS NOT OVER CANNOT BE CLOSED. Closing mid-month freezes
// a partial month as if it were a whole one, and the compliance figure
// in particular would be permanently wrong.
router.post('/close', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { settingsFor } = require('./timesheet');
    const settings = await settingsFor(T(req));
    const b = req.body || {};
    const dry = b.dry_run !== false;          // closing is opt-in, previewing is the default
    const force = b.force === true;

    const windows = await cyclesWithData(T(req), null, Number(settings.cycle_start_day) || 21);
    const win = pickWindow(windowFor(b, settings, b.as_of), windows);
    const today = b.as_of && /^\d{4}-\d{2}-\d{2}$/.test(b.as_of) ? b.as_of
      : new Date().toISOString().slice(0, 10);
    if (win.to >= today) {
      return res.status(422).json({
        error: `That period runs to ${win.to} and is not over yet. Closing it now would freeze a partial month — `
          + 'wait until it ends, or close an earlier one.' });
    }
    const cycle = await activeCycle(T(req));
    if (!cycle) return res.status(422).json({ error: 'There is no active performance cycle to close a month against.' });

    // Only people who logged time in the window. Somebody with no logs
    // has nothing to snapshot, and a row of zeroes against their name
    // would read as a bad month rather than as no data.
    const people = (await db.query(
      `SELECT ${EMP} FROM core.employees e
        WHERE e.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM pms.timesheet_entries t
           WHERE t.tenant_id=$1 AND t.employee_id=e.id
             AND t.log_date >= $2::date AND t.log_date <= $3::date)
        ORDER BY e.name`, [T(req), win.from, win.to])).rows;

    const already = new Set((await db.query(
      `SELECT employee_id FROM pms.timesheet_month
        WHERE tenant_id=$1 AND cycle_id=$2 AND period_start=$3::date`,
      [T(req), cycle.id, win.from])).rows.map((r) => r.employee_id));

    const would = [];
    const skipped = [];
    for (const p of people) {
      if (already.has(p.id) && !force) {
        skipped.push({ employee: p.name, reason: 'already closed for this period — pass force to recompute' });
        continue;
      }
      const r = await reportFor(req, p, { from: win.from, to: win.to });
      would.push({ employee: { id: p.id, name: p.name, department: p.department }, snap: snapshotOf(r) });
    }

    if (dry) {
      return res.json({
        dry_run: true, window: win, cycle: { id: cycle.id, name: cycle.name },
        would_close: would.length, skipped,
        rows: would.map((w) => ({
          employee: w.employee,
          hours: w.snap.hours_logged, mapped_pct: w.snap.mapped_pct,
          coverage_pct: w.snap.weighted_coverage_pct, compliance_pct: w.snap.compliance_pct,
          score: w.snap.score, grade: w.snap.grade, withheld: w.snap.withheld.length,
        })),
      });
    }

    // TRANSACTIONAL. A half-closed month is a calibration input that
    // matches nothing anybody saw.
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      for (const w of would) {
        const s = w.snap;
        await client.query(
          `INSERT INTO pms.timesheet_month
             (tenant_id, employee_id, cycle_id, period_start, period_end,
              hours_logged, hours_considered, hours_attributed, hours_excluded, items,
              mapped_pct, weighted_coverage_pct, alignment_pct, value_add_pct, compliance_pct,
              score, grade, withheld, scoring, by_kra, closed_by)
           VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                   $18::jsonb,$19::jsonb,$20::jsonb,$21)
           ON CONFLICT (tenant_id, employee_id, cycle_id, period_start) DO UPDATE SET
             period_end=EXCLUDED.period_end,
             hours_logged=EXCLUDED.hours_logged, hours_considered=EXCLUDED.hours_considered,
             hours_attributed=EXCLUDED.hours_attributed, hours_excluded=EXCLUDED.hours_excluded,
             items=EXCLUDED.items, mapped_pct=EXCLUDED.mapped_pct,
             weighted_coverage_pct=EXCLUDED.weighted_coverage_pct,
             alignment_pct=EXCLUDED.alignment_pct, value_add_pct=EXCLUDED.value_add_pct,
             compliance_pct=EXCLUDED.compliance_pct, score=EXCLUDED.score, grade=EXCLUDED.grade,
             withheld=EXCLUDED.withheld, scoring=EXCLUDED.scoring, by_kra=EXCLUDED.by_kra,
             closed_by=EXCLUDED.closed_by, closed_at=now()`,
          [T(req), w.employee.id, cycle.id, win.from, win.to,
           s.hours_logged, s.hours_considered, s.hours_attributed, s.hours_excluded, s.items,
           s.mapped_pct, s.weighted_coverage_pct, s.alignment_pct, s.value_add_pct, s.compliance_pct,
           s.score, s.grade, JSON.stringify(s.withheld), JSON.stringify(s.scoring),
           JSON.stringify(s.by_kra), req.user.email]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    await audit(req, force ? 'TIMESHEET_MONTH_RECLOSED' : 'TIMESHEET_MONTH_CLOSED', null, {
      cycle_id: cycle.id, period_start: win.from, period_end: win.to,
      closed: would.length, skipped: skipped.length,
    });
    res.json({ ok: true, window: win, closed: would.length, skipped });
  } catch (e) {
    logger.error('timesheet-kra close', { error: e.message });
    res.status(500).json({ error: 'Could not close that period' });
  }
});

// The closed months for one person, plus their rollup.
async function monthsFor(req, target) {
  const { settingsFor } = require('./timesheet');
  const settings = await settingsFor(T(req));
  const cycle = await activeCycle(T(req));
  if (!cycle) return { cycle: null, months: [], rollup: rollupRules.rollup([], {}) };
  // m.period_start, not period_start: the to_char alias below has the
  // same name as the real column, and an unqualified ORDER BY on it is
  // rejected as ambiguous by Postgres.
  const months = (await db.query(
    `SELECT m.*, to_char(m.period_start,'YYYY-MM-DD') AS period_start,
            to_char(m.period_end,'YYYY-MM-DD') AS period_end
       FROM pms.timesheet_month m
      WHERE m.tenant_id=$1 AND m.employee_id=$2 AND m.cycle_id=$3
      ORDER BY m.period_start`, [T(req), target.id, cycle.id])).rows;
  return {
    cycle: { id: cycle.id, name: cycle.name },
    months,
    rollup: rollupRules.rollup(months, {
      periods_in_cycle: periodsInCycle(cycle, Number(settings.cycle_start_day) || 21),
    }),
  };
}

router.get('/months/me', async (req, res) => {
  try {
    const me = await employeeOr404(req, res, req.user.id);
    if (!me) return;
    res.json({ employee: me, ...(await monthsFor(req, me)) });
  } catch (e) {
    logger.error('timesheet-kra months me', { error: e.message });
    res.status(500).json({ error: 'Could not load your closed months' });
  }
});

router.get('/months/:id', async (req, res) => {
  try {
    const target = await employeeOr404(req, res, req.params.id);
    if (!target) return;
    if (!(await canRead(req, target))) {
      return res.status(403).json({ error: 'You can only open the timesheet of someone who reports to you' });
    }
    res.json({ employee: target, ...(await monthsFor(req, target)) });
  } catch (e) {
    logger.error('timesheet-kra months', { error: e.message });
    res.status(500).json({ error: 'Could not load the closed months' });
  }
});

// PUT /timesheet/kra/month/:id/override — a manager disputing one month.
//
// ON THE MONTH, NOT ON THE ROLLUP. A sprint run outside Zoho, a
// secondment, a month mostly on leave: the correction belongs against
// the month that was wrong, with its reason, where the rollup will read
// it and the audit will keep it. Overriding the year-end figure
// directly would leave no record of WHICH month was disputed.
router.put('/month/:id/override', async (req, res) => {
  try {
    const row = (await db.query(
      `SELECT m.*, to_char(m.period_start,'YYYY-MM-DD') AS period_start
         FROM pms.timesheet_month m WHERE m.id=$1 AND m.tenant_id=$2`,
      [req.params.id, T(req)])).rows[0];
    if (!row) return res.status(404).json({ error: 'No closed month with that id' });
    const target = await employeeOr404(req, res, row.employee_id);
    if (!target) return;
    if (!(await canWrite(req, target))) {
      return res.status(403).json({ error: 'Only this person\'s manager or HR can override their month' });
    }
    const b = req.body || {};
    // Clearing an override is a legitimate instruction and needs no
    // reason of its own — the audit already carries the one it removes.
    if (b.clear === true) {
      const cleared = (await db.query(
        `UPDATE pms.timesheet_month
            SET override_score=NULL, override_grade=NULL, override_reason=NULL,
                overridden_by=NULL, overridden_at=NULL
          WHERE id=$1 RETURNING *`, [row.id])).rows[0];
      await audit(req, 'TIMESHEET_MONTH_OVERRIDE_CLEARED', target.id, {
        month_id: row.id, period_start: row.period_start,
        was: { score: row.override_score, grade: row.override_grade, reason: row.override_reason },
      });
      return res.json({ ok: true, month: cleared });
    }
    const bad = rollupRules.validateOverride(b);
    if (bad) return res.status(422).json({ error: bad });

    const saved = (await db.query(
      `UPDATE pms.timesheet_month
          SET override_score=$2, override_grade=$3, override_reason=$4,
              overridden_by=$5, overridden_at=now()
        WHERE id=$1 RETURNING *`,
      [row.id, b.score == null || b.score === '' ? null : Number(b.score),
       String(b.grade || '').trim() || null, String(b.reason).trim(), req.user.email])).rows[0];

    // Audited with what it was, because this is the record that answers
    // "why did my rating change" once it reaches calibration.
    await audit(req, 'TIMESHEET_MONTH_OVERRIDDEN', target.id, {
      month_id: row.id, period_start: row.period_start,
      from: { score: row.score, grade: row.grade },
      to: { score: saved.override_score, grade: saved.override_grade },
      reason: saved.override_reason,
    });
    res.json({ ok: true, month: saved });
  } catch (e) {
    logger.error('timesheet-kra override', { error: e.message });
    res.status(500).json({ error: 'Could not save the override' });
  }
});

// GET /timesheet/kra/rollup — everybody's year-end view, HR only.
//
// ONE QUERY PLUS A PURE ROLLUP PER PERSON. The rows are already
// snapshots, so nothing is recomputed here — which is the whole point
// of having closed them.
router.get('/rollup', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const { settingsFor } = require('./timesheet');
    const settings = await settingsFor(T(req));
    const cycle = await activeCycle(T(req));
    if (!cycle) return res.json({ cycle: null, people: [], totals: { people: 0 } });
    const periods = periodsInCycle(cycle, Number(settings.cycle_start_day) || 21);

    const rows = (await db.query(
      `SELECT m.*, to_char(m.period_start,'YYYY-MM-DD') AS period_start,
              e.name, e.emp_code, e.department, e.designation
         FROM pms.timesheet_month m JOIN core.employees e ON e.id = m.employee_id
        WHERE m.tenant_id=$1 AND m.cycle_id=$2
        ORDER BY e.name, m.period_start`, [T(req), cycle.id])).rows;

    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.employee_id)) {
        by.set(r.employee_id, { employee: { id: r.employee_id, name: r.name, emp_code: r.emp_code,
          department: r.department, designation: r.designation }, months: [] });
      }
      by.get(r.employee_id).months.push(r);
    }
    const people = [...by.values()]
      .map((p) => ({ employee: p.employee, rollup: rollupRules.rollup(p.months, { periods_in_cycle: periods }) }))
      .sort((a, b) => b.rollup.hours - a.rollup.hours || a.employee.name.localeCompare(b.employee.name));

    const closedPeriods = [...new Set(rows.map((r) => r.period_start))].sort();
    res.json({
      cycle: { id: cycle.id, name: cycle.name },
      periods_in_cycle: periods,
      closed_periods: closedPeriods,
      people,
      totals: {
        people: people.length,
        periods_closed: closedPeriods.length,
        hours: Math.round(people.reduce((t, p) => t + p.rollup.hours, 0) * 10) / 10,
        overrides: people.reduce((t, p) => t + p.rollup.overrides, 0),
        // The honest headline: how many of these are thick enough to
        // read at all.
        readable: people.filter((p) => p.rollup.mapped_pct != null && p.rollup.mapped_pct >= 50).length,
      },
    });
  } catch (e) {
    logger.error('timesheet-kra rollup', { error: e.message });
    res.status(500).json({ error: 'Could not build the rollup' });
  }
});

module.exports = { router, reportFor, validateMapping, scoringFor, windowFor,
                   periodsInCycle, snapshotOf, monthsFor };
