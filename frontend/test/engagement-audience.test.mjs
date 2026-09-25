// node --test — the engagement builder, in a real browser.
//
// Asked for on 25 Sep: "create engagement form in the engagement survey
// which will be pushed to all employees who are fitting in that
// employees categories", plus the Day 1 / Week 1 / 30 / 60 / 90
// lifecycle.
//
// A server test cannot see whether the options of a multiple-choice
// question ever reach the employee — and that was the actual defect:
// 'choice' existed in the schema, rendered as a 1-5 scale, and reported
// n=0 while the answers sat unread in the table. Only a browser catches
// that, which is why this file exists.
//
// It also types a whole title in one go, because a component declared
// inside its parent remounts on every keystroke and the field keeps
// only the last character. That bug has been paid for once already on
// the employee Add form.
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

async function open(path, email) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1250 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1100);
  return { ctx, page, errors };
}

test('the builder asks who the survey goes to, and counts them live', async (t) => {
  if (needStack(t)) return;
  // "Blank survey", not "New survey": since the library landed on
  // 25 Sep the primary button opens the template picker, and typing a
  // survey from scratch is the secondary path.
  const { ctx, page, errors } = await open('/admin/engagement');
  await page.getByRole('button', { name: /^Blank survey$/i }).first().click();
  await page.waitForTimeout(600);

  // The title survives being typed. A field that remounts per keystroke
  // keeps only the last character.
  const title = page.locator('input').first();
  await title.click();
  await page.keyboard.type('Audience probe', { delay: 25 });
  assert.equal(await title.inputValue(), 'Audience probe');

  const main = () => page.locator('main, [role=dialog], body').first().innerText();
  let text = await main();
  assert.match(text, /Who gets this survey/i, 'the audience panel is on the form at all');
  assert.match(text, /Right now this reaches \d+ employee/, 'and it says how many it reaches');
  // Every category the spec asks to target by.
  for (const box of ['Department', 'Designation', 'Reporting manager']) {
    assert.match(text, new RegExp(box, 'i'), `${box} can be targeted`);
  }

  // Narrowing the audience moves the number.
  const countNow = async () => {
    const m = (await main()).match(/Right now this reaches (\d+) employee/);
    return m ? Number(m[1]) : null;
  };
  const all = await countNow();
  assert.ok(all > 1, `there is more than one employee to narrow from — got ${all}`);
  await page.getByRole('button', { name: /^Technology$/ }).first().click();
  await page.waitForTimeout(900);
  const narrowed = await countNow();
  assert.ok(narrowed < all, `picking a department narrowed the audience: ${all} -> ${narrowed}`);
  assert.match(await main(), /everyone in Technology/, 'and the sentence names it');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the five lifecycle milestones are pickable, and each is a window', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('/admin/engagement');
  await page.getByRole('button', { name: /^Blank survey$/i }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Lifecycle/ }).click();
  await page.waitForTimeout(400);

  for (const label of ['Day 1 Check-in', 'Week 1 Onboarding', 'Day 30 Connect', 'Day 60 Connect', 'Day 90 Connect']) {
    assert.equal(await page.getByRole('button', { name: new RegExp(`^${label}$`) }).count(), 1, `${label} is offered`);
  }

  await page.getByRole('button', { name: /^Day 30 Connect$/ }).click();
  await page.waitForTimeout(900);
  const text = await page.locator('body').innerText();
  // THE POINT. A window, not an exact day: almost nobody is sitting on
  // exactly day 30 on any given morning, and an employee crosses it
  // once, so an exact match loses most of a cohort silently.
  assert.match(text, /Goes out to anyone who joined 30 to 37 days ago/);
  assert.match(text, /stays open/, 'and it says the survey keeps inviting');
  assert.match(text, /joined between 30 and 37 days ago/, 'the live count uses the same window');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an employee with no date of joining is reported, not silently dropped', async (t) => {
  if (needStack(t)) return;
  // No silent failure: a cohort that is quietly short looks exactly
  // like a cohort that is genuinely that size.
  const { ctx, page, errors } = await open('/admin/engagement');
  await page.getByRole('button', { name: /^Blank survey$/i }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: /Lifecycle/ }).click();
  await page.getByRole('button', { name: /^Day 30 Connect$/ }).click();
  await page.waitForTimeout(900);
  assert.match(await page.locator('body').innerText(),
    /\d+ active employees? (has|have) no date of joining on the master/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a pick-one question shows its options to the employee and tallies them', async (t) => {
  if (needStack(t)) return;
  // THE DEFECT FOUND ON 25 Sep. 'choice' was in the schema and
  // implemented nowhere: the employee saw a 1-5 scale where the options
  // should have been, and the results said "n=0 · avg". It hit the most
  // useful question in a 30-day survey — the one naming what is
  // blocking somebody.
  const OPTS = ['Lack of training', 'Lack of system access', 'No significant blocker'];
  const tok = await token();
  const marker = `ZZ Choice Probe ${Date.now()}`;
  const s = (await (await fetch(`${API}/api/v1/engagement/surveys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ title: marker, anonymity_default: false,
      audience_rule: {}, questions: [{ qtype: 'choice', prompt: 'What is blocking you?', options: OPTS }] }),
  })).json()).survey;
  await fetch(`${API}/api/v1/engagement/surveys/${s.id}/open`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}` } });

  // The employee's view: real radio buttons carrying the real options.
  const { ctx, page, errors } = await open('/engagement', 'emp@shot.in');
  // The row carries a Take button; clicking the title does nothing.
  const mine = page.locator('div').filter({ hasText: new RegExp(marker) }).last();
  await mine.getByRole('button', { name: /^Take$/ }).click();
  await page.waitForTimeout(1000);
  const radios = page.locator('input[type=radio]');
  assert.equal(await radios.count(), OPTS.length, 'one radio per option, not a 1-5 scale');
  const body = await page.locator('body').innerText();
  for (const o of OPTS) assert.ok(body.includes(o), `"${o}" is on screen`);
  assert.ok(!body.includes('What is blocking you? *\n1'), 'not rendered as a rating');

  await page.getByText('Lack of training').click();
  await page.getByRole('button', { name: /^Submit$/ }).click();
  await page.waitForTimeout(1400);
  assert.deepEqual(errors, []);
  await ctx.close();

  // ...and HR sees a tally, not "n=0 · avg".
  const hr = await open('/admin/engagement');
  const row = hr.page.locator('div').filter({ hasText: new RegExp(marker) }).last();
  await row.getByRole('button', { name: /^Results$/ }).click();
  await hr.page.waitForTimeout(1500);
  const res = await hr.page.locator('main').innerText();
  assert.match(res, /1 answered/, 'the answer is counted');
  assert.match(res, /Lack of training\s+1 · 100%/, 'and tallied per option with a percentage');
  assert.match(res, /No significant blocker\s+0 · 0%/, 'every offered option is listed, so a zero shows as a zero');
  assert.ok(!/n=0/.test(res), 'the old "n=0 · avg" output is gone');
  assert.deepEqual(hr.errors, []);
  await hr.ctx.close();

  // Leave the tenant as we found it.
  await fetch(`${API}/api/v1/engagement/surveys/${s.id}/close`, {
    method: 'POST', headers: { Authorization: `Bearer ${tok}` } });
});
