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
const { suggestTransitions, rankOf, familyOf, SPINE } = require('../modules/people/career-ladder');

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
  assert.equal(find(rows, 'Development', 'Software Developer').to_role, 'Senior Software Developer');
  assert.equal(find(rows, 'Tester', 'Software Tester').to_role, 'Senior Software Tester');
  assert.equal(find(rows, 'Development', 'Senior Software Developer').to_role, 'Lead');
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
  const r = find(rows, 'Functional', 'Customer Service Representative');
  assert.equal(r.to_role, 'Senior Executive', 'the generic rung, not the commonest role');
  assert.match(r.notes, /PLEASE CHECK/, 'and it says so, because it is a guess');
  // A role that DOES have a senior form, inside its own department, is
  // not flagged.
  assert.ok(!/PLEASE CHECK/.test(find(rows, 'HR', 'Executive').notes));
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
  // Development employs both, so its own ladder places them.
  assert.equal(find(rows, 'Development', 'Assistant Vice President').to_role, 'Deputy Vice President');
  // But from the very next rung it does win: a Trainee Tester becomes a
  // Software Tester, not the generic Executive.
  const t = suggestTransitions([
    { department: 'Tester', designation: 'Trainee Tester', headcount: 3 },
    { department: 'Tester', designation: 'Software Tester', headcount: 20 },
    { department: 'HR', designation: 'Executive', headcount: 3 },
  ]);
  assert.equal(find(t, 'Tester', 'Trainee Tester').to_role, 'Software Tester');
});

test('EVERY row names a department — none is left blank', () => {
  // Reported by Mindgate on 25 Sep against the real download: "career
  // matrix sheet has blank department files". The draft used to lead
  // with a company-wide block (blank Department, which the importer
  // reads as "every department") and only added department rows where a
  // department differed. Correct for the importer, and it produced a
  // sheet whose Department column was mostly empty.
  const rows = suggestTransitions([
    { department: 'Development', designation: 'Software Developer', headcount: 180 },
    { department: 'Development', designation: 'Senior Software Developer', headcount: 227 },
    { department: 'Development', designation: 'Lead', headcount: 57 },
    { department: 'Sales', designation: 'Software Developer', headcount: 1 },
    { department: 'Sales', designation: 'Senior Software Developer', headcount: 1 },
    { department: 'Sales', designation: 'Manager', headcount: 2 },
  ]);
  assert.ok(rows.length, 'there is something to check');
  for (const r of rows) {
    assert.ok(r.department && r.department.trim(), `a blank department came back on ${r.from_role} -> ${r.to_role}`);
  }
  // The same move is now stated once PER DEPARTMENT that implies it,
  // rather than once company-wide — which is what "derived from
  // department and designation as per employees list" asks for.
  const devs = rows.filter((r) => r.from_role === 'Software Developer');
  assert.deepEqual(devs.map((r) => r.department).sort(), ['Development', 'Sales']);
  // ...and both go to Lead, because Lead is the rung above a senior IC.
  // This used to say Sales went to MANAGER, since Sales employs no Lead
  // and the target could only be a title the department already held —
  // which is exactly the multi-rung bug Mindgate reported on 25 Sep.
  // A Sales senior developer's next step is a Lead whether or not Sales
  // has one yet; the note says nobody there holds it.
  assert.equal(find(rows, 'Development', 'Senior Software Developer').to_role, 'Lead');
  const sales = find(rows, 'Sales', 'Senior Software Developer');
  assert.equal(sales.to_role, 'Lead');
  assert.match(sales.notes, /nobody in Sales holds Lead today/);
});

test('a department that employs one title still appears, flagged', () => {
  // The other half of the same change. Dropping single-title
  // departments kept the sheet tidy and meant Customer Support, PMO and
  // RMG were simply absent from a draft that claims to be built from
  // the employee list.
  const rows = suggestTransitions([
    { department: 'Development', designation: 'Executive', headcount: 3 },
    { department: 'Development', designation: 'Senior Executive', headcount: 7 },
    { department: 'Customer Support', designation: 'Executive', headcount: 1 },
  ]);
  const cs = find(rows, 'Customer Support', 'Executive');
  assert.ok(cs, 'the one-title department is in the draft');
  assert.equal(cs.to_role, 'Senior Executive');
  assert.match(cs.notes, /nobody in Customer Support holds Senior Executive today/,
    'and the note says the rung came from the company-wide ladder');
  // ...but it is NOT flagged for review. Executive -> Senior Executive
  // is right; the department simply has not filled that rung yet, and
  // pointing at an unfilled rung is what a career path is for. Flagging
  // it put PLEASE CHECK on 85 of 210 rows against the real master,
  // which buries the nine that are genuinely guesses.
  assert.ok(!/PLEASE CHECK/.test(cs.notes), `not a guess, so not flagged — got ${cs.notes}`);
});

test('nothing is proposed that nobody holds anywhere in the company', () => {
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
  // TBS employs one title and nothing above it exists anywhere on the
  // master either, so there is genuinely no rung to propose — the row
  // is absent because the DATA has no answer, not because the
  // department was skipped for being small.
  assert.equal(rows.filter((r) => r.department === 'TBS').length, 0);
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
    assert.equal(r.expected_level_change, 1,
      'every suggested row is exactly one rung, so the column reads 1');
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
  // The department travels with the row. It used to be blank here,
  // because the suggested sheet led with a company-wide block; since
  // 25 Sep every suggested row names one, so that is what has to
  // survive the trip.
  assert.equal(back.department, 'Development');
  assert.ok(back.required_competencies.includes('Problem solving'),
    `competencies split back out of the cell — got ${JSON.stringify(back.required_competencies)}`);
});

test('a HAND-BLANKED department still means "every department" to the importer', async () => {
  // The suggested sheet no longer produces one, but the importer's
  // blank-department feature is untouched and HR can still blank a cell
  // to make a rung company-wide. Tested directly now that the suggested
  // sheet cannot cover it — otherwise the 25 Sep change would have
  // silently deleted this coverage.
  const buf = await transitionsWorkbook(SUGGESTED_BANNER, [
    ['', 'Executive', null, 'Senior Executive', null, 1, 12, 18, 'Problem solving', 'company-wide by hand'],
  ]);
  const parsed = (await parseExcelSheets(buf)).flatMap((sh) => sh.rows || []);
  const report = validateCareerTransitionRows(parsed);
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].department, null, 'a blank cell arrives as NULL, not ""');
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

// ---- one rung per row, added 25 Sep ---------------------------------
//
// Reported by Mindgate against the download in this repo's history:
//
//   "suggested matrix should only show 1 level of matrix not more than
//    one level ... attached excel shows more than 1 level jump for
//    designations as well, please correct the same"
//
// Twenty-eight of the 210 rows on the sheet they sent back jumped two
// rungs or more. Every case below is a real row off that file.

// The company ladder, in order, as the module publishes it. A row is
// one rung when exactly one of these levels sits between the two — the
// raw difference between rank numbers is NOT the test, because the
// scale has an off-spine level (Architect, Assistant Manager) that
// nobody is promoted through.
const rungsBetween = (from, to) =>
  SPINE.filter((l) => l > rankOf(from).level).length - SPINE.filter((l) => l > rankOf(to).level).length;

test('a department with a hole in its ladder steps one rung, not across the hole', () => {
  // THE BUG. Business Finance employs an Executive and a Senior Manager
  // and nothing in between, and the target could only be a title the
  // department already held — so the draft told an Executive their next
  // step was Senior Manager. Five rungs, on a sheet handed to staff.
  const rows = suggestTransitions([
    { department: 'Business Finance', designation: 'Executive', headcount: 1 },
    { department: 'Business Finance', designation: 'Senior Business Finance Analyst', headcount: 1 },
    { department: 'Business Finance', designation: 'Senior Manager', headcount: 1 },
    { department: 'Business Finance', designation: 'Vice President I', headcount: 1 },
    { department: 'Business Finance', designation: 'Senior Vice President I', headcount: 1 },
    // the rest of the company, so the missing rungs have real titles
    { department: 'Development', designation: 'Senior Executive', headcount: 34 },
    { department: 'Development', designation: 'Lead', headcount: 108 },
    { department: 'Development', designation: 'Manager', headcount: 61 },
    { department: 'Development', designation: 'Assistant Vice President', headcount: 30 },
    { department: 'Development', designation: 'Deputy Vice President', headcount: 4 },
    { department: 'Development', designation: 'Vice President II', headcount: 7 },
  ]);
  const bf = (from) => find(rows, 'Business Finance', from);
  assert.equal(bf('Executive').to_role, 'Senior Executive', 'was Senior Manager, five rungs up');
  assert.equal(bf('Senior Business Finance Analyst').to_role, 'Lead', 'was Senior Manager, four rungs up');
  assert.equal(bf('Senior Manager').to_role, 'Assistant Vice President', 'was Vice President I, three rungs up');
  assert.equal(bf('Vice President I').to_role, 'Vice President II', 'was Senior Vice President I, two rungs up');
});

test('no suggested row jumps more than one rung, on any shape of master', () => {
  const rows = suggestTransitions([
    { department: 'Admin', designation: 'Office Assistant', headcount: 3 },
    { department: 'Admin', designation: 'Senior Executive', headcount: 1 },
    { department: 'Admin', designation: 'Manager', headcount: 1 },
    { department: 'Admin', designation: 'Assistant Vice President', headcount: 1 },
    { department: 'Cyber Security', designation: 'Trainee', headcount: 2 },
    { department: 'Cyber Security', designation: 'Senior Security Analyst', headcount: 11 },
    { department: 'Cyber Security', designation: 'Vice President I', headcount: 1 },
    { department: 'Development', designation: 'Executive', headcount: 30 },
    { department: 'Development', designation: 'Software Developer', headcount: 181 },
    { department: 'Development', designation: 'Senior Software Developer', headcount: 272 },
    { department: 'Development', designation: 'Lead', headcount: 108 },
    { department: 'Development', designation: 'Technical Architect', headcount: 12 },
    { department: 'Development', designation: 'Manager', headcount: 61 },
    { department: 'Development', designation: 'Senior Manager', headcount: 28 },
    { department: 'Development', designation: 'Assistant Vice President', headcount: 30 },
    { department: 'Development', designation: 'Deputy Vice President', headcount: 4 },
    { department: 'Development', designation: 'Vice President I', headcount: 11 },
    { department: 'Development', designation: 'Vice President II', headcount: 7 },
    // Every spine rung is occupied here ON PURPOSE, so rungsBetween can
    // measure against the full ladder with no ambiguity. A master with
    // holes in it is the next test's job.
    { department: 'Development', designation: 'Senior Vice President I', headcount: 1 },
    { department: 'Development', designation: 'Senior Vice President II', headcount: 3 },
    { department: 'Development', designation: 'Business Head', headcount: 1 },
  ]);
  assert.ok(rows.length > 15, 'there is something to check');
  for (const r of rows) {
    assert.equal(rungsBetween(r.from_role, r.to_role), 1,
      `${r.department}: ${r.from_role} -> ${r.to_role} is not one rung`);
    assert.equal(r.expected_level_change, 1,
      `${r.from_role} -> ${r.to_role} reports ${r.expected_level_change} in the Expected Level Change column`);
  }
  // An off-spine title (Architect sits beside the ladder, not on it)
  // steps onto the ladder at the rung above, and that counts as one.
  assert.equal(find(rows, 'Development', 'Technical Architect').to_role, 'Manager');
  // And the top of the ladder proposes nothing at all rather than
  // pointing at itself.
  assert.ok(!find(rows, 'Development', 'Business Head'), 'nothing above a Business Head');
});

test('a rung nobody in the company is on is stepped over, not turned into a dead end', () => {
  // The other half of "one rung". If the target had to be the very next
  // spine rung and no more, a company with no Deputy Vice President
  // would drop every AVP row — the rung above them would be empty and
  // the row would have nowhere to go. A rung with nobody on it anywhere
  // is not a rung in THIS company, so AVP -> Vice President is still
  // one step of its own ladder.
  const rows = suggestTransitions([
    { department: 'Sales', designation: 'Assistant Vice President', headcount: 5 },
    { department: 'Sales', designation: 'Vice President', headcount: 3 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_role, 'Vice President');
  assert.equal(rows[0].expected_level_change, 1);
  // ...but when the company DOES have that rung, it is used.
  const withDvp = suggestTransitions([
    { department: 'Sales', designation: 'Assistant Vice President', headcount: 5 },
    { department: 'Sales', designation: 'Vice President', headcount: 3 },
    { department: 'Finance', designation: 'Deputy Vice President', headcount: 1 },
  ]);
  assert.equal(find(withDvp, 'Sales', 'Assistant Vice President').to_role, 'Deputy Vice President',
    'the rung exists now, so it is not skipped');
});

test('the senior form only wins when it is the rung directly above', () => {
  // "Vice President I" and "Senior Vice President I" are one job family
  // apart, and the senior-form rule handed the sheet a two-rung jump
  // because Vice President II sits between them. The rung is chosen
  // first now; the family rule only gets to NAME it.
  const rows = suggestTransitions([
    { department: 'Finance', designation: 'Vice President I', headcount: 11 },
    { department: 'Finance', designation: 'Vice President II', headcount: 7 },
    { department: 'Finance', designation: 'Senior Vice President I', headcount: 1 },
  ]);
  assert.equal(find(rows, 'Finance', 'Vice President I').to_role, 'Vice President II');
  assert.equal(find(rows, 'Finance', 'Vice President II').to_role, 'Senior Vice President I');
});
