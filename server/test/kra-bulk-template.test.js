// node --test — the bulk KRA importer reads the client's own goal sheet.
//
// The sheets actually in use are not "a header row and then data". Row 1
// is a merged guidance banner repeated across every cell; the column names
// are on row 2; the Parameters column is written once per group and left
// blank down the rest of it; blank rows separate the groups; one workbook
// spells the column "Weightage" and another "Weigthtage"; and a single
// workbook carries a dozen tabs, one per role. Every one of those broke
// the previous importer, which assumed row 1 was the header and read only
// the first worksheet.
//
// Pure — builds real .xlsx buffers with ExcelJS and drives the parser
// directly, so it needs no database and no HTTP server.
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kbt';
process.env.TENANT_SLUG = process.env.TENANT_SLUG || 'kbt-test';
const { validateKraBulkRows, normKraHeader } = require('../modules/performance');
const { parseExcelSheets } = require('../core/employees');

const BANNER = 'Please see Guideline Sheet for reference ( Apr 2025 - Mar2026)';
const EMAIL = 'kbt@example.com';
const knownEmails = new Set([EMAIL]);
const empByEmail = new Map([[EMAIL, { name: 'KBT Person', designation: 'Engineer' }]]);

// Reproduces the real layout: banner row, header on row 2, forward-filled
// Parameters, blank separator rows.
function clientSheet(wb, name, weightHeader, rows) {
  const ws = wb.addWorksheet(name);
  ws.addRow([BANNER, BANNER, BANNER, BANNER, BANNER]);
  ws.addRow(['employee_email', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)',
    'KPIs \n(Measuring Metrics & Data Source)', weightHeader, 'Comments']);
  for (const r of rows) ws.addRow(r);
  return ws;
}

async function bufOf(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('reads a real-shaped sheet: banner row 1, header row 2, forward-filled Parameters, blank separators', async () => {
  const buf = await bufOf((wb) => clientSheet(wb, 'L2 DB Support', 'Weightage', [
    [EMAIL, 'Financial', 'TD, BD analysis beyond Threshold', '100% of cases analysed', 40, 'Dependency on dev team'],
    [EMAIL, '', 'Incident analysis', '100% SLA adherence on RCA', 20, ''],
    ['', '', '', '', '', ''], // the blank separator these sheets use between groups
    [EMAIL, 'Project / Process', 'Issue Analysis', '100% of client cases closed end to end', 40, ''],
  ]));
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.equal(report.fatal, null);
  assert.deepEqual(report.errors, [], JSON.stringify(report.errors));
  assert.equal(report.ok, true);
  assert.equal(report.rows.length, 3, 'the blank separator row must not become a KRA');

  // Forward fill: row 2 of the group inherits "Financial" rather than null.
  assert.deepEqual(report.rows.map((r) => r.category),
    ['Financial', 'Financial', 'Project / Process']);
  assert.deepEqual(report.rows.map((r) => r.kra_title),
    ['TD, BD analysis beyond Threshold', 'Incident analysis', 'Issue Analysis']);
  // The client headers map onto our fields: KPIs -> measures, Comments -> description.
  assert.equal(report.rows[0].measures, '100% of cases analysed');
  assert.equal(report.rows[0].description, 'Dependency on dev team');
  // Spreadsheet row numbers, so an error points at the row HR sees on screen.
  assert.deepEqual(report.rows.map((r) => r.line), [3, 4, 6]);
  assert.equal(report.rows[0].sheet, 'L2 DB Support');
});

test('accepts the "Weigthtage" spelling that ships in one of the real workbooks', async () => {
  const buf = await bufOf((wb) => clientSheet(wb, 'PM KRA', 'Weigthtage', [
    [EMAIL, 'Financial', 'On-Time Project Delivery', 'Delivered within agreed timelines', 100, ''],
  ]));
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);
  assert.equal(report.fatal, null, report.fatal);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows[0].weight, 100);
});

test('reads every worksheet, not just the first — these workbooks carry one tab per role', async () => {
  const other = 'kbt2@example.com';
  const buf = await bufOf((wb) => {
    clientSheet(wb, 'L1 Recon', 'Weightage', [
      [EMAIL, 'Financial', 'Timely file processing', '100% SLA adherence', 100, ''],
    ]);
    clientSheet(wb, 'KRA Technical Manager', 'Weigthtage', [
      [other, 'Financial', 'Cost of Quality', 'Reduce rework hours by 15%', 60, ''],
      [other, 'Project / Process', 'Code Review Compliance', '100% peer review coverage', 40, ''],
    ]);
  });
  const report = validateKraBulkRows(await parseExcelSheets(buf),
    new Set([EMAIL, other]),
    new Map([[EMAIL, { name: 'A' }], [other, { name: 'B' }]]));

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 3);
  assert.equal(report.summary.employees, 2);
  assert.deepEqual([...new Set(report.rows.map((r) => r.sheet))],
    ['L1 Recon', 'KRA Technical Manager']);
});

test('a reference tab with no KRA header is skipped with a warning, not a rejection', async () => {
  const buf = await bufOf((wb) => {
    const g = wb.addWorksheet('Guidelines');
    g.addRow(['Rating scale']); g.addRow(['5', 'Outstanding']);
    clientSheet(wb, 'L1 Support', 'Weightage', [
      [EMAIL, 'Financial', 'Incident analysis', '100% SLA adherence', 100, ''],
    ]);
  });
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 1);
  assert.match(report.warnings.map((w) => w.warning).join(' '), /Guidelines/);
  assert.equal(report.summary.sheets_skipped, 1);
});

test('a sheet missing employee_email is named in the error, and the other sheets still import', async () => {
  const wb = new ExcelJS.Workbook();
  clientSheet(wb, 'Good', 'Weightage', [
    [EMAIL, 'Financial', 'Incident analysis', '100% SLA adherence', 100, ''],
  ]);
  // Same layout but without the employee_email column — the raw client sheet
  // as it arrives, before HR adds the column.
  const bad = wb.addWorksheet('Raw');
  bad.addRow([BANNER, BANNER, BANNER, BANNER]);
  bad.addRow(['Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs \n(Measuring Metrics & Data Source)', 'Weightage']);
  bad.addRow(['Financial', 'Some KRA', 'Some KPI', 100]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);
  assert.equal(report.fatal, null, 'one bad tab must not fail the whole upload');
  assert.equal(report.ok, false);
  assert.equal(report.rows.length, 1, 'the good sheet is still parsed');
  assert.match(report.errors.map((e) => e.error).join(' '), /"Raw".*employee_email/);
});

test('a file with no KRA table anywhere fails up front, naming what was expected', async () => {
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('Notes');
    ws.addRow(['just', 'some', 'notes']);
  });
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);
  assert.equal(report.ok, false);
  assert.match(report.fatal, /No KRA table found/);
});

test('the previous flat CSV header still imports', async () => {
  const rows = [
    ['employee_email', 'kra_title', 'weight', 'description', 'measures'],
    [EMAIL, 'Improve response time', '100', 'Own first-response SLA', 'Helpdesk average'],
  ];
  const report = validateKraBulkRows(rows, knownEmails, empByEmail); // bare-array back-compat
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows[0].kra_title, 'Improve response time');
  assert.equal(report.rows[0].measures, 'Helpdesk average');
  assert.equal(report.rows[0].category, null);
});

test('weights still have to total 100 per employee, across tabs', async () => {
  const buf = await bufOf((wb) => {
    clientSheet(wb, '1. L1 Support KRA', 'Weightage', [
      [EMAIL, 'Financial', 'Incident analysis', 'SLA adherence', 60, ''],
    ]);
    clientSheet(wb, '2. L1 Monitoring KRA', 'Weightage', [
      [EMAIL, 'Project / Process', 'Daily performance report', 'Bankwise daily report', 30, ''],
    ]);
  });
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);
  assert.equal(report.ok, false);
  assert.match(report.errors.map((e) => e.error).join(' '), /must total 100 \(currently 90\)/);

  // ...and the same person split across two tabs adding to 100 is valid,
  // which is why the check groups by employee and not by sheet.
  const good = await bufOf((wb) => {
    clientSheet(wb, '1. L1 Support KRA', 'Weightage', [
      [EMAIL, 'Financial', 'Incident analysis', 'SLA adherence', 60, ''],
    ]);
    clientSheet(wb, '2. L1 Monitoring KRA', 'Weightage', [
      [EMAIL, 'Project / Process', 'Daily performance report', 'Bankwise daily report', 40, ''],
    ]);
  });
  const ok = validateKraBulkRows(await parseExcelSheets(good), knownEmails, empByEmail);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
});

test('extra columns in the PM workbook are reported, not silently dropped', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('PM KRA');
  ws.addRow([BANNER]);
  ws.addRow(['employee_email', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)',
    'KPIs \n(Measuring Metrics & Data Source)', 'Weigthtage', 'Comments',
    'Minutes', 'Feedback', 'Frequency of evaluation']);
  ws.addRow([EMAIL, 'Financial', 'On-Time Project Delivery', 'Within agreed timelines', 100, '', 'x', 'y', 'Quarterly']);
  const report = validateKraBulkRows(await parseExcelSheets(Buffer.from(await wb.xlsx.writeBuffer())), knownEmails, empByEmail);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const w = report.warnings.map((x) => x.warning).join(' ');
  assert.match(w, /Minutes/);
  assert.match(w, /Feedback/);
  assert.match(w, /Frequency of evaluation/);
});

test('normKraHeader strips the parenthetical guidance the client headers carry', () => {
  assert.equal(normKraHeader('KRA \n(S.M.A.R.T GOALS)'), 'kra');
  assert.equal(normKraHeader('KPIs \n(Measuring Metrics & Data Source)'), 'kpis');
  assert.equal(normKraHeader('Weigthtage'), 'weigthtage');
  assert.equal(normKraHeader('Customer '), 'customer');
  assert.equal(normKraHeader('Weight (%)'), 'weight');
});

// ---------------------------------------------------------------------------
// Merged cells. These are not an exotic case in the real sheets — reading
// them literally made a 100-point workbook total 305, because ExcelJS
// reports a merge master's value on every cell of the merge.
// ---------------------------------------------------------------------------

// Builds a sheet and applies merges by A1 range, so the fixtures read the
// way the range list in the real file does.
async function mergedSheet(name, rows, merges) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  ws.addRow([BANNER]);
  ws.addRow(['employee_email', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)',
    'KPIs \n(Measuring Metrics & Data Source)', 'Weightage']);
  for (const r of rows) ws.addRow(r);
  for (const m of merges) ws.mergeCells(m);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('merge shape 1 — one KRA whose title and weight span several KPI rows', async () => {
  // Rows 3-5: one KRA worth 40 with three measures, exactly the layout of
  // "Internal Process Adherence & Improvement" in the PM sheet.
  const buf = await mergedSheet('PM KRA', [
    [EMAIL, 'Project / Process', 'Internal Process Adherence', 'Adheres to internal process', 40],
    [EMAIL, '', '', 'Monitors timesheet submission', ''],
    [EMAIL, '', '', 'Runs the weekly review call', ''],
    [EMAIL, 'People', 'Training and team Upskill', 'TNI suggestions for the team', 60],
  ], ['C3:C5', 'E3:E5', 'B3:B5']);
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 2, 'three merged rows are one KRA, not three');
  assert.equal(report.rows[0].weight, 40, 'the merged weight is counted once, not three times');
  assert.deepEqual(report.rows[0].measures.split('\n'),
    ['Adheres to internal process', 'Monitors timesheet submission', 'Runs the weekly review call']);
  assert.equal(report.rows.reduce((a, r) => a + r.weight, 0), 100);
});

test('merge shape 2 — one weight shared by two distinct KRAs is split, and said so', async () => {
  const buf = await mergedSheet('PM KRA', [
    [EMAIL, 'Customer', 'Stakeholder Management', 'Builds strong relationships', 15],
    [EMAIL, '', 'External Customer Satisfaction', 'Maintains customer relationships', ''],
    [EMAIL, 'People', 'Team Upskill', 'TNI suggestions', 85],
  ], ['E3:E4']);
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 3, 'distinct titles stay distinct KRAs');
  assert.deepEqual(report.rows.map((r) => r.weight), [7.5, 7.5, 85]);
  assert.match(report.warnings.map((w) => w.warning).join(' '),
    /merged across 2 KRAs .* split as 7\.5 \/ 7\.5/);
});

test('a split that does not divide evenly still totals exactly the shared weight', async () => {
  // 10 across 3 is 3.333…; a plain division makes the sheet total 99.99 and
  // the file is then rejected for a rounding error we introduced.
  const buf = await mergedSheet('PM KRA', [
    [EMAIL, 'People', 'Training and team Upskill', 'TNI for the team', 10],
    [EMAIL, '', 'Resource allocation', 'Prioritises by severity', ''],
    [EMAIL, '', 'Team Performance', 'Evaluates team performance', ''],
    [EMAIL, 'Financial', 'Revenue Leakage Prevention', '95% billing accuracy', 90],
  ], ['E3:E5']);
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.deepEqual(report.rows.map((r) => r.weight), [3.34, 3.33, 3.33, 90]);
  assert.equal(report.rows.reduce((a, r) => a + r.weight, 0), 100);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test('merge shape 3 — a blank title with its own weight is its own weighted line', async () => {
  // From the Delivery Manager sheet: rows whose KRA cell is left blank but
  // which carry a real weight of their own. Folding them into the KRA above
  // silently dropped their weight and turned that sheet's 100 into 85.
  const buf = await mergedSheet('KRA of Delivery Manager', [
    [EMAIL, 'People', 'Resource allocation and Optimization', 'Prioritises by severity', 50],
    [EMAIL, '', '', 'Optimises allocation for productivity', 50],
  ], []);
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.equal(report.rows.length, 2);
  assert.equal(report.rows.reduce((a, r) => a + r.weight, 0), 100);
  // The title carries down, the way the category does.
  assert.equal(report.rows[1].kra_title, 'Resource allocation and Optimization');
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.match(report.warnings.map((w) => w.warning).join(' '), /repeats the title on row 3/);
});

test('a KRA with no weight of its own is reported, not handed a slice of the merge above', async () => {
  const buf = await mergedSheet('PM KRA', [
    [EMAIL, 'Financial', 'Budget Adherence', 'Within allocated budget', 100],
    [EMAIL, 'People', 'Team Upskill', 'TNI suggestions', ''],
  ], []);
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);
  assert.equal(report.ok, false);
  assert.match(report.errors.map((e) => e.error).join(' '), /weightage must be a positive number/);
});

test('the total row and the notes below it are reported as what they are', async () => {
  const buf = await mergedSheet('6. Release management', [
    [EMAIL, 'Financial', 'Incident analysis', 'SLA adherence', 100],
    ['', '', '', '', 100],                 // the total row every sheet ends with
    ['', '', '', '', 'Max 8 Key KRAs'],    // a note parked in the weight column
    ['', '', 'FTR', '', ''],               // loose jottings below the total
  ], []);
  const report = validateKraBulkRows(await parseExcelSheets(buf), knownEmails, empByEmail);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 1, 'none of the footer rows become a KRA');
  const w = report.warnings.map((x) => x.warning).join(' | ');
  assert.match(w, /weightage total \(100\)/);
  assert.match(w, /reads "Max 8 Key KRAs"/);
  assert.match(w, /"FTR" sits below the total row/);
});

test('a header split across two rows is read as one header', async () => {
  // The "IM" tab puts "KRA"/"KPIs"/"Weightage" on one row and the
  // parenthetical halves on the next. Reading the second as data produced a
  // KRA whose weightage was the word "Weightage".
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('7. IM ');
  ws.addRow([]);
  ws.addRow(['employee_email', 'Parameters', 'KRA', 'KPIs', 'Weightage']);
  ws.addRow(['', 'Parameters', '(S.M.A.R.T GOALS)', '(Measuring Metrics & Data Source)', 'Weightage']);
  ws.addRow([EMAIL, 'Financial', 'Incident Management', '100% compliance', 100]);
  const report = validateKraBulkRows(
    await parseExcelSheets(Buffer.from(await wb.xlsx.writeBuffer())), knownEmails, empByEmail);

  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].kra_title, 'Incident Management');
});
