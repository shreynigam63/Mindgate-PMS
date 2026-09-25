// node --test — the controls added on 25 Sep, in a real browser.
//
//   1  "there is not delete option for deleting multiple files"
//   4  "there should be delete list option ... and add option for
//       adding single employee as currently we don't have any
//       integration to HRMS software"
//
// A server test cannot see a checkbox, and the one bug that actually
// bit while building this is invisible to every other kind of test: a
// field component declared inside its parent is a new component type on
// every render, so React remounts the input on each keystroke and the
// field loses focus after one character. That is why the add-form test
// types a whole name and reads it back.
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

async function open(path) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@shot.in', password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  return { ctx, page, errors };
}

test('Employees offers an Add form whose fields keep focus while you type', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('/admin/directory');
  await page.getByRole('button', { name: /Add employee/ }).first().click();
  await page.waitForTimeout(400);
  const box = page.locator('label:has-text("Full name") input');
  assert.equal(await box.count(), 1, 'the add form is open');
  await box.click();
  await page.keyboard.type('Priya Deshpande', { delay: 30 });
  assert.equal(await box.inputValue(), 'Priya Deshpande',
    'the whole name arrived — a field that remounts per keystroke keeps only the last character');
  // The fields the importer needs, so the two paths stay comparable.
  // Read the labels off the form rather than probing for each one:
  // :has-text is a substring match, and "Office email"'s own hint
  // mentions an employee code, so probing matched two labels.
  const labels = await page.locator('label').evaluateAll(
    (ls) => ls.filter((l) => l.querySelector('input')).map((l) => l.childNodes[0].textContent.trim()));
  for (const want of ['Full name *', 'Office email', 'Employee code', 'Department', 'Designation',
    'Role band', "Manager's email", 'Date of joining']) {
    assert.ok(labels.includes(want), `${want} is on the form — got ${JSON.stringify(labels)}`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Employees can select rows and offers both deletes', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('/admin/directory');
  const boxes = page.locator('tbody input[type=checkbox]');
  const n = await boxes.count();
  assert.ok(n > 1, 'there are rows to tick');
  // Nothing ticked: no bulk button, so it cannot be pressed by accident.
  assert.equal(await page.getByRole('button', { name: /Delete \d+ selected/ }).count(), 0);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('button', { name: /Delete 2 selected/ }).count(), 1);
  // And the whole-list control names the count it would destroy.
  const clear = page.getByRole('button', { name: /Delete the whole list/ });
  assert.equal(await clear.count(), 1);
  assert.ok((await clear.innerText()).includes(`(${n})`),
    `the clear button names the count — got ${JSON.stringify(await clear.innerText())}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Career Pathing Matrix says what the suggested draft is built from', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('/admin/career-transitions');
  const main = await page.locator('main').innerText();
  // Point 3: the draft follows the employee list, and now says so.
  assert.match(main, /Right now that is \d+ active employee/);
  assert.match(main, /rebuilt on every click, never stored/);
  // Point 2: and it no longer promises blank departments.
  assert.match(main, /every row\s*names a department/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Career Pathing Matrix can delete a selection', async (t) => {
  if (needStack(t)) return;
  // Seeds its OWN row through the API and deletes that one, so the test
  // leaves the demo tenant exactly as it found it. The first cut ticked
  // whatever happened to be first and ate a transition on every run,
  // which made the count it asserted depend on how often it had run.
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@shot.in', password: PASS }),
  })).json()).token;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const marker = `ZZ Bulk Probe ${Date.now()}`;
  await fetch(`${API}/api/v1/people/career/transitions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ department: 'ZZ Probe', from_role: marker, to_role: `${marker} Senior` }),
  });

  const { ctx, page, errors } = await open('/admin/career-transitions');
  const before = await page.locator('input[type=checkbox][aria-label^="Select "]').count();
  const del = page.getByRole('button', { name: /Delete selected/ });
  assert.equal(await del.isDisabled(), true, 'nothing ticked, nothing to press');

  const mine = page.locator(`input[type=checkbox][aria-label="Select ${marker} to ${marker} Senior"]`);
  assert.equal(await mine.count(), 1, 'the seeded row is on screen');
  await mine.check();
  await page.waitForTimeout(250);
  assert.equal(await del.isEnabled(), true);
  assert.match(await page.locator('main').innerText(), /1 selected/);

  page.once('dialog', (d) => d.accept());
  await del.click();
  await page.waitForTimeout(1500);
  const after = await page.locator('input[type=checkbox][aria-label^="Select "]').count();
  assert.equal(after, before - 1, 'exactly the ticked row went');
  assert.ok(!(await page.locator('main').innerText()).includes(marker), 'and it is gone from the list');
  assert.ok((await page.getByRole('button', { name: /Clear the whole matrix/ }).innerText()).includes(`(${after})`),
    'the clear button follows the new count');
  assert.deepEqual(errors, []);
  await ctx.close();
});
