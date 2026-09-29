// node --test — KRA timesheet keywords on the KRA Library page.
//
// Phase 1 of the Zoho timesheet rating engine (29 Sep).
//
// The server tests pin the parsing and the bulk endpoint. What only a
// browser shows is the safety rail that matters most here: Apply is
// genuinely disabled until a preview has run, and changing the filter
// after previewing invalidates it. A bulk edit over 2,360 library rows
// that can be fired without inspection is one typo away from a day of
// cleanup.
//
// It also checks the panel says NOTHING IS SCORED YET, because the
// worst outcome of phase 1 is HR believing a rating already moves when
// they type in this box.
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

// Leaves the shelf as it was found, so these tests can run in any order
// and again tomorrow against the same demo tenant.
async function clearAll() {
  const t = await token();
  await fetch(`${API}/api/v1/pms/hr/kra-library/keywords/bulk`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ mode: 'replace', keywords: '', confirm_clear: true }) });
}

async function open() {
  const t = await token();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1150 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + '/admin/kra-library', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2400);
  return { ctx, page, errors };
}

const text = (page) => page.evaluate(() => document.body.textContent);

test('the panel shows coverage and says nothing is scored yet', async (t) => {
  if (needStack(t)) return;
  await clearAll();
  const { ctx, page, errors } = await open();
  try {
    const body = await text(page);
    assert.ok(body.includes('Timesheet keywords'), 'the panel is on the page');
    assert.match(body, /\d+ of \d+ KRAs · [\d.]+% covered/,
      'coverage is the number to watch in phase 1');
    // The most important sentence on the screen right now.
    assert.match(body, /Nothing is scored from them yet/,
      'HR must not think a rating already moves when they type here');
    assert.ok(body.includes('Value-add words'), 'the org-wide A+ list is here too');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('THE SAFETY RAIL: apply is dead until a preview has run', async (t) => {
  if (needStack(t)) return;
  await clearAll();
  const { ctx, page, errors } = await open();
  try {
    await page.getByRole('button', { name: /Apply in bulk/ }).click();
    await page.waitForTimeout(500);
    await page.getByPlaceholder('Development, Bug Fixing, Code Review').fill('Development, Bug Fixing');
    await page.waitForTimeout(300);

    const blocked = page.getByRole('button', { name: /Preview first/ });
    assert.equal(await blocked.count(), 1, 'the button says what it wants');
    assert.equal(await blocked.isDisabled(), true, 'and is genuinely disabled, not just labelled');

    await page.getByRole('button', { name: /^Preview$/ }).click();
    await page.waitForTimeout(1800);
    let body = await text(page);
    assert.match(body, /\d+ matched · \d+ would change/, 'the preview says how many');
    assert.match(body, /none →/, 'and shows before → after per row');

    // Nothing was written by previewing.
    const t2 = await token();
    const before = await (await fetch(`${API}/api/v1/pms/hr/kra-library/keywords/summary`,
      { headers: { Authorization: `Bearer ${t2}` } })).json();
    assert.equal(before.with_keywords, 0, 'the preview wrote nothing');

    await page.getByRole('button', { name: /^Apply to \d+ KRA/ }).click();
    await page.waitForTimeout(2400);
    body = await text(page);
    assert.match(body, /\d+ of \d+ KRAs · [\d.]+% covered/);
    const after = await (await fetch(`${API}/api/v1/pms/hr/kra-library/keywords/summary`,
      { headers: { Authorization: `Bearer ${t2}` } })).json();
    assert.ok(after.with_keywords > 0, 'and applying did write');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await clearAll(); await ctx.close(); }
});

test('changing the filter after a preview invalidates it', async (t) => {
  if (needStack(t)) return;
  // The dangerous version of this screen is one where Apply fires a
  // preview that was taken against different criteria.
  await clearAll();
  const { ctx, page, errors } = await open();
  try {
    await page.getByRole('button', { name: /Apply in bulk/ }).click();
    await page.waitForTimeout(500);
    await page.getByPlaceholder('Development, Bug Fixing, Code Review').fill('Development');
    await page.getByRole('button', { name: /^Preview$/ }).click();
    await page.waitForTimeout(1800);
    assert.equal(await page.getByRole('button', { name: /^Apply to \d+ KRA/ }).count(), 1,
      'apply is live after previewing');

    // Now change the words. The preview no longer describes what would
    // happen, so the button must go back to demanding one.
    await page.getByPlaceholder('Development, Bug Fixing, Code Review').fill('Something Else');
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole('button', { name: /^Apply to \d+ KRA/ }).count(), 0,
      'the stale preview is dropped');
    assert.equal(await page.getByRole('button', { name: /Preview first/ }).count(), 1);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await clearAll(); await ctx.close(); }
});

test('clearing every keyword demands a confirmation', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open();
  try {
    await page.getByRole('button', { name: /Apply in bulk/ }).click();
    await page.waitForTimeout(500);
    // Replace + empty box is the destructive combination.
    await page.locator('select').filter({ hasText: 'Add to what is there' }).first()
      .selectOption('replace');
    await page.waitForTimeout(400);
    const body = await text(page);
    assert.match(body, /clear the keywords on every matching KRA/i,
      'the confirmation appears, rather than the instruction being inferred from an empty box');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('a KRA row shows its keywords, and says so when it has none', async (t) => {
  if (needStack(t)) return;
  // WRITTEN TWICE. The first version clicked a vague locator, fell
  // through to a diagnostic when no shelf opened, and passed — a
  // poison that removed the empty-state text entirely left it green.
  // This one opens a shelf by its own control and fails if it cannot,
  // because a test that cannot reach the thing it describes is not a
  // test.
  await clearAll();
  const { ctx, page, errors } = await open();
  try {
    // The shelf toggle is labelled with the DESIGNATION, not a generic
    // "View KRAs" — that label only exists in the filtered view. Asked
    // of the API so the locator cannot drift from the data.
    const t1 = await token();
    const shelves = await (await fetch(`${API}/api/v1/pms/hr/kra-library`,
      { headers: { Authorization: `Bearer ${t1}` } })).json();
    const desig = (shelves.shelves || [])[0] && (shelves.shelves || [])[0].designation;
    assert.ok(desig, 'the demo tenant has at least one published shelf');
    await page.getByRole('button', { name: new RegExp(desig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
    await page.waitForTimeout(2200);

    let body = await text(page);
    assert.match(body, /no timesheet keywords/,
      'a KRA with none says so, rather than leaving a blank that reads as a rendering gap');

    // And once they exist, the row shows them as chips.
    const t2 = await token();
    await fetch(`${API}/api/v1/pms/hr/kra-library/keywords/bulk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t2}` },
      body: JSON.stringify({ mode: 'add', keywords: 'Sprint Execution' }) });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: new RegExp(desig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
    await page.waitForTimeout(2200);
    body = await text(page);
    assert.match(body, /sprint execution/, 'the keyword is on the row');
    assert.ok(!/no timesheet keywords/.test(body), 'and the empty state is gone');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await clearAll(); await ctx.close(); }
});
