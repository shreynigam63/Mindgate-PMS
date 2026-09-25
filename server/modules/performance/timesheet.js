// Timesheets — the routes.
//
// Asked for on 25 Sep, with the client's Zoho Sprints export and their
// own compliance dashboard attached:
//
//   1  employees get an upload and their OWN report, on the Self tab
//   2  managers get the dashboard for the people who report to them
//   3  HR gets it for everybody
//   4  all three live under a tab called "Timesheet"
//
// Mounted by the performance router, which has already authenticated and
// run the parity gate. Every handler still guards its own rows: the
// route table cannot express "your own logs only", and that is exactly
// the rule this feature turns on.
//
// THE UPLOAD IS SCOPED TO THE UPLOADER. An employee may load a file that
// contains other people's rows — the export is per project, so it very
// often does — and those rows are REPORTED and skipped, not loaded.
// Silently loading them would let anyone write another person's
// compliance record; silently dropping them would leave the employee
// believing a partial upload was complete.
const express = require('express');
const multer = require('multer');
const db = require('../../core/db');
const logger = require('../../core/logger');
const { hasPermission } = require('../../core/permissions');
const { parseExcelSheets, parseCsv, detectFormat } = require('../../core/employees');
const { parseTimesheetSheet, compliance, DEFAULTS } = require('./timesheet-rules');

const router = express.Router();
const T = (req) => req.user.tenant_id;

// The module's own audit helper, for the same reason competencies.js has
// one: index.js requires this file, so requiring back is a cycle. A
// timesheet upload changes a compliance record that a manager will read
// in a review, so who loaded what has to stay queryable.
const audit = (req, action, employeeId, details) => db.query(
  `INSERT INTO pms.audit_log (tenant_id, actor_email, action, employee_id, details)
   VALUES ($1,$2,$3,$4,$5)`,
  [T(req), req.user.email, action, employeeId || null, details ? JSON.stringify(details) : null])
  .catch((e) => logger.warn('timesheet audit failed', { error: e.message }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(csv|xlsx|xls)$/i.test(file.originalname || '')) return cb(new Error('Only .csv, .xlsx, or .xls files are accepted'));
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// Settings. Not in the generic SETTINGS map in index.js: that one is a
// fixed list of allowed values per key, and a holiday list is free text.
// Bending it to fit would have cost more than one small pair of routes.

async function settingsFor(tenantId) {
  const row = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [tenantId])).rows[0];
  const v = (row && row.value) || {};
  return {
    cycle_start_day: Number(v.cycle_start_day) || DEFAULTS.cycle_start_day,
    green_pct: v.green_pct == null ? DEFAULTS.green_pct : Number(v.green_pct),
    amber_pct: v.amber_pct == null ? DEFAULTS.amber_pct : Number(v.amber_pct),
    holidays: Array.isArray(v.holidays) ? v.holidays : [],
  };
}

router.get('/settings', async (req, res) => {
  try {
    res.json({ settings: await settingsFor(T(req)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const b = req.body || {};
    const day = Number(b.cycle_start_day);
    const green = Number(b.green_pct);
    const amber = Number(b.amber_pct);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      return res.status(422).json({ error: 'cycle_start_day must be a whole number between 1 and 28' });
    }
    if (!(green >= 0 && green <= 100) || !(amber >= 0 && amber <= 100)) {
      return res.status(422).json({ error: 'green_pct and amber_pct must be between 0 and 100' });
    }
    // Named rather than silently swapped: a Green threshold below Amber
    // makes every rating Green, which looks like the feature working.
    if (amber > green) return res.status(422).json({ error: 'the Amber threshold cannot be higher than the Green one' });
    const holidays = (Array.isArray(b.holidays) ? b.holidays : String(b.holidays || '').split(/[,\s]+/))
      .map((s) => String(s).trim()).filter(Boolean);
    const bad = holidays.find((h) => !/^\d{4}-\d{2}-\d{2}$/.test(h));
    if (bad) return res.status(422).json({ error: `holiday "${bad}" is not a date — use YYYY-MM-DD` });
    const value = { cycle_start_day: day, green_pct: green, amber_pct: amber, holidays: [...new Set(holidays)].sort() };
    await db.query(
      `INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'timesheet',$2)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [T(req), JSON.stringify(value)]);
    audit(req, 'TIMESHEET_SETTINGS_CHANGED', null, value);
    res.json({ ok: true, settings: value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Reads

const EMP = `e.id, e.emp_code, e.name, e.email, e.department, e.designation`;

async function entriesFor(tenantId, employeeIds) {
  if (!employeeIds.length) return new Map();
  const rows = (await db.query(
    `SELECT employee_id, to_char(log_date,'YYYY-MM-DD') AS log_date, hours,
            item_id, item_name, item_type, sprint, description, approval_status, approved_by, logged_on
       FROM pms.timesheet_entries
      WHERE tenant_id=$1 AND employee_id = ANY($2::uuid[])
      ORDER BY log_date, item_id`, [tenantId, employeeIds])).rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.employee_id)) by.set(r.employee_id, []);
    by.get(r.employee_id).push({ ...r, hours: Number(r.hours) });
  }
  return by;
}

// One person's full report: every cycle, every day, every log.
async function reportFor(tenantId, employee, settings, asOf) {
  const entries = (await entriesFor(tenantId, [employee.id])).get(employee.id) || [];
  const c = compliance(entries, settings, asOf);
  const last = (await db.query(
    `SELECT b.source_file, b.project_name, b.created_at, b.uploaded_by_email, b.rows_loaded
       FROM pms.timesheet_batches b
      WHERE b.tenant_id=$1 AND EXISTS (
            SELECT 1 FROM pms.timesheet_entries t WHERE t.batch_id=b.id AND t.employee_id=$2)
      ORDER BY b.created_at DESC LIMIT 1`, [tenantId, employee.id])).rows[0] || null;
  return { employee, settings, ...c, entries, last_upload: last };
}

// A roster line: the headline numbers only, for a list of people.
function summarise(employee, entries, settings, asOf) {
  const c = compliance(entries, settings, asOf);
  const current = c.cycles.length ? c.cycles[c.cycles.length - 1] : null;
  const hasData = !!entries.length;
  return {
    employee,
    logged_days: c.total.filled,
    working_days: c.total.work,
    missing: c.total.missing,
    hours: c.total.hours,
    // NULL, not 0 and not 'Red', for somebody who has uploaded nothing.
    // They have not failed to fill their timesheet in this system; there
    // is simply no data about them, and a roster that prints Red against
    // 1,300 names on day one is a lie that sends managers chasing people
    // who have done nothing wrong.
    pct: hasData ? c.total.pct : null,
    rating: hasData ? c.total.rating : null,
    cycles: c.cycles.length,
    has_data: hasData,
    current_cycle: current && {
      start: current.start, end: current.end, pct: current.pct, rating: current.rating,
      filled: current.filled, work: current.work, missing: current.missing, hours: current.hours,
      in_progress: current.in_progress,
    },
  };
}

router.get('/me', async (req, res) => {
  try {
    const me = (await db.query(
      `SELECT ${EMP} FROM core.employees e WHERE e.tenant_id=$1 AND e.id=$2`, [T(req), req.user.id])).rows[0];
    if (!me) return res.status(404).json({ error: 'no employee record for this login' });
    const settings = await settingsFor(T(req));
    res.json(await reportFor(T(req), me, settings, req.query.as_of));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The manager's roster. Direct reports only — the same scope every other
// Manager-tab list uses.
router.get('/team', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_team_eval'))) return res.status(403).json({ error: "Requires 'pms_team_eval'" });
    const people = (await db.query(
      `SELECT ${EMP} FROM core.employees e
        WHERE e.tenant_id=$1 AND e.manager_id=$2 AND e.status='active'
        ORDER BY e.name`, [T(req), req.user.id])).rows;
    const settings = await settingsFor(T(req));
    const by = await entriesFor(T(req), people.map((p) => p.id));
    res.json({
      settings,
      team: people.map((p) => summarise(p, by.get(p.id) || [], settings, req.query.as_of)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Everybody. HR only, and paged by department/search rather than by
// offset because that is how HR actually looks for somebody.
router.get('/all', async (req, res) => {
  try {
    if (!(await hasPermission(req.user, 'pms_admin'))) return res.status(403).json({ error: "Requires 'pms_admin'" });
    const dept = (req.query.department || '').trim();
    const q = (req.query.q || '').trim();
    const params = [T(req)];
    let where = '';
    if (dept) { params.push(dept); where += ` AND lower(btrim(coalesce(e.department,''))) = lower(btrim($${params.length}))`; }
    if (q) { params.push(`%${q}%`); where += ` AND (e.name ILIKE $${params.length} OR e.email ILIKE $${params.length} OR e.emp_code ILIKE $${params.length})`; }
    const people = (await db.query(
      `SELECT ${EMP} FROM core.employees e
        WHERE e.tenant_id=$1 AND e.status='active' ${where}
        ORDER BY e.name`, params)).rows;
    const departments = (await db.query(
      `SELECT DISTINCT btrim(department) AS department FROM core.employees
        WHERE tenant_id=$1 AND status='active' AND coalesce(btrim(department),'') <> '' ORDER BY 1`,
      [T(req)])).rows.map((r) => r.department);
    const settings = await settingsFor(T(req));
    const by = await entriesFor(T(req), people.map((p) => p.id));
    const rows = people.map((p) => summarise(p, by.get(p.id) || [], settings, req.query.as_of));
    // The headline HR actually needs: of the people who have uploaded
    // anything at all, how many are Green. Counting the 1,300 who have
    // never uploaded as Red would make the number meaningless on day one,
    // so they are reported separately as "no data".
    const withData = rows.filter((r) => r.has_data);
    res.json({
      settings,
      departments,
      employees: rows,
      totals: {
        employees: rows.length,
        with_data: withData.length,
        no_data: rows.length - withData.length,
        green: withData.filter((r) => r.rating === 'Green').length,
        amber: withData.filter((r) => r.rating === 'Amber').length,
        red: withData.filter((r) => r.rating === 'Red').length,
        hours: Math.round(withData.reduce((t, r) => t + r.hours, 0) * 100) / 100,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One person's full report, for a manager or for HR. The guard is the
// point of the route: a manager may open their own reports and nobody
// else's, and the check is on the ROW, not on the path.
router.get('/employee/:id', async (req, res) => {
  try {
    const target = (await db.query(
      `SELECT ${EMP}, e.manager_id FROM core.employees e WHERE e.tenant_id=$1 AND e.id=$2`,
      [T(req), req.params.id])).rows[0];
    if (!target) return res.status(404).json({ error: 'employee not found' });
    const isAdmin = await hasPermission(req.user, 'pms_admin');
    const isMine = target.manager_id === req.user.id;
    const isSelf = target.id === req.user.id;
    if (!isAdmin && !isSelf && !isMine) {
      return res.status(403).json({ error: 'You can only open the timesheet of someone who reports to you' });
    }
    const settings = await settingsFor(T(req));
    res.json(await reportFor(T(req), target, settings, req.query.as_of));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Upload

router.post('/upload', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
}), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });
    const format = detectFormat(req.file);
    if (format === 'xls-legacy') {
      return res.status(400).json({ error: 'Legacy .xls files are not supported — please re-save the file as .xlsx (File > Save As > Excel Workbook) and upload again.' });
    }
    const sheets = format === 'xlsx'
      ? await parseExcelSheets(req.file.buffer)
      : [{ name: null, rows: parseCsv(req.file.buffer.toString('utf8')), rowNumbers: null }];

    // The export has one worksheet, but a workbook somebody has added a
    // notes tab to should still work: take the first sheet that HAS a
    // timesheet header rather than insisting it is sheet one.
    let parsed = null;
    for (const s of sheets) {
      const p = parseTimesheetSheet(s.rows, { rowNumbers: s.rowNumbers });
      if (!p.fatal) { parsed = { ...p, sheet: s.name }; break; }
      if (!parsed) parsed = { ...p, sheet: s.name };
    }
    if (parsed.fatal) return res.status(400).json({ error: parsed.fatal });

    const isAdmin = await hasPermission(req.user, 'pms_admin');
    const me = (await db.query(
      `SELECT ${EMP} FROM core.employees e WHERE e.tenant_id=$1 AND e.id=$2`, [T(req), req.user.id])).rows[0];

    // Resolve owners to employees once, by email then by name. An email
    // is exact; a name is a soft key, so an ambiguous one is reported
    // rather than guessed — two people called the same thing would
    // otherwise have their compliance silently merged.
    const emails = [...new Set(parsed.entries.map((e) => e.owner_email).filter(Boolean))];
    const names = [...new Set(parsed.entries.map((e) => e.owner_name).filter(Boolean))];
    const byEmail = new Map((await db.query(
      `SELECT ${EMP} FROM core.employees e WHERE e.tenant_id=$1 AND lower(e.email) = ANY($2::text[])`,
      [T(req), emails.map((s) => s.toLowerCase())])).rows.map((r) => [r.email.toLowerCase(), r]));
    const nameHits = new Map();
    if (names.length) {
      for (const r of (await db.query(
        `SELECT ${EMP} FROM core.employees e
          WHERE e.tenant_id=$1 AND lower(btrim(e.name)) = ANY($2::text[])`,
        [T(req), names.map((s) => s.trim().toLowerCase())])).rows) {
        const k = r.name.trim().toLowerCase();
        if (!nameHits.has(k)) nameHits.set(k, []);
        nameHits.get(k).push(r);
      }
    }

    const errors = [...parsed.errors];
    const skipped = [];
    const keep = [];
    const touched = new Map();
    for (const e of parsed.entries) {
      let emp = e.owner_email ? byEmail.get(e.owner_email) : null;
      if (!emp && e.owner_name) {
        const hits = nameHits.get(e.owner_name.trim().toLowerCase()) || [];
        if (hits.length === 1) [emp] = hits;
        else if (hits.length > 1) {
          errors.push({ line: e.line, error: `"${e.owner_name}" matches ${hits.length} employees — the file needs an Owner Mail Id column for this row` });
          continue;
        }
      }
      if (!emp) {
        errors.push({ line: e.line, error: `no employee on file for "${e.owner_email || e.owner_name}"` });
        continue;
      }
      // THE SCOPE RULE. Not a route rule: it is about the row.
      if (!isAdmin && emp.id !== req.user.id) {
        skipped.push({ line: e.line, owner: emp.name, reason: 'not your log — only your own rows are loaded' });
        continue;
      }
      keep.push({ ...e, employee: emp });
      touched.set(emp.id, emp);
    }

    const dates = keep.map((e) => e.log_date).sort();
    const report = {
      sheet: parsed.sheet,
      header_row: parsed.headerRow,
      meta: parsed.meta,
      total_rows: parsed.entries.length,
      loadable: keep.length,
      employees: [...touched.values()].map((e) => ({ id: e.id, name: e.name, email: e.email })),
      first_log_date: dates[0] || null,
      last_log_date: dates[dates.length - 1] || null,
      errors,
      skipped: skipped.slice(0, 200),
      skipped_total: skipped.length,
      scope: isAdmin ? 'all employees' : 'your own logs only',
    };

    if (req.query.commit !== '1') {
      return res.json({ ok: errors.length === 0, committed: false, note: 'Dry run — pass ?commit=1 to load.', ...report });
    }
    if (!keep.length) {
      return res.status(422).json({ ok: false, committed: false, error: 'Nothing in this file can be loaded — see the rows below.', ...report });
    }

    const client = await db.getClient();
    let batchId;
    try {
      await client.query('BEGIN');
      batchId = (await client.query(
        `INSERT INTO pms.timesheet_batches
           (tenant_id, uploaded_by_email, source_file, project_name, team_name, exported_on,
            rows_loaded, employees_touched, first_log_date, last_log_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [T(req), req.user.email, req.file.originalname || null, parsed.meta.project_name || null,
          parsed.meta.team_name || null, parsed.meta.exported_on || null,
          keep.length, touched.size, report.first_log_date, report.last_log_date])).rows[0].id;

      // Replace the window this file covers, per employee — see 053 for
      // why a window and not the world.
      for (const emp of touched.values()) {
        const mine = keep.filter((e) => e.employee.id === emp.id).map((e) => e.log_date).sort();
        await client.query(
          `DELETE FROM pms.timesheet_entries
            WHERE tenant_id=$1 AND employee_id=$2 AND log_date BETWEEN $3::date AND $4::date`,
          [T(req), emp.id, mine[0], mine[mine.length - 1]]);
      }
      for (const e of keep) {
        await client.query(
          `INSERT INTO pms.timesheet_entries
             (tenant_id, batch_id, employee_id, owner_name, owner_email, log_date, hours,
              item_id, item_name, item_type, sprint, log_type, description,
              billing_status, approval_status, approved_by, logged_on, project_name)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [T(req), batchId, e.employee.id, e.owner_name || null, e.owner_email || null, e.log_date, e.hours,
            e.item_id || null, e.item_name || null, e.item_type || null, e.sprint || null, e.log_type || null,
            e.description || null, e.billing_status || null, e.approval_status || null, e.approved_by || null,
            e.logged_on || null, e.project_name || null]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    for (const emp of touched.values()) {
      audit(req, 'TIMESHEET_UPLOADED', emp.id, {
        batch: batchId,
        file: req.file.originalname,
        rows: keep.filter((e) => e.employee.id === emp.id).length,
        from: report.first_log_date,
        to: report.last_log_date,
      });
    }
    logger.info('timesheet uploaded', { tenant: T(req), by: req.user.email, rows: keep.length, employees: touched.size });
    res.json({ ok: true, committed: true, batch_id: batchId, ...report });
  } catch (e) {
    logger.error('timesheet upload', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// What has been loaded, most recent first. Employees see their own
// uploads; HR sees every one.
router.get('/batches', async (req, res) => {
  try {
    const isAdmin = await hasPermission(req.user, 'pms_admin');
    const params = [T(req)];
    let where = '';
    if (!isAdmin) {
      params.push(req.user.id);
      where = ` AND EXISTS (SELECT 1 FROM pms.timesheet_entries t WHERE t.batch_id=b.id AND t.employee_id=$${params.length})`;
    }
    const rows = (await db.query(
      `SELECT b.id, b.source_file, b.project_name, b.team_name, b.uploaded_by_email, b.rows_loaded,
              b.employees_touched, b.first_log_date, b.last_log_date, b.created_at
         FROM pms.timesheet_batches b
        WHERE b.tenant_id=$1 ${where}
        ORDER BY b.created_at DESC LIMIT 25`, params)).rows;
    res.json({ batches: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, settingsFor };
