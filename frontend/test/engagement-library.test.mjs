// node --test — the survey library (phase 3, 25 Sep), in a real browser.
//
// "I would create a Survey Library" — HR picks "Day 30 Connect" rather
// than typing twenty questions.
//
// The thing only a browser can check is that using a template really
// does land twenty questions, with their option lists, in an editable
// draft that has NOT been released. A server test can see the rows; it
// cannot see whether HR was told what just happened, and a template
// that silently creates something offscreen reads as a broken button.
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

async function open(path = '/admin/engagement') {
  const t = await token();
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

test('the library opens with the lifecycle surveys, grouped and labelled', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open();
  await page.getByRole('button', { name: /New from library/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();

  for (const title of ['Day 1 Check-in', 'Week 1 Onboarding', 'Day 30 Connect',
    'Day 60 Connect', 'Day 90 Connect']) {
    assert.ok(body.includes(title), `${title} is in the library`);
  }
  // The headings are uppercased by CSS, so innerText gives them back
  // as "NEW HIRE LISTENING" — matched case-insensitively.
  for (const cat of ['Onboarding', 'New Hire Listening', 'Engagement', 'Development', 'Retention', 'Exit']) {
    assert.match(body, new RegExp(cat, 'i'), `the ${cat} category is shown`);
  }
  // Each lifecycle card states its window, its question count and
  // whether it is attributed, so HR chooses with the facts in front of
  // them. Asserted ON THE CARD, not on the page: the survey list
  // behind the modal carries its own "standing · day 30–37" chip, so a
  // whole-page match would pass even with the card's chip deleted.
  const cardFor = (title) => page.locator('.card')
    .filter({ hasText: new RegExp(title) })
    .filter({ has: page.getByRole('button', { name: /Use this/ }) });
  const d30 = await cardFor('Day 30 Connect').first().innerText();
  assert.match(d30, /day 30–37/, `the Day 30 card names its window — got ${d30}`);
  assert.match(d30, /\d+ questions/, 'and how many questions come with it');
  assert.match(d30, /attributed/, 'and that it is attributed');
  const pulse = await cardFor('Quarterly Pulse').first().innerText();
  assert.match(pulse, /anonymous/, 'while the pulse card says anonymous');
  assert.ok(!/day \d+–\d+/.test(pulse), 'and carries no milestone, because it is not a lifecycle survey');
  const d90 = await cardFor('Day 90 Connect').first().innerText();
  assert.match(d90, /day 90–97/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a template that cannot be released here says so on its card', async (t) => {
  if (needStack(t)) return;
  // Preboarding is real and wanted, but nobody is on the employee
  // master before their joining date and a pre-joiner has no login.
  // Letting HR release it would release a survey that reaches nobody.
  const { ctx, page, errors } = await open();
  await page.getByRole('button', { name: /New from library/i }).click();
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  assert.ok(body.includes('Pre-joining / Preboarding'), 'it is offered');
  assert.match(body, /Not automatic yet/);
  assert.match(body, /before their joining date/i);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('using a template lands an editable DRAFT and says what happened', async (t) => {
  if (needStack(t)) return;
  // Counts rather than asserting absence. The first cut checked that
  // "Day 90 Connect" was NOT on the list beforehand, which made the
  // test pass once and fail on every run after — it leaves its own
  // draft behind, and there is no delete for a survey.
  const countDay90 = async () => {
    const t = await token();
    const list = (await (await fetch(`${API}/api/v1/engagement/surveys`, {
      headers: { Authorization: `Bearer ${t}` } })).json()).surveys;
    return list.filter((x) => x.template_key === 'day_90').length;
  };
  const had = await countDay90();

  const { ctx, page, errors } = await open();
  await page.getByRole('button', { name: /New from library/i }).click();
  await page.waitForTimeout(1200);

  // Use Day 90 — nothing in the demo tenant has run it, so the
  // assertions below cannot be satisfied by a leftover.
  // Scoped to the card that HAS the button. Filtering on the title
  // alone matches two things once this test has run before: the
  // library card, and the survey row it left on the list behind the
  // modal — and .last() picks the row, which has no button.
  const card = page.locator('.card')
    .filter({ hasText: /Day 90 Connect — confirmation readiness/ })
    .filter({ has: page.getByRole('button', { name: /Use this/ }) });
  await card.getByRole('button', { name: /Use this/ }).click();
  await page.waitForTimeout(1800);

  const after = await page.locator('main').innerText();
  // HR is told what just happened, because a template creates a draft
  // in a list rather than opening anything, and silence reads as a
  // broken button.
  assert.match(after, /created as a draft with \d+ questions/);
  assert.match(after, /lifecycle survey for day 90–97/);
  assert.match(after, /press .*Open.* to release it/i);
  assert.ok(after.includes('Day 90 Connect'), 'and it is on the list');
  assert.equal(await countDay90(), had + 1, 'exactly one new survey came from the template');

  // It really is a draft: the row offers Open, so nobody has been
  // invited yet.
  const row = page.locator('.card')
    .filter({ hasText: /Day 90 Connect — confirmation readiness/ })
    .filter({ hasText: /draft/ }).first();
  assert.match(await row.innerText(), /draft/);
  assert.deepEqual(errors, []);
  await ctx.close();

  // ...and the questions came with their option lists — the thing that
  // was broken until 25 Sep. Checked through the API because the
  // draft's form is only reachable once it is open.
  const tok = await token();
  const list = (await (await fetch(`${API}/api/v1/engagement/surveys`, {
    headers: { Authorization: `Bearer ${tok}` } })).json()).surveys;
  const s = list.find((x) => x.template_key === 'day_90');
  assert.ok(s, 'the survey remembers which template it came from');
  const qs = (await (await fetch(`${API}/api/v1/engagement/surveys/${s.id}/questions`, {
    headers: { Authorization: `Bearer ${tok}` } })).json()).questions;
  assert.ok(qs.length > 15, `the whole template came across — got ${qs.length} questions`);
  const productivity = qs.find((q) => /current level of productivity/.test(q.prompt));
  assert.ok(productivity, 'the productivity question is there');
  assert.equal(productivity.qtype, 'choice');
  assert.ok(productivity.options.includes('Fully productive'),
    `with its options — got ${JSON.stringify(productivity.options)}`);
});

test('the library can be skipped for a blank survey', async (t) => {
  if (needStack(t)) return;
  // The old flow still exists; the library is an addition, not a gate.
  const { ctx, page, errors } = await open();
  await page.getByRole('button', { name: /New from library/i }).click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /Start from blank instead/ }).click();
  await page.waitForTimeout(900);
  const body = await page.locator('body').innerText();
  assert.match(body, /Survey title/i, 'the blank builder opened');
  assert.match(body, /Who gets this survey/i, 'with the audience panel');
  assert.deepEqual(errors, []);
  await ctx.close();
});
