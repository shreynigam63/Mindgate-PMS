// node --test — signing in with a password the browser filled in (26 Oct).
//
// "Still only email is saved, password is not saved for login." A browser
// that fills a saved password puts it in the box without telling the page
// (no input event) until the person clicks. The sign-in read its own copy,
// still empty, and answered "Enter your password". This fills both boxes
// the way the browser does — the DOM value set, no event — and signs in.
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
  } catch { /* stack not running */ }
});
after(async () => { if (browser) await browser.close(); });

test('a password filled in by the browser signs in on the first click', async (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return; }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForSelector('input[name=password]');
  // What a password manager does: the values land in the boxes, no events.
  await page.evaluate(([email, pw]) => {
    document.querySelector('input[name=email]').value = email;
    document.querySelector('input[name=password]').value = pw;
  }, ['emp@shot.in', PASS]);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForTimeout(2500);
  const body = (await page.textContent('body')).replace(/\s+/g, ' ');
  assert.ok(!/Enter your password/.test(body), 'a filled password was read as empty');
  assert.ok(await page.evaluate(() => !!localStorage.getItem('apms_token')), 'signed in');
  await ctx.close();
});

test('the form is one the browser can save: a username box and a current-password box', async (t) => {
  if (!up) { t.skip('dev stack not running'); return; }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForSelector('form input[name=password]');
  const f = await page.evaluate(() => ({
    user: document.querySelector('form input[name=email]').getAttribute('autocomplete'),
    pw: document.querySelector('form input[name=password]').getAttribute('autocomplete'),
    type: document.querySelector('form input[name=password]').type,
  }));
  assert.deepEqual(f, { user: 'username', pw: 'current-password', type: 'password' });
  await ctx.close();
});
