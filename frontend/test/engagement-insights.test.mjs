// node --test — the New Hire Insights page (phase 5, 25 Sep).
//
// Sections 22 to 25. What only a browser can check is whether the page
// says what the numbers MEAN: a red chip with no action and no owner
// is where most HR dashboards stop, and it looks completely correct in
// the API response.
//
// NO LISTENING AGENT — excluded by Mindgate, and there is nothing on
// this page that drafts or infers.
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

async function open(email = 'admin@shot.in', path = '/admin/engagement-insights') {
  const t = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1600 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  return { ctx, page, errors };
}

test('the page is in the HR nav and reachable', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/engagement');
  assert.equal(await page.getByRole('link', { name: /New Hire Insights/i }).count(), 1,
    'registered in core.page_permission, so the nav shows it');
  await page.getByRole('link', { name: /New Hire Insights/i }).click();
  await page.waitForTimeout(1600);
  assert.match(await page.locator('main').innerText(), /New Hire Insights/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the dashboard reports the index, the weakest dimension and the real blockers', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open();
  const main = await page.locator('main').innerText();
  assert.match(main, /New hire experience index/i);
  assert.match(main, /Where onboarding is weakest/i);
  assert.match(main, /What people said is blocking them/i);

  // Section 24's point: not "scored 82%" but which dimension is
  // weakest. Read the dimension rows off the page and check the order.
  const dims = await page.locator('main .card').filter({ hasText: /Where onboarding is weakest/i })
    .locator('div.flex.items-center.gap-3').allInnerTexts();
  assert.ok(dims.length >= 3, `several dimensions listed — got ${dims.length}`);
  // Each row reads "<dimension>\n<score>\n<n> answers". The score is
  // the first bare number. The first cut of this parse produced NaN
  // and the assertion below was `scores.length >= 0`, which is true of
  // everything — reversing the sort did not fail the test.
  const scores = dims.map((d) => {
    const line = d.split('\n').map((x) => x.trim()).find((x) => /^\d+$/.test(x));
    return line == null ? NaN : Number(line);
  });
  assert.ok(scores.every((n) => Number.isFinite(n)),
    `every row has a readable score — got ${JSON.stringify(dims)}`);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] <= scores[i],
      `weakest first — ${scores.join(', ')} is not ascending, and this list exists to be acted on`);
  }

  // A productivity LEVEL must not be in the blocker LIST. "Still
  // learning" reached the top of it at 100% before blockers were
  // given their own dimension, which made the list useless.
  //
  // Read off the list rows, not the page: the card's own explanation
  // says that "No significant blocker" is not counted, so a
  // whole-page match finds the phrase and fails on the copy.
  const blockerRows = await page.locator('main .card')
    .filter({ hasText: /What people said is blocking them/i })
    .locator('div.flex.items-center.gap-3').allInnerTexts();
  assert.ok(blockerRows.length, 'blockers are listed');
  for (const row of blockerRows) {
    assert.ok(!/Still learning/.test(row), `a productivity level is not a blocker — got "${row}"`);
    assert.ok(!/No significant blocker/.test(row), `"no blocker" is not a blocker — got "${row}"`);
  }
  assert.ok(scores.length >= 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('every flag carries an action, an owner and a follow-up — not just a colour', async (t) => {
  if (needStack(t)) return;
  // Section 20: "Survey → Score → Risk → Action → Owner → Follow-up".
  // A red chip on its own is where most HR dashboards stop.
  const { ctx, page, errors } = await open();
  assert.match(await page.locator('main').innerText(), /Who needs attention/i);
  const first = page.locator('main details').first();
  assert.ok(await first.count(), 'somebody is flagged in the demo data');
  await first.click();
  await page.waitForTimeout(500);
  const open1 = await first.innerText();
  assert.match(open1, /\b(red|amber)\b/);
  assert.match(open1, /Do:/, 'the action');
  assert.match(open1, /Owner:/, 'who does it');
  assert.match(open1, /Follow up in: \d+ days/, 'and by when');
  assert.match(open1, /answered .* to /, 'and the answer that caused it, so it can be checked');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a flagged person opens their own 30/60/90 trend', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open();
  const first = page.locator('main details').first();
  await first.click();
  await page.waitForTimeout(400);
  await first.getByRole('button', { name: /See their 30\/60\/90 trend/ }).click();
  await page.waitForTimeout(1500);
  const main = await page.locator('main').innerText();
  assert.match(main, /across their milestones/i);
  assert.match(main, /Role clarity/i, 'dimensions are named in words, not keys');
  assert.match(main, /Overall/);
  // The milestones are columns, in order.
  assert.ok(/Day 30/i.test(main) && /Day 60/i.test(main), `the milestone columns — got ${main.slice(0, 400)}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the missing half of the correlation is stated, not left as an empty column', async (t) => {
  if (needStack(t)) return;
  // On this tenant no employee has an appraisal rating, so the
  // performance side cannot be computed. An empty column reads as "no
  // relationship"; the truth is "no data", and the difference matters.
  const { ctx, page, errors } = await open();
  const main = await page.locator('main').innerText();
  assert.match(main, /What happened next/i);
  assert.match(main, /No appraisal ratings on file yet/i);
  assert.match(main, /because the data does not exist, not because there is\s*no relationship/i);
  assert.match(main, /Attrition is real and shown/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an employee cannot reach the page at all', async (t) => {
  if (needStack(t)) return;
  const { ctx, page } = await open('emp@shot.in');
  const main = await page.locator('main').innerText();
  assert.ok(!/New hire experience index/i.test(main),
    `the direct URL is guarded, not just hidden from the nav — got ${main.slice(0, 200)}`);
  await ctx.close();
});
