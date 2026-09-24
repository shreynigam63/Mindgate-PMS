// node --test — the rules behind the suggested Career Pathing Matrix.
//
// Asked for on 24 Sep: "please find template of career pathing matrix
// and fill the same as per department and designation, also create
// downloadable excel sheet for upload."
//
// career-ladder.js is pure on purpose, so the ordering rules can be
// tested directly — which is where every bug in this kind of code
// lives. Each assertion below is a mistake the first draft actually
// made against the real 90-designation master, not a hypothetical.
//
// No database: nothing here touches one.
const { test } = require('node:test');
const assert = require('node:assert');
const { suggestTransitions, rankOf, familyOf } = require('../modules/people/career-ladder');

const find = (rows, dept, from) => rows.find((r) => r.department === dept && r.from_role === from);

test('seniority is read from the title, most specific pattern first', () => {
  // "Senior Manager" is a manager rung, not the senior form of some
  // "Manager", and "Senior Technical Lead" is a lead. A generic /^senior/
  // placed any earlier swallows both.
  const lvl = (d) => rankOf(d).level;
  assert.ok(lvl('Senior Manager') > lvl('Manager'), 'Senior Manager outranks Manager');
  assert.ok(lvl('Manager') > lvl('Senior Software Developer'), 'a manager outranks a senior IC');
  assert.equal(lvl('Senior Technical Lead'), lvl('Lead'), 'a senior lead is still a lead');
  assert.ok(lvl('Assistant Vice President') < lvl('Deputy Vice President'));
  assert.ok(lvl('Deputy Vice President') < lvl('Vice President I'));
  assert.ok(lvl('Vice President I') < lvl('Vice President II'));
  assert.ok(lvl('Vice President II') < lvl('Senior Vice President I'));
  assert.ok(lvl('Assistant Manager') < lvl('Manager'), 'assistant manager is below manager');
  assert.equal(lvl('Trainee Tester'), lvl('Trainee'));
  assert.ok(lvl('Trainee') < lvl('Software Tester'));
});

test('a job family survives its seniority prefix, and never empties out', () => {
  assert.equal(familyOf('Senior Software Developer'), familyOf('Software Developer'));
  assert.equal(familyOf('Sr. Oracle DBA'), familyOf('Oracle DBA'));
  // A bare seniority word strips to NOTHING, and an empty family
  // matches every other family — so that one row would make every
  // job look like the same ladder. "Senior " with a trailing space is
  // not hypothetical: HRMS exports are full of trailing whitespace.
  assert.ok(familyOf('Senior '), 'a bare seniority word keeps a family');
  assert.ok(familyOf('Trainee  '), 'even with trailing whitespace');
  for (const d of ['Trainee', 'Intern', 'Senior ', 'Sr. ']) {
    assert.ok(familyOf(d), `${JSON.stringify(d)} must not have an empty family`);
  }
});

test('the next rung is the senior form of the same job where one exists', () => {
  const rows = suggestTransitions([
    { department: 'Development', designation: 'Software Developer', headcount: 180 },
    { department: 'Development', designation: 'Senior Software Developer', headcount: 227 },
    { department: 'Development', designation: 'Lead', headcount: 57 },
    { department: 'Tester', designation: 'Software Tester', headcount: 20 },
    { department: 'Tester', designation: 'Senior Software Tester', headcount: 68 },
  ]);
  assert.equal(find(rows, '', 'Software Developer').to_role, 'Senior Software Developer');
  assert.equal(find(rows, '', 'Software Tester').to_role, 'Senior Software Tester');
  assert.equal(find(rows, '', 'Senior Software Developer').to_role, 'Lead');
});

test('with no senior form, the rung is the generic ladder — not the biggest team', () => {
  // THE BUG THIS EXISTS FOR. The first cut fell back to "lowest rung
  // above, biggest headcount wins", and because Senior Software
  // Developer is the biggest role in this company the company-wide
  // sheet said a Customer Service Representative's next step was
  // Senior Software Developer. Eleven rows read like that.
  const rows = suggestTransitions([
    { department: 'Development', designation: 'Senior Software Developer', headcount: 227 },
    { department: 'Functional', designation: 'Customer Service Representative', headcount: 1 },
    { department: 'HR', designation: 'Senior Executive', headcount: 7 },
    { department: 'HR', designation: 'Executive', headcount: 3 },
  ]);
  const r = find(rows, '', 'Customer Service Representative');
  assert.equal(r.to_role, 'Senior Executive', 'the generic rung, not the commonest role');
  assert.match(r.notes, /PLEASE CHECK/, 'and it says so, because it is a guess');
  // A role that DOES have a senior form is not flagged.
  assert.ok(!/PLEASE CHECK/.test(find(rows, '', 'Executive').notes));
});

test('a related title only wins from the very next rung up', () => {
  // "Assistant Vice President" matched "Vice President" (two rungs up)
  // and skipped Deputy Vice President sitting directly above it.
  const rows = suggestTransitions([
    { department: 'Sales', designation: 'Assistant Vice President', headcount: 5 },
    { department: 'Sales', designation: 'Vice President', headcount: 3 },
    { department: 'Development', designation: 'Deputy Vice President', headcount: 2 },
    { department: 'Development', designation: 'Assistant Vice President', headcount: 5 },
  ]);
  assert.equal(find(rows, '', 'Assistant Vice President').to_role, 'Deputy Vice President');
  // But from the very next rung it does win: a Trainee Tester becomes a
  // Software Tester, not the generic Executive.
  const t = suggestTransitions([
    { department: 'Tester', designation: 'Trainee Tester', headcount: 3 },
    { department: 'Tester', designation: 'Software Tester', headcount: 20 },
    { department: 'HR', designation: 'Executive', headcount: 3 },
  ]);
  assert.equal(find(t, '', 'Trainee Tester').to_role, 'Software Tester');
});

test('a department rung only appears where it differs from the company-wide one', () => {
  const rows = suggestTransitions([
    { department: 'Development', designation: 'Software Developer', headcount: 180 },
    { department: 'Development', designation: 'Senior Software Developer', headcount: 227 },
    { department: 'Development', designation: 'Lead', headcount: 57 },
    { department: 'Sales', designation: 'Software Developer', headcount: 1 },
    { department: 'Sales', designation: 'Senior Software Developer', headcount: 1 },
    { department: 'Sales', designation: 'Manager', headcount: 2 },
  ]);
  // Both departments imply the same first move, so it is stated once,
  // company-wide. A sheet that repeated it per department would be
  // unreadable at 34 departments.
  assert.equal(rows.filter((r) => r.from_role === 'Software Developer').length, 1);
  assert.equal(find(rows, '', 'Software Developer').department, '');
  // Sales has no Lead, so its senior developers go straight to Manager
  // while everyone else goes to Lead. THAT is a department-only rung.
  assert.equal(find(rows, '', 'Senior Software Developer').to_role, 'Lead');
  const sales = find(rows, 'Sales', 'Senior Software Developer');
  assert.ok(sales, 'a department whose ladder differs gets its own row');
  assert.equal(sales.to_role, 'Manager');
});

test('nothing is proposed that nobody holds, and a one-role department gets nothing', () => {
  const master = [
    { department: 'Development', designation: 'Software Developer', headcount: 180 },
    { department: 'Development', designation: 'Senior Software Developer', headcount: 227 },
    { department: 'TBS', designation: 'Consultant - TBS', headcount: 3 },
  ];
  const held = new Set(master.map((m) => m.designation));
  const rows = suggestTransitions(master);
  for (const r of rows) {
    assert.ok(held.has(r.to_role), `${r.to_role} is a real designation on the master`);
    assert.ok(held.has(r.from_role), `${r.from_role} is a real designation on the master`);
  }
  assert.equal(rows.filter((r) => r.department === 'TBS').length, 0,
    'a department with one title has no ladder to suggest');
});

test('every suggested row is a complete, uploadable row', () => {
  const rows = suggestTransitions([
    { department: 'HR', designation: 'Executive', headcount: 3 },
    { department: 'HR', designation: 'Senior Executive', headcount: 7 },
    { department: 'HR', designation: 'Manager', headcount: 7 },
    { department: 'HR', designation: 'Senior Manager', headcount: 2 },
  ]);
  assert.ok(rows.length);
  for (const r of rows) {
    assert.ok(r.from_role && r.to_role, 'the importer requires both roles');
    assert.notEqual(r.from_role, r.to_role, 'a rung never points at itself');
    assert.ok(Number.isInteger(r.expected_level_change) && r.expected_level_change > 0,
      'a transition is always a step up');
    assert.ok(r.min_time_months > 0 && r.typical_time_months >= r.min_time_months,
      'typical time is never less than the minimum');
    assert.ok(Array.isArray(r.required_competencies) && r.required_competencies.length,
      'competencies are worded as the competency master words them');
    assert.ok(r.notes, 'every row says where it came from');
  }
});

// ---- the round trip -------------------------------------------------------
//
// The whole point of the suggested matrix is that it goes straight back
// in through the importer HR already uses. A sheet this code writes that
// its own validator then rejects would be worse than no sheet at all —
// so the two are tested against each other rather than separately.
const ExcelJS = require('exceljs');
const { validateCareerTransitionRows } = require('../modules/people/career-transitions-import');
const { transitionsWorkbook, SUGGESTED_BANNER, TRANSITION_HEADERS } = require('../modules/people');
const { parseExcelSheets } = require('../core/employees');

const MASTER = [
  { department: 'Development', designation: 'Software Developer', headcount: 180 },
  { department: 'Development', designation: 'Senior Software Developer', headcount: 227 },
  { department: 'Development', designation: 'Lead', headcount: 57 },
  { department: 'Development', designation: 'Manager', headcount: 15 },
  { department: 'Development', designation: 'Senior Manager', headcount: 6 },
  { department: 'Tester', designation: 'Trainee Tester', headcount: 3 },
  { department: 'Tester', designation: 'Software Tester', headcount: 20 },
  { department: 'Tester', designation: 'Senior Software Tester', headcount: 68 },
  { department: 'Sales', designation: 'Assistant Vice President', headcount: 5 },
  { department: 'Sales', designation: 'Vice President', headcount: 3 },
  // The specialised title with no senior form — the flagged case.
  { department: 'Support', designation: 'Customer Service Representative', headcount: 1 },
  { department: 'Support', designation: 'Senior Executive', headcount: 4 },
];

const sheetRows = (t) => [
  t.department, t.from_role, t.from_level, t.to_role, t.to_level,
  t.expected_level_change, t.min_time_months, t.typical_time_months,
  (t.required_competencies || []).join('\n'), t.notes,
];

test('the suggested workbook is accepted by the importer that has to read it', async () => {
  const suggested = suggestTransitions(MASTER);
  assert.ok(suggested.length > 5, 'there is something to check');
  const buf = await transitionsWorkbook(SUGGESTED_BANNER, suggested.map(sheetRows));

  // Read it back exactly as the upload route does — including the
  // banner row, which the parser has to skip on its own.
  const parsed = (await parseExcelSheets(buf)).flatMap((sh) => sh.rows || []);
  const report = validateCareerTransitionRows(parsed);
  assert.deepEqual(report.errors, [], `the importer rejected its own sheet: ${JSON.stringify(report.errors)}`);
  assert.equal(report.rows.length, suggested.length, 'every row survives the round trip');

  // And the values actually arrive, not just the row count.
  const back = report.rows.find((r) => r.from_role === 'Software Developer');
  assert.ok(back, 'the developer rung came back');
  assert.equal(back.to_role, 'Senior Software Developer');
  // A blank Department cell comes back as NULL, not "" — that is the
  // importer's own "applies to every department" marker, and the
  // column in people.career_transitions is nullable for exactly this.
  assert.equal(back.department, null, 'a blank department means every department');
  assert.ok(back.required_competencies.includes('Problem solving'),
    `competencies split back out of the cell — got ${JSON.stringify(back.required_competencies)}`);
});

test('the sheet carries the importer\'s own headers, in its own order', async () => {
  const buf = await transitionsWorkbook(SUGGESTED_BANNER, suggestTransitions(MASTER).map(sheetRows));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Career Transitions');
  // Row 1 is the banner, row 2 the headers — the same shape as the
  // blank template, because it goes through the same door.
  assert.match(String(ws.getRow(1).getCell(1).value), /^SUGGESTED career pathing matrix/);
  const header = [];
  ws.getRow(2).eachCell((c) => header.push(String(c.value)));
  assert.deepEqual(header, TRANSITION_HEADERS);
});
