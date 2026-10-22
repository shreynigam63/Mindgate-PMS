// node --test — who uploads timesheets, and whose rows an upload loads.
//
// 22 Oct: "Timesheet will be updated only by HR/Super Admin and not by
// employee. Kindly update logic and remove option from employee for
// uploading time sheet. Also for HR provide option to upload per person
// and bulk as well." These tests pin all three halves in a real browser:
//
//   * Self → Timesheet has no upload any more, and says HR loads it;
//   * HR → Timesheet uploads in bulk (each row against the person it
//     names) and for one person (only their rows; the rest is listed);
//   * an HRBP reading HR's page through the gateway is not offered it.
//
// The fixture is built here rather than committed as a binary: a Zoho
// export is only a header row carrying "Log Date" and "Log owner", and a
// CSV the upload accepts. Skips cleanly when the dev stack is not up.
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

const HEAD = 'Item Id,Item Name,Log Type,Log Hours(for calculation),Log owner,Log Date,Approval Status,Description,Owner Mail Id';
const row = (name, email, date) => `TSU-1,Upload probe,WorkItem,8,${name},${date},Approved,probe row,${email}`;
// Two people in one file, the way a project export arrives.
const TEAM_FILE = [HEAD,
  row('Arun Krishnan', 'emp@shot.in', '15/Oct/2026'),
  row('Arun Krishnan', 'emp@shot.in', '16/Oct/2026'),
  row('Kavya Shetty', 'kavya@shot.in', '15/Oct/2026'),
].join('\n');

const text = (page) => page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));

async function open(email, path) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1300 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(`${APP}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  return { ctx, page, errors };
}

async function sendFile(page, csv) {
  await page.setInputFiles('input[type=file]', { name: 'team-export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await page.getByRole('button', { name: /Check the file/ }).click();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: /^Upload$/ }).click();
  await page.waitForTimeout(2500);
}

test('SELF → TIMESHEET HAS NO UPLOAD: the employee is told HR loads it', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('emp@shot.in', '/my/timesheet');
  const body = await text(page);
  assert.equal(await page.locator('input[type=file]').count(), 0, 'a file box is still on the employee page');
  assert.equal(await page.getByRole('button', { name: /Check the file/ }).count(), 0);
  assert.equal(await page.getByText(/Download template/).count(), 0);
  assert.match(body, /uploaded by HR/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('HR BULK: every row loads against the person it names', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/timesheet');
  assert.match(await text(page), /Upload timesheets/);
  await page.getByRole('button', { name: /Bulk — everyone in the file/ }).click();
  await sendFile(page, TEAM_FILE);
  const body = await text(page);
  assert.match(body, /Uploaded\. 3 rows read, 3 loaded/);
  assert.match(body, /Loaded for 2 people: (Arun Krishnan, Kavya Shetty|Kavya Shetty, Arun Krishnan)/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('HR ONE PERSON: only that person\'s rows load, and the rest of the file is listed back', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/timesheet');
  await page.getByRole('button', { name: /^One person$/ }).click();
  await page.getByPlaceholder(/Find the employee/).fill('Kavya');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Kavya Shetty/ }).first().click();
  assert.match(await text(page), /For Kavya Shetty kavya@shot\.in/);
  await sendFile(page, TEAM_FILE);
  const body = await text(page);
  assert.match(body, /3 rows read, 1 loaded/);
  assert.match(body, /Loaded for 1 person: Kavya Shetty/);
  assert.match(body, /2 rows belong to other people and were not loaded — this upload is for Kavya Shetty only/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a person\'s own timesheet under HR carries an upload for that person', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/admin/timesheet');
  await page.getByPlaceholder(/Search/).first().fill('Arun Krishnan');
  await page.waitForTimeout(400);
  await page.locator('tr', { hasText: 'Arun Krishnan' }).first().click();
  await page.waitForTimeout(1500);
  assert.match(await text(page), /Upload timesheet for Arun Krishnan/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an HRBP reading HR\'s timesheet page is not offered the upload', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hrbp@shot.in', '/hrbp/timesheet');
  const body = await text(page);
  assert.match(body, /Timesheet Dashboard/);
  assert.ok(!/Upload timesheets/.test(body), 'the HRBP page offered the upload');
  assert.equal(await page.locator('input[type=file]').count(), 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
