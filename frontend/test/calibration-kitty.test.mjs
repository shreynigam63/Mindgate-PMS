// node --test — the calibration kitty on screen, in a real browser.
//
// Asked for on 29 Sep as a spec for the Calibration page.
//
// The server tests already pin the arithmetic and the HTTP surface.
// What only a browser can show is whether HR can REACH any of it: that
// the bracket chips re-filter the panel and not just the table, that a
// leaver reads as frozen rather than as somebody with a 0% hike, and
// that the reason fields appear when the money they justify is typed.
//
// ASSERTS ON textContent, NOT innerText — the grid scrolls, and
// Chromium's innerText omits what is scrolled out of an overflow
// container, which reports present columns as missing.
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

async function token(email = 'admin@shot.in') {
  return (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
}

// A kitty with real numbers, so the panel is not a row of zeros.
async function setKitty(body) {
  const t = await token();
  const r = await fetch(`${API}/api/v1/pms/calibration/kitty`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify(body) });
  assert.equal(r.status, 200, 'the fixture kitty should save');
}

async function open(path = '/admin/calibration') {
  const t = await token();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1150 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  return { ctx, page, errors };
}

const text = (page) => page.evaluate(() => document.body.textContent);

test('the panel, the grade table and the grid all reach the screen', async (t) => {
  if (needStack(t)) return;
  await setKitty({ kitty_pct: 8, bracket_threshold: 5000000,
    retention_pool: 500000, market_pool: 300000, promotion_pool: 400000 });
  const { ctx, page, errors } = await open();
  try {
    const body = await text(page);
    // The four pools, each a separate budget — the client's rule that
    // they sit on top of the kitty rather than inside it.
    for (const label of ['Kitty & budget', 'Total salary pool', 'Incremental kitty',
      'Retention', 'Market correction', 'Promotion']) {
      assert.ok(body.includes(label), `the panel shows "${label}"`);
    }
    // The grade ladder, in the letters the client asked for.
    for (const g of ['A+', 'B+']) assert.ok(body.includes(g), `grade ${g}`);
    // The grid and its computed columns.
    for (const col of ['Increment allocation', 'Current CTC', 'Revised CTC', 'Export to Excel']) {
      assert.ok(body.includes(col), `the grid shows "${col}"`);
    }
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the bracket chips carry the configured threshold, not a hardcoded 50L', async (t) => {
  if (needStack(t)) return;
  // The threshold is a column so a client can reconfigure it. A chip
  // reading "> ₹50L" on a tenant who set 40 would be a lie, so the
  // label is built from the stored value.
  await setKitty({ bracket_threshold: 4000000 });
  const { ctx, page, errors } = await open();
  try {
    const body = await text(page);
    assert.ok(body.includes('₹40.00 L'), `the chip follows the threshold, got: ${body.slice(0, 0)}`);
    assert.ok(!body.includes('₹50.00 L'), 'and does not still claim 50');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await setKitty({ bracket_threshold: 5000000 });
    await ctx.close();
  }
});

test('switching bracket re-filters the PANEL, not only the table', async (t) => {
  if (needStack(t)) return;
  // A company-wide total sitting above a filtered table reads as a
  // contradiction, and somebody will quote the wrong number off it.
  await setKitty({ kitty_pct: 8, bracket_threshold: 5000000 });
  const { ctx, page, errors } = await open();
  try {
    const all = await text(page);
    const allShown = /(\d+) of (\d+) shown/.exec(all);
    assert.ok(allShown, 'the count is on screen');
    assert.equal(allShown[1], allShown[2], 'everyone, before filtering');

    await page.getByRole('button', { name: /^> / }).click();
    await page.waitForTimeout(1500);
    const above = await text(page);
    const aboveShown = /(\d+) of (\d+) shown/.exec(above);
    assert.ok(Number(aboveShown[1]) < Number(aboveShown[2]),
      'fewer people in the upper bracket than in total');
    assert.notEqual(above.match(/Total salary pool[\s\S]{0,40}/)[0],
      all.match(/Total salary pool[\s\S]{0,40}/)[0],
      'and the salary pool moved with them');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('a leaver reads as frozen, with the reason, not as a 0% hike', async (t) => {
  if (needStack(t)) return;
  // The client's rule: resigned and not retained means no increment at
  // all. A bare 0% in the column looks like a decision somebody made
  // about their performance.
  const { ctx, page, errors } = await open();
  try {
    const body = await text(page);
    assert.ok(body.includes('leaving'), 'the status chip says so');
    assert.match(body, /retention is not approved, so no increment is allocated/,
      'and the row explains itself');
    assert.match(body, /rating still counts in the distribution/,
      'including that their rating is still counted');
    // The raw timestamp bug: "2026-10-25T00:00:00.000Z" mid-sentence.
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body), 'dates are readable, not ISO timestamps');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('opening a row offers the three special pots, and asks why', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open();
  try {
    // Open the first employee row in the allocation grid.
    const grid = page.locator('table').last();
    await grid.locator('tbody tr').first().locator('button').first().click();
    await page.waitForTimeout(900);
    let body = await text(page);
    for (const label of ['Standard hike', 'Market correction', 'Promotion', 'Retention']) {
      assert.ok(body.includes(label), `the editor offers "${label}"`);
    }
    // A reason field appears only once there is money to justify —
    // asking for one against a 0% is noise.
    assert.equal(await page.getByPlaceholder('Reason (required)').count(), 0,
      'no reason asked for before anything is typed');

    // Scoped to the expanded panel. A page-wide input[type=number]
    // also matches the Adjust Rating box on every row of the RATINGS
    // table above, so nth(1) was one of those and typing into it
    // proved nothing about this panel.
    const panel = page.locator('tr').filter({ hasText: 'Standard hike' }).last();
    const mkt = panel.locator('input[type=number]').nth(1);
    await mkt.fill('5');
    await page.waitForTimeout(500);
    assert.ok(await page.getByPlaceholder('Reason (required)').count() >= 1,
      'typing a market correction asks why');

    // And the server refuses it without one, rather than the page
    // being the only thing standing between HR and an unexplained hike.
    await panel.getByRole('button', { name: /^Save$/ }).click();
    await page.waitForTimeout(1500);
    body = await text(page);
    assert.match(body, /needs a reason/i, 'saving without it is refused, in a sentence');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the page still works for somebody without the compensation permission', async (t) => {
  if (needStack(t)) return;
  // Salary is granted separately from the rest of HR, so a user with
  // pms_admin and not pms_compensation must get the ratings page they
  // have today rather than a red error box.
  //
  // THE 403 IS INTERCEPTED RATHER THAN EARNED. The demo tenant has no
  // such user: pms_compensation is seeded to the hr and admin roles,
  // and manufacturing one would mean either a tenth demo employee or a
  // sixth credential — and a bulk-credentials test asserts exactly how
  // many of each there are. The server test already proves the route
  // returns 403 to someone without the grant; what only a browser can
  // show is what this PAGE does when it gets one, which is precisely
  // what the route below stubs.
  const t2 = await token();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.route('**/api/v1/pms/calibration/kitty*', (route) => route.fulfill({
      status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: "Requires 'pms_compensation' — compensation data is granted separately from other HR permissions" }),
    }));
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await page.evaluate((x) => localStorage.setItem('apms_token', x), t2);
    await page.goto(APP + '/admin/calibration', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    const body = await text(page);
    assert.ok(body.includes('Distribution vs bell-curve targets'),
      'the ratings half of the page is still there');
    // The DISTINCTIVE copy of the explanatory panel, not just the
    // permission name: the raw 403 message contains "pms_compensation"
    // too, so asserting on that alone passed even when the page threw
    // the error into its red banner instead of degrading. This
    // sentence exists only in the graceful path.
    assert.match(body, /granted\s+separately from the rest of HR/,
      'the explanatory panel, not a red error box');
    assert.ok(!/text-rose/.test(await page.evaluate(() => {
      const el = [...document.querySelectorAll('p')].find((x) => /pms_compensation/.test(x.textContent));
      return el ? el.className : '';
    })), 'and it is not styled as an error');
    assert.ok(!body.includes('Increment allocation'), 'with no allocation grid');
    assert.ok(!body.includes('Kitty & budget'), 'and no kitty panel');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the three sections collapse, and remember it across a reload', async (t) => {
  if (needStack(t)) return;
  // Asked for on 29 Sep: "can we have dropdown for kitty, calibration
  // and increment allocation". Three full-width blocks down one scroll
  // was more page than anybody needed at once.
  await setKitty({ kitty_pct: 8, bracket_threshold: 5000000,
    retention_pool: 500000, market_pool: 300000, promotion_pool: 400000 });
  const { ctx, page, errors } = await open();
  try {
    // All three open to begin with: a page that hid its own contents on
    // first visit would look broken rather than tidy.
    let body = await text(page);
    for (const inside of ['Total salary pool', 'Adjust Rating', 'Revised CTC']) {
      assert.ok(body.includes(inside), `"${inside}" is visible before collapsing`);
    }

    const header = (name) => page.getByRole('button', { name: new RegExp(name) }).first();

    await header('Kitty & budget').click();
    await page.waitForTimeout(400);
    body = await text(page);
    assert.ok(!body.includes('Total salary pool'), 'the kitty folded away');
    assert.ok(body.includes('Kitty & budget'), 'but its header stays');
    // The headline figure survives the fold — it is the number somebody
    // collapsed the section to get past.
    assert.match(body, /kitty · .* left/, 'and the header still says what is left');
    assert.ok(body.includes('Revised CTC'), 'the other sections are untouched');

    await header('Ratings & adjustments').click();
    await page.waitForTimeout(400);
    body = await text(page);
    assert.ok(!body.includes('Adjust Rating'), 'the ratings table folded away');

    await header('Increment allocation').click();
    await page.waitForTimeout(400);
    body = await text(page);
    assert.ok(!body.includes('Revised CTC'), 'the allocation grid folded away');
    assert.ok(body.includes('Increment allocation'), 'its header stays too');

    // THE STATE STICKS. A panel that springs back open on every reload
    // is worse than no panel: HR collapses the grid to work on the
    // kitty, saves, the page reloads and they are back where they were.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    body = await text(page);
    assert.ok(!body.includes('Total salary pool'), 'kitty still closed after a reload');
    assert.ok(!body.includes('Revised CTC'), 'allocation still closed after a reload');

    // And they open again.
    await header('Increment allocation').click();
    await page.waitForTimeout(600);
    assert.ok((await text(page)).includes('Revised CTC'), 'reopening works');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    // Left open for the next test, and for anyone using the demo.
    await page.evaluate(() => {
      try { ['kitty', 'ratings', 'allocation'].forEach((k) => localStorage.removeItem(`apms.cal.section.${k}`)); } catch { /* ignore */ }
    });
    await ctx.close();
  }
});

test('a button in a section header does its job without folding the section', async (t) => {
  if (needStack(t)) return;
  // Export sits in the allocation header and Set the kitty in the
  // kitty header. Clicking either must not collapse the thing it acts
  // on — the commonest way a click-to-toggle header goes wrong.
  const { ctx, page, errors } = await open();
  try {
    await page.getByRole('button', { name: /Set the kitty/ }).click();
    await page.waitForTimeout(500);
    const body = await text(page);
    assert.ok(body.includes('Total salary pool'), 'the kitty section is still open');
    assert.ok(body.includes('Approved kitty'), 'and the editor opened');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('each section has its own search, inside the section it filters', async (t) => {
  if (needStack(t)) return;
  // Asked for on 29 Sep: "please provide search bar under ratings &
  // adjustments". It had been floating between the two sections.
  //
  // SPLIT INTO TWO BOXES rather than moved. One shared query filtered
  // both tables, so tucking it inside the Ratings panel would have
  // left the allocation grid filtered by a query nobody could see the
  // moment that panel was folded away — a grid quietly showing three
  // of nine people with no visible reason.
  const { ctx, page, errors } = await open();
  try {
    const boxes = page.getByPlaceholder(/^Search by/);
    assert.equal(await boxes.count(), 2, 'one search per section');

    const ratings = page.getByPlaceholder(/adjustment reason/);
    const alloc = page.getByPlaceholder(/code, designation/);
    assert.equal(await ratings.count(), 1);
    assert.equal(await alloc.count(), 1);

    // Typing in one must not filter the other.
    const rowsIn = (name) => page.locator('table').filter({ hasText: name }).first()
      .locator('tbody tr').count();
    const allocBefore = await rowsIn('Revised CTC');
    await ratings.fill('Arun');
    await page.waitForTimeout(600);
    assert.equal(await rowsIn('Revised CTC'), allocBefore,
      'searching the ratings table leaves the allocation grid alone');

    await alloc.fill('Arun');
    await page.waitForTimeout(600);
    assert.ok(await rowsIn('Revised CTC') < allocBefore, 'and its own box does filter it');

    // Folding a section takes its search with it, which is the point:
    // no filter can be left applied out of sight.
    await page.getByRole('button', { name: /Increment allocation/ }).first().click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByPlaceholder(/code, designation/).count(), 0,
      'the allocation search folds away with its grid');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await page.evaluate(() => {
      try { ['kitty', 'ratings', 'allocation'].forEach((k) => localStorage.removeItem(`apms.cal.section.${k}`)); } catch { /* ignore */ }
    });
    await ctx.close();
  }
});
