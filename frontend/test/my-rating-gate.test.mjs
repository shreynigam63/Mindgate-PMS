// node --test — My Rating is closed until a rating is published.
//
// Asked for on 27 Sep: "my rating option should be visible to employee
// only when appraisal is published or it can be unclickable until
// appraisal is published."
//
// Only a browser can check the part that matters. The API answering
// has_published:false is easy; what a person sees is whether the menu
// entry still LEADS anywhere, and whether the greyed thing says what
// opens it or just sits there looking broken.
//
// Two real accounts on the demo tenant, one on each side of the gate:
// admin@shot.in has no published rating, emp@shot.in has one. Nothing is
// written by this file.
//
// Skips cleanly when the dev stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';

// No published rating / one published rating.
const SHUT = 'admin@shot.in';
const OPEN = 'emp@shot.in';

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

async function open(email, path = '/home') {
  const t = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  return { ctx, page, errors };
}

// The menu entry, whichever element it is rendered as.
const navEntry = (page) => page.locator('nav.subnav').getByText('My Rating', { exact: true });

test('with nothing published the menu entry is there, greyed, and leads nowhere', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open(SHUT);

  // STILL THERE. Hiding it was the other option on the table and was not
  // taken: a tab that vanishes makes people ask whether they have lost
  // access. This assertion is what stops a later change quietly hiding it.
  const entry = navEntry(page);
  assert.equal(await entry.count(), 1, 'the entry is present, not removed');

  const holder = entry.locator('xpath=ancestor-or-self::*[contains(@class,"subnav-item")]');
  assert.equal(await holder.getAttribute('aria-disabled'), 'true');
  assert.equal(await holder.evaluate((el) => el.tagName), 'SPAN',
    'not an <a> — a link with a href is still clickable and still navigates');
  assert.match(await holder.getAttribute('title') || '', /once HR publishes/i,
    'and it says what will open it, rather than being silently dead');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the two Home tiles are shut in the same way, and say the same thing', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open(SHUT);

  // The stat card the client circled. It must not be a link.
  const stat = page.locator('main .stat').filter({ hasText: 'My rating' });
  assert.equal(await stat.count(), 1);
  assert.equal(await stat.evaluate((el) => el.tagName), 'DIV',
    'the stat card leads nowhere while there is nothing behind it');
  assert.match(await stat.getAttribute('title') || '', /Opens once HR publishes/i);

  // And the tile in "My performance".
  const tile = page.locator('main .card').filter({ hasText: /^My Rating/ }).first();
  assert.equal(await tile.count(), 1);
  assert.equal(await tile.evaluate((el) => el.tagName), 'DIV', 'locked tiles are not links');
  assert.match(await tile.innerText(), /Opens once HR publishes your appraisal/i);

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('with a rating published everything opens, and the page actually loads', async (t) => {
  if (needStack(t)) return;
  // The gate is only worth having if it lifts. This is the same three
  // surfaces for somebody who HAS a published rating.
  const { ctx, page, errors } = await open(OPEN);

  const holder = navEntry(page).locator('xpath=ancestor-or-self::*[contains(@class,"subnav-item")]');
  assert.equal(await holder.evaluate((el) => el.tagName), 'A', 'the menu entry is a link again');
  assert.equal(await holder.getAttribute('aria-disabled'), null);

  const stat = page.locator('main .stat').filter({ hasText: 'My rating' });
  assert.equal(await stat.evaluate((el) => el.tagName), 'A');

  const tile = page.locator('main .card').filter({ hasText: /^My Rating/ }).first();
  assert.equal(await tile.evaluate((el) => el.tagName), 'A');

  await holder.click();
  await page.waitForTimeout(1500);
  const main = await page.locator('main').innerText();
  assert.match(main, /My Rating History/i);
  assert.ok(!/No published ratings yet/i.test(main),
    `the gate opened onto a page with something on it — got ${main.slice(0, 200)}`);

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('typing the address still reaches the page, and it explains itself', async (t) => {
  if (needStack(t)) return;
  // The gate is a "nothing here yet", NOT a permission: My Rating is your
  // own data and core.page_permission leaves it open to everyone. So the
  // URL must NOT answer with the access-denied screen — that would tell
  // somebody they had lost a right they never lost.
  const { ctx, page, errors } = await open(SHUT, '/my/rating');
  const main = await page.locator('main').innerText();
  assert.ok(!/not part of your access/i.test(main),
    `an empty page is not a forbidden one — got ${main.slice(0, 200)}`);
  assert.match(main, /No published ratings yet/i);
  assert.match(main, /after HR publishes/i, 'and it says what will change that');
  assert.deepEqual(errors, []);
  await ctx.close();
});
