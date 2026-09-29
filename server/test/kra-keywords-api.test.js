// node --test — KRA keywords over the real HTTP surface.
//
// Phase 1 of the Zoho timesheet rating engine (29 Sep). The pure tests
// pin the parsing; this pins the wiring — which is where the bugs that
// reach a client actually live.
//
// The thing most worth testing here is the BULK editor. The client
// instance carries 2,360 library rows, so a bulk apply is the only
// realistic way to populate them, and a bulk apply that touches the
// wrong rows is a day of cleanup. Hence: the filter narrows, the
// preview writes nothing, and clearing needs saying out loud.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set — see file header';

let db, server, base, tenantId, tok = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-kw';
  process.env.TENANT_SLUG = 'kw-test-' + Date.now();
  process.env.AUTH_DEV = 'true';
  db = require('../core/db');
  const bcrypt = require('bcryptjs');
  const express = require('express');
  const { runMigrations } = require('../core/migrate');
  const { devLogin } = require('../core/auth');
  await runMigrations();

  const t = (await db.query(`INSERT INTO core.tenants (name, slug) VALUES ($1,$1) RETURNING id`,
    [process.env.TENANT_SLUG])).rows[0];
  tenantId = t.id;
  await require('../migrations/002-default-permission-bundles').ensureTenantSeeds(db, t.id);

  await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation)
     VALUES ($1,'KW Boss','kw-boss@x.com','active','HR','Head of HR'),
            ($1,'KW Plain','kw-plain@x.com','active','Delivery','Engineer')`, [t.id]);
  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'kw-boss@x.com','admin')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['kw-boss@x.com', 'kw-plain@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`,
      [t.id, e, hash]);
  }

  // A small shelf across two designations and two categories.
  const rows = [
    ['Software Developer', 'Delivery', 'Client Project Delivery'],
    ['Software Developer', 'Delivery', 'Code Quality'],
    ['Software Developer', 'People', 'Mentoring'],
    ['Support Engineer', 'Delivery', 'Ticket Resolution'],
    ['Support Engineer', 'Delivery', 'Client Project Delivery'],
  ];
  let i = 0;
  for (const [desig, cat, title] of rows) {
    await db.query(
      `INSERT INTO pms.kra_library (tenant_id, designation, department, category, title, sort_order)
       VALUES ($1,$2,'Technology',$3,$4,$5)`, [t.id, desig, cat, title, (i += 10)]);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenantId = t.id; next(); });
  app.post('/api/v1/auth/dev-login', devLogin);
  app.use('/api/v1/pms', require('../modules/performance').router);
  server = app.listen(0);
  base = `http://localhost:${server.address().port}/api/v1`;

  const login = async (email) => (await (await fetch(`${base}/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass' }) })).json()).token;
  tok.boss = await login('kw-boss@x.com');
  tok.plain = await login('kw-plain@x.com');
});

after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'boss') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};

const keywordsOf = async (title) => (await db.query(
  `SELECT keywords FROM pms.kra_library WHERE tenant_id=$1 AND title=$2 ORDER BY designation`,
  [tenantId, title])).rows.map((r) => r.keywords);

test('the shelf starts with no keywords, and says so honestly', { skip }, async () => {
  const r = await api('/pms/hr/kra-library/keywords/summary');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 5);
  assert.equal(r.body.with_keywords, 0);
  assert.equal(r.body.coverage_pct, 0, 'coverage is the number worth watching in phase 1');
  assert.deepEqual(r.body.keywords, [], 'no keyword is in use yet');
});

test('a fresh tenant gets the value-add list on first load', { skip }, async () => {
  // The migration's own loop reads core.tenants, empty during
  // migrations — the trap that cost 056 a boot loop and 063 a silent
  // no-op. Ensured at request time instead.
  const r = await api('/pms/hr/kra-library/keywords/summary');
  assert.ok(r.body.value_add_keywords.length > 0, 'seeded on first read');
  assert.ok(r.body.value_add_keywords.includes('automation'));
  assert.ok(r.body.value_add_keywords.includes('process improvement'),
    'the A+ words from the spec are in the starting list');
  // Stored lowercase, so phase 2 matches case-insensitively without
  // remembering to.
  assert.ok(r.body.value_add_keywords.every((w) => w === w.toLowerCase()));
});

test('ONE row: keywords save, and a rename does not wipe them', { skip }, async () => {
  const row = (await db.query(
    `SELECT id FROM pms.kra_library WHERE tenant_id=$1 AND title='Code Quality'`, [tenantId])).rows[0];
  let r = await api(`/pms/hr/kra-library/entry/${row.id}`, { method: 'PUT', body: JSON.stringify({
    title: 'Code Quality', keywords: 'Code Review, Unit Testing' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entry.keywords, ['code review', 'unit testing']);

  // A PUT that only renames must leave them alone — absent means
  // "unchanged", not "clear".
  r = await api(`/pms/hr/kra-library/entry/${row.id}`, { method: 'PUT', body: JSON.stringify({
    title: 'Code Quality & Reviews' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entry.keywords, ['code review', 'unit testing']);

  // And an explicit empty clears.
  r = await api(`/pms/hr/kra-library/entry/${row.id}`, { method: 'PUT', body: JSON.stringify({
    title: 'Code Quality & Reviews', keywords: '' }) });
  assert.deepEqual(r.body.entry.keywords, []);
});

test('the edit is audited with the keywords before and after', { skip }, async () => {
  // A published shelf shapes everybody's objectives, and in phase 2 it
  // will shape a rating. "What did this used to say" has to be
  // answerable.
  const rows = (await db.query(
    `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='KRA_LIBRARY_ENTRY_EDITED'
      ORDER BY at DESC LIMIT 5`, [tenantId])).rows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r) => Array.isArray(r.details.after.keywords)),
    'keywords travel in the audit entry');
});

test('BULK: the preview writes nothing', { skip }, async () => {
  // A bulk edit over hundreds of rows that cannot be inspected first is
  // one typo away from a day of cleanup.
  const r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Software Developer', mode: 'add', keywords: 'Development, Sprint Execution',
    dry_run: true }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.dry_run, true);
  assert.equal(r.body.matched, 3, 'the three Software Developer rows');
  assert.equal(r.body.changing, 3);
  assert.ok(r.body.changes[0].before && r.body.changes[0].after, 'before and after, per row');

  const after = (await db.query(
    `SELECT count(*)::int AS n FROM pms.kra_library
      WHERE tenant_id=$1 AND cardinality(keywords) > 0`, [tenantId])).rows[0].n;
  assert.equal(after, 0, 'nothing was written');
});

test('BULK: the filter narrows, and leaves everything else alone', { skip }, async () => {
  const r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Software Developer', mode: 'add', keywords: 'Development' }) });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 3);

  // Support Engineer rows are untouched, including the one that shares
  // a title with a Software Developer row — the case a title-only
  // filter would get wrong.
  const shared = (await db.query(
    `SELECT designation, keywords FROM pms.kra_library
      WHERE tenant_id=$1 AND title='Client Project Delivery' ORDER BY designation`, [tenantId])).rows;
  assert.deepEqual(shared.find((x) => x.designation === 'Software Developer').keywords, ['development']);
  assert.deepEqual(shared.find((x) => x.designation === 'Support Engineer').keywords, []);
});

test('BULK: filters AND together', { skip }, async () => {
  const r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Software Developer', category: 'People', mode: 'add', keywords: 'Coaching' }) });
  assert.equal(r.body.matched, 1, 'only the People row for that designation');
  assert.equal(r.body.changed, 1);
  assert.deepEqual((await keywordsOf('Mentoring'))[0], ['development', 'coaching']);
});

test('BULK: add is idempotent, so running it twice changes nothing', { skip }, async () => {
  const r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Software Developer', mode: 'add', keywords: 'Development' }) });
  assert.equal(r.body.matched, 3);
  assert.equal(r.body.changed, 0, 'nothing moved, so nothing was written');
});

test('BULK: remove takes out only the named keyword', { skip }, async () => {
  const r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Software Developer', mode: 'remove', keywords: 'Development' }) });
  assert.equal(r.body.changed, 3);
  assert.deepEqual((await keywordsOf('Mentoring'))[0], ['coaching'], 'the other keyword survives');
});

test('BULK: clearing everything has to be confirmed', { skip }, async () => {
  let r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    mode: 'replace', keywords: '' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /clear the keywords on every matching KRA/);
  assert.deepEqual((await keywordsOf('Mentoring'))[0], ['coaching'], 'and nothing was cleared');

  r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Software Developer', mode: 'replace', keywords: '', confirm_clear: true }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await keywordsOf('Mentoring'))[0], []);
});

test('BULK: a title filter treats the search text as data, not syntax', { skip }, async () => {
  // '%' unescaped matches every row, so a bulk apply searching for it
  // would silently tag the whole shelf.
  const r = await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    title_contains: '%', mode: 'add', keywords: 'x', dry_run: true }) });
  assert.equal(r.body.matched, 0, 'a literal percent matches no title here');
});

test('the summary counts coverage and the keywords actually in use', { skip }, async () => {
  await api('/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({
    designation: 'Support Engineer', mode: 'replace', keywords: 'Ticketing, Client Support' }) });
  const r = await api('/pms/hr/kra-library/keywords/summary');
  assert.equal(r.body.total, 5);
  assert.equal(r.body.with_keywords, 2, 'the two Support Engineer rows');
  assert.equal(r.body.coverage_pct, 40);
  const words = Object.fromEntries(r.body.keywords.map((x) => [x.keyword, x.kras]));
  assert.equal(words.ticketing, 2);
  assert.equal(words['client support'], 2);
  const se = r.body.by_designation.find((d) => d.designation === 'Support Engineer');
  assert.equal(se.with_keywords, 2);
  assert.ok(r.body.categories.includes('Delivery'), 'the filter dropdowns are fed from real data');
});

test('the value-add list is editable and audited', { skip }, async () => {
  const r = await api('/pms/hr/kra-library/value-add-keywords', { method: 'PUT', body: JSON.stringify({
    keywords: 'Automation, Critical Fix, Critical Fix, Patent' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.value_add_keywords, ['automation', 'critical fix', 'patent'],
    'normalised and de-duplicated like any other keyword list');
  const back = await api('/pms/hr/kra-library/keywords/summary');
  assert.deepEqual(back.body.value_add_keywords, ['automation', 'critical fix', 'patent']);

  let rows = [];
  for (let i = 0; i < 40 && rows.length === 0; i++) {
    rows = (await db.query(
      `SELECT details FROM pms.audit_log WHERE tenant_id=$1 AND action='TIMESHEET_VALUE_ADD_KEYWORDS_SET'`,
      [tenantId])).rows;
    if (!rows.length) await new Promise((res) => setTimeout(res, 50));
  }
  assert.ok(rows.length >= 1, 'the list that will drive an A+ is audited when it changes');
});

test('editing the value-add list does not disturb the other timesheet settings', { skip }, async () => {
  // It shares a settings blob with the cycle start day, the thresholds
  // and the holidays. Writing the whole object back without merging
  // would silently reset a tenant's compliance configuration.
  await db.query(
    `INSERT INTO core.admin_settings (tenant_id, key, value)
     VALUES ($1,'timesheet',$2::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value`,
    [tenantId, JSON.stringify({ cycle_start_day: 16, green_pct: 88, amber_pct: 70,
      holidays: ['2026-01-26'], value_add_keywords: ['automation'] })]);

  await api('/pms/hr/kra-library/value-add-keywords', { method: 'PUT', body: JSON.stringify({
    keywords: 'Innovation' }) });

  const v = (await db.query(
    `SELECT value FROM core.admin_settings WHERE tenant_id=$1 AND key='timesheet'`, [tenantId])).rows[0].value;
  assert.equal(v.cycle_start_day, 16, 'the cycle start day survives');
  assert.equal(v.green_pct, 88);
  assert.deepEqual(v.holidays, ['2026-01-26'], 'and the holidays');
  assert.deepEqual(v.value_add_keywords, ['innovation']);
});

test('none of this is reachable without pms_admin', { skip }, async () => {
  // The shelf shapes everybody's objectives and, in phase 2, a rating.
  for (const [path, opts] of [
    ['/pms/hr/kra-library/keywords/summary', {}],
    ['/pms/hr/kra-library/keywords/bulk', { method: 'POST', body: JSON.stringify({ mode: 'add', keywords: 'x' }) }],
    ['/pms/hr/kra-library/value-add-keywords', { method: 'PUT', body: JSON.stringify({ keywords: 'x' }) }],
  ]) {
    assert.equal((await api(path, opts, 'plain')).status, 403, path);
  }
});

test('an employee KRA can carry its own keywords, apart from the shelf', { skip }, async () => {
  // A KRA can be written by hand with no library row behind it, and one
  // person's "Client Delivery" involves different task names from
  // another's. Editing the shelf must not rewrite what a past month was
  // scored against.
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='pms' AND table_name='kras' AND column_name='keywords'`)).rowCount;
  assert.equal(cols, 1, 'pms.kras carries its own keywords column');
  const d = (await db.query(
    `SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_schema='pms' AND table_name='kras' AND column_name='keywords'`)).rows[0];
  assert.equal(d.is_nullable, 'NO');
  assert.match(d.column_default, /\{\}/, 'defaults to empty, never null — no null checks downstream');
});
