// node --test — a survey ABOUT somebody else (phase 4, 25 Sep), in a
// real browser.
//
// "BUT — YOU SHOULD ALSO SURVEY THE MANAGER. This is critical."
//
// A server test can see that four invitation rows exist. Only a
// browser shows whether the manager can TELL THEM APART: four rows all
// titled "Manager 30-Day Review" with nothing else on them is the
// failure mode, and it looks fine in the database.
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
async function apiCall(path, tok, opts = {}) {
  const r = await fetch(`${API}/api/v1${path}`, { ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) } });
  return r.json();
}
async function open(path, email) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  return { ctx, page, errors };
}

test('the builder offers "managers answer about each reportee", and counts both sides', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('/admin/engagement');
  await page.getByRole('button', { name: /^Blank survey$/i }).click();
  await page.waitForTimeout(700);

  const body = () => page.locator('body').innerText();
  assert.match(await body(), /Employees answer about themselves/);
  assert.match(await body(), /Managers answer about each reportee/);

  // Anonymity is offered for a self survey...
  assert.ok((await body()).includes('Anonymous — answers are never stored against a name'));

  await page.getByRole('button', { name: /Managers answer about each reportee/ }).click();
  await page.waitForTimeout(1100);
  const after = await body();
  // ...and withdrawn for an assessment, which cannot be anonymous.
  assert.ok(!after.includes('Anonymous — answers are never stored against a name'),
    'the anonymity option is gone, because a manager assessment cannot be one');
  assert.match(after, /always attributed/);
  assert.match(after, /pick the people being\s*assessed/i);
  // The count now names how many managers would be asked.
  assert.match(after, /manager[s]? would be asked/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a manager sees one row per reportee, each naming who it is about', async (t) => {
  if (needStack(t)) return;
  // THE FAILURE ONLY A BROWSER CATCHES. Four invitations all titled
  // "Manager 30-Day Review" and nothing else is four identical rows:
  // correct in the database, useless on screen.
  const tok = await token();
  const marker = `ZZ Mgr Probe ${Date.now()}`;
  // Close anything a previous run left open. This test creates a
  // survey and only closes it on the happy path, so one failure used
  // to leave an open probe behind and every run after it saw several
  // "about <same person>" rows and could not tell them apart.
  for (const s of (await apiCall('/engagement/surveys', tok)).surveys || []) {
    if (s.title.startsWith('ZZ Mgr Probe') && s.status === 'open') {
      await apiCall(`/engagement/surveys/${s.id}/close`, tok, { method: 'POST' });
    }
  }

  // Give the demo manager two reportees inside a wide window.
  const emps = (await apiCall('/employees?limit=500', tok)).employees || [];
  const mgr = emps.find((e) => e.email === 'mgr@shot.in');
  const subjects = emps.filter((e) => ['emp@shot.in', 'hr@shot.in'].includes(e.email));
  assert.ok(mgr && subjects.length === 2, 'the demo fixtures are present');
  for (const s of subjects) {
    await apiCall(`/employees/${s.id}`, tok, { method: 'PUT',
      body: JSON.stringify({ manager_email: 'mgr@shot.in' }) }).catch(() => {});
  }

  const survey = (await apiCall('/engagement/surveys', tok, { method: 'POST', body: JSON.stringify({
    title: marker, audience_kind: 'manager_about_reportee', anonymity_default: false,
    audience_rule: { manager_ids: [mgr.id] },
    questions: [{ qtype: 'scale', prompt: 'The employee has understood their role.' }],
  }) })).survey;
  const opened = await apiCall(`/engagement/surveys/${survey.id}/open`, tok, { method: 'POST' });
  assert.ok(opened.invited >= 2, `the manager was invited about each reportee — got ${opened.invited}`);

  const { ctx, page, errors } = await open('/engagement', 'mgr@shot.in');
  const mineRows = page.locator('div.p-3').filter({ hasText: new RegExp(marker) });
  const text = (await mineRows.allInnerTexts()).join('\n');
  const abouts = [...text.matchAll(/about ([A-Z][\w .]+?)(?: ·|\n|$)/gm)].map((m) => m[1].trim());
  assert.ok(abouts.length >= 2, `each row says who it is about — found ${JSON.stringify(abouts)}`);
  assert.ok(new Set(abouts).size >= 2, 'and they are different people, not the same row twice');

  // Answering one leaves the other open, and the form says who it is about.
  // Scoped to THIS survey as well as this subject: the same manager
  // can hold rows about the same person on several open surveys.
  const first = page.locator('div.p-3')
    .filter({ hasText: new RegExp(marker) })
    .filter({ hasText: new RegExp(`about ${abouts[0]}`) });
  assert.equal(await first.count(), 1, 'exactly one row for this survey and this person');
  await first.getByRole('button', { name: /^Take$/ }).click();
  await page.waitForTimeout(1000);
  const form = await page.locator('main').innerText();
  assert.match(form, new RegExp(`You are assessing\\s+${abouts[0]}`),
    `the form names the subject — got ${form.slice(0, 250)}`);
  assert.match(form, /recorded against their name and yours/);
  assert.ok(!form.includes('This survey is anonymous'), 'and does not claim to be anonymous');

  await page.getByRole('button', { name: /^1$/ }).first().click();
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await page.waitForTimeout(1500);
  const left = await page.locator('main').innerText();
  assert.match(left, /completed ✓/, 'the one just answered is marked done');
  assert.match(left, new RegExp(`about ${abouts[1]}`), 'and the other is still to do');
  assert.deepEqual(errors, []);
  await ctx.close();

  // HR sees a per-person scorecard rather than one average.
  const hr = await open('/admin/engagement');
  // div.p-3 is the ROW. Filtering .card matches the container that
  // holds every row, so the Results button clicked belonged to a
  // different survey and the scorecard never appeared.
  const row = hr.page.locator('div.p-3').filter({ hasText: new RegExp(marker) });
  assert.equal(await row.count(), 1, 'exactly one row carries this marker');
  await row.getByRole('button', { name: /^Results$/ }).click();
  await hr.page.getByText(/Each employee, as their manager rated them/).waitFor({ timeout: 10000 });
  const res = await hr.page.locator('main').innerText();
  // Case-insensitive: the heading carries the .lbl class, which
  // uppercases it in CSS. getByText reads the DOM text and matches;
  // innerText returns what is rendered and does not.
  assert.match(res, /each employee, as their manager rated them/i);
  assert.match(res, new RegExp(abouts[0]), 'the assessed person is listed by name');
  assert.match(res, /rated by/, 'and so is who rated them');
  assert.deepEqual(hr.errors, []);
  await hr.ctx.close();

  await apiCall(`/engagement/surveys/${survey.id}/close`, tok, { method: 'POST' });
});
