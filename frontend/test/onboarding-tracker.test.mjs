// node --test — the First-Week Journey (onboarding tracker), in a real
// browser, under New Hire Insights in both the HR and HRBP groups.
//
// Asked for on 6 Oct: "It should be available under hiring insights tab
// available in HRBP and HR tab." These pin that it IS there, on both
// routes, opens first, and that a joiner's week opens from the list.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

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

// The First-Week Journey is hidden on screen while this switch is off
// (src/features.js, 8 Oct); its tests then only check it stays hidden.
const SHOWN = /SHOW_FIRST_WEEK_JOURNEY\s*=\s*true/.test(readFileSync(new URL('../src/features.js', import.meta.url), 'utf8'));
const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; }
  if (!SHOWN) { t.skip('First-Week Journey is switched off in src/features.js'); return true; }
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
  assert.match(main, /Day 1 · Readiness, Welcome/i);
  assert.match(main, /Before joining — readiness/i);
  assert.ok(!/Pre-Day 1/.test(main), 'no Pre-Day 1 any more');
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

// Corrected on 7 Oct: the first-week emails go TO the joiner, FROM the
// SPOC who owns the activity; the tick belongs to HR Ops, HR and HRBP.
test('a task\'s email is addressed to the joiner, from the activity\'s SPOC', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/engagement-insights');
  const row = page.locator('main tr.cursor-pointer').first();
  if (!(await row.count())) { t.skip('no joiner on the local tracker'); await ctx.close(); return; }
  const joiner = (await row.locator('td span.font-semibold').first().innerText()).trim();
  await row.click();
  await page.waitForTimeout(1200);
  assert.match(await page.locator('main').innerText(), /Personal email \(before joining\)/i);
  const btn = page.getByRole('button', { name: /Email joiner · from / }).first();
  await btn.click();
  await page.waitForTimeout(1000);
  const box = await page.locator('main .bg-\\[\\#f8faff\\]').first().innerText();
  assert.match(box, /From/i);
  assert.match(box, /To/i);
  assert.match(await page.getByLabel('Message').first().inputValue(), /^Dear /, 'the draft is written to the joiner');
  assert.ok(box.includes(joiner), `the email goes to ${joiner}`);
  assert.ok(!/Email SPOC/.test(await page.locator('main').innerText()), 'the old "Email SPOC" wording is gone');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('HR Ops has the tracker as its own page, and may tick tasks', async (t) => {
  if (needStack(t)) return;
  const who = process.env.HROPS_EMAIL || 'rohit@shot.in';
  const me = await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: who, password: PASS }),
  })).json();
  if (!me.token || (me.user && me.user.role !== 'hr_ops')) { t.skip(`${who} is not an HR Ops user locally`); return; }
  const { ctx, page, errors } = await open(who, '/hrops/onboarding');
  const main = await page.locator('main').innerText();
  assert.ok(!/not part of your access/i.test(main), 'HR Ops may open /hrops/onboarding');
  assert.match(main, /First-Week Journey/);
  assert.equal(await page.locator('aside a[href="/hrops/onboarding"]').count(), 1, 'the sidebar names it');
  const row = page.locator('main tr.cursor-pointer').first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1200);
    assert.equal(await page.getByRole('button', { name: /^Mark (not )?done$/ }).first().isDisabled(), false, 'HR Ops can tick');
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('HR does not get a second way in — the HR Ops entry is hidden when New Hire Insights is open to you', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('hr@shot.in', '/home');
  assert.equal(await page.locator('aside a[href="/hrops/onboarding"]').count(), 0);
  await ctx.close();
});

test('someone without onboarding_ops cannot open the HR Ops page', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('emp@shot.in', '/hrops/onboarding');
  assert.ok(!/Personal email|Add joiner/i.test(await page.locator('main').innerText()));
  await ctx.close();
});

// 7 Oct: no mail setup — each SPOC sends their onboarding emails from their
// own Gmail, from a list on their Home page.
test('a SPOC finds their onboarding emails on Home, each one opening in their own Gmail', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/home');
  const panel = page.locator('.panel', { hasText: 'Onboarding emails for you to send' });
  if (!(await panel.count())) { t.skip('no onboarding email is due for this manager locally'); await ctx.close(); return; }
  const link = panel.getByRole('link', { name: /Open in Gmail/ }).first();
  const href = await link.getAttribute('href');
  assert.match(href, /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
  const q = new URL(href).searchParams;
  assert.ok(q.get('to'), 'addressed to the joiner');
  assert.match(q.get('body'), /^Dear /);
  assert.equal(q.get('authuser'), 'mgr@shot.in', 'opens in the SPOC\'s own account');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await panel.getByRole('button', { name: /I’ve sent it/ }).count() > 0, true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('while switched off, New Hire Insights shows no First-Week Journey, and HR Ops has no menu entry', async (t) => {
  if (!up) { t.skip('dev stack not running'); return; }
  if (SHOWN) { t.skip('switched on'); return; }
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/engagement-insights');
  const main = await page.locator('main').innerText();
  assert.ok(!/First-Week Journey/.test(main), 'the tab is gone');
  assert.match(main, /New Hire Insights/);
  assert.equal(await page.locator('aside a[href="/hrops/onboarding"]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
