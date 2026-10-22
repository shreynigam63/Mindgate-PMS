// node --test — Log Title is the KRA (22 Oct), in a real browser.
//
// "In download template log title should be use as KRA title and KRA
// coverage will be mapped accordingly instead of item used as KRA
// coverage." HR uploads a file for one person in which:
//
//   * one log's Log Title is one of their KRA titles,
//   * one log's Log Title is not (a typo),
//   * one log has no Log Title;
//
// and the check says so before saving, and KRA coverage places the first
// by its Log Title — under the item's own name — and flags the second.
// The person's KRA titles are read through the API, not written here, so
// the test follows whatever the demo data holds. Skips cleanly when the
// dev stack is not up.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';

const APP = process.env.APP_URL || 'http://127.0.0.1:5190';
const API = process.env.API_URL || 'http://127.0.0.1:8080';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASS = process.env.DEMO_PASSWORD || 'Demo#2026pms';
const SHOTS = process.env.SHOTS_DIR || null;

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
const get = async (tok, path) => (await fetch(`${API}/api/v1${path}`, { headers: { Authorization: `Bearer ${tok}` } })).json();

const text = (page) => page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));

async function open(email, path) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1500 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  return { ctx, page, errors };
}

const HEAD = 'Item Id,Item Name,Log Title,Log Type,Log Hours(for calculation),Log owner,Log Date,Approval Status,Owner Mail Id';
const csvCell = (v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const row = (id, item, title, date) => [id, item, title, 'WorkItem', '8', 'Arun Krishnan', date, 'Approved', 'emp@shot.in'].map(csvCell).join(',');

test('HR checks a file: Log Titles that are KRAs, blank, and not a KRA — then KRA coverage places them', async (t) => {
  if (needStack(t)) return;
  const hr = await token('hr@shot.in');
  const roster = await get(hr, '/pms/timesheet/all');
  const arun = roster.employees.map((r) => r.employee).find((p) => p.email === 'emp@shot.in');
  const kra = await get(hr, `/pms/timesheet/kra/employee/${arun.id}`);
  const titles = kra.by_kra.map((k) => k.title);
  if (!titles.length) { t.skip('Arun has no KRAs in the demo data'); return; }
  const kraTitle = titles[0];

  const file = [HEAD,
    row('LT-1', 'Sprint demo prep', kraTitle, '21/Oct/2026'),
    row('LT-2', 'Weekly status deck', `${kraTitle} typo`, '22/Oct/2026'),
    row('LT-3', 'Team lunch planning', '', '23/Oct/2026'),
  ].join('\n');

  const { ctx, page, errors } = await open('hr@shot.in', '/admin/timesheet');
  await page.getByRole('button', { name: /^One person$/ }).click();
  await page.getByPlaceholder(/Find the employee/).fill('Arun');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Arun Krishnan/ }).first().click();
  await page.setInputFiles('input[type=file]', { name: 'arun.csv', mimeType: 'text/csv', buffer: Buffer.from(file, 'utf8') });
  await page.getByRole('button', { name: /Check the file/ }).click();
  await page.waitForTimeout(1800);
  const checked = await text(page);
  assert.match(checked, /Log Title: 1 row names one of the person's KRAs · 1 blank \(placed by Item Name\) · 1 not a KRA title/);
  assert.match(checked, /Row 3: “.+ typo” — not one of Arun Krishnan's KRA titles/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/4-log-title-checked.png`, fullPage: false });
  await page.getByRole('button', { name: /^Upload$/ }).click();
  await page.waitForTimeout(2500);
  assert.match(await text(page), /Uploaded\. 3 rows read, 3 loaded/);
  assert.deepEqual(errors, []);
  await ctx.close();

  // KRA coverage, on Arun's own timesheet under HR.
  const v = await open('hr@shot.in', '/admin/timesheet');
  await v.page.getByPlaceholder(/Search/).first().fill('Arun Krishnan');
  await v.page.waitForTimeout(400);
  await v.page.locator('tr', { hasText: 'Arun Krishnan' }).first().click();
  await v.page.waitForTimeout(1500);
  await v.page.getByRole('button', { name: /^KRA coverage$/ }).click();
  await v.page.waitForTimeout(2000);
  const sel = v.page.locator('select').first();
  if (await sel.count()) {
    const opts = await sel.locator('option').evaluateAll((os) => os.map((o) => o.value));
    const want = opts.find((o) => o <= '2026-10-21' && o >= '2026-09-22');
    if (want) { await sel.selectOption(want); await v.page.waitForTimeout(1800); }
  }
  const card = v.page.locator('div.rounded-lg', { hasText: 'Sprint demo prep' }).first();
  const cardText = (await card.textContent()).replace(/\s+/g, ' ');
  assert.match(cardText, /By Log Title/);
  assert.ok(cardText.includes(kraTitle), 'the KRA the Log Title names');
  assert.match(cardText, /Set by the Log Title in the uploaded timesheet/);
  const typo = (await v.page.locator('div.rounded-lg', { hasText: 'Weekly status deck' }).first().textContent()).replace(/\s+/g, ' ');
  assert.match(typo, /Unplaced/);
  assert.match(typo, /not one of this person's KRA titles/);
  if (SHOTS) {
    await card.scrollIntoViewIfNeeded();
    await v.page.screenshot({ path: `${SHOTS}/5-kra-coverage-by-log-title.png`, fullPage: false });
  }
  assert.deepEqual(v.errors, []);
  await v.ctx.close();
});
