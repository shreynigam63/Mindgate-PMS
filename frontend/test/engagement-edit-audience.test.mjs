// node --test — editing a draft survey from its preview, in a real
// browser.
//
// Asked for on 28 Sep, on two screenshots of the Engagement page:
//
//   1. "HR should have option to select who it goes to, either
//      employee or team or department."
//   2. "please check 2nd screenshot and provide edit option during
//      previewing surveys."
//
// The first screenshot was a Customer Feedback draft made from the
// library, audience box ringed in red: "1427 people — everyone on the
// employee list". Department and team targeting existed, but only in
// the blank-survey builder — a library survey arrived with the
// template's audience and nothing could change it. Naming individual
// people could not be done at all.
//
// WHY THIS NEEDS A BROWSER. The server tests already prove the rule
// resolves and the PUT lands. What they cannot see is whether HR can
// REACH any of it: whether an Edit button exists on the preview,
// whether the picker shows the people it has selected rather than the
// uuids it stores, and whether the count on screen moves. That
// reachability was the entire bug — the machinery was there and no
// screen led to it.
//
// ASSERTS ON textContent, NOT innerText. The editor is a scrolling
// modal, and Chromium's innerText omits content scrolled out of an
// overflow container — a check written against innerText reports
// controls missing that are demonstrably present and clickable.
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

async function token(email = 'hr@shot.in') {
  return (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
}

async function open(path, email) {
  const t = await token(email);
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1150 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((x) => localStorage.setItem('apms_token', x), t);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

const text = (page) => page.evaluate(() => document.body.textContent);

// EVERY SURVEY THESE TESTS TOUCH GETS A UNIQUE TITLE, and every click
// is scoped to its own row. The demo tenant accumulates drafts, most of
// them called "Customer Feedback"; a test that clicked the first
// Preview on the page acted on whichever draft happened to be on top
// and reported failures that said nothing about the code. Determinism
// here is not tidiness — without it this file lies in both directions.

// Made through the API rather than the library modal, because what is
// under test is the EDITOR, not template picking (covered in
// engagement-library.test.mjs). A survey created this way is the same
// draft the library would produce: audience unset, i.e. everybody.
async function makeDraft(title, questions) {
  const t = await token();
  const r = await fetch(`${API}/api/v1/engagement/surveys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ title, questions: questions || [{ qtype: 'scale', prompt: 'Overall satisfaction with the team' }] }),
  });
  const body = await r.json();
  assert.ok(body.survey && body.survey.id, `could not create the fixture survey: ${JSON.stringify(body)}`);
  return body.survey.id;
}

async function release(id) {
  const t = await token();
  const r = await fetch(`${API}/api/v1/engagement/surveys/${id}/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: '{}' });
  assert.equal(r.status, 200, 'the fixture survey should open');
}

// The one row carrying this title, and its buttons.
function rowFor(page, title) {
  return page.locator('div')
    .filter({ hasText: title })
    .filter({ has: page.getByRole('button', { name: /^Preview$/ }) })
    .last();
}

async function previewOf(page, title) {
  await rowFor(page, title).getByRole('button', { name: /^Preview$/ }).click();
  await page.waitForTimeout(1600);
}

test('THE REPORTED GAP: a library survey can be retargeted from its preview', async (t) => {
  if (needStack(t)) return;
  const title = `ZZ Retarget ${Date.now()}`;
  await makeDraft(title);
  const { ctx, page, errors } = await open('/admin/engagement');
  try {
    await previewOf(page, title);

    // Before: aimed at the whole company, exactly as reported.
    const before = await text(page);
    assert.match(before, /everyone on the employee list/,
      'the draft arrives aimed at everybody — the thing being complained about');

    // 1. THE EDIT BUTTON EXISTS ON THE PREVIEW. This is ask (2), and
    //    the reachability that was missing.
    const edit = page.getByRole('button', { name: 'Edit', exact: true }).first();
    assert.equal(await edit.count(), 1, 'the preview offers Edit');
    await edit.click();

    // 2. THE PICKER OFFERS ALL THREE THINGS HR NAMED.
    await page.getByPlaceholder(/Search the employee master/i).waitFor({ timeout: 15000 });
    await page.waitForTimeout(700);
    const inEditor = await text(page);
    for (const label of ['Department', 'Team — everyone reporting to', 'Specific people']) {
      assert.ok(inEditor.includes(label), `the editor offers "${label}"`);
    }

    // 3. PICK ONE NAMED PERSON and watch the live count follow.
    await page.getByPlaceholder(/Search the employee master/i).fill('arun');
    await page.waitForTimeout(1200);
    await page.locator('button', { hasText: 'emp@shot.in' }).first().click();
    await page.waitForTimeout(1200);
    const picked = await text(page);
    assert.match(picked, /Right now this reaches\s*1\s*person/,
      'the count on screen follows the pick, from the same resolver Open uses');
    assert.match(picked, /the 1 person picked by name/);

    // 4. SAVE, and the preview it returns to must show the new audience
    //    — not the stale one it was opened with.
    await page.getByRole('button', { name: /Save changes/i }).click();
    await page.waitForTimeout(2500);
    const after = await text(page);
    assert.match(after, /1\s*person\s*—\s*the 1 person picked by name/,
      'back in the preview, showing what was just saved');
    assert.ok(!/everyone on the employee list/.test(after.split('Who it goes to')[1] || ''),
      'and no longer claiming it goes to everybody');

    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the editor reopens showing the people already picked, by name', async (t) => {
  if (needStack(t)) return;
  // A picker that forgot the selection would look like the audience
  // had been lost, and HR would re-pick people who were already
  // picked — or save an empty rule and widen it back to everybody.
  const title = `ZZ Reopen ${Date.now()}`;
  await makeDraft(title);
  const { ctx, page, errors } = await open('/admin/engagement');
  try {
    await previewOf(page, title);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByPlaceholder(/Search the employee master/i).waitFor({ timeout: 15000 });
    await page.getByPlaceholder(/Search the employee master/i).fill('arun');
    await page.waitForTimeout(1200);
    await page.locator('button', { hasText: 'emp@shot.in' }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: /Save changes/i }).click();
    await page.waitForTimeout(2500);

    // Reopen the editor on the saved draft.
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByPlaceholder(/Search the employee master/i).waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    const t2 = await text(page);
    assert.match(t2, /Specific people · 1 selected/, 'it remembers the selection');
    assert.match(t2, /Arun Employee/, 'and shows a NAME, not the uuid it stores');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('the questions are editable too, since the preview shows them', async (t) => {
  if (needStack(t)) return;
  const title = `ZZ Questions ${Date.now()}`;
  await makeDraft(title, [{ qtype: 'scale', prompt: 'Overall satisfaction with the team' }]);
  const { ctx, page, errors } = await open('/admin/engagement');
  try {
    await previewOf(page, title);
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByPlaceholder(/Search the employee master/i).waitFor({ timeout: 15000 });
    await page.waitForTimeout(700);

    // The first question box is seeded with the template's wording,
    // rather than opening blank and quietly replacing the survey.
    const q1 = page.locator('input[placeholder="Question text"]').first();
    const seeded = await q1.inputValue();
    assert.ok(seeded && seeded.length > 3, `the editor loads the existing questions, got "${seeded}"`);

    // Retype it in one go — a component declared inside its parent
    // remounts per keystroke and keeps only the last character. That
    // bug has been paid for twice in this codebase.
    await q1.fill('Rewritten by the editor');
    await page.waitForTimeout(300);
    assert.equal(await q1.inputValue(), 'Rewritten by the editor', 'the field holds a whole sentence');

    await page.getByRole('button', { name: /Save changes/i }).click();
    await page.waitForTimeout(2500);
    assert.match(await text(page), /Rewritten by the editor/,
      'and the preview shows the new wording');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});

test('an OPEN survey offers no Edit button at all', async (t) => {
  if (needStack(t)) return;
  // The server refuses the edit either way. Offering a button that
  // would be refused is a worse screen than not offering it.
  // Released through the API: what is under test is whether the
  // preview offers Edit on an open survey, not the release flow (which
  // engagement.test.mjs already drives).
  const title = `ZZ Opened ${Date.now()}`;
  const id = await makeDraft(title);
  await release(id);
  const { ctx, page, errors } = await open('/admin/engagement');
  try {
    await previewOf(page, title);
    const body = await text(page);
    assert.ok(body.includes(title), 'the preview really is the opened survey');
    assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 0,
      'no Edit on a survey people have already been invited to');
    // And the draft case is the control: without this the assertion
    // above would also pass if Edit had never been built.
    const draftTitle = `ZZ Control ${Date.now()}`;
    await makeDraft(draftTitle);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await previewOf(page, draftTitle);
    assert.equal(await page.getByRole('button', { name: 'Edit', exact: true }).count(), 1,
      'but a draft does offer it');
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});
