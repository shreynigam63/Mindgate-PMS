// node --test — the KRA library: a shelf of suggested KRAs per designation
// that employees pick from (migration 033).
//
// The library reuses the assignment importer's parser rather than carrying
// a second copy of it, so the first job of this file is proving the reuse
// is real: the same awkward sheet shapes those files are full of — a merged
// banner on row 1, forward-filled Parameters, multi-tab workbooks — must
// work here too, because they come out of the same spreadsheets.
//
// The second job is proving the two importers differ where they should.
// An assignment must total 100 because it IS somebody's scorecard. A shelf
// must NOT be forced to, because it is a menu people pick from. Getting
// that backwards would make the feature pointless, and it is the kind of
// mistake a test written after the fact would happily bless.
//
// Pure — builds real .xlsx buffers and drives the parser directly, so it
// needs no database and no HTTP server.
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-klib';
process.env.TENANT_SLUG = process.env.TENANT_SLUG || 'klib-test';
const { validateKraBulkRows } = require('../modules/performance');
const { parseExcelSheets } = require('../core/employees');

const BANNER = 'Please see Guideline Sheet for reference ( Apr 2025 - Mar2026)';
const SSE = 'Senior Software Engineer';
const known = new Set([SSE.toLowerCase(), 'delivery manager']);
const LIB = { keyField: 'designation' };

function librarySheet(wb, name, rows, header = 'Suggested Weightage') {
  const ws = wb.addWorksheet(name);
  ws.addRow([BANNER, BANNER, BANNER, BANNER, BANNER]);
  ws.addRow(['Designation', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)',
    'KPIs \n(Measuring Metrics & Data Source)', header, 'Comments']);
  for (const r of rows) ws.addRow(r);
  return ws;
}

async function bufOf(build) {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('reads a designation-keyed sheet with the same banner/forward-fill shape as the assignment template', async () => {
  const buf = await bufOf((wb) => librarySheet(wb, 'SSE', [
    [SSE, 'Financial', 'Delivery within allocated project budget', 'Variance against approved budget', 20, ''],
    [SSE, '', 'Reduce cloud spend per environment', 'Monthly run-rate vs. baseline', 10, ''],
    ['', '', '', '', '', ''],
    [SSE, 'Customer', 'On-time milestone delivery', '100% of milestones met', 25, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.length, 3);
  // Forward-fill: rows 1 and 2 share the Financial heading written once.
  assert.deepEqual(r.rows.map((x) => x.category), ['Financial', 'Financial', 'Customer']);
  assert.deepEqual(r.rows.map((x) => x.designation), [SSE, SSE, SSE]);
  assert.equal(r.summary.key_field, 'designation');
  assert.equal(r.summary.designations, 1);
});

test('A SHELF DOES NOT HAVE TO TOTAL 100 — that is the point of a library', async () => {
  // 105 across seven KRAs. As an assignment this is a hard error; as a
  // shelf it is the normal, healthy case, because the employee picks a
  // hundred points' worth out of it.
  const buf = await bufOf((wb) => librarySheet(wb, 'SSE', [
    [SSE, 'Financial', 'Budget adherence', 'Variance', 20, ''],
    [SSE, 'Financial', 'Cloud spend', 'Run-rate', 10, ''],
    [SSE, 'Customer', 'On-time delivery', 'Milestones', 25, ''],
    [SSE, 'Process', 'Code review turnaround', 'Median < 24h', 20, ''],
    [SSE, 'Process', 'Incident response', 'MTTR', 10, ''],
    [SSE, 'People', 'Mentoring', 'Two sessions a quarter', 15, ''],
    [SSE, 'People', 'Hiring panels', 'Interviews per quarter', 5, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.length, 7);
  assert.equal(r.errors.length, 0, 'an over-full shelf must not be an error');
  // It is still SAID, so HR can see the shelf totals 105 on purpose.
  const totalNote = r.warnings.find((w) => /totalling 105/.test(w.warning));
  assert.ok(totalNote, `expected the total to be reported: ${JSON.stringify(r.warnings)}`);
});

test('the same file keyed by employee_email still enforces 100 — the two importers diverge here', async () => {
  // Identical rows, read as an assignment. This is the control: if this
  // ever stops failing, the library's leniency has leaked into the
  // importer that must not have it.
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('by email');
    ws.addRow([BANNER, BANNER, BANNER, BANNER, BANNER]);
    ws.addRow(['employee_email', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)',
      'KPIs \n(Measuring Metrics & Data Source)', 'Weightage', 'Comments']);
    ws.addRow(['a@example.com', 'Financial', 'Budget adherence', 'Variance', 20, '']);
    ws.addRow(['a@example.com', 'Customer', 'On-time delivery', 'Milestones', 25, '']);
  });
  const r = validateKraBulkRows(await parseExcelSheets(buf), new Set(['a@example.com']), new Map());
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /must total 100 \(currently 45\)/.test(e.error)),
    `expected the 100 rule to still bite: ${JSON.stringify(r.errors)}`);
});

test('a designation nobody holds is a warning, not a rejection — HR builds shelves ahead of hiring', async () => {
  const buf = await bufOf((wb) => librarySheet(wb, 'new role', [
    ['Principal Architect', 'Process', 'Architecture governance', 'Reviews completed', 40, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, 'an unheld designation must not block the upload');
  assert.ok(r.warnings.some((w) => /no active employee currently holds the designation "Principal Architect"/.test(w.warning)),
    `expected the unheld designation to be called out: ${JSON.stringify(r.warnings)}`);
});

test('designations are matched case- and space-insensitively, but stored as HR typed them', async () => {
  const buf = await bufOf((wb) => librarySheet(wb, 'casing', [
    ['  senior SOFTWARE engineer ', 'Financial', 'Budget adherence', 'Variance', 20, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  // No "nobody holds this" warning: it matched the known set despite the
  // casing and the stray spaces.
  assert.equal(r.warnings.filter((w) => /no active employee/.test(w.warning)).length, 0);
  // The grouping key is normalised...
  assert.equal(r.rows[0].key, 'senior software engineer');
  // ...but the label kept for display is the trimmed original spelling,
  // because HR should see back what they wrote.
  assert.equal(r.rows[0].designation, 'senior SOFTWARE engineer');
});

test('a blank Designation carries down from the row above, the way Parameters does', async () => {
  const buf = await bufOf((wb) => librarySheet(wb, 'gap', [
    [SSE, 'Financial', 'Budget adherence', 'Variance', 20, ''],
    ['', 'Customer', 'Orphan KRA', 'Nothing', 15, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  // The parser forward-fills a blank KEY the same way it forward-fills a
  // blank title, which is right for these sheets — a designation written
  // once above a block of its KRAs. So the orphan inherits SSE rather
  // than erroring, and BOTH rows land on that shelf.
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows.map((x) => x.key), ['senior software engineer', 'senior software engineer']);
});

test('missing the Designation column is a clear fatal, not "no KRA table found"', async () => {
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('no key');
    ws.addRow(['Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Suggested Weightage']);
    ws.addRow(['Financial', 'Budget adherence', 'Variance', 20]);
  });
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, false);
  assert.match(r.fatal, /designation/i);
});

test('one workbook, one tab per role — every sheet is read', async () => {
  const buf = await bufOf((wb) => {
    librarySheet(wb, 'SSE', [[SSE, 'Financial', 'Budget adherence', 'Variance', 20, '']]);
    librarySheet(wb, 'DM', [['Delivery Manager', 'Customer', 'Client satisfaction', 'CSAT', 30, '']]);
  });
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.length, 2);
  assert.equal(r.summary.designations, 2);
  assert.deepEqual([...new Set(r.rows.map((x) => x.designation))].sort(), ['Delivery Manager', SSE]);
});

test('"Role" and "Job Title" are accepted as the designation column, but a bare "Title" is NOT', async () => {
  // Accepting a bare "Title" would silently file every KRA under a
  // designation named after the KRA itself, because in these sheets that
  // word means the KRA's own title far more often than the job title.
  const asRole = await bufOf((wb) => {
    const ws = wb.addWorksheet('role');
    ws.addRow(['Role', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Suggested Weightage']);
    ws.addRow([SSE, 'Financial', 'Budget adherence', 'Variance', 20]);
  });
  assert.equal(validateKraBulkRows(await parseExcelSheets(asRole), known, null, LIB).ok, true);

  const asTitle = await bufOf((wb) => {
    const ws = wb.addWorksheet('title');
    ws.addRow(['Title', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Suggested Weightage']);
    ws.addRow([SSE, 'Financial', 'Budget adherence', 'Variance', 20]);
  });
  const r = validateKraBulkRows(await parseExcelSheets(asTitle), known, null, LIB);
  assert.equal(r.ok, false, 'a bare "Title" column must not be read as the designation');
  assert.match(r.fatal, /designation/i);
});

test('an unknown key field is rejected loudly rather than reported as a missing column', async () => {
  // The failure mode this prevents: a typo in our own call surfacing as
  // "missing required column: designatoin" against a valid file, sending
  // HR to hunt a problem in their spreadsheet that is really in our code.
  const buf = await bufOf((wb) => librarySheet(wb, 'x', [[SSE, 'Financial', 'A', 'B', 20, '']]));
  const sheets = await parseExcelSheets(buf);
  assert.throws(() => validateKraBulkRows(sheets, known, null, { keyField: 'designatoin' }),
    /unknown KRA key field/);
});

test('"Designations" in the plural is accepted — one letter must not reject a perfect file', async () => {
  // The client edited our own library template, naturally wrote the column
  // heading as a plural because it heads a list of them, and got back
  // "missing required column(s): designation" against a file with 2,145
  // valid KRAs in it.
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('KRA Library');
    ws.addRow([BANNER, BANNER, BANNER, BANNER, BANNER]);
    ws.addRow(['Designations', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Weightage']);
    ws.addRow([SSE, 'Financial', 'Budget adherence', 'Variance', 20]);
  });
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, JSON.stringify(r.errors || r.fatal));
  assert.equal(r.rows[0].designation, SSE);
});

test('a designation-keyed file on the EMPLOYEE-keyed screen is told which screen it belongs on', async () => {
  // The wrong-screen case, which is what actually happened: a good file in
  // the wrong place. "missing required column(s): employee_email" is true
  // and useless — it sends HR hunting for a column the file was never
  // supposed to have.
  const buf = await bufOf((wb) => librarySheet(wb, 'KRA Library', [
    [SSE, 'Financial', 'Budget adherence', 'Variance', 20, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), new Set(['a@example.com']), new Map());
  assert.equal(r.ok, false);
  assert.equal(r.wrong_screen, 'designation');
  assert.match(r.fatal, /keyed on Designation, but this screen expects Employee Email/);
  assert.match(r.fatal, /KRA Library/);
});

test('and the reverse: an employee-keyed file on the LIBRARY screen is pointed at KRA Overview', async () => {
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('by email');
    ws.addRow(['employee_email', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Weightage']);
    ws.addRow(['a@example.com', 'Financial', 'Budget adherence', 'Variance', 100]);
  });
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, false);
  assert.equal(r.wrong_screen, 'employee_email');
  assert.match(r.fatal, /KRA Overview/);
});

test('a file missing BOTH key columns still gets the plain missing-column message', async () => {
  // The wrong-screen hint must not swallow the ordinary case of a genuinely
  // malformed file — there is no other screen to send that one to.
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('no key');
    ws.addRow(['Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Weightage']);
    ws.addRow(['Financial', 'Budget adherence', 'Variance', 20]);
  });
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, false);
  assert.equal(r.wrong_screen, undefined);
  assert.match(r.fatal, /missing required column\(s\): designation/);
});

test('THE PARAMETER CARRY STOPS AT A DESIGNATION BOUNDARY — it must not leak into the next role', async () => {
  // Found in the client's own 2,145-row library. 14 designations came from
  // source workbooks with no Parameters column at all, so every one of their
  // KRAs inherited the LAST parameter of whichever role happened to sit above
  // them in the sheet — 235 KRAs silently filed under "People" because that
  // is how the previous block ended. No error, no warning; the KRAs just
  // arrived grouped under a heading nobody had chosen.
  const buf = await bufOf((wb) => librarySheet(wb, 'two roles', [
    ['Delivery Manager', 'Financial', 'Budget adherence', 'Variance', 20, ''],
    ['', 'People', 'Mentoring', 'Two sessions a quarter', 30, ''],
    // A new designation whose own Parameters cell is empty. The row above
    // says "People"; that belongs to the Delivery Manager block and must
    // stop there.
    ['Business Head', '', 'Project profitability', 'Margin vs plan', 50, ''],
    ['', '', 'Security compliance', 'Zero open criticals', 50, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, JSON.stringify(r.errors || r.fatal));

  const dm = r.rows.filter((x) => x.designation === 'Delivery Manager');
  const bh = r.rows.filter((x) => x.designation === 'Business Head');
  assert.deepEqual(dm.map((x) => x.category), ['Financial', 'People'],
    'the carry must still work WITHIN a block');
  assert.deepEqual(bh.map((x) => x.category), [null, null],
    'a role with no Parameters of its own gets none — not the previous role\'s');
});

test('a parameter written on the same row as a new designation still applies to that block', async () => {
  // The boundary reset must not throw away a parameter the new block DOES
  // declare on its own first row — that would be the opposite bug.
  const buf = await bufOf((wb) => librarySheet(wb, 'declared', [
    ['Delivery Manager', 'People', 'Mentoring', 'Two a quarter', 100, ''],
    ['Business Head', 'Financial', 'Project profitability', 'Margin vs plan', 60, ''],
    ['', '', 'Revenue growth', 'YoY', 40, ''],
  ]));
  const r = validateKraBulkRows(await parseExcelSheets(buf), known, null, LIB);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.rows.filter((x) => x.designation === 'Business Head').map((x) => x.category),
    ['Financial', 'Financial'], 'declared on the boundary row, then carried down its own block');
});

test('the same boundary rule holds for the employee-keyed importer', async () => {
  // employee_email is not forward-filled, but the category carry still has to
  // stop when the person changes — one employee's Parameter must never end up
  // on another employee's scorecard.
  const buf = await bufOf((wb) => {
    const ws = wb.addWorksheet('by email');
    ws.addRow(['employee_email', 'Parameters', 'KRA \n(S.M.A.R.T GOALS)', 'KPIs', 'Weightage']);
    ws.addRow(['a@example.com', 'People', 'Mentoring', 'Two a quarter', 100]);
    ws.addRow(['b@example.com', '', 'Budget adherence', 'Variance', 100]);
  });
  const emails = new Set(['a@example.com', 'b@example.com']);
  const r = validateKraBulkRows(await parseExcelSheets(buf), emails, new Map());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.find((x) => x.employee_email === 'a@example.com').category, 'People');
  assert.equal(r.rows.find((x) => x.employee_email === 'b@example.com').category, null,
    'b declared no Parameter, so b gets none — not a\'s');
});
