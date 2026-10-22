// node --test — the timesheet parser and the compliance maths, with no
// database in sight. These are the numbers a manager reads in a review,
// so they get tested against literals rather than against the app.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseTimesheetSheet, compliance, cycleOf, parseDate, dateProblem, parseHours, key,
} = require('../modules/performance/timesheet-rules');

// The shape of the client's own export: five metadata rows, a group-band
// row, then the header on row 7.
const HEADER = ['Item Id', 'Item Name', 'Meeting title', 'Log Title', 'Log Type', 'Log Hours',
  'Log Hours(for calculation)', 'Log hours in seconds', 'Reason for Rejection', 'Created by',
  'Updated By', 'Approved by', 'Created On', 'Log owner', 'Log Date', 'Billing Status',
  'Approval Status', 'Description', 'Release', 'Sprint', 'Created by', 'Created On',
  'Completed On', 'Tags', 'Assignee', 'Status', 'Epic', 'Item Type', 'Priority', 'Start Date',
  'End Date', 'Start After', 'Duration', 'Estimation Points', 'Release', 'Total Workhours',
  'Work hours per owner', 'Work hours type', 'Created by', 'Updated By', 'Created On',
  'Sprint Name', 'Meeting Type', 'Location', 'Remind Before', 'Agenda', 'Last Modified',
  'Project Id', 'Project Name', 'Owner Mail Id', 'Owner Role', 'Project Group'];

const row = (over = {}) => {
  const r = new Array(HEADER.length).fill('');
  const put = (name, v) => { r[HEADER.indexOf(name)] = v; };
  put('Item Id', 'U5P-I58'); put('Item Name', 'GFF Activities'); put('Log Type', 'WorkItem');
  put('Log Hours', '08:00'); put('Log Hours(for calculation)', '8.0');
  put('Log owner', 'Arun Prajapati'); put('Log Date', '18/Sep/2026');
  put('Approval Status', 'Approved'); put('Approved by', 'Danish Tawsalkar');
  put('Created On', '18/Sep/2026 16:19'); put('Description', 'working on tap n pay');
  put('Sprint', 'Q2 Sprint 3'); put('Item Type', 'Story');
  put('Owner Mail Id', 'arun.prajapati@mindgate.in'); put('Project Name', 'UPI 5.0 Product');
  for (const [k, v] of Object.entries(over)) put(k, v);
  return r;
};
const sheet = (...rows) => ([
  ['Team Name', 'productteam'],
  ['Project Name', 'UPI 5.0 Product'],
  ['Exported By', 'Prashant Rajeshirke'],
  ['Date', '2026-09-25 11:04:03'],
  ['Filter', 'Log owner Is Arun Prajapati'],
  ['', '', '', '', '', '', '', '', 'Timesheet'],
  HEADER,
  ...rows,
]);

test('the header is FOUND, not assumed to be row 1', () => {
  const p = parseTimesheetSheet(sheet(row()));
  assert.equal(p.fatal, undefined);
  assert.equal(p.headerRow, 7, 'the client export puts the header on row 7');
  assert.equal(p.entries.length, 1);
  assert.equal(p.meta.project_name, 'UPI 5.0 Product');
  assert.equal(p.meta.team_name, 'productteam');
});

test('a sheet with no Log Date / Log owner pair is refused, not half-read', () => {
  const p = parseTimesheetSheet([['Name', 'Hours'], ['Arun', '8']]);
  assert.match(p.fatal, /Log Date/);
  assert.equal(p.entries.length, 0);
});

test('the export\'s own fields land where they belong', () => {
  const [e] = parseTimesheetSheet(sheet(row())).entries;
  assert.equal(e.owner_email, 'arun.prajapati@mindgate.in');
  assert.equal(e.owner_name, 'Arun Prajapati');
  assert.equal(e.log_date, '2026-09-18');
  assert.equal(e.hours, 8);
  assert.equal(e.item_id, 'U5P-I58');
  assert.equal(e.approval_status, 'Approved');
  // "Created On" appears three times under three group bands. The
  // timesheet's own is the first, and that is the one we must take.
  assert.equal(e.logged_on, '18/Sep/2026 16:19');
});

test('a row that names no owner, or carries no date, is reported — never dropped quietly', () => {
  const p = parseTimesheetSheet(sheet(
    row(),
    row({ 'Log Date': 'not a date' }),
    row({ 'Log owner': '', 'Owner Mail Id': '' }),
  ));
  assert.equal(p.ok, false);
  assert.equal(p.entries.length, 1, 'only the good row survives');
  assert.equal(p.errors.length, 2);
  assert.match(p.errors[0].error, /not a date/);
  assert.match(p.errors[1].error, /no log owner/);
  // The line number must be the one a human sees in Excel.
  assert.equal(p.errors[0].line, 9);
});

test('a wholly blank row is spacing, not an error', () => {
  const p = parseTimesheetSheet(sheet(row(), new Array(HEADER.length).fill('')));
  assert.equal(p.ok, true);
  assert.equal(p.entries.length, 1);
  assert.equal(p.errors.length, 0);
});

test('hours come from the decimal column, then the clock one', () => {
  assert.equal(parseHours('08:00', '8.0'), 8);
  assert.equal(parseHours('07:30', ''), 7.5);
  assert.equal(parseHours('', '4.25'), 4.25);
  assert.equal(parseHours('', ''), null, 'no hours is not zero hours');
});

test('hours are a number or h:mm — anything else is refused, never read as its leading digits (8 Oct)', () => {
  assert.equal(parseHours('', '7:30'), 7.5, 'h:mm typed into the decimal column means what it says');
  assert.equal(parseHours('', '8'), 8);
  assert.equal(parseHours('', '7:30:00'), 7.5);
  // A time-formatted cell reached the parser as a date and loaded 1899 h.
  assert.equal(parseHours('', '1899-12-30'), null);
  assert.equal(parseHours('', '7h'), null);
  assert.equal(parseHours('', '-2'), null);
  assert.equal(parseHours('1899-12-30', ''), null);
  // G wins whenever it has anything — a bad G is reported, not papered
  // over by F.
  assert.equal(parseHours('07:30', 'seven'), null);
});

test('a row with no hours, unreadable hours, or more than a day is reported — not loaded as 0 or 1899', () => {
  const p = parseTimesheetSheet(sheet(
    row(),
    row({ 'Log Hours': '', 'Log Hours(for calculation)': '' }),
    row({ 'Log Hours(for calculation)': '1899-12-30' }),
    row({ 'Log Hours(for calculation)': '25' }),
    row({ 'Log Hours(for calculation)': '0' }),
  ));
  assert.deepEqual(p.entries.map((e) => [e.line, e.hours]), [[8, 8], [12, 0]], 'an explicit 0 still loads, as an export can carry one');
  assert.deepEqual(p.errors.map((e) => e.line), [9, 10, 11]);
  assert.match(p.errors[0].error, /no Log Hours/);
  assert.match(p.errors[1].error, /not a number of hours/);
  assert.match(p.errors[2].error, /more than a day/);
});

test('a second log on the same day, written without owner or date, is reported — not skipped as blank (8 Oct)', () => {
  const p = parseTimesheetSheet(sheet(
    row(),
    row({ 'Log owner': '', 'Owner Mail Id': '', 'Log Date': '', 'Item Id': '', 'Log Hours(for calculation)': '3.5' }),
  ));
  assert.equal(p.entries.length, 1);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].error, /no Log Date — every row needs one/);
});

test('the summary rows at the foot of a real export are still skipped', () => {
  // What the client's export carries below its last log: a Log Type and a
  // total in Log Hours, and nothing else.
  const foot = (type, total) => {
    const r = new Array(HEADER.length).fill('');
    r[HEADER.indexOf('Log Type')] = type;
    r[HEADER.indexOf('Log Hours')] = total;
    return r;
  };
  const p = parseTimesheetSheet(sheet(row(), foot('Billable', '8:0'), foot('Non-billable', '584:0')));
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(p.entries.length, 1);
});

test('dates parse in all three shapes the export produces', () => {
  assert.equal(key(parseDate('18/Sep/2026')), '2026-09-18');
  assert.equal(key(parseDate('2026-09-18')), '2026-09-18');
  assert.equal(key(parseDate(new Date(2026, 8, 18))), '2026-09-18');
  assert.equal(key(parseDate(46283)), '2026-09-18');   // an Excel serial
  assert.equal(parseDate('rubbish'), null);
});

test('a day that does not exist is refused, not rolled into the next month (8 Oct)', () => {
  assert.equal(parseDate('31/Sep/2026'), null, 'not 1 Oct');
  assert.equal(parseDate('29/Feb/2026'), null);
  assert.equal(parseDate('2026-09-31'), null);
  assert.equal(key(parseDate('29/Feb/2028')), '2028-02-29', 'a real leap day still parses');
  assert.equal(key(parseDate('30/Sep/2026')), '2026-09-30');
});

test('the cycle runs from the start day to the day before the next', () => {
  const c = cycleOf(new Date(2026, 8, 25), 21);
  assert.equal(key(c.start), '2026-09-21');
  assert.equal(key(c.end), '2026-10-20');
  // A date BEFORE the start day belongs to the cycle that began last month.
  const b = cycleOf(new Date(2026, 8, 3), 21);
  assert.equal(key(b.start), '2026-08-21');
  assert.equal(key(b.end), '2026-09-20');
});

test('filled % counts working days only, and the rating follows the thresholds', () => {
  // 21 Sep 2026 is a Monday. Log Mon/Tue/Wed, leave Thu/Fri empty.
  const logs = ['2026-09-21', '2026-09-22', '2026-09-23'].map((d) => ({ log_date: d, hours: 8 }));
  const r = compliance(logs, { cycle_start_day: 21, green_pct: 90, amber_pct: 75 }, '2026-09-25');
  assert.equal(r.cycles.length, 1);
  const [c] = r.cycles;
  assert.equal(c.work, 5, 'Mon-Fri up to the as-of date');
  assert.equal(c.filled, 3);
  assert.equal(c.missing, 2);
  assert.equal(c.pct, 60);
  assert.equal(c.rating, 'Red');
  assert.equal(c.in_progress, true);
  assert.equal(c.hours, 24);
});

// 15 Oct: "Login hour as per 8 hrs per day based on number of working days
// … 207 hours shows 95.7%". The % is hours against 8 × working days.
test('LOGIN HOURS: 207 hours over 22 working days is 117.6% (8 h a day), not the 95.5% of days filled', () => {
  // 21 Sep – 21 Oct 2026, cycle from the 21st, Mon–Fri: 23 working days to
  // 21 Oct (the 20th is the cycle end, so take the full 21 Sep – 20 Oct).
  const days = [];
  for (let d = new Date(2026, 8, 21); d <= new Date(2026, 9, 20); d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days.push(key(new Date(d)));
  }
  assert.equal(days.length, 22);
  // 207 hours over 21 of the 22 days: one day missed.
  const logs = days.slice(0, 21).map((x, i) => ({ log_date: x, hours: i < 18 ? 10 : 9 }));
  assert.equal(logs.reduce((t, l) => t + l.hours, 0), 207);
  const c = compliance(logs, { cycle_start_day: 21, green_pct: 90, amber_pct: 75 }, '2026-10-20').cycles[0];
  assert.equal(c.work, 22);
  assert.equal(c.expected_hours, 176, '8 h × 22 working days');
  assert.equal(c.pct, 117.6, '207 ÷ 176');
  assert.equal(c.filled_pct, 95.5, 'the old day-based figure, kept as filled_pct');
  assert.equal(c.rating, 'Green');
  // Half days on every working day: every day filled, half the hours.
  const half = compliance(days.map((x) => ({ log_date: x, hours: 4 })), { cycle_start_day: 21, green_pct: 90, amber_pct: 75 }, '2026-10-20').cycles[0];
  assert.equal(half.filled_pct, 100);
  assert.equal(half.pct, 50);
  assert.equal(half.rating, 'Red');
  // A holiday is not asked for; HR's own hours a day are used.
  const hol = compliance(logs, { cycle_start_day: 21, green_pct: 90, amber_pct: 75, holidays: ['2026-10-02'], hours_per_day: 9 }, '2026-10-20').cycles[0];
  assert.equal(hol.work, 21);
  assert.equal(hol.expected_hours, 189);
});

test('a weekend log is counted as extra, never as a working day', () => {
  // 26 Sep 2026 is a Saturday.
  const r = compliance([{ log_date: '2026-09-26', hours: 4 }],
    { cycle_start_day: 21, green_pct: 90, amber_pct: 75 }, '2026-09-30');
  const [c] = r.cycles;
  assert.equal(c.extra, 1);
  assert.equal(c.filled, 0, 'a Saturday log fills no working day');
  assert.equal(c.hours, 4, 'the hours still count towards the total');
  const sat = c.days.find((d) => d.date === '2026-09-26');
  assert.equal(sat.state, 'extra');
});

test('a holiday is not a working day, so missing it is not a miss', () => {
  const opts = { cycle_start_day: 21, green_pct: 90, amber_pct: 75 };
  const logs = ['2026-09-21', '2026-09-22', '2026-09-24', '2026-09-25'].map((d) => ({ log_date: d, hours: 8 }));
  const without = compliance(logs, opts, '2026-09-25');
  assert.equal(without.cycles[0].pct, 80, '23 Sep missing out of five working days');
  const withHol = compliance(logs, { ...opts, holidays: ['2026-09-23'] }, '2026-09-25');
  assert.equal(withHol.cycles[0].work, 4);
  assert.equal(withHol.cycles[0].pct, 100);
  assert.equal(withHol.cycles[0].rating, 'Green');
});

test('days after the as-of date are not counted missing', () => {
  const r = compliance([{ log_date: '2026-09-21', hours: 8 }],
    { cycle_start_day: 21, green_pct: 90, amber_pct: 75 }, '2026-09-21');
  const [c] = r.cycles;
  assert.equal(c.work, 1, 'only the 21st has happened');
  assert.equal(c.pct, 100);
  assert.equal(c.days.filter((d) => d.state === 'future').length > 0, true);
});

test('the thresholds decide the colour, and the boundary is inclusive', () => {
  const at = (filled, work, green, amber) => {
    // Build `filled` logged weekdays out of `work` working days.
    const days = [];
    const d = new Date(2026, 8, 21);
    while (days.length < work) {
      if (d.getDay() !== 0 && d.getDay() !== 6) days.push(key(new Date(d)));
      d.setDate(d.getDate() + 1);
    }
    return compliance(days.slice(0, filled).map((x) => ({ log_date: x, hours: 8 })),
      { cycle_start_day: 21, green_pct: green, amber_pct: amber }, days[work - 1]).cycles[0];
  };
  assert.equal(at(9, 10, 90, 75).rating, 'Green', '90% with a 90 threshold is Green');
  assert.equal(at(8, 10, 90, 75).rating, 'Amber');
  assert.equal(at(7, 10, 90, 75).rating, 'Red', '70% is below the 75 Amber bar');
});

test('no logs at all is "no data", not 0% Red', () => {
  const r = compliance([], { cycle_start_day: 21 }, '2026-09-25');
  assert.equal(r.cycles.length, 0);
  assert.equal(r.total.no_data, true);
});

test('the local-date key does not shift the day across a timezone', () => {
  assert.equal(key(new Date(2026, 8, 18)), '2026-09-18');
  // ...and, the case that matters, IN THE CLIENT'S OWN TIMEZONE. This
  // runner is UTC, where toISOString() happens to agree with the local
  // date, so a UTC-only assertion cannot see the bug at all: at IST a
  // date built at local midnight is 18:30 UTC the PREVIOUS day, and
  // toISOString() would file every log one day early. Run it in a child
  // process with TZ set, because TZ is read once at startup.
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    const { key, compliance } = require('${require('node:path').resolve(__dirname, '../modules/performance/timesheet-rules.js')}');
    // 21 Sep 2026 is a Monday. Under a UTC-based key it reads as Sunday
    // the 20th, which is a weekend, so the day silently stops counting.
    const c = compliance([{ log_date: '2026-09-21', hours: 8 }],
      { cycle_start_day: 21, green_pct: 90, amber_pct: 75 }, '2026-09-21').cycles[0];
    process.stdout.write(JSON.stringify({ k: key(new Date(2026, 8, 18)), work: c.work, filled: c.filled }));
  `], { env: { ...process.env, TZ: 'Asia/Kolkata' } }).toString();
  assert.deepEqual(JSON.parse(out), { k: '2026-09-18', work: 1, filled: 1 });
});

// 16 Oct, from the client's QA (Def-018, Def-019).
test('an empty Log owner is reported even when Owner Mail Id is filled (Def-018)', () => {
  const p = parseTimesheetSheet(sheet(row(), row({ 'Log owner': '' })));
  assert.equal(p.entries.length, 1);
  assert.match(p.errors[0].error, /Log owner is empty/);
});

test('hours with only an item type, a sprint or a project is a log line, reported (Def-018)', () => {
  const only = (col) => {
    const r = new Array(HEADER.length).fill('');
    r[HEADER.indexOf('Log Hours(for calculation)')] = '4';
    r[HEADER.indexOf(col)] = 'Sprint 7';
    return r;
  };
  const p = parseTimesheetSheet(sheet(row(), only('Sprint'), only('Item Type')));
  assert.equal(p.entries.length, 1);
  assert.equal(p.errors.length, 2);
  assert.match(p.errors[0].error, /no Log Date/);
});

test('dates typed by hand: two-digit years, month first, day-first numbers; ambiguous ones refused with the fix (Def-019)', () => {
  assert.equal(key(parseDate('18/Sep/26')), '2026-09-18');
  assert.equal(key(parseDate('Sep 5, 2026')), '2026-09-05');
  assert.equal(key(parseDate('September 18 2026')), '2026-09-18');
  assert.equal(key(parseDate('25/09/2026')), '2026-09-25', 'only one reading is possible');
  assert.equal(key(parseDate('05/05/2026')), '2026-05-05');
  assert.equal(parseDate('05/09/2026'), null, '5 Sep or 9 May: never guessed');
  assert.equal(parseDate('31/09/2026'), null);
  assert.match(dateProblem('05/09/2026'), /ambiguous — it could be 5 Sep or 9 May\. Write it as 05\/Sep\/2026/);
  assert.match(dateProblem('rubbish'), /not a date — write it as 18\/Sep\/2026/);
  const p = parseTimesheetSheet(sheet(row({ 'Log Date': '05/09/2026' })));
  assert.match(p.errors[0].error, /ambiguous/);
});

// 22 Oct: Log Title carries the KRA the log counts towards.
test('Log Title is read; a Zoho export leaves it empty and loads as before', () => {
  const p = parseTimesheetSheet(sheet(
    row({ 'Log Title': '  Client Delivery ' }),
    row({ 'Log Date': '19/Sep/2026' })));
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.entries.map((x) => x.log_title), ['Client Delivery', '']);
});

test('a row with only a Log Title is reported, not skipped as blank', () => {
  const blank = new Array(HEADER.length).fill('');
  blank[HEADER.indexOf('Log Title')] = 'Client Delivery';
  const p = parseTimesheetSheet(sheet(row(), blank));
  assert.equal(p.entries.length, 1);
  assert.deepEqual(p.errors.map((x) => x.line), [9]);
  assert.match(p.errors[0].error, /no Log Date/);
});
