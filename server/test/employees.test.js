// node --test — CSV + Excel employee import validation.
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { validateEmployeeCsv, validateEmployeeXlsx, detectFormat, flexDate } = require('../core/employees');

// Builds a real .xlsx buffer in memory so the Excel path is exercised
// end-to-end (parse → validate), not just asserted against mocked rows.
async function buildXlsx(headerRow, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  ws.addRow(headerRow);
  dataRows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

const HEADER = 'emp_code,name,email,department,designation,role_band,manager_email,date_of_joining,status';

test('clean file passes with manager links resolved', () => {
  const csv = [HEADER,
    'E1,CEO Person,ceo@x.com,Leadership,CEO,L1,,01-04-2020,active',
    'E2,Mgr One,mgr@x.com,Delivery,Manager,L3,ceo@x.com,15 Jun 2021,active',
    'E3,Emp One,emp@x.com,Delivery,Engineer,L5,mgr@x.com,2023-01-09,active',
  ].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 3);
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[1].date_of_joining, '2021-06-15');
  assert.equal(r.rows[2].date_of_joining, '2023-01-09');
});

test('duplicate email is an error naming both lines', () => {
  const csv = [HEADER,
    'E1,A,a@x.com,D,,,,,active',
    'E2,B,a@x.com,D,,,,,active'].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].error, /duplicate email "a@x.com" \(first at line 2\)/);
});

test('manager not in file is an error', () => {
  const csv = [HEADER, 'E1,A,a@x.com,D,,,ghost@x.com,,active'].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].error, /manager_email "ghost@x.com" not present/);
});

test('manager chain cycle is detected and named', () => {
  const csv = [HEADER,
    'E1,A,a@x.com,D,,,b@x.com,,active',
    'E2,B,b@x.com,D,,,c@x.com,,active',
    'E3,C,c@x.com,D,,,a@x.com,,active'].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /cycle/.test(e.error)));
});

test('self-manager is an error', () => {
  const csv = [HEADER, 'E1,A,a@x.com,D,,,a@x.com,,active'].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].error, /own manager/);
});

test('unparseable date is a warning, not an error; row still loads', () => {
  const csv = [HEADER, 'E1,A,a@x.com,D,,,,31 Feb 2020,active'].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].date_of_joining, null);
  assert.ok(r.warnings.some(w => /unparseable date/.test(w.warning)));
});

test('missing required column is fatal', () => {
  const r = validateEmployeeCsv('name,department\nA,D');
  assert.equal(r.ok, false);
  assert.match(r.fatal, /email/);
});

test('quoted names with commas survive', () => {
  const csv = [HEADER, 'E1,"Kumar, Anil",a@x.com,D,,,,26th Aug 2024,active'].join('\n');
  const r = validateEmployeeCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].name, 'Kumar, Anil');
  assert.equal(r.rows[0].date_of_joining, '2024-08-26');
});

test('flexDate: ordinals, ISO, swap, rollover rejection', () => {
  assert.equal(flexDate('26th Aug 2026'), '2026-08-26');
  assert.equal(flexDate('2026-08-26'), '2026-08-26');
  assert.equal(flexDate('08/26/2026'), '2026-08-26');
  assert.equal(flexDate('31 Feb 2026'), null);
});

// ---------- Excel (.xlsx) — BR-1.1 bulk upload -----------------------------

test('detectFormat: routes by extension, falls back to mimetype', () => {
  assert.equal(detectFormat({ originalname: 'staff.xlsx' }), 'xlsx');
  assert.equal(detectFormat({ originalname: 'staff.xls' }), 'xls-legacy');
  assert.equal(detectFormat({ originalname: 'staff.csv' }), 'csv');
  assert.equal(detectFormat({ originalname: 'upload', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'xlsx');
  assert.equal(detectFormat({ originalname: 'upload', mimetype: 'application/vnd.ms-excel' }), 'xls-legacy');
});

test('xlsx: clean workbook passes with manager links resolved, same as CSV', async () => {
  const header = ['emp_code','name','email','department','designation','role_band','manager_email','date_of_joining','status'];
  const buf = await buildXlsx(header, [
    ['E1','CEO Person','ceo@x.com','Leadership','CEO','L1','','2020-04-01','active'],
    ['E2','Mgr One','mgr@x.com','Delivery','Manager','L3','ceo@x.com','2021-06-15','active'],
    ['E3','Emp One','emp@x.com','Delivery','Engineer','L5','mgr@x.com','2023-01-09','active'],
  ]);
  const r = await validateEmployeeXlsx(buf);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 3);
  assert.equal(r.errors.length, 0);
  assert.equal(r.rows[1].date_of_joining, '2021-06-15');
});

test('xlsx: duplicate email is an error, identical message to the CSV path', async () => {
  const header = ['emp_code','name','email','department'];
  const buf = await buildXlsx(header, [
    ['E1','A','a@x.com','D'],
    ['E2','B','a@x.com','D'],
  ]);
  const r = await validateEmployeeXlsx(buf);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].error, /duplicate email "a@x.com" \(first at line 2\)/);
});

test('xlsx: manager chain cycle is detected, same as the CSV path', async () => {
  const header = ['name','email','department','manager_email'];
  const buf = await buildXlsx(header, [
    ['A','a@x.com','D','b@x.com'],
    ['B','b@x.com','D','c@x.com'],
    ['C','c@x.com','D','a@x.com'],
  ]);
  const r = await validateEmployeeXlsx(buf);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /cycle/.test(e.error)));
});

test('xlsx: real Excel date cells (not text) parse via flexDate normalisation', async () => {
  const header = ['name','email','date_of_joining'];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employees');
  ws.addRow(header);
  const row = ws.addRow(['A', 'a@x.com', new Date(Date.UTC(2024, 7, 26))]); // native Date cell, not a string
  row.getCell(3).numFmt = 'yyyy-mm-dd';
  const buf = await wb.xlsx.writeBuffer();
  const r = await validateEmployeeXlsx(buf);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].date_of_joining, '2024-08-26');
});

test('xlsx: missing required column is fatal, same as the CSV path', async () => {
  const buf = await buildXlsx(['name','department'], [['A','D']]);
  const r = await validateEmployeeXlsx(buf);
  assert.equal(r.ok, false);
  assert.match(r.fatal, /email/);
});
