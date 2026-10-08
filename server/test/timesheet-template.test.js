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
