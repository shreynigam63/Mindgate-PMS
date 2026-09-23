// node --test — where each page lives, and whether its band is visible.
//
// Covers the five points asked for on 23 Sep:
//
//   1. "Engagement tab should be under HR tab and not my performance."
//   2. "better format for creating surveys instead of current one."
//   3. "my growth still shows team target achievement … should ideally be
//      under Manager tab and not my performance tab."
//   4. "mid year under my performance still shows Manager reviews also
//      which should ideally not be visible under self mid-year."
//   5. "we don't need 7 parameters in PMS for now, please remove from all
//      tabs if available."
//
// A server test can assert the page_permission rows, and page-permissions
// .test.js does. It cannot assert what the MENU renders or what a page
// puts on screen, which is what every one of these five is about — so
// this drives a real browser against the running dev stack.
//
// THE BAND TEST is here for a different reason. `hue` names a gradient
// class and a name with no class is SILENT: .hero keeps its white text
// and simply has no background, so the title renders white on the page's
// near-white backdrop and the band reads as an empty strip. `lagoon` did
// that on two Manager pages — the class had never been written. Asserting
// a real computed background is the only way that shows up short of
// looking at every page.
//
// Skips cleanly when the stack is not up.
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

// Inside the test, not in its options — see kra-table.test.mjs for the
// run where `{ skip: skip() }` made five tests report ok while testing
// nothing.
const needStack = (t) => {
  if (!up) { t.skip('dev stack not running (API 8080 + Vite 5190)'); return true; }
  return false;
};

async function open(email, path) {
  const token = (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('apms_token', t), token);
  await page.goto(APP + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

// The item strip for one role tab, by its label.
const groupItems = async (page, group) => {
  await page.locator(`header >> text="${group}"`).first().click();
  await page.waitForTimeout(350);
  return (await page.locator('header nav').innerText())
    .split('\n').map((s) => s.trim()).filter(Boolean);
};

test('1 + 3 — Engagement admin sits under HR, team growth under Manager', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('hr@shot.in', '/home');

  const self = await groupItems(page, 'Self');
  assert.ok(self.includes('My Surveys'),
    'an employee keeps the survey they were invited to answer');
  assert.ok(!self.includes('Engagement'),
    'but "Engagement" — writing and running surveys — is no longer under Self');

  const mgr = await groupItems(page, 'Manager');
  assert.ok(mgr.includes('Team Target Achievements'),
    'the manager list of growth plans moved out of My Growth');

  const hr = await groupItems(page, 'HR');
  assert.ok(hr.includes('Engagement Surveys'), 'and running surveys is HR\'s');

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('3 — My Growth no longer carries the team list', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('mgr@shot.in', '/my/growth');
  const body = await page.locator('body').innerText();
  assert.ok(!/Team Target Achievements/i.test(body),
    'a manager\'s own growth page must not list their reports');
  assert.ok(!/reports have submitted/i.test(body));
  await page.goto(APP + '/team/growth', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const team = await page.locator('body').innerText();
  assert.ok(!/not part of your access/i.test(team), '/team/growth opens for a manager');
  assert.equal(await page.locator('input[placeholder*="Search"]').count(), 1,
    'and it has the search box every team list now has');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('4 — the self mid-year page shows no manager review', async (t) => {
  if (needStack(t)) return;
  const { ctx, page, errors } = await open('emp@shot.in', '/my/midyear');
  const body = await page.locator('body').innerText();
  assert.ok(!/From the manager/i.test(body),
    'the manager column is gone from the employee\'s own mid-year');
  assert.ok(/Your mid-year/i.test(body), 'and their own half is still labelled');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('5 — the 7 parameters are on no tab, for any role', async (t) => {
  if (needStack(t)) return;
  const PARAM = /Organi[sz]ational Parameter|7 param|Review Analysis/i;
  for (const [email, path] of [
    ['hr@shot.in', '/admin/cycles'],          // HR used to configure them here
    ['emp@shot.in', '/my/self-appraisal'],
    ['hr@shot.in', '/my/annual-review'],
  ]) {
    const { ctx, page } = await open(email, path);
    const body = await page.locator('body').innerText();
    assert.ok(!PARAM.test(body), `${path} still shows the 7 parameters`);
    await ctx.close();
  }

  // TEAM EVALUATION NEEDS THE CARD OPENED FIRST, and this is the one
  // page where the grid actually lived. Reading the page body without
  // expanding a report asserted nothing at all: EvalEditor only renders
  // for the expanded row, so a poisoned build that put the parameters
  // straight back on the card still passed. Caught by poisoning it.
  {
    const { ctx, page } = await open('mgr@shot.in', '/team/eval');
    const rows = page.locator('.card button').first();
    assert.ok(await rows.count(), 'the manager has at least one report to expand');
    await rows.click();
    await page.waitForTimeout(1200);
    const body = await page.locator('body').innerText();
    assert.ok(/Strengths|Rate|rating/i.test(body),
      'the evaluation editor really did open — otherwise the check below is vacuous');
    assert.ok(!PARAM.test(body), '/team/eval still shows the 7-parameter grid');
    await ctx.close();
  }

  // The page that WAS the 7 parameters has no route left, so it falls
  // through to the catch-all rather than rendering.
  const { ctx, page } = await open('hr@shot.in', '/admin/parameter-analysis');
  assert.match(page.url(), /\/home$/, 'the removed page redirects rather than opening');
  const hr = await groupItems(page, 'HR');
  assert.ok(!hr.some((x) => /Review Analysis/i.test(x)), 'and it is off the menu');
  await ctx.close();
});

test('every page band actually has a background — an unstyled hue is invisible', async (t) => {
  if (needStack(t)) return;
  // Reads the COMPUTED background, so a hue whose class was never written
  // fails here rather than shipping as a blank strip. The pages listed
  // are one per hue in use plus both pages that had the fault.
  for (const [email, path] of [
    ['emp@shot.in', '/my/kras'],
    ['emp@shot.in', '/my/growth'],
    ['emp@shot.in', '/my/midyear'],
    ['emp@shot.in', '/engagement'],
    ['mgr@shot.in', '/team/growth'],
    ['mgr@shot.in', '/team/midyear'],
    ['mgr@shot.in', '/team/overview'],
    ['hr@shot.in', '/admin/engagement'],
    ['hr@shot.in', '/admin/kra-library'],
  ]) {
    const { ctx, page } = await open(email, path);
    const bg = await page.evaluate(() => {
      const h = document.querySelector('.hero');
      if (!h) return 'NO HERO';
      const s = getComputedStyle(h);
      return s.backgroundImage === 'none' ? s.backgroundColor : s.backgroundImage;
    });
    assert.ok(bg.startsWith('linear-gradient'),
      `${path}: the page band has no gradient (got ${bg}) — its hue has no hero-* class`);
    await ctx.close();
  }
});

test('an employee with no KRAs can still be rated — the gap the parameters used to cover', async (t) => {
  if (needStack(t)) return;
  // THE REGRESSION THIS EXISTS FOR. Removing the 7-parameter grid took
  // away the only rating control on an annual evaluation card; the
  // per-KRA average replaced it, and a person whose sheet has no KRAs
  // has no average. Without a fallback their manager gets a card with
  // nothing to set and a submit that fails with "overall_rating
  // required". So the plain picker is offered for exactly that case.
  const { ctx, page, errors } = await open('mgr@shot.in', '/team/eval');
  await page.locator('.card button').first().click();
  await page.waitForTimeout(1300);
  const card = page.locator('.card').first();
  const body = await card.innerText();
  if (!/No KRAs on this employee/i.test(body)) {
    // The demo data may not hold such a person; say so rather than
    // passing quietly on an assertion that never ran.
    t.diagnostic('no KRA-less report in the demo data — fallback not exercised');
    await ctx.close();
    return;
  }
  assert.match(body, /OVERALL RATING/i, 'the plain picker is offered instead');
  await page.getByRole('button', { name: 'A', exact: true }).first().click();
  await page.waitForTimeout(1400);
  assert.match(await card.innerText(), /Saved/, 'and setting it actually persists');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('All Approvals opens the record and can return it, not just approve blind', async (t) => {
  if (needStack(t)) return;
  // Asked for on 23 Sep: "return KRA option is missing, please add the
  // same / also KRA view option is not available."
  //
  // THE WHOLE ROUND TRIP, through the product's own transitions only:
  // the employee submits, HR opens the row in the queue and reads the
  // sheet, fails to return it without a reason, then returns it with
  // one. No hand-patched rows.
  //
  // IT MUST NOT SILENTLY SKIP. The first version of this bailed with
  // t.diagnostic() and a return when the demo sheet would not submit —
  // its weights total 60, not 100 — and reported `ok` while testing
  // nothing at all. Poisoning it (removing the table, renaming the
  // Return button) changed no result, which is how that was caught. It
  // now makes the sheet submittable itself, through the employee's own
  // edit route, and puts the original weights back afterwards; anything
  // that still goes wrong fails the test rather than passing it.
  const tok = async (email) => (await (await fetch(`${API}/api/v1/auth/dev-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASS }),
  })).json()).token;
  const call = async (who, p, init) => {
    const r = await fetch(`${API}/api/v1${p}`, {
      ...init, headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const emp = await tok('emp@shot.in');
  const admin = await tok('admin@shot.in');

  const mine = await call(emp, '/pms/my/kra-sheet');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const original = mine.body.kras;
  const sheetId = mine.body.sheet.id;
  assert.ok(original.length > 1, 'the demo employee has a sheet with KRAs to review');

  // A submitted or approved sheet is locked to its owner, by design. The
  // test has to start from a writable one and may well END on a locked
  // one if it fails midway, so both the setup and the restore go through
  // this — using the very route under test to unlock it, which is a real
  // transition rather than a patched row.
  //
  // Without this the test was not repeatable: one run left the sheet
  // submitted and the next failed in setup with a 409.
  const makeWritable = async () => {
    const st = (await call(emp, '/pms/my/kra-sheet')).body.sheet.status;
    if (st === 'submitted' || st === 'approved') {
      await call(admin, '/pms/approvals/bulk', {
        method: 'POST',
        body: JSON.stringify({ decision: 'returned', comment: 'Unlocked by an automated check.',
                               items: [{ kind: 'kra_sheet', id: sheetId }] }),
      });
    }
  };

  // Put the weights back exactly as found, whatever happens below — and
  // CHECK that it worked.
  //
  // This test shares the demo employee's sheet with the KRA-table tests,
  // which need it editable (they assert on the "+ New parameter" row that
  // only a draft renders). A restore that quietly failed left the sheet
  // submitted and broke an unrelated test on the NEXT run, which is a
  // miserable thing to debug — so a failed restore fails here instead.
  const restore = async () => {
    await makeWritable();
    await call(emp, '/pms/my/kra-sheet/kras', {
      method: 'PUT',
      body: JSON.stringify({ kras: original.map((k) => ({
        id: k.id, title: k.title, description: k.description, measures: k.measures,
        category: k.category, weight: k.weight, sort_order: k.sort_order })) }),
    });
    const back = (await call(emp, '/pms/my/kra-sheet')).body;
    assert.equal(back.sheet.status, 'draft', 'the demo sheet was left editable for the other tests');
    assert.deepEqual(back.kras.map((k) => Number(k.weight)), original.map((k) => Number(k.weight)),
      'the demo sheet was left with the weights it started with');
  };
  await makeWritable();

  let ctx;
  try {
    // Weights must total 100 to submit, and the demo sheet totals 60.
    // Nudge the first KRA up by the difference — a real edit through the
    // real route, not a patched row.
    const total = original.reduce((n, k) => n + Number(k.weight || 0), 0);
    const bumped = original.map((k, i) => ({
      id: k.id, title: k.title, description: k.description, measures: k.measures,
      category: k.category, sort_order: k.sort_order,
      weight: i === 0 ? Number(k.weight || 0) + (100 - total) : Number(k.weight || 0),
    }));
    const saved = await call(emp, '/pms/my/kra-sheet/kras', { method: 'PUT', body: JSON.stringify({ kras: bumped }) });
    assert.equal(saved.status, 200, `could not rebalance the sheet: ${JSON.stringify(saved.body)}`);

    const sub = await call(emp, '/pms/my/kra-sheet/submit', { method: 'POST' });
    assert.equal(sub.status, 200, `could not submit the sheet: ${JSON.stringify(sub.body)}`);

    const opened = await open('admin@shot.in', '/admin/approvals');
    ctx = opened.ctx;
    const page = opened.page;
    await page.locator('button:has-text("KRA sheet")').first().click();
    await page.waitForTimeout(700);
    const row = page.locator('tbody tr button').filter({ hasText: 'Arun Employee' });
    assert.ok(await row.count(), 'the submitted sheet reaches the company-wide queue');
    await row.first().click();
    await page.waitForTimeout(1600);

    // VIEW — the same four-column table the employee filled in, not a
    // second rendering of it.
    assert.equal(await page.locator('.kratable').count(), 1, 'the sheet itself is shown');
    // textContent, not innerText: the header cells are uppercased by CSS,
    // so innerText would compare the rendering rather than the markup and
    // read PARAMETERS. kra-table.test.mjs compares the same way.
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll('.kratable thead th')].map((th) => th.textContent.trim())),
      ['Parameters', 'KRAs', 'KPIs (measuring metrics & data source)', 'Weightage']);
    const spans = await page.evaluate(() =>
      [...document.querySelectorAll('.kratable td.kt-param:not(.kt-param-add)')].map((td) => td.rowSpan));
    assert.ok(spans.some((n) => n > 1), 'parameters are merged over their KRAs here too');

    // RETURN — refused without a reason. This asserts the OUTCOME, not
    // which layer produced it: the page refuses before sending, and the
    // server refuses again if it ever did send. Deleting the client-side
    // guard leaves this passing, which was checked by doing exactly that
    // — and is correct, because the product still behaves the same. What
    // must never pass is the sheet changing state.
    await page.locator('button:has-text("Return for edits")').click();
    await page.waitForTimeout(800);
    assert.match(await page.locator('body').innerText(), /needs a comment/i);
    assert.equal((await call(emp, '/pms/my/kra-sheet')).body.sheet.status, 'submitted',
      'a refused return changed nothing');

    // RETURN — with one. The comment is the point: it is what the
    // employee is told.
    await page.locator('textarea').first().fill('Returned by an automated check.');
    await page.locator('button:has-text("Return for edits")').click();
    await page.waitForTimeout(2500);
    const after = await call(emp, '/pms/my/kra-sheet');
    assert.equal(after.body.sheet.status, 'returned');
    assert.equal(after.body.sheet.manager_comment, 'Returned by an automated check.');
    assert.deepEqual(opened.errors, []);
  } finally {
    await restore();
    if (ctx) await ctx.close();
  }
});
