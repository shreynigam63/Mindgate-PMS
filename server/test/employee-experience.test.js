// Total professional experience from the HRMS export (13 Oct).
//
// The RnR Junior awards (WOW Machine, Rising Star, Buddy Star) are decided
// on total experience, and nothing ever wrote it: the client's export has
// carried it all along as "CurrentExperiance", and the importer dropped
// that column as unused. So nobody in the company could receive a Junior
// award. The client confirmed the column is total experience.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { parseExperience, validateEmployeeCsv, TEMPLATE_COLUMNS } = require('../core/employees');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

test('experience reads the way an HRMS writes it', () => {
  const cases = [
    ['4.5', 4.5], ['4', 4], ['0', 0], ['4 Years 6 Months', 4.5], ['4 Yrs, 6 Mths', 4.5],
    ['6 months', 0.5], ['4y 6m', 4.5], ['2 Years', 2], ['4 years and 6 months', 4.5],
    // Written without spaces. Read piecewise these lost their years and
    // came back as months alone (found by review, 13 Oct).
    ['4Y6M', 4.5], ['2yrs3mths', 2.25], ['1y6m', 1.5], ['4Years6Months', 4.5],
  ];
  for (const [raw, want] of cases) assert.equal(parseExperience(raw).value, want, raw);
  for (const raw of ['', '-', 'NA', 'n/a', null]) {
    const r = parseExperience(raw);
    assert.equal(r.value, null, `${raw} is no figure`);
    assert.equal(r.error, undefined, `${raw} is not an error either`);
  }
});

test('anything else is reported, never guessed', () => {
  assert.match(parseExperience('lots').error, /not a number of years/);
  assert.match(parseExperience('75').error, /outside 0 to 60 years/);
  assert.match(parseExperience('5+').error, /not a number of years/);
  assert.match(parseExperience('abc 4 years').error, /not a number of years/);
});

test('THE CLIENT\'S COLUMN IS READ — "CurrentExperiance", and the other spellings', () => {
  for (const header of ['CurrentExperiance', 'Current Experience', 'Total Experience', 'Experience', 'Years of Experience']) {
    const r = validateEmployeeCsv(`Full Name,Office Email,${header}\nAsha,asha@x.com,3 Years 6 Months\n`);
    assert.ok(r.ok, header);
    assert.equal(r.rows[0].total_experience_years, 3.5, `${header} was not read`);
    assert.ok(!r.warnings.some((w) => /unknown column/i.test(w.warning || '')), `${header} reported as unknown`);
  }
});

test('two columns that both read as experience are named, not silently merged', () => {
  const r = validateEmployeeCsv('Full Name,Office Email,CURRENTEXPERIANCE,Experience\nAsha,asha@x.com,4,\n');
  assert.ok(r.warnings.some((w) => /"CURRENTEXPERIANCE" and "Experience" all read as total_experience_years/.test(w.warning)));
});

test('an unreadable cell is a row warning, and the row still loads', () => {
  const r = validateEmployeeCsv('Full Name,Office Email,Total Experience\nAsha,asha@x.com,lots\n');
  assert.ok(r.ok);
  assert.equal(r.rows[0].total_experience_years, null);
  assert.ok(r.warnings.some((w) => w.line === 2 && /not a number of years/.test(w.warning)));
});

test('the downloadable template asks for it', () => {
  assert.ok(TEMPLATE_COLUMNS.some(([h]) => h === 'Total Experience'));
});

// ---- stored, and never wiped by a file that leaves it out ----------------

let db; let tenantId;
before(async () => {
  if (!HAS_DB) return;
  db = require('../core/db');
  await require('../core/migrate').runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [`exp-test-${Date.now()}`])).rows[0].id;
});
after(async () => {
  if (!HAS_DB) return;
  await db.query(`DELETE FROM core.employees WHERE tenant_id=$1`, [tenantId]).catch(() => {});
  await db.query(`DELETE FROM core.tenants WHERE id=$1`, [tenantId]).catch(() => {});
  await db.pool.end();
});

test('the upload stores it, and a later file without it keeps it', { skip }, async () => {
  const { loadEmployees } = require('../core/employees');
  const person = (exp) => ({ emp_code: null, name: 'Exp Person', email: 'exp-person@x.com', department: null,
    designation: null, role_band: null, manager_email: null, date_of_joining: null, status: 'active',
    total_experience_years: exp });
  const stored = async () => Number((await db.query(
    `SELECT total_experience_years v FROM core.employees WHERE tenant_id=$1 AND email='exp-person@x.com'`,
    [tenantId])).rows[0].v);

  await loadEmployees(tenantId, [person(3.5)]);
  assert.equal(await stored(), 3.5);
  await loadEmployees(tenantId, [person(null)]);
  assert.equal(await stored(), 3.5, 'a blank cell or a file without the column wiped it');
  await loadEmployees(tenantId, [person(4)]);
  assert.equal(await stored(), 4, 'a new figure replaces the old one');
});
