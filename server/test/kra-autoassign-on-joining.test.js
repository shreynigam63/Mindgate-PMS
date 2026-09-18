// node --test — a new hire gets their KRAs when their details are added.
//
// Asked for on 18 Sep: "new hires should be assigned KRAs directly as per
// their department and designation once their details are added in system."
// The earlier framing carried the constraint that shapes it: "Manager
// approval is still required, but the KRA itself must remain open."
//
// So the sheet lands in 'draft' — theirs to review and submit. Submitting is
// what asks a manager for approval, and an employee who has never seen their
// own objectives cannot have asked for that.
//
// THE TESTS THAT CARRY THE WEIGHT:
//   - a RE-IMPORT of the same file assigns nothing. An HRMS export is the
//     whole company; getting this wrong would overwrite ~1,400 sheets on
//     every nightly sync.
//   - an existing sheet with KRAs on it is never touched, whoever calls.
//   - the department shelf wins over the company-wide one, and falls back
//     to it — the precedence the picker already serves.
//   - a designation with no shelf is REPORTED, not silently empty. 16 live
//     employees are in exactly that position.
//   - weights are NOT normalised to 100. One live shelf totals 105%, and
//     inventing a split nobody approved is worse than reporting it.
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, tenantId, cycleId, aa, loadEmployees;

const sheetOf = async (employeeId) => (await db.query(
  `SELECT id, status, manager_id FROM pms.kra_sheets WHERE cycle_id=$1 AND employee_id=$2`,
  [cycleId, employeeId])).rows[0];
const krasOf = async (employeeId) => {
  const s = await sheetOf(employeeId);
  if (!s) return [];
  return (await db.query(
    `SELECT title, weight, measures, category, sort_order FROM pms.kras
      WHERE sheet_id=$1 ORDER BY sort_order`, [s.id])).rows;
};
const mkEmp = async (name, email, designation, department, extra = {}) => (await db.query(
  `INSERT INTO core.employees (tenant_id,name,email,status,designation,department,manager_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [tenantId, name, email, extra.status || 'active', designation, department, extra.managerId || null])).rows[0].id;
const lib = async (designation, department, title, weight, order = 10) => db.query(
  `INSERT INTO pms.kra_library (tenant_id, designation, department, title, measures, category, suggested_weight, sort_order)
   VALUES ($1,$2,$3,$4,$5,'Delivery',$6,$7)`,
  [tenantId, designation, department, title, `how ${title} is measured`, weight, order]);
const setScope = async (mode) => db.query(
  `INSERT INTO core.admin_settings (tenant_id, key, value) VALUES ($1,'kra_library_scope',$2)
   ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`,
  [tenantId, JSON.stringify({ mode })]);

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-autoassign';
  process.env.TENANT_SLUG = 'autoassign-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();
  aa = require('../modules/performance/kra-autoassign');
  loadEmployees = require('../core/employees').loadEmployees;

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  cycleId = (await db.query(
    `INSERT INTO pms.cycles (tenant_id,name,fiscal_year,phase)
     VALUES ($1,'AA Cycle','FY26','kra_open') RETURNING id`, [t.id])).rows[0].id;

  // Company-wide shelf for Executive (no department), and a Finance-specific
  // one for the same title — the two-shelf case the precedence rule exists
  // for.
  await lib('Executive', null, 'Company KRA A', 60, 10);
  await lib('Executive', null, 'Company KRA B', 40, 20);
  await lib('Executive', 'Finance', 'Finance KRA A', 50, 10);
  await lib('Executive', 'Finance', 'Finance KRA B', 50, 20);
  // A shelf whose weights do NOT total 100, like Senior Software Engineer
  // does on the live instance.
  await lib('Architect', null, 'Arch KRA A', 60, 10);
  await lib('Architect', null, 'Arch KRA B', 45, 20);
});

after(async () => {
  if (!HAS_DB) return;
  await db.pool.end();
});

test('A NEW HIRE GETS THE SHELF FOR THEIR DESIGNATION, IN DRAFT', { skip }, async () => {
  const mgr = await mkEmp('AA Mgr', 'aa-mgr@x.com', 'Manager', 'Admin');
  const emp = await mkEmp('AA One', 'aa-one@x.com', 'Executive', 'Admin', { managerId: mgr });

  const r = await aa.assignFromLibrary(tenantId, emp, { actorEmail: 'hr@x.com' });
  assert.equal(r.assigned, 2, JSON.stringify(r));
  assert.equal(r.weight_total, 100);
  assert.equal(r.weights_ok, true);

  const sheet = await sheetOf(emp);
  // 'draft', NOT 'submitted': manager approval is still required, and
  // approval needs a submission a person actually made.
  assert.equal(sheet.status, 'draft');
  assert.equal(sheet.manager_id, mgr, 'the sheet is pointed at their manager');

  const kras = await krasOf(emp);
  assert.deepEqual(kras.map((k) => k.title), ['Company KRA A', 'Company KRA B']);
  assert.equal(Number(kras[0].weight), 60);
  assert.equal(kras[0].measures, 'how Company KRA A is measured', 'measures come across too');
  assert.equal(kras[0].category, 'Delivery');
});

test('THE DEPARTMENT SHELF WINS OVER THE COMPANY-WIDE ONE', { skip }, async () => {
  await setScope('department+designation');
  const emp = await mkEmp('AA Fin', 'aa-fin@x.com', 'Executive', 'Finance');

  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.matched_scope, 'department+designation');
  assert.deepEqual((await krasOf(emp)).map((k) => k.title), ['Finance KRA A', 'Finance KRA B'],
    'the Finance shelf, not the company-wide one — and NOT both');
});

test('…and falls back to the company-wide shelf when their department has none', { skip }, async () => {
  await setScope('department+designation');
  const emp = await mkEmp('AA Ops', 'aa-ops@x.com', 'Executive', 'Operations');

  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.matched_scope, 'designation');
  assert.deepEqual((await krasOf(emp)).map((k) => k.title), ['Company KRA A', 'Company KRA B']);
});

test('with department matching OFF, the company-wide shelf is used even for Finance', { skip }, async () => {
  await setScope('designation');
  const emp = await mkEmp('AA Fin2', 'aa-fin2@x.com', 'Executive', 'Finance');

  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.matched_scope, 'designation');
  assert.deepEqual((await krasOf(emp)).map((k) => k.title), ['Company KRA A', 'Company KRA B']);
  await setScope('department+designation');
});

test('department and designation are matched on trimmed, case-folded text', { skip }, async () => {
  // The library arrives as a spreadsheet. " finance " and "Finance" are the
  // same department to everyone except a computer.
  const emp = await mkEmp('AA Case', 'aa-case@x.com', '  eXeCutive ', ' FINANCE  ');
  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.matched_scope, 'department+designation');
  assert.equal(r.assigned, 2);
});

test('WEIGHTS ARE REPORTED, NEVER NORMALISED', { skip }, async () => {
  // One live shelf (Senior Software Engineer) totals 105%. Quietly
  // rescaling it would invent a split nobody approved; the employee's page
  // already warns and refuses the submit until it is 100.
  const emp = await mkEmp('AA Arch', 'aa-arch@x.com', 'Architect', 'Tech');
  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.assigned, 2);
  assert.equal(r.weight_total, 105, 'reported as it is');
  assert.equal(r.weights_ok, false);
  const kras = await krasOf(emp);
  assert.deepEqual(kras.map((k) => Number(k.weight)), [60, 45], 'not rescaled to 57.14/42.86');
});

test('a library row with no suggested weight becomes a 0% KRA, not a failed insert', { skip }, async () => {
  await lib('Trainee', null, 'Unweighted KRA', null, 10);
  const emp = await mkEmp('AA Trn', 'aa-trn@x.com', 'Trainee', 'Tech');
  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.assigned, 1);
  assert.equal(Number((await krasOf(emp))[0].weight), 0, 'visible and fixable, rather than nothing at all');
});

test('AN EXISTING SHEET WITH KRAs ON IT IS NEVER TOUCHED', { skip }, async () => {
  const emp = await mkEmp('AA Has', 'aa-has@x.com', 'Executive', 'Admin');
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,'draft') RETURNING id`,
    [tenantId, cycleId, emp])).rows[0].id;
  await db.query(
    `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order) VALUES ($1,$2,'My own KRA',100,10)`,
    [tenantId, sheet]);

  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.assigned, 0);
  assert.equal(r.reason, 'already_has_kras');
  assert.equal(r.existing, 1);
  assert.deepEqual((await krasOf(emp)).map((k) => k.title), ['My own KRA'], 'their own picks stay theirs');
});

test('a submitted or approved sheet is left alone even when empty', { skip }, async () => {
  for (const status of ['submitted', 'approved']) {
    const emp = await mkEmp(`AA ${status}`, `aa-${status}@x.com`, 'Executive', 'Admin');
    await db.query(
      `INSERT INTO pms.kra_sheets (tenant_id,cycle_id,employee_id,status) VALUES ($1,$2,$3,$4)`,
      [tenantId, cycleId, emp, status]);
    const r = await aa.assignFromLibrary(tenantId, emp);
    assert.equal(r.assigned, 0);
    assert.equal(r.reason, `sheet_${status}`);
    assert.equal((await krasOf(emp)).length, 0);
  }
});

test('the skips that must be REPORTED rather than silent', { skip }, async () => {
  const noShelf = await mkEmp('AA VP', 'aa-vp@x.com', 'Vice President I', 'Delivery');
  assert.equal((await aa.assignFromLibrary(tenantId, noShelf)).reason, 'no_shelf_for_designation',
    '16 live employees are in exactly this position');

  const noDesig = await mkEmp('AA None', 'aa-none@x.com', null, 'Delivery');
  assert.equal((await aa.assignFromLibrary(tenantId, noDesig)).reason, 'no_designation');

  const leaver = await mkEmp('AA Gone', 'aa-gone@x.com', 'Executive', 'Admin', { status: 'inactive' });
  assert.equal((await aa.assignFromLibrary(tenantId, leaver)).reason, 'not_active',
    'a leaver must not appear in a manager\'s queue');

  assert.equal((await aa.assignFromLibrary(tenantId, '11111111-1111-1111-1111-111111111111')).reason,
    'employee_not_found');
});

test('it is audited, and the employee is told', { skip }, async () => {
  const emp = await mkEmp('AA Aud', 'aa-aud@x.com', 'Executive', 'Admin');
  await aa.assignFromLibrary(tenantId, emp, { actorEmail: 'hr@x.com' });

  const a = (await db.query(
    `SELECT actor_email, entity, details FROM core.audit_log
      WHERE tenant_id=$1 AND action='KRA_AUTOASSIGNED_ON_JOINING' AND details->>'employee_id'=$2`,
    [tenantId, emp])).rows;
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_email, 'hr@x.com');
  assert.equal(a[0].entity, 'kra_sheets');
  assert.equal(a[0].details.kras, 2);
  assert.equal(a[0].details.weight_total, 100);

  const n = (await db.query(
    `SELECT title, body FROM core.notifications
      WHERE tenant_id=$1 AND employee_id=$2 AND kind='kra_autoassigned'`, [tenantId, emp])).rows;
  assert.equal(n.length, 1);
  assert.match(n[0].body, /2 KRAs for Executive/);
  assert.match(n[0].body, /submit them to your manager/);
});

test('the notification says so when the weights need fixing first', { skip }, async () => {
  const emp = await mkEmp('AA Arch2', 'aa-arch2@x.com', 'Architect', 'Tech');
  await aa.assignFromLibrary(tenantId, emp);
  const n = (await db.query(
    `SELECT body FROM core.notifications WHERE tenant_id=$1 AND employee_id=$2 AND kind='kra_autoassigned'`,
    [tenantId, emp])).rows[0];
  assert.match(n.body, /total 105% and must come to 100%/);
});

test('no open cycle means nothing is assigned and nothing is invented', { skip }, async () => {
  await db.query(`UPDATE pms.cycles SET phase='closed' WHERE id=$1`, [cycleId]);
  const emp = await mkEmp('AA NoCyc', 'aa-nocyc@x.com', 'Executive', 'Admin');
  const r = await aa.assignFromLibrary(tenantId, emp);
  assert.equal(r.reason, 'no_open_cycle');
  assert.equal((await db.query(
    `SELECT count(*)::int AS n FROM pms.kra_sheets WHERE employee_id=$1`, [emp])).rows[0].n, 0,
    'no sheet is created either');
  await db.query(`UPDATE pms.cycles SET phase='kra_open' WHERE id=$1`, [cycleId]);
});

test('THE IMPORTER ASSIGNS ON A FIRST IMPORT, AND A RE-IMPORT ASSIGNS NOTHING', { skip }, async () => {
  // The test this feature lives or dies by. An HRMS export is the whole
  // company, so "new hire" must mean "not on file", never "in the file".
  const file = [
    { emp_code: 'N1', name: 'Imp One', email: 'imp-one@x.com', department: 'Finance',
      designation: 'Executive', role_band: null, date_of_joining: null, status: 'active', manager_email: '' },
    { emp_code: 'N2', name: 'Imp Two', email: 'imp-two@x.com', department: 'Delivery',
      designation: 'Vice President I', role_band: null, date_of_joining: null, status: 'active', manager_email: '' },
  ];

  const first = await loadEmployees(tenantId, file, { actorEmail: 'hr@x.com' });
  assert.equal(first.new_hires, 2);
  assert.equal(first.kras_auto_assigned.length, 1, 'one had a shelf');
  assert.equal(first.kras_auto_assigned[0].email, 'imp-one@x.com');
  assert.equal(first.kras_auto_assigned[0].kras, 2);
  assert.equal(first.kras_auto_assigned[0].matched_scope, 'department+designation');
  assert.equal(first.kras_not_auto_assigned.length, 1, 'and the other is REPORTED, not silent');
  assert.equal(first.kras_not_auto_assigned[0].reason, 'no_shelf_for_designation');

  // The same file again — a nightly sync.
  const again = await loadEmployees(tenantId, file, { actorEmail: 'hr@x.com' });
  assert.equal(again.new_hires, 0, 'nobody in the file is new any more');
  assert.equal(again.kras_auto_assigned.length, 0);
  assert.equal(again.kras_not_auto_assigned.length, 0);

  // …and the KRAs assigned the first time are untouched, not duplicated.
  const empId = (await db.query(
    `SELECT id FROM core.employees WHERE tenant_id=$1 AND email='imp-one@x.com'`, [tenantId])).rows[0].id;
  assert.equal((await krasOf(empId)).length, 2);
});

test('shelfFor() is read-only, so the dry-run preview cannot write', { skip }, async () => {
  // The dry run calls exactly this and nothing else. If it ever grew a
  // write, HR pressing Validate would change data.
  const before = (await db.query(`SELECT count(*)::int AS n FROM pms.kras`)).rows[0].n;
  const beforeSheets = (await db.query(`SELECT count(*)::int AS n FROM pms.kra_sheets`)).rows[0].n;
  const s = await aa.shelfFor(tenantId, { designation: 'Executive', department: 'Finance' });
  assert.equal(s.rows.length, 2);
  assert.equal(s.scope, 'department+designation');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.kras`)).rows[0].n, before);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pms.kra_sheets`)).rows[0].n, beforeSheets);
});
