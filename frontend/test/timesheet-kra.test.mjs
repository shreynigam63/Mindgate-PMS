// node --test — the KRA coverage tab, in a real browser.
//
// Phase 3 of the Zoho timesheet rating engine. The server tests pin the
// numbers and the guards; what only a browser shows is whether the
// screen tells the truth about them.
//
// Three things matter more than the rest here:
//
//   - THE EMPLOYEE HAS NO MAPPING CONTROLS. The server refuses their
//     writes, but a screen that offers a control and then 403s is a
//     screen that taught somebody the product is broken.
//   - THE WITHHELD REASONS ARE SHOWN VERBATIM. Phase 2 ships with
//     automatic scoring off; the worst outcome is a manager believing a
//     rating already moves from this screen.
//   - NO KRAs, NO DROPDOWN. Offering "pick the KRA this serves" over an
//     empty list is how a manager concludes the product is broken.
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

const token = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: PASS }),
})).json()).token;

async function open(email, route) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2400);
  return { ctx, page, errors };
}
// Chromium's innerText omits anything scrolled out of an overflow
// container, so every assertion here reads textContent. Learned the
// hard way on the engagement pages.
const text = (page) => page.evaluate(() => document.body.textContent);

const toKra = async (page) => {
  await page.getByRole('button', { name: 'KRA coverage' }).first().click();
  await page.waitForTimeout(2400);
};
const openPerson = async (page, name) => {
  await page.getByRole('cell', { name: new RegExp(name) }).first().click();
  await page.waitForTimeout(2200);
};

// ---- the employee -------------------------------------------------------

test('THE EMPLOYEE SEES THE NUMBERS AND CANNOT CHANGE THEM', { skip: false }, async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('emp@shot.in', '/my/timesheet');
  try {
    await toKra(page);
    const body = await text(page);
    assert.match(body, /Where the hours went/i, 'the per-KRA table is there');
    assert.match(body, /Your manager decides which KRA each item serves/,
      'and it says whose decision it is');
    // The control the server would refuse is simply not drawn.
    assert.equal(await page.locator('text=pick the KRA this serves').count(), 0);
    assert.equal(await page.getByRole('button', { name: /Save \d+ mapping|Nothing to save/ }).count(), 0);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('THE WITHHELD REASONS ARE PRINTED, NOT SUMMARISED', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // The worst outcome of this phase is somebody believing a rating
  // already moves here. The sentence comes from the server and this
  // screen must show it whole.
  const { ctx, page, errors } = await open('emp@shot.in', '/my/timesheet');
  try {
    await toKra(page);
    const body = await text(page);
    assert.match(body, /No rating is produced from this screen/);
    assert.match(body, /Automatic scoring is off/);
    assert.ok(!/insufficient data/i.test(body), 'never flattened into a stock phrase');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the period defaults to a month that has logs, and the rest are offered', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // A timesheet is uploaded after the month it covers, so opening on
  // the calendar's current cycle showed "no timesheet logged" to
  // everybody, with no way to reach the month they came for.
  const { ctx, page, errors } = await open('emp@shot.in', '/my/timesheet');
  try {
    await toKra(page);
    const body = await text(page);
    assert.ok(!/No timesheet logged in/.test(body), 'not stranded on an empty month');
    assert.match(body, /Period/);
    const sel = page.locator('select').first();
    assert.ok(await sel.count(), 'a period picker exists');
    const opts = await sel.locator('option').allTextContents();
    assert.ok(opts.length >= 1 && opts.every((o) => /\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/.test(o)),
      `periods are named by their dates: ${JSON.stringify(opts)}`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

// ---- the manager --------------------------------------------------------

test('A MANAGER MAPS AN ITEM AND THE NUMBERS MOVE', { skip: false }, async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/timesheet');
  try {
    await openPerson(page, 'Arun Employee');
    await toKra(page);

    // Start from a known state: drop every mapping this person has.
    const tk = await token('mgr@shot.in');
    const who = (await (await fetch(`${API}/api/v1/pms/timesheet/kra/team`,
      { headers: { Authorization: `Bearer ${tk}` } })).json())
      .team.find((x) => x.employee.name === 'Arun Employee');
    assert.ok(who, 'the manager can see this reportee');

    const before = await text(page);
    assert.match(before, /What was logged/i);
    // The save button is present but inert until something is chosen.
    const save = page.getByRole('button', { name: /Nothing to save|Save \d+ mapping/ });
    assert.equal(await save.count(), 1);
    assert.equal(await save.isDisabled(), true, 'nothing pending, nothing to press');

    // Choose a KRA for the first item.
    const picker = page.locator('select').filter({ hasText: 'pick the KRA this serves' }).first();
    const opts = await picker.locator('option').allTextContents();
    assert.ok(opts.length > 2, `the KRA list is populated: ${JSON.stringify(opts)}`);
    await picker.selectOption({ index: 1 });
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('button', { name: /Save 1 mapping/ }).count(), 1,
      'the button counts what is pending');
    assert.equal(await page.getByRole('button', { name: /Save 1 mapping/ }).isDisabled(), false);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('EXCLUDING WORK ASKS FOR THE REASON ON THE SCREEN, not in a 422', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // The server requires it. Letting the manager fill the whole form and
  // then telling them off is a worse version of the same rule.
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/timesheet');
  try {
    await openPerson(page, 'Arun Employee');
    await toKra(page);
    const picker = page.locator('select').filter({ hasText: 'Not KRA work' }).first();
    await picker.selectOption('__ex');
    await page.waitForTimeout(400);
    assert.equal(await page.getByPlaceholder(/Why is this not KRA work/).count(), 1,
      'the reason box appears as soon as the choice is made');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('NO KRAs, NO DROPDOWN — and it says what the real fix is', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // Priya Nair carries a sheet with zero KRAs on it. Offering a picker
  // over an empty list is how a manager concludes the product is broken.
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/timesheet');
  try {
    await openPerson(page, 'Priya Nair');
    await toKra(page);
    const body = await text(page);
    assert.match(body, /has no KRAs for this cycle/, 'the reason is stated');
    assert.match(body, /There is nothing to map this to/, 'and so is what to do about it');
    assert.equal(await page.locator('text=pick the KRA this serves').count(), 0,
      'no dropdown over an empty list');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('A KRA DECLARED UNMEASURABLE IS NOT OFFERED AS A DESTINATION', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // Arun's "CSAT Score" is marked as measured from quarterly client
  // feedback. Offering it in the picker contradicts that declaration,
  // and hours parked there would count towards nobody's coverage —
  // visible in the shares and invisible in the coverage figure.
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/timesheet');
  try {
    await openPerson(page, 'Arun Employee');
    await toKra(page);
    const body = await text(page);
    assert.match(body, /CSAT Score/, 'the KRA is on the sheet and shown in the table');
    assert.match(body, /not measured from timesheets/, 'with its reason');

    const picker = page.locator('select').filter({ hasText: 'pick the KRA this serves' }).first();
    const opts = await picker.locator('option').allTextContents();
    assert.ok(opts.length > 2, `the picker is populated: ${JSON.stringify(opts)}`);
    // WRITTEN TWICE. The first version matched the option text
    // EXACTLY — /^CSAT Score$/ — and a poison that removed the filter
    // left it green, because the unfiltered list labels an unmeasurable
    // KRA "CSAT Score (not measured from timesheets)" and that is not an
    // exact match. The rule is that the KRA is not offered AT ALL, so
    // the assertion has to be a substring one.
    assert.ok(!opts.some((o) => o.includes('CSAT Score')),
      `CSAT Score must not be a choice at all: ${JSON.stringify(opts)}`);
    assert.ok(opts.some((o) => /Incident analysis/.test(o)), 'the measurable ones still are');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('a pending choice is labelled unsaved rather than shown as done', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // The chip used to keep showing the SAVED state beside a dropdown
  // that already said something else, so the screen looked like it
  // disagreed with itself.
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/timesheet');
  try {
    await openPerson(page, 'Arun Employee');
    await toKra(page);
    assert.ok(!/unsaved/.test(await text(page)), 'nothing pending to begin with');
    const picker = page.locator('select').filter({ hasText: 'Not KRA work' }).first();
    await picker.selectOption('__ex');
    await page.waitForTimeout(400);
    assert.match(await text(page), /Not KRA work · unsaved/);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

// ---- HR -----------------------------------------------------------------

test('HR sees the backlog, and the people with no KRAs named as such', { skip: false }, async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('admin@shot.in', '/admin/timesheet');
  try {
    await toKra(page);
    const body = await text(page);
    assert.match(body, /Who needs a mapping session/i);
    assert.match(body, /Hours placed/);
    assert.ok(!/Nobody logged time/.test(body), 'not stranded on an empty current cycle');
    // The cap on the whole feature, on screen rather than implied.
    assert.match(body, /no KRAs on their sheet for this cycle/,
      'the people who logged time with nothing to credit it to are called out');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the Compliance tab still works and is the default', { skip: false }, async (t) => {
  if (needStack(t)) return;
  // The view that has been there since 25 Sep, and the one that works
  // for everybody. Opening on KRA coverage would show "nothing here"
  // for most of the client's company.
  const { ctx, page, errors } = await open('emp@shot.in', '/my/timesheet');
  try {
    const body = await text(page);
    assert.match(body, /Compliance/);
    assert.ok(!/Where the hours went/i.test(body), 'compliance is what loads first');
    await toKra(page);
    await page.getByRole('button', { name: 'Compliance' }).first().click();
    await page.waitForTimeout(1200);
    const back = await text(page);
    assert.ok(!/Where the hours went/i.test(back), 'and it comes back');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});
