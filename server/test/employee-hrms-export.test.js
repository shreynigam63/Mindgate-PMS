// node --test — importing the HRMS export exactly as HR receives it.
//
// The client's employee report comes out of their HRMS with its own column
// names ("Full Name", "Office Email"), names its managers rather than
// addressing them, and has gaps in it. Before this, the whole 1,397-row
// file was refused at the header check with "Missing required column(s):
// name, email" — not one row was read, and nothing was actually wrong with
// the data.
//
// These tests pin the three things that changed, and — just as important —
// the places where the importer deliberately did NOT become more lenient.
// Pure: no database, no HTTP.
const { test } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const { validateEmployeeCsv, validateEmployeeXlsx, NO_EMAIL_DOMAIN, isPlaceholderEmail } = require('../core/employees');

// The header row as the client's HRMS actually writes it.
const HRMS = 'Employee Code,Full Name,Office Email,Department,Designation,Reporting Manager,HOD,Date of Joining';

const csv = (...lines) => validateEmployeeCsv([HRMS, ...lines].join('\n'));
const warnedAbout = (r, re) => r.warnings.filter((w) => re.test(w.warning));

test('the export’s own column names are accepted — this is the whole point', () => {
  const r = csv(
    'MGS1,Rajesh Kulkarni,rajesh.k@mindgate.in,Delivery,Delivery Head,,,01/04/2019',
    'MGS2,Priya Menon,priya.menon@mindgate.in,Delivery,Manager - Delivery,Rajesh Kulkarni,Rajesh Kulkarni,15/06/2021',
  );
  assert.equal(r.fatal, null, 'the header check must not reject the file');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].emp_code, 'MGS1');
  assert.equal(r.rows[1].name, 'Priya Menon');
  assert.equal(r.rows[1].email, 'priya.menon@mindgate.in');
});

test('the importer’s original column names still work — this widened what is accepted, it did not replace it', () => {
  const r = validateEmployeeCsv([
    'emp_code,name,email,department,designation,role_band,manager_email,date_of_joining,status',
    'E1,CEO Person,ceo@x.com,Leadership,CEO,L1,,2020-04-01,active',
    'E2,Mgr One,mgr@x.com,Delivery,Manager,L3,ceo@x.com,2021-06-15,active',
  ].join('\n'));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows[1].manager_email, 'ceo@x.com');
});

test('Reporting Manager is resolved by NAME against the same file', () => {
  const r = csv(
    'MGS1,Rajesh Kulkarni,rajesh.k@mindgate.in,Delivery,Delivery Head,,,01/04/2019',
    'MGS2,Priya Menon,priya.menon@mindgate.in,Delivery,Manager - Delivery,Rajesh Kulkarni,,15/06/2021',
    'MGS3,Akshay Raut,akshay.raut@mindgate.in,Delivery,Project Manager,Priya  Menon,,01/07/2022',
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows[1].manager_email, 'rajesh.k@mindgate.in');
  // Doubled space in "Priya  Menon" still matches: an HRMS writes the same
  // person's name two ways often enough that exact comparison would drop
  // real reporting lines.
  assert.equal(r.rows[2].manager_email, 'priya.menon@mindgate.in');
  assert.equal(r.summary.managers_resolved_by_name, 2);
});

test('a manager NAME that is not in the file is a warning; a manager EMAIL that is not is still an error', () => {
  // The asymmetry is deliberate. In the real export 41 rows name a manager
  // who is outside the extract — people who left, or who sit above the
  // exported population. Refusing 1,397 rows over that helps nobody. An
  // ADDRESS, by contrast, is an exact identifier: a miss means the file
  // contradicts itself, and that is worth stopping for.
  const byName = csv('MGS1,Solo Person,solo@x.com,Delivery,Engineer,Ghost Manager,,01/04/2019');
  assert.equal(byName.ok, true, 'an unresolved manager name must not block the file');
  assert.equal(byName.rows[0].manager_email, null);
  assert.equal(warnedAbout(byName, /reporting manager "Ghost Manager" is not in this file/).length, 1);

  const byEmail = validateEmployeeCsv([
    'name,email,manager_email',
    'Solo Person,solo@x.com,ghost@x.com',
  ].join('\n'));
  assert.equal(byEmail.ok, false, 'an unresolved manager_email must still be an error');
  assert.ok(byEmail.errors.some((e) => /not present in this file/.test(e.error)));
});

test('two people with the same name are an error, not a coin toss', () => {
  const r = csv(
    'MGS1,Amit Sharma,amit1@x.com,Delivery,Manager,,,01/04/2019',
    'MGS2,Amit Sharma,amit2@x.com,Support,Manager,,,01/04/2019',
    'MGS3,Reportee One,rep@x.com,Delivery,Engineer,Amit Sharma,,01/04/2020',
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /ambiguous — 2 employees share that name/.test(e.error)),
    `expected the ambiguity to be named: ${JSON.stringify(r.errors)}`);
});

test('an employee whose Reporting Manager is themselves gets no reporting line, and the file still loads', () => {
  // Four rows in the real export do this. It is wrong, but the only sane
  // reading is "no manager" and the org-wide "N employees have no manager"
  // warning already surfaces it.
  const r = csv('MGS1,Self Manager,self@x.com,Delivery,Head,Self Manager,,01/04/2019');
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].manager_email, null);
  assert.equal(warnedAbout(r, /is this employee — no reporting line set/).length, 1);
});

test('a self-referencing manager_email is STILL a hard error', () => {
  const r = validateEmployeeCsv(['name,email,manager_email', 'A,a@x.com,a@x.com'].join('\n'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /own manager/.test(e.error)));
});

test('no email on record: a placeholder is built from the employee code, and it is said out loud', () => {
  const r = csv(
    'MGS1,Boss Person,boss@x.com,INFRA,Head,,,01/04/2019',
    'MGST347,Oracle DBA Person,,INFRA,Oracle DBA,Boss Person,,01/04/2021',
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows[1].email, `mgst347@${NO_EMAIL_DOMAIN}`);
  assert.equal(r.rows[1].email_is_placeholder, true);
  assert.ok(isPlaceholderEmail(r.rows[1].email));
  assert.equal(r.summary.placeholder_emails, 1);
  // Named in its own list, so the dry run answers "who cannot sign in"
  // without reading a thousand warnings.
  assert.deepEqual(r.placeholder_emails, [{ line: 3, emp_code: 'MGST347', name: 'Oracle DBA Person', email: `mgst347@${NO_EMAIL_DOMAIN}` }]);
  assert.equal(warnedAbout(r, /cannot sign in until HR adds a real one/).length, 1);
  // They are still in the org chart — which is the reason for doing this
  // at all rather than skipping the row.
  assert.equal(r.rows[1].manager_email, 'boss@x.com');
});

test('.invalid is used on purpose — a placeholder must never be able to receive mail', () => {
  const r = csv('MGS9,No Mail,,Delivery,Engineer,,,01/04/2021');
  assert.match(r.rows[0].email, /@no-email\.invalid$/);
});

test('two people sharing one address: the first keeps it, the second gets a placeholder', () => {
  const r = csv(
    'MGST347,Linux Admin One,shared@mindgate.in,INFRA,Linux Administrator,,,01/04/2019',
    'MGST395,Linux Admin Two,shared@mindgate.in,INFRA,Linux Administrator,,,01/04/2020',
  );
  assert.equal(r.ok, true, 'one shared address must not block the whole file');
  assert.equal(r.rows[0].email, 'shared@mindgate.in');
  assert.equal(r.rows[1].email, `mgst395@${NO_EMAIL_DOMAIN}`);
  assert.equal(warnedAbout(r, /is already used at line 2/).length, 1);
});

test('no email AND no employee code is an error — there is nothing to build an identity from', () => {
  const r = csv(',Nameless Address,,Delivery,Engineer,,,01/04/2021');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /no employee code to derive a placeholder from/.test(e.error)));
});

test('a space inside an address is repaired and reported', () => {
  // Two rows of the client's export are written "amit.nandi @mindgate.in".
  // No valid unquoted address contains a space, so stripping it can only
  // repair the value — but the HRMS should still be fixed, so it is said.
  const r = csv('MGS1,Amit Nandi,amit.nandi @mindgate.in,Delivery,Engineer,,,01/04/2021');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows[0].email, 'amit.nandi@mindgate.in');
  assert.equal(warnedAbout(r, /contains spaces — read as/).length, 1);
});

test('the department head is set only when every row in the department agrees', () => {
  const r = csv(
    'MGS1,Vadivel S,vadivel@x.com,Development,Delivery Head,,,01/04/2015',
    'MGS2,Dev One,dev1@x.com,Development,Engineer,Vadivel S,Vadivel S,01/04/2020',
    'MGS3,Dev Two,dev2@x.com,Development,Engineer,Vadivel S,Vadivel S,01/04/2021',
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.department_heads, [{ department: 'Development', name: 'Vadivel S', email: 'vadivel@x.com', employees: 2 }]);
  assert.equal(r.summary.department_heads, 1);
});

test('A DEPARTMENT WHOSE ROWS NAME DIFFERENT HODs GETS NO HEAD — the disagreement is reported instead', () => {
  // This is the test that matters most here. The first cut took the most
  // common HOD per department, which looked reasonable and was wrong: in
  // the client's own data "Development" is 226 people naming 23 different
  // HODs, because Department is a coarse grouping and HOD records each
  // person's actual head within it. Taking the modal name would have put
  // 226 people into one person's review queue and called it configuration.
  const r = csv(
    'MGS1,Head A,a@x.com,Development,Head,,,01/04/2015',
    'MGS2,Head B,b@x.com,Development,Head,,,01/04/2015',
    'MGS3,Dev One,dev1@x.com,Development,Engineer,Head A,Head A,01/04/2020',
    'MGS4,Dev Two,dev2@x.com,Development,Engineer,Head A,Head A,01/04/2020',
    'MGS5,Dev Three,dev3@x.com,Development,Engineer,Head B,Head B,01/04/2020',
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.department_heads, [], 'a contested department must not be assigned a head automatically');
  assert.equal(r.summary.department_heads_need_a_choice, 1);
  assert.deepEqual(r.department_heads_need_a_choice, [{
    department: 'Development',
    candidates: [{ name: 'Head A', employees: 2 }, { name: 'Head B', employees: 1 }],
  }], 'HR needs the candidates and their weight in order to choose');
  assert.equal(warnedAbout(r, /names 2 different HODs — no department head set automatically/).length, 1);
});

test('an HOD who is not in the file is reported, not invented', () => {
  const r = csv('MGS1,Dev One,dev1@x.com,Development,Engineer,,Ghost Head,01/04/2020');
  assert.equal(r.ok, true);
  assert.deepEqual(r.department_heads, []);
  assert.equal(warnedAbout(r, /HOD "Ghost Head" for department "Development" is not in this file/).length, 1);
});

test('columns the PMS has no use for are ignored silently, not listed as unknown', () => {
  // An export with a dozen irrelevant columns would otherwise bury the
  // warnings that matter under noise about ones nobody can act on. Date of
  // Birth, Gender and Salutation are in that list deliberately: nothing
  // reads them, and the less personal data the appraisal system holds the
  // better.
  const r = validateEmployeeCsv([
    'Company,Salutation,Employee Code,Full Name,Date of Birth,Gender,Branch,Office Email,Department,Designation,Qualification,CURRENTEXPERIANCE,BranchCode',
    'Mindgate,Mr.,MGS1,Jane Sample,01/01/1990,Male,Mumbai,jane@x.com,Delivery,Engineer,B.E.,5.2,MUM',
  ].join('\n'));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(warnedAbout(r, /unknown column/).length, 0, `nothing should be reported as unknown: ${JSON.stringify(r.warnings)}`);
  // ...but a column nobody has heard of IS still reported, because that is
  // usually a typo in a column the importer was meant to read.
  const typo = validateEmployeeCsv(['Full Name,Office Email,Desigantion', 'A,a@x.com,Engineer'].join('\n'));
  assert.equal(warnedAbout(typo, /unknown column\(s\): desigantion/).length, 1);
});

test('a leaving date with no status column is flagged rather than silently imported as active', () => {
  const r = validateEmployeeCsv([
    'Full Name,Office Email,Resignation Date',
    'Leaver Person,leaver@x.com,31/03/2026',
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].status, 'active');
  assert.equal(warnedAbout(r, /resignation date is set .* but there is no status column/).length, 1);
});

test('dd/mm/yyyy is read the way the client writes it', () => {
  const r = csv('MGS1,Jane Sample,jane@x.com,Delivery,Engineer,,,01/07/2026');
  assert.equal(r.rows[0].date_of_joining, '2026-07-01', '01/07 is 1 July, not 7 January');
});

test('the same export as a real .xlsx reaches the identical result', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('EmpReport');
  ws.addRow(HRMS.split(','));
  ws.addRow(['MGS1', 'Rajesh Kulkarni', 'rajesh.k@mindgate.in', 'Delivery', 'Delivery Head', '', '', '01/04/2019']);
  ws.addRow(['MGS2', 'Priya Menon', 'priya.menon@mindgate.in', 'Delivery', 'Manager - Delivery', 'Rajesh Kulkarni', 'Rajesh Kulkarni', '15/06/2021']);
  const r = await validateEmployeeXlsx(await wb.xlsx.writeBuffer());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.rows[1].manager_email, 'rajesh.k@mindgate.in');
  assert.deepEqual(r.department_heads, [{ department: 'Delivery', name: 'Rajesh Kulkarni', email: 'rajesh.k@mindgate.in', employees: 1 }]);
});

test('a file with neither a name nor an email column is still rejected outright', () => {
  const r = validateEmployeeCsv(['Department,Designation', 'Delivery,Engineer'].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.fatal, /Missing required column\(s\): name, email/);
});
