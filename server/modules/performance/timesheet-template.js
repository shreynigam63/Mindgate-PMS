// The timesheet upload template.
//
// Asked for on 8 Oct, on the Self → Timesheet page: "please provide
// download template option as per upload template file which we are
// currently uploading for timesheet." The file people upload is a Zoho
// Sprints timesheet export, so the template IS that export's layout, cell
// for cell where it matters:
//
//   sheet "Main"
//   rows 1–5  Team Name / Project Name / Exported By / Date / Filter
//   row 6     the group bands, merged: Timesheet (I:S), Item (T:AL),
//             Meeting (AM:AT)
//   row 7     the 52 column headings, in the export's order — including
//             the three repeated "Created by" / "Created On" / "Release",
//             because the parser takes the FIRST of each (the Timesheet
//             band's) and a template that reordered them would load the
//             wrong one
//   row 8 on  one row per log
//
// So a template filled in by hand and a Zoho export go through exactly the
// same parser (timesheet-rules.js) with nothing special-cased. The test
// round-trips a filled template through it to keep that true.
//
// The cell formats are deliberate, because spreadsheets convert what people
// type. They are set on the WHOLE column, so row 2,000 behaves like row 8:
//   * Log Hours (F), Log Hours(for calculation) (G) and the two "Created
//     On" columns are TEXT. In a number or General cell a typed "7:30"
//     becomes a fraction of a day (0.3125, shown as 0.31) — the review on
//     8 Oct loaded exactly that from LibreOffice. As text, "7:30" stays
//     "7:30" and the parser reads it as 7.5 hours. The parser itself also
//     refuses anything that is not a number of hours or h:mm, so a pasted
//     time-formatted cell cannot load a wrong number either.
//   * Log Date (O) is a real DATE (dd/mmm/yyyy). Whatever someone types
//     that Excel recognises as a date arrives as one, and a typed
//     "18/Sep/2026" that it does not recognise stays text the parser reads.
//
// No sample data row on Main: an example left in by mistake would load as
// a real log. The example lives on the "How to fill this in" sheet, which
// the upload never reads (it stops at the first sheet with a header).
const ExcelJS = require('exceljs');

// The export's own headings, A → AZ. Not normalised — these are what a
// person sees and what Zoho writes.
const EXPORT_HEADERS = [
  'Item Id', 'Item Name', 'Meeting title', 'Log Title', 'Log Type', 'Log Hours',
  'Log Hours(for calculation)', 'Log hours in seconds',
  // Timesheet band (I:S)
  'Reason for Rejection', 'Created by', 'Updated By', 'Approved by', 'Created On', 'Log owner',
  'Log Date', 'Billing Status', 'Approval Status', 'Description', 'Release',
  // Item band (T:AL)
  'Sprint', 'Created by', 'Created On', 'Completed On', 'Tags', 'Assignee', 'Status', 'Epic',
  'Item Type', 'Priority', 'Start Date', 'End Date', 'Start After', 'Duration',
  'Estimation Points', 'Release', 'Total Workhours', 'Work hours per owner', 'Work hours type',
  // Meeting band (AM:AT)
  'Created by', 'Updated By', 'Created On', 'Sprint Name', 'Meeting Type', 'Location',
  'Remind Before', 'Agenda',
  // Unbanded (AU:AZ)
  'Last Modified', 'Project Id', 'Project Name', 'Owner Mail Id', 'Owner Role', 'Project Group',
];

const BANDS = [
  { label: 'Timesheet', from: 'I', to: 'S' },
  { label: 'Item', from: 'T', to: 'AL' },
  { label: 'Meeting', from: 'AM', to: 'AT' },
];

// What the PMS reads, by column letter. Required ones are marked; the rest
// are read when present. Anything not listed here is carried for fidelity
// with the export and ignored.
const READ = [
  { col: 'N', what: 'Log owner', need: 'required', how: 'Your name exactly as it is in the PMS.', example: 'Your Name' },
  { col: 'O', what: 'Log Date', need: 'required', how: 'The day the work was done. 18/Sep/2026, or any date Excel recognises.', example: '18/Sep/2026' },
  { col: 'G', what: 'Log Hours(for calculation)', need: 'required', how: 'Hours: 8, 7.5 or 7:30 (all mean what they say — 7:30 is seven and a half hours). At most 24 in one log. If this is blank, Log Hours (F) is used.', example: '7.5' },
  { col: 'F', what: 'Log Hours', need: 'optional', how: 'The same hours as hh:mm. Used only when G is blank.', example: '07:30' },
  { col: 'AX', what: 'Owner Mail Id', need: 'recommended', how: 'Your work email. Matches you exactly; without it the name in N has to be unique in the PMS.', example: 'your.name@company.com' },
  { col: 'A', what: 'Item Id', need: 'recommended', how: 'The work item\'s id. Lets your manager map the item to a KRA once for every day you logged it.', example: 'PRJ-101' },
  { col: 'B', what: 'Item Name', need: 'recommended', how: 'What the work item is. Read when matching hours to your KRAs.', example: 'Payment gateway integration' },
  { col: 'R', what: 'Description', need: 'recommended', how: 'What you did that day. Also read when matching hours to your KRAs.', example: 'Built the refund API and its tests' },
  { col: 'AB', what: 'Item Type', need: 'optional', how: 'Story, Task, Bug, Meeting…', example: 'Story' },
  { col: 'E', what: 'Log Type', need: 'optional', how: 'As Zoho writes it, e.g. WorkItem.', example: 'WorkItem' },
  { col: 'T', what: 'Sprint', need: 'optional', how: 'The sprint the item belongs to.', example: 'Q2 Sprint 3' },
  { col: 'AW', what: 'Project Name', need: 'optional', how: 'Falls back to Project Name in row 2 when blank.', example: 'UPI 5.0 Product' },
  { col: 'P', what: 'Billing Status', need: 'optional', how: 'Billable / Non-billable.', example: 'Non-billable' },
  { col: 'Q', what: 'Approval Status', need: 'optional', how: 'Approved / Pending / Rejected.', example: 'Approved' },
  { col: 'L', what: 'Approved by', need: 'optional', how: 'Who approved the log.', example: 'Manager Name' },
  { col: 'M', what: 'Created On', need: 'optional', how: 'When the log was entered (the Timesheet band\'s Created On).', example: '18/Sep/2026 16:19' },
];

// The template's "Date" stamp is written the way the export writes it —
// local wall-clock time, as text — in the zone the rest of the app uses.
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const stamp = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};

const NAVY = 'FF1B3B6F';
const BAND = 'FFDBE3EF';
const NEED = { required: 'FFFDE2C4', recommended: 'FFFFF4D6', optional: 'FFEEF2F8' };
const FIRST_DATA_ROW = 8;

const colNum = (letters) => letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

/**
 * @param {{name?: string, email?: string, today?: Date}} who  the person
 *   downloading — named on the instructions sheet so they know what to
 *   put in Log owner / Owner Mail Id. Never written into a data row.
 * @returns {ExcelJS.Workbook}
 */
function buildTimesheetTemplate(who = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Performance Management System';
  const ws = wb.addWorksheet('Main');

  // Rows 1–5: the export's metadata block, label in A and value in B.
  const meta = [
    ['Team Name', ''],
    ['Project Name', ''],
    ['Exported By', who.name || ''],
    ['Date', stamp(who.today || new Date())],
    ['Filter', 'PMS timesheet template — one row per log, from row 8 down'],
  ];
  meta.forEach(([k, v], i) => {
    const r = ws.getRow(i + 1);
    r.getCell(1).value = k;
    r.getCell(2).value = v;
    r.getCell(1).font = { bold: true, color: { argb: NAVY } };
  });

  // Row 6: the group bands, merged like the export.
  for (const b of BANDS) {
    ws.mergeCells(`${b.from}6:${b.to}6`);
    const c = ws.getCell(`${b.from}6`);
    c.value = b.label;
    c.font = { bold: true, color: { argb: NAVY } };
    c.alignment = { horizontal: 'center' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BAND } };
  }

  // Row 7: the 52 headings. Columns the PMS reads are shaded by need, with
  // a note saying what goes in them — the legend is on the cells it is about.
  const header = ws.getRow(7);
  EXPORT_HEADERS.forEach((h, i) => { header.getCell(i + 1).value = h; });
  header.font = { bold: true };
  header.height = 30;
  header.alignment = { vertical: 'middle', wrapText: true };
  for (const r of READ) {
    const c = ws.getCell(`${r.col}7`);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NEED[r.need] } };
    c.note = `${r.need.toUpperCase()} — ${r.how}`;
  }

  EXPORT_HEADERS.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(12, Math.min(30, h.length + 4)); });
  // The formats that stop the spreadsheet rewriting what people type — see
  // the header of this file. Whole columns; the headings in row 7 are text
  // either way. No data validation on G: a rule there is what let 0.3125
  // through as "between 0 and 24", and as text it would reject 7.5 — the
  // parser's own check, reported per row on upload, is the one that counts.
  ws.getColumn('F').numFmt = '@';            // Log Hours, hh:mm as text
  ws.getColumn('G').numFmt = '@';            // hours for calculation: 8, 7.5 or 7:30
  ws.getColumn('M').numFmt = '@';            // Created On (Timesheet band)
  ws.getColumn('V').numFmt = '@';            // Created On (Item band)
  ws.getColumn('O').numFmt = 'dd/mmm/yyyy';  // Log Date, a real date
  ws.views = [{ state: 'frozen', ySplit: 7, xSplit: 2 }];

  // The instructions. A separate sheet so nothing in it can be read as a log.
  const help = wb.addWorksheet('How to fill this in');
  const line = (vals, style) => { const r = help.addRow(vals); if (style) r.font = style; return r; };
  line(['Timesheet upload template'], { bold: true, size: 14, color: { argb: NAVY } });
  line(['This is the layout of a Zoho Sprints timesheet export. A Zoho export can be uploaded as it comes; use this when you fill the sheet in by hand.']);
  line([]);
  line(['For you'], { bold: true, color: { argb: NAVY } });
  line(['Log owner (column N)', who.name || 'your name as it is in the PMS']);
  line(['Owner Mail Id (column AX)', who.email || 'your work email']);
  line([]);
  line(['How to fill it in'], { bold: true, color: { argb: NAVY } });
  [
    '1. On the Main sheet, write one row per log from row 8 down. Do not move or rename rows 1–7.',
    '2. Fill the three REQUIRED columns (shaded orange) on EVERY row — Log owner, Log Date, Log Hours(for calculation) — a second log on the same day too. A row missing one is reported, not loaded.',
    '3. Fill the RECOMMENDED columns (shaded yellow) too: Owner Mail Id matches you exactly, and Item Name and Description are what your hours are matched to your KRAs on.',
    '4. Every other column can stay empty. It is there because the Zoho export has it.',
    '5. Upload on Self → Timesheet: Check the file first — it shows the rows, dates and total hours it will load — then Upload. Only your own rows are loaded.',
    '6. Uploading again replaces the days the new file covers, and leaves every other day as it was.',
  ].forEach((t) => line([t]));
  line([]);
  const h = line(['Column', 'Heading', 'Need', 'What to put', 'Example'], { bold: true, color: { argb: 'FFFFFFFF' } });
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; });
  for (const r of READ) {
    const row = line([r.col, r.what, r.need, r.how, r.what === 'Log owner' && who.name ? who.name
      : r.what === 'Owner Mail Id' && who.email ? who.email : r.example]);
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NEED[r.need] } };
    row.alignment = { vertical: 'top', wrapText: true };
  }
  help.getColumn(1).width = 26;
  help.getColumn(2).width = 28;
  help.getColumn(3).width = 13;
  help.getColumn(4).width = 70;
  help.getColumn(5).width = 30;
  return wb;
}

module.exports = { buildTimesheetTemplate, EXPORT_HEADERS, BANDS, READ, FIRST_DATA_ROW, colNum };
