// node --test — the upload panel says WHOSE rows it just loaded.
//
// Reported from the live PoC as "we are unable to check information of
// uploaded data even after upload is completed". Nothing was broken: an
// admin uploaded another person's Zoho export, all 73 rows loaded against
// THAT person (the row-level scope rule is bypassed for pms_admin), and
// My Timesheet — which reads only the signed-in user's own logs — sat
// underneath the green "73 loaded" line saying "Nothing uploaded yet."
//
// Both panels were telling the truth about different questions, which is
// the worst kind of correct: it reads as data loss. These tests pin that
// the screen now names the owner instead.
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

// The fixture is built here rather than committed as a binary: a Zoho
// export is only a header row carrying "Log Date" and "Log owner", and a
// CSV the upload accepts. Owned by somebody who is NOT the uploader,
// which is the whole point.
const OWNED_BY_SOMEONE_ELSE = [
  'Item Id,Item Name,Log Type,Log Hours(for calculation),Log owner,Log Date,Approval Status,Description,Owner Mail Id',
  'MSG-1,Ownership message probe,WorkItem,8,Arun Employee,17/Sep/2026,Approved,probe row,emp@shot.in',
  'MSG-1,Ownership message probe,WorkItem,8,Arun Employee,18/Sep/2026,Approved,probe row,emp@shot.in',
].join('\n');

const text = (page) => page.evaluate(() => document.body.textContent);

async function uploadAs(email, csv) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(`${APP}/my/timesheet`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.setInputFiles('input[type=file]', {
    name: 'probe-timesheet.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
  });
  await page.getByRole('button', { name: /Check the file/ }).click();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /^Upload/ }).click();
  await page.waitForTimeout(3000);
  return { ctx, page, errors };
}

test('AN ADMIN IS TOLD WHOSE ROWS THEY JUST LOADED, not left with a blank page', async (t) => {
  if (needStack(t)) return;
  // admin@shot.in has no logs of their own, exactly like the live admin
  // who reported this.
  const { ctx, page, errors } = await uploadAs('admin@shot.in', OWNED_BY_SOMEONE_ELSE);
  const body = (await text(page)).replace(/\s+/g, ' ');

  assert.match(body, /loaded/, 'the upload itself must still report success');
  // CONTIGUOUS, deliberately. The first version read
  // /belong to .*Arun Employee/ and did not bite when the panel was
  // poisoned to say "belong to other people": the greedy .* bridged all
  // the way to the owner's name further down in the empty state, so the
  // assertion passed on two unrelated fragments. Anything matching the
  // whole document body needs the words next to each other.
  assert.match(body, /belong to Arun Employee, not to you/,
    'the owner has to be NAMED — "some rows belong to other people" is what left the reporter stuck');
  assert.match(body, /This page shows your own logs only/,
    'and it has to say why this screen is empty, or the next question is identical');
  assert.match(body, /Open their record under HR . Timesheet/,
    'and where to go to actually read the data');

  // The whole defect: this sentence must NOT be on screen after a
  // successful upload.
  assert.ok(!/Nothing uploaded yet/.test(body),
    'the empty state contradicted the upload panel directly above it');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the empty state still reads normally for somebody who has simply never uploaded', async (t) => {
  if (needStack(t)) return;
  // WRITTEN TWICE. The first version of this test only checked the
  // admin-uploads-for-someone-else path, which passed just as happily
  // with the honest "Nothing uploaded yet" deleted outright — and that
  // message is right for a person who has genuinely never uploaded.
  // hod@shot.in: can actually sign in (only 5 of the 9 demo people have a
  // local credential — rekha@shot.in does not, and the first run of this
  // test sat on the sign-in screen and failed for that reason, not for
  // anything about the message) and has no timesheet rows of their own.
  const tk = await token('hod@shot.in');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), tk);
  await page.goto(`${APP}/my/timesheet`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  const body = (await text(page)).replace(/\s+/g, ' ');
  assert.match(body, /Nothing uploaded yet/,
    'with no upload in this session there is nobody to name, and the original wording is correct');
  await ctx.close();
});
