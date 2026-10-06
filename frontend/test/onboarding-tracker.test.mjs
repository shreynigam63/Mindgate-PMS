// node --test — the First-Week Journey (onboarding tracker), in a real
// browser, under New Hire Insights in both the HR and HRBP groups.
//
// Asked for on 6 Oct: "It should be available under hiring insights tab
// available in HRBP and HR tab." These pin that it IS there, on both
// routes, opens first, and that a joiner's week opens from the list.
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
  const t = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  return { ctx, page, errors };
}

for (const [who, path] of [['hr@shot.in', '/admin/engagement-insights'], ['hrbp@shot.in', '/hrbp/engagement-insights']]) {
  test(`${path} opens on the First-Week Journey, with the workbook's dashboard`, async (t) => {
    if (needStack(t)) return;
    const { ctx, page, errors } = await open(who, path);
    const main = await page.locator('main').innerText();
    assert.ok(!/not part of your access/i.test(main), `${who} must be able to open ${path}`);
    assert.match(main, /First-Week Journey/);
    assert.match(main, /Survey Insights/, 'the survey half is still one click away');
    for (const card of ['Joiners in onboarding', 'Activities due today', 'Overdue activities', 'Overall completion']) {
      assert.ok(main.includes(card), `the ${card} card`);
    }
    assert.match(main, /New joiners/);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('a joiner\'s week opens from the list, day by day, with the Day-7 feedback', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/engagement-insights');
  const row = page.locator('main tr.cursor-pointer').first();
  if (!(await row.count())) { t.skip('no joiner on the local tracker'); await ctx.close(); return; }
  await row.click();
  await page.waitForTimeout(1200);
  const main = await page.locator('main').innerText();
  assert.match(main, /Pre-Day 1 · Readiness/);
  assert.match(main, /Day 7 · Feedback & Alignment/);
  assert.match(main, /Day-7 feedback/);
  assert.match(main, /All joiners/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the page search finds it, and the sidebar names it', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/home');
  await page.getByLabel('Search pages').fill('new hire');
  await page.waitForTimeout(300);
  await page.locator('.topsearch-pop button').first().click();
  await page.waitForTimeout(1200);
  assert.match(page.url(), /engagement-insights/);
  assert.equal(await page.locator('aside a[href$="/engagement-insights"]').count() >= 1, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
