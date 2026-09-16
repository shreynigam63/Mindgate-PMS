// node --test — the three change requests raised on 16 September, each
// pinned by the behaviour that was actually wrong.
//
// 1. A RETURNED development plan is editable whatever phase the cycle has
//    reached. The gate used to be phase-only and ran BEFORE the status was
//    read, so returning the plan — the remedy everywhere else in this
//    product — changed nothing, and a whole-tenant cycle rollback was the
//    only way to fix one person's goal.
// 2. The KRA library importer groups on (department, designation), so a
//    "Manager" shelf for Development and one for Sales can coexist, and a
//    file with no Department column behaves exactly as it did before.
// 3. A development goal records the KRA it serves — the value the AI
//    already produces and the popup already groups by, which used to be
//    discarded the moment the goal was saved.
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-cr';
process.env.TENANT_SLUG = process.env.TENANT_SLUG || 'cr-test';
const { validateKraBulkRows, devplanEditable } = require('../modules/performance');
const { parseExcelSheets } = require('../core/employees');

const LIB = { keyField: 'designation' };
const known = new Set(['manager', 'senior manager']);

async function sheet(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('KRA');
  rows.forEach((r) => ws.addRow(r));
  return parseExcelSheets(Buffer.from(await wb.xlsx.writeBuffer()));
}

// ---- 1. the returned plan ---------------------------------------------

test('Growth Planning still opens editing for everybody, returned or not', () => {
  assert.equal(devplanEditable('growth_planning', 'draft').ok, true);
  assert.equal(devplanEditable('growth_planning', 'approved').ok, true);
});

test('A RETURNED PLAN IS EDITABLE AFTER THE CYCLE MOVES ON — the whole point', () => {
  for (const phase of ['mid_year_review', 'self_appraisal', 'manager_eval', 'hod_eval']) {
    const g = devplanEditable(phase, 'returned');
    assert.equal(g.ok, true, `returned plan should be editable in ${phase}`);
    // via is what keeps the save from resetting the status to draft and
    // stranding the employee mid-fix — the bug found while screenshotting.
    assert.equal(g.via, 'returned');
  }
});

test('a plan that was NOT returned stays locked once the phase moves on', () => {
  for (const status of ['draft', 'submitted', 'approved']) {
    assert.equal(devplanEditable('mid_year_review', status).ok, false);
  }
});

test('an approved plan is told how to get unstuck, not just refused', () => {
  const g = devplanEditable('mid_year_review', 'approved');
  assert.match(g.error, /return the plan/i);
});

test('calibration is the cut-off — a returned plan does not stay open forever', () => {
  assert.equal(devplanEditable('calibration', 'returned').ok, false);
  assert.equal(devplanEditable('publish', 'returned').ok, false);
  assert.equal(devplanEditable('closed', 'returned').ok, false);
  assert.match(devplanEditable('calibration', 'returned').error, /no longer be edited/i);
});

// ---- 2. the department dimension --------------------------------------

test('a library file with NO department column behaves exactly as before', async () => {
  const sheets = await sheet([
    ['Designation', 'Parameters', 'KRA', 'KPIs', 'Suggested Weightage'],
    ['Manager', 'Financial', 'Budget adherence', 'Within approved limits', 40],
    ['', '', 'Cost per delivery', 'Tracked monthly', 60],
  ]);
  const r = validateKraBulkRows(sheets, known, null, LIB);
  assert.equal(r.summary.errors, 0);
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) assert.equal(row.department, null);
});

test('THE DEPARTMENT IS FORWARD-FILLED, like the designation beside it', async () => {
  const sheets = await sheet([
    ['Department', 'Designation', 'Parameters', 'KRA', 'KPIs', 'Suggested Weightage'],
    ['Development', 'Manager', 'Delivery', 'Release predictability', 'Sprints closed on plan', 50],
    ['', '', '', 'Defect escape rate', 'Post-release defects', 50],
  ]);
  const r = validateKraBulkRows(sheets, known, null, LIB);
  assert.equal(r.summary.errors, 0);
  assert.deepEqual(r.rows.map((x) => x.department), ['Development', 'Development']);
});

test('THE DEPARTMENT CARRY STOPS AT A DESIGNATION BOUNDARY', async () => {
  // Without this, one role's department leaks onto the next role's KRAs and
  // publishes a Sales shelf under Development. Same boundary rule that
  // Parameters follows, and it was broken there first.
  const sheets = await sheet([
    ['Department', 'Designation', 'Parameters', 'KRA', 'KPIs', 'Suggested Weightage'],
    ['Development', 'Manager', 'Delivery', 'Release predictability', 'Sprints closed on plan', 100],
    ['', 'Senior Manager', 'Delivery', 'Portfolio health', 'Programmes green', 100],
  ]);
  const r = validateKraBulkRows(sheets, known, null, LIB);
  assert.equal(r.summary.errors, 0);
  const senior = r.rows.find((x) => /senior/i.test(x.designation));
  assert.equal(senior.department, null, 'Senior Manager must NOT inherit Development');
});

test('the same title in two departments produces two separate shelves', async () => {
  const sheets = await sheet([
    ['Department', 'Designation', 'Parameters', 'KRA', 'KPIs', 'Suggested Weightage'],
    ['Development', 'Manager', 'Delivery', 'Release predictability', 'Sprints closed on plan', 100],
    ['Human Resources', 'Manager', 'People', 'Time to hire', 'Offer to join in days', 100],
  ]);
  const r = validateKraBulkRows(sheets, known, null, LIB);
  assert.equal(r.summary.errors, 0);
  const depts = r.rows.map((x) => x.department).sort();
  assert.deepEqual(depts, ['Development', 'Human Resources']);
  // Same normalised key — which is exactly why the commit groups on the
  // pair and not on the key alone.
  assert.equal(new Set(r.rows.map((x) => x.key)).size, 1);
});

test('Department is recognised under the names HR actually writes', async () => {
  for (const header of ['Department', 'Dept', 'Departments', 'Business Unit']) {
    const sheets = await sheet([
      [header, 'Designation', 'Parameters', 'KRA', 'KPIs', 'Suggested Weightage'],
      ['Development', 'Manager', 'Delivery', 'Release predictability', 'Sprints closed', 100],
    ]);
    const r = validateKraBulkRows(sheets, known, null, LIB);
    assert.equal(r.rows[0].department, 'Development', `"${header}" should map to department`);
  }
});
