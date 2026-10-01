// node --test — the "Surveys waiting on you" collapse.
//
// Asked for on 1 Oct: "surveys waiting for you can have toggle view which
// can be hidden or open in one click."
//
// Three things make this a feature rather than a `hidden` class, and all
// three are pinned below:
//
//   1. ONE CLICK, both ways. Shut and open again without a reload.
//   2. THE COUNT SURVIVES THE COLLAPSE. Collapsing is meant to buy back
//      vertical space, not to hide that seven forms are waiting. If the
//      sentence went away with the list, somebody who shut it once would
//      never learn they owe anything — which is worse than the gap the
//      collapse was for. This is the assertion that matters.
//   3. THE CHOICE STICKS. Re-shutting it on every visit is not a
//      preference, it is a chore.
//
// Skips cleanly when the stack is not up.
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

async function openHome(email) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(`${APP}/home`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

const toggle = (page) => page.locator('button[aria-expanded]').first();
// SCOPED TO THE CARD, AND :visible. Two ways this locator was wrong
// before it was right, both found by running it:
//   - a bare locator counts DOM nodes, and the collapse sets `hidden`
//     (display:none), so the rows stay in the DOM and the count never
//     changed — every assertion below passed against a toggle that did
//     nothing;
//   - `a[href="/engagement"]` also matches the nav's own "My Surveys"
//     item, which is in the header on every page, so a shut section
//     still counted one.
// The card is the toggle's next sibling, which is the only thing the
// collapse actually governs.
const rows = (page) => page.locator('button[aria-expanded] + div a:visible');

test('the survey list hides and opens in one click, and says so', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await openHome('admin@shot.in');

  const btn = toggle(page);
  assert.equal(await btn.count(), 1, 'the header is the toggle');
  assert.equal(await btn.getAttribute('aria-expanded'), 'true', 'open by default');
  const openRows = await rows(page).count();
  assert.ok(openRows > 0, 'there are survey rows to begin with');
  assert.match(await btn.innerText(), /Hide/, 'an open section offers to hide');

  await btn.click();
  await page.waitForTimeout(300);
  assert.equal(await btn.getAttribute('aria-expanded'), 'false', 'one click shuts it');
  assert.equal(await rows(page).count(), 0, 'and the rows are gone');
  assert.match(await btn.innerText(), /Show/, 'a shut section offers to show');

  await btn.click();
  await page.waitForTimeout(300);
  assert.equal(await rows(page).count(), openRows, 'one click brings every row back');

  assert.deepEqual(errors, []);
  await ctx.close();
});

// THE ONE THAT MATTERS. Written second on purpose: the first version of
// this feature could have put the count inside the collapsing block and
// still passed every assertion above.
test('collapsing hides the list, never the fact that forms are waiting', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await openHome('admin@shot.in');

  const btn = toggle(page);
  const said = await btn.innerText();
  const m = said.match(/(\d+) open forms? ha(?:s|ve) not been answered yet/);
  assert.ok(m, `the open header states the count — got ${JSON.stringify(said)}`);

  await btn.click();
  await page.waitForTimeout(300);
  assert.equal(await rows(page).count(), 0, 'shut');
  const stillSaid = await btn.innerText();
  assert.match(stillSaid, new RegExp(`${m[1]} open forms? ha(?:s|ve) not been answered yet`),
    `the count must survive the collapse — got ${JSON.stringify(stillSaid)}`);
  // And it is still on the page as text, not only in an attribute.
  assert.ok((await page.locator('body').textContent()).includes(`${m[1]} open form`),
    'the sentence is readable on the page while the list is shut');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the choice survives a reload, per browser', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await openHome('admin@shot.in');

  await toggle(page).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false',
    'it came back shut, so nobody has to shut it twice');
  assert.equal(await rows(page).count(), 0);

  // Re-opening sticks the same way.
  await toggle(page).click();
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'and open sticks too');

  assert.deepEqual(errors, []);
  await ctx.close();

  // A FRESH BROWSER IS NOT AFFECTED. The preference is per-viewer, so it
  // must not leak through anything shared — if this ever came back shut,
  // the choice would be living somewhere it should not.
  const fresh = await openHome('admin@shot.in');
  assert.equal(await toggle(fresh.page).getAttribute('aria-expanded'), 'true',
    'a browser that never shut it gets the default');
  await fresh.ctx.close();
});
