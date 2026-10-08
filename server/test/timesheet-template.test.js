// node --test — the timesheet upload template (asked for on 8 Oct).
//
// The template is only worth having if a sheet filled in from it goes
// through the SAME parser as a Zoho export and comes out right. So these
// build the template, fill it the ways people actually fill a sheet, read
// it back through the real Excel reader and the real parser, and check
// what lands. No database needed.
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { buildTimesheetTemplate, EXPORT_HEADERS, BANDS, FIRST_DATA_ROW } = require('../modules/performance/timesheet-template');
const { parseTimesheetSheet, COLUMNS, HEADER_MARKERS } = require('../modules/performance/timesheet-rules');
const { parseExcelSheets } = require('../core/employees');

const norm = (h) => String(h == null ? '' : h).toLowerCase().replace(/[^a-z0-9]+/g, '');
const roundTrip = async (wb) => {
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(buf);           // what Excel would hand back after a save
  return parseExcelSheets(Buffer.from(await reread.xlsx.writeBuffer()));
};

test('the template has the export\'s layout: 5 metadata rows, the 3 group bands, then the header on row 7', async () => {
  const wb = buildTimesheetTemplate({ name: 'Asha Rao', email: 'asha@x.com' });
  const ws = wb.getWorksheet('Main');
  assert.ok(ws, 'the sheet is called Main, like the export');
  assert.deepEqual([1, 2, 3, 4, 5].map((r) => ws.getCell(`A${r}`).value),
    ['Team Name', 'Project Name', 'Exported By', 'Date', 'Filter']);
  assert.equal(ws.getCell('B3').value, 'Asha Rao');
  for (const b of BANDS) assert.equal(ws.getCell(`${b.from}6`).value, b.label);
  assert.equal(ws.getRow(7).values.slice(1).length, 52);
  assert.deepEqual(ws.getRow(7).values.slice(1), EXPORT_HEADERS);
  assert.equal(FIRST_DATA_ROW, 8);
});

test('every column the parser reads is in the header — and "Created On" resolves to the Timesheet band\'s', () => {
  const header = EXPORT_HEADERS.map(norm);
  for (const m of HEADER_MARKERS) assert.ok(header.includes(m), `marker ${m}`);
  for (const [field, wanted] of Object.entries(COLUMNS)) {
    assert.ok(header.includes(wanted), `${field} (${wanted}) is missing from the template`);
  }
  // indexOf takes the first; it must be column M, inside the Timesheet band I:S.
  assert.equal(header.indexOf('createdon'), 12);
  assert.equal(header.indexOf('logowner'), 13);
  assert.equal(header.indexOf('logdate'), 14);
});

test('an empty template parses cleanly, finds its header on row 7, and loads nothing', async () => {
  const sheets = await roundTrip(buildTimesheetTemplate({ name: 'Asha Rao', email: 'asha@x.com' }));
  const main = sheets.find((s) => s.name === 'Main');
  const p = parseTimesheetSheet(main.rows, { rowNumbers: main.rowNumbers });
  assert.equal(p.fatal, undefined);
  assert.equal(p.headerRow ? main.rowNumbers[p.headerRow - 1] : null, 7);
  assert.equal(p.entries.length, 0, 'no example row that could be uploaded by mistake');
  // The instructions sheet must never read as a timesheet.
  const help = sheets.find((s) => s.name === 'How to fill this in');
  assert.ok(parseTimesheetSheet(help.rows).fatal, 'the help sheet carries no Log Date + Log owner header row');
});

test('a filled template loads: a real date, a typed date, decimal hours, and hh:mm kept as text', async () => {
  const wb = buildTimesheetTemplate({ name: 'Asha Rao', email: 'asha@x.com' });
  const ws = wb.getWorksheet('Main');
  // Row 8: what Excel stores when someone types a date into the date column.
  ws.getCell('N8').value = 'Asha Rao';
  ws.getCell('O8').value = new Date(Date.UTC(2026, 8, 18));
  ws.getCell('G8').value = 7.5;
  ws.getCell('F8').value = '07:30';
  ws.getCell('AX8').value = 'asha@x.com';
  ws.getCell('B8').value = 'Refund API';
  ws.getCell('R8').value = 'Built the refund endpoint';
  // Row 9: a typed export-style date as text, and only hh:mm hours.
  ws.getCell('N9').value = 'Asha Rao';
  ws.getCell('O9').value = '19/Sep/2026';
  ws.getCell('F9').value = '08:00';
  ws.getCell('AX9').value = 'asha@x.com';
  const sheets = await roundTrip(wb);
  const main = sheets.find((s) => s.name === 'Main');
  const p = parseTimesheetSheet(main.rows, { rowNumbers: main.rowNumbers });
  assert.deepEqual(p.errors, []);
  assert.equal(p.entries.length, 2);
  const [a, b] = p.entries;
  assert.equal(a.log_date, '2026-09-18'); assert.equal(a.hours, 7.5); assert.equal(a.owner_email, 'asha@x.com');
  assert.equal(a.item_name, 'Refund API'); assert.equal(a.description, 'Built the refund endpoint');
  assert.equal(a.line, 8, 'errors and reports name the row a person sees');
  assert.equal(b.log_date, '2026-09-19'); assert.equal(b.hours, 8);
  assert.equal(ws.getCell('F8').numFmt, '@', 'Log Hours is text, so Excel cannot turn 07:30 into a time');
});

// The review on 8 Oct filled the template the ways real spreadsheets get
// filled — LibreOffice typing, pasting from another sheet, formulas — and
// found each of these loading a wrong number or nothing. Each is pinned.
test('what spreadsheets do to typed cells cannot load a wrong number', async () => {
  const wb = buildTimesheetTemplate({ name: 'Asha Rao', email: 'asha@x.com' });
  const ws = wb.getWorksheet('Main');
  // G and F are text for the whole column — row 2,000 too, not only the
  // first thousand rows — so a typed 7:30 stays "7:30".
  for (const c of ['F', 'G', 'M', 'V']) assert.equal(ws.getColumn(c).numFmt, '@', `column ${c} is text`);
  assert.equal(ws.getColumn('O').numFmt, 'dd/mmm/yyyy');
  assert.equal(ws.getCell('G2000').numFmt, '@');
  const owner = (r) => { ws.getCell(`N${r}`).value = 'Asha Rao'; ws.getCell(`AX${r}`).value = 'asha@x.com'; };
  // 8: "7:30" typed into G (text) — seven and a half hours.
  owner(8); ws.getCell('O8').value = '18/Sep/2026'; ws.getCell('G8').value = '7:30';
  // 9: a time-formatted cell pasted into G — what LibreOffice keeps from a
  // paste-with-formats. Once loaded as 1899 hours.
  owner(9); ws.getCell('O9').value = '19/Sep/2026';
  ws.getCell('G9').value = new Date(Date.UTC(1899, 11, 30, 7, 30)); ws.getCell('G9').numFmt = 'h:mm';
  // 10: Log Date as a formula, =O9+1. Once read as "Sun Sep 20 2026 …".
  owner(10); ws.getCell('G10').value = '8';
  ws.getCell('O10').value = { formula: 'O9+1', result: new Date(Date.UTC(2026, 8, 20)) };
  // 11: the owner as rich text (part bold). Once read as "[object Object]".
  ws.getCell('N11').value = { richText: [{ text: 'Asha ', font: { bold: true } }, { text: 'Rao' }] };
  ws.getCell('AX11').value = 'asha@x.com'; ws.getCell('O11').value = '21/Sep/2026'; ws.getCell('G11').value = '6';
  // 12: a second log on the same day, owner and date left off. Once dropped silently.
  ws.getCell('G12').value = '1.5'; ws.getCell('B12').value = 'Code review';
  // 13: a day that does not exist. Once loaded as 1 Oct.
  owner(13); ws.getCell('O13').value = '31/Sep/2026'; ws.getCell('G13').value = '8';
  const main = (await roundTrip(wb)).find((s) => s.name === 'Main');
  const p = parseTimesheetSheet(main.rows, { rowNumbers: main.rowNumbers });
  assert.deepEqual(p.entries.map((e) => [e.line, e.log_date, e.hours, e.owner_name]), [
    [8, '2026-09-18', 7.5, 'Asha Rao'],
    [9, '2026-09-19', 7.5, 'Asha Rao'],
    [10, '2026-09-20', 8, 'Asha Rao'],
    [11, '2026-09-21', 6, 'Asha Rao'],
  ]);
  assert.deepEqual(p.errors.map((e) => e.line), [12, 13]);
  assert.match(p.errors[0].error, /no Log Date/);
  assert.match(p.errors[1].error, /31\/Sep\/2026" is not a date/);
});

test('the Date stamp is local wall-clock text, like the export\'s', () => {
  const ws = buildTimesheetTemplate({ today: new Date(Date.UTC(2026, 9, 7, 20, 30, 5)) }).getWorksheet('Main');
  // 20:30 UTC is already 8 Oct in India; a Date cell written as UTC showed 7 Oct.
  const tz = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  if (tz === 'Asia/Kolkata') assert.equal(ws.getCell('B4').value, '2026-10-08 02:00:05');
  assert.match(ws.getCell('B4').value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
