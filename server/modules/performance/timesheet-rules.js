// Timesheet compliance — the maths and the parser, with no database and
// no Express in sight.
//
// Two jobs, both pure, both here so they can be tested with a literal:
//
//   parseTimesheetSheet()  a Zoho Sprints timesheet export -> rows
//   compliance()           rows + settings -> cycles, filled %, rating
//
// WHY THE PARSER CANNOT ASSUME ROW 1. The client's export carries five
// metadata rows (Team Name, Project Name, Exported By, Date, Filter),
// then a GROUP BAND row that spans "Timesheet", "Item" and "Meeting"
// over their columns, and only then the real header. Reading row 1 as
// the header reports every column as missing against a perfectly good
// file — exactly the failure the employee importer hit on 22 Sep. So
// the header is FOUND, by looking for the two columns that make a row a
// timesheet line: Log Date and Log owner.
//
// WHY THE COLUMN NAMES REPEAT. Under those group bands, "Created by",
// "Created On" and "Release" each appear up to three times — once for
// the log, once for the item, once for the meeting. indexOf() therefore
// takes the FIRST, which is the timesheet's own, which is the one we
// want. That is luck rather than design, so the mapping below names the
// group it means in a comment rather than leaving the next reader to
// discover it.

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

const pad = (n) => String(n).padStart(2, '0');
// Local-date key. NOT toISOString(): that converts to UTC first, so
// every date east of Greenwich comes back a day early after midnight
// local — which on a day-by-day compliance grid means a log lands on
// the wrong day and a filled day reads as missing.
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The export writes "18/Sep/2026", the xlsx parser may hand back
// "2026-09-18" for a real date cell, and a raw Excel serial turns up
// when a column is formatted as a number. All three, one function.
function parseDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const dmy = s.match(/^(\d{1,2})[/\- ]([A-Za-z]{3})[A-Za-z]*[/\- ](\d{4})/);
  if (dmy && MON[dmy[2].toLowerCase()] != null) return new Date(+dmy[3], MON[dmy[2].toLowerCase()], +dmy[1]);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
  const num = Number(s);
  // Excel serials. 25569 is 1970-01-01; anything below 20000 (1954) in a
  // date column is a typo, not a date, and is better reported as
  // unparseable than silently read as the Eisenhower administration.
  if (Number.isFinite(num) && num > 20000 && num < 80000) {
    const d = new Date(Math.round((num - 25569) * 864e5));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return null;
}

// "08:00" -> 8, "07:30" -> 7.5. The export carries BOTH a display column
// and a decimal one; the decimal wins when it is a number, because
// "Log Hours(for calculation)" is what the source itself calls
// authoritative.
function parseHours(display, decimal) {
  const n = parseFloat(decimal);
  if (Number.isFinite(n)) return n;
  const m = String(display == null ? '' : display).trim().match(/^(\d+):(\d{1,2})/);
  if (m) return +m[1] + (+m[2]) / 60;
  const plain = parseFloat(display);
  return Number.isFinite(plain) ? plain : 0;
}

const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, '');

// field -> the header it comes from. Left column is our name, right is
// the export's, normalised. The comment says which group band it sits
// under where the name repeats.
const COLUMNS = {
  item_id: 'itemid',
  item_name: 'itemname',
  log_type: 'logtype',
  hours_display: 'loghours',
  hours_decimal: 'loghoursforcalculation',
  owner_name: 'logowner',
  log_date: 'logdate',
  billing_status: 'billingstatus',
  approval_status: 'approvalstatus',
  approved_by: 'approvedby',
  logged_on: 'createdon',        // Timesheet band — the first of three
  description: 'description',
  sprint: 'sprint',
  item_type: 'itemtype',
  owner_email: 'ownermailid',
  project_name: 'projectname',
};
// Without these two a sheet is not a timesheet, whatever else it holds.
const HEADER_MARKERS = ['logdate', 'logowner'];

/**
 * @param {string[][]} rows  the worksheet as an array of arrays of strings
 * @returns {{ok, meta, entries, errors, headerRow}}
 *   entries carry a 1-based `line` — the row number a human sees in
 *   Excel — so every error names a row they can actually go and look at.
 */
function parseTimesheetSheet(rows, opts = {}) {
  const errors = [];
  const out = [];
  const meta = {};
  const headerIndex = rows.findIndex((r) => {
    const set = new Set((r || []).map(norm));
    return HEADER_MARKERS.every((m) => set.has(m));
  });
  if (headerIndex < 0) {
    return {
      ok: false, meta, entries: [], errors, headerRow: null,
      fatal: 'This does not look like a Zoho timesheet export — no row carries both a "Log Date" and a "Log owner" column.',
    };
  }
  // The metadata block above the header: "Team Name | productteam".
  for (let i = 0; i < headerIndex; i++) {
    const k = norm((rows[i] || [])[0]);
    const v = (rows[i] || [])[1];
    if (k && v) meta[k] = String(v).trim();
  }

  const header = (rows[headerIndex] || []).map(norm);
  const at = {};
  for (const [field, wanted] of Object.entries(COLUMNS)) at[field] = header.indexOf(wanted);

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const line = (opts.rowNumbers && opts.rowNumbers[i]) || i + 1;
    const get = (f) => (at[f] >= 0 ? String(r[at[f]] == null ? '' : r[at[f]]).trim() : '');
    const ownerEmail = get('owner_email').toLowerCase();
    const ownerName = get('owner_name');
    // A wholly blank row is spacing, not an error. A row with an owner
    // but no date, or a date but no owner, IS an error: it is a log line
    // the file failed to describe, and dropping it quietly would make
    // the compliance figure wrong in the flattering direction.
    if (!ownerEmail && !ownerName && !get('log_date') && !get('item_id')) continue;
    const d = parseDate(get('log_date'));
    if (!d) { errors.push({ line, error: `log date "${get('log_date')}" is not a date` }); continue; }
    if (!ownerEmail && !ownerName) { errors.push({ line, error: 'the row names no log owner' }); continue; }
    out.push({
      line,
      owner_email: ownerEmail,
      owner_name: ownerName,
      log_date: key(d),
      hours: Math.round(parseHours(get('hours_display'), get('hours_decimal')) * 100) / 100,
      item_id: get('item_id'),
      item_name: get('item_name'),
      item_type: get('item_type'),
      sprint: get('sprint'),
      log_type: get('log_type'),
      description: get('description'),
      billing_status: get('billing_status'),
      approval_status: get('approval_status'),
      approved_by: get('approved_by'),
      logged_on: get('logged_on'),
      project_name: get('project_name') || meta.projectname || '',
    });
  }
  return {
    ok: errors.length === 0,
    headerRow: headerIndex + 1,
    meta: {
      team_name: meta.teamname || '',
      project_name: meta.projectname || '',
      exported_by: meta.exportedby || '',
      exported_on: meta.date || '',
    },
    entries: out,
    errors,
  };
}

// --------------------------------------------------------------------------
// The compliance maths.

const DEFAULTS = {
  cycle_start_day: 21,   // the client's dashboard defaults to the 21st
  green_pct: 90,
  amber_pct: 75,
  holidays: [],
};

// The cycle a date falls in, for a cycle that starts on day `sd`:
// 21 Sep – 20 Oct when sd is 21. A date before the 21st belongs to the
// cycle that started the PREVIOUS month.
function cycleOf(d, sd) {
  let y = d.getFullYear();
  let m = d.getMonth();
  if (d.getDate() < sd) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  return { start: new Date(y, m, sd), end: new Date(y, m + 1, sd - 1) };
}

function ratingOf(pct, green, amber) {
  return pct >= green ? 'Green' : pct >= amber ? 'Amber' : 'Red';
}

/**
 * @param {{log_date:string, hours:number}[]} entries  one person's logs
 * @param {object} settings  cycle_start_day, green_pct, amber_pct, holidays[]
 * @param {string} asOf  yyyy-mm-dd; days after it are not counted missing
 */
function compliance(entries, settings = {}, asOf = null) {
  const s = { ...DEFAULTS, ...settings };
  const sd = Math.min(28, Math.max(1, Number(s.cycle_start_day) || DEFAULTS.cycle_start_day));
  const green = Number(s.green_pct);
  const amber = Number(s.amber_pct);
  const hol = new Set(s.holidays || []);
  const today = parseDate(asOf) || new Date();
  const asOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const rows = entries.map((e) => ({ ...e, d: parseDate(e.log_date) })).filter((e) => e.d);
  if (!rows.length) {
    return { cycles: [], total: { work: 0, filled: 0, missing: 0, extra: 0, hours: 0, pct: 0, rating: 'Red', no_data: true } };
  }
  const byDay = new Map();
  for (const e of rows) {
    const k = key(e.d);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const minD = new Date(Math.min(...rows.map((e) => e.d)));
  const maxD = new Date(Math.max(asOfDay, ...rows.map((e) => e.d)));

  const cycles = [];
  let c = cycleOf(minD, sd);
  // A guard, not decoration: a bad start day or a corrupt date could
  // otherwise spin here forever inside a request.
  for (let guard = 0; c.start <= maxD && guard < 600; guard++) {
    const days = [];
    let work = 0; let filled = 0; let extra = 0; let hours = 0;
    for (let d = new Date(c.start); d <= c.end; d.setDate(d.getDate() + 1)) {
      const k = key(d);
      const logs = byDay.get(k) || [];
      const h = logs.reduce((t, e) => t + (Number(e.hours) || 0), 0);
      hours += h;
      const wd = d.getDay();
      const off = wd === 0 || wd === 6 || hol.has(k);
      let state;
      if (d > asOfDay) state = logs.length ? 'filled' : 'future';
      else if (off) {
        state = logs.length ? 'extra' : (hol.has(k) ? 'holiday' : 'weekend');
        if (logs.length) extra++;
      } else {
        work++;
        if (logs.length) { filled++; state = 'filled'; } else state = 'missing';
      }
      days.push({ date: k, weekday: d.getDay(), state, hours: Math.round(h * 100) / 100, logs: logs.length });
    }
    const pct = work ? (filled / work) * 100 : 0;
    cycles.push({
      start: key(c.start),
      end: key(c.end),
      work,
      filled,
      missing: work - filled,
      extra,
      hours: Math.round(hours * 100) / 100,
      pct: Math.round(pct * 10) / 10,
      rating: ratingOf(pct, green, amber),
      in_progress: c.end > asOfDay,
      days,
    });
    c = cycleOf(new Date(c.end.getFullYear(), c.end.getMonth(), c.end.getDate() + 1), sd);
  }

  const work = cycles.reduce((t, x) => t + x.work, 0);
  const filled = cycles.reduce((t, x) => t + x.filled, 0);
  const hours = cycles.reduce((t, x) => t + x.hours, 0);
  const pct = work ? (filled / work) * 100 : 0;
  return {
    cycles,
    total: {
      work,
      filled,
      missing: work - filled,
      extra: cycles.reduce((t, x) => t + x.extra, 0),
      hours: Math.round(hours * 100) / 100,
      pct: Math.round(pct * 10) / 10,
      rating: ratingOf(pct, green, amber),
    },
  };
}

module.exports = { parseTimesheetSheet, compliance, cycleOf, ratingOf, parseDate, parseHours, key, DEFAULTS };
