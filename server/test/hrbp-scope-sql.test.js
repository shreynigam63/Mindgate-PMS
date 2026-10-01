// node --test — the remit clause, run by Postgres rather than simulated.
//
// hrbp-scope.test.js compares matches() against a JavaScript
// re-implementation of the SQL, which proves the two halves of my own
// reasoning agree and nothing about what the database does with the
// clause. This file runs the generated WHERE for real: same remits, same
// employees, and the rows that come back have to be exactly the ones
// matches() accepts.
//
// It is worth the database because the dangerous case is specifically a
// SQL one — a scoping clause that disappears, or quietly matches
// everything, while the JavaScript beside it looks correct.
const { test, before } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
let db, tenantId;
const { matches, remitSql } = require('../modules/people/hrbp-scope');

const PEOPLE = [
  ['Pune Person',      'Pune',          'Rajesh Kulkarni'],
  ['Pune Lower',       'pune',          'Someone Else'],
  ['Pune Padded',      '  PUNE  ',      null],
  ['Mumbai Rajesh',    'Mumbai',        'Rajesh Kulkarni'],
  ['Mumbai Other',     'Mumbai',        'Someone Else'],
  ['Kharadi Person',   'Pune - Kharadi', null],
  ['Nothing Known',    null,            null],
];

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-hrbp-sql';
  process.env.TENANT_SLUG = 'hrbp-sql-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const { runMigrations } = require('../core/migrate');
  await runMigrations();
  tenantId = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0].id;
  for (const [name, location, hod] of PEOPLE) {
    await db.query(
      `INSERT INTO core.employees (tenant_id, name, email, status, location, hod_name)
       VALUES ($1,$2,$3,'active',$4,$5)`,
      [tenantId, name, `${name.replace(/\s+/g, '.').toLowerCase()}@hrbp.test`, location, hod]);
  }
});

const run = async (remit) => {
  const { where, params } = remitSql(remit, 2);
  const rows = (await db.query(
    `SELECT e.name FROM core.employees e
      WHERE e.tenant_id=$1 AND e.status='active'${where} ORDER BY e.name`,
    [tenantId, ...params])).rows;
  return rows.map((r) => r.name);
};
const expected = (remit) => PEOPLE
  .filter(([, location, hod_name]) => matches(remit, { location, hod_name }))
  .map(([name]) => name).sort();

const agree = async (t, remit) => {
  if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
  assert.deepEqual(await run(remit), expected(remit));
};

test('AN EMPTY REMIT RETURNS NO ROWS FROM POSTGRES — the clause must not vanish', async (t) => {
  if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
  const got = await run({ locations: [], hods: [] });
  assert.deepEqual(got, [], `an unassigned HRBP must see nobody, got ${got.length} people`);
  // And prove the fixture is not simply empty, or the assertion above is
  // worthless.
  assert.equal((await run({ locations: ['Pune'], hods: [] })).length > 0, true);
});

test('location remit: Postgres and matches() return the same people', async (t) => {
  await agree(t, { locations: ['Pune'], hods: [] });
});

test('HOD remit: Postgres and matches() return the same people', async (t) => {
  await agree(t, { locations: [], hods: ['Rajesh Kulkarni'] });
});

test('both: Postgres and matches() return the same people, as a union', async (t) => {
  await agree(t, { locations: ['Pune'], hods: ['Rajesh Kulkarni'] });
  if (!HAS_DB) return;
  // Named explicitly, because "they agree" would also hold if both were
  // wrong in the same direction.
  assert.deepEqual(await run({ locations: ['Pune'], hods: ['Rajesh Kulkarni'] }),
    ['Mumbai Rajesh', 'Pune Lower', 'Pune Padded', 'Pune Person']);
});

test('case and padding fold in Postgres too, and a different site stays different', async (t) => {
  if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
  const got = await run({ locations: ['  pUnE '], hods: [] });
  assert.deepEqual(got, ['Pune Lower', 'Pune Padded', 'Pune Person']);
  assert.ok(!got.includes('Kharadi Person'), '"Pune - Kharadi" is not "Pune"');
});

test('a person with neither field set is returned by no remit at all', async (t) => {
  if (!HAS_DB) { t.skip('no DATABASE_URL'); return; }
  for (const remit of [{ locations: ['Pune'], hods: [] }, { locations: [], hods: ['Rajesh Kulkarni'] },
    { locations: ['Pune', 'Mumbai'], hods: ['Rajesh Kulkarni', 'Someone Else'] }]) {
    assert.ok(!(await run(remit)).includes('Nothing Known'));
  }
});
