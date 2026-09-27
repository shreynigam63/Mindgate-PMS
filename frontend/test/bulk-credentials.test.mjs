// node --test — creating logins for a lot of people from the Employees page.
//
// Asked for on 27 Sep: "please build create bulk credentials option for
// Admin/HR login so they can create bulk credentials for employees from
// front end."
//
// The API tests prove the rules. What only a browser can prove is the
// part that makes this safe to hand to HR: that nothing is written until
// they have seen the plan, that the people being passed over are named
// on screen, and that the passwords — which exist in readable form for
// exactly one page load — actually come out in the file.
//
// SELF-CLEANING. The commit half creates its own throwaway employee and
// erases them afterwards, so the demo tenant is in the same state before
// and after and the file can be run twice in a row.
//
// Skips cleanly when the dev stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

let browser; let up = false; let token;

before(async () => {
  try {
    const r = await fetch(`${API}/api/v1/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return;
    await fetch(APP, { signal: AbortSignal.timeout(2500) });
    token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@shot.in', password: PASS }),
    })).json()).token;
    browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
    up = true;
  } catch { /* stack not running — every test below skips */ }
});
after(async () => { if (browser) await browser.close(); });

const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; }
  return false;
};

const apiCall = (path, opts = {}) => fetch(`${API}/api/v1${path}`, {
  ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});

async function open(email = 'admin@shot.in') {
  const t = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1500 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(`${APP}/admin/directory`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

// Polls instead of sleeping. The preview is a round trip and the commit
// is a bcrypt run, so a fixed wait is either too short on a slow pass or
// wasted on a fast one — and a too-short one reads as a broken feature.
async function waitForText(locator, re, ms = 15000) {
  const until = Date.now() + ms;
  let last = '';
  while (Date.now() < until) {
    last = await locator.innerText().catch(() => '');
    if (re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${re} — last saw:\n${last.slice(0, 600)}`);
}

const openPanel = async (page) => {
  await page.getByRole('button', { name: /Create logins in bulk/i }).click();
  await page.waitForTimeout(300);
};

test('the panel is on the Employees page and opens', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open();
  assert.equal(await page.getByRole('button', { name: /Create logins in bulk/i }).count(), 1);
  await openPanel(page);
  const main = await page.locator('main').innerText();
  assert.match(main, /A different password for each person/i);
  assert.match(main, /The same password for everyone/i);
  assert.match(main, /replace the password of anyone who already has a login/i);
  // The thing HR has to know before handing these out: each one is spent
  // at the first sign-in, which is what makes a pattern password safe.
  assert.match(main, /used once/i);
  assert.match(main, /nothing in the app opens until they have/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the preview writes nothing and names everyone it is passing over', async (t) => {
  if (needStack(t)) return;
  const before = (await (await apiCall('/employees')).json()).employees.filter((e) => e.has_login).length;

  const { ctx, page, errors } = await open();
  await openPanel(page);
  await page.getByRole('button', { name: /^Preview$/ }).click();
  const panel = page.locator('main .card').filter({ hasText: /Create logins in bulk/ });
  const text = await waitForText(panel, /will get a new login/i);
  assert.match(text, /already have a login/i, 'the people being passed over are counted, not silently dropped');

  // And each of them, by name, with the sentence that explains it.
  await panel.locator('summary', { hasText: /Who, and why/ }).click();
  await page.waitForTimeout(300);
  const detail = await panel.innerText();
  assert.match(detail, /Already has a login/, 'a reason in words, not an outcome code');

  const after = (await (await apiCall('/employees')).json()).employees.filter((e) => e.has_login).length;
  assert.equal(after, before, 'a preview writes nothing at all');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('creating a login for one person gives back a password that works, and a file', async (t) => {
  if (needStack(t)) return;
  // Its own throwaway person, erased at the end, so this can run twice.
  const stamp = Date.now();
  const name = `Zz Bulk ${stamp}`;
  const email = `zz-bulk-${stamp}@shot.in`;
  const made = await (await apiCall('/employees', {
    method: 'POST', body: JSON.stringify({ name, email, department: 'Delivery', designation: 'Executive' }),
  })).json();
  assert.ok(made.employee && made.employee.id, `test employee created — got ${JSON.stringify(made).slice(0, 200)}`);

  const { ctx, page, errors } = await open();
  try {
    // Narrow the table to them and tick their row, so the run is scoped
    // to one person rather than to the whole demo tenant.
    await page.getByPlaceholder('Search employees').fill(name);
    await page.waitForTimeout(500);
    await page.getByRole('checkbox', { name: `Select ${name}` }).check();
    await page.waitForTimeout(300);

    await openPanel(page);
    const panel = page.locator('main .card').filter({ hasText: /Create logins in bulk/ });
    // Case-insensitive: the panel heading is uppercased by CSS, and
    // innerText returns what is rendered, not what is in the markup.
    assert.match(await panel.innerText(), /1 selected employee/i);

    await panel.getByRole('button', { name: /^Preview$/ }).click();
    await waitForText(panel, /1 will get a new login/);

    await panel.getByRole('button', { name: /Create 1 login/ }).click();
    const done = await waitForText(panel, /1 login created/);
    assert.match(done, /only place they can ever be read/i,
      'and it says plainly that the file is the only copy');

    // The password on screen is the password that signs them in. This is
    // the whole feature; everything else is arranging it on a page.
    await panel.locator('summary', { hasText: /Show the passwords on screen/ }).click();
    await page.waitForTimeout(300);
    const shown = await panel.innerText();
    const m = shown.match(new RegExp(`${email} — (\\S+)`));
    assert.ok(m, `the password is shown against the address — got ${shown.slice(0, 300)}`);
    const login = await fetch(`${API}/api/v1/auth/dev-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: m[1] }),
    });
    assert.equal(login.status, 200, 'the password handed to HR actually works');

    // THE RESULT SURVIVES THE LIST REFRESHING UNDERNEATH IT. Committing
    // reloads the table and clears the ticked rows, and an earlier cut
    // treated that as "the inputs changed" and blanked the panel — which
    // threw away the only readable copy of the passwords at the exact
    // moment they were created. Both halves are asserted together: the
    // row behind has caught up, and the passwords are still on screen.
    const row = page.locator('main table tbody tr').filter({ hasText: email });
    assert.match(await row.innerText(), /Active/,
      'the table behind has reloaded and now shows the login');
    assert.ok((await panel.innerText()).includes(m[1]),
      'and the passwords are still readable — a reload must not take them away');

    // The file carries the same thing, because that is what leaves the room.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      panel.getByRole('button', { name: /Download the passwords/ }).click(),
    ]);
    const path = await download.path();
    const csv = (await import('node:fs')).readFileSync(path, 'utf8');
    assert.match(csv, /Employee ID,Name,Email,Department,Password,Note/);
    assert.ok(csv.includes(email) && csv.includes(m[1]),
      'the downloaded file carries the address and its password');
    assert.match(download.suggestedFilename(), /^pms-logins-\d{4}-\d{2}-\d{2}\.csv$/);

    assert.deepEqual(errors, []);
  } finally {
    await ctx.close();
    await apiCall(`/employees/${made.employee.id}?purge=1`, { method: 'DELETE' });
  }
});

test('an employee cannot reach the page that carries it', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('emp@shot.in');
  const main = await page.locator('main').innerText();
  assert.ok(!/Create logins in bulk/i.test(main),
    `the Employees page is HR-only and so is this — got ${main.slice(0, 200)}`);
  await ctx.close();
});
