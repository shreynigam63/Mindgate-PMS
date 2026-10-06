// node --test — Home after 6 Oct.
//
// This file pinned the collapsible "Surveys waiting on you" list (asked
// for on 1 Oct). On 6 Oct the client asked for it, and the cycle card
// beside it, to go: "please remove these two tabs from homepage", and for
// Quick Actions to sit "in single line to look better". These tests pin
// that instead — and that a survey is still reachable, since removing a
// prompt must not remove the form.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

let browser; let up = false;
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
const needStack = (t) => { if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; } return false; };

async function open(email, path, width = 1440) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

test('Home no longer carries the survey list or the cycle card', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/home');
  const main = await page.locator('main').innerText();
  assert.ok(!/Surveys waiting on you/.test(main), 'the survey list is gone');
  assert.ok(!/PMS Cycle – Current Status/.test(main), 'and the cycle card');
  assert.match(main, /Quick Actions/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Quick Actions sit on one line on a desktop screen', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('mgr@shot.in', '/home');
  const tops = await page.locator('main a.qa').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.ok(tops.length >= 2, `quick actions are there — got ${tops.length}`);
  assert.equal(new Set(tops).size, 1, `one row, not two — tops were ${tops.join(', ')}`);
  await ctx.close();
});

test('a survey is still one click from the menu', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/engagement');
  assert.ok(!/not part of your access/i.test(await page.locator('main').innerText()), 'My Surveys opens');
  assert.deepEqual(errors, []);
  await ctx.close();
});
