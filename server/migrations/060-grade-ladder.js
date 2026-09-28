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
//
// SPELT OUT IN FULL, asked for on 28 Sep: "all short form of
// designations should be proper with full name. for e.g. Sr./Sr should
// Senior, DVP should be Deputy Vice President, AVP should be Assistant
// Vice President and so on."
//
// The sheet is written in the shorthand people use in a grading
// discussion. This ends up on an appraisal record and in a career
// conversation, where "Sr. VP 2" is not a job title anybody would put
// in writing. So the LADDER below carries the full name, and the
// abbreviation survives only as a lookup key in DESIGNATIONS, because
// the employee master still spells some titles the short way.
//
// One thing is deliberately NOT expanded: CXO. Unlike AVP or DVP it is
// not the abbreviation of a single title — it stands for whichever
// C-level office a person holds — so writing it out would mean
// choosing one, and inventing a title is worse than keeping the
// shorthand the sheet uses.
//
// [grade, label, band, exp, generic, {family: role}]
const F = ['Technical', 'Business Analysis', 'Testing',
           'Application Support / Application Monitoring', 'Corporate Functions'];
const LADDER = [
  ['B8',  '',    'Band 8', '',         'Office Boy',    ['Office Boy', '', '', '', '']],
  ['E1',  'E1',  'Band 7', '0-1 yrs',  'Trainee',       ['Trainee Software Developer', 'Trainee Business Analyst', 'Trainee Tester', 'Trainee Analyst', 'Trainee - Function']],
  ['E2',  'E2',  'Band 6', '1-3 yrs',  'Executive',     ['Software Developer', 'Business Analyst', 'Software Tester', 'Software Analyst', 'Executive -']],
  ['E3',  'E3',  'Band 6', '3-7 yrs',  'Senior Executive', ['Senior Software Developer', 'Senior Business Analyst', 'Senior Software Tester', 'Senior Software Analyst', 'Senior Executive -']],
  ['E4',  'E4',  'Band 5', '7-10 yrs', 'Lead',          ['Lead - Technical', 'Senior / Lead Business Analyst', 'Test Lead', 'Lead - Application Support', 'Assistant Manager -']],
  ['E5',  'E5',  'Band 5', '10-12 yrs', 'Manager',      ['Technical Architect', 'Manager - Business Analyst', 'Manager - Quality Assurance', 'Manager - Application Support', 'Manager -']],
  ['E6',  'E6',  'Band 4', '12-15 yrs', 'Senior Manager', ['Solution Architect', 'Senior Manager - Business Analyst', 'Senior Manager - Quality Assurance', 'Senior Manager - Application Support', 'Senior Manager -']],
  ['E7',  'E7',  'Band 4', '15+ yrs',  'Assistant Vice President', ['Assistant Vice President', 'Assistant Vice President', 'Assistant Vice President', 'Assistant Vice President', 'Assistant Vice President']],
  ['E8',  'E8',  'Band 4', '15+ yrs',  'Deputy Vice President',    ['Deputy Vice President', 'Deputy Vice President', 'Deputy Vice President', 'Deputy Vice President', 'Deputy Vice President']],
  ['E9',  'E9',  'Band 3', '18+ yrs',  'Vice President I',         ['Vice President I', 'Vice President I', 'Vice President I', 'Vice President I', 'Vice President I']],
  ['E10', 'E10', 'Band 3', '18+ yrs',  'Vice President II',        ['Vice President II', 'Vice President II', 'Vice President II', 'Vice President II', 'Vice President II']],
  ['E11', 'E11', 'Band 2', '20+ yrs',  'Senior Vice President I',  ['Senior Vice President I', 'Senior Vice President I', 'Senior Vice President I', 'Senior Vice President I', 'Senior Vice President I']],
  ['E12', 'E12', 'Band 2', '20+ yrs',  'Senior Vice President II', ['Senior Vice President II', 'Senior Vice President II', 'Senior Vice President II', 'Senior Vice President II', 'Senior Vice President II']],
  ['E13', 'E13', 'Band 2', '20+ yrs',  'President / CXO',          ['President / CXO', 'President / CXO', 'President / CXO', 'President / CXO', 'President / CXO']],
  ['E14', 'E14', 'Band 1', '',         'Chief Executive Officer',  ['', '', '', '', '']],
  ['UGO', '',    'UGO',    '',         'Founder',                  ['', '', '', '', '']],
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
  ['Trainee Software Developer', 'E1', 'Technical'],
  ['Trainee Business Analyst', 'E1', 'Business Analysis'], ['Trainee BA', 'E1', 'Business Analysis'],
  ['Trainee Tester', 'E1', 'Testing'],
  ['Trainee Analyst', 'E1', 'Application Support / Application Monitoring'],
  ['Software Developer', 'E2', 'Technical'],
  ['Business Analyst', 'E2', 'Business Analysis'], ['BA', 'E2', 'Business Analysis'],
  ['Software Tester', 'E2', 'Testing'],
  ['Software Analyst', 'E2', 'Application Support / Application Monitoring'],
  ['Executive', 'E2', 'Corporate Functions'],
  ['Senior Software Developer', 'E3', 'Technical'],
  ['Senior Business Analyst', 'E3', 'Business Analysis'], ['Sr. BA', 'E3', 'Business Analysis'],
  ['Senior Software Tester', 'E3', 'Testing'],
  ['Senior Software Analyst', 'E3', 'Application Support / Application Monitoring'],
  ['Senior Executive', 'E3', 'Corporate Functions'],
  ['Lead', 'E4', null], ['Lead - Technical', 'E4', 'Technical'], ['Test Lead', 'E4', 'Testing'],
  ['Lead - Application Support', 'E4', 'Application Support / Application Monitoring'],
  ['Lead - App Support', 'E4', 'Application Support / Application Monitoring'],
  ['Senior / Lead Business Analyst', 'E4', 'Business Analysis'], ['Sr. / Lead BA', 'E4', 'Business Analysis'],
  ['Manager', 'E5', null], ['Technical Architect', 'E5', 'Technical'],
  ['Manager - Business Analyst', 'E5', 'Business Analysis'], ['Manager - BA', 'E5', 'Business Analysis'],
  ['Manager - Quality Assurance', 'E5', 'Testing'], ['Manager - QA', 'E5', 'Testing'],
  ['Manager - Application Support', 'E5', 'Application Support / Application Monitoring'],
  ['Manager - App Support', 'E5', 'Application Support / Application Monitoring'],
  ['Senior Manager', 'E6', null], ['Solution Architect', 'E6', 'Technical'],
  ['Senior Manager - Business Analyst', 'E6', 'Business Analysis'], ['Sr Manager - BA', 'E6', 'Business Analysis'],
  ['Senior Manager - Quality Assurance', 'E6', 'Testing'], ['Sr Manager - QA', 'E6', 'Testing'],
  ['Senior Manager - Application Support', 'E6', 'Application Support / Application Monitoring'],
  ['Sr Manager - App Support', 'E6', 'Application Support / Application Monitoring'],
  ['Assistant Vice President', 'E7', null], ['AVP', 'E7', null],
  ['Deputy Vice President', 'E8', null], ['DVP', 'E8', null],
  ['Vice President I', 'E9', null], ['VP1', 'E9', null], ['Vice President', 'E9', null],
  ['Vice President II', 'E10', null], ['VP2', 'E10', null],
  ['Senior Vice President I', 'E11', null], ['Sr. VP 1', 'E11', null],
  ['Senior Vice President II', 'E12', null], ['Sr. VP 2', 'E12', null],
  ['President / CXO', 'E13', null], ['President/CXO', 'E13', null],
  ['Chief Executive Officer', 'E14', null], ['CEO', 'E14', null],
  ['Founder', 'UGO', null],
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
  ['Application Support', 'Application Support / Application Monitoring'],
  ['Monitoring Support', 'Application Support / Application Monitoring'],
  ['Support', 'Application Support / Application Monitoring'],
  ['Incident', 'Application Support / Application Monitoring'],
  ['Production Support', 'Application Support / Application Monitoring'],
  ['Customer Support', 'Application Support / Application Monitoring'],
  ['Functional', 'Business Analysis'], ['Techno functional', 'Business Analysis'],
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
      // DO UPDATE, not DO NOTHING, and only for the two tables that are
      // a transcription of the client's sheet. Correcting a name there —
      // spelling AVP out in full, say — has to reach a tenant that
      // already ran this, and every migration runs on every boot. The
      // two MAPPING tables below stay DO NOTHING: those are HR's to
      // edit, and a re-deploy must not undo their work.
      `INSERT INTO pms.grade_ladder (tenant_id, grade, grade_label, band, sort_order, exp_range, generic_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, grade) DO UPDATE SET
         grade_label=EXCLUDED.grade_label, band=EXCLUDED.band, sort_order=EXCLUDED.sort_order,
         exp_range=EXCLUDED.exp_range, generic_role=EXCLUDED.generic_role`,
      [tenantId, grade, label, band, i, exp, generic]);
    for (let f = 0; f < F.length; f++) {
      if (!roles[f]) continue;
      await db.query(
        `INSERT INTO pms.grade_roles (tenant_id, grade, family, role_name)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, grade, family) DO UPDATE SET role_name=EXCLUDED.role_name`,
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
