// The company's own grade ladder, as data.
//
// Asked for on 28 Sep, with the sheet attached ("Grade and Level -
// Designation wise"): "download suggested matrix should suggest grade
// and levels as per 3rd excel sheet attached" and "downloaded sheet
// should suggest only one level growth as per roles and roles to be
// considered as per 3rd excel."
//
// Until now the suggested matrix INFERRED a ladder by reading seniority
// words out of job titles — Senior/Lead/Manager/VP — and the two Level
// columns came out blank because there was no grade to put in them.
// That was the only thing available before this sheet existed. It is
// not what the company runs on.
//
// SO THE LADDER IS NOW A TABLE, not a constant in a module. Mindgate
// will add roles to it — 51 of their 78 live designations are not on
// the sheet at all — and that must not need a release. Same rule as
// every other threshold and label in this product.
//
// FOUR TABLES, because they answer four different questions:
//   grade_ladder      what rungs exist, in what order, in which band
//   grade_roles       what a rung is CALLED in each job family
//   designation_grade which rung a job title on the master sits on
//   department_family which family a department belongs to
//
// The last two are the mapping between the sheet and this company's
// actual master, and they are the ones HR will edit. Seeded here with
// what can be read off the sheet without guessing; a designation the
// sheet does not name gets NO ROW, and the suggested matrix reports it
// rather than inventing a grade for it.

// ---- the sheet, transcribed ------------------------------------------
// [grade, label, band, exp, generic, {family: role}]
const F = ['Technical', 'BA', 'Testing', 'App Support / App Monitoring', 'Corporate Functions'];
const LADDER = [
  ['B8',  '',    'Band 8', '',        'Office Boy',    ['Office Boy', '', '', '', '']],
  ['E1',  'E1',  'Band 7', '0-1 yrs', 'Trainee',       ['Trainee Software Developer', 'Trainee BA', 'Trainee Tester', 'Trainee Analyst', 'Trainee - Function']],
  ['E2',  'E2',  'Band 6', '1-3 yrs', 'Executive',     ['Software Developer', 'BA', 'Software Tester', 'Software Analyst', 'Executive -']],
  ['E3',  'E3',  'Band 6', '3-7 yrs', 'Senior Executive', ['Senior Software Developer', 'Sr. BA', 'Senior Software Tester', 'Senior Software Analyst', 'Sr Executive -']],
  ['E4',  'E4',  'Band 5', '7-10 yrs', 'Lead',         ['Lead - Technical', 'Sr. / Lead BA', 'Test Lead', 'Lead - App Support', 'Asst Mgr -']],
  ['E5',  'E5',  'Band 5', '10-12 yrs', 'Manager',     ['Technical Architect', 'Manager - BA', 'Manager - QA', 'Manager - App Support', 'Manager -']],
  ['E6',  'E6',  'Band 4', '12-15 yrs', 'Senior Manager', ['Solution Architect', 'Sr Manager - BA', 'Sr Manager - QA', 'Sr Manager - App Support', 'Sr Manager -']],
  ['E7',  'E7',  'Band 4', '15+ yrs', 'AVP',           ['AVP', 'AVP', 'AVP', 'AVP', 'AVP']],
  ['E8',  'E8',  'Band 4', '15+ yrs', 'DVP',           ['DVP', 'DVP', 'DVP', 'DVP', 'DVP']],
  ['E9',  'E9',  'Band 3', '18+ yrs', 'VP1',           ['VP1', 'VP1', 'VP1', 'VP1', 'VP1']],
  ['E10', 'E10', 'Band 3', '18+ yrs', 'VP2',           ['VP2', 'VP2', 'VP2', 'VP2', 'VP2']],
  ['E11', 'E11', 'Band 2', '20+ yrs', 'Sr. VP 1',      ['Sr. VP 1', 'Sr. VP 1', 'Sr. VP 1', 'Sr. VP 1', 'Sr. VP 1']],
  ['E12', 'E12', 'Band 2', '20+ yrs', 'Sr. VP 2',      ['Sr. VP 2', 'Sr. VP 2', 'Sr. VP 2', 'Sr. VP 2', 'Sr. VP 2']],
  ['E13', 'E13', 'Band 2', '20+ yrs', 'President/CXO', ['President/CXO', 'President/CXO', 'President/CXO', 'President/CXO', 'President/CXO']],
  ['E14', 'E14', 'Band 1', '',        'CEO',           ['', '', '', '', '']],
  ['UGO', '',    'UGO',    '',        'Founder',       ['', '', '', '', '']],
];

// ---- master designation → rung ---------------------------------------
//
// ONLY what the sheet says, plus the spelt-out form of an abbreviation
// it uses (AVP / Assistant Vice President, VP1 / Vice President I). No
// seniority guessing: "DevOps Engineer" is not here because the sheet
// does not grade it, and a grade nobody agreed to is worse on an
// appraisal sheet than a blank somebody has to fill in.
const DESIGNATIONS = [
  ['Office Boy', 'B8', 'Technical'], ['Office Assistant', 'B8', 'Corporate Functions'],
  ['Trainee', 'E1', null],
  ['Trainee Software Developer', 'E1', 'Technical'], ['Trainee BA', 'E1', 'BA'],
  ['Trainee Tester', 'E1', 'Testing'], ['Trainee Analyst', 'E1', 'App Support / App Monitoring'],
  ['Software Developer', 'E2', 'Technical'], ['BA', 'E2', 'BA'], ['Business Analyst', 'E2', 'BA'],
  ['Software Tester', 'E2', 'Testing'], ['Software Analyst', 'E2', 'App Support / App Monitoring'],
  ['Executive', 'E2', 'Corporate Functions'],
  ['Senior Software Developer', 'E3', 'Technical'], ['Sr. BA', 'E3', 'BA'],
  ['Senior Business Analyst', 'E3', 'BA'], ['Senior Software Tester', 'E3', 'Testing'],
  ['Senior Software Analyst', 'E3', 'App Support / App Monitoring'],
  ['Senior Executive', 'E3', 'Corporate Functions'],
  ['Lead', 'E4', null], ['Lead - Technical', 'E4', 'Technical'], ['Test Lead', 'E4', 'Testing'],
  ['Lead - App Support', 'E4', 'App Support / App Monitoring'], ['Sr. / Lead BA', 'E4', 'BA'],
  ['Manager', 'E5', null], ['Technical Architect', 'E5', 'Technical'],
  ['Manager - BA', 'E5', 'BA'], ['Manager - QA', 'E5', 'Testing'],
  ['Manager - App Support', 'E5', 'App Support / App Monitoring'],
  ['Senior Manager', 'E6', null], ['Solution Architect', 'E6', 'Technical'],
  ['Sr Manager - BA', 'E6', 'BA'], ['Sr Manager - QA', 'E6', 'Testing'],
  ['Sr Manager - App Support', 'E6', 'App Support / App Monitoring'],
  ['AVP', 'E7', null], ['Assistant Vice President', 'E7', null],
  ['DVP', 'E8', null], ['Deputy Vice President', 'E8', null],
  ['VP1', 'E9', null], ['Vice President I', 'E9', null], ['Vice President', 'E9', null],
  ['VP2', 'E10', null], ['Vice President II', 'E10', null],
  ['Sr. VP 1', 'E11', null], ['Senior Vice President I', 'E11', null],
  ['Sr. VP 2', 'E12', null], ['Senior Vice President II', 'E12', null],
  ['President/CXO', 'E13', null], ['CEO', 'E14', null], ['Founder', 'UGO', null],
];

// ---- department → job family -----------------------------------------
//
// Needed because below AVP the rungs are named differently per family:
// an E3 is a Senior Software Developer in Technical and a Senior
// Software Analyst in App Support. A department not listed here has no
// family, and the matrix then falls back to the sheet's own generic
// column — Executive, Senior Executive, Lead, Manager — which is what
// that column is for.
//
// The ambiguous ones are listed with the family they most resemble
// rather than left out, because a wrong family is visible on the sheet
// and a missing one just looks like the feature not working. HR edits
// the row if we read it wrong.
const DEPARTMENTS = [
  ['Development', 'Technical'], ['INFRA', 'Technical'], ['IT', 'Technical'],
  ['Cloud', 'Technical'], ['Cyber Security', 'Technical'], ['DevOps', 'Technical'],
  ['SRE', 'Technical'], ['Core Banking Application', 'Technical'],
  ['Tester', 'Testing'],
  ['Application Support', 'App Support / App Monitoring'],
  ['Monitoring Support', 'App Support / App Monitoring'],
  ['Support', 'App Support / App Monitoring'],
  ['Incident', 'App Support / App Monitoring'],
  ['Production Support', 'App Support / App Monitoring'],
  ['Customer Support', 'App Support / App Monitoring'],
  ['Functional', 'BA'], ['Techno functional', 'BA'],
  ['HR', 'Corporate Functions'], ['Admin', 'Corporate Functions'],
  ['Sales', 'Corporate Functions'], ['Finance & Accounts', 'Corporate Functions'],
  ['Accounts', 'Corporate Functions'], ['Business Finance', 'Corporate Functions'],
  ['Marketing', 'Corporate Functions'], ['Legal & Compliance', 'Corporate Functions'],
  ['Management', 'Corporate Functions'], ['PMO', 'Corporate Functions'],
  ['RMG', 'Corporate Functions'], ['Process Excellence', 'Corporate Functions'],
  ['Implementation', 'Corporate Functions'], ['Recon', 'Corporate Functions'],
  ['Merchant', 'Corporate Functions'], ['TBS', 'Corporate Functions'],
  ['ENBD', 'Corporate Functions'],
];

async function seed(db, tenantId) {
  for (let i = 0; i < LADDER.length; i++) {
    const [grade, label, band, exp, generic, roles] = LADDER[i];
    await db.query(
      `INSERT INTO pms.grade_ladder (tenant_id, grade, grade_label, band, sort_order, exp_range, generic_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, grade) DO NOTHING`,
      [tenantId, grade, label, band, i, exp, generic]);
    for (let f = 0; f < F.length; f++) {
      if (!roles[f]) continue;
      await db.query(
        `INSERT INTO pms.grade_roles (tenant_id, grade, family, role_name)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, grade, family) DO NOTHING`,
        [tenantId, grade, F[f], roles[f]]);
    }
  }
  for (const [designation, grade, family] of DESIGNATIONS) {
    await db.query(
      `INSERT INTO pms.designation_grade (tenant_id, designation, grade, family)
       VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, lower_designation) DO NOTHING`,
      [tenantId, designation, grade, family]);
  }
  for (const [department, family] of DEPARTMENTS) {
    await db.query(
      `INSERT INTO pms.department_family (tenant_id, department, family)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, lower_department) DO NOTHING`,
      [tenantId, department, family]);
  }
}

module.exports.up = async (db) => {
  await db.query(`CREATE TABLE IF NOT EXISTS pms.grade_ladder (
    tenant_id    uuid NOT NULL,
    grade        text NOT NULL,
    grade_label  text NOT NULL DEFAULT '',   -- blank for the two ungraded bands
    band         text,
    sort_order   integer NOT NULL,
    exp_range    text,
    generic_role text,
    PRIMARY KEY (tenant_id, grade)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS pms.grade_roles (
    tenant_id uuid NOT NULL,
    grade     text NOT NULL,
    family    text NOT NULL,
    role_name text NOT NULL,
    PRIMARY KEY (tenant_id, grade, family)
  )`);
  // lower_designation is GENERATED, so "Senior Manager" and "senior
  // manager" cannot both be mapped to different grades — the master
  // carries both casings and two answers for one title is not a
  // mapping. Same for departments.
  await db.query(`CREATE TABLE IF NOT EXISTS pms.designation_grade (
    tenant_id         uuid NOT NULL,
    designation       text NOT NULL,
    lower_designation text GENERATED ALWAYS AS (lower(btrim(designation))) STORED,
    grade             text NOT NULL,
    family            text,
    PRIMARY KEY (tenant_id, lower_designation)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS pms.department_family (
    tenant_id        uuid NOT NULL,
    department       text NOT NULL,
    lower_department text GENERATED ALWAYS AS (lower(btrim(department))) STORED,
    family           text NOT NULL,
    PRIMARY KEY (tenant_id, lower_department)
  )`);

  for (const { id } of (await db.query(`SELECT id FROM core.tenants`)).rows) await seed(db, id);
};

module.exports.seed = seed;
module.exports.LADDER = LADDER;
module.exports.FAMILIES = F;
