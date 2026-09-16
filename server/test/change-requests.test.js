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

test('inside the merged phase, editing follows the sheet, not the cycle', () => {
  // 036 folded growth_planning into kra_open, so there is no phase that
  // opens the growth plan for everybody: the employee's own submission
  // does. A plan already approved stays locked either way.
  assert.equal(devplanEditable('kra_open', 'draft', 'submitted').ok, true);
  assert.equal(devplanEditable('kra_open', 'approved', 'submitted').ok, false, 'approved still locks');
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
  assert.match(g.error, /return it for edits/i);
});

test('calibration is the cut-off — a returned plan does not stay open forever', () => {
  assert.equal(devplanEditable('calibration', 'returned').ok, false);
  assert.equal(devplanEditable('publish', 'returned').ok, false);
  assert.equal(devplanEditable('closed', 'returned').ok, false);
  // Shut is what matters; the message is the generic phase one by then.
  assert.equal(devplanEditable('calibration', 'returned').reason, 'phase');
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

// ---- the merged KRA / growth window -----------------------------------
//
// Requested directly: "once the KRA is submitted to manager, employee can
// use growth plan tab including target achievement for the year and
// aspiring career". The point is to stop HR having to advance — and then
// roll back — the whole cycle to serve one person's timing.
const { growthEditable } = require('../modules/performance/phase-machine');
const growthWindow = (phase, sheetStatus) => growthEditable(phase, { sheetStatus });

test('SUBMITTING YOUR KRAs OPENS YOUR GROWTH PLAN, without HR advancing the cycle', () => {
  assert.equal(growthWindow('kra_open', 'submitted').ok, true);
  assert.equal(growthWindow('kra_open', 'submitted').via, 'kra_submitted');
  // approved implies submitted — a manager deciding must not close it again
  assert.equal(growthWindow('kra_open', 'approved').ok, true);
});

test('before you submit, the growth plan is shut — and says which', () => {
  for (const status of ['draft', 'returned', null]) {
    const w = growthWindow('kra_open', status);
    assert.equal(w.ok, false, `sheet ${status} should not open the growth plan`);
    assert.equal(w.reason, 'kra_not_submitted');
  }
});

test('there is no phase that opens it for everybody any more (036)', () => {
  // growth_planning was the one that did. Folding it away means the
  // submission is the ONLY way in, which is the point of the merge — and
  // the one consequence worth stating plainly: an employee who never
  // submits a KRA sheet never gets a growth plan on that cycle.
  for (const status of ['draft', null]) {
    assert.equal(growthWindow('kra_open', status).ok, false);
  }
  assert.equal(growthWindow('growth_planning', 'submitted').ok, false, 'the phase itself is gone');
});

test('a submitted KRA sheet does not open the growth plan in a LATER phase', () => {
  // kra_submitted is a way to start EARLY, not a permanent key. Past
  // Growth Planning the plan is agreed and locks like anything else.
  const w = growthWindow('mid_year_review', 'submitted');
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'phase');
});

test('the development plan honours the same window, and still refuses a locked plan', () => {
  assert.equal(devplanEditable('kra_open', 'draft', 'submitted').ok, true);
  assert.equal(devplanEditable('kra_open', 'draft', 'submitted').via, 'kra_submitted');
  // shut before submission, and told what to do about it
  const shut = devplanEditable('kra_open', 'draft', 'draft');
  assert.equal(shut.ok, false);
  assert.match(shut.error, /Submit your KRAs/i);
});
