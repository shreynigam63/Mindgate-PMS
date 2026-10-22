// node --test — Log Title is the KRA (22 Oct), over the real HTTP surface.
//
// "In download template log title should be use as KRA title and KRA
// coverage will be mapped accordingly instead of item used as KRA
// coverage." Pinned end to end, the way HR uses it:
//
//   1. the one-person template lists that person's KRA titles, and its
//      Log Title column offers them; the bulk one lists everybody's;
//   2. "Check the file" says which rows name one of their owner's KRAs,
//      which are blank, and which name something that is not their KRA;
//   3. KRA coverage places each log by its Log Title, before the item
//      name, keywords or a manager's mapping — and a Log Title that is not
//      a KRA is reported, not guessed past;
//   4. HR's mapping backlog counts those hours as placed.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');

const HAS_DB = !!process.env.DATABASE_URL;
const skip = !HAS_DB && 'DATABASE_URL not set';

let db, server, base, tenantId, tok = {};
let ids = {};

before(async () => {
  if (!HAS_DB) return;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tslt';
  process.env.TENANT_SLUG = 'tslt-test-' + Date.now();
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

  const add = async (name, email, extra = {}) => (await db.query(
    `INSERT INTO core.employees (tenant_id, name, email, status, department, designation, manager_id)
     VALUES ($1,$2,$3,'active','Delivery',$4,$5) RETURNING id`,
    [t.id, name, email, extra.designation || 'Support Engineer', extra.manager || null])).rows[0].id;
  ids.mgr = await add('LT Manager', 'lt-mgr@x.com', { designation: 'Delivery Manager' });
  ids.emp = await add('LT Employee', 'lt-emp@x.com', { manager: ids.mgr });
  ids.nokra = await add('LT NoKras', 'lt-nokra@x.com', { manager: ids.mgr });
  ids.hr = await add('LT HR', 'lt-hr@x.com', { designation: 'Head of HR' });

  await db.query(`INSERT INTO core.user_roles (tenant_id, email, role) VALUES ($1,'lt-hr@x.com','hr'),($1,'lt-mgr@x.com','manager')`, [t.id]);
  const hash = await bcrypt.hash('pass', 10);
  for (const e of ['lt-mgr@x.com', 'lt-emp@x.com', 'lt-hr@x.com']) {
    await db.query(`INSERT INTO core.local_credentials (tenant_id, email, password_hash) VALUES ($1,$2,$3)`, [t.id, e, hash]);
  }

  const cycle = (await db.query(
    `INSERT INTO pms.cycles (tenant_id, name, fiscal_year, phase, opens_at, closes_at)
     VALUES ($1,'FY26','2026-27','manager_eval','2026-04-01','2027-03-31') RETURNING id`, [t.id])).rows[0];
  ids.cycle = cycle.id;
  const sheet = (await db.query(
    `INSERT INTO pms.kra_sheets (tenant_id, cycle_id, employee_id, status) VALUES ($1,$2,$3,'approved') RETURNING id`,
    [t.id, cycle.id, ids.emp])).rows[0];
  ids.kra = {};
  let i = 0;
  // Keywords on Ticket Resolution, so a log that mentions "ticket" would be
  // placed there by keyword — unless its Log Title says otherwise.
  for (const [title, weight, kw] of [
    ['Code review, security & architectural compliance', 50, []],
    ['Ticket Resolution', 30, ['ticket']],
    ['Client Reporting', 20, []]]) {
    ids.kra[title] = (await db.query(
      `INSERT INTO pms.kras (tenant_id, sheet_id, title, weight, sort_order, keywords) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [t.id, sheet.id, title, weight, (i += 10), kw])).rows[0].id;
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
  tok.hr = await login('lt-hr@x.com');
  tok.mgr = await login('lt-mgr@x.com');
  tok.emp = await login('lt-emp@x.com');
});

after(async () => { if (server) server.close(); });

const api = async (path, opts = {}, who = 'hr') => {
  const r = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}`, ...(opts.headers || {}) },
  });
  return { status: r.status, body: await r.json() };
};
const template = async (employeeId) => {
  const r = await fetch(`${base}/pms/timesheet/template.xlsx${employeeId ? `?employee_id=${employeeId}` : ''}`,
    { headers: { Authorization: `Bearer ${tok.hr}` } });
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  return wb;
};
const sendWorkbook = async (wb, q) => {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())]), 'timesheet_upload_template.xlsx');
  const r = await fetch(`${base}/pms/timesheet/upload?${q}`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok.hr}` }, body: fd,
  });
  return { status: r.status, body: await r.json() };
};
const WIN = 'from=2026-08-21&to=2026-09-20';

// The one-person template filled in as HR would: rows 8–12.
//   8  Log Title = a KRA, typed in another case with a full stop
//   9  Log Title = a KRA, the item named something else entirely
//  10  Log Title that is NOT one of their KRAs (a typo)
//  11  no Log Title, the item named after a KRA — placed as before
//  12  Log Title = a KRA whose item mentions "ticket", a keyword of ANOTHER KRA
async function filledFor(employeeId) {
  const wb = await template(employeeId);
  const ws = wb.getWorksheet('Main');
  const row = (r, date, hours, itemId, item, title) => {
    ws.getCell(`N${r}`).value = 'LT Employee';
    ws.getCell(`AX${r}`).value = 'lt-emp@x.com';
    ws.getCell(`O${r}`).value = date;
    ws.getCell(`G${r}`).value = String(hours);
    ws.getCell(`A${r}`).value = itemId;
    ws.getCell(`B${r}`).value = item;
    if (title) ws.getCell(`D${r}`).value = title;
  };
  row(8, '01/Sep/2026', 8, 'PR-1', 'Payment gateway PR reviews', 'code review, security & architectural compliance.');
  row(9, '02/Sep/2026', 6, 'OPS-7', 'Night support rota', 'Ticket Resolution');
  row(10, '03/Sep/2026', 4, 'OPS-8', 'Weekly status deck', 'Client Reportng');
  row(11, '04/Sep/2026', 5, 'REP-2', 'Client Reporting', null);
  row(12, '07/Sep/2026', 3, 'PR-2', 'ticket triage tooling review', 'Code review, security & architectural compliance');
  return wb;
}

test('the one-person template lists THEIR KRA titles, and the Log Title column offers them', { skip }, async () => {
  const wb = await template(ids.emp);
  const list = wb.getWorksheet('KRA titles');
  assert.ok(list, 'a KRA titles sheet');
  const titles = [];
  list.eachRow((r, n) => { if (n > 1 && r.getCell(1).value) titles.push(r.getCell(1).value); });
  assert.deepEqual(titles.sort(), ['Client Reporting', 'Code review, security & architectural compliance', 'Ticket Resolution']);
  const main = wb.getWorksheet('Main');
  assert.equal(main.getCell('D7').value, 'Log Title');
  const dv = main.dataValidations.find('D8:D20000') || main.getCell('D8').dataValidation;
  assert.ok(dv, 'Log Title has a list');
  assert.equal(dv.type, 'list');
  assert.match(dv.formulae[0], /'KRA titles'!\$A\$2:\$A\$4/);
  const help = [];
  wb.getWorksheet('How to fill this in').eachRow((r) => help.push(r.values.slice(1).join(' | ')));
  assert.ok(help.some((l) => /For LT Employee/.test(l)));
  assert.ok(help.some((l) => /Log Title \(column D\) \| one of their 3 KRA titles/.test(l)));
  assert.ok(!help.some((l) => /Self → Timesheet/.test(l)), 'the help no longer sends anyone to upload on Self');
});

test('the bulk template lists every KRA title, and whose each one is', { skip }, async () => {
  const wb = await template(null);
  const list = wb.getWorksheet('KRA titles');
  const people = [];
  list.eachRow((r, n) => { if (n > 1 && r.getCell(3).value) people.push(`${r.getCell(3).value}: ${r.getCell(5).value}`); });
  assert.equal(people.length, 3);
  assert.ok(people.includes('LT Employee: Ticket Resolution'));
  const help = [];
  wb.getWorksheet('How to fill this in').eachRow((r) => help.push(r.values.slice(1).join(' | ')));
  assert.ok(help.some((l) => /For everyone in the file/.test(l)));
});

test('a person with no KRAs gets a template that says so, with no list to pick from', { skip }, async () => {
  const wb = await template(ids.nokra);
  const main = wb.getWorksheet('Main');
  assert.equal(main.getCell('D8').dataValidation, undefined);
  const text = [];
  wb.getWorksheet('KRA titles').eachRow((r) => text.push(String(r.getCell(1).value)));
  assert.ok(text.some((l) => /LT NoKras has no KRAs on their sheet/.test(l)));
});

test('CHECK THE FILE says which Log Titles are KRAs, which are blank, and which are not', { skip }, async () => {
  const r = await sendWorkbook(await filledFor(ids.emp), `employee_id=${ids.emp}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.loadable, 5, 'every row loads — the hours are real');
  assert.equal(r.body.log_titles.with_kra_title, 3);
  assert.equal(r.body.log_titles.blank, 1);
  assert.equal(r.body.log_titles.not_a_kra_total, 1);
  assert.deepEqual(r.body.log_titles.not_a_kra.map((x) => [x.line, x.log_title]), [[10, 'Client Reportng']]);
  assert.match(r.body.log_titles.not_a_kra[0].reason, /not one of LT Employee's KRA titles/);
});

test('the Log Title is stored with each log', { skip }, async () => {
  const r = await sendWorkbook(await filledFor(ids.emp), `commit=1&employee_id=${ids.emp}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = (await db.query(
    `SELECT item_id, log_title FROM pms.timesheet_entries WHERE tenant_id=$1 AND employee_id=$2 ORDER BY log_date`,
    [tenantId, ids.emp])).rows;
  assert.deepEqual(rows.map((x) => [x.item_id, x.log_title]), [
    ['PR-1', 'code review, security & architectural compliance.'],
    ['OPS-7', 'Ticket Resolution'],
    ['OPS-8', 'Client Reportng'],
    ['REP-2', null],
    ['PR-2', 'Code review, security & architectural compliance'],
  ]);
});

test('KRA COVERAGE PLACES EACH LOG BY ITS LOG TITLE — before the item name and the keywords', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`);
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.body.items.map((i) => [i.item_id, i]));
  assert.equal(by['PR-1'].how, 'log_title');
  assert.equal(by['PR-1'].kra_title, 'Code review, security & architectural compliance');
  assert.equal(by['PR-1'].item_label, 'Payment gateway PR reviews', 'the item keeps its own name');
  assert.equal(by['OPS-7'].how, 'log_title');
  assert.equal(by['OPS-7'].kra_title, 'Ticket Resolution');
  // "ticket" is a Ticket Resolution keyword; the Log Title says Code review.
  assert.equal(by['PR-2'].how, 'log_title');
  assert.equal(by['PR-2'].kra_title, 'Code review, security & architectural compliance');
  // Not a KRA title: reported, not guessed from anything else.
  assert.equal(by['OPS-8'].how, 'unmapped');
  assert.equal(by['OPS-8'].log_title, 'Client Reportng');
  assert.match(by['OPS-8'].log_title_problem, /not one of this person's KRA titles/);
  // No Log Title: the item is named after a KRA, placed as before.
  assert.equal(by['REP-2'].how, 'title');
  assert.equal(by['REP-2'].kra_title, 'Client Reporting');
  const hours = Object.fromEntries(r.body.by_kra.map((k) => [k.title, k.hours]));
  assert.deepEqual(hours, {
    'Code review, security & architectural compliance': 11, 'Ticket Resolution': 6, 'Client Reporting': 5,
  });
  assert.equal(r.body.totals.unmapped, 4);
  assert.deepEqual(r.body.totals.log_title, { placed: 17, not_a_kra: 4, blank: 5 });
});

test('a manager can map a log whose Log Title is not a KRA; a mapping cannot overrule one that is', { skip }, async () => {
  const before = await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`);
  const typo = before.body.items.find((i) => i.item_id === 'OPS-8');
  const titled = before.body.items.find((i) => i.item_id === 'OPS-7');
  for (const [it, kra] of [[typo, 'Client Reporting'], [titled, 'Client Reporting']]) {
    const m = await api(`/pms/timesheet/kra/employee/${ids.emp}/map`, {
      method: 'PUT', body: JSON.stringify({ item_key: it.item_key, decision: 'kra', kra_id: ids.kra[kra], item_label: it.item_label }),
    }, 'mgr');
    assert.equal(m.status, 200, JSON.stringify(m.body));
  }
  const r = await api(`/pms/timesheet/kra/employee/${ids.emp}?${WIN}`);
  const by = Object.fromEntries(r.body.items.map((i) => [i.item_id, i]));
  assert.equal(by['OPS-8'].how, 'mapped');
  assert.equal(by['OPS-8'].kra_title, 'Client Reporting');
  assert.equal(by['OPS-7'].how, 'log_title', 'the Log Title still decides');
  assert.equal(by['OPS-7'].kra_title, 'Ticket Resolution');
});

test('HR\'s mapping backlog counts Log-Title hours as placed', { skip }, async () => {
  const r = await api(`/pms/timesheet/kra/backlog?${WIN}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const me = r.body.people.find((p) => p.employee.id === ids.emp);
  // 11 + 6 by Log Title, 4 mapped by the manager. REP-2 is placed by its
  // name on the KRA screen, but the backlog counts only what was asserted.
  assert.equal(me.mapped_hours, 21);
  assert.equal(me.hours, 26);
  assert.equal(me.unmapped_items, 1);
});
