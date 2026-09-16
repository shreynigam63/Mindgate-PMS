// node --test — what the Department dropdown on My KRAs counts.
//
// Requested directly: the department entry should read "Admin and overall
// total KRAs mapped under Admin department as per overall designations
// mapped under Admin", because the Designation control right underneath
// already gives the per-title breakdown. Before this, both controls
// counted the same eight KRAs — the employee's own title — and the
// department dimension was never actually measured anywhere.
//
// Two things are easy to get wrong here and both are pinned below:
//   * a title with BOTH its own department shelf and a company-wide
//     fallback must count once, not twice (COALESCE/NULLIF, not a sum);
//   * a title nobody in the department holds must not be counted at all,
//     because the total is "what this department's people are served".
//
// Real Postgres, real HTTP surface, skips cleanly without DATABASE_URL.
const { test, after, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, token;

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sdt';
  process.env.TENANT_SLUG = 'sdt-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);
  await db.query(
    `INSERT INTO core.admin_settings (tenant_id, key, value)
     VALUES ($1,'kra_library_scope','{"mode":"department+designation"}'::jsonb)`, [t.id]);

  // Admin employs three titles; Sales employs one, to prove the total is
  // scoped to the department and not a count of the whole library.
  const people = [
    ['Exec One', 'sdt-exec@x.com', 'Admin', 'Executive'],
    ['Exec Two', 'sdt-exec2@x.com', 'Admin', 'Executive'],   // same title twice: titles, not headcount
    ['Off Asst', 'sdt-oa@x.com', 'Admin', 'Office Assistant'],
    ['Adm Mgr', 'sdt-am@x.com', 'Admin', 'Admin Manager'],
    ['Sales Rep', 'sdt-sales@x.com', 'Sales', 'Sales Executive'],
  ];
  for (const [name, email, dept, desig] of people) {
    await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
       VALUES ($1,$2,$3,'active',$4,$5)`, [t.id, name, email, dept, desig]);
  }
  await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`,
    [t.id, 'sdt-exec@x.com', await bcrypt.hash('pass', 10)]);

  // Executive: 2 company-wide AND 3 under Admin. The Admin shelf wins —
  // a naive sum would say 5 and inflate every department that has ever
  // published one of its own.
  const lib = [
    [null, 'Executive', 'Company A'], [null, 'Executive', 'Company B'],
    ['Admin', 'Executive', 'Admin A'], ['Admin', 'Executive', 'Admin B'], ['Admin', 'Executive', 'Admin C'],
    [null, 'Office Assistant', 'OA A'], [null, 'Office Assistant', 'OA B'],   // fallback only -> 2
    ['Admin', 'Admin Manager', 'AM A'],                                        // own only     -> 1
    [null, 'Sales Executive', 'Sales A'],                                      // other dept
    [null, 'Nobody Holds This', 'Ghost A'],                                    // no employee  -> 0
  ];
  for (const [dept, desig, title] of lib) {
    await db.query(
      `INSERT INTO pms.kra_library (tenant_id, department, designation, title) VALUES ($1,$2,$3,$4)`,
      [t.id, dept, desig, title]);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;
  token = (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sdt-exec@x.com', password: 'pass' }),
  })).json()).token;
});

after(async () => {
  if (!HAS_DB) return;
  server.close();
  await db.pool.end();
});

const shelf = async () => (await (await fetch(`${base}/pms/my/kra-library`,
  { headers: { Authorization: `Bearer ${token}` } })).json());

test('the department entry counts THE DEPARTMENT, not the viewer\'s own title', { skip }, async () => {
  const d = await shelf();
  const admin = (d.shelves || []).find((s) => s.department === 'Admin');
  assert.ok(admin, 'the employee\'s own department is always on the menu');
  // Executive 3 (its own Admin shelf) + Office Assistant 2 (fallback)
  // + Admin Manager 1 = 6, across 3 titles. Not 8, which is what adding
  // the Executive fallback on top would give.
  assert.equal(admin.department_kras, 6);
  assert.equal(admin.department_titles, 3);
  // ...and the viewer's own title still reads 3, so the two controls are
  // visibly measuring different things rather than repeating each other.
  assert.equal(admin.kras, 3);
});

test('a title with both an own shelf and a fallback is counted once', { skip }, async () => {
  const d = await shelf();
  const admin = (d.shelves || []).find((s) => s.department === 'Admin');
  const desigs = d.department_designations || [];
  const exec = desigs.find((x) => x.designation === 'Executive');
  assert.equal(exec.kras, 3, 'the Admin shelf wins over the company-wide one');
  // The department total is exactly the sum of the titles listed beside
  // it — the invariant that makes the two controls agree.
  assert.equal(admin.department_kras, desigs.reduce((n, x) => n + x.kras, 0));
  assert.equal(admin.department_titles, desigs.length);
});

test('another department\'s KRAs, and titles nobody holds, are not in the total', { skip }, async () => {
  const d = await shelf();
  const admin = (d.shelves || []).find((s) => s.department === 'Admin');
  // Sales Executive (1) and Nobody Holds This (1) are in the library but
  // not in Admin. 6, not 8.
  assert.equal(admin.department_kras, 6);
  assert.ok(!(d.department_designations || []).some((x) => /Sales|Nobody/.test(x.designation)));
});

test('"All departments" counts every department, added up', { skip }, async () => {
  const d = await shelf();
  const all = (d.shelves || []).find((s) => !s.department);
  assert.ok(all, 'the company-wide shelf stays on the menu');
  // Admin 6 (Executive 3 + Office Assistant 2 + Admin Manager 1)
  // + Sales 1 = 7, across the 2 departments anybody works in.
  assert.equal(all.all_kras, 7);
  assert.equal(all.all_departments, 2);
  // It is NOT a department, so it carries no department total...
  assert.equal(all.department_kras, undefined);
  // ...and `kras` still means what it always did: the shelf this option
  // actually loads, which is this one job title's company-wide set. The
  // label says something different from what the option does, which is
  // deliberate and is why this assertion is here rather than deleted.
  assert.equal(all.kras, 2);
});

test('THE TOP LINE IS THE SUM OF THE LINES BELOW IT', { skip }, async () => {
  // The invariant that makes the menu coherent: pick any department and
  // it is part of the "All departments" figure. Only this viewer's own
  // department is on their menu, so the check goes through the server's
  // own rollup — every department, not just the visible one.
  const d = await shelf();
  const all = (d.shelves || []).find((s) => !s.department);
  const admin = (d.shelves || []).find((s) => s.department === 'Admin');
  assert.ok(all.all_kras > admin.department_kras, 'the whole exceeds the part');
  assert.equal(all.all_kras - admin.department_kras, 1, 'Sales is the only other department');
});

test('an employee with no department at all is in neither total', { skip }, async () => {
  // They belong to no department, so they cannot be part of "all
  // departments" — and counting them would break the sum-of-parts rule
  // above. Proven by adding one and re-reading the totals.
  const before = (await shelf()).shelves.find((s) => !s.department).all_kras;
  await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
     SELECT tenant_id,'No Dept','sdt-nodept@x.com','active','','Executive'
       FROM core.employees WHERE email='sdt-exec@x.com'`);
  const after = (await shelf()).shelves.find((s) => !s.department).all_kras;
  assert.equal(after, before, 'a department-less employee changes nothing');
  await db.query(`DELETE FROM core.employees WHERE email='sdt-nodept@x.com'`);
});

test('two people with the same title are one title, not two', { skip }, async () => {
  // department_titles counts job titles because the number sits next to a
  // KRA count; counting heads would make "70 KRAs across 412 titles" and
  // mean nothing.
  const d = await shelf();
  const admin = (d.shelves || []).find((s) => s.department === 'Admin');
  assert.equal(admin.department_titles, 3, 'Executive is held by two people, counted once');
});
