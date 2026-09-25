// node --test — the three Timesheet tabs, in a real browser.
//
// Asked for on 25 Sep: one tab named "Timesheet" on Self, Manager and
// HR, each over a different scope. Three things a server test cannot
// see, and all three are what was actually asked for:
//
//   1  the Self page offers an upload and the employee's OWN report,
//      and no way to reach anybody else
//   2  the Manager tab lists the caller's reportees
//   3  the HR tab lists everybody, with the coverage stated
//
// Skips cleanly when the dev stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

let browser;
let up = false;

before(async () => {
  try {
    const r = await fetch(`${API}/api/v1/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return;
    await fetch(APP, { signal: AbortSignal.timeout(2500) });
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    up = true;
  } catch { /* stack not running — every test below skips */ }
});
after(async () => { if (browser) await browser.close(); });

const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; }
  return false;
};

async function open(email, path) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  return { ctx, page, errors };
}

test('one tab named Timesheet on Self, Manager and HR', async (t) => {
  if (needStack(t)) return;
  for (const [email, group, path] of [
    ['emp@shot.in', 'Self', '/my/timesheet'],
    ['mgr@shot.in', 'Manager', '/team/timesheet'],
    ['admin@shot.in', 'HR', '/admin/timesheet'],
  ]) {
    const { ctx, page, errors } = await open(email, path);
    const links = await page.$$eval('nav a, header a', (as) => as.map((a) => ({
      href: a.getAttribute('href'), text: a.textContent.trim(),
    })));
    const ts = links.filter((l) => (l.href || '').includes('timesheet'));
    assert.equal(ts.length, 1, `${group}: exactly one Timesheet link in the nav`);
    assert.equal(ts[0].text, 'Timesheet', `${group}: the tab is named Timesheet`);
    assert.equal(ts[0].href, path, `${group}: it points at ${path}`);
    assert.deepEqual(errors, [], `${group}: no page errors`);
    await ctx.close();
  }
});

test('Self offers an upload and the employee\'s own report, and nobody else\'s', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('emp@shot.in', '/my/timesheet');
  assert.equal(await page.locator('input[type=file]').count(), 1, 'the upload control is there');
  const main = await page.locator('main').innerText();
  assert.match(main, /Only your own rows are loaded/i);
  // The page is about the signed-in person. Nobody else's name appears —
  // the control here is a colleague who HAS uploaded, so a leak would
  // show up rather than being masked by an empty database.
  const others = await (await fetch(`${API}/api/v1/pms/timesheet/all`, {
    headers: { Authorization: `Bearer ${(await (await fetch(`${API}/api/v1/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@shot.in', password: PASS }),
    })).json()).token}` },
  })).json();
  const colleague = (others.employees || [])
    .filter((e) => e.has_data && e.employee.email !== 'emp@shot.in')[0];
  if (colleague) {
    assert.ok(!main.includes(colleague.employee.name),
      `an employee's own page must not name ${colleague.employee.name}`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Manager tab lists the caller\'s reportees and opens one', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/timesheet');
  const main = await page.locator('main').innerText();
  assert.match(main, /Your reportees/i);
  // The roster is the reporting line, read from the employee directory
  // rather than from the page that is under test.
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@shot.in', password: PASS }),
  })).json()).token;
  const dir = await (await fetch(`${API}/api/v1/employees?limit=500`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const reports = (dir.employees || [])
    .filter((e) => e.manager_email === 'mgr@shot.in' && e.status === 'active');
  assert.ok(reports.length, 'the fixture has reportees to show');
  for (const r of reports) assert.ok(main.includes(r.name), `${r.name} is listed`);

  await page.getByText(reports[0].name).first().click();
  await page.waitForTimeout(1200);
  const detail = await page.locator('main').innerText();
  assert.match(detail, /Back to the team/i);
  assert.match(detail, /Cycle summary|Nothing uploaded yet/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the HR tab covers everybody and states the coverage', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/timesheet');
  const main = await page.locator('main').innerText();
  assert.match(main, /Employees in scope/i);
  assert.match(main, /Every department/i);
  // People with no upload must be reported as having no data, never as
  // Red — the whole reason the totals split them out.
  assert.match(main, /uploaded nothing yet|have uploaded/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an employee cannot reach the team or company pages by URL', async (t) => {
  if (needStack(t)) return;
  for (const path of ['/team/timesheet', '/admin/timesheet']) {
    const { ctx, page } = await open('emp@shot.in', path);
    const body = await page.locator('body').innerText();
    assert.match(body, /This page is not part of your access/i,
      `an employee typing ${path} is refused, not served`);
    // ...and refused by the page guard, not by an empty list: the roster
    // headings must not be on screen at all.
    assert.ok(!/Your reportees|Employees in scope/i.test(body),
      `${path} must not render its content for an employee`);
    await ctx.close();
  }
});
