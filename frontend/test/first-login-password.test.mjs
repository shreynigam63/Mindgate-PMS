// node --test — being made to choose your own password at first sign-in.
//
// Asked for on 27 Sep: "the password for all employees will be their
// name@123 and during login everyone should get change password option
// during first login", compulsory on the client's own answer.
//
// The API tests prove the lock cannot be talked past with a token. What
// only a browser can show is the half a person meets: that signing in
// with the issued password lands on this screen and nothing else, that
// getting the old password wrong says so, and that finishing puts them
// in the app rather than at a dead end.
//
// SELF-CLEANING: its own throwaway employee, erased afterwards.
//
// Skips cleanly when the dev stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

let browser; let up = false; let adminTok;

before(async () => {
  try {
    const r = await fetch(`${API}/api/v1/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return;
    await fetch(APP, { signal: AbortSignal.timeout(2500) });
    adminTok = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
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

const asAdmin = (path, opts = {}) => fetch(`${API}/api/v1${path}`, {
  ...opts, headers: { Authorization: `Bearer ${adminTok}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const signIn = (email, password) => fetch(`${API}/api/v1/auth/dev-login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

async function openAs(token, path = '/home') {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

// A person with a freshly issued name@123 password, cleaned up by the caller.
async function issueTo(first) {
  const stamp = Date.now();
  const name = `${first} Zz${stamp}`;
  const email = `zz-first-${stamp}@shot.in`;
  const made = await (await asAdmin('/employees', {
    method: 'POST', body: JSON.stringify({ name, email, department: 'Delivery', designation: 'Executive' }),
  })).json();
  const r = await (await asAdmin('/employees/credentials/bulk', {
    method: 'POST', body: JSON.stringify({ ids: [made.employee.id], mode: 'name' }),
  })).json();
  return { id: made.employee.id, name, email, password: r.rows[0].password };
}
const erase = (id) => asAdmin(`/employees/${id}?purge=1`, { method: 'DELETE' });

test('the issued password is the first name and @123', async (t) => {
  if (needStack(t)) return;
  const who = await issueTo('Kavita');
  try {
    assert.equal(who.password, 'kavita@123',
      'the rule the client asked for, as the page will hand it out');
  } finally { await erase(who.id); }
});

test('signing in with it opens the change screen and nothing else', async (t) => {
  if (needStack(t)) return;
  const who = await issueTo('Kavita');
  try {
    const tok = (await (await signIn(who.email, who.password)).json()).token;
    const { ctx, page, errors } = await openAs(tok);
    const body = await page.locator('body').innerText();
    assert.match(body, /Choose your own password/i);
    assert.match(body, /set for you by HR/i, 'and says why they are being asked');
    // The app itself is not behind it. A prompt somebody can click past
    // to the product would not be the "compulsory" that was asked for.
    assert.ok(!/My KRAs/.test(body), `the product is not reachable — got ${body.slice(0, 300)}`);
    // Not a trap: somebody who opened the wrong account has a way out.
    assert.match(body, /Sign out instead/);
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await erase(who.id); }
});

test('the old password has to be right, and then the app opens', async (t) => {
  if (needStack(t)) return;
  const who = await issueTo('Kavita');
  try {
    const tok = (await (await signIn(who.email, who.password)).json()).token;
    const { ctx, page, errors } = await openAs(tok);

    const current = page.getByPlaceholder('The password HR gave you');
    const next = page.getByPlaceholder('New password (at least 8 characters)');
    const again = page.getByPlaceholder('New password again');

    // Wrong old password: refused, and still on this screen.
    await current.fill('not-the-one');
    await next.fill('Chosen#2026x');
    await again.fill('Chosen#2026x');
    await page.getByRole('button', { name: /Save my password/ }).click();
    await page.waitForTimeout(1200);
    assert.match(await page.locator('body').innerText(), /not your current password/i);

    // The two new ones not matching is caught before anything is sent.
    await current.fill(who.password);
    await again.fill('Chosen#2026y');
    await page.getByRole('button', { name: /Save my password/ }).click();
    await page.waitForTimeout(600);
    assert.match(await page.locator('body').innerText(), /do not match/i);

    // And done properly, they land in the product.
    await again.fill('Chosen#2026x');
    await page.getByRole('button', { name: /Save my password/ }).click();
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText();
    assert.match(body, /My KRAs/, `the app opened — got ${body.slice(0, 300)}`);
    assert.ok(!/Choose your own password/i.test(body), 'and the screen is gone');

    // The issued password is spent; the chosen one works.
    assert.equal((await signIn(who.email, who.password)).status, 401);
    const back = await signIn(who.email, 'Chosen#2026x');
    assert.equal(back.status, 200);
    assert.equal((await back.json()).user.must_change_password, false, 'and it does not ask twice');

    assert.deepEqual(errors, []);
    await ctx.close();
  } finally { await erase(who.id); }
});

test('anyone can change their password afterwards, from the header', async (t) => {
  if (needStack(t)) return;
  // Added with the forced screen rather than after it: a product where a
  // password can be changed only once, at first sign-in, has no way to
  // change a password.
  const { ctx, page, errors } = await openAs(adminTok);
  // Matched on the accessible name, which is the aria-label rather than
  // the visible word: the button is icon-only on a phone, so the label is
  // what carries its meaning to a screen reader — and to this locator.
  await page.getByRole('button', { name: /Change your password/ }).click();
  await page.waitForTimeout(600);
  assert.match(await page.locator('body').innerText(), /Change your password/i);
  await page.getByRole('button', { name: /Cancel/ }).click();
  await page.waitForTimeout(800);
  const body = await page.locator('body').innerText();
  assert.ok(!/Change your password/i.test(body), 'and cancelling puts them back');
  assert.match(body, /My KRAs/);
  assert.deepEqual(errors, []);
  await ctx.close();
});
