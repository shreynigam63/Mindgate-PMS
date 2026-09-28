// node --test — the suggested matrix, read off the company's own grades.
//
// Asked for on 28 Sep with the "Grade and Level - Designation wise"
// sheet attached: "download suggested matrix should suggest grade and
// levels as per 3rd excel sheet" and "downloaded sheet should suggest
// only one level growth as per roles and roles to be considered as per
// 3rd excel."
//
// The old generator inferred a ladder from the words in a job title and
// left both Level columns blank, because there was no grade to put in
// them. These tests are about the difference: the grades are theirs,
// the role names are theirs, and where their sheet is silent the answer
// is a blank with a reason rather than a guess.
const { test, after, before } = require('node:test');
const assert = require('node:assert');
const { suggestFromGrades, roleAt, timeInRung, NO_GRADE } = require('../modules/people/career-ladder');
const { LADDER, FAMILIES } = require('../migrations/060-grade-ladder');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

// The sheet, as the generator sees it.
const rungs = LADDER.map((l, i) => ({
  grade: l[0], grade_label: l[1], band: l[2], sort_order: i, exp_range: l[3], generic_role: l[4],
}));
const roles = new Map();
LADDER.forEach((l) => FAMILIES.forEach((f, k) => { if (l[5][k]) roles.set(`${l[0]}|${f}`, l[5][k]); }));
const ladderWith = (gradeOf, familyOf = []) => ({
  rungs, roles, gradeOf: new Map(gradeOf), familyOf: new Map(familyOf),
});
const one = (out, role) => out.find((r) => r.from_role === role);

test('the Level columns carry the grade and the band — they used to be blank', () => {
  const out = suggestFromGrades(
    [{ department: 'Development', designation: 'Senior Software Developer', headcount: 3 }],
    ladderWith([['senior software developer', { grade: 'E3', family: 'Technical' }]]));
  const r = one(out, 'Senior Software Developer');
  assert.equal(r.from_level, 'E3 · Band 6');
  assert.equal(r.to_level, 'E4 · Band 5');
});

test('the next rung is the next GRADE, and its name comes from the family column', () => {
  // Technical E3 is Senior Software Developer; E4 is Lead - Technical.
  // Not "Lead", which is the sheet's generic column, and not a title
  // guessed from the employee master.
  const out = suggestFromGrades(
    [{ department: 'Development', designation: 'Senior Software Developer', headcount: 3 },
     { department: 'Tester', designation: 'Senior Software Tester', headcount: 2 }],
    ladderWith([['senior software developer', { grade: 'E3', family: 'Technical' }],
                ['senior software tester', { grade: 'E3', family: 'Testing' }]]));
  assert.equal(one(out, 'Senior Software Developer').to_role, 'Lead - Technical');
  assert.equal(one(out, 'Senior Software Tester').to_role, 'Test Lead',
    'the same grade is called something different in each family');
});

test('ONE GRADE UP, never a jump', () => {
  // Every rung on the sheet, walked. The whole of the second request is
  // that no row may skip a grade.
  const grid = LADDER.filter((l) => l[4]).map((l) => ({
    department: 'Development', designation: `role-${l[0]}`, headcount: 1 }));
  const out = suggestFromGrades(grid, ladderWith(
    LADDER.filter((l) => l[4]).map((l) => [`role-${l[0]}`, { grade: l[0], family: 'Technical' }])));
  const order = rungs.map((g) => g.grade);
  for (const r of out) {
    if (!r.to_role) continue;
    const from = r.from_level.split(' · ')[0] || r.from_level;
    const to = r.to_level.split(' · ')[0] || r.to_level;
    const i = rungs.findIndex((g) => (g.grade_label || g.band) === from);
    const j = rungs.findIndex((g) => (g.grade_label || g.band) === to);
    assert.equal(j - i, 1, `${r.from_role}: ${from} → ${to} is ${j - i} rungs, not 1`);
    assert.equal(r.expected_level_change, 1);
  }
  assert.ok(out.length >= 10, `the whole ladder was walked — got ${out.length}`);
  // …and the top of it points nowhere rather than wrapping round.
  assert.ok(!out.some((r) => r.from_level.startsWith('UGO') || r.from_level.startsWith('E14')),
    'nothing above the top rung, so no row for it');
});

test('a Corporate Functions rung keeps its own name, minus the dangling dash', () => {
  // The sheet writes these as "Sr Executive -", "Asst Mgr -" — the role
  // then a dash waiting for the function name. Falling back to the
  // generic column would call a Corporate Functions E4 "Lead", which
  // the sheet plainly does not.
  const out = suggestFromGrades(
    [{ department: 'HR', designation: 'Executive', headcount: 1 },
     { department: 'HR', designation: 'Senior Executive', headcount: 1 }],
    ladderWith([['executive', { grade: 'E2', family: 'Corporate Functions' }],
                ['senior executive', { grade: 'E3', family: 'Corporate Functions' }]]));
  assert.equal(one(out, 'Executive').to_role, 'Senior Executive');
  assert.equal(one(out, 'Senior Executive').to_role, 'Assistant Manager');
  assert.ok(!out.some((r) => /[-–]\s*$/.test(String(r.to_role))), 'no trailing dash reaches the sheet');
});

test('the family comes from the department when the title does not fix one', () => {
  // "Manager" is a Manager in every family, so the sheet cannot say
  // which E6 it becomes. The department answers it.
  const gradeOf = [['manager', { grade: 'E5', family: null }]];
  const tech = suggestFromGrades([{ department: 'Development', designation: 'Manager', headcount: 1 }],
    ladderWith(gradeOf, [['development', 'Technical']]));
  const hr = suggestFromGrades([{ department: 'HR', designation: 'Manager', headcount: 1 }],
    ladderWith(gradeOf, [['hr', 'Corporate Functions']]));
  assert.equal(one(tech, 'Manager').to_role, 'Solution Architect');
  assert.equal(one(hr, 'Manager').to_role, 'Senior Manager');

  // With no family at all it falls to the sheet's generic column, and
  // the note says so rather than leaving HR to wonder.
  const none = suggestFromGrades([{ department: 'Nowhere', designation: 'Manager', headcount: 1 }],
    ladderWith(gradeOf));
  assert.equal(one(none, 'Manager').to_role, 'Senior Manager');
  assert.match(one(none, 'Manager').notes, /no job family for Nowhere/);
});

test('a designation the sheet does not grade gets a blank and a reason, never a guess', () => {
  // THE DECISION THIS PINS. 51 of the 78 designations on the live master
  // are not on the grade sheet — DevOps Engineer, Oracle DBA, Cloud
  // Engineer and so on. Mindgate chose blank-and-flagged over inferring
  // a grade from the title. A guessed grade on an appraisal sheet is
  // worse than a blank somebody has to fill in.
  const out = suggestFromGrades(
    [{ department: 'DevOps', designation: 'DevOps Engineer', headcount: 45 }],
    ladderWith([], [['devops', 'Technical']]));
  const r = one(out, 'DevOps Engineer');
  assert.ok(r, 'the row still appears — a title missing from its own draft is what gets noticed late');
  assert.equal(r.to_role, '');
  assert.equal(r.from_level, '');
  assert.equal(r.to_level, '');
  assert.equal(r.notes, NO_GRADE);
  assert.match(r.notes, /^PLEASE CHECK/);
});

test('EVERY ROLE NAME IS SPELT OUT — no Sr., no AVP, no BA', () => {
  // Asked for on 28 Sep: "all short form of designations should be
  // proper with full name." The sheet is written in grading shorthand;
  // this ends up on an appraisal record, where "Sr. VP 2" is not a job
  // title anybody would put in writing.
  const names = [];
  for (const [, , , , generic, roles] of LADDER) {
    if (generic) names.push(generic);
    for (const r of roles) if (r) names.push(r);
  }
  const SHORT = /\b(Sr\.?|Jr\.?|AVP|DVP|VP1|VP2|BA|QA|Mgr|Asst|Exe|App)\b/;
  for (const n of names) {
    // CXO is the one that stays: unlike AVP it is not the abbreviation
    // of a single title, so writing it out would mean inventing one.
    if (n === 'President / CXO') continue;
    assert.ok(!SHORT.test(n), `"${n}" still carries an abbreviation`);
  }
  assert.ok(names.includes('Assistant Vice President') && names.includes('Deputy Vice President')
    && names.includes('Senior Vice President II') && names.includes('Senior Business Analyst'),
    'and the expansions are the ones asked for');
  // A trailing "-" is the Corporate Functions placeholder, not an
  // abbreviation, and it never reaches the sheet — see roleAt.
  assert.ok(names.some((n) => /[-–]\s*$/.test(n)), 'the placeholders are still in the table');
});

test('the times come from the sheet\'s own experience bands', () => {
  // E2 is 1-3 yrs and E3 is 3-7, so two years in an E2. Invented
  // numbers were what the column held before.
  const e2 = rungs.find((g) => g.grade === 'E2');
  const e3 = rungs.find((g) => g.grade === 'E3');
  const e4 = rungs.find((g) => g.grade === 'E4');
  assert.deepEqual(timeInRung(e2, e3), [24, 36]);
  assert.deepEqual(timeInRung(e3, e4), [48, 72], '3-7 to 7-10 is four years');
  // The top of the ladder is all "15+ yrs" / "20+ yrs" — no width to
  // read, so it falls back rather than reporting zero months.
  const e11 = rungs.find((g) => g.grade === 'E11');
  const e12 = rungs.find((g) => g.grade === 'E12');
  const [min] = timeInRung(e11, e12);
  assert.ok(min > 0, `a rung never takes zero months — got ${min}`);
});

test('roleAt prefers the family, then the generic, and never returns a dash', () => {
  const e4 = rungs.find((g) => g.grade === 'E4');
  const ld = { roles };
  assert.equal(roleAt(ld, e4, 'Technical'), 'Lead - Technical');
  assert.equal(roleAt(ld, e4, 'Corporate Functions'), 'Assistant Manager');
  assert.equal(roleAt(ld, e4, null), 'Lead', 'no family: the generic column');
  assert.equal(roleAt(ld, e4, 'Nonexistent Family'), 'Lead');
});

// ---- the tables, and the download that reads them --------------------
let db;
before(async () => {
  if (!HAS_DB) return;
  process.env.TENANT_SLUG = 'grade-ladder-' + Date.now();
  db = require('../core/db');
  await require('../core/migrate').runMigrations();
});
after(async () => { if (HAS_DB) await db.pool.end(); });

test('the migration seeds the sheet, per tenant', { skip }, async () => {
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    ['gl-' + Date.now()])).rows[0].id;
  await require('../migrations/060-grade-ladder').seed(db, t);

  const rows = (await db.query(
    `SELECT grade, grade_label, band, exp_range, generic_role FROM pms.grade_ladder
      WHERE tenant_id=$1 ORDER BY sort_order`, [t])).rows;
  assert.equal(rows.length, 16, 'every row of the sheet, Band 8 and UGO included');
  assert.deepEqual(rows.map((r) => r.grade).slice(0, 4), ['B8', 'E1', 'E2', 'E3'], 'in the sheet\'s order');
  assert.equal(rows.find((r) => r.grade === 'E3').band, 'Band 6');
  assert.equal(rows.find((r) => r.grade === 'E3').exp_range, '3-7 yrs');

  const e3 = (await db.query(
    `SELECT family, role_name FROM pms.grade_roles WHERE tenant_id=$1 AND grade='E3' ORDER BY family`,
    [t])).rows;
  assert.equal(e3.length, 5, 'all five job families at E3');
  assert.equal(e3.find((r) => r.family === 'Technical').role_name, 'Senior Software Developer');

  // Case does not create a second mapping for one title.
  await db.query(
    `INSERT INTO pms.designation_grade (tenant_id, designation, grade, family)
     VALUES ($1,'SENIOR MANAGER','E7',null) ON CONFLICT (tenant_id, lower_designation) DO NOTHING`, [t]);
  const sm = (await db.query(
    `SELECT grade FROM pms.designation_grade WHERE tenant_id=$1 AND lower_designation='senior manager'`,
    [t])).rows;
  assert.equal(sm.length, 1, 'one title, one grade');
  assert.equal(sm[0].grade, 'E6', 'and the seeded one stands');

  // Re-running is harmless — the boot runs every migration every time.
  await require('../migrations/060-grade-ladder').seed(db, t);
  assert.equal((await db.query(
    `SELECT count(*)::int n FROM pms.grade_ladder WHERE tenant_id=$1`, [t])).rows[0].n, 16);
});

test('re-seeding corrects the sheet but never HR\'s own mapping', { skip }, async () => {
  // The split that makes a name fix deployable. The two transcription
  // tables are ours and a re-deploy must be able to correct them —
  // spelling AVP out in full is exactly that. The two mapping tables
  // are HR's, and a re-deploy must not undo an evening of their work.
  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    ['gl2-' + Date.now()])).rows[0].id;
  const { seed } = require('../migrations/060-grade-ladder');
  await seed(db, t);

  // Somebody's older copy of the sheet, and an edit of HR's.
  await db.query(`UPDATE pms.grade_roles SET role_name='AVP' WHERE tenant_id=$1 AND grade='E7'`, [t]);
  await db.query(`UPDATE pms.grade_ladder SET generic_role='AVP' WHERE tenant_id=$1 AND grade='E7'`, [t]);
  await db.query(`UPDATE pms.designation_grade SET grade='E9' WHERE tenant_id=$1 AND lower_designation='manager'`, [t]);
  await db.query(
    `INSERT INTO pms.designation_grade (tenant_id, designation, grade, family)
     VALUES ($1,'DevOps Engineer','E3','Technical')`, [t]);

  await seed(db, t);

  assert.equal((await db.query(
    `SELECT generic_role FROM pms.grade_ladder WHERE tenant_id=$1 AND grade='E7'`, [t])).rows[0].generic_role,
    'Assistant Vice President', 'the sheet is corrected by the re-run');
  assert.ok((await db.query(
    `SELECT role_name FROM pms.grade_roles WHERE tenant_id=$1 AND grade='E7'`, [t]))
    .rows.every((r) => r.role_name === 'Assistant Vice President'));

  assert.equal((await db.query(
    `SELECT grade FROM pms.designation_grade WHERE tenant_id=$1 AND lower_designation='manager'`, [t])).rows[0].grade,
    'E9', "HR's re-grading of Manager survives");
  assert.equal((await db.query(
    `SELECT grade FROM pms.designation_grade WHERE tenant_id=$1 AND lower_designation='devops engineer'`, [t])).rows[0].grade,
    'E3', 'and the row they added for an ungraded title is still there');
});
